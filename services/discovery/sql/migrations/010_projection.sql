-- ============================================================================
-- Discovery read model.
--
-- A projection of inventory, shaped for search. It is DISCOVERY DATA: every
-- row carries `refreshed_at`, search responses report their age, and the
-- booking path never reads from here. A stale row can cost a user one retry
-- at booking time. It cannot cause an oversell.
--
-- How it stays current:
--
--   inventory.events  ──►  mark event dirty   (same transaction as the dedupe
--                                              marker, so a crash cannot drop it)
--   refresher         ──►  claim dirty rows with SKIP LOCKED, re-read
--                          availability from the inventory engine, upsert here
--                          and into Elasticsearch
--   resync            ──►  periodic full sweep, for events that never produced
--                          an event (bulk-seeded inventory) or whose events
--                          were lost
--
-- Events are treated as "this changed" signals, not as state. The projection
-- always re-reads the authority, so a missed or reordered event cannot leave it
-- permanently wrong — the next refresh corrects it.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE trips (
     event_id     uuid PRIMARY KEY,
     external_ref text        NOT NULL,
     name         text        NOT NULL,
     train_number text,
     train_name   text,
     starts_at    timestamptz NOT NULL,
     span_max     integer     NOT NULL,
     refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trip_stops (
     event_id       uuid    NOT NULL REFERENCES trips(event_id) ON DELETE CASCADE,
     position       integer NOT NULL,
     code           text    NOT NULL,
     label          text    NOT NULL,
     offset_minutes integer NOT NULL,
     PRIMARY KEY (event_id, position)
);

-- Fuzzy station matching when Elasticsearch is unavailable: "kanpr" still
-- finds Kanpur Central.
CREATE INDEX trip_stops_label_trgm ON trip_stops USING gin (label gin_trgm_ops);
CREATE INDEX trip_stops_code_idx ON trip_stops (code);

-- Availability for every (from, to) pair and class. Precomputed because the
-- question "is there a 3A seat from Kanpur to Howrah on the 21st?" must be
-- answerable without a scan of live allocations on every keystroke.
CREATE TABLE trip_segments (
     event_id       uuid    NOT NULL REFERENCES trips(event_id) ON DELETE CASCADE,
     span_from      integer NOT NULL,
     span_to        integer NOT NULL,
     class          text    NOT NULL,
     available      integer NOT NULL,
     total          integer NOT NULL,
     fare_cents     bigint  NOT NULL,
     tier           text    NOT NULL,
     refreshed_at   timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (event_id, span_from, span_to, class)
);

CREATE INDEX trip_segments_search_idx ON trip_segments (class, available);

-- Durable work queue for the refresher.
CREATE TABLE dirty_events (
     event_id  uuid PRIMARY KEY,
     marked_at timestamptz NOT NULL DEFAULT now(),
     reason    text
);
