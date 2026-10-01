# CLAUDE.md — Tessera

Context for AI coding sessions. Read this first; it saves re-deriving the design.

## What this is

**Tessera** — a distributed reservation and inventory platform whose central
problem is: allocate scarce inventory to many concurrent users without ever
overselling, while payments time out, processes die, and messages arrive twice or
out of order. Railway ticketing is the demo domain; the engine is generic (rail
seats, hotel rooms, concert seats, appointment slots, rental units).

Formerly "ScaleRail" (an IRCTC-style booking app). Renamed and rebuilt; the old
spec is in `docs/spec/ORIGINAL_SPEC.md`, the roadmap in `docs/plan/MASTER_PLAN.md`.

## The one idea everything rests on

Every inventory type is a **resource occupied over an interval** (`int4range`).
A PostgreSQL GiST **exclusion constraint** forbids two live allocations of the
same resource with overlapping spans:

```sql
EXCLUDE USING gist (resource_id WITH =, span WITH &&) WHERE (state IN ('HELD','CONFIRMED','BLOCKED'))
```

So overselling is prevented by the database refusing the row, not by application
care. Everything above it (Redis, caches, locks, queues) is a throughput or UX
optimisation, never a correctness dependency. **Do not weaken this.**

## Non-negotiable rules

1. **PostgreSQL is the only authority** for allocation. Redis is a load filter / cache only.
2. **No network I/O inside a DB transaction** (no HTTP, Kafka, payment call).
3. **Never trust client prices.** Pricing is computed server-side (pricing service) and locked into the hold.
4. **A payment timeout is UNKNOWN, never FAILED.** Resolve by asking the provider; never re-charge.
5. **Money is never auto-repaired** by reconciliation — recommendation + human.
6. **Every mutation is idempotent** (claim-first keys, `INSERT … ON CONFLICT DO NOTHING`).
7. **Every event goes through the transactional outbox**, validated against `packages/shared/src/events/schemas.js`.
8. **Consumers dedupe in the same transaction as their effect** (`processed_events`).
9. **State machines are enforced by DB triggers** (allocations, holds, sagas, payments). Illegal transitions throw.
10. **Ledger and audit tables are append-only** by trigger. Never UPDATE/DELETE them, even in tests.
11. **Do not invent benchmark numbers.** Results live in `docs/benchmarks/RESULTS.md`, produced by `npm run lab`.

## Layout

```
packages/shared/   correctness primitives: pool, migrations, idempotency, outbox (writer+relay),
                   consumer dedupe + DLQ, event contracts, failpoints, admission (token bucket,
                   waiting room), pricing rules, metrics, logging, tracing, HTTP shell,
                   config helpers (str/num/secret), outbound httpRequest with a deadline
services/
  gateway/          :4000  edge: rate limit, auth (HS256 JWT), RBAC, waiting room, load shedding, proxy
  inventory-engine/ :4001  the authority: reserve/confirm/release/cancel, ledger, expiry sweeper, admin block
  reservation/      :4002  public booking API + durable saga orchestrator
  payment/          :4003  payment state machine incl. UNKNOWN, fake fault-injecting provider, resolver
  reconciliation/   :4004  cross-service checks, conservative auto-repair, correctness scoreboard
  notification/     :4005  Kafka consumer (booking.events), exactly-once effect, DLQ + replay
  discovery/        :4006  search read model: Kafka-driven projection, Elasticsearch + PG fallback, L1/L2 cache
  pricing/          :4007  server-side fares (distance share × demand tier)
lab/                Contention Lab: 9 concurrency strategies, verified against DB rows
bench/              seed.js, e2e.js (39 live checks), smoke.js (deploy check via public URL), k6/flash-sale.js, results/
apps/console/       React + Vite + Tailwind console (search, seat map, live saga, ops, scoreboard)
deploy/             compose (laptop profiles core/obs/app/lab + docker-compose.prod.yml for one server),
                   edge (Caddy + console image), prometheus, grafana, k8s (base, overlays, infra)
scripts/            start.sh / stop.sh / chaos.sh
docs/               architecture, API, database, learn/ course (08 = deployment guide), benchmarks, interview
```

## Commands

```bash
npm install
cp .env.example .env
npm run up          # postgres, redis, kafka (KRaft) + topics, elasticsearch
npm run migrate     # plain-SQL migrations, checksummed, advisory-locked
npm run seed        # 6 trains, 2016 seats, deterministic (seed 42)
npm run start       # all 8 services, detached, logs in .logs/
npm run console     # http://localhost:5173
npm test            # 50 integration tests (needs postgres + redis)
npm run e2e         # 39 end-to-end checks against the running stack
npm run lab -- run --scenario 1000u-1r --strategy all
npm run chaos -- kafka|redis|payment
npm run up:obs      # prometheus :9091, grafana :3002, jaeger :16687
npm run smoke -- https://host   # after a deploy: book + cancel through the public URL
# deploy to a server: docs/learn/08-deployment.md (docker-compose.prod.yml + deploy/compose/.env)
```

Operator login in the console: `ops@tessera.dev`. Any other email is a customer.

## Conventions

- Node 22, **CommonJS**, npm workspaces, 5-space indentation, heavy "why" comments.
- Plain SQL migrations per service in `services/<svc>/sql/migrations/NNN_name.sql`;
  shared primitives in `packages/shared/sql/`. Never edit an applied migration —
  add a new one (the runner rejects checksum changes).
- One database per service (same Postgres instance locally). No cross-database joins;
  reconciliation is the documented exception (read-only).
- Errors: `TesseraError` subclasses; 409 = expected contention, never a 500.
- Service-to-service calls go through `@tessera/shared/src/http/client` (`httpRequest`),
  and config through `@tessera/shared/src/config` — don't hand-roll `fetch` or env parsing.
- Windows dev box: Git Bash has no `pkill`; `scripts/stop.sh` uses PowerShell.
  Shell heredocs containing apostrophes break — write files with the editor instead.

## Status

Built and verified: everything above. Not exercised: K8s manifests (schema-validated,
not run on a cluster), the prod compose file as containers (validated, and every
step below it verified on the host), k6 script (written, not yet run), multi-instance scaling curve (2 reservation
workers verified correct, no curve measured). All numbers are from one laptop.
