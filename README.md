# Tessera

**Distributed reservation and inventory infrastructure, engineered to keep inventory
correct under extreme concurrent demand.**

A *tessera* was the Roman admission token: one object, one entry, impossible to
duplicate. Holding that guarantee while thousands of people click "Book" on the same
seat — and while payments time out, processes crash and messages arrive twice — is
what this system does.

Railway ticketing is the demo. The engine is generic: seats over a range of stops,
hotel rooms over nights, concert seats, appointment slots and rental units are all
the same shape.

---

## The central idea

Every kind of inventory is a **resource occupied over an interval**, and PostgreSQL
enforces "never oversell" itself:

```sql
EXCLUDE USING gist (resource_id WITH =, span WITH &&)
  WHERE (state IN ('HELD','CONFIRMED','BLOCKED'))
```

Two live allocations of the same seat cannot overlap because the database refuses to
store the second row. Everything above it — Redis, caches, queues, locks — is an
optimisation. A bug there costs latency, never a double-booked seat.

## What it proves, with numbers

Measured on one laptop, 1,000 users competing for 1 seat, verified by counting rows
in the database (never by counting HTTP responses):

| Strategy | Customers sold the same seat | p99 | req/s |
|---|---:|---:|---:|
| Naive read-check-write | **64** | 623 ms | 1,007 |
| Constraint alone | 1 | 30,008 ms (609 deadlocks) | 9.6 |
| **Row-lock queue + constraint (production)** | **1** | **186 ms** | **575** |
| Redis lock + constraint | 1 (Redis leaked once; constraint caught it) | 10.6 ms | 11,364 |

Plus: **40 integration tests** and **31 end-to-end checks** against the live stack —
50 simultaneous customers for one seat (exactly one wins), idempotent replay, a
declined payment releasing the seat, a provider timeout resolved to exactly one
charge, segment resale, the admin policy refusing to seize a sold seat, forged
webhooks rejected. During development Kafka was unreachable for hours: **931 events**
waited in the outbox and were all published on recovery, zero lost.

Details: [`docs/benchmarks/RESULTS.md`](docs/benchmarks/RESULTS.md).

## Architecture

```
Browser ─► gateway :4000  (rate limit · waiting room · JWT · RBAC · load shedding)
              ├─► discovery :4006    search: Kafka-fed projection, Elasticsearch + PG fallback, L1/L2 cache
              ├─► reservation :4002  booking API + durable saga (hold → pay → confirm)
              │      ├─► pricing :4007          server-side fares
              │      ├─► inventory-engine :4001  THE AUTHORITY (exclusion constraint, ledger, expiry)
              │      └─► payment :4003          state machine with UNKNOWN, fault-injecting provider
              ├─► reconciliation :4004  cross-service checks, safe auto-repair, scoreboard
              └─► notification :4005    Kafka consumer, exactly-once effect, DLQ + replay

PostgreSQL 16 (one DB per service) · Kafka KRaft (transactional outbox) · Redis 7 · Elasticsearch 8
Prometheus · Grafana · OpenTelemetry/Jaeger · Docker Compose · Kubernetes manifests
```

## Quick start

```bash
npm install && cp .env.example .env
npm run up          # PostgreSQL, Redis, Kafka + topics, Elasticsearch
npm run migrate     # schemas
npm run seed        # 6 trains, 2016 seats
npm run start       # all 8 services
npm run console     # http://localhost:5173  (operator login: ops@tessera.dev)
```

Proofs:

```bash
npm test                                              # 40 integration tests
npm run e2e                                           # 31 live end-to-end checks
npm run lab -- run --scenario 1000u-1r --strategy all # concurrency comparison
npm run chaos -- kafka|redis|payment                  # failure scenarios
```

Full guide: [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md).

## Documentation

| Document | Contents |
|---|---|
| **[Learn Tessera (course)](docs/learn/README.md)** | **Start here if the project feels big:** concepts from zero, three levels of depth, every file explained, failure scenarios, resume and interview guide |
| [Getting started](docs/GETTING_STARTED.md) | Setup and a guided walk-through |
| [Architecture](docs/ARCHITECTURE.md) | How it works, A to Z |
| [API](docs/API.md) | Every endpoint and event, and how to explain them |
| [Database](docs/DATABASE.md) | Every schema and constraint, and why |
| [File guide](docs/FILE_GUIDE.md) | What every file does |
| [Challenges](docs/CHALLENGES.md) | Problems hit and solved; behavioural answers |
| [Interview Q&A](docs/PROJECT_INTERVIEW.md) · [HTML guide](docs/interview/tessera-interview-guide.html) | Interview preparation |
| [Results](docs/benchmarks/RESULTS.md) · [Hypotheses](docs/benchmarks/HYPOTHESES.md) | Measurements, and predictions made before measuring |

## Honest scope

Built and verified: everything above. Kubernetes manifests are production-shaped but
have not been run on a cluster. The k6 flash-sale script is written but its results
are not yet recorded. Horizontal scaling is verified for correctness (two saga
workers, one database) but no scaling curve has been measured. All numbers come from
a single laptop and describe relative behaviour, not production capacity.

## Stack

Node.js 22 · Express 5 · PostgreSQL 16 · Kafka (KRaft) / KafkaJS · Redis 7 · Elasticsearch 8 ·
React 18 · Vite · Tailwind · Zustand · Prometheus · Grafana · OpenTelemetry · Jaeger ·
Docker Compose · Kubernetes (kustomize) · node:test · k6
