# 00 · Concepts primer — every idea this project uses, from zero

This file explains every concept Tessera relies on, before you look at any code.
It starts basic and gets advanced. Each concept has:

- **What** — a one-sentence definition
- **Analogy** — an everyday picture
- **Why Tessera needs it**
- **Where** — the file(s) where it lives

If you already know a section, skip it.

---

## Part A — Foundations

### A1. Client, server, API, HTTP status codes

- **What.** A *client* (browser, another service) sends an HTTP *request*. A
  *server* answers with a *response*: a status code plus a body (usually JSON).
- **Status codes you will see everywhere here:**

| Code | Meaning | In Tessera |
|---|---|---|
| 200 / 201 | OK / created | normal success |
| 202 | **Accepted**: "got it, still working on it" | creating a reservation returns 202, and the booking finishes in the background |
| 400 | your request is malformed | missing fields |
| 401 / 403 | not logged in / not allowed | missing JWT / not an operator |
| 404 | not found | also used to *hide* other people's reservations |
| **409** | **Conflict**: someone else got it first | "seat already taken". This is **expected**, not a bug |
| 422 | same idempotency key, different body | client bug or attack |
| 429 | too many requests | rate limiter |
| 503 | server overloaded / dependency down | load shedding |
| 500 | we broke | the only one that means a real fault |

> 💡 The project is strict about **409 vs 500**. 1,000 people trying to buy one seat
> should produce 1 success and 999 × 409. If those 999 became 500s, dashboards
> would say "the system is broken" when it is actually working perfectly.
> → `packages/shared/src/errors/index.js`

### A2. Monolith vs microservices

- **Monolith**: one program, one database.
- **Microservices**: several small programs (services), each owning **its own
  database**, talking over the network.
- **Analogy.** A monolith is a one-person shop. Microservices are a mall: each
  store has its own stockroom, and stores phone each other.
- **Why Tessera does it.** To show the *hard* problems that only appear once the
  pieces are separate. "Charge the card AND confirm the seat" can no longer be one
  database transaction, because the card data and the seat data live in different
  databases.
- **Where.** `services/*`. Each has its own DB (`deploy/compose/init/postgres/01-databases.sql`).

### A3. Database, table, row, primary key, index

- A **table** is a spreadsheet. A **row** is one line. The **primary key** is the
  unique ID column.
- An **index** is the book's index: it lets the DB find rows without reading the
  whole table.
- A **partial index** indexes only *some* rows, e.g. `WHERE state = 'HELD'`. It stays
  tiny even when the table holds millions of old rows. Tessera uses these on every
  hot path.

### A4. Transactions and ACID

- **What.** A *transaction* groups several statements so they **all happen or none
  happen**: `BEGIN … COMMIT` (or `ROLLBACK` to undo).
- **Analogy.** A bank transfer: "take ₹100 from A" and "give ₹100 to B" must both
  happen, or neither.
- **ACID**:
  - **A**tomic: all or nothing.
  - **C**onsistent: constraints always hold.
  - **I**solated: concurrent transactions don't see each other's half-done work.
  - **D**urable: once committed, it survives a crash.
- **Why Tessera needs it.** It is the main tool in the whole project. Almost every
  pattern below is a trick for putting two things *into the same transaction*, so
  that a crash cannot separate them.
- **Where.** `pool.withTransaction()` in `packages/shared/src/db/pool.js`.

### A5. Constraints and triggers

- A **constraint** is a rule the database enforces on every write, no matter which
  code does it. Examples: `UNIQUE`, `NOT NULL`, `CHECK (held + confirmed <= capacity)`.
- A **trigger** is a small function the DB runs automatically before or after a
  write. Tessera uses triggers to:
  - enforce **state machines** (reject `FAILED → CAPTURED`)
  - make tables **append-only** (reject any UPDATE or DELETE on the ledger)
- **Analogy.** A constraint is a bouncer at the door. Even if your code forgets to
  check, the bouncer doesn't.
- **Why.** "Rules in the database, not just in code" is the project's core
  philosophy. A buggy service, a hand-typed SQL fix at 3 a.m., or a future
  developer all hit the same wall.

### A6. Migrations

- **What.** Versioned SQL files (`010_inventory_core.sql`, `011_…`) that build the
  schema step by step. A runner records which ones have been applied.
- **Rule.** Never edit an applied migration; add a new one. Tessera's runner stores
  a **checksum** (a SHA-256 fingerprint) of each file and refuses to run if an old
  file changed. `012_tighten_insert_guard.sql` and `014_ledger_baseline.sql` are
  real examples of "fix by adding a new file".
- **Where.** `packages/shared/src/db/migrate.js`.

---

## Part B — Concurrency (the heart of the project)

### B1. What is a race condition?

- **What.** Two things happen at the same time, and the result depends on which
  one wins by luck.
- **The classic oversell bug ("check-then-act"):**

```
User A: SELECT status → 'AVAILABLE'      User B: SELECT status → 'AVAILABLE'
User A: UPDATE status = 'SOLD'            User B: UPDATE status = 'SOLD'
→ both think they bought seat 12A 💥
```

- The gap between *checking* and *acting* is called a **TOCTOU** (time-of-check to
  time-of-use) window.
- 🧪 The Contention Lab ran exactly this with 1,000 users and one seat:
  **64 customers were sold the same seat** (`docs/benchmarks/RESULTS.md` §2).

### B2. Locks: pessimistic locking (`SELECT … FOR UPDATE`)

- **What.** "Lock this row. Anyone else who wants it waits until I commit."
- **Analogy.** One key for the restroom. You take the key, and everyone else queues.
- **Pros**: simple, correct. **Cons**: waiters hold DB connections while they wait.
- In Tessera the reserve path locks the seat rows first, in sorted order (see B5).

### B3. Optimistic locking / compare-and-swap (CAS)

- **What.** Don't lock. Read the row, then write **only if it hasn't changed**:
  `UPDATE … SET state = 'X' WHERE id = $1 AND state = 'expected'`.
  If 0 rows were updated, someone beat you.
- **Analogy.** Editing a shared doc: "save only if nobody saved since I opened it".
- **Where.** Saga transitions (`#transitionIn` in the orchestrator), payment
  transitions (`#transition` in payment.service.js), confirm (`WHERE … AND
  expires_at > now()`).

### B4. `SKIP LOCKED` — a work queue in a table

- **What.** `SELECT … FOR UPDATE SKIP LOCKED LIMIT 20` means "give me 20 rows nobody
  else has locked, and skip the locked ones instead of waiting".
- **Analogy.** Several cashiers with one queue. Each cashier calls the next
  *unserved* customer, and nobody fights over the same one.
- **Why.** Many worker processes can share work **without a leader and without
  coordination**. Tessera uses it for the expiry sweeper, the saga worker, the
  outbox relay, the payment resolver and the discovery refresher.

### B5. Deadlocks and lock ordering

- **What.** A waits for B's lock while B waits for A's lock, so both wait forever.
  Postgres detects this and kills one of them (SQLSTATE `40P01`).
- **Classic cause.** Request 1 locks seats {A, B}, request 2 locks {B, A}.
- **Fix.** Everyone locks in the **same global order** (sort by id). Then a cycle
  cannot form. → `reserve.js` step 3: `resolved.sort(...)`.

### B6. Isolation level "READ COMMITTED"

- Postgres' default. Each statement sees data committed *before that statement
  started*. A blocked UPDATE re-checks its `WHERE` clause against the newly committed
  row. That is why `UPDATE … WHERE id = $1` (no status condition) oversells, while
  `UPDATE … WHERE id = $1 AND status = 'AVAILABLE'` is safe.

### B7. Range types and the exclusion constraint ⭐ (the one big idea)

- **Range type.** Postgres can store an interval as one value: `int4range`, written
  `[3,7)`. Here `[` means "includes 3" and `)` means "excludes 7". This is called
  **half-open**.
- `&&` is the "overlaps" operator. `[0,3) && [3,5)` is **false**, because they only
  touch at 3. That is exactly right: someone getting off at stop 3 and someone
  boarding at stop 3 can share the seat.
- **Exclusion constraint.** A generalised UNIQUE: *"no two rows may have equal
  `resource_id` AND overlapping `span`"*:

```sql
EXCLUDE USING gist (resource_id WITH =, span WITH &&)
  WHERE (state IN ('HELD','CONFIRMED','BLOCKED'))
```

- **GiST** is the index type that can answer "does anything overlap this range?"
  quickly. `btree_gist` is the extension that lets it also handle the plain `=`
  on `resource_id`.
- The `WHERE` makes it a **partial** constraint: expired, released and cancelled
  rows stay as history but no longer block anyone.
- **Analogy.** A hotel's booking book that physically refuses to accept two entries
  for room 204 on overlapping nights.
- **Why this is the whole project.** Overselling becomes **impossible at the storage
  layer**. Postgres rejects the second row with SQLSTATE `23P01`, and the API turns
  that into a 409. Every other layer (Redis, caches, locks) only makes things
  faster. None of them is needed for correctness.
- **Where.** `services/inventory-engine/sql/migrations/010_inventory_core.sql:202`.

### B8. Hot rows and sharded counters (buckets)

- **Problem.** If 10,000 people buy "a meal" and there is one row
  `meals_left = 500`, everyone queues on that **single hot row**.
- **Fix.** Split it into N **buckets** (rows), each holding part of the capacity.
  Buyers start at a hashed bucket and move to the next if it is full. N rows give
  N independent queues.
- **Where.** `pool_buckets` table + `claimPool()` in `reserve.js`. The same idea
  explains why `aggregate_sequences` is per-aggregate rather than one global
  counter.

---

## Part C — Reliability in a distributed system

### C1. Network calls fail in three ways, not two

A call to another service can:
1. **succeed**
2. **fail** (you get an error answer)
3. **time out**: you **don't know** whether it happened

The third case is the dangerous one. If the payment provider charged the card and
then the network dropped the reply, retrying would **charge twice**, and assuming
failure would **lose a paid booking**.

- **Tessera's answer.** A timeout is recorded as the state **`UNKNOWN`**. A resolver
  then *asks the provider* what happened. → `services/payment`.

### C2. Idempotency

- **What.** Doing an operation twice has the same effect as doing it once.
- **Analogy.** Pressing the lift button 5 times still calls one lift.
- **How.** The client sends an `Idempotency-Key` header (a unique string per
  attempt). The server **claims** the key atomically *before* doing the work
  (`INSERT … ON CONFLICT DO NOTHING`). A retry with the same key gets the **stored
  original response** back instead of a second booking.
- ⚠️ **The common wrong version** (check if key exists → do work → save key) has a
  race: two retries both pass the check. Tessera claims first.
- **Where.** `packages/shared/src/idempotency/index.js`.

### C3. Retries, exponential backoff and jitter

- **Backoff**: wait longer after each failure (100 ms, 200 ms, 400 ms…).
- **Jitter**: randomise the wait. Without it, 1,000 clients that failed together
  all retry at the same instant and fail together again (a "thundering herd").
- **Full jitter**: wait a random time between 0 and the ceiling.
- **Where.** `packages/shared/src/util/backoff.js`, outbox relay, saga failures.

### C4. Message broker (Kafka), topics, partitions, consumer groups

- **Kafka** is a durable, ordered log of messages. Producers append and consumers
  read.
- **Topic**: a named log (`inventory.events`, `booking.events`).
- **Partition**: a topic is split into partitions for parallelism. **Order is only
  guaranteed within one partition.** Messages with the same **key** always go to
  the same partition, so Tessera keys by `aggregate_id` (e.g. the train's event id)
  to keep each train's events in order.
- **Consumer group**: several copies of a consumer share the partitions between
  them.
- **Offset**: a consumer's bookmark ("I've processed up to message 4,512").
- **KRaft**: Kafka running without ZooKeeper (one process in local dev).

### C5. Delivery guarantees: at-most-once, at-least-once, "effectively-once"

- **At-most-once**: may lose messages, never duplicates.
- **At-least-once**: never loses, **may duplicate**. Kafka with "commit offset
  after processing" gives you this.
- **Exactly-once** across Kafka *and* a database doesn't come for free. Tessera
  says so plainly and builds **effectively-once**:

  ```
  at-least-once delivery + idempotent consumer (dedupe in same tx) = effectively-once effect
  ```

### C6. The dual-write problem and the Transactional Outbox ⭐

- **Problem.** A service must (1) update its DB **and** (2) publish an event. Two
  separate systems give two separate failure points:
  - `COMMIT; publish()`: if it crashes in between, the event is lost forever.
  - `publish(); COMMIT`: if the commit fails, the world heard about something that
    never happened.
- **Outbox pattern.** Write the event as a **row in an `outbox_events` table, in the
  same transaction** as the business change. Either both commit or neither does.
  A separate **relay** later reads pending rows, publishes them to Kafka, and
  marks them published.
- **Analogy.** Instead of mailing a letter the instant you sign a contract (and
  maybe forgetting), you drop the letter into an outbox tray **stapled to the
  contract**. The office boy empties the tray to the post office.
- **Cost.** Events are a few hundred ms late. **Benefit.** Never lost. 🧪 Kafka was
  down for hours during development: 931 events waited in the outbox and all were
  delivered after recovery (`docs/CHALLENGES.md` #8).
- **Where.** `packages/shared/src/outbox/writer.js` (write), `relay.js` (publish).

### C7. Idempotent consumer / inbox (dedupe table)

- Since delivery is at-least-once, consumers must ignore duplicates.
- **How.** In the *same transaction* as the effect, insert
  `(consumer, event_id)` into `processed_events`. A duplicate collides on the
  primary key and is skipped. Effect and marker commit together, so a crash
  can't leave one without the other.
- **Where.** `packages/shared/src/consumer/index.js` → `createIdempotentHandler`.

### C8. Out-of-order events and sequence numbers

- Even within a partition, retries and rebalances can deliver an *older* event after
  a newer one. Each event carries `aggregate_seq` (1, 2, 3… per aggregate).
  A projection stores the highest seq it applied and drops anything older.
- **Where.** `projection_offsets` table + the `opts.projection` branch in the consumer.

### C9. Dead Letter Queue (DLQ) and poison messages

- A **poison message** fails every time (bad JSON, schema violation, a bug). If you
  keep retrying it, the whole partition stalls behind it.
- **DLQ.** After N attempts, park it in a `dead_letters` table and a `.dlq` topic,
  then move on. An operator can fix the bug and **replay** it.
- ⚠️ Retry counts are stored **in the DB**, not in memory. An in-memory counter
  resets on restart, so a poison message would look like "attempt 1" forever.

### C10. Schema evolution, versioning and upcasting

- Events are contracts between services. Changing one can break consumers.
- **Rules.** Additive optional changes keep the same version. Breaking changes get
  a **new version** plus an **upcaster**: a function converting v1 → v2.
- Example: `booking.confirmed` v2 added `currency` and `seat_codes`, and the
  upcaster fills `currency: 'INR'` for old v1 events.
- **Validation** uses JSON Schema (via the Ajv library) at the producer (before
  writing the outbox row) **and** at the consumer.
- **Where.** `packages/shared/src/events/schemas.js`, `registry.js`.

### C11. Saga pattern ⭐ (distributed transactions without 2PC)

- **Problem.** "Hold seat → charge card → confirm seat" spans 3 services and 3
  databases, so there is no single transaction.
- **2PC (two-phase commit)** would lock everything across services while waiting
  on a slow card payment. Tessera rejects it.
- **Saga.** A sequence of local steps. Each step has a **compensation** (an undo)
  if a later step fails:
  - hold OK, payment failed → **release the hold**
  - paid, confirm failed → **refund**
- **Orchestration** (used here): one coordinator (the reservation service's saga
  orchestrator) drives the steps. The alternative, *choreography*, has services
  reacting to each other's events.
- **Durable saga.** The saga's current state is a **row in a table**, not a variable
  in memory. If the process dies, another worker reads the row and continues.
- **Where.** `services/reservation/src/saga/orchestrator.js`.

### C12. State machines

- **What.** An object can only be in certain states, and only certain moves between
  them are legal. Example: `HELD → CONFIRMED` ✓, `CONFIRMED → HELD` ✗.
- Tessera enforces each one **with a DB trigger** (allocations, holds, sagas,
  payments). An illegal transition throws an error no matter which code tries it.

### C13. Leases

- **What.** A lock with an expiry time: "worker-7 owns this saga until 12:00:60".
- **Why.** If worker-7 crashes, the lease **expires** and another worker can take
  over. A plain lock held by a dead process could block forever.
- **Where.** `lease_owner`, `lease_until` on `sagas` and `outbox_events`.

### C14. TTL (time-to-live) and expiry

- A **hold** reserves a seat for 10 minutes (default 600 s). If you don't pay in
  time, it expires and the seat goes back.
- Tessera expires holds two ways:
  - **lazily**: the reserve path cleans expired holds on exactly the seats it is
    about to touch, inside its own transaction. This is the correctness-relevant
    path.
  - **sweeper**: a background job, so browsing users see freed seats quickly. This
    one is only about freshness.

### C15. Reconciliation

- **What.** A periodic auditor that compares services against each other ("payment
  captured but no booking?") and reports or fixes mismatches.
- **Grace window + seen twice.** Cross-service state is never perfectly in sync at
  any instant, so an issue counts only if it is old enough and survives two passes.
- **Money rule.** Anything involving money is **never auto-fixed**. A human decides.

### C16. Ledger / double-entry thinking

- **What.** An **append-only** list of every inventory movement with a signed
  delta (`+1` available, `-1` allocated…). Adding up (folding) the ledger must equal
  the real current state. If it doesn't, some code moved inventory without writing
  the ledger, and that is caught automatically.
- **Where.** `inventory_ledger` + view `invariant_ledger_drift`.

### C17. Invariants

- **What.** A statement that must *always* be true, e.g. "no two live allocations
  overlap". Tessera writes each one as a **SQL view that returns zero rows when
  healthy**. Tests, the lab, reconciliation and the dashboard all query the same
  views.

---

## Part D — Protecting the system under load

### D1. Rate limiting with a token bucket

- **What.** Each user has a bucket of N tokens. Each request costs 1 token, and
  tokens refill at R per second. An empty bucket means 429.
- **Why a bucket rather than "N per minute".** A fixed window allows a burst of 2N
  across the boundary between two windows. A bucket refills smoothly.
- **Atomicity.** The whole decision runs as **one Lua script inside Redis**. Redis
  runs scripts atomically, so two gateways can't both see "1 token left".
- **Fail closed.** If Redis is down, fall back to a local in-memory limiter rather
  than allowing everything.
- **Where.** `packages/shared/src/admission/token-bucket.js`.

### D2. Virtual waiting room

- Rate limiting stops *one* greedy client. A flash sale is **100,000 polite users**
  at once. A waiting room caps **how many are inside** and admits more as slots
  free (like a club with a doorman).
- Admitted users get a **signed token** (an HMAC) that the gateway checks *without*
  Redis, so a Redis outage doesn't kick out people already checking out.
- **Where.** `packages/shared/src/admission/waiting-room.js`.

### D3. Load shedding and backpressure

- If the Node process is overloaded (its **event-loop lag** is high), reject new
  requests immediately with 503 + `Retry-After`. A fast "try again" beats a slow
  timeout. → gateway middleware #1.

### D4. Caching: L1, L2, TTL, stampede, single-flight, versioned keys

- **L1**: an in-process `Map` (fastest, per instance). **L2**: Redis (shared by all
  instances).
- **TTL**: how long an entry lives. **Jittered TTL**: randomised so entries don't
  all expire together.
- **Cache stampede**: an entry expires and 500 requests all hit the DB at once.
  **Single-flight**: only the first request runs the query, and the others wait for
  its promise.
- **Versioned keys**: the key includes a version number. Bumping the version makes
  every old entry unreachable, so there is no explicit delete step to get wrong.
- **Rule in Tessera.** Caches are only for **reads that aren't authoritative**
  (search). The booking path never trusts a cache.

### D5. Circuit breaker

- If a dependency (Elasticsearch) fails, stop calling it for a while (10 s) and use
  a fallback (Postgres search). Then try again. This avoids hammering a sick system.

### D6. CQRS / read model / projection

- **Command side** (writes) and **query side** (reads) use different data shapes.
  Discovery keeps a **projection**: a precomputed, search-friendly copy of
  availability, rebuilt when inventory events say "train X changed".
- It is **eventually consistent**: possibly a few seconds stale, and labelled
  `authoritative: false`.

---

## Part E — Security basics used here

| Concept | One-liner | Where |
|---|---|---|
| **JWT (HS256)** | a signed token `header.payload.signature`. The server verifies the HMAC signature to trust the payload (user id, role, expiry) | `services/gateway/src/auth.js` |
| **HMAC** | a "signature" made with a shared secret. Anyone without the secret can't forge it | webhooks, JWT, waiting-room tokens |
| **Constant-time compare** | compare signatures in fixed time, so attackers can't learn how many characters matched by timing | `crypto.timingSafeEqual` |
| **Webhook replay protection** | store each provider event id, and ignore repeats. Include a timestamp in the signature and reject old ones | `provider_events` table |
| **RBAC** | role-based access: CUSTOMER vs OPERATOR | gateway `requireRole` |
| **Service token** | internal APIs require `x-internal-token`, so they can't be called from outside | `requireInternal` |
| **Never trust client prices** | the server computes fares; any price the client sends is ignored | pricing service |
| **404 instead of 403** | don't even confirm another user's reservation exists | reservation GET |

---

## Part F — Operations and observability

| Concept | One-liner | Where |
|---|---|---|
| **Structured logging** | logs are JSON with `request_id`, `correlation_id`, `trace_id` attached automatically | `observability/logger.js` (uses AsyncLocalStorage) |
| **Correlation id** | one id that follows a booking across all services and events | HTTP shell middleware |
| **Metrics (Prometheus)** | counters, gauges, histograms scraped from `/metrics` | `observability/metrics.js` |
| **p50 / p99** | 50% / 99% of requests were faster than this. p99 shows the worst experiences | benchmark tables |
| **Distributed tracing (OpenTelemetry / Jaeger)** | a timeline of one request across services | `observability/tracing.js` |
| **Liveness vs readiness** | `/health`: "is the process alive?" (restart if not). `/ready`: "should it get traffic?" (DB reachable?) | `http/server.js` |
| **Graceful shutdown** | on SIGTERM: fail readiness → drain → stop workers & release leases → close pools | `http/server.js listen()` |
| **Failpoints** | named spots in the code where tests can inject a crash or error on purpose | `failpoints/index.js` |
| **Chaos testing** | break things deliberately (stop Kafka/Redis, time out payments) and check correctness | `scripts/chaos.sh` |
| **Docker Compose profiles** | start groups of containers: `core`, `obs`, `app`, `lab` | `deploy/compose` |
| **Kubernetes, HPA, PDB** | deployments, autoscaling on CPU, a minimum number of pods kept up during disruptions | `deploy/k8s` (not run on a real cluster) |

---

## How the concepts stack up in Tessera

```
                 ┌──────────── Load protection (D) ─────────────┐
                 │ rate limit · waiting room · load shed · cache │   ← speed & fairness
                 └──────────────────────────────────────────────┘
                 ┌──────────── Reliability (C) ─────────────────┐
                 │ idempotency · outbox · dedupe · saga · UNKNOWN│   ← no lost/double effects
                 │ reconciliation · ledger · DLQ                 │
                 └──────────────────────────────────────────────┘
                 ┌──────────── Concurrency (B) ─────────────────┐
                 │ sorted row locks · SKIP LOCKED · CAS          │   ← throughput
                 └──────────────────────────────────────────────┘
                 ┌──────────── The foundation ──────────────────┐
                 │ Postgres transactions + EXCLUSION CONSTRAINT  │   ← CORRECTNESS lives here
                 └──────────────────────────────────────────────┘
```

**Remember this one sentence:** *correctness lives in the bottom box. Everything
above it makes the system faster, fairer or more resilient, but none of it can
cause an oversell if it breaks.*

Next: [01 · The big picture →](01-level1-big-picture.md)
