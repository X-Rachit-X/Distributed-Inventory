-- ============================================================================
-- Contention Lab schema.
--
-- The lab exists to answer a question the production schema cannot: what
-- actually happens when you DON'T have the right protection?
--
-- `lab.allocations_unsafe` is an exact copy of the production allocations table
-- with the exclusion constraint deliberately REMOVED. It is the control group.
-- Running the naive read-check-write strategy against it produces real,
-- reproducible oversells on this machine — which is the only honest way to
-- argue that the constraint matters. A claim of "this prevents overselling" is
-- worth very little without a demonstration of the thing being prevented.
--
-- `lab.allocations_guarded` carries the same constraint as production, so the
-- same strategy can be run with and without the final safety net. That pairing
-- is what the layer-ablation mode uses to show WHICH layer catches WHICH bug.
--
-- Everything here is namespaced in its own schema and keyed by run_id, so lab
-- traffic can never touch real inventory. The API service does not import it.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS lab;

-- ────────────────────────────────────────────────────────────────────────────
-- Run registry. Every lab execution is recorded with its full parameters so a
-- result can be reproduced and compared later.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE lab.runs (
     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     scenario     text        NOT NULL,
     strategy     text        NOT NULL,
     users        integer     NOT NULL,
     resources    integer     NOT NULL,
     seed         bigint      NOT NULL,
     git_commit   text,
     git_dirty    boolean,
     started_at   timestamptz NOT NULL DEFAULT now(),
     finished_at  timestamptz,
     params       jsonb       NOT NULL DEFAULT '{}',
     results      jsonb
);

-- ────────────────────────────────────────────────────────────────────────────
-- CONTROL GROUP — no exclusion constraint.
--
-- If a strategy is going to oversell, this is where the evidence lands.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE lab.allocations_unsafe (
     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     run_id      uuid        NOT NULL,
     resource_id uuid        NOT NULL,
     span        int4range   NOT NULL,
     state       text        NOT NULL DEFAULT 'HELD',
     customer_id text        NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now()
     -- NO EXCLUDE CONSTRAINT. This omission is the experiment.
);

CREATE INDEX lab_unsafe_run_resource_idx ON lab.allocations_unsafe (run_id, resource_id);

-- ────────────────────────────────────────────────────────────────────────────
-- TREATMENT GROUP — identical, plus the production constraint.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE lab.allocations_guarded (
     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     run_id      uuid        NOT NULL,
     resource_id uuid        NOT NULL,
     span        int4range   NOT NULL,
     state       text        NOT NULL DEFAULT 'HELD',
     customer_id text        NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now(),

     -- The run_id participates so that two concurrent lab runs do not collide
     -- with each other; within a run the semantics match production exactly.
     CONSTRAINT lab_guarded_no_overlap
          EXCLUDE USING gist (run_id WITH =, resource_id WITH =, span WITH &&)
          WHERE (state IN ('HELD','CONFIRMED'))
);

CREATE INDEX lab_guarded_run_resource_idx ON lab.allocations_guarded (run_id, resource_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Per-resource status row.
--
-- This models how most reservation systems are actually built: a `status`
-- column flipped from AVAILABLE to HELD. It is what the naive, pessimistic-lock
-- and compare-and-swap strategies operate on, so the comparison is against the
-- design people really write, not a straw man.
--
-- `version` supports optimistic concurrency control.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE lab.resource_state (
     run_id      uuid    NOT NULL,
     resource_id uuid    NOT NULL,
     status      text    NOT NULL DEFAULT 'AVAILABLE',
     holder      text,
     version     bigint  NOT NULL DEFAULT 0,
     PRIMARY KEY (run_id, resource_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Quantity pool for the bucket-sharding experiment.
--
-- `bucket_count = 1` reproduces the classic hot-row bottleneck; higher values
-- spread it. Running the same workload at 1, 4 and 16 buckets is what turns
-- "shard the hot key" from folklore into a measurement.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE lab.pool_buckets (
     run_id   uuid    NOT NULL,
     bucket   integer NOT NULL,
     capacity integer NOT NULL,
     taken    integer NOT NULL DEFAULT 0,
     PRIMARY KEY (run_id, bucket),
     CONSTRAINT lab_pool_never_oversold CHECK (taken >= 0 AND taken <= capacity)
);

-- Unguarded twin, for showing what happens without the CHECK.
CREATE TABLE lab.pool_buckets_unsafe (
     run_id   uuid    NOT NULL,
     bucket   integer NOT NULL,
     capacity integer NOT NULL,
     taken    integer NOT NULL DEFAULT 0,
     PRIMARY KEY (run_id, bucket)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Per-request observations. One row per attempted reservation.
--
-- Stored rather than aggregated in memory so that percentiles are computed from
-- the real distribution, and so a surprising p99 can be traced back to the
-- individual requests that caused it.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE lab.observations (
     id          bigserial PRIMARY KEY,
     run_id      uuid    NOT NULL,
     worker      integer NOT NULL,
     attempt_no  integer NOT NULL,
     outcome     text    NOT NULL CHECK (outcome IN ('SUCCESS','CONFLICT','ERROR','TIMEOUT')),
     latency_ms  numeric NOT NULL,
     retries     integer NOT NULL DEFAULT 0,
     sqlstate    text,
     detail      text,
     started_at  timestamptz NOT NULL
);

CREATE INDEX lab_observations_run_idx ON lab.observations (run_id, outcome);

-- ════════════════════════════════════════════════════════════════════════════
-- Lab verdict.
--
-- The count that decides whether a strategy is safe: how many resource-spans
-- ended up claimed by more than one customer. Computed from stored rows, never
-- from HTTP response counts — a system can return 200 to two callers and still
-- have written only one row, or return 500 and have written two.
-- ════════════════════════════════════════════════════════════════════════════
CREATE VIEW lab.oversells_unsafe AS
SELECT run_id, resource_id, span, count(*) AS claim_count,
       array_agg(customer_id ORDER BY created_at) AS customers
  FROM lab.allocations_unsafe
 WHERE state IN ('HELD','CONFIRMED')
 GROUP BY run_id, resource_id, span
HAVING count(*) > 1;

CREATE VIEW lab.oversells_guarded AS
SELECT run_id, resource_id, span, count(*) AS claim_count,
       array_agg(customer_id ORDER BY created_at) AS customers
  FROM lab.allocations_guarded
 WHERE state IN ('HELD','CONFIRMED')
 GROUP BY run_id, resource_id, span
HAVING count(*) > 1;

-- Overlap detection for segment scenarios, where two claims can conflict
-- without being identical: [1,4) and [2,6) are different spans but the same bug.
CREATE VIEW lab.overlaps_unsafe AS
SELECT a.run_id, a.resource_id, a.span AS span_a, b.span AS span_b,
       a.customer_id AS customer_a, b.customer_id AS customer_b
  FROM lab.allocations_unsafe a
  JOIN lab.allocations_unsafe b
    ON a.run_id = b.run_id AND a.resource_id = b.resource_id AND a.id < b.id AND a.span && b.span
 WHERE a.state IN ('HELD','CONFIRMED') AND b.state IN ('HELD','CONFIRMED');
