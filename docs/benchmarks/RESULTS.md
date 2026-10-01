# Contention Lab — measured results

> 📍 **Reading path, step 5** (with [CHALLENGES.md](../CHALLENGES.md)). The numbers here are the only benchmark numbers used anywhere in the docs. New here? Start at the [docs home](../README.md).

Generated from `bench/results/lab/`. Every figure below came from a run on this machine.
Nothing here is estimated, rounded for effect, or carried over from another project.

**Environment.** Windows 11, 16 logical cores, PostgreSQL 16 in Docker Desktop, client and
database on the same host, seed 42, commit `7397a85`. Numbers characterise *relative*
behaviour between strategies. They are not production capacity figures and must not be
quoted as any — a single laptop with a containerised database is not a deployment.

**How correctness is judged.** After traffic stops, the runner queries stored rows and counts
how many customers hold the same resource-span. Response codes are never used as evidence: a
system can return success to two callers while writing one row, or fail a caller after
writing theirs.

---

## 1. Headline: 1,000 users, 1 seat

| Strategy | Rows written | Units sold | **Extra** | Conflicts | Errors | p50 | p99 | req/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A — naive read-check-write | 64 | 1 | **63** | 936 | 0 | 13.6ms | 623ms | 1,007 |
| B — pessimistic row lock | 1 | 1 | 0 | 999 | 0 | 64.0ms | 96ms | 944 |
| C — SKIP LOCKED | 1 | 1 | 0 | 999 | 0 | 28.2ms | 56ms | 2,123 |
| D — optimistic CAS | 1 | 1 | 0 | 999 | 0 | 22.4ms | 281ms | 2,012 |
| E — Redis lock + constraint | 1 | 1 | 0 | 999 | 0 | 3.6ms | 10.6ms | 11,364 |
| F — exclusion constraint alone | 1 | 1 | 0 | 308 | **609** | 814ms | 30,008ms | 9.6 |
| F2 — row-lock queue + constraint | 1 | 1 | 0 | 999 | 0 | 103ms | 186ms | 575 |
| H — constraint + admission bulkhead | 1 | 1 | 0 | 968 | 31 | 0.04ms | 4,232ms | 165 |

*Extra* = customers sold a unit that was already sold. It is the only column that decides
safe from unsafe.

---

## 2. The naive strategy oversells (H1 — **CONFIRMED**)

64 rows, one seat. Sixty-three people were sold something someone else already had.

The mechanism is not subtle once the SQL is read:

```sql
SELECT status FROM resource_state WHERE id = $1;      -- every caller sees 'AVAILABLE'
-- ...application decides it may proceed...
UPDATE resource_state SET status = 'HELD' WHERE id = $1;   -- no status predicate
```

Under `READ COMMITTED`, an `UPDATE` that blocks on a row lock re-evaluates its `WHERE`
clause against the newly committed row. Because the predicate matches on identity only, every
waiter still matches and proceeds. This is exactly the shape of real code that checks
availability in the application and then writes `WHERE id = $1`.

Sixty-four is the concurrency setting, not a coincidence: every simultaneously connected
caller won.

### Why the first attempt at this test was wrong

The first version of the harness reported **zero oversells for the naive strategy**, and the
strategy looked safe. It was not. Strategies connected to the database lazily inside each
request, and connection establishment took long enough that virtual user 1 finished its whole
transaction before user 40 had a socket. The requests were serialised by connection setup, so
nothing ever raced.

The fix was warm connections plus a starting barrier: every worker connects and completes a
round trip first, then all are released together. This is recorded because a benchmark that
fails to create the condition it claims to test is worse than no benchmark — it produces a
confident, false clean bill of health.

---

## 3. The constraint alone is correct but collapses (the most important finding)

Strategy F — a bare `INSERT`, no prior read, no lock, relying entirely on the exclusion
constraint — **never oversold**. It also managed 9.6 requests per second, with 609 of 1,000
requests dying on SQLSTATE `40P01`, deadlock detected, and p99 pinned at the 30-second
statement timeout.

Wait-event sampling during the run:

```
Lock:transactionid    98% of active samples
```

**Mechanism.** A GiST exclusion constraint does not use speculative insertion the way a unique
index does. It inserts the row, then scans for conflicts, and waits on any conflicting
transaction still in progress. With many simultaneous inserters on one key they wait on each
other, the wait graph develops cycles, and the deadlock detector begins aborting transactions.

**Fix.** Give contention an orderly place to queue *before* it reaches the constraint. Strategy
F2 takes a row lock on the resource first — sorted, so multi-resource requests cannot form
cycles either — and then inserts.

| | Deadlocks | p99 | req/s |
|---|---:|---:|---:|
| F — constraint alone | 609 | 30,008ms | 9.6 |
| F2 — row lock, then constraint | **0** | **186ms** | **575** |

Same correctness, 86× the throughput. **This finding changed the production code**: the row
lock is now step 4 of `services/inventory-engine/src/engine/reserve.js`.

The row lock is a throughput optimisation. The constraint remains the authority. If a future
code path forgets the lock or takes it on the wrong row, the system gets slow — not wrong.

---

## 4. Redis was far faster than predicted (H4 — **REFUTED**)

The pre-registered prediction was: *"I expect E to be SLOWER than F on this single-machine
setup... This is the prediction I most expect to be wrong."*

It was wrong, and by a wide margin: **11,364 req/s versus 9.6**, p99 10.6ms versus 30 seconds.

The reason is not that Redis is a better lock. It is that Redis rejects 999 of 1,000 requests
*before they touch PostgreSQL at all*. A losing request costs one Redis round trip (~3.6ms)
instead of a `BEGIN`, a blocking `SELECT`, a `ROLLBACK`, and possibly a deadlock. Strategy B,
which is well-behaved, still pays three database round trips per loser and lands at ~1,000
req/s. The gain is about **work avoided**, not about lock quality.

### The result that matters more: the constraint caught what Redis let through

Strategy E's run recorded **one `23P01`** — an exclusion-constraint violation. The Redis lock
allowed a second request through to the database (a lock released after the winner committed,
before that commit was visible to the next acquirer), and the constraint refused it.

Had Redis been the only line of defence, that run would have oversold.

This is the whole architectural argument, produced by measurement rather than assertion: a
distributed lock is a legitimate and very effective **load filter**, and an illegitimate
**source of truth**. The two roles are independent, and this project uses it only for the
first.

---

## 5. The other hypotheses

| | Prediction | Observed | Verdict |
|---|---|---|---|
| **H2** | B correct but p99 ≥ 5× F's | B correct; p99 96ms vs F2's 186ms — B was *better*, because it avoids the constraint's conflict scan entirely on the losing path | **REFUTED as stated** |
| **H3** | D correct, highest retries, higher throughput than B | Correct, 2,012 req/s vs B's 944. p99 281ms — 3× B's, from retry backoff | **PARTLY CONFIRMED** |
| **H5** | C beats B for "any available resource" | 2,123 vs 944 req/s, p99 56ms vs 96ms, identical correctness | **CONFIRMED** (see caveat) |
| **H8** | H lowers p99 vs F, at the cost of shed requests | Sheds aggressively — p50 0.04ms because most requests are refused instantly — but p99 4,232ms for admitted ones | **INCONCLUSIVE** |
| **H1** | Naive oversells | 63 extra claims | **CONFIRMED** |
| **H4** | Redis slower than the constraint alone | ~1,000× faster | **REFUTED** |
| **H6** | Removing the aggregate counter is the biggest hot-inventory win | — | **NOT YET TESTED** |
| **H7** | Sorted acquisition eliminates deadlocks | Integration test: 40 concurrent opposite-order two-resource requests, 0 deadlocks | **CONFIRMED (test, not benchmark)** |

**H2, honestly.** The prediction assumed pessimistic locking would be the slow one. It is not:
`SELECT ... FOR UPDATE` on a single row is a clean FIFO queue, and a loser discovers the seat
is gone in one short transaction. The genuinely slow path was the one I had chosen for
production. The prediction was directionally backwards.

**H5 caveat.** Strategy C answers a different question. It allocates *any* free resource and
cannot honour a request for a specific seat, because it steps over locked rows rather than
waiting. The comparison is fair for auto-allocation workloads only; C is not a drop-in
replacement for B or F2.

**H8 caveat.** The bulkhead's shed-versus-admitted split is not yet separated in the p99
figure, so the number mixes both populations. The scenario needs a saturation sweep before
anything can be concluded.

---

## 6. What this says about the architecture

1. **Overselling is prevented by the database, not by application care.** Strategy A had
   perfectly reasonable-looking application logic and sold one seat 64 times. Strategy F had
   no application logic at all and sold it once.

2. **Correctness and throughput are separate problems, and conflating them is the trap.**
   F is maximally correct and unusably slow. The answer was not to weaken the constraint but
   to add an orderly queue in front of it.

3. **Defence in depth is worth having because the outer layers do fail.** E's single `23P01`
   is direct evidence: the Redis lock leaked, and nothing bad happened.

4. **Conflicts are not errors.** Every safe strategy reports ~999 conflicts at 1,000-to-1
   contention. That is the system working. A load-test report that buries conflicts in an
   error rate would show a 99.9% failure rate for a correctly functioning system.

---

## 7. Reproducing

```bash
npm run up                                              # PostgreSQL, Redis, Kafka
npm run migrate inventory
npm run lab -- run --scenario 1000u-1r --strategy all --seed 42
npm run lab -- ablation --scenario 1000u-1r             # with vs without the constraint
node --test services/inventory-engine/test/integration/reserve.test.js
```

Raw artifacts, including per-request latency samples and wait-event distributions, are in
`bench/results/lab/`. Each carries its seed, git commit, and a dirty-working-tree flag.

---

## 8. Not yet measured

Stated so the gaps are not mistaken for results:

- 10,000-user scenarios (the harness supports them; they have not been run)
- the hot-event scenario and H6's counter-versus-projection comparison
- horizontal scaling across 1, 3 and 5 service instances
- everything above measures the engine directly; HTTP-level benchmarks through the gateway,
  where connection-pool pressure becomes visible, are not built yet
- chaos scenarios: Kafka outage, Redis outage, worker crash mid-commit
