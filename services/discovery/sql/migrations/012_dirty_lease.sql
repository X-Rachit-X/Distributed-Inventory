-- ============================================================================
-- Lease the refresh queue instead of locking it.
--
-- The refresher used to claim dirty trains with SELECT … FOR UPDATE SKIP LOCKED
-- and keep that transaction open while it called the inventory engine and
-- Elasticsearch over HTTP. A slow dependency then held row locks and a pooled
-- connection for as long as it was slow, against the project's rule of no
-- network I/O inside a transaction.
--
-- Now a short transaction stamps a lease and commits; the refresh runs with no
-- transaction open; a second short statement finishes the row. A replica that
-- dies mid-refresh lets its lease lapse and another replica takes the train.
-- ============================================================================

ALTER TABLE dirty_events ADD COLUMN lease_until timestamptz;
