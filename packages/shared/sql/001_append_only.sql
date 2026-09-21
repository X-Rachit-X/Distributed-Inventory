-- ============================================================================
-- Append-only enforcement, available in every service database.
--
-- An audit trail that can be edited is not an audit trail. These triggers block
-- UPDATE and DELETE for every role, including the table owner, so "just fix the
-- row" is unavailable even to someone holding full credentials. History is
-- corrected by appending a compensating entry, exactly as in double-entry
-- bookkeeping.
--
-- Defined here rather than per service because reservation, payment and
-- reconciliation all need it for their own history tables.
-- ============================================================================

CREATE OR REPLACE FUNCTION tessera_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
     RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '0A000',
                HINT = 'Record a compensating entry instead of modifying history.';
END $$;

-- Idempotent: the inventory database created this trigger in its own migration
-- before this shared file existed.
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
     BEFORE UPDATE OR DELETE ON audit_log
     FOR EACH ROW EXECUTE FUNCTION tessera_append_only();
