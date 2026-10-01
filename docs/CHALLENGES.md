# Challenges, and how they were solved

> 📍 **Reading path, step 5** (with [benchmarks/RESULTS.md](benchmarks/RESULTS.md)): why the design looks the way it does. New here? Start at the [docs home](README.md).

Every item here happened while building Tessera. Each is written in
Situation → Task → Action → Result form so it can be used directly for
behavioural questions.

## Technical challenges

### 1. My benchmark reported a broken strategy as safe
- **Situation.** The naive read-check-write strategy reported zero oversells.
- **Cause.** Each virtual user opened its database connection lazily. Connection
  setup staggered them so much that user 1 finished before user 40 connected —
  nothing actually ran concurrently.
- **Action.** Warm, dedicated connections per virtual user and a starting barrier
  that releases them together.
- **Result.** The naive strategy sold one seat to **64 customers**. Lesson: a test
  that fails to create the condition it claims to test gives false confidence.

### 2. The production design was correct but 86× too slow
- **Situation.** Relying on the exclusion constraint alone, 1,000 requests for one
  seat gave **609 deadlocks**, a 30 s p99, 9.6 req/s. Nothing oversold.
- **Cause.** A GiST exclusion constraint inserts and then scans for conflicts,
  waiting on in-progress inserters; those waits formed cycles.
- **Action.** Queue on the resource row first (sorted `SELECT … FOR UPDATE`), keep
  the constraint as the authority.
- **Result.** 0 deadlocks, 186 ms p99, 575 req/s. Run side by side with the
  constraint-alone strategy (876 deadlocks, 6.7 req/s in that run), that is 86× the
  throughput; against the first run's 9.6 req/s it is 60×. My pre-registered prediction was
  wrong and the write-up says so.

### 3. The Redis lock was 1,000× faster than predicted — and leaked
- **Situation.** I predicted a Redis lock would be slower; it did 11,364 req/s.
- **Finding.** It also let a second request through once in 1,000; the database
  constraint rejected it (23P01).
- **Result.** A distributed lock is a load filter, not a source of truth. Both
  facts are in the results.

### 4. The ledger reported drift on correct data
- **Cause.** No opening balance: a seat created and then held folded to −1.
- **Action.** Record `CAPACITY_ADDED` on creation; make the drift view start from
  resources so unaccounted inventory is visible instead of excluded by a join.

### 5. A direct `CONFIRMED` insert was allowed
- Found by probing my own schema. Allocations can now be created only as HELD or
  BLOCKED; confirmation must pass through a hold (and therefore payment).

### 6. A saga race found by accident
- **Situation.** Duplicate service processes produced
  "illegal saga transition HOLD_FAILED → HOLD_CREATED".
- **Cause.** Every transition released the saga's lease — including the one that
  marks a step as started, before the slow call. A second worker took it mid-step.
- **Action.** Keep the lease across a step; make every transition a
  compare-and-swap on the expected state.
- **Result.** 31/31 end-to-end checks with **two** reservation workers on one
  database, zero illegal transitions.

### 7. Sagas stuck one step short of done
- `RELEASED` was treated as terminal by the claim query but the state machine
  expected `RELEASED → COMPENSATED`. Also, the hold-failed path never settled the
  reservation, so customers would see "in progress" forever. Both fixed; both found
  by tests that asserted the final state.

### 8. The outbox backlog while Kafka was unreachable
- The Kafka image failed to download (TLS timeouts) for a long stretch. 931 events
  accumulated as PENDING. When Kafka came up they were all published — 659/165/107
  messages matching the outbox exactly, zero dead-lettered. The pattern did what
  it is for, under a real outage rather than a simulated one.

### 9. A healthcheck that lied
- Kafka reported unhealthy while running: the probe used `localhost:29092`, but that
  listener binds to the container's hostname address. Probing the `0.0.0.0` listener
  fixed it.

### 10. A poison work queue
- Discovery's refresh queue took the oldest dirty rows first. Rows for deleted test
  events failed with 404 forever and starved every real refresh — a database version
  of a poison message stalling a partition. Fix: 404 means "remove", failures go to
  the back of the queue with an attempt count, and are dropped after five.

### 11. Search fell back permanently after one timeout
- The first query hit a cold Elasticsearch, timed out, and marked it unhealthy with
  no way back. Added a circuit breaker: retry after 10 s. Also switched fuzzy
  matching to word similarity (`kanpr` vs "Kanpur Central": 0.24 → 0.67).

### 12. The pool's timeouts were not guaranteed on the first query
- `SET statement_timeout` ran from a connect listener without being awaited, so the
  caller's first query could overlap it (pg warned "query while already executing").
  Moved the timeouts to connection startup options.

### 13. Latent bugs caught before they ran
- A DLQ wrapper that called `this.handle` on a plain function; a consumer reader
  version that would have dead-lettered every non-upcastable event; an
  `id = $1 OR external_ref = $1` lookup that PostgreSQL types as UUID and would throw
  on external references. All found by reading code when wiring it up.

### 14. Security issues in the original system
- A bad client signature marked a payment FAILED, so the genuine webhook was then
  rejected — money taken, no booking, triggerable by anyone. Fixed: signature
  failures change nothing.
- The client sent the price. Now prices are quoted server-side and stored on the
  hold.

### 15. Environment friction
- Windows: no `pkill`, background processes holding the shell's output pipe, a log
  path where `\$name` escaped the dollar sign so every service wrote to one file named
  `.logs$name.log`. Rewrote the start script around PowerShell `Start-Process` with
  forward-slash paths. Other projects occupied ports 9090/3000/16686; Tessera uses
  9091/3002/16687.

## Behavioural questions — ready answers

**Tell me about a time you were wrong.**
Challenge 2/3. I wrote predictions down before running the benchmark. Two were
wrong: I thought pessimistic locking would be slow and Redis would be slower still.
The design I had chosen for production was the slow one. I changed it and published
the wrong predictions next to the results.

**Tell me about a bug that was hard to find.**
Challenge 6. The symptom was an "illegal transition" error that only appeared with
two workers. The cause was a lease released at the wrong moment. I reproduced it
deliberately with two workers and then kept that as a test condition.

**Tell me about a time your testing misled you.**
Challenge 1. The benchmark said the unsafe strategy was safe. I didn't trust a
result that contradicted the mechanism, found the harness wasn't creating
concurrency, and fixed the harness before believing any number.

**How do you handle ambiguity / an under-specified requirement?**
The brief listed ~90 requirements. I wrote a phased plan with exit gates, ordered by
correctness first, and marked anything I couldn't build properly as designed-but-not-
built rather than faking it (Kubernetes, Schema Registry, scaling curves).

**Describe a trade-off you made.**
Saga instead of two-phase commit: temporary inconsistency in exchange for not holding
locks across a human entering card details — then reconciliation to catch what the
saga misses. Or: one Docker image for eight services (a few MB bigger, but identical
dependency versions everywhere).

**Tell me about a failure in production-like conditions.**
Challenge 8: a real multi-hour broker outage during development. Nothing was lost;
931 events published on recovery.

**When did you push back on something?**
Reconciliation: auto-repair would be easy for money issues too. I refused — an
automated refund loop that misfires is harder to undo than the inconsistency.

**How do you prioritise?**
Correctness → consistency → failure recovery → observability → performance → scale.
The inventory engine and its proof came before the frontend.

**What would you do differently?**
Build the concurrency harness first and validate it against a known-broken strategy
before measuring anything else; run the load test through the gateway earlier; keep
test data in a separate database so it can't leak into the running system (challenge
10).

**How do you make sure your work is correct?**
Constraints in the database, invariants that the tests, the benchmark and
reconciliation all share, and assertions on stored rows rather than on responses.
