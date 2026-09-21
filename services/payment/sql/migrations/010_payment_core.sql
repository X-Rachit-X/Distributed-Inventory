-- ============================================================================
-- Payment service.
--
-- THE CENTRAL IDEA: UNKNOWN IS A STATE.
--
-- Most payment integrations model two outcomes, success and failure. Reality
-- has a third and it is the dangerous one:
--
--     Tessera → provider          request sent
--                                 provider charges the customer
--               ← × network timeout
--     Tessera                     ...knows nothing
--
-- The money may have moved. Treating that as failure and releasing the seat
-- leaves a charged customer with no booking. Treating it as success books a
-- seat that may never be paid for. Retrying the charge may charge twice.
--
-- The only correct response is to admit ignorance, record UNKNOWN, and ASK THE
-- PROVIDER what happened — using our own idempotency key as the reference. A
-- resolver worker does exactly that, and the saga waits rather than guessing.
--
-- The previous version had a related and worse bug: a client submitting a bad
-- signature moved the order permanently to FAILED, so a later genuine webhook
-- for the same order was discarded as an invalid state transition. The customer
-- was charged and the booking never confirmed. Here, signature verification
-- failure is recorded as an ATTEMPT and never transitions the payment.
-- ============================================================================

CREATE TABLE payments (
     id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     reservation_id   uuid        NOT NULL,
     customer_id      text        NOT NULL,
     amount_cents     bigint      NOT NULL CHECK (amount_cents > 0),
     currency         text        NOT NULL DEFAULT 'INR',

     state            text        NOT NULL DEFAULT 'CREATED' CHECK (state IN (
                           'CREATED',
                           'AUTHORIZED',
                           'CAPTURED',
                           'FAILED',
                           'CANCELLED',
                           'UNKNOWN',          -- provider did not answer; must be resolved, not guessed
                           'REFUND_PENDING',
                           'REFUNDED',
                           'PARTIALLY_REFUNDED'
                      )),

     provider         text        NOT NULL DEFAULT 'fake',
     -- Our key, sent to the provider so a retry is recognised as the same
     -- charge rather than a second one. Unique: one payment per key, enforced
     -- by the database rather than by remembering to check.
     idempotency_key  text        NOT NULL UNIQUE,
     provider_ref     text,                        -- provider's order id
     provider_payment_id text     UNIQUE,          -- provider's payment id
     failure_reason   text,

     -- Resolver bookkeeping for UNKNOWN payments.
     unknown_since    timestamptz,
     resolve_attempts integer     NOT NULL DEFAULT 0,
     next_resolve_at  timestamptz,

     metadata         jsonb       NOT NULL DEFAULT '{}',
     created_at       timestamptz NOT NULL DEFAULT now(),
     updated_at       timestamptz NOT NULL DEFAULT now(),
     authorized_at    timestamptz,
     captured_at      timestamptz
);

CREATE INDEX payments_reservation_idx ON payments (reservation_id);
CREATE INDEX payments_customer_idx    ON payments (customer_id, created_at DESC);
-- The resolver's work queue.
CREATE INDEX payments_unknown_idx     ON payments (next_resolve_at) WHERE state = 'UNKNOWN';

-- ────────────────────────────────────────────────────────────────────────────
-- Payment state machine.
--
--   CREATED ──▶ AUTHORIZED ──▶ CAPTURED ──▶ REFUND_PENDING ──▶ REFUNDED
--      │                                                    └─▶ PARTIALLY_REFUNDED
--      ├──▶ FAILED
--      ├──▶ CANCELLED
--      └──▶ UNKNOWN ──▶ AUTHORIZED | CAPTURED | FAILED   (resolver only)
--
-- Note there is no path OUT of FAILED. A failed payment is terminal, which is
-- why it must never be entered on a client's bad signature — only on the
-- provider's own word.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION payment_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
     allowed text[];
BEGIN
     IF OLD.state = NEW.state THEN
          NEW.updated_at := now();
          RETURN NEW;
     END IF;

     allowed := CASE OLD.state
          WHEN 'CREATED'            THEN ARRAY['AUTHORIZED','CAPTURED','FAILED','CANCELLED','UNKNOWN']
          WHEN 'AUTHORIZED'         THEN ARRAY['CAPTURED','FAILED','CANCELLED','UNKNOWN']
          WHEN 'CAPTURED'           THEN ARRAY['REFUND_PENDING']
          WHEN 'UNKNOWN'            THEN ARRAY['AUTHORIZED','CAPTURED','FAILED','CANCELLED']
          WHEN 'REFUND_PENDING'     THEN ARRAY['REFUNDED','PARTIALLY_REFUNDED','CAPTURED']
          WHEN 'PARTIALLY_REFUNDED' THEN ARRAY['REFUND_PENDING','REFUNDED']
          ELSE ARRAY[]::text[]
     END;

     IF NOT (NEW.state = ANY(allowed)) THEN
          RAISE EXCEPTION 'illegal payment transition: % -> % (payment %)', OLD.state, NEW.state, OLD.id
               USING ERRCODE = '23514';
     END IF;

     NEW.updated_at := now();
     IF NEW.state = 'AUTHORIZED' AND NEW.authorized_at IS NULL THEN NEW.authorized_at := now(); END IF;
     IF NEW.state = 'CAPTURED'   AND NEW.captured_at   IS NULL THEN NEW.captured_at   := now(); END IF;
     IF NEW.state = 'UNKNOWN'    AND NEW.unknown_since IS NULL THEN NEW.unknown_since := now(); END IF;
     RETURN NEW;
END $$;

CREATE TRIGGER payments_transition_guard
     BEFORE UPDATE ON payments
     FOR EACH ROW EXECUTE FUNCTION payment_transition_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- Refunds. Separate rows because partial refunds are normal and a single
-- `refunded_amount` column loses the history of who refunded what and why.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE refunds (
     id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     payment_id       uuid        NOT NULL REFERENCES payments(id),
     amount_cents     bigint      NOT NULL CHECK (amount_cents > 0),
     reason           text,
     state            text        NOT NULL DEFAULT 'INITIATED'
                                  CHECK (state IN ('INITIATED','PROCESSING','COMPLETED','FAILED','UNKNOWN')),
     idempotency_key  text        NOT NULL UNIQUE,
     provider_refund_id text      UNIQUE,
     failure_reason   text,
     created_at       timestamptz NOT NULL DEFAULT now(),
     updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refunds_payment_idx ON refunds (payment_id);

-- Total refunded must never exceed what was captured. Enforced by trigger
-- because it is a cross-row invariant a CHECK cannot express.
CREATE OR REPLACE FUNCTION refund_cannot_exceed_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
     paid bigint;
     refunded bigint;
BEGIN
     SELECT amount_cents INTO paid FROM payments WHERE id = NEW.payment_id;
     SELECT COALESCE(sum(amount_cents), 0) INTO refunded
       FROM refunds
      WHERE payment_id = NEW.payment_id AND state <> 'FAILED' AND id <> NEW.id;

     IF refunded + NEW.amount_cents > paid THEN
          RAISE EXCEPTION 'refunds (% + %) would exceed captured amount % for payment %',
               refunded, NEW.amount_cents, paid, NEW.payment_id
               USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
END $$;

CREATE TRIGGER refunds_cannot_exceed
     BEFORE INSERT OR UPDATE ON refunds
     FOR EACH ROW EXECUTE FUNCTION refund_cannot_exceed_payment();

-- ────────────────────────────────────────────────────────────────────────────
-- Provider events (webhooks).
--
-- Every webhook is recorded before it is acted upon, keyed by the provider's
-- own event id. A replayed webhook — whether from a provider retry or an
-- attacker capturing and resending one — finds its row already present and is
-- ignored. This is replay protection and an audit trail in one table.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE provider_events (
     id                bigserial PRIMARY KEY,
     provider          text        NOT NULL,
     provider_event_id text        NOT NULL,
     event_type        text        NOT NULL,
     payment_id        uuid,
     payload           jsonb       NOT NULL,
     signature_valid   boolean     NOT NULL,
     processed         boolean     NOT NULL DEFAULT false,
     received_at       timestamptz NOT NULL DEFAULT now(),
     UNIQUE (provider, provider_event_id)
);

CREATE INDEX provider_events_payment_idx ON provider_events (payment_id);

-- Failed signature verifications. Kept separately from payment state precisely
-- so that a bad signature can never move a payment to a terminal state — the
-- bug this design exists to prevent.
CREATE TABLE signature_failures (
     id          bigserial PRIMARY KEY,
     provider    text        NOT NULL,
     payload     text,
     reason      text        NOT NULL,
     source_ip   text,
     received_at timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Operational views
-- ────────────────────────────────────────────────────────────────────────────

CREATE VIEW payments_awaiting_resolution AS
SELECT id, reservation_id, amount_cents, provider, provider_ref,
       resolve_attempts, now() - unknown_since AS unknown_for
  FROM payments
 WHERE state = 'UNKNOWN';

-- Money captured with nothing behind it, after a grace window.
-- Cross-service state is not atomic, so a young mismatch is normal; only a
-- persistent one is a problem.
CREATE VIEW invariant_captured_without_reservation AS
SELECT id AS payment_id, reservation_id, amount_cents, captured_at
  FROM payments
 WHERE state = 'CAPTURED'
   AND captured_at < now() - interval '5 minutes'
   AND reservation_id IS NULL;
