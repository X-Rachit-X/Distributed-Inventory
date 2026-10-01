# 04c · File by file — `services/reservation` (booking API + saga)

> 📍 **Reference page:** look things up here, no need to read it top to bottom. Reading path: [01](01-level1-big-picture.md) → [02](02-level2-how-it-works.md) → [code](../README.md#step-3-read-the-code-in-the-order-a-booking-flows) → [03](03-level3-deep-dive.md) → [05](05-failure-scenarios.md) → [06](06-resume-and-interview.md) · [Docs home](../README.md) · [File map](04-file-map.md)

```
reservation/
├── sql/migrations/010_reservation_core.sql   reservations, items, bookings, sagas (+trigger), saga_steps
├── src/index.js                 public API: create (202), get, list, cancel + starts saga worker & relay
├── src/saga/orchestrator.js     ⭐ the durable saga
├── src/clients/index.js         HTTP clients (+ in-process clients for tests)
├── src/workers/saga.worker.js   polling loop
├── src/config/index.js          timeouts, fairness limits, URLs
└── test/integration/saga.test.js  12 tests
```

---

## `sql/migrations/010_reservation_core.sql`

Header: **"the saga is a table, not a call stack."** The old version ran the saga
inside the HTTP handler and only *logged* what happened. If the pod died after
payment, nothing finished the job.

| Lines | Object | Explanation |
|---|---|---|
| 23-48 | `reservations` | the customer's **intent**: `customer_id`, `event_ref` / `event_id`, `state` (`PENDING/HELD/AWAITING_PAYMENT/CONFIRMED/FAILED/CANCELLED/EXPIRED`), `hold_id`, `booking_id`, `payment_id`, `total_cents`, `currency`, `item_count`, `hold_expires_at`, `failure_reason`, `idempotency_key`, ids. Partial index on non-terminal states |
| 50-65 | `reservation_items` | seat (`resource_code/id`, `span_from/to`) or pool item (`pool_code`, `quantity`), **server-quoted `price_cents`**, passenger name and age |
| 72-86 | `bookings` | the **outcome**. `reservation_id` UNIQUE (one booking per reservation), human `reference` UNIQUE (`TSR-…`), `state`, `payment_id`. Kept separate from reservations so "how many attempts failed?" stays answerable |
| 91-134 | `sagas` | `state` CHECK with 18 states; `attempts`, `max_attempts` (8), `last_error`; **`next_run_at`** (when to run next), **`step_deadline_at`** (when the current step counts as stuck); **`lease_owner/lease_until`**; `context jsonb` (everything the saga needs) |
| 138-143 | partial indexes `sagas_due_idx`, `sagas_stuck_idx` | only non-terminal sagas, so the indexes stay small |
| 147-163 | `saga_steps` + append-only trigger | the history: from → to, attempt, outcome (`OK/RETRY/FAILED/TIMEOUT/SKIPPED`), detail, duration |
| 172-217 | `saga_transition_guard()` | a `CASE` per state lists the allowed next states (see the diagram in Level 2). Note `PAYMENT_UNKNOWN` → only AUTHORIZED / FAILED / MANUAL_REVIEW; `CONFIRM_PENDING` → CONFIRMED / REFUND_PENDING / MANUAL_REVIEW ("never silently drop"). Sets `completed_at` on CONFIRMED / COMPENSATED / RELEASED |
| 225-232 | view `stuck_sagas` | past deadline and not terminal |
| 236-239 | view `sagas_needing_attention` | PAYMENT_UNKNOWN / MANUAL_REVIEW / REFUND_PENDING, i.e. money in question |

---

## `src/index.js`, the public API

| Lines | What | Why |
|---|---|---|
| 1-18 | comment | POST returns **immediately** (202). Holding a request open across a payment ties a connection to the slowest system in the flow |
| 20-21 | `require(env)`, `require(tracing)` | tracing must load first |
| 43-47 | pool | |
| 49-63 | `HttpInventoryClient` (5 s timeout), `HttpPaymentClient` (**30 s**: payments may be slow, and a timeout means UNKNOWN) | |
| 65-86 | `createApp` with readiness deps: postgres (critical), inventory `/health` (critical) | |
| 96-101 | `requireCustomer`: trusts `x-customer-id` | safe only because the gateway sets it after verifying the JWT, and the internal network isn't public |
| 117-265 | **`POST /v1/reservations`** ↓ | |
| 121-134 | validate: Idempotency-Key header **required**, eventId or eventRef, 1 ≤ items ≤ `MAX_ITEMS_PER_RESERVATION` (6) | |
| 138-149 | **fairness**: sum `item_count` of the customer's PENDING/HELD/AWAITING_PAYMENT reservations; > `MAX_CONCURRENT_HOLDS` (12) → 409 `TOO_MANY_ACTIVE_HOLDS` | a script can't park the whole train in holds |
| 152-154 | `quote = await priceItems(eventId, items)` **before** the transaction; `fareFor(item)` looks the item up by `id-or-code:from:to` | Rule 2 + Rule 3 |
| 156-259 | `withIdempotency(pool, {scope:'reservation.create', key, ownerId: customerId, request: body}, client => …)` | |
| 165-182 | `INSERT reservations (…, 'PENDING', item_count, total_cents=quote.totalCents, idempotency_key, correlation, trace)` | |
| 184-205 | `INSERT reservation_items` for each item, with `price_cents = fareFor(item).fareCents` | any client `priceCents` is ignored |
| 210-235 | `SagaOrchestrator.create(client, {reservationId, context: {eventId, customerId, resources: [{resourceId, resourceCode, spanFrom, spanTo, priceCents}], pools, ttlSeconds, totalCents, paymentMode}})` | the saga carries **everything** it needs, so a worker after a restart depends on nothing in memory |
| 237-257 | response 202: `reservationId`, `state: PENDING`, **`pollUrl`**, `pollAfterMs: 500`, quote summary | tells the client how to follow progress |
| 263 | replayed → 200, else 202 | |
| 277-319 | `priceItems`: seat items only → `POST pricing /v1/quote` with a 5 s `AbortController`; network error or timeout → **503** ("selling at an unknown price is worse than 'try again'": fail closed); 404 / 400 passed through; build `byKey` with both id and code keys | |
| 322-371 | `GET /v1/reservations/:id`: joins reservation + booking + saga + items (`json_agg`); **another customer's id → 404** (doesn't reveal it exists); returns `progress: describeProgress(sagaState)` and `settled` | |
| 373-388 | `GET /v1/reservations`: the customer's latest 50 | |
| 391-453 | `POST /v1/reservations/:id/cancel` ↓ | |
| 403-405 | already CANCELLED/FAILED/EXPIRED → return `alreadySettled` | idempotent |
| 407-437 | CONFIRMED → inventory `cancelBooking` (key `cancel:<id>`) → reservation CANCELLED → refund (key `refund:<id>`). A refund failure is **logged, not thrown**: inventory is already released, and reconciliation will flag the money | |
| 441-451 | in flight → `UPDATE sagas SET state='RELEASE_PENDING', next_run_at=now(), lease cleared WHERE state IN (CREATED, HOLD_PENDING, HOLD_CREATED, PAYMENT_PENDING)` → 202 `CANCELLING` | the saga's normal compensation path does the release |
| 456-476 | `describeProgress`: saga state → human text ("Securing your seats", "Confirming payment with your bank"…) | the UI doesn't need to know saga internals |
| 482-528 | create the orchestrator + worker + outbox relay; `main()` starts them; `listen` with workers/resources for graceful shutdown | |

> ⚠️ Detail worth knowing: the cancel shortcut for an in-flight saga moves the
> state with a plain UPDATE, and the DB trigger still validates the arrow. Of the
> four states in its `IN (…)` list, only `HOLD_CREATED → RELEASE_PENDING` is an
> allowed transition. For a saga in `CREATED`, `HOLD_PENDING` or `PAYMENT_PENDING`
> the trigger raises (SQLSTATE 23514), which surfaces as a 500. The guard *does* its
> job: cancelling mid-payment would be unsafe anyway. But the API answer is
> unfriendly. See the honest notes in
> [06](06-resume-and-interview.md#4-honest-notes-from-reading-the-code).

---

## `src/saga/orchestrator.js` ⭐

### Top of file

| Lines | What |
|---|---|
| 1-33 | comment: forward path, failure paths, **why one step per claim** (crash window = one step; a slow provider parks one saga, not a worker), **why no 2PC** |
| 47-59 | `STEP_POLICY`: HOLD_PENDING 10 s / 3 attempts → HOLD_FAILED; **PAYMENT_PENDING 45 s / 1 attempt ("never re-charge automatically") → PAYMENT_UNKNOWN, `indeterminateOnTimeout`**; PAYMENT_UNKNOWN 300 s / 10 → MANUAL_REVIEW; CONFIRM_PENDING 15 s / 5 → REFUND_PENDING; RELEASE_PENDING / REFUND_PENDING → MANUAL_REVIEW |
| 69-75 | constructor; `workerId = saga-<pid>-<random>` |
| 78-86 | `static create(client, …)`: `INSERT sagas (state 'CREATED', next_run_at now())`, called **inside** the reservation transaction |

### Claiming and dispatch

| Lines | What | Why |
|---|---|---|
| 95-107 | `tick({batchSize=20})`: claim, then for each `#step`, on error `#recordFailure` | |
| 116-123 | `releaseLeases()`: clear leases owned by this worker | rolling deploys don't stall sagas for 60 s |
| 125-147 | `#claim`: CTE `due` = non-terminal, `next_run_at <= now()`, lease free or expired, `ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT n` → `UPDATE … SET lease_owner, lease_until = now()+60s, attempts+1 RETURNING …` | many workers, disjoint work, crash-safe |
| 150-194 | `#step`: deadline passed → `#onTimeout`; otherwise a `switch` on state → handler. Unknown state → MANUAL_REVIEW | |
| 181-187 | `HOLD_FAILED` → `#settleAndCompensate` | the comment says this was found by the e2e run: the saga ended but the reservation stayed PENDING forever |

### Forward steps

| Lines | Handler | What happens |
|---|---|---|
| 198-253 | `#beginHold` | (1) CAS `CREATED→HOLD_PENDING` with a deadline and **`keepLease: true`**; if another worker moved it → return. (2) `inventory.reserve({idempotencyKey: 'saga:<id>:hold', …context})`. (3) `failpoint('saga.after_hold_before_commit')`. (4) one tx: reservation → `HELD` (hold_id, expiry, total) + saga → `HOLD_CREATED` with `context.holdId/totalCents`. On **409** → store `failure_reason` and `#fail('HOLD_FAILED')`. Other errors rethrow → `#recordFailure` (retry with jitter) |
| 255-259 | `#awaitHold` | reached when a worker picks up a saga left in HOLD_PENDING: re-run `#beginHold`. **The idempotency key makes the repeat safe** (inventory replays the original hold). Note that `#step` checks the deadline first: if the 10 s step deadline has already passed (e.g. after a hard crash that left a 60 s lease), the saga takes the timeout path instead. See [05 §3](05-failure-scenarios.md#3-process-crashes-at-exact-points-failpoints) |
| 261-324 | `#beginPayment` | CAS → `PAYMENT_PENDING` (keepLease, 45 s deadline). `payments.charge({idempotencyKey: 'saga:<id>:payment', amount: ctx.totalCents, mode})`. **Any thrown error → `PAYMENT_UNKNOWN`** (run again in 250 ms: "a customer whose money may have moved should not wait"). `state UNKNOWN` → PAYMENT_UNKNOWN with `paymentId` saved. `FAILED` → reservation FAILED + `PAYMENT_FAILED`. Otherwise one tx: reservation `AWAITING_PAYMENT` + payment_id, saga → `PAYMENT_AUTHORIZED` |
| 326-331 | `#awaitPayment` | re-issue the charge; payment's own idempotency returns the existing payment instead of charging again |
| 336-370 | `#resolvePayment` | **the only exit from UNKNOWN.** No `paymentId` → the charge never landed → `PAYMENT_FAILED`. Else `payments.resolveUnknown(id)`: not resolved → after 10 attempts `MANUAL_REVIEW` ("money may be held"), else reschedule `min(300 s, 250 ms·2^attempts)`. Resolved FAILED → `PAYMENT_FAILED`. Resolved paid → `PAYMENT_AUTHORIZED` |
| 372-457 | `#beginConfirm` | CAS → `CONFIRM_PENDING` (keepLease). `inventory.confirm({holdId, bookingId = reservation id})`. On `HOLD_EXPIRED` or 409 → log an error ("the customer has PAID and the seat is gone") → `REFUND_PENDING` + metric. Then `failpoint('saga.after_confirm_before_commit')` and one tx: `INSERT bookings (reference 'TSR-'+first 8 of id upper) ON CONFLICT (reservation_id) DO NOTHING`; reservation → CONFIRMED with booking_id; read seat codes; `nextSeq` + **`enqueue('booking.events', 'booking.confirmed', version 2, {…, currency: 'INR', seat_codes})`**; saga → `CONFIRMED` |

### Compensation

| Lines | Handler | What happens |
|---|---|---|
| 465-508 | `#releaseHold` | `inventory.release` (key `saga:<id>:release`). An error is only logged, because release is idempotent and the TTL reclaims the hold anyway. Then one tx: reservation → CANCELLED (unless already final), saga → `RELEASED` **and** → `COMPENSATED`. The comment explains the bug: the claim query treats RELEASED as terminal, so a saga left there was stranded one step short |
| 510-538 | `#refund` | no paymentId → MANUAL_REVIEW. `payments.refund({key 'saga:<id>:refund'})`. Outcome `UNKNOWN` → **MANUAL_REVIEW** ("retrying a payout blindly risks paying twice"). Else reservation CANCELLED (reason 'refunded') + saga `COMPENSATED` |

### Timeouts, failures, the CAS primitive

| Lines | What |
|---|---|
| 542-559 | `#onTimeout`: go to `STEP_POLICY[state].onTimeout` (default MANUAL_REVIEW), log `indeterminate` for payment ("a timeout means *we do not know*, never *it failed*") |
| 561-563 | `#fail(state, reason)` |
| 572-583 | `#settleAndCompensate`: reservation → FAILED and saga → COMPENSATED in one tx |
| 585-605 | `#recordFailure`: attempts ≥ policy max → `onTimeout` target. Else full-jitter `random(0, min(60 s, 500 ms·2^attempts))` |
| 607-620 | `#reschedule`: set `next_run_at`, `last_error`, **clear the lease**; append a RETRY row to `saga_steps` |
| 622-626 | `#transition` = `#transitionIn` inside its own transaction |
| 650-700 | **`#transitionIn`** ↓ |

```sql
UPDATE sagas
   SET state = $2,
       next_run_at = now() + ($3 || ' milliseconds')::interval,
       step_deadline_at = <now()+deadline | NULL>,
       attempts = CASE WHEN state <> $2 THEN 0 ELSE attempts END   -- new state → reset attempts
       [, lease_owner = NULL, lease_until = NULL]                  -- unless keepLease
       [, context = $5]
 WHERE id = $1 AND state = $4                                       -- ← COMPARE-AND-SWAP
```
- `rowCount === 0` → log "another worker moved it first" → return `false`.
- Otherwise append to `saga_steps`, count the metric, and **update the in-memory
  snapshot** `saga.state = toState`, so a second transition in the same step uses
  the right `from`.

The comment (628-649) records the two lessons from running two replicas: CAS
instead of a blind UPDATE, and keeping the lease across the slow call.

---

## `src/clients/index.js`

| Part | What | Why |
|---|---|---|
| `toError(status, body)` | turn the upstream JSON error into a `TesseraError` with the same status/code (keeps `HOLD_EXPIRED`) | the saga can branch on `err.status === 409` |
| `HttpInventoryClient.#call` | `fetch` POST with `AbortController` timeout, `x-internal-token`, `idempotency-key` header. Timeout → `ServiceUnavailableError` | `reserve`, `confirm`, `release`, `cancelBooking` |
| `HttpPaymentClient.#call` | same, but **5xx → `err.indeterminate = true`**, and timeout → `ServiceUnavailableError` with `indeterminate` + code `PROVIDER_TIMEOUT` | "a timeout here is not a failure" |
| `InProcessInventoryClient` | calls the real engine functions in `pool.withTransaction` | tests run the **real SQL and constraints**, only without HTTP. "It is NOT a mock" |
| `InProcessPaymentClient` | calls a real `PaymentService` with the fake provider | |

## `src/workers/saga.worker.js`

A loop: `orchestrator.tick({batchSize: 20})`, then sleep 250 ms if work was done,
else 1 s. `stop()` sets `running=false`, clears the timer and **releases leases**.

## `src/config/index.js`

Port 4002; pool 20; URLs; `INVENTORY_TIMEOUT_MS` 5000 ("a slow answer means
contention; fail fast"); `PAYMENT_TIMEOUT_MS` 30000 ("payments may be slow, a
timeout is UNKNOWN"); saga interval 250 ms; TTL 600 s; **max 6 items per
reservation, 12 concurrent held items per customer**. Production refuses the dev
internal token.

---

## `test/integration/saga.test.js` (12 tests)

Uses three real pools (inventory/reservation/payment DBs), the **real** engine,
`PaymentService` + `FakeProvider`, and the in-process clients.

| Test | Proves |
|---|---|
| reserve → pay → confirm issues a booking | happy path |
| a declined payment gives the seat back | compensation |
| a released seat can be sold to someone else | compensation really frees inventory |
| a provider timeout becomes UNKNOWN, not FAILED | rule 4 |
| resolution asks the provider and confirms | resolver path |
| a charge that never reached the provider resolves to failure | `found: false` → FAILED |
| a saga abandoned mid-flight is completed by another worker | durability + lease expiry |
| two workers racing the same saga don't double-process it | SKIP LOCKED + CAS + keepLease |
| a hold that expired after payment triggers a refund | "never a silent loss" |
| a replayed webhook is applied once | provider_events dedupe |
| a forged signature is rejected and changes nothing | signature_failures |
| an expired timestamp is rejected even with a valid signature | replay window |

Next: [04d · Payment →](04d-payment.md)
