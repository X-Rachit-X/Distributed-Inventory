# Tessera

**A distributed reservation and inventory platform engineered to keep inventory correct under
extreme concurrent demand.**

A *tessera* was the Roman admission token: a physical object guaranteeing exactly one entry,
impossible to duplicate. Holding that guarantee under ten thousand simultaneous requests is the
entire system.

Railway ticketing is the demonstration domain. The engine underneath is generic: railway seats,
hotel rooms, concert tickets, appointments and rental units are all the same shape.

---

## The problem

> How do you allocate scarce inventory to a very large number of concurrent users without ever
> overselling — while payments time out, processes die, networks partition, and messages arrive
> twice or out of order?

Everything in this repository is in service of that sentence.

---

## The central decision

Every kind of inventory is modelled as one thing: a **resource occupied over an interval**.

| Domain | Resource | Span |
|---|---|---|
| Railway | seat | range of station stops — `[3,7)` |
| Hotel | room | range of nights — `[0,3)` |
| Concert / appointment | seat / slot | `[0,1)` |

Which makes "never oversell" one line of SQL:

```sql
ALTER TABLE allocations
  ADD CONSTRAINT allocations_no_overlap
  EXCLUDE USING gist (resource_id WITH =, span WITH &&)
  WHERE (state IN ('HELD','CONFIRMED','BLOCKED'));
```

**Overselling is not prevented by application code being careful. It is prevented by the
database refusing to store the row.** Every layer above — caches, Redis locks, queues, retries —
is an optimisation for throughput and user experience. A bug in any of them costs latency, not a
double-booked seat.

---

## What makes this more than an architecture diagram

The project's claims are measured, not asserted. The Contention Lab runs nine concurrency
strategies against the same workload and then **counts rows in the database** — never HTTP
responses, because a system can return success to two callers while writing one row.

**1,000 users competing for 1 seat, seed 42:**

| Strategy | Units sold | Extra | p99 | req/s |
|---|---:|---:|---:|---:|
| A — naive read-check-write | 1 | **63** | 623ms | 1,007 |
| B — pessimistic row lock | 1 | 0 | 96ms | 944 |
| E — Redis lock + constraint | 1 | 0 | 10.6ms | 11,364 |
| F — constraint alone | 1 | 0 | 30,008ms | 9.6 |
| **F2 — row lock + constraint** | **1** | **0** | **186ms** | **575** |

*Extra* = customers sold a unit that was already sold.

Three findings came out of running it, and each changed the code:

- **The benchmark was lying first.** The naive strategy initially reported zero oversells.
  Connections were established lazily, so setup staggered the requests and nothing raced. With
  warm connections and a starting barrier it sells one seat to **64 customers**.
- **The production design was 86× too slow.** Relying on the exclusion constraint alone produced
  **609 deadlocks** and a 30-second p99. A GiST exclusion constraint inserts *then* scans for
  conflicts, so concurrent inserters wait on each other and the wait graph cycles. A sorted row
  lock in front fixed it: 0 deadlocks, 186ms p99.
- **The Redis lock leaked once in a thousand** — and the constraint caught it. Defence in depth,
  demonstrated rather than claimed.

Full results: [`docs/benchmarks/RESULTS.md`](docs/benchmarks/RESULTS.md). Predictions were
committed before the first run in [`docs/benchmarks/HYPOTHESES.md`](docs/benchmarks/HYPOTHESES.md);
two were wrong and are reported as wrong.

---

## Quick start

```bash
npm install
npm run up                 # PostgreSQL 16, Redis 7, Kafka (KRaft), Elasticsearch
npm run migrate            # plain-SQL migrations, checksummed

npm test                   # 40 integration tests against real infrastructure

npm run lab -- list                                        # scenarios and strategies
npm run lab -- run --scenario 1000u-1r --strategy all      # the headline comparison
npm run lab -- ablation --scenario 1000u-1r                # with vs without the constraint
```

The lab writes artifacts to `bench/results/lab/`, each carrying its seed, git commit and a
dirty-working-tree flag.

---

## How correctness is held

| Mechanism | What it guarantees | Where |
|---|---|---|
| GiST exclusion constraint | No two live allocations of a resource overlap | `sql/migrations/010` |
| State-machine triggers | Illegal transitions are impossible, including from a hand-run `UPDATE` | `011` |
| Append-only ledger | Folding movements reproduces state, or a defect is reported | `011`, `014` |
| Lazy in-transaction expiry | The TTL is authoritative at the moment it matters | `engine/reserve.js` |
| Claim-first idempotency | Two concurrent retries cannot both execute | `shared/idempotency` |
| Transactional outbox | An event cannot exist without its change, or vice versa | `shared/outbox` |
| Consumer dedupe in the same transaction | At-least-once delivery becomes effectively-once effect | `shared/consumer` |
| Durable saga | Progress survives process death | `reservation/src/saga` |
| `UNKNOWN` payment state | A provider timeout is investigated, never assumed | `payment/src/service` |
| Reconciliation | Cross-service disagreement is found and reported | `reconciliation/src` |

Invariant views (`invariant_summary`) are shared by the tests, the benchmarks, the
reconciliation worker and the scoreboard — so a benchmark cannot pass using a weaker check than
reconciliation uses.

---

## Layout

```
packages/shared/        idempotency, outbox, consumer dedupe, failpoints, admission control
services/
  inventory-engine/     the authority: allocations, holds, ledger, expiry
  reservation/          reservations, bookings, durable saga orchestrator
  payment/              payment state machine incl. UNKNOWN, fault-injecting provider
  reconciliation/       cross-service checks, conservative repair, scoreboard
  gateway/ identity/ catalog/ discovery/ notification/
lab/                    Contention Lab: strategies, scenarios, runner, CLI
bench/results/          benchmark artifacts
deploy/compose/         PostgreSQL, Redis, Kafka (KRaft), Elasticsearch, observability
docs/                   architecture, benchmarks, interview reference
```

---

## Documentation

- **[Interview reference](docs/PROJECT_INTERVIEW.md)** — every defensible question, with the
  code, test or measurement behind each answer, and an explicit list of what is *not* built
- **[`tessera-deep-dive.html`](tessera-deep-dive.html)** — the same material as a study page
- **[Benchmark results](docs/benchmarks/RESULTS.md)** · **[Hypotheses](docs/benchmarks/HYPOTHESES.md)**
- **[Master plan](docs/plan/MASTER_PLAN.md)** — the full roadmap and its phase gates

---

## Status

Built and tested: inventory engine, durable saga, payment state machine, reconciliation,
admission control, Contention Lab — **40 integration tests passing** against PostgreSQL 16 and
Redis 7.

Not yet built: OpenTelemetry tracing, Grafana dashboards, k6 HTTP benchmarks, the chaos suite,
Kubernetes manifests, and multi-instance scaling measurements. The interview reference lists
these explicitly rather than leaving them implied.

All measurements come from one laptop with PostgreSQL in Docker. They characterise relative
behaviour between strategies; they are not production capacity figures.
