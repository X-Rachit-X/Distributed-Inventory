# 02 · Level 2 🟡 — How it works (a little deeper)

> Goal: follow one booking through every service, table and message. You still
> don't need to read code, but you will learn the *names* of things so the code
> becomes familiar later.

---

## 1. The repository map

```
Distributed-Inventory/
├── packages/shared/          ← the toolbox every service imports
│   ├── sql/                  ← tables every DB gets (outbox, idempotency, dedupe, DLQ, audit)
│   └── src/                  ← pool, migrations, errors, idempotency, outbox, consumer,
│                               events, failpoints, http shell, admission, pricing, metrics/logs
├── services/
│   ├── gateway/              :4000  front door
│   ├── inventory-engine/     :4001  THE authority on seats
│   ├── reservation/          :4002  booking API + saga
│   ├── payment/              :4003  money, with UNKNOWN state
│   ├── reconciliation/       :4004  auditor
│   ├── notification/         :4005  emails (Kafka consumer)
│   ├── discovery/            :4006  search (Kafka consumer + ES/PG)
│   └── pricing/              :4007  fares
├── lab/                      ← Contention Lab: 9+ locking strategies raced against each other
├── bench/                    ← seed data, 31 end-to-end checks, k6 load script, raw results
├── apps/console/             ← React UI (search, seat map, live booking progress, ops)
├── deploy/                   ← docker-compose, prometheus, grafana, kubernetes
├── scripts/                  ← start/stop all services, chaos scenarios
└── docs/                     ← you are here
```

Every service has the same shape:

```
services/<name>/
├── sql/migrations/NNN_*.sql   its own database schema
├── src/index.js               HTTP routes + starts background workers
├── src/config/                env variables, validated at boot
├── src/<logic folders>/       engine/, saga/, service/, workers/, checks/…
└── test/                      integration tests against a real Postgres
```

## 2. The databases (one per service)

All six live in **one** Postgres container locally, but they are **separate
databases**. No query ever joins across them. The one exception is
reconciliation, which has **read-only** access to the others because its job is
to compare them.

Every database also gets the **shared correctness tables**:

| Shared table | Job |
|---|---|
| `outbox_events` | events waiting to be published to Kafka |
| `aggregate_sequences` | per-aggregate counters (1, 2, 3…) for event ordering |
| `idempotency_keys` | "have I already handled this request?" plus the saved response |
| `processed_events` | "have I already consumed this event?" (consumer dedupe) |
| `projection_offsets` | highest event sequence applied per aggregate (drops stale events) |
| `consumer_attempts` | retry counters that survive restarts |
| `dead_letters` | poison messages parked for a human |
| `audit_log` | who did what (append-only) |

Each service's own tables:

| DB | Main tables | What they mean |
|---|---|---|
| **inventory** | `inventory_events` (a train run on a date) · `span_points` (stops) · `resource_groups` (coaches) · `inventory_resources` (seats) · `holds` · **`allocations`** · `inventory_pools` / `pool_buckets` / `pool_claims` (meals) · `inventory_ledger` | the truth about seats |
| **reservation** | `reservations` · `reservation_items` · `bookings` · **`sagas`** · `saga_steps` | customer intent and booking progress |
| **payment** | `payments` · `refunds` · `provider_events` · `signature_failures` | money |
| **discovery** | `trips` · `trip_stops` · `trip_segments` · `dirty_events` | a search-friendly copy |
| **notification** | `notifications` | the inbox |
| **reconciliation** | `recon_runs` · `reconciliation_issues` · `repair_log` · `scoreboard_snapshots` | audit results |

> 💡 Note the vocabulary: **"event"** in `inventory_events` means *a bookable
> occurrence* (one train journey on one date). It is **not** a Kafka message.
> Kafka messages are called "events" too, so read the context carefully.

## 3. Key nouns in the inventory model

```
inventory_event  = "12301 Howrah Rajdhani, 21 Sep"     span_max = 8 stops
  ├── span_points  = 0:NDLS, 1:CNB, 2:ALD, … 7:HWH
  ├── resource_groups = coach B1 (3A), coach S1 (SL) …
  │     └── inventory_resources = seat B1-23, B1-24, …   (each has a base price)
  ├── holds        = "customer X temporarily has these items until 10:10"
  │     └── allocations = (seat B1-23, span [1,5), state HELD, hold_id …)  ← THE table
  └── inventory_pools = "VEG_MEAL capacity 200", split into buckets
```

**Allocation states:** `HELD` → `CONFIRMED` → `CANCELLED`, or `HELD` → `EXPIRED` /
`RELEASED`. Operators can create `BLOCKED` (damaged seat). Only `HELD`, `CONFIRMED`
and `BLOCKED` occupy the seat.

## 4. One booking, step by step (with names)

### Step 0: browsing (reads, never authoritative)

```
Browser ─GET /api/search?from=NDLS&to=HWH─► gateway ─► discovery
                                                      L1 cache → L2 Redis → Elasticsearch → (fallback) Postgres
                     ◄── results + backend + cache + as_of + authoritative:false
Browser ─GET /api/events/:id/resources?spanFrom=0&spanTo=7─► gateway ─► inventory (read, no locks)
```

Reads are allowed to be slightly stale. The reserve step re-checks everything, so
a stale read costs a retry, never an oversell.

### Step 1: the gateway

`POST /api/reservations` with header `Idempotency-Key: web-…`:

1. **Load shed?** If event-loop lag > 500 ms, reply 503.
2. **Rate limit**: the `reserve` bucket allows a burst of 5, refilling 0.2/s (about
   12/min). Otherwise 429.
3. **Authenticate**: verify the JWT and read `customerId` and `role`.
4. **Waiting room** (only if enabled): require a valid admission token.
5. **Proxy** to reservation with `x-customer-id`, `x-internal-token`,
   `x-correlation-id` and the idempotency key.

### Step 2: the reservation service (returns fast)

`POST /v1/reservations`:

1. **Fairness**: does this customer already hold too many items? (max 12) → 409.
2. **Price on the server**: call `pricing /v1/quote` **before** opening any DB
   transaction (rule: no network inside a transaction).
3. **One transaction, under idempotency**:
   - claim the idempotency key
   - `INSERT reservations` (state `PENDING`)
   - `INSERT reservation_items` (with the server-quoted price)
   - `INSERT sagas` (state `CREATED`, with a `context` JSON holding everything the
     saga will need)
   - save the response on the idempotency key
4. Reply **202 Accepted** with `pollUrl`.

### Step 3: the saga worker drives the booking

A loop inside the reservation service claims due sagas (`FOR UPDATE SKIP LOCKED`
plus a 60-second lease) and runs **one step per claim**:

```
CREATED ─► HOLD_PENDING ──(inventory /internal/reserve)──► HOLD_CREATED
        ─► PAYMENT_PENDING ──(payment /internal/charge)──► PAYMENT_AUTHORIZED
        ─► CONFIRM_PENDING ──(inventory /internal/confirm)──► CONFIRMED  ✅
```

Each external call carries a deterministic idempotency key such as
`saga:<sagaId>:hold`. If the worker crashes and the step re-runs, the downstream
service recognises it as the same request.

### Step 4: inventory reserves (the critical transaction)

Inside **one** Postgres transaction:

```
1  check the event is ACTIVE
2  resolve seat codes → ids, validate spans
3  sort items (deadlock prevention)
4  SELECT … FOR UPDATE on the seat rows (orderly queue)
5  expire stale holds on exactly these seats (lazy expiry)
6  INSERT holds (expires_at = now() + TTL, by the DATABASE clock)
7  INSERT allocations (state HELD)   ← exclusion constraint decides; loser → 23P01 → 409
8  claim meal-pool quantities (CHECK constraint decides)
9  INSERT ledger entries (ALLOCATED, delta −1)
10 INSERT outbox event 'inventory.held'
COMMIT
```

### Step 5: payment

1. `INSERT payments` (state `CREATED`) is **committed before** calling the provider,
   so a crash still leaves a record.
2. Call the provider:
   - success → `CAPTURED`, and the saga moves to `PAYMENT_AUTHORIZED`
   - decline → `FAILED`, and the saga releases the seat
   - **timeout / 5xx → `UNKNOWN`**: the saga waits in `PAYMENT_UNKNOWN` and asks the
     provider (`/resolve`) with backoff until it gets a definite answer
3. Webhooks from the provider are HMAC-verified, deduplicated by event id, and
   guarded against arriving out of order.

### Step 6: confirm

Inventory runs **one guarded UPDATE**:

```sql
UPDATE allocations SET state='CONFIRMED', booking_id=$2
 WHERE hold_id=$1 AND state='HELD' AND expires_at > now()
```

If the hold expired a microsecond ago, zero rows change, and the saga goes to
`REFUND_PENDING` and refunds. Otherwise the reservation service inserts the
`bookings` row (reference `TSR-XXXXXXXX`) and an outbox event `booking.confirmed`
(v2), all in one transaction.

### Step 7: events fan out

```
inventory DB outbox ─relay─► Kafka inventory.events ─► discovery (mark train dirty → refresh search)
reservation DB outbox ─relay─► Kafka booking.events  ─► notification (send email once)
payment DB outbox ─relay─► Kafka payment.events      (published; no consumer subscribes yet)
```

### Step 8: polling and the auditor

- The browser polls `GET /api/reservations/:id` and sees a human-readable `progress`
  ("Processing payment", "Booked").
- Every 30 s, reconciliation runs 8 checks across the databases and keeps a
  scoreboard where every counter should be 0.

## 5. The full saga state machine

```
                    ┌──────────► HOLD_FAILED ─────────────────────► COMPENSATED
                    │ (seat taken)
CREATED ─► HOLD_PENDING ─► HOLD_CREATED ─► PAYMENT_PENDING ─┬─► PAYMENT_AUTHORIZED ─► CONFIRM_PENDING ─► CONFIRMED
                                                            │          ▲                     │
                                                            │          │ resolved: paid      │ hold expired after pay
                                                            ├─► PAYMENT_UNKNOWN ─────────────┤
                                                            │      │ resolved: not paid      ▼
                                                            │      ▼                   REFUND_PENDING ─► COMPENSATED
                                                            └─► PAYMENT_FAILED ─► RELEASE_PENDING ─► RELEASED ─► COMPENSATED

Anything unclear involving money ─► MANUAL_REVIEW (a human decides)
Any step past its deadline ─► its "onTimeout" target (e.g. PAYMENT_PENDING times out → PAYMENT_UNKNOWN)
```

A **database trigger** (`saga_transition_guard`) allows only these arrows.

## 6. Kafka topics and event types

| Topic | Event types | Producer | Consumer |
|---|---|---|---|
| `inventory.events` | `inventory.held/confirmed/released/cancelled/expired/blocked/unblocked` | inventory-engine | discovery |
| `booking.events` | `booking.confirmed` (v1, v2), `booking.cancelled` | reservation | notification |
| `payment.events` | `payment.captured/failed` | payment | (none yet) |
| `*.dlq` | dead-lettered copies | consumers | operators |

Every message has the same **envelope**: `event_id, event_type, event_version,
aggregate_id, aggregate_seq, occurred_at, correlation_id, causation_id, trace_id,
payload`.

## 7. Background workers (things that run without a request)

| Worker | Service | Every | Does |
|---|---|---|---|
| Outbox relay | inventory, reservation, payment | 250 ms busy / 1 s idle | publish pending outbox rows to Kafka |
| Expiry sweeper | inventory | 5 s busy / 15 s idle | expire holds past their TTL (freshness) |
| Saga worker | reservation | 250 ms / 1 s | drive sagas one step at a time |
| Payment resolver | payment | 2 s | ask the provider about UNKNOWN payments |
| Projection refresher | discovery | 1 s (+ full resync every 60 s) | rebuild search rows for dirty trains |
| Kafka consumers | discovery, notification | continuous | react to events, deduplicated |
| Reconciliation | reconciliation | 30 s | 8 cross-service checks, safe repairs |
| Admission loop | gateway | 1 s | admit people from the waiting room |

All of them can run as **many copies at once** safely (thanks to SKIP LOCKED, leases
and CAS), and all of them **stop gracefully** and release their leases on shutdown.

## 8. What protects what (layer table)

| Layer | Protects against | If it breaks… |
|---|---|---|
| Exclusion constraint | double-selling | **this is the floor; it can't "break" without a migration** |
| Sorted row lock | deadlocks, slow contention | slower, still correct |
| Lazy expiry | expired holds blocking seats | sweeper and reconciliation still clean up |
| Idempotency keys | double bookings and charges on retry | duplicates are possible, so it is essential |
| Outbox | lost events | events could be lost, so it is essential for events |
| Consumer dedupe | double emails and double effects | duplicates |
| Saga in a table | half-finished bookings on crash | stuck bookings |
| UNKNOWN state + resolver | double charge / charged-without-ticket | money errors |
| Reconciliation | anything the above missed | issues go unnoticed longer |
| Rate limit / waiting room / load shed | overload, greedy clients | slower, DB under more pressure |
| Caches | slow search | slower search |

## 9. How to run it and watch it

```bash
npm install && cp .env.example .env
npm run up          # Postgres, Redis, Kafka (+topics), Elasticsearch in Docker
npm run migrate     # every DB: shared SQL + its own migrations
npm run seed        # trains, stops, coaches, seats, meal pool, ledger opening balance
npm run start       # 8 services in the background, logs in .logs/
npm run console     # http://localhost:5173  (log in as ops@tessera.dev for the operator view)

npm test            # 40 integration tests
npm run e2e         # 31 live checks
npm run lab -- run --scenario 1000u-1r --strategy all
npm run chaos -- kafka|redis|payment
```

Things to try in the console:

1. Book a seat and watch the **Reservation** page move through the saga steps.
2. As `ops@`, set the provider mode to `timeout_after_success`, book again, and
   watch "Confirming payment with your bank", then resolution.
3. Open **Correctness**: every invariant should be 0.

Next: [03 · Deep dive into every pattern →](03-level3-deep-dive.md)
