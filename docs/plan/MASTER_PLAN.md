# ScaleRail v2 — Master Plan

> 📍 **History:** the roadmap from the ScaleRail era. Parts of it describe plans, not the current code; for what exists now, use the reading path. New here? Start at the [docs home](../README.md).

> Source spec: `update.md` (parent folder). This plan turns it into a buildable, ordered roadmap grounded in what the code does **today**.
> Status: **PLAN ONLY — nothing has been implemented yet.** Reference repos (SeatLock, TicketBlitz, EventCart, TripSaga, hotel-reservation) have **not** been studied yet; claims about them below come only from `update.md`. Research is Phase 0 and will correct this plan where it is wrong.

---

## 0. Thesis

ScaleRail stops being "a ticket booking app with a saga" and becomes **an inventory-correctness laboratory with a railway product on top.**

Three ideas carry the whole project:

1. **PostgreSQL is the only authority.** Every allocation is guarded by a database constraint (an exclusion constraint), so a bug in any layer above it cannot oversell.
2. **Every claim is proven, not asserted.** Each benchmark and chaos run ends with an *invariant verifier* querying authoritative state. A run with a violated invariant cannot publish numbers.
3. **Failure is a first-class input.** Deterministic failpoints, a fault-injecting fake payment provider, and Toxiproxy let us crash exactly where the spec's scenarios say (after commit / before publish / after publish / before mark).

---

## 1. Ground truth: what the code does today

Read directly from source (paths relative to `Smart-rail/irctc-backend/`). Items marked **(verify)** are strong suspicions that Phase 1 tests must confirm or refute before we rely on them.

### 1.1 Keep (real assets)

| Asset | Where |
|---|---|
| Segment-overlap semantics `a.from < b.to AND b.from < a.to` | `inventory-service/.../inventory.service.js` |
| Sorted all-or-nothing Lua lock acquisition | `booking-service/src/utils/distributedLock.js` |
| CAS on booking `version` | `booking.service.js:17-28` |
| Raw-body HMAC webhook verification, gateway abstraction (`base/razorpay/factory`) | `payment-service/src/services/gateways/` |
| Gateway circuit breaker, refresh-cookie auth, DLQ wrapper concept | `api-gateway`, `user-service`, `shared/utils/dlqHandler.js` |
| ES station fuzzy resolution | `search-service` |

### 1.2 Defects found (these are the v2 motivation — real "before" stories for the interview)

| # | Defect | Evidence | Fixed by |
|---|---|---|---|
| D1 | **Dual writes.** DB commit, then Kafka publish with `catch → log "CRITICAL"`. Lost events are possible. | `booking.service.js:310-346`, `payment.service.js:174-181`, `inventory.service.js:453-461` | Outbox (Ph2) |
| D2 | **Idempotency is check-then-act.** Two concurrent identical requests both run; payment calls the PSP *before* recording the key. | `booking.service.js:63-76`, `payment.service.js:10-41` | Claim-first idempotency (Ph2) |
| D3 | **Built-in hot row.** Every lock/confirm/unlock updates the one `schedule_inventories` row and runs `COUNT(*)` over all seats of the schedule → all reservations on a schedule serialize. | `inventory.service.js:194-214, 426-433` | Drop counters from write path; projection (Ph1/6) |
| D4 | **Mixed-mode double-booking hole (verify).** Segment lock path checks only `seat_segment_locks`; full-journey path checks only `seat_inventories.status`. A segment lock on a full-journey-BOOKED seat succeeds, and `recomputeSegmentSeatStatuses` then overwrites `BOOKED` with `LOCKED`. | `inventory.service.js:337-381, 139-188` | Single interval model + exclusion constraint (Ph1) |
| D5 | **`FOR UPDATE NOWAIT` losers → 3 linear retries, no jitter; likely surface as 5xx not 409 (verify).** | `inventory.service.js:321-327`, `retryTransaction.js` | Conditional single-statement allocation (Ph1) |
| D6 | **Booking pre-fetches *all* seats over HTTP per request**, then re-checks — O(seats) stale check-then-act. | `booking.service.js:117-121` | Engine validates atomically (Ph1) |
| D7 | **Redis is on the correctness path.** Lock taken before DB; Redis error → `acquired:false` → misleading "seats being booked by another user"; expiry leader election also dies with Redis. Violates spec §5/§78. | `distributedLock.js:101-110`, `bookingExpiry.js:33-42` | Redis becomes optional accelerator (Ph1/5) |
| D8 | **Expiry is fragile (verify).** Session-level `pg_try_advisory_lock` through a *pooled* client: unlock may hit a different connection, leaking the lock. Single scanner, no batching/SKIP LOCKED. Two independent expiry clocks (booking TTL vs inventory `LOCK_TTL` default 300 s) that can disagree. | `lockExpiry.js:19-30,133`, `bookingExpiry.js:64-70`, `inventory/config` | DB-enforced TTL + SKIP LOCKED sweeper (Ph1) |
| D9 | **Saga is not durable.** Runs inline in the HTTP handler; `saga_logs` is a log, not a state machine; compensation failures are swallowed ("expiry will eventually clean this up"); compensation may refund a payment that was never captured. | `booking.service.js:204-208`, `saga.service.js:147-229` | Durable orchestrator (Ph3) |
| D10 | **Payment transitions aren't atomic.** Read-then-`update({where:{id}})` although a `version` column exists → webhook + client-verify race → duplicate `PAYMENT_SUCCESS`. **A bad signature marks the order `FAILED` permanently**, so a later genuine capture is dropped as `invalid_state` = money taken, no booking. `payment.authorized` is treated as captured. No webhook event-id dedupe/replay window. No `UNKNOWN` state. | `payment.service.js:130,146-169,306-314` | Payment state machine (Ph3) |
| D11 | **Consumer/DLQ.** Retry counter is an in-memory `Map` (lost on restart/rebalance); DLQ record has no stack/attempts; no replay; consumers idempotent only by accident of state checks. | `shared/utils/dlqHandler.js:24` | Ph2 |
| D12 | **Kafka is unstructured.** Topic auto-create (→ 1 partition), ad-hoc names/keys, unversioned JSON, Zookeeper still in use. | `docker-compose.yml`, `kafka-topics.js` | Ph0/2 |
| D13 | **Rate limiter is non-atomic and punishing.** Pipeline then a *separate* `zrange`; `ZADD` before the check so rejected requests still count; fails open; booking limit is 5/min **per IP**, not per user. | `rateLimiting.middleware.js:22-63`, `routes/index.js:169-174` | Token bucket Lua (Ph5) |
| D14 | **Search writes are expensive.** `refresh: true` on every ES write; availability updates rewrite a nested `schedules[]` array in one doc per train (a hot ES doc). Filters limited to station pair + date. | `search.service.js` | Ph6 |
| D15 | **No tests, metrics, tracing, or service Dockerfiles** (compose = infra only). Prisma pool is the unmeasured default (`new PrismaPg({connectionString})`). | repo-wide | Ph0/7 |
| D16 | **Docs drift.** README says "Redis-based seat holds" (Postgres is what actually protects); ARCHITECTURE.md lists seat types `SLEEPER/AC_3_TIER`, code uses `LOWER/MIDDLE/UPPER…`. | `README.md`, `docs/ARCHITECTURE.md` | Ph9 |
| D17 | **RBAC (verify).** Gateway admin routes only `requireAuth`; must confirm role enforcement exists in admin-service. | `routes/index.js:76-122` | Ph9 |

### 1.3 Environment findings (this machine)

- Windows 11, 16 logical cores, Node v22.13.1, Python 3.13, Java 22, Docker CLI 29.5 — **Docker daemon is not running** (Docker Desktop must be started before Phase 0 can proceed).
- **`k6` and `psql` are not installed.** Plan: run k6 via the `grafana/k6` container; run `psql` inside the postgres container.
- Repo `irctc-backend` is a git repo with 2 commits and **uncommitted changes** (`search-service/src/index.js`, `user-service/.../asyncHandler.js`, two untracked guide files). We branch `v2/inventory-platform` after committing or stashing these — **your call, I won't touch git without being asked.**
- All numbers we produce come from one Windows/Docker-Desktop laptop. Benchmarks will say so and will not extrapolate.

---

## 2. Target architecture (evolve, don't discard)

### 2.1 Services

| Service | v2 role | Change |
|---|---|---|
| `api-gateway` | Edge: auth, **token-bucket rate limit, waiting-room admission, load shedding**, idempotency-key passthrough, trace root | extend |
| `user-service` | Auth/RBAC claims, **risk signals** (account creation rate) | small |
| `booking-service` → **`reservation-service`** | Reservation/booking API, **durable saga orchestrator**, API-level idempotency | rewrite core (`git mv`) |
| `inventory-service` = **Inventory Engine** | Authoritative inventory, holds, allocations, ledger, audit, admin block/unblock, outbox, expiry worker | rewrite core |
| `payment-service` | Payment state machine incl. `UNKNOWN`, PSP status resolution, **Fake-PSP gateway**, outbox | extend |
| `search-service` | ES discovery + **availability read model** consumer, richer filters | extend |
| `notification-service` | Idempotent consumer | small |
| `admin-service` | Catalog (trains/coaches/seats/schedules) + outbox; inventory-adjust proxy with RBAC | extend |
| **`pricing-service`** (new) | base × class multiplier × availability tier; optional demand simulator | new, small |
| **`reconciliation-service`** (new) | Invariant/ledger/payment/saga reconciliation, repair, scoreboard API | new |
| **`lab-service`** (new, `lab` compose profile only) | Contention Lab + Chaos Lab runner (HTTP + SSE for UI; CLI shares the same library) | new |
| Workers | Same package/image as their service, started with `node src/worker.js`: expiry, outbox-relay, saga, status-resolver | new entrypoints |

This is 7 original + pricing + reconciliation (+ lab, dev-only). It stays inside the doc's own "I would stop here" guidance: no new broker, cache, or database.

### 2.2 Source of truth for every piece of state (spec §5)

| State | Authority | Acceleration / copies | If the copy is wrong |
|---|---|---|---|
| Allocation of a resource/span | **Inventory DB** `allocations` (+ exclusion constraint) | Redis availability cache, ES counts | Copy is discovery-only; reserve always re-validates in DB |
| Hold TTL | **Inventory DB** `holds.expires_at` (DB clock) | Redis TTL key (cleanup hint only) | DB wins; expired holds are reaped *inside the reserve tx* |
| Reservation & saga state | **Reservation DB** | none | — |
| Payment state | **Payment DB** + PSP (PSP wins on `UNKNOWN`) | webhook events | Resolver queries PSP |
| Ledger / audit | **Inventory DB** (append-only) | — | Reconciliation compares ledger fold vs state |
| Idempotency records | DB of the service that owns the mutation | none | — |
| Rate-limit buckets, waiting-room queue, admission tokens | **Redis** (intentionally non-authoritative) | — | Redis loss = re-queue / reset, never a correctness event |
| Search index / availability summary | ES / Redis L2 / in-process L1 | derived from events | Bounded staleness; exposed as `availability_cache_age` |

**Redis-down policy** (spec §78): reservation keeps working; waiting room & token bucket degrade to a conservative in-process limiter + backpressure; cache misses fall through to DB; nothing is ever "accepted unsafely".

### 2.3 Cross-service transaction rule

Local ACID where resources share a DB (seat + meal + luggage are all inventory-engine rows → one transaction). Saga across services (inventory ↔ payment ↔ reservation). No 2PC. No network calls inside a DB transaction.

---

## 3. Domain & data model (Inventory Engine)

### 3.1 Key design move: one interval-allocation model

Model **every** inventory type as *(resource, span)* allocations, where `span` is an `int4range`:

| Domain | Event | Resource | Span |
|---|---|---|---|
| Railway | Train journey (per date) | Seat | station-sequence range `[from,to)` — replaces `SeatSegmentLock` |
| Hotel | Stay period | Room | night-index range |
| Concert / appointment | Show / slot | Seat / slot | `[0,1)` |
| Quantity stock (meals, luggage) | Event | **Pool** (bucketed counters) | n/a |
| Rental | Window | Unit | time-slot range |

The **final invariant lives in Postgres**:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE allocations ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (resource_id WITH =, span WITH &&)
  WHERE (state IN ('HELD','CONFIRMED','BLOCKED'));
```

This eliminates D4 by construction and makes "confirmed ≤ 1 per seat/span" a schema property. Quantity pools use `CHECK (held + confirmed <= capacity)` plus single-statement conditional `UPDATE ... WHERE capacity - held - confirmed >= $n`.

### 3.2 Tables (inventory DB; plain-SQL migrations — Prisma can't express exclusion constraints, partial indexes, triggers)

`inventory_events`, `resource_groups` (coach), `inventory_resources`, `inventory_pools`, `pool_buckets`, `holds`, `hold_items`, `allocations`, `inventory_ledger` (append-only: `REVOKE UPDATE,DELETE` + trigger), `outbox_events`, `processed_events`, `idempotency_keys`, `audit_log`, `dead_letters`. Reservation DB adds `reservations`, `reservation_items`, `bookings`, `sagas`, `saga_steps`, `idempotency_keys`, `outbox_events`. Payment DB adds `payments`, `refunds`, `provider_events`. Recon DB adds `reconciliation_issues`, `recon_runs`. Waiting-room analytics: `waiting_room_entries` written asynchronously from events (Redis is the live queue).

### 3.3 State machines (enforced in three places: app transition table, DB trigger on `allocations.state`, property tests)

```
allocation:  (none=AVAILABLE) → HELD → CONFIRMED
             HELD → EXPIRED | RELEASED | CANCELLED         (drop out of the exclusion set)
             CONFIRMED → CANCELLED                          (only via explicit cancel/refund workflow)
             (none) → BLOCKED → (unblocked = row RELEASED)  (admin only)
             HELD → HELD  = idempotent no-op (same hold_id); AVAILABLE→CONFIRMED and CONFIRMED→AVAILABLE are rejected

hold:        ACTIVE → CONFIRMED | EXPIRED | RELEASED | CANCELLED
payment:     CREATED → AUTHORIZED → CAPTURED → REFUND_PENDING → REFUNDED
             CREATED → FAILED | CANCELLED ;  any in-flight → UNKNOWN → (resolver) → CAPTURED | FAILED
saga:        CREATED → HOLD_PENDING → HOLD_CREATED → PAYMENT_PENDING → PAYMENT_AUTHORIZED
             → CONFIRM_PENDING → CONFIRMED
             failure: PAYMENT_FAILED | HOLD_FAILED | TIMED_OUT → RELEASE_PENDING → RELEASED → COMPENSATED
             CONFIRM_PENDING failing after capture → REFUND_PENDING → COMPENSATED  (or MANUAL_REVIEW)
```

### 3.4 Hard invariants (checked by one shared SQL library used by tests, benchmarks, reconciliation, and the scoreboard)

- **I1** No two live allocations overlap on a resource (constraint; verifier double-checks).
- **I2** Per pool bucket: `held + confirmed ≤ capacity`; sum(buckets) matches events.
- **I3** No `HELD` allocation past `expires_at` is treated as live by any read or confirm.
- **I4** Ledger fold == current state (for every resource/pool).
- **I5** Every `CONFIRMED` allocation has a booking + captured payment (else a reconciliation issue).
- **I6** Every committed business change has exactly-one outbox row; every `PUBLISHED` outbox row exists on Kafka (sampled).
- **I7** No duplicate booking for the same idempotency key / same resource-span.

### 3.5 Adjustment-vs-hold policy (spec §51, no undefined behavior)

Admin `BLOCK` on an `AVAILABLE` resource → succeeds. On `HELD` → **rejected 409** naming the hold (option `schedule_block_after_release` → designed, stretch). On `CONFIRMED` → **rejected**; only the cancel+refund workflow can free it. `UNBLOCK` requires reason; every adjustment writes ledger `ADJUSTED` + audit + outbox.

---

## 4. Critical flows and transaction boundaries (spec §64/§65)

**Reserve** (inventory engine, one round trip where possible, ~milliseconds):
```
BEGIN                                   -- lock_timeout, statement_timeout set per role
  claim idempotency key (INSERT … ON CONFLICT DO NOTHING RETURNING)
  reap expired HELD rows for the target resources  -- TTL enforced HERE, by DB clock
  sort (resource_id, span) ascending      -- deterministic order → no deadlocks (spec addendum #2)
  INSERT allocations …                    -- exclusion constraint = final arbiter; conflict → SQLSTATE 23P01 → 409
  UPDATE pool_buckets … WHERE cap−held−conf ≥ n   -- quantity items, same tx
  INSERT holds/hold_items, inventory_ledger(ALLOCATED), audit_log, outbox_events, idempotency response
COMMIT
```
No payment, Kafka, HTTP or Redis call inside. Redis (optional) pre-filters hot seats *before* the tx to shed load; skipping it never changes correctness.

**Confirm**: single tx: `UPDATE allocations SET state='CONFIRMED' WHERE hold_id=$1 AND state='HELD' AND expires_at > now()` → row count must equal item count, else `HOLD_EXPIRED` (409) — **never confirms an expired hold**. Ledger `CONFIRMED`, outbox.

**Expire (sweeper)**: `WITH c AS (SELECT id FROM holds WHERE state='ACTIVE' AND expires_at <= now() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $batch) …` — many workers, no leader, no session locks, crash = rollback = retried. Sweeper is a *freshness* optimisation; correctness never depends on it.

**Payment + saga**: see §7. **Cancel/refund**: saga-driven; confirmed → `CANCELLED` releases span, ledger `CANCELLED`, refund via payment state machine with own idempotency key.

---

## 5. Concurrency Lab & strategy comparison (spec §9, §11, §39, §68)

### 5.1 Strategies (same interface: `reserve(ctx, items) → {ok|conflict|error}`)

| ID | Strategy | Notes |
|---|---|---|
| A | Naive `SELECT` → check → `UPDATE` | **Intentionally unsafe**, runs in an isolated `lab` schema *without* the constraint to demonstrate oversell |
| B | Pessimistic `SELECT … FOR UPDATE` (blocking) | queueing on hot row; pool exhaustion risk |
| C | `FOR UPDATE SKIP LOCKED` | natural for "any N seats"; for *explicit* seat it means fail-fast — semantics documented |
| D | Optimistic version CAS (`UPDATE … WHERE version=$v`) | retry storms under contention |
| E | Redis `SET NX` lock + DB unique/exclusion constraint | TicketBlitz-style; Redis is a filter, constraint is the authority |
| F | PostgreSQL-native: exclusion constraint / conditional `UPDATE … RETURNING`, single round-trip (CTE or PL/pgSQL fn) | expected production path |
| G | Bucket-sharded quantity pool (N buckets, spill to others with SKIP LOCKED) | hot-inventory mitigation |
| H | Admission-controlled queue (per-event bounded concurrency) | hot-inventory mitigation |

The "hybrid" in the interview UI is F with E's Redis pre-filter and H's per-event bulkhead. **Rule (spec §40):** we keep Redis only if the data says it helps; otherwise it stays as a documented negative result.

### 5.2 Scenarios (users→resources)
`10→1, 100→1, 1000→1, 10000→1, 1000→10, 10000→100, 1000→1000`, plus multi-resource (2 adjacent seats; seat+meal+luggage, adversarial lock order to *show* deadlocks when sorting is off), plus hot-train (90 % of traffic → 1 event).

### 5.3 Measurements (all from real sampling, stored raw)
successes/failures/conflicts/errors, oversells (from DB, not HTTP counts), tx latency p50/p95/p99/max, throughput, **lock wait** (`pg_stat_activity.wait_event` sampling + `pg_locks`), deadlocks/rollbacks (`pg_stat_database`), pool utilisation/queue time, DB CPU (`docker stats` sampling), retries per request.

### 5.4 Pre-registered hypotheses (written *before* running; results file records "predicted vs observed", incl. the ones we get wrong — this feeds interview Q34/Q35)
- H1: A oversells whenever concurrency > 1 (deterministic interleaving tests + statistical runs).
- H2: B's p99 degrades sharply as users→1 seat because transactions queue on one row and exhaust the pool; F stays flat because the row lock is held for one statement.
- H3: D wastes work under high contention (retry storm) but wins at low contention.
- H4: E adds latency and a failure mode; it only helps if it sheds enough load before the DB. **Might be wrong — we will report it either way.**
- H5: SKIP LOCKED beats blocking locks for "any seat" allocation and loses no correctness.
- H6: Removing `schedule_inventories` counter writes is the single biggest hot-train win.
- H7: Sorted resource ordering eliminates deadlocks that unsorted ordering produces.

### 5.5 Lab UI/CLI
`npm run lab -- run --scenario 1000u-10r --strategy all --seed 42` and a `/lab` page in the React admin UI (SSE live chart, "show me the SQL", `pg_locks` snapshot). Each run outputs `manifest.json` (seed, workload, env, commit, dirty flag), raw samples, `invariants.json`, generated `summary.md`.

**Layer-ablation ("test the tests")**: a Lab mode that disables one defense at a time (app check, row lock, CAS, unique/exclusion constraint) and proves the verifier catches what slips through. This shows *which layer catches what*, the strongest interview artifact.

---

## 6. Reliability plumbing

### 6.1 Idempotency (spec §16/17/61)
Header `Idempotency-Key`; table `(scope, key) PK, request_hash, state IN_PROGRESS|COMPLETED|FAILED, response_status, response_body, created_at, expires_at`.
- **Claim first**: `INSERT … ON CONFLICT DO NOTHING RETURNING`. Winner executes; loser sees `IN_PROGRESS` → `409 + Retry-After`; `COMPLETED` → replay stored response byte-for-byte (success **and** deterministic failures); same key + different body hash → `422 idempotency_key_reuse`.
- For DB-only mutations (reserve) the record is written **in the same tx** as the business write, so "commit succeeded, response lost" always replays the original. Cross-service calls derive downstream keys from `saga_id:step`.
- TTL 24 h + cleanup worker. Applies to reserve, confirm, cancel, payment create/refund, webhook (keyed by PSP event-id).

### 6.2 Transactional outbox (spec §18/19/44)
`outbox_events(event_id, aggregate_id, aggregate_seq, event_type, event_version, payload, status PENDING|PUBLISHED|FAILED|DEAD_LETTER, attempt_count, next_attempt_at, lease_owner, lease_until, created_at)`.
- **Relay**: claim a batch in a *short* tx (`FOR UPDATE SKIP LOCKED` + lease), publish **outside** any tx (KafkaJS `idempotent:true`), then mark `PUBLISHED`. Batching, exponential backoff + jitter, poison → `DEAD_LETTER` after N attempts. Crash after publish/before mark ⇒ duplicate; consumers dedupe. Kafka down ⇒ rows stay `PENDING`, relay catches up.
- **Ordering subtlety we must handle:** multiple relays + SKIP LOCKED can reorder events of one aggregate. Mitigation: claim only the head-of-line unpublished event per `aggregate_id`, and consumers discard stale events via `aggregate_seq` (also covers reorder chaos tests).

### 6.3 Kafka design (spec §20)
KRaft single broker (drop Zookeeper), auto-create **off**, topics created by an init script with explicit partitions.

| Topic | Key | Why |
|---|---|---|
| `reservation.events` | `reservation_id` | per-reservation/saga ordering |
| `inventory.events` | `event_id` (journey/show) | ordered availability projection per journey; `aggregate_seq` guards |
| `payment.events` | `reservation_id` | saga step ordering across payment↔reservation |
| `booking.events`, `notification.events`, `reconciliation.events` | `reservation_id` / `customer_id` | ordering per user-visible thing |
| `*.dlq`, `*.retry-*` | original key | preserves locality |

### 6.4 Consumers, DLQ, schemas
- **Consumer idempotency**: `processed_events(consumer, event_id) PK` inserted **in the same tx** as the business effect (`ON CONFLICT DO NOTHING` → skip). Docs will state plainly: *at-least-once delivery + idempotent consumer = effectively-once business effect*; Kafka gives no application-level exactly-once.
- **DLQ**: persistent record (event id, topic, partition, offset, reason, stack, attempts — counted in DB/headers, not memory, timestamp) + `dead_letters` table + admin **replay** (CLI + API) back to the original topic after a fix. Triggers: malformed, schema-invalid, repeated failure, poison.
- **Schemas**: envelope `{event_id, event_type, event_version, occurred_at, aggregate_id, aggregate_seq, correlation_id, causation_id, trace_id, payload}`; **JSON Schema + Ajv** registry in `packages/shared/events/`, additive-only minor changes, breaking → `v2` with an **upcaster** so v1 consumers keep working (demo: producer v2 / consumer v1). Confluent Schema Registry / Avro / Protobuf: **RESEARCHED + DESIGNED, NOT IMPLEMENTED** (decision recorded in `docs/research/schema-evolution.md`).
- Work-queue choice (spec §38): Kafka for cross-service events; **DB-backed claiming** (SKIP LOCKED/leases) for expiry, outbox, saga, recon — tightly coupled to Postgres state.

---

## 7. Payments, saga, reconciliation, ledger

### 7.1 Durable saga orchestrator (reservation-service)
`sagas(id, reservation_id, state, step, attempts, max_attempts, step_deadline_at, next_run_at, lease_owner, lease_until, version)`; worker claims due sagas (SKIP LOCKED + lease), executes one step, transitions by CAS, emits commands/events through the outbox. Every step has **timeout, retry policy (backoff+jitter), max attempts, compensation, terminal state** and a `saga_id:step` idempotency key. Survives process crashes because all progress is in Postgres.

Reserve is synchronous for the user (API → reservation tx → inventory hold call with timeout, outside any tx); the rest is asynchronous. A crash between `HOLD_PENDING` and reply is resumed by the saga worker re-issuing the *same-keyed* hold.

### 7.2 Payment state machine + UNKNOWN (spec §25–27, addendum #3)
- Payment ops carry their own idempotency key; store `payment_id, idempotency_key, status, provider_reference`. PSP order creation is made crash-safe: record `CREATED(local)` first, call PSP with our key as reference, reconcile on retry.
- **Timeout ⇒ `UNKNOWN`, never "failed", never blind-retry.** The resolver queries the PSP by reference → `CAPTURED` or `FAILED`; only then does the saga proceed or compensate. Refund/void are conservative (no blind money movement).
- Fixes D10: guarded `UPDATE … WHERE status=$expected` transitions; a bad client signature never poisons an order; `authorized ≠ captured`; webhooks verified with HMAC + timestamp window + event-id dedupe (`provider_events`).
- **Fake-PSP gateway** (new gateway implementation behind the existing `base.gateway.js`): signed webhooks, modes `ok | slow | fail | timeout-after-success | duplicate-webhook | out-of-order | 5xx`, and a `GET status` endpoint. Real Razorpay test-mode can't produce these; this is what makes payment chaos reproducible. Razorpay stays as the real gateway.

### 7.3 Reconciliation engine (spec §28/29/67, addendum #4)
Worker runs read-only snapshot queries (`REPEATABLE READ READ ONLY`, per-DB read-only roles — a documented exception to "no shared DBs") and compares Inventory ⇄ Reservations ⇄ Payments ⇄ Bookings ⇄ Ledger. Cross-DB snapshots aren't atomic, so an issue is raised only after a **grace window + re-verification**.

Detects: confirmed booking without captured payment · captured payment without booking · expired hold still allocated · booking without allocation · duplicate booking · orphan payment · stuck saga · **ledger fold ≠ state** (`ledger 97 available vs DB 96`). Writes `reconciliation_issues(severity, entity, expected, actual, detected_at, repair_status, …)`.

Repairs: **automated only when safe** (release an expired hold; re-drive a stuck saga step; enqueue PSP status resolution). Money movement is **never** auto-executed — it produces an issue with a recommended action; an admin triggers `POST /reconciliation/:id/retry`, which is audited.

### 7.4 Ledger
Append-only entries `ALLOCATED, RELEASED, CONFIRMED, CANCELLED, EXPIRED, ADJUSTED` with `delta`, state before/after, actor, request/trace id. Written in the same tx as the change. A **fold function** reconstructs state from the ledger; property tests assert `fold(ledger) == state`, and the reconciler runs it continuously.

---

## 8. Traffic shaping, fairness, hot inventory

| Mechanism | Protects | Implementation |
|---|---|---|
| **Token bucket** (per user / per IP / per endpoint class: search, reserve, confirm, waiting-room) | abusive request *frequency* | one atomic Redis Lua script; deny doesn't consume; returns `Retry-After`; in-process fallback when Redis is down |
| **Waiting room** | macro admission during spikes (≠ rate limiting) | Redis: `INCR` sequence + ZSET for FIFO; **admission is one Lua script** computing `min(max_active − active, token-bucket-allowance)` and moving users to `admitted` atomically — any of 5 gateway instances may call it, so no double/lost admission; reconnect via session token; expiry of stale entries; signed **admission token** (verified statelessly at the gateway, so Redis loss doesn't break admitted users). Priority lanes (NORMAL/PREMIUM) = **stretch**, weighted fair share, premium derived from a server-side claim, never client input |
| **Capacity control / backpressure** | the DB | per-instance bulkhead (bounded concurrent DB-bound reserves + bounded queue) → `503 + Retry-After` past the limit; pool sized so `instances × max ≤ max_connections − reserve`; `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`; event-loop-lag gauge; bench with vs without |
| **Fairness** | one client monopolising stock | max concurrent holds/user, hold TTL, per-user bucket, idempotency, tracked gauges |
| **Anti-bot signals + risk score** | scalping | rules on request rate, repeated failed reservations, concurrent sessions, account-creation rate, seat churn (hold→release loops) → score → throttle/require waiting-room re-entry. Documented as *basic signals, not fraud detection* |
| **Hot inventory** | single popular train/event | detect (per-event rate EWMA + conflict ratio + lock-wait) → mitigate in order: drop write-path counters (D3) → SKIP LOCKED claim for auto-allocation → bucket-sharded pools → per-event admission bulkhead. Measured against baseline |

---

## 9. Read side: search, cache, availability

- **Availability read model** built from `inventory.events` (per-`event_id` ordering + `aggregate_seq` to drop stale/out-of-order updates), stored in Redis L2 and an in-process L1 (TTL + event-driven invalidation), with **stampede protection** (single-flight + jittered TTL). Exposes `availability_cache_age` and `cache_hit_rate`.
- Only metadata/schedules/stations/availability *summaries*/config are cached. **Seat ownership is never cached as truth**; reserve re-validates in the DB.
- **Search (ES)**: keep fuzzy stations; add departure/arrival windows, operator, seat class, availability, price range; stop `refresh:true` per write (use refresh interval); split availability out of the per-train doc (separate `availability` index keyed by `event_id`) to remove the hot-doc pattern. Results carry `as_of` timestamp: *discovery, not authority.*
- **UI**: seat map shows a "may be stale (as of …)" indicator; on reserve it surfaces the authoritative 409 gracefully and refreshes.
- Read replicas: **DESIGNED, NOT IMPLEMENTED** (policy recorded: search/read → replica/cache; allocation → primary only).

---

## 10. Observability & SLOs

- **Metrics** (`prom-client`, `/metrics` on every service) — the spec §46 list, plus `hold_duration`, `lock_wait_duration`, `db_pool_{active,idle,waiting}`, `event_loop_lag`, `load_shed_total`, `invariant_violations{type}`.
- **Tracing**: OpenTelemetry Node SDK (http, express, pg, ioredis, kafkajs) → OTel Collector → Jaeger; trace context propagated through Kafka headers and stored on outbox rows; every reservation carries `trace_id, reservation_id, saga_id, idempotency_key`.
- **Logs**: structured JSON with the same ids.
- **Dashboards (Grafana, provisioned JSON in repo)**: the 13 sections of spec §85 + the **Correctness Scoreboard** (oversells, duplicate bookings, orphaned holds, ledger mismatches, unprocessed outbox, DLQ, duplicate events, recon issues — all driven by the shared invariant SQL).
- **SLOs (hypothetical, no production claims)**: reserve p99, search p95, reserve success/error ratio, event processing lag, reconciliation freshness — measured and reported as *observed*, alongside the target.

---

## 11. Testing, benchmarks, chaos

### 11.1 Test pyramid
- **Unit** (`node:test`): state machines, allocation, adjacency, idempotency, pricing, compensation.
- **Property** (`fast-check`): random resources/attempts/retries/faults ⇒ never oversell, never confirm expired hold, retries idempotent, released ⇒ available, confirmed never double-allocated, `fold(ledger)==state`, transition matrix.
- **Integration** (Testcontainers: Postgres, Redis, Kafka): DB constraints, outbox relay, consumers, DLQ.
- **Concurrency**: 100 threads/1 seat ⇒ 1 success + 99 conflicts; 1000 req/10 seats ⇒ exactly 10; **assert against DB rows, never only HTTP counts**.
- **E2E**: search → reserve → pay (Fake PSP) → confirm → booking.

### 11.2 Failpoints (deterministic chaos — beyond the spec)
`await failpoint('outbox.after_publish_before_mark')` etc. Armed via env or an internal admin call (`FAILPOINTS_ENABLED=true`, never in prod profile): actions `crash | throw | delay | drop`, with count/probability. This lets tests crash *exactly* at: expiry-before-commit, after-commit-before-response, outbox row committed/before publish, published/before mark — instead of hoping `docker kill` lands at the right moment. Coarse faults (stop Kafka/Redis/PG, kill a service/worker, network delay/timeouts, PG connection exhaustion) use Docker + **Toxiproxy**. Duplicate/reordered events use an event-injector.

### 11.3 Chaos matrix
For each scenario in spec §43/§44: **expected · actual · recovery · invariant verified**, recorded automatically to `docs/FAILURES.md` from run artifacts (never hand-typed).

### 11.4 Benchmarks BENCH-001…010
Reproducible harness: seeded data generator (users/events/seats/routes/trains/schedules), k6 (via container) scenarios for the 10 spec cases, plus in-process DB-level runs for the strategy comparison. Artifact layout:

```
bench/results/BENCH-00X/<timestamp>-<commit>/
  manifest.json   # seed, workload, env (CPU/RAM/OS/Docker/PG settings), commit, dirty flag
  raw/            # k6 ndjson, pg_stat snapshots, docker stats, kafka lag samples
  invariants.json # verifier output — a failed invariant marks the run INVALID
  summary.md      # generated
```
`bench compare <runA> <runB>` flags p99↑, throughput↓, DB connections↑, Kafka lag↑ against thresholds. **`BENCHMARKS.md` is generated from artifacts**; until a run exists it says `NOT YET RUN`. Scaling runs: reservation-service ×1/3/5 behind an LB, consumers ×1/3/5 (throughput, lag, rebalance time). Flash-sale simulator parameters: users, inventory, arrival rate, burst duration, API instances, DB connections; local-only with hard caps so it can't be pointed at cloud infra by accident.
Optional stretch: **history checker** (Jepsen-lite) — record every client op with timestamps and check offline that no two overlapping successful allocations ever coexisted.

---

## 12. Security (spec §48/§84)

Keep JWT + HTTP-only refresh (device-bound rotation). Add: RBAC enforced at gateway **and** service (`ADMIN`, `OPS`, `CUSTOMER`), request validation (Ajv/zod schemas on every mutation), audit log (who/what/when/resource/old→new/request_id/trace_id/service/reason), webhook HMAC + timestamp window + event-id replay protection, secrets via env/Docker secrets (no defaults committed; `.env.example` only), PII minimisation (no PII in events/logs — notification service resolves email itself), internal-secret → **signed short-lived service tokens**. `SECURITY.md` threat model: double booking, payment replay, idempotency abuse (key squatting/cross-user reuse → scope keys by user), JWT theft, webhook forgery, rate-limit bypass (X-Forwarded-For trust), waiting-room manipulation (token forgery/queue jumping), privilege escalation, inventory manipulation, event injection — each with mitigation **and the test that proves it**.

---

## 13. Deployment

- **Docker Compose** (real): Dockerfiles for every service, `packages/shared` as an npm workspace package (fixes the fragile `../../../../shared` relative imports), healthchecks + `depends_on: service_healthy`, profiles `core | obs | lab`, PgBouncer (evaluate; transaction pooling vs session features documented), Redis AOF on, KRaft Kafka.
- **Kubernetes** (production-*shaped*): kustomize base + overlays; Deployments, Services, probes (liveness/readiness), resource requests/limits, PodDisruptionBudgets, HPA manifest, graceful SIGTERM shutdown (drain relay/saga leases). Validated with `kubectl --dry-run` and a smoke run on kind **only if it actually works here**; otherwise labelled *manifests only, not exercised*. No production-readiness claim.

---

## 14. Additions beyond `update.md` (what I'm adding and why)

| # | Addition | Why it earns its place |
|---|---|---|
| 1 | Exclusion-constraint interval model | One mechanism covers rail segments, hotel dates, seats; removes D4; DB-native final invariant |
| 2 | Lazy in-tx expiry | Makes "TTL enforced by the authoritative system" literally true; sweeper is optional freshness |
| 3 | Failpoints framework | Deterministic crash tests for the exact 4 outbox/worker scenarios |
| 4 | Fake-PSP with fault modes | Only way to reproduce timeout-after-success/duplicate/out-of-order webhooks |
| 5 | Proof-carrying benchmarks | No published number without a passing invariant check + manifest |
| 6 | Layer-ablation lab mode | Demonstrates which defense layer catches which bug |
| 7 | Pre-registered hypotheses | Honest "what helped / what failed" (interview Q34/Q35) |
| 8 | Outbox head-of-line + `aggregate_seq` | Solves a real reorder bug class multi-relay designs have |
| 9 | Ledger fold verifier | Turns the ledger into an executable correctness proof |
| 10 | History checker (stretch) | Independent, black-box correctness check on load-test traffic |
| 11 | Toxiproxy | Network faults without touching app code |

Explicitly **not** adding: another broker, cache, DB, GraphQL, gRPC, service mesh, real ML fraud detection.

---

## 15. Feature status ledger (spec §89 — no faking)

| Status target | Features |
|---|---|
| **IMPLEMENT + TEST + BENCH** | interval model + state machine, holds/TTL/expiry, strategies A–H & Lab, idempotency, outbox/relay, consumer dedupe, DLQ+replay, durable saga, payment SM + UNKNOWN + Fake-PSP, reconciliation + ledger, token bucket, waiting room, backpressure, hot-inventory mitigations, L1/L2 cache + invalidation, ES search expansion, audit log, admin block/unblock, metrics, tracing, dashboards, k6 suite, chaos lab, compose deployment, docs |
| **IMPLEMENT (lighter)** | adjacency/best-available allocation (+ contention benchmark), multi-resource holds, pricing-service (base × class × availability tier), risk score rules, event versioning v1→v2 demo, K8s manifests |
| **STRETCH** | priority lanes, demand-pricing simulator, history checker, scheduled block-after-release |
| **RESEARCHED + DESIGNED, NOT IMPLEMENTED (planned)** | Confluent Schema Registry/Avro/Protobuf, read replicas, real multi-node K8s scaling proof, HPA behaviour under load |

---

## 16. Phased roadmap (each phase ends with a hard gate; nothing moves on until the gate is green)

Order follows the spec's priority: **correctness → consistency → failure recovery → observability → performance → scale → advanced.** Sizes: S/M/L/XL are relative effort, not calendar promises.

| Ph | Name | Size | Scope | Exit gate |
|---|---|---|---|---|
| **0** | Foundation & research | M | Start Docker; boot & baseline the *current* system (record its behavior under 1000u/1seat = the "before" numbers); branch; npm workspaces + `packages/shared`; SQL migration runner; Dockerfiles; compose (KRaft, init topics, healthchecks, PG extensions); `prom-client` + Prometheus/Grafana skeleton; test harness; **`docs/research/*.md` for the 10 spec topics** (reference repos fetched, then redesigned independently) | current system reproducibly boots; baseline run stored; research docs exist; hypotheses file committed |
| **1** | Inventory Engine core | XL | v2 schema + exclusion constraint; state machine (+ trigger); reserve/confirm/release/expire; ledger + audit; block/unblock policy; invariant verifier (`sr-verify`); strategies A–H; Contention Lab CLI + `lab` schema; deterministic + property + concurrency tests | 1000u/10 seats = exactly 10 (B–H); A demonstrably oversells; fold(ledger)==state; 100-thread/1-seat test green; hypotheses H1–H7 have recorded results |
| **2** | Idempotency, outbox, Kafka contracts | L | Claim-first idempotency lib; outbox tables + relay in inventory/reservation/payment/admin; event envelope + JSON-Schema registry (v1); `processed_events`; persistent DLQ + replay; topic/key design; failpoints lib | four outbox chaos scenarios pass via failpoints; duplicate + reordered event tests pass; Kafka-down → catch-up test passes |
| **3** | Reservation service, durable saga, payments | XL | Rename→`reservation-service`; API `/reservations…`; saga worker with timeouts/retries/compensation; payment SM + `UNKNOWN` resolver; Fake-PSP; webhook hardening | payment-fail → released; paid-but-confirm-fails → correct compensation, no duplicate charge/refund; saga survives kill -9 at every step (failpoints); E2E green |
| **4** | Reconciliation & scoreboard | L | Recon service, issues table, safe auto-repair, admin retry, ledger verification, scoreboard API | injected corruptions in each of the 8 classes are detected; safe ones repaired; money ones never auto-executed |
| **5** | Traffic shaping & fairness | L | Token bucket Lua; waiting room + admission tokens (+ 5-instance correctness test); bulkhead/backpressure; per-user hold caps; risk score; hot-inventory detection & mitigations | 5 gateways admit exactly `max_active`; no double admit; Redis-down degraded-mode test; hot-train benchmark shows measured mitigation effect (or a documented negative result) |
| **6** | Read side & search | M | Availability projection, L1/L2, invalidation, staleness metrics, ES v2 mapping/filters, stale-aware UI | staleness measured; cache stampede test; search filters tested; reserve unaffected by stale cache (test with poisoned cache) |
| **7** | Observability complete | M | OTel tracing end-to-end incl. Kafka; all metrics; Grafana dashboards (13 sections + Scoreboard); audit log views | one reservation traceable client→…→confirmation with the 4 ids; dashboards populated from a real run |
| **8** | Load, chaos, scale, regression | XL | k6 scenarios; flash-sale sim; chaos lab (Docker+Toxiproxy+failpoints); 1/3/5 instance runs; consumer scaling; BENCH-001…010; regression compare | all benches have artifacts + passing invariants; `BENCHMARKS.md` + `FAILURES.md` generated; regression tool flags a seeded regression |
| **9** | Security, K8s, docs, UI polish | L | Threat model + tests; RBAC; service tokens; K8s manifests; frontend Lab/Chaos/Scoreboard/Recon/Waiting-room pages; README rewrite; the 14 docs in spec §87; **`PROJECT_INTERVIEW.md`** (37 Qs answered from *measured* evidence) | docs cross-checked against code and results; every "implemented" claim links to a test or bench artifact |

**Vertical-slice rule:** Phase 1 delivers a runnable slice early (Lab CLI against the real engine), so the signature demo exists before the rest of the platform is finished. Frontend pages are built alongside their backend phase, not deferred to the end.

---

## 17. Repo layout (target)

```
irctc-backend/
  packages/shared/        # events, envelope+schemas, idempotency, outbox, consumer-dedupe, failpoints, metrics, tracing, sql invariants
  api-gateway/  user-service/  search-service/  notification-service/  admin-service/
  reservation-service/    # was booking-service
  inventory-service/      # Inventory Engine (sql/migrations, strategies/, workers/)
  payment-service/  pricing-service/  reconciliation-service/
  lab/                    # strategies runner, scenarios, chaos controller, CLI  (lab-service = its HTTP face)
  bench/                  # k6 scripts, seed generator, results/, compare tool
  deploy/{compose,k8s,grafana,prometheus,otel,toxiproxy}
  docs/{plan,research,adr,…the 14 spec docs}
  frontend/
```
Conventions: plain-SQL migrations for core services (Prisma stays only in user/admin), `pg` Pool with explicit timeouts on hot paths, CommonJS to match the repo, `node:test`, ADRs for every decision that has a rejected alternative.

---

## 18. Decisions I made by default (tell me if you disagree)

1. **Keep Node/CommonJS**, no TypeScript rewrite (churn without correctness payoff).
2. **Two DBs for reservation vs inventory** (honest saga boundary) rather than merging them. Multi-resource all-or-nothing happens *inside* the inventory DB.
3. **Drop Prisma from reservation/inventory/payment** (needs exclusion constraints/triggers/raw SQL and lower per-request overhead); keep it in user/admin.
4. **Clean-slate v2 schemas, no data backfill** (no production data exists).
5. **Rename `booking-service` → `reservation-service`.**
6. **Zookeeper → KRaft**, topic auto-create off.
7. **Fake-PSP + Razorpay** (fake for chaos/bench, Razorpay for demo).
8. **Reconciliation reads via read-only DB roles**, with a grace window.
9. **k6 through its container**; `psql` through the postgres container.

## 19. Open questions / risks

- **Docker Desktop must be running** for anything beyond code writing. That's the first thing to do.
- **Uncommitted changes in the repo** — commit/stash before we branch? (I'll ask again at Phase 0 start.)
- **Scope is very large** (90-section spec). The ordering above guarantees a coherent, defensible project at *every* phase boundary; if time runs short, cut from the tail (Ph 9 polish, Ph 6 extras, stretch items) — never from Ph 1–4.
- **Single-machine benchmarks** cannot prove "production scale"; docs will say exactly that.
- **Adjacency/best-available under exclusion constraints** needs care (multi-row conflicts → retry with next candidate); will prototype in Ph1 and may downgrade to "lighter".
- Some defects (D4, D5, D8, D17) are unverified; Phase 0's baseline run and Phase 1's tests will confirm or refute them, and this table will be updated with the result.
