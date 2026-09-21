-- ============================================================================
-- Reconciliation service.
--
-- Every other service is built to keep state correct. This one assumes they
-- will occasionally fail anyway, and makes that visible rather than leaving it
-- to be discovered by a customer.
--
-- The system spans several databases, so no snapshot across them is atomic. A
-- reservation confirmed a millisecond ago may not yet have its booking row. So
-- a mismatch is only an ISSUE after a grace window AND a re-check — otherwise
-- reconciliation would generate false alarms continuously and be ignored,
-- which is the usual fate of such tools.
--
-- Repair policy, stated once and enforced throughout:
--   - inventory-only repairs (releasing an expired hold, re-driving a stuck
--     saga step) may be automatic; they are reversible and move no money.
--   - anything involving money produces a RECOMMENDATION and waits for a human.
--     An automated refund loop that misfires is worse than the inconsistency
--     it was trying to fix.
-- ============================================================================

CREATE TABLE recon_runs (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     started_at     timestamptz NOT NULL DEFAULT now(),
     finished_at    timestamptz,
     checks_run     integer     NOT NULL DEFAULT 0,
     issues_found   integer     NOT NULL DEFAULT 0,
     issues_repaired integer    NOT NULL DEFAULT 0,
     duration_ms    integer,
     error          text
);

CREATE TABLE reconciliation_issues (
     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     run_id        uuid        REFERENCES recon_runs(id),

     kind          text        NOT NULL CHECK (kind IN (
                        'CONFIRMED_WITHOUT_PAYMENT',   -- seat issued, no captured payment
                        'PAYMENT_WITHOUT_BOOKING',     -- money taken, nothing issued
                        'EXPIRED_HOLD_STILL_ALLOCATED',-- TTL elapsed, inventory still withheld
                        'BOOKING_WITHOUT_ALLOCATION',  -- booking exists, inventory does not
                        'DUPLICATE_BOOKING',           -- two bookings, one resource-span
                        'ORPHAN_PAYMENT',              -- payment with no reservation
                        'STUCK_SAGA',                  -- past its deadline, not progressing
                        'PAYMENT_UNKNOWN_TOO_LONG',    -- provider never resolved
                        'LEDGER_DRIFT',                -- ledger fold disagrees with state
                        'OUTBOX_BACKLOG'               -- events committed but never published
                   )),

     severity      text        NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
     entity_type   text        NOT NULL,
     entity_id     text        NOT NULL,
     expected      jsonb,
     actual        jsonb,
     detail        text,

     -- `money_involved` gates automatic repair. Set by the check, not inferred
     -- later, so the decision is explicit at the point of detection.
     money_involved boolean    NOT NULL DEFAULT false,

     repair_status text        NOT NULL DEFAULT 'OPEN' CHECK (repair_status IN (
                        'OPEN',
                        'AUTO_REPAIRED',
                        'AWAITING_HUMAN',    -- a recommendation exists; nothing has been done
                        'REPAIRED_BY_HUMAN',
                        'RESOLVED_ITSELF',   -- gone on re-check: the grace window did its job
                        'IGNORED'
                   )),
     recommended_action text,
     repair_detail text,
     repaired_by   text,

     -- Confirmation counter. An issue is only reported once it has survived
     -- more than one pass, which filters out in-flight state.
     seen_count    integer     NOT NULL DEFAULT 1,
     first_seen_at timestamptz NOT NULL DEFAULT now(),
     last_seen_at  timestamptz NOT NULL DEFAULT now(),
     resolved_at   timestamptz,

     UNIQUE (kind, entity_type, entity_id)
);

CREATE INDEX recon_issues_open_idx ON reconciliation_issues (severity, first_seen_at)
     WHERE repair_status IN ('OPEN','AWAITING_HUMAN');
CREATE INDEX recon_issues_kind_idx ON reconciliation_issues (kind, repair_status);

-- Every repair, automatic or human, leaves a record.
CREATE TABLE repair_log (
     id          bigserial PRIMARY KEY,
     issue_id    uuid        NOT NULL REFERENCES reconciliation_issues(id),
     action      text        NOT NULL,
     automatic   boolean     NOT NULL,
     actor       text        NOT NULL,
     before      jsonb,
     after       jsonb,
     outcome     text        NOT NULL CHECK (outcome IN ('SUCCESS','FAILED','SKIPPED')),
     detail      text,
     created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER repair_log_append_only
     BEFORE UPDATE OR DELETE ON repair_log
     FOR EACH ROW EXECUTE FUNCTION tessera_append_only();

-- ────────────────────────────────────────────────────────────────────────────
-- The Correctness Scoreboard.
--
-- One row per invariant, with its current violation count. This is what the
-- dashboard renders and what a chaos run asserts against after the system has
-- been attacked. Every number should read zero.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE scoreboard_snapshots (
     id          bigserial PRIMARY KEY,
     captured_at timestamptz NOT NULL DEFAULT now(),
     metrics     jsonb       NOT NULL,
     all_clear   boolean     NOT NULL
);

CREATE INDEX scoreboard_recent_idx ON scoreboard_snapshots (captured_at DESC);

CREATE VIEW scoreboard_current AS
SELECT
     (SELECT count(*) FROM reconciliation_issues
       WHERE repair_status IN ('OPEN','AWAITING_HUMAN') AND severity = 'CRITICAL') AS critical_issues,
     (SELECT count(*) FROM reconciliation_issues
       WHERE repair_status IN ('OPEN','AWAITING_HUMAN')) AS open_issues,
     (SELECT count(*) FROM reconciliation_issues
       WHERE kind = 'DUPLICATE_BOOKING' AND repair_status IN ('OPEN','AWAITING_HUMAN')) AS duplicate_bookings,
     (SELECT count(*) FROM reconciliation_issues
       WHERE kind = 'LEDGER_DRIFT' AND repair_status IN ('OPEN','AWAITING_HUMAN')) AS ledger_mismatches,
     (SELECT count(*) FROM reconciliation_issues
       WHERE kind = 'EXPIRED_HOLD_STILL_ALLOCATED' AND repair_status IN ('OPEN','AWAITING_HUMAN')) AS orphaned_holds,
     (SELECT count(*) FROM reconciliation_issues
       WHERE kind = 'PAYMENT_WITHOUT_BOOKING' AND repair_status IN ('OPEN','AWAITING_HUMAN')) AS payments_without_booking,
     (SELECT count(*) FROM reconciliation_issues
       WHERE kind = 'STUCK_SAGA' AND repair_status IN ('OPEN','AWAITING_HUMAN')) AS stuck_sagas,
     (SELECT max(finished_at) FROM recon_runs WHERE finished_at IS NOT NULL) AS last_run_at;
