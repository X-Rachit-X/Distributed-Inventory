-- ============================================================================
-- Tessera Inventory Engine — core schema
--
-- THE CENTRAL IDEA
-- ----------------
-- Every kind of scarce inventory this engine models is the same shape:
-- a RESOURCE occupied over a SPAN.
--
--     railway      seat    occupied over a range of station stops   [3, 7)
--     hotel        room    occupied over a range of nights          [0, 3)
--     concert      seat    occupied for the one and only span       [0, 1)
--     appointment  slot    occupied for the one and only span       [0, 1)
--     rental       unit    occupied over a range of time slots      [9, 12)
--
-- Once inventory is expressed that way, "do not oversell" becomes exactly one
-- sentence: TWO LIVE ALLOCATIONS OF THE SAME RESOURCE MUST NOT OVERLAP.
--
-- PostgreSQL can enforce that sentence itself, with a GiST exclusion
-- constraint. That matters more than it first appears. It means overselling is
-- not prevented by application code being careful — it is prevented by the
-- database refusing to store the row. Every layer above (cache, queue, lock,
-- retry, application check) becomes an optimisation for throughput and user
-- experience, and none of them is load-bearing for correctness. A bug in any of
-- them costs latency, not a double-booked seat.
--
-- That single design decision also deletes an entire class of bug the previous
-- version of this system had: two code paths (whole-journey seats and
-- per-segment seats) maintained two different notions of "taken", and a request
-- that entered through one path could not see a claim made through the other.
-- Here there is one representation, so there is nothing to disagree.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- required to mix `resource_id =` with `span &&`
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- Events: a bookable occurrence. One train journey on one date, one hotel
-- stay window, one concert, one clinic day.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_events (
     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     -- Identifier owned by the catalog service (a schedule id, a show id).
     external_ref text        NOT NULL UNIQUE,
     domain       text        NOT NULL
                              CHECK (domain IN ('RAIL','HOTEL','CONCERT','APPOINTMENT','RENTAL','GENERIC')),
     name         text        NOT NULL,
     starts_at    timestamptz NOT NULL,

     -- How to read the span axis for this event. Documentation for humans and
     -- validation for the API; the engine itself treats every span identically.
     span_kind    text        NOT NULL CHECK (span_kind IN ('SEGMENT','NIGHT','SLOT','WHOLE')),
     -- Upper bound of the span axis: stop count for RAIL, night count for HOTEL,
     -- 1 for an all-or-nothing event.
     span_max     integer     NOT NULL CHECK (span_max > 0),

     state        text        NOT NULL DEFAULT 'ACTIVE'
                              CHECK (state IN ('ACTIVE','CLOSED','CANCELLED')),
     metadata     jsonb       NOT NULL DEFAULT '{}',
     created_at   timestamptz NOT NULL DEFAULT now(),
     updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_events_starts_idx ON inventory_events (starts_at) WHERE state = 'ACTIVE';

-- Names for the span axis: station stops, night dates, slot times. Lets the API
-- accept "New Delhi → Kanpur" and resolve it to [2, 5) without the caller
-- having to know sequence numbers.
CREATE TABLE span_points (
     event_id   uuid    NOT NULL REFERENCES inventory_events(id) ON DELETE CASCADE,
     position   integer NOT NULL CHECK (position >= 0),
     ref        text    NOT NULL,          -- station id, ISO date, slot id
     label      text    NOT NULL,          -- 'New Delhi', '2026-04-12'
     code       text,                      -- 'NDLS'
     metadata   jsonb   NOT NULL DEFAULT '{}',
     PRIMARY KEY (event_id, position),
     UNIQUE (event_id, ref)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Resource groups: coach, floor, section. Carries the topology used by
-- adjacency-aware allocation ("two seats together").
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE resource_groups (
     id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     event_id   uuid    NOT NULL REFERENCES inventory_events(id) ON DELETE CASCADE,
     code       text    NOT NULL,
     kind       text    NOT NULL DEFAULT 'COACH',
     class      text,
     row_count  integer,
     col_count  integer,
     metadata   jsonb   NOT NULL DEFAULT '{}',
     UNIQUE (event_id, code)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Resources: the individually allocatable things. A seat, a room, a slot.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_resources (
     id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     event_id         uuid    NOT NULL REFERENCES inventory_events(id) ON DELETE CASCADE,
     group_id         uuid    REFERENCES resource_groups(id) ON DELETE CASCADE,
     code             text    NOT NULL,              -- 'A1', 'Room 204'
     class            text    NOT NULL DEFAULT 'STANDARD',
     -- Grid position within the group. Adjacency = same row, consecutive column.
     row_idx          integer,
     col_idx          integer,
     base_price_cents bigint  NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0),
     state            text    NOT NULL DEFAULT 'ENABLED' CHECK (state IN ('ENABLED','RETIRED')),
     attributes       jsonb   NOT NULL DEFAULT '{}',
     created_at       timestamptz NOT NULL DEFAULT now(),
     UNIQUE (event_id, code)
);

CREATE INDEX inventory_resources_event_idx ON inventory_resources (event_id, class) WHERE state = 'ENABLED';
CREATE INDEX inventory_resources_grid_idx  ON inventory_resources (group_id, row_idx, col_idx);

-- ────────────────────────────────────────────────────────────────────────────
-- Holds: a customer's temporary claim over one or more allocations.
--
-- The TTL lives HERE, in the authoritative database, keyed off the database
-- clock. Redis may hold a mirror key to make cleanup prompt, but Redis being
-- down, slow, or flushed cannot extend a hold or resurrect an expired one.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE holds (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     event_id       uuid        NOT NULL REFERENCES inventory_events(id),
     customer_id    text        NOT NULL,
     reservation_id text,
     state          text        NOT NULL DEFAULT 'ACTIVE'
                                CHECK (state IN ('ACTIVE','CONFIRMED','EXPIRED','RELEASED','CANCELLED')),
     expires_at     timestamptz NOT NULL,
     item_count     integer     NOT NULL DEFAULT 0,
     total_cents    bigint      NOT NULL DEFAULT 0,
     correlation_id text,
     trace_id       text,
     created_at     timestamptz NOT NULL DEFAULT now(),
     updated_at     timestamptz NOT NULL DEFAULT now(),
     terminal_at    timestamptz,
     CONSTRAINT hold_expiry_after_creation CHECK (expires_at > created_at)
);

-- The sweeper's index. Partial, so it only ever contains live holds.
CREATE INDEX holds_expiry_idx  ON holds (expires_at) WHERE state = 'ACTIVE';
CREATE INDEX holds_customer_idx ON holds (customer_id) WHERE state = 'ACTIVE';
CREATE INDEX holds_reservation_idx ON holds (reservation_id);

-- ════════════════════════════════════════════════════════════════════════════
-- ALLOCATIONS — the table the entire system is built to protect.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TYPE allocation_state AS ENUM (
     'HELD',       -- temporarily claimed, has a TTL
     'CONFIRMED',  -- paid for and issued
     'BLOCKED',    -- withdrawn by an operator (damaged seat, maintenance)
     'EXPIRED',    -- TTL elapsed          ─┐
     'RELEASED',   -- voluntarily given up  ├─ terminal: no longer occupies anything
     'CANCELLED'   -- cancelled after confirm ─┘
);

CREATE TABLE allocations (
     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     event_id     uuid             NOT NULL REFERENCES inventory_events(id),
     resource_id  uuid             NOT NULL REFERENCES inventory_resources(id),

     -- Half-open interval [lower, upper). Half-open is the right choice: a
     -- passenger alighting at stop 5 and another boarding at stop 5 do not
     -- conflict, and `&&` models that correctly with no special-casing.
     span         int4range        NOT NULL,

     state        allocation_state NOT NULL,
     hold_id      uuid             REFERENCES holds(id),
     booking_id   text,
     customer_id  text,
     expires_at   timestamptz,
     price_cents  bigint           NOT NULL DEFAULT 0,
     reason       text,                          -- why BLOCKED, why CANCELLED
     created_at   timestamptz      NOT NULL DEFAULT now(),
     updated_at   timestamptz      NOT NULL DEFAULT now(),
     terminal_at  timestamptz,

     CONSTRAINT span_not_empty          CHECK (NOT isempty(span)),
     CONSTRAINT span_bounded            CHECK (lower(span) >= 0),
     CONSTRAINT held_has_expiry         CHECK (state <> 'HELD' OR expires_at IS NOT NULL),
     CONSTRAINT held_has_hold           CHECK (state <> 'HELD' OR hold_id IS NOT NULL),
     CONSTRAINT confirmed_has_booking   CHECK (state <> 'CONFIRMED' OR booking_id IS NOT NULL),
     CONSTRAINT blocked_has_reason      CHECK (state <> 'BLOCKED' OR reason IS NOT NULL)
);

-- ────────────────────────────────────────────────────────────────────────────
-- THE INVARIANT.
--
-- Two allocations of the same resource whose spans overlap cannot both be live.
-- The WHERE clause is essential: expired, released and cancelled rows stay in
-- the table as history but stop constraining anything, so the audit trail costs
-- nothing in availability.
--
-- Under a thousand concurrent requests for one seat, PostgreSQL serialises the
-- conflicting inserts on the GiST index and exactly one commits. The rest get
-- SQLSTATE 23P01, which the API returns as 409 Conflict. There is no window in
-- which the application could be tricked into allowing both, because the
-- application is not the one deciding.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE allocations
     ADD CONSTRAINT allocations_no_overlap
     EXCLUDE USING gist (resource_id WITH =, span WITH &&)
     WHERE (state IN ('HELD','CONFIRMED','BLOCKED'));

-- Sweeper and lazy-reap path: find expired holds fast.
CREATE INDEX allocations_expiry_idx ON allocations (expires_at) WHERE state = 'HELD';
-- Confirm path: all allocations belonging to one hold.
CREATE INDEX allocations_hold_idx ON allocations (hold_id) WHERE state = 'HELD';
-- Availability reads and the invariant verifier.
CREATE INDEX allocations_event_live_idx ON allocations (event_id, resource_id)
     WHERE state IN ('HELD','CONFIRMED','BLOCKED');
CREATE INDEX allocations_booking_idx ON allocations (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX allocations_customer_live_idx ON allocations (customer_id)
     WHERE state IN ('HELD','CONFIRMED');

-- ────────────────────────────────────────────────────────────────────────────
-- Quantity pools: inventory with no individual identity — meals, luggage
-- allowance, general-admission tickets. Counters, not intervals.
--
-- Buckets exist to spread a hot counter. One row per pool means every buyer of
-- a popular item queues on one row; N buckets turn that into N independent
-- queues. The trade-off is that a request must try buckets until one has room,
-- which is why bucket_count is configurable per pool rather than global.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_pools (
     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     event_id     uuid    NOT NULL REFERENCES inventory_events(id) ON DELETE CASCADE,
     code         text    NOT NULL,
     capacity     integer NOT NULL CHECK (capacity >= 0),
     bucket_count integer NOT NULL DEFAULT 1 CHECK (bucket_count > 0),
     price_cents  bigint  NOT NULL DEFAULT 0,
     UNIQUE (event_id, code)
);

CREATE TABLE pool_buckets (
     pool_id   uuid    NOT NULL REFERENCES inventory_pools(id) ON DELETE CASCADE,
     bucket    integer NOT NULL,
     capacity  integer NOT NULL CHECK (capacity >= 0),
     held      integer NOT NULL DEFAULT 0,
     confirmed integer NOT NULL DEFAULT 0,
     PRIMARY KEY (pool_id, bucket),
     -- The pool equivalent of the exclusion constraint: the database itself
     -- refuses to record more claims than capacity.
     CONSTRAINT pool_bucket_never_oversold
          CHECK (held >= 0 AND confirmed >= 0 AND held + confirmed <= capacity)
);

CREATE TABLE pool_claims (
     id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     hold_id    uuid    REFERENCES holds(id),
     pool_id    uuid    NOT NULL REFERENCES inventory_pools(id),
     bucket     integer NOT NULL,
     quantity   integer NOT NULL CHECK (quantity > 0),
     state      text    NOT NULL DEFAULT 'HELD'
                        CHECK (state IN ('HELD','CONFIRMED','RELEASED','EXPIRED','CANCELLED')),
     booking_id text,
     expires_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pool_claims_hold_idx   ON pool_claims (hold_id);
CREATE INDEX pool_claims_expiry_idx ON pool_claims (expires_at) WHERE state = 'HELD';
