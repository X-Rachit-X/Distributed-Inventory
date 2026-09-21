-- ============================================================================
-- Reservation service — reservations, bookings, and the durable saga.
--
-- THE SAGA IS A TABLE, NOT A CALL STACK.
--
-- The previous version ran its saga inline in the HTTP handler: hold seats,
-- create payment, confirm, all inside one request, with a `saga_logs` table
-- that recorded what had happened after the fact. That design cannot survive a
-- process restart. If the pod died between "payment authorised" and "inventory
-- confirmed", the customer had been charged and nothing existed to finish the
-- job — the log said what went wrong but nothing was driving it forward.
--
-- Here the saga's STATE is the durable thing. A worker claims due sagas, runs
-- exactly one step, and records the transition. Every step has a deadline, a
-- retry policy, a compensation, and a terminal state. Kill the process at any
-- point and another worker picks the saga up from its last committed state,
-- because progress lives in PostgreSQL rather than in a stack frame.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Reservations: the customer's intent.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE reservations (
     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     customer_id     text        NOT NULL,
     event_ref       text        NOT NULL,          -- catalog's schedule/show id
     event_id        uuid,                          -- inventory engine's event id
     state           text        NOT NULL DEFAULT 'PENDING'
                                 CHECK (state IN ('PENDING','HELD','AWAITING_PAYMENT','CONFIRMED',
                                                  'FAILED','CANCELLED','EXPIRED')),
     hold_id         uuid,
     booking_id      uuid,
     payment_id      uuid,
     total_cents     bigint      NOT NULL DEFAULT 0,
     currency        text        NOT NULL DEFAULT 'INR',
     item_count      integer     NOT NULL DEFAULT 0,
     hold_expires_at timestamptz,
     failure_reason  text,
     idempotency_key text,
     correlation_id  text,
     trace_id        text,
     created_at      timestamptz NOT NULL DEFAULT now(),
     updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reservations_customer_idx ON reservations (customer_id, created_at DESC);
CREATE INDEX reservations_state_idx    ON reservations (state) WHERE state NOT IN ('CONFIRMED','CANCELLED','FAILED','EXPIRED');
CREATE INDEX reservations_hold_idx     ON reservations (hold_id);

CREATE TABLE reservation_items (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     reservation_id uuid    NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
     resource_code  text,
     resource_id    uuid,
     span_from      integer,
     span_to        integer,
     pool_code      text,
     quantity       integer NOT NULL DEFAULT 1,
     price_cents    bigint  NOT NULL DEFAULT 0,
     passenger_name text,
     passenger_age  integer,
     metadata       jsonb   NOT NULL DEFAULT '{}'
);

CREATE INDEX reservation_items_res_idx ON reservation_items (reservation_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Bookings: the issued, paid-for result. Separate from reservations because a
-- reservation is an attempt and a booking is an outcome; conflating them makes
-- "how many attempts failed?" unanswerable.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE bookings (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     reservation_id uuid        NOT NULL UNIQUE REFERENCES reservations(id),
     customer_id    text        NOT NULL,
     reference      text        NOT NULL UNIQUE,   -- human-facing, e.g. TSR-8F3K2Q
     state          text        NOT NULL DEFAULT 'CONFIRMED'
                                CHECK (state IN ('CONFIRMED','CANCELLED','REFUNDED')),
     total_cents    bigint      NOT NULL,
     payment_id     uuid,
     issued_at      timestamptz NOT NULL DEFAULT now(),
     cancelled_at   timestamptz,
     metadata       jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX bookings_customer_idx ON bookings (customer_id, issued_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- SAGAS
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE sagas (
     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     reservation_id  uuid        NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
     type            text        NOT NULL DEFAULT 'BOOKING',

     -- The forward path and its two failure paths. Encoded as a CHECK so an
     -- invalid state cannot be written by any code path.
     state           text        NOT NULL DEFAULT 'CREATED' CHECK (state IN (
                          'CREATED',
                          'HOLD_PENDING', 'HOLD_CREATED',
                          'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED',
                          -- The provider did not answer. NOT a failure: the charge
                          -- may well have succeeded. Resolved by querying the
                          -- provider, never by assuming or by retrying blindly.
                          'PAYMENT_UNKNOWN',
                          'CONFIRM_PENDING', 'CONFIRMED',
                          'HOLD_FAILED', 'PAYMENT_FAILED', 'TIMED_OUT',
                          'RELEASE_PENDING', 'RELEASED',
                          'REFUND_PENDING', 'COMPENSATED',
                          -- Money is involved and the safe action is not obvious.
                          -- A human decides. Never auto-resolved.
                          'MANUAL_REVIEW'
                     )),

     attempts        integer     NOT NULL DEFAULT 0,
     max_attempts    integer     NOT NULL DEFAULT 8,
     last_error      text,

     -- Scheduling. `next_run_at` drives the worker; `step_deadline_at` is when
     -- the CURRENT step is considered timed out.
     next_run_at     timestamptz NOT NULL DEFAULT now(),
     step_deadline_at timestamptz,

     -- Lease, so several workers can run without both driving one saga.
     lease_owner     text,
     lease_until     timestamptz,

     correlation_id  text,
     trace_id        text,
     context         jsonb       NOT NULL DEFAULT '{}',
     created_at      timestamptz NOT NULL DEFAULT now(),
     updated_at      timestamptz NOT NULL DEFAULT now(),
     completed_at    timestamptz
);

-- The worker's claim query. Partial index so it stays small as completed sagas
-- accumulate — the overwhelming majority of rows are terminal.
CREATE INDEX sagas_due_idx ON sagas (next_run_at)
     WHERE state NOT IN ('CONFIRMED','COMPENSATED','RELEASED','MANUAL_REVIEW');

CREATE INDEX sagas_reservation_idx ON sagas (reservation_id);
CREATE INDEX sagas_stuck_idx ON sagas (step_deadline_at)
     WHERE state NOT IN ('CONFIRMED','COMPENSATED','RELEASED','MANUAL_REVIEW');

-- Append-only transition history. Answers "what did this saga do, in what
-- order, and how long did each step take" during an incident.
CREATE TABLE saga_steps (
     id          bigserial PRIMARY KEY,
     saga_id     uuid        NOT NULL REFERENCES sagas(id) ON DELETE CASCADE,
     from_state  text,
     to_state    text        NOT NULL,
     attempt     integer     NOT NULL DEFAULT 0,
     outcome     text        NOT NULL CHECK (outcome IN ('OK','RETRY','FAILED','TIMEOUT','SKIPPED')),
     detail      text,
     duration_ms integer,
     created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saga_steps_saga_idx ON saga_steps (saga_id, id);

CREATE TRIGGER saga_steps_append_only
     BEFORE UPDATE OR DELETE ON saga_steps
     FOR EACH ROW EXECUTE FUNCTION tessera_append_only();

-- ────────────────────────────────────────────────────────────────────────────
-- Saga state machine, enforced in the database.
--
-- The application has the same table for good error messages, but this trigger
-- is what makes an illegal transition impossible rather than merely
-- unimplemented — including from a hand-run UPDATE during an incident.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION saga_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
     allowed text[];
BEGIN
     IF OLD.state = NEW.state THEN
          NEW.updated_at := now();
          RETURN NEW;
     END IF;

     allowed := CASE OLD.state
          WHEN 'CREATED'            THEN ARRAY['HOLD_PENDING','TIMED_OUT']
          WHEN 'HOLD_PENDING'       THEN ARRAY['HOLD_CREATED','HOLD_FAILED','TIMED_OUT']
          WHEN 'HOLD_CREATED'       THEN ARRAY['PAYMENT_PENDING','RELEASE_PENDING','TIMED_OUT']
          WHEN 'PAYMENT_PENDING'    THEN ARRAY['PAYMENT_AUTHORIZED','PAYMENT_FAILED','PAYMENT_UNKNOWN','TIMED_OUT']
          -- UNKNOWN resolves only into a definite answer from the provider.
          WHEN 'PAYMENT_UNKNOWN'    THEN ARRAY['PAYMENT_AUTHORIZED','PAYMENT_FAILED','MANUAL_REVIEW']
          WHEN 'PAYMENT_AUTHORIZED' THEN ARRAY['CONFIRM_PENDING','REFUND_PENDING','MANUAL_REVIEW']
          -- Confirmation failing AFTER a successful charge must never silently
          -- drop: it goes to refund, or to a human.
          WHEN 'CONFIRM_PENDING'    THEN ARRAY['CONFIRMED','REFUND_PENDING','MANUAL_REVIEW']
          WHEN 'HOLD_FAILED'        THEN ARRAY['COMPENSATED']
          WHEN 'PAYMENT_FAILED'     THEN ARRAY['RELEASE_PENDING']
          WHEN 'TIMED_OUT'          THEN ARRAY['RELEASE_PENDING','PAYMENT_UNKNOWN','MANUAL_REVIEW']
          WHEN 'RELEASE_PENDING'    THEN ARRAY['RELEASED','MANUAL_REVIEW']
          WHEN 'RELEASED'           THEN ARRAY['COMPENSATED']
          WHEN 'REFUND_PENDING'     THEN ARRAY['COMPENSATED','MANUAL_REVIEW']
          WHEN 'MANUAL_REVIEW'      THEN ARRAY['COMPENSATED','CONFIRMED','RELEASE_PENDING']
          ELSE ARRAY[]::text[]
     END;

     IF NOT (NEW.state = ANY(allowed)) THEN
          RAISE EXCEPTION 'illegal saga transition: % -> % (saga %)', OLD.state, NEW.state, OLD.id
               USING ERRCODE = '23514';
     END IF;

     NEW.updated_at := now();
     IF NEW.state IN ('CONFIRMED','COMPENSATED','RELEASED') THEN
          NEW.completed_at := now();
     END IF;
     RETURN NEW;
END $$;

CREATE TRIGGER sagas_transition_guard
     BEFORE UPDATE ON sagas
     FOR EACH ROW EXECUTE FUNCTION saga_transition_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- Operational views
-- ────────────────────────────────────────────────────────────────────────────

-- Sagas past their step deadline. Every row is a customer waiting on something
-- that is not progressing.
CREATE VIEW stuck_sagas AS
SELECT s.id, s.reservation_id, s.state, s.attempts, s.last_error,
       now() - s.step_deadline_at AS overdue_by, r.customer_id
  FROM sagas s
  JOIN reservations r ON r.id = s.reservation_id
 WHERE s.state NOT IN ('CONFIRMED','COMPENSATED','RELEASED','MANUAL_REVIEW')
   AND s.step_deadline_at IS NOT NULL
   AND s.step_deadline_at < now();

-- Sagas holding money in an undetermined state. Highest-priority operational
-- signal in the system: a charge may exist with no booking behind it.
CREATE VIEW sagas_needing_attention AS
SELECT id, reservation_id, state, attempts, last_error, updated_at
  FROM sagas
 WHERE state IN ('PAYMENT_UNKNOWN','MANUAL_REVIEW','REFUND_PENDING');
