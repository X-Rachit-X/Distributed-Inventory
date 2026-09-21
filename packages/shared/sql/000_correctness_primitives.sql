-- ============================================================================
-- Correctness primitives — applied to EVERY Tessera service database.
--
-- These five tables are what turn "we use Kafka and retries" into a system with
-- actual guarantees. They live beside each service's business tables, in the
-- same database, so that a business write and its correctness bookkeeping can
-- commit in ONE transaction. That co-location is the whole design: it is what
-- removes the gap where a crash loses an event or duplicates an effect.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- Transactional outbox
--
-- Written in the same transaction as the business change, so an event cannot
-- exist without its change, and a change cannot exist without its event.
-- A relay publishes committed rows to Kafka afterwards.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox_events (
     id              bigserial PRIMARY KEY,
     event_id        uuid        NOT NULL UNIQUE,
     topic           text        NOT NULL,
     event_type      text        NOT NULL,
     event_version   integer     NOT NULL DEFAULT 1,

     -- Partition key. Every event for one aggregate lands on one partition,
     -- which is what gives per-aggregate ordering downstream.
     aggregate_id    text        NOT NULL,
     -- Monotonic per aggregate. Lets a consumer discard an event that arrives
     -- after a newer one it already applied.
     aggregate_seq   bigint,

     payload         jsonb       NOT NULL,
     correlation_id  text,
     causation_id    text,
     trace_id        text,

     status          text        NOT NULL DEFAULT 'PENDING'
                                 CHECK (status IN ('PENDING','PUBLISHED','FAILED','DEAD_LETTER')),
     attempt_count   integer     NOT NULL DEFAULT 0,
     next_attempt_at timestamptz NOT NULL DEFAULT now(),
     last_error      text,

     -- Lease, so several relay replicas can run without publishing the same row.
     lease_owner     text,
     lease_until     timestamptz,

     created_at      timestamptz NOT NULL DEFAULT now(),
     published_at    timestamptz
);

-- The relay's hot path: pending rows that are due. Partial index keeps it tiny
-- even when the table holds millions of published rows.
CREATE INDEX IF NOT EXISTS outbox_pending_idx
     ON outbox_events (next_attempt_at, id)
     WHERE status = 'PENDING';

-- Supports the head-of-line check that preserves per-aggregate ordering.
CREATE INDEX IF NOT EXISTS outbox_aggregate_pending_idx
     ON outbox_events (aggregate_id, id)
     WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS outbox_published_at_idx
     ON outbox_events (published_at)
     WHERE status = 'PUBLISHED';

-- Per-aggregate counter. Deliberately NOT one global sequence: a global counter
-- would be a single hot row touched by every write in the service — exactly the
-- contention pattern this project exists to eliminate.
CREATE TABLE IF NOT EXISTS aggregate_sequences (
     aggregate_id text   PRIMARY KEY,
     seq          bigint NOT NULL DEFAULT 0
);

-- ────────────────────────────────────────────────────────────────────────────
-- Idempotency keys
--
-- A key is CLAIMED atomically before any work runs, so two concurrent retries
-- cannot both execute. The response is stored verbatim so that a retry after a
-- lost response replays the original answer rather than acting again.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
     scope           text        NOT NULL,
     key             text        NOT NULL,
     -- Scoping to the caller stops one client from squatting on, or reading,
     -- another client's key.
     owner_id        text,
     -- Same key + different body is a client bug or an attack, never a retry.
     request_hash    text        NOT NULL,
     state           text        NOT NULL DEFAULT 'IN_PROGRESS'
                                 CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED')),
     response_status integer,
     response_body   jsonb,
     created_at      timestamptz NOT NULL DEFAULT now(),
     completed_at    timestamptz,
     expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
     PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Consumer deduplication
--
-- Inserted in the SAME transaction as the handler's side effect. That is what
-- upgrades at-least-once delivery into an effectively-once business effect:
-- either the effect and the marker both commit, or neither does.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_events (
     consumer      text        NOT NULL,
     event_id      uuid        NOT NULL,
     event_type    text,
     aggregate_id  text,
     aggregate_seq bigint,
     processed_at  timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (consumer, event_id)
);

CREATE INDEX IF NOT EXISTS processed_events_age_idx ON processed_events (processed_at);

-- Highest aggregate sequence a projection has applied. Guards against
-- out-of-order delivery, which partition ordering alone does not prevent once
-- retries and rebalances are in play.
CREATE TABLE IF NOT EXISTS projection_offsets (
     consumer     text   NOT NULL,
     aggregate_id text   NOT NULL,
     last_seq     bigint NOT NULL,
     updated_at   timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (consumer, aggregate_id)
);

-- Retry counters live here, not in process memory. An in-memory counter resets
-- on restart and on every consumer-group rebalance, letting a poison message
-- loop forever while always looking like attempt #1.
CREATE TABLE IF NOT EXISTS consumer_attempts (
     consumer        text        NOT NULL,
     event_id        text        NOT NULL,
     attempts        integer     NOT NULL DEFAULT 0,
     last_attempt_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (consumer, event_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Dead letters
--
-- Durable record of every poison message, with enough context to diagnose and
-- replay it: full payload, reason, stack, attempts, and the exact source
-- coordinates.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dead_letters (
     id               bigserial PRIMARY KEY,
     consumer         text        NOT NULL,
     event_id         text        NOT NULL,
     event_type       text,
     source_topic     text        NOT NULL,
     source_partition integer     NOT NULL,
     source_offset    text        NOT NULL,
     payload          text,
     reason           text        NOT NULL,
     error_message    text,
     error_stack      text,
     attempts         integer     NOT NULL DEFAULT 0,
     status           text        NOT NULL DEFAULT 'OPEN'
                                  CHECK (status IN ('OPEN','REPLAYED','DISCARDED')),
     created_at       timestamptz NOT NULL DEFAULT now(),
     updated_at       timestamptz NOT NULL DEFAULT now(),
     replayed_at      timestamptz,
     UNIQUE (consumer, event_id)
);

CREATE INDEX IF NOT EXISTS dead_letters_open_idx ON dead_letters (consumer, created_at) WHERE status = 'OPEN';

-- ────────────────────────────────────────────────────────────────────────────
-- Audit log — who did what, to which entity, and what changed.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
     id          bigserial PRIMARY KEY,
     actor_id    text        NOT NULL,
     actor_role  text,
     action      text        NOT NULL,
     entity_type text        NOT NULL,
     entity_id   text        NOT NULL,
     old_state   jsonb,
     new_state   jsonb,
     reason      text,
     request_id  text,
     trace_id    text,
     service     text,
     created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx  ON audit_log (actor_id, created_at DESC);
