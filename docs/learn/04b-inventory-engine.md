# 04b · File by file — `services/inventory-engine` (the authority)

> 📍 **Reference page:** look things up here, no need to read it top to bottom. Reading path: [01](01-level1-big-picture.md) → [02](02-level2-how-it-works.md) → [code](../README.md#step-3-read-the-code-in-the-order-a-booking-flows) → [03](03-level3-deep-dive.md) → [05](05-failure-scenarios.md) → [06](06-resume-and-interview.md) · [Docs home](../README.md) · [File map](04-file-map.md)

This service is the **only** thing allowed to write allocations. Every other
service asks it. If you understand this folder, you understand why Tessera can't
oversell.

```
inventory-engine/
├── sql/migrations/
│   ├── 010_inventory_core.sql      tables + THE exclusion constraint
│   ├── 010a_fresh_install_trigger_order.sql  fix: a fresh install migrates cleanly
│   ├── 011_ledger_and_guards.sql   ledger, state-machine triggers, invariant views
│   ├── 012_tighten_insert_guard.sql  fix: no direct CONFIRMED inserts
│   ├── 013_lab_schema.sql          isolated tables for the Contention Lab
│   └── 014_ledger_baseline.sql     fix: opening balance + better drift view
├── src/
│   ├── index.js                    HTTP API + starts the sweeper and outbox relay
│   ├── config/index.js             config (built on the shared helpers)
│   ├── engine/reserve.js           ⭐ the hot path
│   ├── engine/confirm.js           confirm / release / cancel
│   ├── engine/admin.js             block / unblock seats (operators)
│   ├── engine/availability.js      read queries (seat map, counts, segments, adjacent)
│   ├── engine/ledger.js            ledger writes and folds
│   └── workers/expiry.worker.js    hold sweeper
└── test/                           helpers + 10 integration tests
```

---

## `sql/migrations/010_inventory_core.sql`

The header comment (lines 1-31) is the project's thesis. Read it once.

| Lines | Object | Explanation |
|---|---|---|
| 33-34 | `btree_gist`, `pgcrypto` extensions | btree_gist lets a GiST index handle `resource_id =` (a plain equality) alongside `span &&` |
| 40-63 | `inventory_events` | a bookable occurrence. `external_ref` (catalog id, unique), `domain` (`RAIL/HOTEL/CONCERT/APPOINTMENT/RENTAL/GENERIC`), `span_kind` (`SEGMENT/NIGHT/SLOT/WHOLE`, how to read the axis), `span_max` (> 0: stop count, nights…), `state` (`ACTIVE/CLOSED/CANCELLED`), `metadata` jsonb (train number/name). Partial index on start time for active events |
| 68-77 | `span_points` | names for positions on the axis: `(event_id, position)` → `ref`, `label` ("New Delhi"), `code` ("NDLS"). Lets the UI say "Delhi → Kanpur" instead of `[0,1)` |
| 83-93 | `resource_groups` | coach / floor / section; `class`, grid size |
| 98-115 | `inventory_resources` | the seats. `code` (unique per event), `class`, `row_idx/col_idx` (adjacency), `base_price_cents ≥ 0`, `state` (`ENABLED/RETIRED`) |
| 124-145 | `holds` | a customer's temporary claim: `customer_id`, `reservation_id`, `state` (`ACTIVE/CONFIRMED/EXPIRED/RELEASED/CANCELLED`), **`expires_at`** (DB clock), `item_count`, `total_cents`, ids; `CHECK (expires_at > created_at)`. Partial indexes: expiry (only ACTIVE), customer (only ACTIVE) |
| 150-157 | `allocation_state` enum | HELD, CONFIRMED, BLOCKED (live) / EXPIRED, RELEASED, CANCELLED (terminal) |
| 159-186 | **`allocations`** | `resource_id`, **`span int4range`** (half-open), `state`, `hold_id`, `booking_id`, `customer_id`, `expires_at`, `price_cents`, `reason`. CHECKs: span not empty, lower ≥ 0, HELD ⇒ has expiry and hold, CONFIRMED ⇒ has booking, BLOCKED ⇒ has reason |
| 202-205 | **`allocations_no_overlap`** | `EXCLUDE USING gist (resource_id WITH =, span WITH &&) WHERE (state IN ('HELD','CONFIRMED','BLOCKED'))`. **The invariant.** Losers get 23P01 |
| 208-216 | partial indexes | expiry (HELD only, for sweeper + lazy reap), hold_id (HELD only, for confirm), event+resource (live only, for availability), booking, customer |
| 227-235 | `inventory_pools` | quantity stock (meals): `capacity`, `bucket_count`, `price_cents` |
| 237-248 | `pool_buckets` | `(pool_id, bucket)` → `capacity, held, confirmed`; **`CHECK (held + confirmed <= capacity)`**, the pool's anti-oversell constraint |
| 250-265 | `pool_claims` | which hold claimed how many units from which bucket |

## `sql/migrations/011_ledger_and_guards.sql`

| Lines (in file) | Object | Explanation |
|---|---|---|
| ~1-20 | comment | "the ledger is a proof, not a log"; "illegal transitions are impossible, not merely unimplemented" |
| ~25-56 | `inventory_ledger` | `entry_type` CHECK list, **signed `delta`**, links (allocation/hold/booking), `actor`, `reason`, request/correlation/trace ids. 4 indexes |
| ~66-80 | `tessera_append_only()` + triggers on `inventory_ledger` and `audit_log` | history can't be edited, not even by the owner |
| ~98-128 | `allocation_transition_guard()` | same state → just bump `updated_at`. Else allow only HELD→{CONFIRMED, EXPIRED, RELEASED, CANCELLED}, CONFIRMED→CANCELLED, BLOCKED→RELEASED; otherwise `RAISE … ERRCODE 23514`. Terminal → set `terminal_at`, **null `expires_at`** (so expiry queries ignore it) |
| ~132-144 | `allocation_insert_guard()` | (later tightened by 012) |
| ~149-169 | `hold_transition_guard()` | ACTIVE → any terminal state; nothing else |
| ~185-200 | `invariant_overlapping_allocations` (I1) | self-join on same resource, `a.id < b.id`, `span &&`, both live. Proves the constraint independently and catches a future migration that weakens it |
| ~203-207 | `invariant_oversold_pools` (I2) | |
| ~212-217 | `invariant_expired_still_held` (I3) | HELD with `expires_at <= now()` |
| ~220-226 | `invariant_hold_allocation_mismatch` (I3b) | e.g. hold CONFIRMED but an allocation still HELD |
| ~230-247 | `invariant_ledger_drift` (I4) | first version, replaced in 014 |
| ~251-257 | `invariant_duplicate_bookings` (I7) | same resource+span CONFIRMED more than once |
| ~261-266 | `invariant_outbox_backlog` (I6) | PENDING for more than 60 s |
| ~270-284 | `invariant_summary` | one row per invariant: name, severity, violation count |

## `010a_fresh_install_trigger_order.sql`

A fix found while setting up a clean test database. The shared
`001_append_only.sql` creates the `audit_log_append_only` trigger, and 011 (written
before the shared file existed) creates it again with a plain `CREATE TRIGGER`. On
an existing database nothing happened, but on a **fresh** one 011 failed with
"trigger already exists", so `npm run migrate` could not finish on a new clone.
Applied files can't be edited (checksums), so this new file sorts between 010 and
011 and drops the shared copy **only if 011 hasn't run yet**. The end state is the
same either way: `audit_log` is append-only.

## `012_tighten_insert_guard.sql`

Rewrites `allocation_insert_guard()`: only **HELD** or **BLOCKED** may be inserted.
CONFIRMED is reachable only via HELD. A direct insert would have skipped payment
authorisation. Then a `DO $$ … $$` block **warns** if any CONFIRMED rows without a
hold already exist. The comment explains why the fix is a new file: the runner
rejects edits to an applied migration.

## `013_lab_schema.sql`

A separate `lab` schema for the Contention Lab, keyed by `run_id`, so lab traffic
never touches real inventory: `lab.runs` (scenario, strategy, seed, git commit,
params, results), `lab.resource_state` (status + version for the naive/CAS
strategies), **`lab.allocations_unsafe` (no constraint, the control group)**,
`lab.allocations_guarded` (exclusion constraint on `run_id =, resource_id =,
span &&`), `lab.pool_buckets` (with `CHECK taken <= capacity`) and its unguarded
twin `lab.pool_buckets_unsafe`, and `lab.observations` (per-request outcome
SUCCESS/CONFLICT/ERROR/TIMEOUT).

## `014_ledger_baseline.sql`

1. Backfill `CAPACITY_ADDED +1` for every resource missing one (the opening
   balance).
2. Replace `invariant_ledger_drift`. It now drives **from `inventory_resources`**
   with a LEFT JOIN to the fold, so a resource with no ledger rows at all shows up
   as drift instead of vanishing.
3. Add `invariants_for_event(uuid)`: the same checks scoped to one event, so a test
   only asserts on what it caused.

---

## `src/engine/reserve.js` ⭐ (read this one slowly)

The header comment (lines 1-42) states the transaction boundary and the two
subtleties: **lazy expiry** and **deterministic ordering**.

| Lines | Code | What and why |
|---|---|---|
| 56-58 | TTL default 600 s, min 30, max 1800 | clamp client-requested TTLs |
| 61 | `spanLiteral(lo, hi)` → `'[lo,hi)'` | matches `int4range` half-open semantics |
| 77-84 | `reserve(client, req)`: actor; clamp TTL | `client` is a **transaction client** from the caller |
| 86-90 | at least one resource or pool item | 400 otherwise |
| 93-101 | **step 1**: load the event; 404 if unknown; 409 `EVENT_NOT_ACTIVE` if closed/cancelled | |
| 104 | **step 2**: `resolveResources` | codes → ids, validate spans |
| 107-109 | **step 3**: sort by `(resourceId, spanFrom)` | one global lock order, so no deadlock cycles |
| 137-146 | **step 4**: `SELECT id FROM inventory_resources WHERE id = ANY($1) ORDER BY id FOR UPDATE` | the **orderly queue**. The comment (112-136) gives the measured story: 609 deadlocks → 0, 9.6 → 575 req/s. "Throughput optimisation, not the correctness mechanism" |
| 149-151 | **step 5**: `reapExpired` on these resources | lazy expiry, after the lock so nobody races the reap |
| 154-171 | **step 6**: `INSERT holds … expires_at = now() + ttl` | DB clock. `holdId` may be supplied (tests) or generated |
| 178-235 | **step 7**: for each item, `INSERT allocations (…, 'HELD', hold_id, customer, expires_at, price_cents)`; on success push to `allocations` and add a ledger entry `ALLOCATED −1` | the exclusion constraint checks every insert |
| 222-233 | `catch`: `isOversellPrevented(err)` → metric + `ConflictError('RESOURCE_UNAVAILABLE')` with details | 23P01 → 409. Any other error rethrows → 500 (a real fault). Throwing rolls back the **whole** transaction, so multi-seat bookings are all-or-nothing |
| 238-262 | **step 8**: `claimPool` per pool item; ledger `ALLOCATED −quantity` | |
| 264 | `UPDATE holds SET total_cents` | the amount that will be charged |
| 267 | **step 9**: `ledger.append(client, entries)` | one multi-row insert |
| 270-298 | **step 10**: `nextSeq(client, eventId)` + `enqueue('inventory.events', 'inventory.held', …)` | the outbox, in the same tx. Aggregate = the inventory event (train), so discovery receives one train's events in order |
| 302 | `failpoint('reserve.before_commit')` | chaos: everything written, crash → rollback, nothing consumed |
| 304-314 | return the hold summary | the caller (`withIdempotency`) commits and stores it as the response |
| 324-373 | `resolveResources`: validate integers, `0 ≤ from < to ≤ spanMax`; **one query** for all ids/codes (N queries would lengthen lock time); 404 if missing; 409 `RESOURCE_DISABLED` if retired; price = `r.priceCents ?? base_price_cents` | the server-quoted price arrives via the saga context |
| 382-429 | `reapExpired(client, resourceIds)`: `UPDATE allocations SET state='EXPIRED' WHERE state='HELD' AND expires_at <= now() AND resource_id = ANY($1) RETURNING …`; ledger `EXPIRED +1` (actor `system:lazy-reap`); close holds with no HELD allocations left; metric `reaped_by: lazy` | scoped to this request's seats, so cost is proportional to the request |
| 439-490 | `claimPool`: validate quantity; find the pool; start bucket = `hash(holdId) % bucket_count`; loop: conditional `UPDATE … WHERE capacity − held − confirmed >= qty`; first success → `INSERT pool_claims`; none → 409 `POOL_EXHAUSTED` | the WHERE clause *is* the availability check, so it is atomic |
| 492-496 | `hashCode` | Java-style string hash |

## `src/engine/confirm.js`

| Lines | Code | Why |
|---|---|---|
| 1-20 | comment | "CONFIRM must be impossible on an expired hold, not unlikely" |
| 44-52 | `SELECT … FROM holds WHERE id=$1 FOR UPDATE` | serialise against release / sweeper / another confirm |
| 54-56 | ownership check when `customerId` is given → 403 | |
| 61-73 | already `CONFIRMED` → return the existing allocations, `alreadyConfirmed: true` | **idempotent**: the saga retry and a webhook can both arrive |
| 75-82 | not ACTIVE → 409 `HOLD_NOT_ACTIVE`; app-side expiry check → `HoldExpiredError` | friendly early error |
| 85-94 | `UPDATE allocations SET state='CONFIRMED', booking_id=$2 WHERE hold_id=$1 AND state='HELD' AND expires_at > now() RETURNING …` | **the atomic confirm**: expiry is part of the predicate |
| 96-102 | pool claims HELD → CONFIRMED | |
| 104-114 | `confirmed + poolClaims !== hold.item_count` → `HoldExpiredError('no longer whole')` | no half-confirmed bookings, and the saga refunds |
| 118-125 | pool buckets: `held −q, confirmed +q` | total occupancy unchanged |
| 127-130 | hold → CONFIRMED (fill `reservation_id` if missing) | |
| 134-163 | ledger `CONFIRMED`, **delta 0** | records the transition; capacity was already taken |
| 165-186 | outbox `inventory.confirmed` | |
| 188-193 | hold-duration metric, `failpoint('confirm.before_commit')` | |
| 211-307 | `release()`: lock the hold; ownership; **already terminal → no-op** (compensation may retry); allocations HELD→RELEASED; pool claims RELEASED, buckets `held −q`; hold RELEASED; ledger `RELEASED +1`; outbox `inventory.released` | "releasing early is always better than waiting for the TTL" |
| 317-409 | `cancelBooking()`: `SELECT … WHERE booking_id=$1 FOR UPDATE`; 404 if none; no CONFIRMED left → `alreadyCancelled` (idempotent); CONFIRMED→CANCELLED; pools `confirmed −q`; ledger `CANCELLED +1`; outbox `inventory.cancelled` | inventory only. Refunding is the payment service's job |
| 411-418 | `mapAllocation` | DB row → API shape |

## `src/engine/ledger.js`

- `append(client, entries)`: builds **one multi-row INSERT** with 15 columns per
  entry (`$1..$15`, `$16..$30`, …) and casts `span` to `int4range`. One round
  trip, because this runs while row locks are held.
- `foldResource(db, resourceId)`: `sum(delta)` vs `1 − count(live allocations)`
  → `{ledgerAvailable, actualAvailable, drift}`.
- `recordCapacity(client, eventId, resourceIds)`: writes `CAPACITY_ADDED +1` for
  new resources. Every path that creates resources must call it in the same tx (the
  seed script does).

## `src/engine/admin.js`, block and unblock

The policy is stated in the header so there is no undefined behaviour:

| Seat state | Block request |
|---|---|
| free | **BLOCKED** |
| HELD (live) | **409 `RESOURCE_HELD`**, naming the hold and its expiry. A customer mid-checkout wins over operator convenience, and holds expire anyway |
| CONFIRMED | **409 `RESOURCE_CONFIRMED`**: "cancel and refund the booking first". Seizing it would invalidate a paid ticket without a refund |
| already BLOCKED | no-op (`alreadyBlocked`) |

- Lines 33-42: lock the resource row (`FOR UPDATE OF r`).
- Lines 50-58: find conflicts. Note `(state <> 'HELD' OR expires_at > now())`: an
  expired hold doesn't count.
- Lines 86-104: `INSERT allocations (… 'BLOCKED', reason)`. A block is just another
  allocation, so **the same exclusion constraint** stops blocking a sold seat and
  selling a blocked seat. If someone reserved between the check and the insert →
  23P01 → 409.
- Then ledger `BLOCKED −1`, `audit_log` row (actor = the operator's email from
  `x-actor`), outbox `inventory.blocked`.
- `unblockResource`: BLOCKED → RELEASED, ledger `UNBLOCKED +1`, audit, outbox.
- `writeAudit()`: insert into the append-only `audit_log`.

## `src/engine/availability.js`, reads (discovery data, never authority)

Every query applies expiry inline: `(a.state <> 'HELD' OR a.expires_at > now())`.

| Function | Query idea | Used by |
|---|---|---|
| `getAvailability(db, eventId, {spanFrom, spanTo})` | CTE `occupied` = distinct resources with a live allocation overlapping `int4range(from,to)`; then per class: total, available, cheapest free base price; plus pool availability | `/v1/events/:id/availability`, pricing |
| `getResources` | every seat with a status for the requested span: RETIRED > BLOCKED > SOLD > HELD > AVAILABLE (via `bool_or`) | seat map, pricing |
| `findAdjacent` | "N seats together": free seats, then **gaps-and-islands** (`col_idx − row_number() OVER (PARTITION BY group,row ORDER BY col)` is constant within a consecutive run), group by run, `HAVING count >= N`, trim to N | `/adjacent` (candidates only; the constraint arbitrates later) |
| `getSegmentAvailability` | `generate_series` builds every `(f,t)` pair with `t > f`; CTE `live` = live allocations once; `CROSS JOIN` resources; count available where no live allocation overlaps `int4range(f,t)` | discovery projection |

The events accept either the UUID or the `external_ref` (`id::text = $1 OR external_ref = $1`).

## `src/workers/expiry.worker.js`

- Comment: **why this is not load-bearing** (lazy reap covers correctness), why
  SKIP LOCKED (no leader, replicas scale), and why the old advisory-lock leader
  design was replaced (an unlock on a different pooled connection leaked the lock).
- `sweep()` (one transaction):
  1. `SELECT … FROM holds WHERE state='ACTIVE' AND expires_at <= now() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 200`
  2. `failpoint('expiry.after_claim_before_commit')`
  3. allocations HELD → EXPIRED (reason `hold_ttl_elapsed`)
  4. pool claims → EXPIRED, buckets `held −q`
  5. holds → EXPIRED
  6. ledger `EXPIRED +1` (actor `system:expiry-worker`)
  7. **one outbox event per train**, not per allocation ("a sweep of 200 holds on
     one train should not emit 200 events")
  8. metrics
- Loop: 5 s if it swept something, 15 s if idle. A crash mid-batch rolls back and
  the locks drop, so another worker takes the same holds.

## `src/index.js`, the HTTP service

| Route | Auth | Does |
|---|---|---|
| `POST /internal/reserve` | `x-internal-token` | requires `eventId`, `customerId`, **an Idempotency-Key**; `withIdempotency(pool, {scope:'inventory.reserve', key, ownerId: customerId, request: body}, client => reserve(...))` → 201, or 200 + `replayed: true` |
| `POST /internal/confirm` | internal | `withTransaction(confirm)` |
| `POST /internal/release` | internal | `withTransaction(release)` |
| `POST /internal/cancel-booking` | internal | `withTransaction(cancelBooking)` |
| `GET /v1/events` | public | active events with live total/available counts, `as_of`, `authoritative: false` |
| `GET /v1/events/:id/span-points` | public | stops |
| `GET /v1/events/:id/availability` | public | `cache-control: max-age=2` |
| `GET /v1/events/:id/resources` | public | seat map |
| `GET /v1/events/:id/segment-availability` | public | for discovery |
| `GET /v1/events/:id/adjacent` | public | count clamped 2..6 |
| `GET /v1/holds/:holdId` | public | hold + allocations JSON |
| `POST /admin/resources/:id/block` / `unblock` | internal | reason required; actor from `x-actor` |
| `GET /admin/invariants` | public read-out | `invariant_summary`, sets metrics; **500 only for CRITICAL/HIGH** (corruption), MEDIUM is a "warning" (lag) |

Startup (`main`): `SELECT 1` → start the expiry worker → start the outbox relay
with the shared `startOutboxRelay` (only if `KAFKA_BROKERS` is set; producer `idempotent: true, maxInFlightRequests:
1`; a Kafka failure is logged but **doesn't stop the service**, and events just
accumulate) → `listen` with workers and resources for graceful shutdown.

The pool uses `LOCK_TIMEOUT_MS` (3 s): "waiting 30 s for a lock is worse for the
user than a fast 409".

## `src/config/index.js`

- The `.env` loader that used to live here moved to `packages/shared/src/config/env.js`,
  because every service required it. It skips comments, strips quotes, and **real
  environment variables always win**.
- `config/index.js`: the shared `str` / `num` / `secret` helpers; PORT 4001; pool max 20;
  lock/statement timeouts; Kafka brokers; expiry batch; `INTERNAL_TOKEN`.
  **Production refuses to boot with `dev-internal-token`.**

---

## Tests (`test/`)

`helpers.js`:
- `testPool()`: generous timeouts (tests *want* contention).
- `seedEvent()`: a fresh isolated event per test (unique `external_ref`, N
  resources, **plus the opening ledger balance**).
- `checkInvariants(pool, {eventId})`: scoped through `invariants_for_event`.
- `expireHold()`: moves `created_at` and `expires_at` into the past together
  (because of `expires_at > created_at`).
- `cleanupEvent()`: deletes allocations, holds and seats, but **leaves the ledger and
  audit rows** (append-only).
- `fireConcurrently(count, fn)`: every task awaits one **gate promise**, so all start
  together. (The lab learned the hard way that staggered starts hide races.)

`integration/reserve.test.js` (10 tests):
1. 100 concurrent → 1 seat: exactly **1** live allocation, 1 success, **99 × 409**,
   no other errors.
2. 1,000 requests for 10 seats → exactly 10.
3. Overlapping segments conflict; disjoint segments on one seat coexist.
4. A multi-resource reservation is all-or-nothing.
5. Opposite-order multi-seat requests don't deadlock.
6. An expired hold can't be confirmed and its seat is reusable.
7. Confirm is idempotent.
8. Released inventory is immediately available.
9. Cancelling a confirmed booking returns the seat.
10. Folding the ledger reproduces the observed state.

Next: [04c · Reservation & saga →](04c-reservation-saga.md)
