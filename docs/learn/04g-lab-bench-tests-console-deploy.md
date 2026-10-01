# 04g · File by file — Lab, bench, tests, console, deploy, scripts

> 📍 **Reference page:** look things up here, no need to read it top to bottom. Reading path: [01](01-level1-big-picture.md) → [02](02-level2-how-it-works.md) → [code](../README.md#step-3-read-the-code-in-the-order-a-booking-flows) → [03](03-level3-deep-dive.md) → [05](05-failure-scenarios.md) → [06](06-resume-and-interview.md) · [Docs home](../README.md) · [File map](04-file-map.md)

## Part 1 — `lab/`: the Contention Lab (where the numbers come from)

**Why it exists.** Saying "this prevents overselling" is worth little without
showing the overselling it prevents. The lab races many concurrency strategies
against the same scenario and then **counts rows in the database** to judge them.

```
lab/src/
├── strategies/index.js   A, A0, B, C, D, E, F, F2, G, G0, H, each with the same contract
├── scenarios.js          users × resources shapes, seeded plan generator
├── runner.js             warm connections, starting barrier, wait-event sampling, VERIFY
└── cli/lab.js            npm run lab -- run | ablation | list; writes JSON artifacts
```

### `strategies/index.js`

Contract: `reserve(ctx, req) → { outcome: 'SUCCESS' | 'CONFLICT' | 'ERROR', retries, sqlstate?, detail? }`.
`classify(err)` maps SQLSTATEs: 23P01 / 23505 / 23514 (constraint rejected),
55P03 (lock not available) and 40001 (serialization) → CONFLICT; **40P01
deadlock → ERROR**; 57014 (timeout) → TIMEOUT; anything else → ERROR. CONFLICT and ERROR are kept separate because "999 failed
requests look fine if you only count successes".

⚠️ The comment at the top tells the lab's most important bug story: strategies first
opened connections lazily, so connection setup **serialised** the virtual users,
nothing raced, and the naive strategy looked safe. Fix: each virtual user gets a
**pre-connected client** (`ctx.client`), plus a starting barrier.

| Id | Strategy | Table | The idea in code |
|---|---|---|---|
| **A** | naive read-check-write | unsafe | `BEGIN; SELECT status` → if AVAILABLE, *(2 ms window)* → `UPDATE … WHERE id` (**no status predicate**) → insert → `COMMIT`. Under READ COMMITTED a blocked UPDATE re-checks only `id`, so every waiter proceeds |
| A0 | same, 0 ms delay | unsafe | shows the race isn't manufactured by the delay |
| **B** | pessimistic `SELECT … FOR UPDATE` | unsafe | correct; losers wait holding a connection |
| **C** | `FOR UPDATE SKIP LOCKED LIMIT 1` "any free seat" | unsafe | right for auto-allocation, wrong for picking a specific seat (it would silently give you a different one) |
| **D** | optimistic CAS on `version`, up to 3 attempts | unsafe | wasted work grows with contention |
| **E** | Redis `SET key token NX PX 5000` + insert into the guarded table + release via a Lua "delete only if the token is mine" | guarded | Redis as a **load filter**, the constraint as the authority |
| **F** | one bare `INSERT` into the guarded table | guarded | constraint alone |
| **F2** | `BEGIN; SELECT 1 FROM resource_state … FOR UPDATE; INSERT; COMMIT` | guarded | the **production path** (row-lock queue + constraint) |
| G / G0 | bucketed pool with / without the capacity predicate + CHECK | pool | hot-counter sharding; G0 is the control |
| H | F behind an in-process semaphore of 32 (excess → shed) | guarded | bulkhead / load shedding |

`DEFAULT_SET = A, B, C, D, E, F, F2, H`.

### `scenarios.js`

`10u-1r`, `100u-1r`, **`1000u-1r`**, `10000u-1r` (single-seat race); `1000u-10r`,
`10000u-100r` (flash sale); `1000u-1000r` (abundant control); `500u-1r-segments`
(random overlapping spans on one seat: conflicts that aren't identical rows);
`hot-event` (90% of demand on 1 of 10 events). Each scenario declares
`expectedSuccesses` up front. More successes means overselling, fewer means lost
inventory. `buildPlan` uses a seeded PRNG, so runs are reproducible.

### `runner.js`

1. Register the run in `lab.runs` (seed, git commit, dirty flag, environment).
2. `#seed` the lab tables for this `run_id`.
3. `#execute`: N workers, each **connects and does a round trip first**, then all
   await **one barrier promise**, which is released once everyone is connected.
   Then they fire.
4. While running, sample `pg_stat_activity` wait events (that is how "98%
   `Lock:transactionid`" was observed for strategy F) using a **separate admin
   pool**, so instrumentation doesn't perturb the workload.
5. `#verify`: from **stored rows**, count distinct `(resource, span)` claims vs total
   rows; `extra = Σ(claim_count − 1)` from the oversell views; for unguarded tables
   also count **overlapping** spans (needed for segment scenarios). For pools:
   `Σ max(taken − capacity, 0)`.
6. Summarise latencies (p50/p99), throughput, conflicts and errors. A run that
   oversold where it shouldn't is marked **INVALID** and its speed isn't reported ("a
   fast system that oversold is not a fast system").

### `cli/lab.js`

`run --scenario X --strategy all|A|…`, `ablation` (the same naive logic **with and
without** the DB guard, to show which layer catches which bug), `list`. Prints a
coloured table and writes JSON artifacts to `bench/results/lab/<scenario>-<ts>-<commit>.json`.

---

## Part 2 — `bench/`

| File | What |
|---|---|
| `src/seed.js` | deterministic data from a **mulberry32 PRNG** (seed 42): real station codes (NDLS, CNB, ALD… HWH), train names (Howrah Rajdhani…), classes 1A/2A/3A/SL with prices and coach sizes; per train×day: an `inventory_events` row (`span_max = stops − 1`, metadata with train number/name), `span_points`, coaches, seats with grid positions, a meal pool with buckets, and **`recordCapacity`** (the ledger opening balance). `npm run seed` = 3 trains × 2 days × 8 stops |
| `src/e2e.js` | **31 live checks** through the gateway: services reachable; booking reaches CONFIRMED with a reference; the seat is CONFIRMED in the DB; idempotent replay (marked `replayed`, only one allocation); concurrent customers on one seat → exactly one wins and everyone gets an answer; a declined payment doesn't confirm, the seat is released and can be resold; a provider timeout → **charged exactly once**; overlapping segment refused, disjoint segment allowed; block a free seat, a blocked seat can't be sold, a sold seat can't be blocked; unauthenticated internal call → 401; forged webhook → 400; another customer's reservation → 404; every invariant = 0 |
| `k6/flash-sale.js` | 200 VUs, one iteration each, racing for a few seats through the full HTTP stack; counters for accepted / conflict / rate-limited / server errors; threshold `server_errors < 5`; **teardown fails the run if any invariant is violated**. Written but not yet run (stated honestly in the README) |
| `results/lab/*.json` | raw artifacts behind `docs/benchmarks/RESULTS.md` |

---

## Part 3 — Tests (`npm test`, 40 total)

`node --test --test-concurrency=1` over four files:

| File | Count | Highlights |
|---|---|---|
| `services/inventory-engine/test/integration/reserve.test.js` | 10 | 100→1, 1000→10, segments, all-or-nothing, no deadlock, expiry, idempotent confirm, release, cancel, ledger fold |
| `services/reservation/test/integration/saga.test.js` | 12 | happy path, decline, UNKNOWN, resolution, crash recovery, **two racing workers**, refund after expiry, webhook replay/forgery/expired timestamp |
| `services/reconciliation/test/reconciliation.test.js` | 8 | each detector fires on injected corruption; money never auto-repaired; confirm twice before repairing |
| `packages/shared/test/admission.test.js` | 10 | token bucket and waiting room incl. 5 concurrent instances |

They run against **real Postgres and Redis**, not mocks. Each test seeds its own
isolated event, so tests don't interfere, and assertions are made by **counting
rows**.

---

## Part 4 — `apps/console/` (React UI)

Stack: React 18 + Vite + Tailwind + Zustand + React Router. `vite.config.js`
proxies `/api` to the gateway on :4000.

| File | What |
|---|---|
| `src/api.js` | `request()` adds the bearer token and idempotency key and throws `ApiError` with `isConflict` (409, "offer another seat"), `isRateLimited` (429, honour `Retry-After`) and `isOverloaded` (503). `newIdempotencyKey()` is generated **once per booking attempt** and reused for its retries |
| `src/store.js` | Zustand auth store (token, customerId, email, role) persisted to `localStorage`. The comment notes production would use an HttpOnly cookie |
| `src/App.jsx` | routes + nav; `RequireAuth` remembers where you were headed |
| `pages/Login.jsx` | email login (`ops@tessera.dev` → operator) |
| `pages/Search.jsx` | discovery search; shows backend (ES/PG), cache layer and data age |
| `pages/Trains.jsx` | departures list (`/api/events`) |
| `pages/SeatMap.jsx` | pick from/to stops (`span-points`), load the seat map for that span, book with an idempotency key, navigate to the progress page |
| `pages/Reservation.jsx` | **polls every 400 ms until `settled`**; shows the steps "Securing seats → Taking payment → Issuing booking". The comment notes it exists *because* the flow is asynchronous |
| `pages/MyBookings.jsx` | list, cancel, notifications inbox |
| `pages/Correctness.jsx` | invariant scoreboard, refreshed every 5 s |
| `pages/Operations.jsx` | (operator) reconciliation scoreboard and issues (resolve/ignore), run a pass, block/unblock a seat, **switch the payment provider failure mode** |

---

## Part 5 — `deploy/`

| File | What |
|---|---|
| `compose/docker-compose.yml` | profiles: **core** = Postgres 16 (with `pg_stat_statements`, `max_connections=200`, `log_lock_waits`, `deadlock_timeout=200ms`), Redis 7 (AOF, `noeviction`), Kafka 7.7 in **KRaft** mode (no ZooKeeper, auto-create topics **off**), a `kafka-init` job, Elasticsearch 8 single-node; **obs** = Prometheus :9091, Grafana :3002, Jaeger :16687, Kafka UI :8080; **app** = all services from one image; **lab** = Toxiproxy (network fault injection) |
| `compose/init/postgres/01-databases.sql` | creates the 6 databases, extensions per DB (`btree_gist`, `pgcrypto`, `pg_trgm`, `pg_stat_statements`), and the `tessera_readonly` role with SELECT on inventory/reservation/payment (for reconciliation). The comment: why separate *databases* not schemas ("you have to write a saga") |
| `compose/init/kafka/create-topics.sh` | idempotent topic creation: `*.events` with 6 partitions (3 for less busy ones), `*.dlq` with 30-day retention, replication 1 (laptop; 3 in a real cluster) |
| `prometheus/prometheus.yml` | scrapes all 8 services' `/metrics` |
| `grafana/…` | datasource + the "correctness and flow" dashboard |
| `k8s/base/*.yaml` | per service: Deployment (rolling update, maxUnavailable 0, non-root, **read-only root FS**, no privilege escalation, requests/limits) + Service; **readiness → `/ready`, liveness → `/health`** ("never dependencies: a DB outage must not become a restart loop"); `hpa.yaml` (gateway 2-10, reservation 3-12 on CPU 70%); `pdb.yaml` (min available); `migrate-job.yaml` (runs `migrate-cli.js`; the advisory lock handles concurrent runs); `configmap.yaml`, `secret.example.yaml`, `namespace.yaml`, `kustomization.yaml`; `overlays/local` |

`Dockerfile`: two stages. `deps` runs `npm ci --omit=dev` for all workspaces; the
runtime image is `node:22-alpine` with `ARG SERVICE` → `SERVICE_ENTRY`, `USER node`,
and `CMD node $SERVICE_ENTRY`. **One image for all eight services.**

> ⚠️ Honest scope (from README): the K8s manifests are production-shaped but have
> **not** been run on a cluster.

---

## Part 6 — `scripts/`

| Script | What |
|---|---|
| `start.sh` | stops anything running, starts the 8 services with `nohup` (or PowerShell `Start-Process` on Windows), logs to `.logs/<name>.log`, then polls ports 4000-4007 for health. The comment records a Windows path-escaping bug |
| `stop.sh` | kills them (PowerShell on Windows, since Git Bash has no `pkill`) |
| `chaos.sh kafka` | stop Kafka → book → show the booking still progresses and the **outbox grows** → start Kafka → the outbox drains to 0 |
| `chaos.sh redis` | stop Redis → book (still works) → show `x-ratelimit-mode: degraded` → start Redis |
| `chaos.sh payment` | as operator, set provider mode `timeout_after_success` → book → print status every second (UNKNOWN → resolved) → reset mode |

---

## Part 7 — Root files

| File | What |
|---|---|
| `package.json` | npm **workspaces** (`packages/*`, `services/*`, `lab`, `bench`, `apps/console`) and every `npm run` script (`up`, `migrate`, `seed`, `start`, `test`, `e2e`, `lab`, `chaos`, `console`) |
| `.env.example` | every variable: 6 DB URLs, Kafka/Redis/ES, service URLs, dev secrets, provider mode, waiting room flag, OTEL endpoint, `FAILPOINTS_ENABLED=true` (dev only) |
| `CLAUDE.md` | context for AI coding sessions: rules, layout, commands |
| `README.md` | overview, headline numbers, quick start |

Next: [05 · Failure scenarios →](05-failure-scenarios.md)
