# Tessera — interview reference

Written for: **you, preparing to defend this project in a technical interview.**

Every claim below is backed by code, a test, or a measured benchmark, and each answer says
which. Where something is designed but not built, it says so — being caught overstating one
thing costs you credibility on everything else you said.

The strongest move available to you in an interview is the one this project is built around:
**show the failure, then show the fix, then show the measurement.** Most candidates describe
architectures. Very few can say "here is the bug, here is the number, here is what changed."

---

## 0. The thirty-second answer

> Tessera is a distributed reservation and inventory platform. The hard problem is allocating
> scarce inventory to many concurrent users without ever overselling, while surviving payment
> failures, process crashes and partial outages. The core decision is that PostgreSQL is the
> only authority: overselling is prevented by a GiST exclusion constraint, so a bug anywhere
> above the database cannot cause a double-booking. Everything else — caches, Redis locks,
> queues — is a throughput optimisation. I proved the difference by building a lab that runs
> nine concurrency strategies against the same workload and checks the database afterwards.

If they only ask one follow-up, it will be "how do you know it works?" The answer is §4.

---

## 1. Why this exists

**Q: Why did you change the original ticket-booking project?**

The original was a competent CRUD application with microservices attached. Its weakness was
that nothing in it was hard: the interesting problem — safe allocation of scarce resources
under contention — was handled by a Redis lock and hope.

Reading the code, I found defects that were not hypothetical:

| Defect | Consequence |
|---|---|
| Commit to database, then publish to Kafka with `catch → log("CRITICAL")` | Confirmed bookings could emit no event; nothing reconciled it |
| Idempotency was check-then-act; payment called the provider *before* recording the key | Two concurrent retries both charged |
| Every reserve/confirm/release updated one per-schedule counter row and recounted every seat | All traffic for one train serialised on one row |
| Segment locks and whole-journey locks checked different tables | A seat booked for the whole journey could be re-held for a segment |
| A bad client signature marked a payment `FAILED`, a terminal state | The genuine webhook afterwards was discarded: money taken, no booking, triggerable by anyone |
| Redis lock acquired before the database, failing closed on Redis errors | Redis down meant no bookings at all |
| Expiry used a session-level advisory lock through a connection pool | The unlock could land on a different connection and leak the lock |

The rewrite keeps the microservice topology and replaces the correctness core.

**Q: What is the actual hard problem?**

Allocating scarce inventory to a large number of simultaneous claimants such that the number
sold never exceeds what exists — while payments fail, processes die, networks partition and
messages arrive twice or out of order.

Everything else in the system is in service of that sentence.

---

## 2. The central design decision

**Q: What is the source of truth?**

PostgreSQL, for every allocation decision. Explicitly:

| State | Authority | Acceleration |
|---|---|---|
| Who holds which resource, over which span | `allocations` table + exclusion constraint | Redis availability cache, Elasticsearch counts |
| Hold TTL | `holds.expires_at`, database clock | a Redis key, as a cleanup hint only |
| Payment state | Payment database, and the provider wins on `UNKNOWN` | webhooks |
| Ledger / audit | Append-only tables, `UPDATE`/`DELETE` blocked by trigger | — |
| Rate limits, waiting-room queue | **Redis, deliberately non-authoritative** | — |
| Search results | Elasticsearch | explicitly labelled discovery, not truth |

**Q: How do you prevent overselling?**

Every kind of inventory is modelled as one shape: a **resource occupied over an interval**.

| Domain | Resource | Span |
|---|---|---|
| Railway | seat | range of station stops, `[3,7)` |
| Hotel | room | range of nights, `[0,3)` |
| Concert / appointment | seat / slot | `[0,1)` |

Then the rule is one line of SQL:

```sql
ALTER TABLE allocations
  ADD CONSTRAINT allocations_no_overlap
  EXCLUDE USING gist (resource_id WITH =, span WITH &&)
  WHERE (state IN ('HELD','CONFIRMED','BLOCKED'));
```

Two live allocations of the same resource whose spans overlap cannot both exist, because
PostgreSQL will not store the second row.

Three things follow, and they are the interesting part:

1. **Overselling is not prevented by application care.** It is prevented by the database
   refusing the write. Every layer above becomes an optimisation.
2. **Half-open ranges model the domain exactly.** A passenger alighting at stop 5 and another
   boarding at stop 5 do not conflict, and `&&` gets that right with no special-casing.
3. **The old dual-code-path bug becomes impossible.** There is one representation of "taken",
   so there is nothing for two code paths to disagree about.

The `WHERE` clause matters too: expired and cancelled rows stay as history but stop
constraining anything, so the audit trail costs nothing in availability.

**Q: Why not just use a unique constraint?**

A unique constraint on `(resource_id, seat)` handles "one seat, one booking". It cannot
express "these two *ranges* overlap". Segment booking — the thing that makes a train
profitable — needs range semantics, and so do hotel nights and rental windows.

---

## 3. The finding that changed the design

**This is your best story. Lead with it if they ask about performance.**

**Q: Is the constraint enough on its own?**

For correctness, yes. For throughput, emphatically no — and I only know that because I
measured it.

Strategy F in my lab is a bare `INSERT` with no prior read and no lock, relying entirely on
the exclusion constraint. At 1,000 concurrent requests for one seat:

| | Result |
|---|---|
| Oversold | **0** — perfectly correct |
| Deadlocks (SQLSTATE 40P01) | **609 of 1,000** |
| p99 latency | **30,008ms** (the statement timeout) |
| Throughput | **9.6 req/s** |

Wait-event sampling showed 98% of active backends in `Lock:transactionid`.

**Mechanism.** A GiST exclusion constraint does not use speculative insertion the way a unique
index does. It inserts the row, *then* scans for conflicts, waiting on any conflicting
transaction still in progress. With many simultaneous inserters on one key they wait on each
other, the wait graph develops cycles, and the deadlock detector starts killing transactions.

**Fix.** Give contention an orderly place to queue *before* it reaches the constraint: take a
row lock on the resource first, in sorted order.

| | Deadlocks | p99 | req/s |
|---|---:|---:|---:|
| Constraint alone | 609 | 30,008ms | 9.6 |
| Row lock, then constraint | **0** | **186ms** | **575** |

Same correctness, 86× the throughput. This changed the production code — it is step 4 of
`services/inventory-engine/src/engine/reserve.js`, with the measurement in the comment.

**The framing that matters:** the row lock is a *throughput* optimisation. The constraint
remains the authority. If a future code path forgets the lock, the system gets slow, not
wrong. That separation is the whole architecture.

---

## 4. How correctness is proven

**Q: How do you know it never oversells? How do you test concurrency?**

Three layers, and the distinction between them matters.

**1. The Contention Lab** (`npm run lab`) runs nine strategies against nine scenarios and
then **queries the database** to count how many customers hold the same resource-span.
Response codes are never evidence: a system can return success to two callers while writing
one row.

Result at 1,000 users for 1 seat, seed 42:

| Strategy | Sold | Extra | p99 | req/s |
|---|---:|---:|---:|---:|
| A — naive read-check-write | 1 unit, **64 rows** | **63** | 623ms | 1,007 |
| B — pessimistic row lock | 1 | 0 | 96ms | 944 |
| D — optimistic CAS | 1 | 0 | 281ms | 2,012 |
| E — Redis lock + constraint | 1 | 0 | 10.6ms | 11,364 |
| F — constraint alone | 1 | 0 | 30,008ms | 9.6 |
| F2 — row lock + constraint | 1 | 0 | 186ms | 575 |

**2. Integration tests** against the real engine and real PostgreSQL: 100 concurrent requests
for 1 seat produce exactly 1 allocation and 99 conflicts; 1,000 requests for 10 seats produce
exactly 10.

**3. Invariant views** that every test, the reconciliation worker and the scoreboard share, so
a benchmark cannot pass using a weaker check than reconciliation uses.

**Total: 40 integration tests, all passing** against PostgreSQL 16 and Redis 7.

**Q: What did the naive strategy actually do?**

Sold one seat to 64 customers. The SQL shows why:

```sql
SELECT status FROM resource_state WHERE id = $1;    -- everyone reads 'AVAILABLE'
UPDATE resource_state SET status='HELD' WHERE id=$1; -- no status predicate
```

Under `READ COMMITTED`, a blocked `UPDATE` re-evaluates its `WHERE` against the newly
committed row. The predicate matches on identity only, so every waiter still matches and
proceeds. This is exactly the shape of real code that checks availability in the application
and then writes `WHERE id = $1`.

**Q: Did you get anything wrong?**

Yes, and I wrote the predictions down beforehand specifically so I could not pretend
otherwise (`docs/benchmarks/HYPOTHESES.md`).

- **My benchmark was broken first.** The naive strategy initially reported *zero* oversells
  and looked safe. Strategies connected lazily, and connection setup staggered the requests
  so virtual user 1 finished before user 40 had a socket — nothing ever raced. I added warm
  connections and a starting barrier. A benchmark that fails to create the condition it claims
  to test is worse than none: it produces a confident, false clean bill of health.
- **H4 was wrong by ~1000×.** I predicted Redis would be *slower* than the constraint alone.
  It was 11,364 req/s versus 9.6.
- **H2 was directionally backwards.** I predicted pessimistic locking would be the slow one.
  It was among the fastest; the slow one was the design I had chosen for production.

---

## 5. Redis, and what a distributed lock is for

**Q: Why isn't Redis the source of truth?**

Because Redis cannot make a durability guarantee strong enough to protect money, and because
I have the measurement showing it leaking.

In the strategy E run, the Redis lock let a **second request through to the database**, and
the exclusion constraint rejected it with SQLSTATE 23P01. One occurrence in 1,000 requests.

Had Redis been the only line of defence, that run would have oversold.

**Q: So is the Redis lock useless?**

No — and this is the nuance most candidates miss in both directions. It was the *fastest*
strategy tested, by three orders of magnitude, because it rejects 999 of 1,000 requests before
PostgreSQL is touched at all. A losing request costs one Redis round trip instead of a
`BEGIN`, a blocking `SELECT`, a `ROLLBACK` and possibly a deadlock.

The correct conclusion is that these are two independent roles:

- a distributed lock is an excellent **load filter**
- a distributed lock is an illegitimate **source of truth**

Tessera uses it only for the first.

**Q: What happens if Redis dies?**

Reservations keep working, because nothing on the allocation path depends on Redis. Rate
limiting degrades to a conservative in-process limiter — failing *closed*, not open, since
Redis being down correlates with the system being under stress. Waiting-room admission pauses,
but already-admitted users keep working because their tokens are signed and verified
statelessly. Cached availability falls through to the database.

---

## 6. Time, TTLs, and expiry

**Q: How does reservation expiration work? Who enforces the TTL?**

The database, at the moment it matters.

The subtlety: an exclusion constraint cannot read a clock, so an expired hold still occupies
its span as far as the constraint is concerned. So `reserve` reaps expired holds **for exactly
the resources it is about to touch**, inside its own transaction, before inserting. Scoped
deliberately — a global expiry scan on the hot path would make every reservation pay for the
whole table.

That makes the background sweeper a *freshness* optimisation rather than a correctness
dependency. If it dies, nobody is wrongly denied a seat; browsing users just see stale
availability for longer. Knowing which of your background jobs are load-bearing is the point.

**Q: How do multiple workers avoid processing the same hold? Why SKIP LOCKED?**

```sql
SELECT id FROM holds
 WHERE state = 'ACTIVE' AND expires_at <= now()
 ORDER BY expires_at
   FOR UPDATE SKIP LOCKED
 LIMIT $1
```

Each worker locks a disjoint set and steps over rows another worker holds. N replicas do N
times the work with no leader election, no distributed lock and no coordination. All work is
in one transaction, so a crash rolls back and the rows become claimable the instant the
connection drops.

This replaced a leader election using a session-level `pg_try_advisory_lock` taken through a
connection pool — which had two bugs: the unlock could land on a different pooled connection
and leak the lock, and a single leader was both a bottleneck and a single point of failure.

**Q: Can an expired hold be confirmed?**

No, and not because it is checked first — because the check and the write are one statement:

```sql
UPDATE allocations SET state = 'CONFIRMED'
 WHERE hold_id = $1 AND state = 'HELD' AND expires_at > now()
```

If the TTL elapsed a microsecond ago, zero rows update and the transaction aborts. There is no
window between checking expiry and acting on it, because there is no separate check. The row
count is then compared against the hold's item count, so a partial confirmation aborts too.

---

## 7. Messaging

**Q: Why a transactional outbox?**

Because a service must both change its data and tell the world, and doing them as two
operations has no correct ordering:

```
COMMIT; publish()   → crash between them loses the event forever
publish(); COMMIT   → rollback leaves a lie on the bus
```

The event is inserted as a row in the same transaction as the business change, so it commits
or vanishes with it. A relay moves committed rows to Kafka afterwards. This trades "instant
publish" for "never lost" — a subscriber seeing an event 100ms late is invisible; a confirmed
booking that never emitted its event is a support ticket.

**Q: What happens if Kafka dies?**

Nothing breaks. Rows stay `PENDING` and the relay catches up when the broker returns. That is
the entire point of the pattern, not a happy accident.

**Q: What if the relay crashes after publishing but before marking the row published?**

The event is published twice. That is accepted and designed for — it is why consumer dedupe is
mandatory rather than optional. The failpoint `outbox.after_publish_before_mark` reproduces it
deterministically.

**Q: How do you handle duplicate events? Does Kafka give exactly-once?**

**No.** Kafka's "exactly-once semantics" covers Kafka-to-Kafka stream processing with
transactional offsets. The moment a handler writes to PostgreSQL or calls a payment provider,
that guarantee does not reach the side effect.

What this system actually uses:

> at-least-once delivery **+** idempotent consumer **=** effectively-once business effect

The dedupe row is written in the **same transaction** as the business effect. Either both
commit or neither does, so a redelivery after a crash finds the marker and skips. That
co-location is what makes it airtight rather than merely likely.

**Q: What about out-of-order events?**

Ordering is only guaranteed within a partition, and retries, rebalances and relay races can
still reorder. Every event carries a monotonic `aggregate_seq`, and projections discard
anything not newer than what they have applied.

A subtle one worth mentioning: several relay replicas using `SKIP LOCKED` could publish event
#2 before event #1. The claim query therefore takes only the head-of-line pending event per
aggregate — parallel across aggregates, strictly sequential within one.

**Q: How do you choose partition keys?**

By what must not reorder. `reservation.events` is keyed by reservation id because saga steps
must stay in order. `inventory.events` is keyed by *event* id — keying by resource would
scatter one train's availability updates across partitions and make the read model
inconsistent. Topics are created explicitly with set partition counts; auto-creation is off,
because an auto-created topic gets one partition and silently caps consumer parallelism at one
forever.

---

## 8. The saga

**Q: Why a saga and not a distributed transaction?**

Two-phase commit across inventory, payment and reservation would need all three services plus
the network healthy for the entire duration of a human entering card details, and would hold
locks throughout. The saga accepts temporary inconsistency and guarantees convergence.

**Q: What makes your saga durable?**

The saga's position is **a row**, not a stack frame. A worker claims a due saga under a lease,
runs exactly one step, commits, and releases. Kill the process at any instant and another
worker resumes from the last committed state.

One step per claim, deliberately: the crash window is one step wide instead of one saga wide,
and a slow payment provider parks a single saga rather than occupying a worker for the whole
booking flow.

The state machine is enforced by a database trigger, so an illegal transition is impossible
even from a hand-run `UPDATE` during an incident.

```
CREATED → HOLD_PENDING → HOLD_CREATED → PAYMENT_PENDING
        → PAYMENT_AUTHORIZED → CONFIRM_PENDING → CONFIRMED

hold fails      → HOLD_FAILED → COMPENSATED
payment fails   → PAYMENT_FAILED → RELEASE_PENDING → RELEASED → COMPENSATED
payment unknown → PAYMENT_UNKNOWN → (ask the provider) → AUTHORIZED | FAILED
confirm fails   → REFUND_PENDING → COMPENSATED
anything murky  → MANUAL_REVIEW
```

*Tested:* a saga abandoned mid-flight is completed by another worker; two workers racing the
same saga do not double-allocate.

**Q: What happens if payment succeeds but confirmation fails?**

The customer has paid and the seat is gone — the worst realistic case. The saga moves to
`REFUND_PENDING` and refunds with an idempotency key derived from the saga step. If the refund
outcome is itself unclear, it goes to `MANUAL_REVIEW` rather than retrying: a duplicate refund
is a real loss and much harder to reverse than an inconsistency.

*Tested:* "a hold that expired after payment triggers a refund, never a silent loss."

---

## 9. Payments — the answer that separates candidates

**Q: What happens if the payment provider times out?**

This is the question worth being ready for.

Most systems model two outcomes: success and failure. Reality has a third:

```
Tessera → provider        request sent
                          provider charges the customer
          ← × timeout
Tessera                   ...knows nothing
```

The money may have moved. Treating it as failure leaves a charged customer with no booking.
Treating it as success books a seat that may never be paid for. Retrying may charge twice.

**The only correct response is to admit ignorance.** The payment moves to `UNKNOWN`, and a
resolver **asks the provider** what happened, using our own idempotency key as the reference.
The saga waits rather than guessing. `UNKNOWN` is a first-class state in the schema with its
own transitions, and the only ways out are the provider's own answer.

*Tested:* a provider timeout becomes `UNKNOWN`, not `FAILED`; resolution asks the provider and
confirms the booking; **the customer is charged exactly once.**

To test this I wrote a fake provider that injects failures a real sandbox cannot: charge-then-
timeout, duplicate webhook, capture-before-authorise, 500-after-capture.

**Q: How do you stop a webhook being forged or replayed?**

- HMAC signature over `timestamp.body`, compared in constant time (a plain `===` leaks how much
  of the signature matched)
- the timestamp is inside the signed payload, so a captured webhook cannot be replayed outside
  a five-minute window
- every webhook is recorded by the provider's event id before being acted on, so a duplicate
  delivery finds its row and stops

**The bug this replaced:** a bad client signature used to mark the payment `FAILED` — a
terminal state — so the genuine webhook arriving afterwards was rejected as an invalid
transition. Money taken, no booking, triggerable by anyone with the order id. Now signature
failures land in their own table and change nothing.

---

## 10. Load, fairness, hot inventory

**Q: How is a waiting room different from rate limiting?**

They solve different problems, which is why both exist.

Rate limiting asks *"is this one client asking too often?"* It is per-identity fairness. It
cannot save you from a flash sale: 100,000 users each making one perfectly reasonable request
violates no rate limit by anyone, and still melts the database.

The waiting room asks *"how many people may be inside the system at all?"* It is macro
admission control, bounding total concurrency regardless of how politely each user behaves.

**Q: How do you keep the waiting room correct across instances?**

With five gateways admitting users, the obvious implementation — read the active count,
compare to the cap, admit — is a read-then-write race that admits five times the cap. Every
decision is a single Lua script, which Redis executes atomically.

*Tested:* five instances calling `admit()` simultaneously against a cap of ten admit exactly
ten, with no session admitted twice.

**Q: Why is a token bucket better than a fixed window?**

A fixed window lets a client spend its whole quota in the last millisecond of one window and
again in the first of the next — twice the intended rate at the boundary. A token bucket
refills continuously and bounds the burst by capacity.

The previous implementation also had a subtle cruelty: it added the request to the window
*before* checking the limit, so a throttled client extended its own throttling by retrying —
exactly when it is most likely to retry. A denied request now consumes nothing. *Tested.*

**Q: How do you handle hot inventory?**

In order of measured impact:

1. Remove the aggregate counter from the write path. The old design updated one per-schedule
   row and recounted every seat on every reserve — all traffic for one train serialised on one
   row. Availability is now a projection built from events.
2. Orderly queueing on the resource row (§3), worth 86× on single-resource contention.
3. `SKIP LOCKED` for "any available seat" allocation, so nobody queues.
4. Bucket-sharded pools for quantity inventory, splitting one hot counter into N.
5. Per-event admission bulkheads.

*Honesty note:* items 1 and 5 are implemented but **not yet benchmarked**. Item 1 is
hypothesis H6 and is explicitly marked NOT YET TESTED. Do not quote a number for them.

**Q: How do you protect the database from connection exhaustion?**

- bounded pool with `connectionTimeoutMillis`, so a caller fails fast rather than queueing
  behind an unbounded backlog
- `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` set per
  connection at creation
- **no network I/O inside a database transaction** — no payment call, no Kafka publish, no HTTP
  request. A transaction that waits on an external system holds row locks for the duration of
  that system's worst day
- event-loop lag as the saturation signal for shedding

---

## 11. Reconciliation

**Q: How do you find inconsistencies you didn't anticipate?**

Eight cross-service checks: confirmed-without-payment, payment-without-booking, expired hold
still allocated, booking without allocation, duplicate booking, orphan payment, stuck saga,
ledger drift, outbox backlog.

Two design rules make it usable rather than noise:

1. **Grace windows.** No snapshot across databases is atomic, so a reservation confirmed a
   moment ago legitimately has no booking row yet. Every check ignores anything younger than
   its window, and an issue must be seen in more than one pass before being acted on. Without
   this, reconciliation reports in-flight state continuously, everyone learns to ignore it, and
   it fails exactly when something real happens.
2. **Money is never repaired automatically.** An automated refund loop that misfires during an
   incident is worse than the inconsistency it was fixing, because it is much harder to
   reverse. Financial issues get a recommendation and wait for a human. *This is an explicit
   test:* "money issues are never repaired automatically."

**Q: What is the ledger for?**

Every inventory movement appends an immutable entry with a signed delta. Folding the ledger
must reproduce current state; if it disagrees, something changed inventory without recording
it. That turns the audit trail from a table nobody reads into a continuously checked invariant.

This caught a real bug in my own schema: the fold had no opening balance, so every allocated
resource reported drift. Resource creation now records `CAPACITY_ADDED` — the same rule as
double-entry bookkeeping, where you cannot audit movements without an opening balance.

The ledger is append-only by trigger: `UPDATE` and `DELETE` are blocked for every role,
including the owner. During testing this fired on my own test suite trying to clear the repair
log between tests — the system correctly refusing to let its history be erased, by anyone.

---

## 12. Scaling

**Q: How do you scale horizontally?**

The reservation service is stateless; correctness lives in the database, so adding instances
cannot break it. Workers claim work with `SKIP LOCKED` and leases, so they scale by running
more of them — no leader, no coordination.

*Honesty note:* the 1/3/5-instance scaling runs are **designed but not yet executed**. I can
describe the mechanism and show that the tests pass with concurrent workers on one saga; I
cannot yet show a scaling curve.

**Q: What would you change at 10× traffic?**

Read replicas for search and availability (primary only for allocation — a stale replica must
never decide an allocation), PgBouncer in transaction mode, partition `allocations` by event,
and actually run the hot-inventory benchmarks to find where it bends.

**Q: At 100×?**

Shard by event id — the natural boundary, since allocations never span events. The exclusion
constraint is per-resource and therefore shards cleanly. At that point the waiting room stops
being a nicety and becomes the primary defence, and I would want the read model on a dedicated
store rather than sharing PostgreSQL.

**Q: What are the consistency guarantees?**

- **Strong** for inventory allocation: serialisable with respect to overlapping claims,
  enforced by the constraint
- **Effectively-once** for event side effects: at-least-once delivery plus idempotent consumers
- **Eventually consistent** for search and availability projections, with `as_of` exposed so
  staleness is visible rather than pretended away
- **Convergent** for cross-service workflows, via the saga

---

## 13. What is and is not built

State this without being prompted. Volunteering your gaps is what makes the rest
credible.

| Area | Status |
|---|---|
| Inventory engine, saga, payments (UNKNOWN), reconciliation, admission control | **Built, 40 integration tests** |
| Eight HTTP services, gateway with RBAC, React console | **Built, 31 end-to-end checks** |
| Transactional outbox → Kafka, idempotent consumers, DLQ + replay, versioned events | **Built; survived a real multi-hour broker outage (931 events, none lost)** |
| Search: Kafka-fed projection, Elasticsearch with PostgreSQL fallback, L1/L2 cache | **Built** |
| Server-side pricing (distance × demand tier) | **Built** |
| Prometheus metrics, Grafana dashboard, OpenTelemetry tracing | **Built** (dashboard provisioned; tracing on when Jaeger runs) |
| Contention Lab (9 strategies), chaos script (Kafka / Redis / payment) | **Built, results recorded** |
| k6 flash-sale script | **Written, results not yet recorded** |
| Kubernetes manifests | **Production-shaped, not run on a cluster** |
| Horizontal scaling | **Correctness verified with two saga workers; no scaling curve** |
| Schema Registry / Avro | **Deliberately not built** — JSON Schema + upcasters instead |

All measurements come from one laptop with PostgreSQL in Docker. They characterise
*relative* behaviour between strategies, not production capacity.

## 14. Questions to ask them

Good questions signal seniority better than good answers.

- "How do you currently detect a booking that was paid for but never issued — is it automated
  or does a customer tell you?"
- "When your payment provider times out, what does your system assume?"
- "Which of your background jobs are load-bearing for correctness, versus freshness?"
- "Do your load tests assert on database state afterwards, or on response codes?"

---

## 15. The three things to have ready

If you remember nothing else:

1. **"One seat was sold to 64 customers, and here is the exact SQL that caused it."** The
   read-check-write race, and why the `UPDATE` predicate matters under `READ COMMITTED`.
2. **"My own design was 86× too slow and the benchmark told me."** 609 deadlocks, the GiST
   insert-then-scan mechanism, and the row-lock fix — plus the fact that I predicted the wrong
   answer and published the prediction.
3. **"The Redis lock leaked once in a thousand and the constraint caught it."** Defence in
   depth demonstrated rather than asserted, and the reason a distributed lock is a load filter
   and not a source of truth.
