# Getting started

> 📍 **Reference page:** install and run. To understand what you are running, start at the reading path. New here? Start at the [docs home](README.md).

From a clean machine to a booking in the browser in about ten minutes.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Docker Desktop | recent | PostgreSQL, Redis, Kafka, Elasticsearch |
| Node.js | 20+ (22 used) | the services, lab and console |
| Git Bash (Windows) or any POSIX shell | — | `scripts/*.sh` |

Free ports needed: 5432, 6379, 9092, 9200, 4000–4007, 5173.

## 1 · Install and configure

```bash
git clone https://github.com/X-Rachit-X/Distributed-Inventory.git
cd Distributed-Inventory
npm install
cp .env.example .env
```

`.env` holds development-only secrets. Every service refuses to start with them
when `NODE_ENV=production`.

## 2 · Start the infrastructure

```bash
npm run up
```

Starts PostgreSQL 16 (six databases), Redis 7, Kafka in KRaft mode, a one-shot job
that creates the 13 topics with explicit partition counts, and Elasticsearch.
Kafka and Elasticsearch take 20–40 seconds to report healthy.

```bash
docker ps --format '{{.Names}}\t{{.Status}}'   # wait for (healthy)
```

## 3 · Create schemas and seed inventory

```bash
npm run migrate    # applies every service's SQL migrations
npm run seed       # 3 trains × 2 days, 8 stops, 2016 seats, deterministic
```

## 4 · Start the services

```bash
npm run start
```

Starts all eight services detached, logs in `.logs/<service>.log`, then waits for
every `/health`. Stop them with `npm run stop`.

| Port | Service |
|---|---|
| 4000 | gateway (the only one a browser talks to) |
| 4001 | inventory-engine |
| 4002 | reservation |
| 4003 | payment |
| 4004 | reconciliation |
| 4005 | notification |
| 4006 | discovery |
| 4007 | pricing |

## 5 · Open the console

```bash
npm run console      # http://localhost:5173
```

A walk-through that shows what the system does:

1. **Search** — try `kanpr` → `howra` (typos on purpose). The result line tells you
   which backend answered (Elasticsearch, or PostgreSQL if ES is down), whether it
   came from cache, and how old the data is.
2. **Sign in** with any email. Choose seats on a result. Change the journey — the
   seat map changes, because a seat is free *for a span*, not free outright.
3. **Book.** You land on the live reservation page and watch the saga: securing
   seats → taking payment → issuing booking → a `TSR-…` reference.
4. **My bookings** shows the confirmation notification, delivered by a Kafka
   consumer exactly once.
5. **Sign out, sign in as `ops@tessera.dev`** (operator role). On **Operations**,
   set the payment provider to `timeout_after_success`, then book again as a
   customer: the payment goes UNKNOWN, is resolved with the provider, and the
   customer is charged once.
6. **Correctness** shows the invariants, queried against the database. They should
   all read zero whatever you did.

## 6 · Run the proofs

```bash
npm test                                           # 40 integration tests
npm run e2e                                        # 31 end-to-end checks against the live stack
npm run lab -- run --scenario 1000u-1r --strategy all   # the concurrency comparison
npm run lab -- list                                # every scenario and strategy
```

Chaos:

```bash
npm run chaos -- kafka     # stop the broker, book, watch the outbox hold events, restart, watch it drain
npm run chaos -- redis     # stop Redis, booking still works, rate limiting degrades to local
npm run chaos -- payment   # charge-then-timeout, resolved to exactly one charge
```

Load (k6 runs in a container, nothing to install):

```bash
docker run --rm -i --network host -e BASE=http://localhost:4000 -e VUS=200 \
  grafana/k6 run - < bench/k6/flash-sale.js
```

## 7 · Observability (optional)

```bash
npm run up:obs
```

| Tool | URL |
|---|---|
| Grafana (dashboard "Tessera — correctness & flow") | http://localhost:3002 (admin/admin) |
| Prometheus | http://localhost:9091 |
| Jaeger | http://localhost:16687 |
| Kafka UI | http://localhost:8080 |

For traces, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319` in `.env` and
restart the services.

## Fully containerised

```bash
npm run up:app     # builds one image, runs all eight services in compose
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| A service is "not responding" right after start | notification and discovery join their Kafka group before listening; give it 20s |
| `migrate` fails with "contents changed" | an applied migration was edited; add a new migration instead |
| Search says `backend: postgres` | Elasticsearch is down or warming up; it is retried every 10s automatically |
| Bookings fail with 503 "Pricing is unavailable" | start the pricing service; the system fails closed rather than sell at an unknown price |
| Port 9090 / 3000 already in use | Tessera uses 9091 / 3002 on purpose |
