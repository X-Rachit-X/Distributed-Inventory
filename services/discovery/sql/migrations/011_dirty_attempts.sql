-- Poison handling for the refresh queue.
--
-- Found in operation: test runs created inventory events and then deleted them.
-- Their dirty markers failed with 404 on every refresh, and because the
-- refresher takes the OLDEST rows first, a few permanently failing rows sat at
-- the head of the queue and starved every real refresh -- the database
-- equivalent of a poison message stalling a Kafka partition.
--
-- A failed refresh now counts an attempt and moves to the back of the queue;
-- after too many attempts it is dropped, and the periodic resync re-marks the
-- train if it genuinely still exists.

ALTER TABLE dirty_events ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE dirty_events ADD COLUMN last_error text;
