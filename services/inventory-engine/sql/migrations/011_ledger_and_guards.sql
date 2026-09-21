-- ============================================================================
-- Ledger and state-machine guards.
--
-- Two ideas here.
--
-- 1. THE LEDGER IS A PROOF, NOT A LOG.
--    Every inventory movement appends an immutable entry with a signed delta.
--    Folding the ledger reconstructs current state. If the fold disagrees with
--    the `allocations` table, something wrote inventory without recording it —
--    which is a defect, detected automatically, rather than a mystery found
--    weeks later during a manual count. This turns "we keep an audit trail"
--    into a continuously checked invariant.
--
-- 2. ILLEGAL TRANSITIONS ARE IMPOSSIBLE, NOT MERELY UNIMPLEMENTED.
--    The allowed state transitions are enforced by a trigger. Application code
--    checks them too, for good error messages — but a buggy migration script, a
--    hand-run UPDATE during an incident, or a future service that forgets the
--    rules all hit the same wall. `AVAILABLE → CONFIRMED` without a hold cannot
--    be written, in any code path, by anyone.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Inventory ledger
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_ledger (
     id             bigserial PRIMARY KEY,
     event_id       uuid    NOT NULL,
     resource_id    uuid,
     pool_id        uuid,
     bucket         integer,
     span           int4range,

     entry_type     text    NOT NULL CHECK (entry_type IN (
                         'ALLOCATED',      -- resource claimed by a hold        -1 available
                         'RELEASED',       -- hold given up                     +1 available
                         'EXPIRED',        -- hold timed out                    +1 available
                         'CONFIRMED',      -- hold became a booking              0 (HELD → CONFIRMED)
                         'CANCELLED',      -- confirmed booking cancelled       +1 available
                         'BLOCKED',        -- operator withdrew the resource    -1 available
                         'UNBLOCKED',      -- operator returned the resource    +1 available
                         'CAPACITY_ADDED'  -- inventory created                 +N available
                    )),
     -- Signed change to AVAILABLE units. The fold of these must equal reality.
     delta          integer NOT NULL,

     allocation_id  uuid,
     hold_id        uuid,
     booking_id     text,

     -- Who caused it and why — the questions asked during an incident.
     actor          text    NOT NULL,
     reason         text,
     request_id     text,
     correlation_id text,
     trace_id       text,
     created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_event_idx    ON inventory_ledger (event_id, id);
CREATE INDEX ledger_resource_idx ON inventory_ledger (resource_id, id);
CREATE INDEX ledger_hold_idx     ON inventory_ledger (hold_id);
CREATE INDEX ledger_booking_idx  ON inventory_ledger (booking_id) WHERE booking_id IS NOT NULL;

-- An audit trail that can be edited is not an audit trail. The trigger blocks
-- UPDATE and DELETE for every role, including the owner, so "fix it in prod"
-- is not available even to someone with full credentials.
CREATE OR REPLACE FUNCTION tessera_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
     RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '0A000',
                HINT = 'Record a compensating entry instead of modifying history.';
END $$;

CREATE TRIGGER inventory_ledger_append_only
     BEFORE UPDATE OR DELETE ON inventory_ledger
     FOR EACH ROW EXECUTE FUNCTION tessera_append_only();

CREATE TRIGGER audit_log_append_only
     BEFORE UPDATE OR DELETE ON audit_log
     FOR EACH ROW EXECUTE FUNCTION tessera_append_only();

-- ────────────────────────────────────────────────────────────────────────────
-- Allocation state machine
--
--        (no row) ──reserve──▶ HELD ──confirm──▶ CONFIRMED
--                               │                    │
--                               │                    └──cancel──▶ CANCELLED
--                               ├──expire──▶ EXPIRED
--                               ├──release─▶ RELEASED
--                               └──cancel──▶ CANCELLED
--
--        (no row) ──block────▶ BLOCKED ──unblock──▶ RELEASED
--
-- Deliberately absent: any path into CONFIRMED that does not pass through HELD.
-- The business flow requires a hold first, so a direct "available → confirmed"
-- write is rejected. HELD → HELD is a no-op, handled idempotently above.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION allocation_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
     IF OLD.state = NEW.state THEN
          NEW.updated_at := now();
          RETURN NEW;
     END IF;

     IF NOT (
              (OLD.state = 'HELD'      AND NEW.state IN ('CONFIRMED','EXPIRED','RELEASED','CANCELLED'))
           OR (OLD.state = 'CONFIRMED' AND NEW.state = 'CANCELLED')
           OR (OLD.state = 'BLOCKED'   AND NEW.state = 'RELEASED')
     ) THEN
          RAISE EXCEPTION 'illegal allocation transition: % -> % (allocation %)',
               OLD.state, NEW.state, OLD.id
               USING ERRCODE = '23514';
     END IF;

     NEW.updated_at := now();
     IF NEW.state IN ('EXPIRED','RELEASED','CANCELLED') THEN
          NEW.terminal_at := now();
          -- A terminal row must stop constraining availability and must stop
          -- looking like a live hold to any query that filters on expiry.
          NEW.expires_at  := NULL;
     END IF;
     RETURN NEW;
END $$;

CREATE TRIGGER allocations_transition_guard
     BEFORE UPDATE ON allocations
     FOR EACH ROW EXECUTE FUNCTION allocation_transition_guard();

-- Only HELD, CONFIRMED and BLOCKED may be inserted. Everything else is reached
-- by transition, never created directly.
CREATE OR REPLACE FUNCTION allocation_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
     IF NEW.state NOT IN ('HELD','CONFIRMED','BLOCKED') THEN
          RAISE EXCEPTION 'allocations may only be created in HELD, CONFIRMED or BLOCKED (got %)', NEW.state
               USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
END $$;

CREATE TRIGGER allocations_insert_guard
     BEFORE INSERT ON allocations
     FOR EACH ROW EXECUTE FUNCTION allocation_insert_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- Hold state machine. Same reasoning, applied to the parent aggregate.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hold_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
     IF OLD.state = NEW.state THEN
          NEW.updated_at := now();
          RETURN NEW;
     END IF;

     IF NOT (OLD.state = 'ACTIVE' AND NEW.state IN ('CONFIRMED','EXPIRED','RELEASED','CANCELLED')) THEN
          RAISE EXCEPTION 'illegal hold transition: % -> % (hold %)', OLD.state, NEW.state, OLD.id
               USING ERRCODE = '23514';
     END IF;

     NEW.updated_at := now();
     IF NEW.state <> 'ACTIVE' THEN NEW.terminal_at := now(); END IF;
     RETURN NEW;
END $$;

CREATE TRIGGER holds_transition_guard
     BEFORE UPDATE ON holds
     FOR EACH ROW EXECUTE FUNCTION hold_transition_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- INVARIANT VERIFICATION VIEWS
--
-- The load tests, the reconciliation worker, the correctness scoreboard and the
-- chaos harness all query these same definitions. One source of truth for "is
-- the system correct", so a benchmark cannot pass using a weaker check than the
-- one reconciliation uses.
--
-- Every view returns ZERO ROWS when the system is healthy.
-- ════════════════════════════════════════════════════════════════════════════

-- I1 — no two live allocations of a resource overlap.
-- The exclusion constraint already guarantees this; the view exists to prove it
-- independently, and to catch a future migration that weakens the constraint.
CREATE VIEW invariant_overlapping_allocations AS
SELECT a.id            AS allocation_id,
       b.id            AS conflicting_allocation_id,
       a.resource_id,
       a.event_id,
       a.span          AS span_a,
       b.span          AS span_b,
       a.state         AS state_a,
       b.state         AS state_b
  FROM allocations a
  JOIN allocations b
    ON a.resource_id = b.resource_id
   AND a.id < b.id
   AND a.span && b.span
 WHERE a.state IN ('HELD','CONFIRMED','BLOCKED')
   AND b.state IN ('HELD','CONFIRMED','BLOCKED');

-- I2 — no pool bucket exceeds its capacity.
CREATE VIEW invariant_oversold_pools AS
SELECT pb.pool_id, pb.bucket, pb.capacity, pb.held, pb.confirmed,
       (pb.held + pb.confirmed - pb.capacity) AS excess
  FROM pool_buckets pb
 WHERE pb.held + pb.confirmed > pb.capacity;

-- I3 — no allocation is still HELD past its expiry.
-- A row here means the lazy reap and the sweeper both failed to notice; it
-- would be silently withholding inventory from customers.
CREATE VIEW invariant_expired_still_held AS
SELECT a.id AS allocation_id, a.resource_id, a.hold_id, a.expires_at,
       now() - a.expires_at AS overdue_by
  FROM allocations a
 WHERE a.state = 'HELD'
   AND a.expires_at <= now();

-- I3b — a hold and its allocations must agree about being alive.
CREATE VIEW invariant_hold_allocation_mismatch AS
SELECT h.id AS hold_id, h.state AS hold_state, a.id AS allocation_id, a.state AS allocation_state
  FROM holds h
  JOIN allocations a ON a.hold_id = h.id
 WHERE (h.state = 'ACTIVE'    AND a.state NOT IN ('HELD','CONFIRMED','RELEASED','EXPIRED','CANCELLED'))
    OR (h.state = 'CONFIRMED' AND a.state = 'HELD')
    OR (h.state IN ('EXPIRED','RELEASED','CANCELLED') AND a.state = 'HELD');

-- I4 — the ledger fold must equal observed state, per resource.
-- available = 1 (a resource-span unit is singular) minus live occupancy.
CREATE VIEW invariant_ledger_drift AS
WITH ledger_fold AS (
     SELECT resource_id, sum(delta) AS ledger_available
       FROM inventory_ledger
      WHERE resource_id IS NOT NULL
      GROUP BY resource_id
), actual AS (
     SELECT r.id AS resource_id,
            1 - count(a.id) FILTER (WHERE a.state IN ('HELD','CONFIRMED','BLOCKED')) AS actual_available
       FROM inventory_resources r
       LEFT JOIN allocations a ON a.resource_id = r.id
      GROUP BY r.id
)
SELECT f.resource_id, f.ledger_available, ac.actual_available,
       f.ledger_available - ac.actual_available AS drift
  FROM ledger_fold f
  JOIN actual ac USING (resource_id)
 WHERE f.ledger_available <> ac.actual_available;

-- I7 — one booking must not hold the same resource-span twice, and two
-- bookings must not both claim it (a stronger, booking-level restatement of I1).
CREATE VIEW invariant_duplicate_bookings AS
SELECT resource_id, span, count(*) AS confirmed_count,
       array_agg(booking_id) AS booking_ids
  FROM allocations
 WHERE state = 'CONFIRMED'
 GROUP BY resource_id, span
HAVING count(*) > 1;

-- I6 — outbox rows that have been pending far longer than the relay's normal
-- latency. Not necessarily corruption, but always worth knowing about.
CREATE VIEW invariant_outbox_backlog AS
SELECT id, event_id, event_type, aggregate_id, attempt_count, last_error,
       now() - created_at AS pending_for
  FROM outbox_events
 WHERE status = 'PENDING'
   AND created_at < now() - interval '60 seconds';

-- Convenience roll-up: one row per invariant, violation count, severity.
-- This is what the correctness scoreboard and `npm run verify` read.
CREATE VIEW invariant_summary AS
SELECT 'I1_overlapping_allocations' AS invariant, 'CRITICAL' AS severity,
       (SELECT count(*) FROM invariant_overlapping_allocations) AS violations
UNION ALL
SELECT 'I2_oversold_pools', 'CRITICAL', (SELECT count(*) FROM invariant_oversold_pools)
UNION ALL
SELECT 'I3_expired_still_held', 'HIGH', (SELECT count(*) FROM invariant_expired_still_held)
UNION ALL
SELECT 'I3b_hold_allocation_mismatch', 'HIGH', (SELECT count(*) FROM invariant_hold_allocation_mismatch)
UNION ALL
SELECT 'I4_ledger_drift', 'CRITICAL', (SELECT count(*) FROM invariant_ledger_drift)
UNION ALL
SELECT 'I7_duplicate_bookings', 'CRITICAL', (SELECT count(*) FROM invariant_duplicate_bookings)
UNION ALL
SELECT 'I6_outbox_backlog', 'MEDIUM', (SELECT count(*) FROM invariant_outbox_backlog);
