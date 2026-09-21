-- ============================================================================
-- Close a hole found by testing migration 011 against a live database.
--
-- The original insert guard permitted rows to be created directly in CONFIRMED.
-- That allows AVAILABLE → CONFIRMED, skipping the hold entirely — precisely the
-- transition the business flow forbids, because a confirmation that never held
-- the resource never passed through payment authorisation either.
--
-- Allowed on INSERT:
--   HELD     — the only way a customer may claim inventory
--   BLOCKED  — an operator withdrawing a resource; no hold exists or should
--
-- CONFIRMED is now reachable only by transition from HELD, which the update
-- guard in 011 already restricts.
--
-- Recorded here rather than by editing 011: an applied migration is history,
-- and the runner rejects changes to one by checksum.
-- ============================================================================

CREATE OR REPLACE FUNCTION allocation_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
     IF NEW.state NOT IN ('HELD','BLOCKED') THEN
          RAISE EXCEPTION
               'allocations may only be created in HELD or BLOCKED (got %); CONFIRMED must be reached by confirming a hold',
               NEW.state
               USING ERRCODE = '23514',
                     HINT = 'Create a hold, then confirm it. Direct confirmation would bypass payment authorisation.';
     END IF;
     RETURN NEW;
END $$;

-- Any row that reached CONFIRMED without a hold predates this guard and is by
-- definition unaccounted for. Fail loudly rather than leave it in place.
DO $$
DECLARE orphans integer;
BEGIN
     SELECT count(*) INTO orphans FROM allocations WHERE state = 'CONFIRMED' AND hold_id IS NULL;
     IF orphans > 0 THEN
          RAISE WARNING
               '% confirmed allocation(s) have no hold; these could only have been created before this guard existed',
               orphans;
     END IF;
END $$;
