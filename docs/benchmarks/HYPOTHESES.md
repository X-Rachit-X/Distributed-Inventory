# Pre-registered hypotheses

**Written before the first benchmark run.** Committed in advance so the results report can
record predicted-versus-observed honestly, including the predictions that turn out wrong.

Pre-registration matters because it is very easy, after seeing a number, to construct an
explanation for why it was expected. Writing the prediction down first removes that option.
"Which optimisation failed?" is a question worth being able to answer with evidence rather
than a story assembled afterwards.

Environment for all runs: one Windows 11 laptop, 16 logical cores, PostgreSQL 16 in Docker
Desktop, single broker, client and database on the same machine. These measure *relative*
behaviour between strategies. They are not production capacity figures and will not be
presented as any.

---

## H1 — The naive strategy oversells

Read-check-write against a table with no exclusion constraint will allocate the same
resource to more than one customer whenever concurrency exceeds one.

**Prediction:** at 1,000 users → 1 seat, strictly more than 1 successful claim. Expect
somewhere in the range of 2–30 duplicate claims, depending on how many requests land inside
the check-to-write window.

**Why it matters:** this is the control. Without a demonstrated failure, "we prevent
overselling" is an unfalsifiable claim.

---

## H2 — Pessimistic locking is correct but queues

`SELECT ... FOR UPDATE` will produce exactly one successful claim, with no oversell. Its p99
will degrade sharply as users-per-resource rises, because every loser waits on the row while
holding a database connection.

**Prediction:** at 1,000 users → 1 seat, p99 for strategy B is at least 5× p99 for strategy
F. Wait-event sampling shows the majority of active backends in `Lock:transactionid`.

**Risk to the prediction:** if each transaction is short enough, the queue may drain fast
enough that the difference is small. I expect a visible gap, not necessarily a dramatic one.

---

## H3 — Optimistic CAS wastes work under contention

CAS will be correct but will perform the most wasted work at high contention: every loser
executes a read and a failed conditional write, then retries.

**Prediction:** strategy D shows the highest `totalRetries` of any safe strategy at
1,000 users → 1 seat, and its throughput is *higher* than B's despite doing more work,
because it never blocks. At 1,000 users → 1,000 resources (near-zero contention) D should be
among the fastest.

---

## H4 — The Redis lock may not pay for itself

Strategy E adds a network round trip and a second system that can fail, in exchange for
rejecting doomed requests before they reach the database.

**Prediction: I expect E to be SLOWER than F on this single-machine setup**, because the
database is local and uncontended for connections, so filtering load in front of it buys
little while the extra round trip costs on every request. I expect its advantage, if any, to
appear only when the database is the scarce resource — many application instances against a
connection-limited database.

**This is the prediction I most expect to be wrong**, and it is the one worth reporting
either way. Many well-regarded open-source implementations of this problem put a Redis lock
on the critical path; if the measurement shows it helping here, that is a finding, and if it
shows it costing, that is a more interesting one.

---

## H5 — SKIP LOCKED wins for "any available resource"

For auto-allocation, `FOR UPDATE SKIP LOCKED` should outperform blocking locks, because
nobody waits: a locked row is stepped over rather than queued behind.

**Prediction:** at 1,000 users → 10 resources, strategy C has higher throughput and lower p99
than strategy B, with identical correctness (exactly 10 sold).

**Caveat already known:** C answers a different question than B and F. It cannot honour a
specific seat request. The comparison is only fair for auto-allocation workloads and the
report must say so rather than present C as a drop-in winner.

---

## H6 — Removing the aggregate counter is the largest hot-inventory win

The previous version of this system updated a single per-schedule counter row on every
reserve, confirm and release, and recounted every seat in the schedule. That serialises all
traffic for one train onto one row.

**Prediction:** the v2 design, which derives availability from a projection instead of a
counter on the write path, sustains meaningfully higher throughput on the `hot-event`
scenario than a variant with the counter restored. I expect this single change to matter
more than bucket sharding, Redis filtering, or admission control.

**Status: NOT YET TESTED.** This needs a counter-restored variant built specifically to
measure it. Until that exists, this hypothesis is unverified and must not be quoted as a
result.

---

## H7 — Deterministic ordering eliminates deadlocks

Multi-resource reservations that sort resources before acquiring will show zero deadlocks.
The same workload with deliberately reversed ordering will show non-zero
`pg_stat_database.deadlocks`.

**Prediction:** sorted = 0 deadlocks; adversarial ordering = at least 1 at 200 concurrent
two-resource requests.

**Status: NOT YET TESTED.** Requires the multi-resource scenario.

---

## H8 — Admission control improves goodput past saturation

Beyond some concurrency, accepting more work reduces useful throughput. Bounding in-flight
requests and shedding the excess should keep p99 for *admitted* requests flat while
throughput stays level rather than collapsing.

**Prediction:** at 10,000 users → 100 resources, strategy H shows lower p99 than F for
admitted requests, at the cost of a non-zero shed count. Whether total successful allocations
differ should be zero — shedding must not lose inventory.

---

## How these are scored

Each run writes `bench/results/lab/<scenario>-<timestamp>-<commit>.json` containing the seed,
environment, per-strategy outcomes and the database-verified oversell count.
`docs/benchmarks/RESULTS.md` is generated from those artifacts and records, for each
hypothesis: **predicted / observed / verdict**, where the verdict is one of CONFIRMED,
REFUTED, or INCONCLUSIVE.

A run whose invariant check fails is marked INVALID and its latency and throughput figures
are excluded. A system that oversold is not a system whose performance is interesting.
