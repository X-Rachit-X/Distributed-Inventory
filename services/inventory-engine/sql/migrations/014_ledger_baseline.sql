-- ============================================================================
-- Fix the ledger baseline, found by the ledger-fold test.
--
-- THE DEFECT
-- The fold summed movement deltas and compared them against observed
-- availability, but nothing ever recorded the inventory's STARTING balance. A
-- seat that existed and was then held folded to -1 while actually sitting at 0
-- available, so every allocated resource reported drift. The invariant was
-- firing on correct data — the accounting was incomplete, not the inventory.
--
-- Double-entry bookkeeping has the same rule: you cannot audit movements
-- without an opening balance. Creating a resource is itself an inventory event
-- (+1 available) and must be recorded as `CAPACITY_ADDED`, exactly as the
-- entry_type list always anticipated.
--
-- A SECOND, QUIETER DEFECT
-- The old view INNER JOINed the fold, so a resource with NO ledger rows at all
-- was silently excluded from the check. That is precisely the case most worth
-- catching: inventory that exists but was never accounted for. The view now
-- drives from `inventory_resources`, so unaccounted resources surface as drift
-- rather than disappearing from the report.
-- ============================================================================

-- Opening balance for every resource created before this migration.
INSERT INTO inventory_ledger (event_id, resource_id, entry_type, delta, actor, reason)
SELECT r.event_id, r.id, 'CAPACITY_ADDED', 1, 'system:migration-014', 'opening balance backfill'
  FROM inventory_resources r
 WHERE NOT EXISTS (
          SELECT 1 FROM inventory_ledger l
           WHERE l.resource_id = r.id AND l.entry_type = 'CAPACITY_ADDED'
       );

CREATE OR REPLACE VIEW invariant_ledger_drift AS
WITH fold AS (
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
SELECT ac.resource_id,
       COALESCE(f.ledger_available, 0) AS ledger_available,
       ac.actual_available,
       COALESCE(f.ledger_available, 0) - ac.actual_available AS drift
  FROM actual ac
  LEFT JOIN fold f USING (resource_id)
 WHERE COALESCE(f.ledger_available, 0) <> ac.actual_available;

-- ────────────────────────────────────────────────────────────────────────────
-- Scoped invariant check.
--
-- `invariant_summary` answers "is the whole database healthy", which is the
-- right question for the correctness scoreboard and the reconciliation worker.
-- It is the wrong question for a single test, which must not fail because an
-- unrelated event left an outbox row unpublished. This function answers "is
-- THIS event's inventory correct", so a test asserts only on what it caused.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invariants_for_event(p_event_id uuid)
RETURNS TABLE (invariant text, severity text, violations bigint)
LANGUAGE sql STABLE AS $$
     SELECT 'I1_overlapping_allocations', 'CRITICAL',
            (SELECT count(*) FROM invariant_overlapping_allocations WHERE event_id = p_event_id)
     UNION ALL
     SELECT 'I3_expired_still_held', 'HIGH',
            (SELECT count(*) FROM invariant_expired_still_held e
              WHERE EXISTS (SELECT 1 FROM allocations a
                             WHERE a.id = e.allocation_id AND a.event_id = p_event_id))
     UNION ALL
     SELECT 'I4_ledger_drift', 'CRITICAL',
            (SELECT count(*) FROM invariant_ledger_drift d
              WHERE EXISTS (SELECT 1 FROM inventory_resources r
                             WHERE r.id = d.resource_id AND r.event_id = p_event_id))
     UNION ALL
     SELECT 'I7_duplicate_bookings', 'CRITICAL',
            (SELECT count(*) FROM invariant_duplicate_bookings b
              WHERE EXISTS (SELECT 1 FROM inventory_resources r
                             WHERE r.id = b.resource_id AND r.event_id = p_event_id));
$$;
