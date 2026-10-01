-- ============================================================================
-- Make a fresh install migrate cleanly.
--
-- THE DEFECT
-- The shared 001_append_only.sql creates the `audit_log_append_only` trigger in
-- every database. 011_ledger_and_guards.sql, written before that shared file
-- existed, creates the same trigger with a plain CREATE TRIGGER. On a database
-- that already had 011 applied this never mattered, but on a FRESH database the
-- runner applies 001 first and 011 then fails with "trigger already exists", so
-- `npm run migrate` could not complete on a new clone.
--
-- THE FIX
-- Both files are already applied on existing databases, and the runner rejects
-- edits to applied files by checksum. So, following the rule, this is a new
-- migration. It sorts between 010 and 011 and drops the shared copy of the
-- trigger only when 011 has not run yet, so 011 can create it. On a database
-- where 011 already ran it does nothing, and the trigger stays in place.
--
-- Either way the end state is identical: audit_log is append-only.
-- ============================================================================

DO $$
BEGIN
     IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '011_ledger_and_guards.sql') THEN
          DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
     END IF;
END $$;
