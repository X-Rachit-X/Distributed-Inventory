# 04a · File by file — `packages/shared` (the toolbox)

Every service imports from here, so learn this package first. Once you know these
~20 files, every service reads like "business logic + calls into the toolbox".

How to read this page: each file has **Purpose → Walkthrough (line ranges) →
Key takeaways**. Line numbers refer to the current repo.

---

## `sql/000_correctness_primitives.sql`, the tables every database gets

**Purpose.** Creates the bookkeeping tables that turn "we use Kafka and retries"
into actual guarantees. They sit **in the same database** as each service's
business tables, so a business write and its bookkeeping can commit in **one
transaction**. That co-location is the entire trick.

| Block | What it creates | Why |
|---|---|---|
| `CREATE EXTENSION pgcrypto` | `gen_random_uuid()` | UUID primary keys |
| `outbox_events` | `event_id` (unique UUID), `topic`, `event_type`, `event_version`, `aggregate_id` (Kafka key → partition → ordering), `aggregate_seq`, `payload jsonb`, correlation/causation/trace ids, `status` (`PENDING/PUBLISHED/FAILED/DEAD_LETTER`), `attempt_count`, `next_attempt_at`, `last_error`, `lease_owner/lease_until`, timestamps | the outbox: events committed with their change |
| `outbox_pending_idx` *(partial, `WHERE status='PENDING'`)* | index on `(next_attempt_at, id)` | the relay's query stays fast even with millions of published rows |
| `outbox_aggregate_pending_idx` | `(aggregate_id, id) WHERE PENDING` | supports the "oldest pending per aggregate" ordering check |
| `aggregate_sequences` | `(aggregate_id PK, seq)` | per-aggregate counter. **Not** one global sequence, which would be a hot row every write touches |
| `idempotency_keys` | PK `(scope, key)`, `owner_id`, `request_hash`, `state` (`IN_PROGRESS/COMPLETED/FAILED`), `response_status`, `response_body`, `expires_at` (24 h) | claim-first idempotency with response replay |
| `processed_events` | PK `(consumer, event_id)` | consumer dedupe marker, inserted in the same tx as the effect |
| `projection_offsets` | PK `(consumer, aggregate_id)`, `last_seq` | discard events older than one already applied |
| `consumer_attempts` | PK `(consumer, event_id)`, `attempts` | retry counts that survive restarts (an in-memory Map would reset) |
| `dead_letters` | full payload, source topic/partition/offset, reason, error, stack, attempts, status `OPEN/REPLAYED/DISCARDED`, unique `(consumer, event_id)` | poison messages, with enough context to replay |
| `audit_log` | actor, role, action, entity, old/new state, reason, request/trace ids | who did what |

## `sql/001_append_only.sql`

- Defines `tessera_append_only()`, a trigger function that always does
  `RAISE EXCEPTION '% is append-only; % is not permitted'` with SQLSTATE `0A000`
  and a hint to "record a compensating entry instead".
- Attaches it `BEFORE UPDATE OR DELETE ON audit_log`. Services reuse the function
  for `inventory_ledger`, `saga_steps`, `repair_log`.
- `DROP TRIGGER IF EXISTS` first, because inventory's own migration had already
  created the same trigger before this shared file existed (idempotent migration).

---

## `src/db/pool.js`, Postgres connections with guardrails

| Lines | Code | Explanation |
|---|---|---|
| 26-36 | `DEFAULTS = { max: 10, connectionTimeoutMillis: 5000, statementTimeoutMs: 10000, lockTimeoutMs: 3000, idleInTransactionTimeoutMs: 10000 … }` | **Bounded pool.** An unbounded pool turns one slow query into a total outage. `connectionTimeoutMillis` means "if no connection is free in 5 s, fail fast" |
| 44-47 | `createPool(opts)` merges defaults and requires a `connectionString` | fail at boot, not at 3 a.m. |
| 49-70 | `new Pool({ …, application_name: 'tessera-<name>', options: '-c statement_timeout=… -c lock_timeout=… -c idle_in_transaction_session_timeout=…' })` | The three timeouts are passed as **startup options**, so the server applies them before the connection is handed out. 💡 Bug story in the comment: an earlier un-awaited `SET` in a `connect` listener raced the first query |
| 72-76 | `pool.on('error', …)` | an idle client dying (DB restart) must not crash the Node process |
| 78 | `poolMetrics.register(name, pool)` | exposes total/idle/**waiting** connections to Prometheus. *Waiting* is the saturation signal |
| 90-116 | `pool.withTransaction(fn, txOpts)` | `connect` → `BEGIN [ISOLATION …] [READ ONLY]` → optional `SET LOCAL lock_timeout` → `fn(client)` → `COMMIT`. On error → `ROLLBACK` (ignore errors if the connection is already broken) and rethrow. **`finally { client.release() }`** always returns the connection |
| 118-123 | `pool.stats()` | handy snapshot |

⚠️ The doc comment on `withTransaction` repeats Rule 2: **never do network I/O
inside `fn`**. A slow downstream service would hold the connection and row locks
for as long as it is slow.

## `src/db/migrate.js`, the migration runner

| Lines | What | Why |
|---|---|---|
| 23 | `MIGRATION_ADVISORY_LOCK = 4_244_121` | a fixed number every runner locks on |
| 27-37 | `readMigrations(dir)`: list `*.sql`, sort, read, `sha256` checksum | checksum detects edited history |
| 47-59 | merge files from several dirs and **sort by filename** across all of them; throw on duplicate names | shared `000_/001_` run before the service's `010_…` because of the numeric prefix |
| 66 | `SELECT pg_advisory_lock($1)` | if 3 replicas boot together, only one migrates at a time |
| 68-75 | `CREATE TABLE IF NOT EXISTS schema_migrations (name, checksum, applied_at, duration_ms)` | the record of what ran |
| 80-97 | already applied? Same checksum → skip. **Different checksum → hard error** "Add a new migration instead of editing an applied one" | history is immutable |
| 99-113 | each new file: `BEGIN` → run SQL → insert record → `COMMIT`. On failure `ROLLBACK` and throw | a half-applied migration can't exist |
| 117-120 | `finally`: `pg_advisory_unlock` + release | always unlock |

## `src/db/migrate-cli.js`

`npm run migrate [service]`: for each of the 6 services (in dependency order),
build a 1-connection pool from `<SERVICE>_DATABASE_URL` (with localhost defaults)
and call `migrate(pool, [SHARED_SQL, serviceDir])`. Prints "N applied, M already
current". Exit code 1 if any service failed.

---

## `src/errors/index.js`, the error taxonomy

**Purpose.** Separate **expected conflicts** (409) from **faults** (5xx). Load tests
and dashboards count them separately.

| Lines | Class | Status / code | When |
|---|---|---|---|
| 14-28 | `TesseraError` | base: `status`, `code`, `details`, `retryable`; `toJSON()` → `{error:{code,message,details}}` | all API errors share one shape |
| 30-56 | `BadRequestError` 400 · `UnauthorizedError` 401 · `ForbiddenError` 403 · `NotFoundError` 404 | | |
| 58-63 | `ConflictError` 409 | "someone else took it" | the normal outcome under contention |
| 65-70 | `HoldExpiredError` (409, `HOLD_EXPIRED`) | a subtype, so the saga can tell "expired" from other conflicts |
| 72-78 | `InProgressError` 409, retryable | same idempotency key is still running |
| 80-84 | `IdempotencyKeyReuseError` 422 | same key, different body |
| 86-92 | `TooManyRequestsError` 429 + `retryAfterSeconds` | rate limit / waiting room |
| 98-103 | `LoadSheddingError` 503 | system capacity, not one client |
| 105-110 | `ServiceUnavailableError` 503 | dependency down |
| 112-117 | `StaleStateError` 409 | CAS lost |
| 121-130 | `PG` map of SQLSTATEs: `23505` unique, **`23P01` exclusion**, `23514` check, `40001` serialization, **`40P01` deadlock**, `55P03` lock not available, `57014` cancelled | |
| 133 | `isOversellPrevented(err)` → `err.code === '23P01'` | "the constraint saved us" |
| 136-140 | `isRetryablePgError` → serialization / deadlock / lock-not-available | transient: the transaction didn't commit, so it is safe to retry |

---

## `src/idempotency/index.js`, claim-first idempotency ⭐

| Lines | What | Why |
|---|---|---|
| 40-41 | `hashRequest(body)` = sha256 of `JSON.stringify(body)` | detect "same key, different request" |
| 58-67 | `claim()`: `INSERT … (state 'IN_PROGRESS', expires now()+24h) ON CONFLICT (scope,key) DO NOTHING RETURNING …` | **one atomic statement** is both the check and the claim, so there is no race window |
| 69 | rows returned → `CLAIMED` | you are the first, so do the work |
| 73-84 | else `SELECT` the existing row. If it vanished (expired and cleaned up between the statements) → `InProgressError` ("retry") | rare edge case, handled |
| 88-91 | different `owner_id` → 422 | never leak another user's response |
| 92-94 | different hash → 422 | |
| 95-97 | still `IN_PROGRESS` → 409 retryable | the original is still running |
| 99 | `REPLAY` with the stored record | |
| 103-110 | `complete()`: store state, `response_status`, `response_body`, `completed_at` | |
| 118-123 | `abandon()`: `DELETE … WHERE state='IN_PROGRESS'` | free the key after an **unknown** outcome |
| 139-185 | `withIdempotency(pool, args, fn)` | the wrapper services actually use ↓ |
| 143 | claim **outside** the business transaction (on the pool) | so competitors see the claim immediately instead of after the slow work commits |
| 145-153 | REPLAY → return `{replayed: true, status, body, failed}` | |
| 156-166 | `withTransaction(client => { result = fn(client); complete(client, …) })` | business rows + idempotency record **commit together**, closing the "committed but not recorded" gap |
| 167-183 | error: business rejection (`TesseraError`, status < 500, not retryable) → `complete(... 'FAILED')` so retries replay the rejection; otherwise → `abandon` | deterministic vs unknown outcomes |
| 188-197 | `cleanup()` deletes expired keys in batches of 1000 using `ctid` | safe to run concurrently |

---

## `src/events/envelope.js`

- `createEnvelope({type, version=1, aggregateId, aggregateSeq, payload, correlationId, causationId, traceId})`
  (lines 33-59) requires `type` and `aggregateId`, generates a `crypto.randomUUID()`
  `event_id` and `occurred_at`.
- Each field has a reason (comment lines 1-24): `event_id` = dedupe key;
  `aggregate_id` = partition key (ordering); `aggregate_seq` = staleness guard;
  `event_version` = schema evolution; `correlation_id` = the business thread;
  `causation_id` = which event caused this one; `trace_id` = link to distributed
  traces.
- `toHeaders()` (62-72) copies the metadata into Kafka headers (`event-id`,
  `event-type`, `traceparent`, …) so consumers can filter without parsing the body.

## `src/events/registry.js`

| Lines | What |
|---|---|
| ~26-31 | one Ajv instance (`allErrors`, not strict) + `ajv-formats`; Maps `schemas` (`type.vN`) and `upcasters` (`type.vN->vN+1`) |
| 36-39 | `registerSchema` compiles the JSON Schema once |
| 42-44 | `registerUpcaster(type, from, fn)` |
| 46-53 | `EventValidationError` (code `EVENT_SCHEMA_INVALID`) |
| 60-66 | `validate(envelope)`: unknown type → **pass** (a consumer shouldn't break on types it doesn't handle); invalid payload → throw |
| 74-92 | `upcast(envelope, target)`: apply v1→v2→… step by step. **A missing step throws**, because a wrongly shaped payload is worse than an error |

The header comment explains why there is **no Confluent Schema Registry**: it would
add a stateful service for a benefit this scale doesn't need. Validating at both
producer and consumer catches the same class of bug at runtime.

## `src/events/schemas.js`, the contracts

- Helper shapes: `uuid`, `nullableUuid`, `cents` (integer ≥ 0), `timestamp`,
  `allocationItem`.
- `inventory.held` (requires hold_id, event_id, customer_id, expires_at, items),
  `inventory.confirmed`; `inventory.released/cancelled/expired` share a
  `releaseLike` shape; `inventory.blocked`, `inventory.unblocked`.
- `payment.captured`, `payment.failed`.
- `booking.confirmed` **v1** and **v2** (v2 adds required `currency` 3 letters +
  optional `seat_codes`). Upcaster v1→v2: `{...payload, currency: 'INR', seat_codes:
  payload.seat_codes ?? []}`. The comment: "v1 implied INR, which was true until it
  wasn't".
- `booking.cancelled`.
- `TOPICS` map: topic → event types (documentation).
- `additionalProperties` is left **open** on purpose, so additive fields don't break
  old consumers.

---

## `src/outbox/writer.js`

| Lines | What | Why |
|---|---|---|
| 24-27 | `require('../events/schemas')` | registers every schema, so `validate` never silently no-ops |
| 45-56 | build the envelope | |
| 61 | `validate(envelope)` **before** inserting | a bad event becomes a failed request, not a committed poison message |
| 63-80 | `INSERT INTO outbox_events (…) VALUES (…, 'PENDING', now())` **using the caller's client** | the event commits or rolls back with the business change |
| 93-101 | `nextSeq`: `INSERT INTO aggregate_sequences … ON CONFLICT DO UPDATE SET seq = seq + 1 RETURNING seq` | atomic per-aggregate increment; also row-locks that aggregate's counter until commit, which keeps seq order equal to commit order per aggregate |

## `src/outbox/relay.js` ⭐

| Lines | What | Why |
|---|---|---|
| 33-41 | defaults: batch 100, poll 250 ms (busy) / 1 s (idle), maxAttempts 10, lease 30 s, backoff 100 ms → 60 s | |
| 52-61 | `workerId = <service>-<pid>-<random>` | identifies who holds a lease |
| 63-68 | `start()` begins `#loop` | |
| 70-83 | `stop()`: clear leases this worker holds | another replica can continue **immediately** instead of waiting 30 s |
| 85-99 | `#loop`: `tick()`, then sleep 250 ms if work was done, else 1 s. `unref()` so the timer doesn't keep the process alive | adaptive polling |
| 102-119 | `tick()`: claim batch → for each `#publishOne`, on error `#recordFailure` | |
| 129-159 | `#claim()`: CTE with **`NOT EXISTS older pending for same aggregate`** + `FOR UPDATE SKIP LOCKED LIMIT n`, then `UPDATE … SET lease_owner, lease_until=now()+30s, attempt_count+1` | parallel across aggregates, strictly ordered within one |
| 161-173 | rebuild the envelope from the row | |
| 177 | `failpoint('outbox.before_publish')` | chaos: committed but not sent → stays PENDING |
| 179-188 | `producer.send({ topic, messages:[{ key: aggregate_id, value: JSON, headers }] })` | key → partition → per-aggregate order in Kafka |
| 193 | `failpoint('outbox.after_publish_before_mark')` | chaos: sent but not marked → **duplicate**, which consumers absorb |
| 195-200 | `UPDATE … SET status='PUBLISHED', published_at=now(), lease cleared` | **mark after publish**, giving at-least-once |
| 202-207 | metrics: publish latency (commit → publish), published count | |
| 211-251 | `#recordFailure`: attempts ≥ 10 → `DEAD_LETTER` + error log + DLQ metric. Else `next_attempt_at = now() + random(0, min(60s, 100ms·2^attempts))`, store `last_error`, clear the lease | full jitter avoids synchronised retries after a broker outage |
| 253-258 | `#reportPending` → `outbox_pending` gauge | |

---

## `src/consumer/index.js` ⭐

| Lines | What | Why |
|---|---|---|
| 1-26 | the comment: Kafka's "exactly-once" doesn't cover a Postgres write. at-least-once + idempotent consumer = effectively-once | the honest claim |
| 42-110 | `createIdempotentHandler({pool, consumerName})` returns `handleOnce(envelope, handler, opts)` | |
| 44 | everything in `withTransaction` | effect + marker atomic |
| 48-60 | `INSERT processed_events … ON CONFLICT DO NOTHING RETURNING` | atomic check + claim (a SELECT-then-INSERT would race) |
| 62-72 | no row → `duplicateEvents` metric → `'DUPLICATE'` | |
| 76-98 | if `opts.projection`: `INSERT projection_offsets … ON CONFLICT DO UPDATE SET last_seq = EXCLUDED.last_seq WHERE projection_offsets.last_seq < EXCLUDED.last_seq RETURNING` → no row means the event is not newer → `'STALE'` | out-of-order guard in one statement |
| 100 | `await handler(client, envelope)` | the business effect, **same client** |
| 105 | `failpoint('consumer.after_handle_before_commit')` | |
| 125-229 | `withDLQ({…, maxAttempts=5, readerVersion})` returns a KafkaJS `eachMessage` | |
| 133-150 | `JSON.parse` fails → `deadLetter(MALFORMED_JSON)` and return (don't block the partition) | |
| 152-181 | `validate`, then **per-event-type** reader version: `readerVersion[event_type]`. If older, `upcast` + re-validate. Failure → `SCHEMA_INVALID` dead letter | the comment explains why a single number would dead-letter valid v1-only types |
| 183 | `bumpAttempts` in the DB | survives restarts and rebalances |
| 185-192 | success → clear attempts, metric `ok` | |
| 193-227 | failure: attempts ≥ max → `deadLetter(MAX_ATTEMPTS_EXCEEDED)`, clear, **return** (move on). Else log and **rethrow** so KafkaJS redelivers | |
| 231-244 | `bumpAttempts` (upsert +1) / `clearAttempts` | |
| 253-337 | `deadLetter`: upsert into `dead_letters` (payload, coordinates, reason, message, stack, attempts, status OPEN). Also forward to the `<topic>.dlq` Kafka topic with `dlq-*` headers. Each step has its own try/catch, so a DLQ failure is logged, never thrown | |
| 344-373 | `replayDeadLetters`: select OPEN rows (optionally by ids), re-send to `source_topic` keyed by `aggregate_id`, mark `REPLAYED` | dedupe makes replay safe |

## `src/consumer/runner.js`

- Lines ~10-31: gauge `tessera_kafka_consumer_lag{group,topic,partition}`.
- `startConsumer({clientId, groupId, topics, brokers, pool, handle, readerVersion, maxAttempts=5, fromBeginning=true})`:
  creates a Kafka client (10 retries), a **consumer group** (session 30 s,
  heartbeat 3 s), a producer (for the DLQ) and an admin (for lag), then subscribes.
- `consumer.run({ autoCommit: true, eachMessage: withDLQ(...) })`. KafkaJS
  commits offsets **after** `eachMessage` resolves, so a crash mid-handler means
  redelivery (at-least-once). DLQ topic = `${topics[0]}.dlq`.
- A lag sampler every 5 s: `topic end offset − committed offset` per partition (−1
  committed = everything is lag). Errors are ignored ("the broker being briefly
  unreachable must not crash the consumer").
- Returns `{consumer, producer, stop(), lag()}`. `stop` disconnects cleanly so the
  group rebalances immediately.

---

## `src/failpoints/index.js`

| Lines | What |
|---|---|
| 21 | `ENABLED = process.env.FAILPOINTS_ENABLED === 'true'` |
| 39-49 | `arm(name, {action, count=1, probability=1, delayMs, message})`, throws if disabled |
| 69-100 | `failpoint(name)`: fast exit if disabled or nothing armed; probability gate; count hits and disarm after `count`; then `crash` → `process.exit(9)` (deliberately skipping every cleanup, to simulate SIGKILL), `throw` → error with `code 'FAILPOINT'`, `delay` → sleep, `drop` → return `true` (the caller should skip its side effect) |
| 106-128 | `router(express)` → `GET /`, `POST /:name` (arm), `DELETE /:name`, `DELETE /`. Returns `null` when disabled, so it is never mounted |

Failpoint names in the code: `outbox.before_publish`,
`outbox.after_publish_before_mark`, `consumer.after_handle_before_commit`,
`reserve.before_commit`, `confirm.before_commit`,
`expiry.after_claim_before_commit`, `saga.after_hold_before_commit`,
`saga.after_confirm_before_commit`, `payment.after_insert_before_charge`.

## `src/http/server.js`, the service shell

| Lines | What | Why |
|---|---|---|
| 38-44 | Express app, hide `x-powered-by`, `trust proxy`, JSON body limit 256 kb | |
| ~48-59 | middleware: `requestId` = header or new UUID; `correlationId` = header or requestId; `traceId` from `traceparent`; set `req.context`; echo `x-request-id`; run the rest inside `withContext(...)` | every log line in this request automatically carries the ids |
| ~61-76 | request logging on `finish`: 5xx → error, 4xx → **debug**, else info | conflicts are normal; logging them as errors trains people to ignore logs |
| ~79-83 | `GET /health`: always ok + uptime | **liveness never checks dependencies**: a DB outage must not cause a restart loop |
| ~86-111 | `GET /ready`: run each dependency check; critical failing or draining → 503; non-critical failures listed as `degraded`; includes event-loop lag | Redis down = degraded, still serving |
| ~113 | `GET /metrics` | Prometheus scrape |
| ~116-120 | mount `/_failpoints` only if enabled, with a loud warning | |
| ~122 | start the event-loop lag probe | |
| 128 | `asyncHandler(fn)` | forwards a promise rejection to Express' error handler |
| 137-160 | `errorMiddleware`: `TesseraError` → its status, `Retry-After` if set, log only 5xx. **Raw PG `23P01` / `23505` → 409**. Anything else → log + 500 generic | a correct system never looks broken under load |
| 171-235 | `listen(...)`: keep-alive 65 s / headers 70 s; `shutdown(signal)`: (1) `draining = true` → readiness 503, (2) wait `drainMs` (3 s), (3) `server.close`, (4) stop each worker (release leases), (5) close each resource, (6) exit 0. `unhandledRejection` → log. `uncaughtException` → log + **exit 1** (unknown state; let the orchestrator restart it) | zero-downtime deploys |

## `src/admission/token-bucket.js`

| Lines | What |
|---|---|
| 1-29 | comment: one Lua script = atomic; the old version consumed tokens on *denied* requests (a throttled client deepened its own penalty); token bucket vs fixed window; **fail closed** |
| 35-72 | `TOKEN_BUCKET_LUA`: read `tokens`, `updated`; first time → full bucket; refill `elapsed·rate` capped at capacity; allow and subtract, or compute `retryAfterMs` and **consume nothing**; save; set `EXPIRE` |
| 75-107 | `LocalBucket`: the same maths in a Map; `sweep()` removes buckets idle > 5 min (memory bound) |
| 109-123 | `TokenBucket` constructor; sweep every 60 s, `unref` |
| 132-183 | `take(key, limit)`: key `tb:<key>`, TTL ≥ 60 s; `SCRIPT LOAD` once, then `EVALSHA`; on `NOSCRIPT` (Redis restarted) reload and retry; any Redis error → warn + `local.take` with `degraded: true` |
| 194-202 | `LIMITS` per route: search 60/2s · availability 120/4s · **reserve 5/0.2s** · confirm/cancel 10/0.5s · waitingRoom 60/1s · auth 10/0.1s |

## `src/admission/waiting-room.js`

| Lines | What |
|---|---|
| 1-37 | comment: rate limiting ≠ waiting room; Lua makes it safe across 5 gateways; why Redis is acceptable here (not an inventory-correctness mechanism); signed tokens |
| 44-63 | `JOIN_LUA`: if the session is already in the queue, return its ticket (keep your place); else `INCR seq` → `ZADD queue ticket session` → member hash + TTL |
| 75-102 | `ADMIT_LUA`: `ZREMRANGEBYSCORE active -inf now` (reclaim expired slots); `capacity = maxActive − ZCARD active`; take `min(capacity, drip)` from the queue head; move each to `active` scored by `now + sessionTtl` |
| 105-117 | `HEARTBEAT_LUA`: extend only if still active (can't revive a lapsed session) |
| 119-124 | defaults: 100 active, drip 10 per tick, session 10 min, queue TTL 1 h |
| 139-148 | keys `wr:{eventId}:…`. The `{}` is a Redis Cluster hash tag that keeps all of an event's keys on one shard (Lua needs that) |
| 152-176 | `join` → ticket, position (`ZRANK+1`), `rejoined` |
| 181-195 | `admit` |
| 199-237 | `status`: ADMITTED (+ a fresh token) / NOT_IN_QUEUE / QUEUED with position and an ETA estimate ("a rough estimate is far better than none: users given no progress refresh constantly") |
| 240-275 | `heartbeat`, `leave`, `stats` |
| 279-284 | `issueToken`: `base64url(JSON{e,s,x}) + '.' + HMAC` |
| 287-316 | `verifyToken`: split, recompute the HMAC, **`timingSafeEqual`**, parse, check expiry, check it is **bound to this event** (stops queue-jumping with a token from a quiet event) |
| 320-359 | `AdmissionLoop`: every second, `admit()` each tracked event; runs on every gateway instance (the Lua makes that safe) |

## `src/pricing/index.js`

| Lines | What |
|---|---|
| 27 | `MIN_SPAN_SHARE = 0.3` (short hops still pay at least 30%) |
| 30-35 | `TIERS`: <50% STANDARD ×1.0, <80% FILLING ×1.1, <95% HIGH_DEMAND ×1.25, else LAST_SEATS ×1.5 |
| 37-41 | `demandTier(available, total)` → occupancy = 1 − available/total |
| 55-62 | `fare()`: `spanShare = max(0.3, (to−from)/spanMax)`; `raw = base × share × multiplier`; round to a whole rupee (`/100`, round, `×100`); minimum 100 paise |

## `src/observability/metrics.js`

- Its own Prometheus `Registry` with default Node metrics (prefix `tessera_`).
- Buckets: `latency` (5 ms → 10 s) and `wait` (1 ms → 30 s, for lock waits).
- Metric groups (lines ~28-237): reservation funnel (`attempts`, `success`,
  **`conflict` separate from `error`**, **`oversell_prevented_total`**, hold
  duration, holds expired by `lazy`/`sweeper`); DB health (tx duration, lock
  wait, retries, pool connections, event-loop lag); messaging (outbox
  pending/latency/published, events consumed, duplicates, stale, DLQ); admission
  (rate limited, load shed, waiting-room depth/active/admitted, cache hit/miss,
  availability age); saga/payment/reconciliation (transitions, compensations,
  stuck, payment unknown, issues, **`invariant_violations` (must be 0)**).
- `poolMetrics` (243-254) reads each registered pool's counts at scrape time.
- `startEventLoopLagProbe` (263-274): every 500 ms, measure how late the timer
  fired, which gives the lag the gateway uses to shed load.
- `metricsHandler` (279-283).

## `src/observability/logger.js`

- `AsyncLocalStorage` holds a per-request context. `withContext(ctx, fn)` runs `fn`
  with parent context merged with `ctx`. `addContext` mutates in place (e.g. once a
  reservation id is known).
- A winston format merges the context into **every** log line. JSON by default;
  `LOG_FORMAT=pretty` for colourful dev output.

## `src/observability/tracing.js`

- Must be required **before** express/pg/ioredis/kafkajs, because
  auto-instrumentation patches modules as they load. That is why every service's
  `index.js` requires it on line 2.
- Active only if `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Service name is taken from
  the path (`services/<name>/`). The fs instrumentation is disabled, and health
  probes are ignored. Exports to Jaeger over OTLP HTTP. Any failure only warns
  ("tracing is diagnostic; it must never stop a service").

## `src/util/backoff.js`

- `fullJitter(attempt, {baseMs=20, maxMs=1000})` = `random(0, min(max, base·2^(attempt−1)))`.
- `retry(fn, {maxAttempts=3, shouldRetry=isRetryablePgError, onRetry})` returns
  `{value, attempts}`, so callers can record retry counts ("retries hidden inside a
  helper are how 'fast p50, terrible p99' happens").

## `test/admission.test.js`

Token bucket: burst then deny; a **denied request costs nothing**; concurrent calls
never exceed capacity; falls back locally when Redis is gone. Waiting room: stable
FIFO positions; rejoin keeps your place; **5 concurrent instances never over-admit**;
expired sessions free their slots; tokens verify, expire and are event-bound;
heartbeat can't revive a lapsed session.

Next: [04b · Inventory engine →](04b-inventory-engine.md)
