# 04 · File map — every file in one table

> **Reading path:** [01 Big picture](01-level1-big-picture.md) → [02 How it works](02-level2-how-it-works.md) → [code](../README.md#step-3-read-the-code-in-the-order-a-booking-flows) → [03 Deep dive](03-level3-deep-dive.md) → [05 Failures](05-failure-scenarios.md) → [06 Interview](06-resume-and-interview.md).
> This page is **reference**: use it to find a file, then follow the "Line by line" link
> for the detailed walkthrough of that area.

What every file in the repository does. Generated dependencies (`node_modules`,
`package-lock.json`) and benchmark artifacts are omitted.

## Root

| File | What it does |
|---|---|
| `README.md` | Project overview, headline results, quick start |
| `CLAUDE.md` | Context file for AI coding sessions: rules, layout, commands |
| `package.json` | npm workspaces root and every `npm run` command |
| `.env.example` | Every configuration variable with development defaults |
| `Dockerfile` | One image for all backend services; `SERVICE` build arg picks the entry point; includes `bench/` so a deployment can seed |
| `.github/workflows/images.yml` | Builds and publishes the service and edge images to ghcr.io (manual run or `v*` tag) |
| `.dockerignore`, `.gitignore` | What stays out of images and git |

## `packages/shared` — correctness primitives used by every service

Line by line: [04a-shared-package.md](04a-shared-package.md)

| File | What it does |
|---|---|
| `sql/000_correctness_primitives.sql` | Outbox, idempotency keys, processed events, projection offsets, consumer attempts, dead letters, audit log — applied to every service database |
| `sql/001_append_only.sql` | Trigger function that blocks UPDATE/DELETE on history tables |
| `src/config/env.js` | `.env` loader required first by every service, the seed and the e2e runner (real environment variables win) |
| `src/config/index.js` | `str`, `num` (validated), `flag`, `secret` (refuses dev secrets in production): the one config helper every service uses |
| `src/config/kafka.js` | Optional Kafka TLS/SASL from `KAFKA_SSL` / `KAFKA_SASL_*`, for managed Kafka; used by the relay and the consumer runner |
| `src/db/pool.js` | PostgreSQL pool with statement/lock/idle-in-transaction timeouts as startup options; `withTransaction()` |
| `src/db/migrate.js` | Checksummed, advisory-locked plain-SQL migration runner |
| `src/db/migrate-cli.js` | `npm run migrate`: applies shared + per-service migrations to each database |
| `src/errors/index.js` | Error taxonomy (409 conflict vs 5xx fault), PostgreSQL SQLSTATE classification |
| `src/idempotency/index.js` | Claim-first idempotency: atomic claim, stored response replay, key-reuse detection |
| `src/outbox/writer.js` | Appends a validated event to the outbox inside the caller's transaction; per-aggregate sequence |
| `src/outbox/relay.js` | Publishes committed outbox rows to Kafka: leases, head-of-line ordering per aggregate, jittered backoff, dead-lettering |
| `src/consumer/index.js` | Idempotent handler (dedupe in the effect's transaction), out-of-order guard, DLQ wrapper, replay |
| `src/consumer/runner.js` | Starts a Kafka consumer group with DLQ, upcasting and a consumer-lag metric |
| `src/events/envelope.js` | Standard event envelope and Kafka headers |
| `src/events/registry.js` | JSON-Schema validation (Ajv) and version upcasting |
| `src/events/schemas.js` | Every event contract, including `booking.confirmed` v1→v2 |
| `src/failpoints/index.js` | Named, deterministic crash/throw/delay injection for chaos tests |
| `src/http/client.js` | `httpRequest()` with a deadline covering the whole exchange and a distinct `UPSTREAM_TIMEOUT` error; `isHealthy()` for readiness probes |
| `src/http/server.js` | Service shell: correlation ids, liveness vs readiness, metrics, error mapping, graceful shutdown |
| `src/admission/token-bucket.js` | Atomic token-bucket rate limiter in one Lua script, local fallback when Redis is down |
| `src/admission/waiting-room.js` | Virtual waiting room: FIFO tickets, atomic admission, signed admission tokens |
| `src/pricing/index.js` | The fare rules (distance share × demand tier), shared by pricing and search |
| `src/observability/metrics.js` | Prometheus metrics: conflicts vs errors, oversell-prevented, outbox, sagas, payments, invariants |
| `src/observability/logger.js` | Structured JSON logs with request/correlation/trace ids via AsyncLocalStorage |
| `src/observability/tracing.js` | OpenTelemetry auto-instrumentation, exported to Jaeger when configured |
| `src/util/backoff.js` | Full-jitter exponential backoff and a retry helper |
| `test/admission.test.js` | Token bucket and waiting room tests, including five instances admitting concurrently and the wait estimate |

## `services/inventory-engine` — the authority

Line by line: [04b-inventory-engine.md](04b-inventory-engine.md)

| File | What it does |
|---|---|
| `sql/migrations/010_inventory_core.sql` | Events, stops, coaches, seats, holds, **allocations with the exclusion constraint**, pools |
| `sql/migrations/010a_fresh_install_trigger_order.sql` | Fix: lets a fresh database migrate (011 and the shared 001 both created the audit trigger) |
| `sql/migrations/011_ledger_and_guards.sql` | Append-only ledger, state-machine triggers, invariant views |
| `sql/migrations/012_tighten_insert_guard.sql` | Fix: allocations can no longer be created directly as CONFIRMED |
| `sql/migrations/013_lab_schema.sql` | Isolated Contention Lab tables, including the unguarded control group |
| `sql/migrations/014_ledger_baseline.sql` | Fix: opening balance for the ledger; drift view driven from resources |
| `src/index.js` | HTTP service: internal reserve/confirm/release/cancel, public availability reads, admin block/unblock, invariants endpoint, workers |
| `src/config/index.js` | Validated configuration (via the shared helper) |
| `src/engine/reserve.js` | **The hot path**: sorted row locks, lazy expiry, hold + allocations, pools, ledger, outbox in one transaction |
| `src/engine/confirm.js` | Confirm (expiry checked in the same UPDATE), release, cancel booking |
| `src/engine/availability.js` | Availability per class, per seat, per stop pair; adjacent-seat search |
| `src/engine/admin.js` | Block/unblock with the held/sold refusal policy, audit log |
| `src/engine/ledger.js` | Ledger appends, opening balance, fold check |
| `src/workers/expiry.worker.js` | Expiry sweeper using `SKIP LOCKED`; no leader |
| `test/helpers.js` | Test fixtures: seed an event, concurrent-fire with a starting barrier, scoped invariants |
| `test/integration/reserve.test.js` | 10 tests: 100→1, 1000→10, segments, all-or-nothing, deadlock-free, expiry, idempotent confirm, ledger fold |

## `services/reservation` — booking API and saga

Line by line: [04c-reservation-saga.md](04c-reservation-saga.md)

| File | What it does |
|---|---|
| `sql/migrations/010_reservation_core.sql` | Reservations, items, bookings, sagas (trigger-enforced state machine), saga steps |
| `sql/migrations/011_remove_timed_out.sql` | Removes the unreachable TIMED_OUT saga state from the CHECK and the trigger |
| `src/index.js` | `POST /v1/reservations` (server-side pricing, idempotent, returns 202), status, list, cancel |
| `src/saga/orchestrator.js` | Durable saga: one step per claim, CAS transitions, leases, timeouts, compensation, UNKNOWN handling |
| `src/clients/index.js` | HTTP clients for inventory, payment (timeouts flagged indeterminate; lookup by idempotency key) and pricing; in-process clients for tests |
| `src/workers/saga.worker.js` | Polling loop that drives the orchestrator; releases leases on shutdown |
| `src/config/index.js` | Timeouts, fairness limits, service URLs |
| `test/integration/saga.test.js` | 18 tests: happy path, decline, UNKNOWN resolution, crash recovery, concurrent workers, refund, webhooks, plus the review fixes (CREATED replay, lost response, already-settled payment, abandoned charges, re-run on deadline) |

## `services/payment`

Line by line: [04d-payment.md](04d-payment.md)

| File | What it does |
|---|---|
| `sql/migrations/010_payment_core.sql` | Payments with UNKNOWN state, refunds (≤ captured), provider events (replay protection), signature failures |
| `src/index.js` | Raw-body webhook route, internal charge/resolve/refund, operator endpoints |
| `src/service/payment.service.js` | Charge (row committed before the provider call), idempotent resolution (also for abandoned CREATED rows), webhooks, refunds, guarded transitions that write their event in the same transaction |
| `src/providers/fake.provider.js` | Fault-injecting provider: decline, charge-then-timeout, 500-after-capture, duplicate and out-of-order webhooks |
| `src/workers/resolver.worker.js` | Resolves UNKNOWN payments by asking the provider |
| `src/config/index.js` | Configuration; refuses dev secrets in production |

## `services/gateway`

Line by line: [04e-gateway-pricing.md](04e-gateway-pricing.md)

| File | What it does |
|---|---|
| `src/index.js` | Load shedding, rate limiting, auth, RBAC, waiting room, proxy routes for every public endpoint |
| `src/auth.js` | HS256 JWT sign/verify with constant-time comparison |
| `src/config/index.js` | Upstream URLs, secrets, limits, operator emails (production refuses the public default `ops@tessera.dev`) |

## `services/pricing`

Line by line: [04e-gateway-pricing.md](04e-gateway-pricing.md#part-2--pricing-port-4007)

| File | What it does |
|---|---|
| `src/index.js` | `POST /v1/quote` — prices items from live inventory; single-flight cached reads |

## `services/discovery` — search read model

Line by line: [04f-discovery-notification-reconciliation.md](04f-discovery-notification-reconciliation.md)

| File | What it does |
|---|---|
| `sql/migrations/010_projection.sql` | Trips, stops (trigram index), per-segment availability and fare, dirty queue |
| `sql/migrations/011_dirty_attempts.sql` | Fix: poison handling for the refresh queue |
| `sql/migrations/012_dirty_lease.sql` | Lease column, so no transaction is held open across a refresh's HTTP calls |
| `src/index.js` | Search API with L1/L2 cache and single-flight; Kafka consumer marking trains dirty |
| `src/projection.js` | Refresher: re-reads inventory, rewrites the projection and ES index; coalesced; resync |
| `src/search-index.js` | Elasticsearch index and query with circuit breaker; PostgreSQL fallback search |

## `services/notification`

Line by line: [04f-discovery-notification-reconciliation.md](04f-discovery-notification-reconciliation.md#part-2--notification-port-4005-exactly-one-email)

| File | What it does |
|---|---|
| `sql/migrations/010_notifications.sql` | Notifications, unique per source event and template |
| `src/index.js` | Kafka consumer of `booking.events` (reads v2), exactly-once effect, inbox, DLQ list and replay |

## `services/reconciliation`

Line by line: [04f-discovery-notification-reconciliation.md](04f-discovery-notification-reconciliation.md#part-3--reconciliation-port-4004-the-auditor)

| File | What it does |
|---|---|
| `sql/migrations/010_reconciliation.sql` | Runs, issues, append-only repair log, scoreboard |
| `sql/migrations/011_allocation_without_booking.sql` | Adds the ALLOCATION_WITHOUT_BOOKING issue kind |
| `src/checks/index.js` | The eleven cross-service checks, each with a grace window and a money flag |
| `src/worker.js` | Runs checks, confirms across passes, repairs only safe inventory issues, records everything |
| `src/index.js` | Scoreboard, issues, manual resolve/ignore/retry with reasons |
| `test/reconciliation.test.js` | 11 tests: each detector fires on injected corruption; money is never auto-repaired |

## `lab` — Contention Lab

Line by line: [04g-lab-bench-tests-console-deploy.md](04g-lab-bench-tests-console-deploy.md)

| File | What it does |
|---|---|
| `src/strategies/index.js` | Nine strategies: naive, row lock, SKIP LOCKED, CAS, Redis lock, constraint alone, row lock + constraint, bucketed pool, bulkhead |
| `src/scenarios.js` | Users × resources scenarios and a seeded plan generator |
| `src/runner.js` | Warm connections, starting barrier, wait-event sampling, verification against stored rows |
| `src/cli/lab.js` | `npm run lab` — run, ablation, list; writes artifacts |

## `bench`

Line by line: [04g-lab-bench-tests-console-deploy.md](04g-lab-bench-tests-console-deploy.md#part-2--bench)

| File | What it does |
|---|---|
| `src/seed.js` | Deterministic railway inventory (trains, stops with times, coaches, seats, meal pool, opening ledger balance) |
| `src/e2e.js` | 39 end-to-end checks against the live stack, including cancellation and search |
| `src/smoke.js` | Deployment smoke test through the public URL only: book, confirm, cancel |
| `k6/flash-sale.js` | k6 flash-sale load test through the gateway; passes only if invariants hold |
| `results/lab/*.json` | Raw Contention Lab artifacts with seed, commit, environment |

## `apps/console` — React console

Line by line: [04g-lab-bench-tests-console-deploy.md](04g-lab-bench-tests-console-deploy.md#part-4--appsconsole-react-ui)

| File | What it does |
|---|---|
| `src/api.js` | Gateway client; typed errors for 409/429/503 |
| `src/store.js` | Auth state (token, role) |
| `src/App.jsx` | Routes and navigation |
| `src/pages/Search.jsx` | Search with backend/cache/age shown |
| `src/pages/Trains.jsx` | Departures list |
| `src/pages/SeatMap.jsx` | Journey-aware seat map and booking |
| `src/pages/Reservation.jsx` | Live saga progress |
| `src/pages/MyBookings.jsx` | Bookings, cancel, notifications |
| `src/pages/Correctness.jsx` | Invariant scoreboard |
| `src/pages/Operations.jsx` | Operator actions: issues, block seats, provider failure modes |
| `src/pages/Login.jsx` | Demo sign-in |
| `index.html`, `main.jsx`, `index.css`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js` | Build and styling |

## `deploy`

Line by line: [04g-lab-bench-tests-console-deploy.md](04g-lab-bench-tests-console-deploy.md#part-5--deploy)

| File | What it does |
|---|---|
| `compose/docker-compose.yml` | Profiles: `core` (Postgres, Redis, Kafka, ES), `obs` (Prometheus, Grafana, Jaeger, Kafka UI), `app` (all services), `lab` (Toxiproxy) |
| `compose/docker-compose.prod.yml`, `compose/prod.env.example` | Single-server production stack: only the edge is published, required secrets, migrate-first |
| `edge/Caddyfile`, `edge/Dockerfile` | Edge image: console build + Caddy (TLS, `/api` proxy, SPA fallback) |
| `compose/init/postgres/01-databases.sql` | Creates the six databases, extensions, read-only role |
| `compose/init/kafka/create-topics.sh` | Creates 13 topics with explicit partitions |
| `prometheus/prometheus.yml` | Scrapes all eight services |
| `grafana/provisioning/*`, `grafana/dashboards/tessera.json` | Datasource and the correctness-and-flow dashboard |
| `k8s/base/*`, `k8s/overlays/{local,production}/*`, `k8s/infra/*`, `k8s/README.md` | Kubernetes manifests: app base with edge + ingress, local and production overlays, learning-cluster data services (schema-validated, not run on a cluster) |

How to use all of this: [08 · Deployment](08-deployment.md).

## `scripts`

Line by line: [04g-lab-bench-tests-console-deploy.md](04g-lab-bench-tests-console-deploy.md#part-6--scripts)

| File | What it does |
|---|---|
| `start.sh` | Starts all services detached with per-service logs, waits for health |
| `stop.sh` | Stops them (PowerShell on Windows) |
| `chaos.sh` | Kafka outage, Redis outage, payment charge-then-timeout scenarios |

## `docs`

See the [docs home](../README.md) for what each document is for and the order to read them in.
