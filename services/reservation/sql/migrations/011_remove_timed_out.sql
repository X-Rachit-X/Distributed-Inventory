-- ============================================================================
-- Remove the TIMED_OUT saga state.
--
-- It was declared in 010 (in the CHECK list and in the transition trigger) but
-- no code ever moved a saga into it: every step's timeout goes to a specific
-- target named in the orchestrator's STEP_POLICY (HOLD_FAILED,
-- PAYMENT_UNKNOWN, REFUND_PENDING, MANUAL_REVIEW). A state nothing can reach is
-- one more thing every reader has to understand for no benefit.
--
-- The transition table is otherwise unchanged.
-- ============================================================================

-- Refuse rather than silently rewrite history, should a row ever exist.
DO $$
BEGIN
     IF EXISTS (SELECT 1 FROM sagas WHERE state = 'TIMED_OUT') THEN
          RAISE EXCEPTION 'sagas in TIMED_OUT exist; resolve them before applying this migration';
     END IF;
END $$;

ALTER TABLE sagas DROP CONSTRAINT sagas_state_check;
ALTER TABLE sagas ADD CONSTRAINT sagas_state_check CHECK (state IN (
     'CREATED',
     'HOLD_PENDING', 'HOLD_CREATED',
     'PAYMENT_PENDING', 'PAYMENT_AUTHORIZED',
     'PAYMENT_UNKNOWN',
     'CONFIRM_PENDING', 'CONFIRMED',
     'HOLD_FAILED', 'PAYMENT_FAILED',
     'RELEASE_PENDING', 'RELEASED',
     'REFUND_PENDING', 'COMPENSATED',
     'MANUAL_REVIEW'
));

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
          WHEN 'CREATED'            THEN ARRAY['HOLD_PENDING']
          WHEN 'HOLD_PENDING'       THEN ARRAY['HOLD_CREATED','HOLD_FAILED']
          WHEN 'HOLD_CREATED'       THEN ARRAY['PAYMENT_PENDING','RELEASE_PENDING']
          WHEN 'PAYMENT_PENDING'    THEN ARRAY['PAYMENT_AUTHORIZED','PAYMENT_FAILED','PAYMENT_UNKNOWN']
          -- UNKNOWN resolves only into a definite answer from the provider.
          WHEN 'PAYMENT_UNKNOWN'    THEN ARRAY['PAYMENT_AUTHORIZED','PAYMENT_FAILED','MANUAL_REVIEW']
          WHEN 'PAYMENT_AUTHORIZED' THEN ARRAY['CONFIRM_PENDING','REFUND_PENDING','MANUAL_REVIEW']
          -- Confirmation failing AFTER a successful charge must never silently
          -- drop: it goes to refund, or to a human.
          WHEN 'CONFIRM_PENDING'    THEN ARRAY['CONFIRMED','REFUND_PENDING','MANUAL_REVIEW']
          WHEN 'HOLD_FAILED'        THEN ARRAY['COMPENSATED']
          WHEN 'PAYMENT_FAILED'     THEN ARRAY['RELEASE_PENDING']
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
