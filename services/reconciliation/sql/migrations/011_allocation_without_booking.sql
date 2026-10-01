-- ============================================================================
-- New issue kind: ALLOCATION_WITHOUT_BOOKING.
--
-- A seat confirmed in inventory whose reservation is not confirmed. It means a
-- seat is withheld from sale with no customer holding a ticket for it — for
-- example a confirm that committed in inventory just before the saga gave up
-- and refunded. Inventory is still correct (nothing is oversold), but capacity
-- is silently lost, and nothing used to look for it.
-- ============================================================================

ALTER TABLE reconciliation_issues DROP CONSTRAINT reconciliation_issues_kind_check;
ALTER TABLE reconciliation_issues ADD CONSTRAINT reconciliation_issues_kind_check CHECK (kind IN (
     'CONFIRMED_WITHOUT_PAYMENT',
     'PAYMENT_WITHOUT_BOOKING',
     'EXPIRED_HOLD_STILL_ALLOCATED',
     'BOOKING_WITHOUT_ALLOCATION',
     'ALLOCATION_WITHOUT_BOOKING',
     'DUPLICATE_BOOKING',
     'ORPHAN_PAYMENT',
     'STUCK_SAGA',
     'PAYMENT_UNKNOWN_TOO_LONG',
     'LEDGER_DRIFT',
     'OUTBOX_BACKLOG'
));
