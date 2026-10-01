# Architecture — how Tessera works, A to Z

> 📍 **Reference page:** compact, exact facts about the architecture. For the plain-language, step-by-step version read [learn/02](learn/02-level2-how-it-works.md) and [learn/03](learn/03-level3-deep-dive.md). New here? Start at the [docs home](README.md).

## 1. The problem

Allocate scarce inventory to a very large number of simultaneous claimants so that
the number sold **never** exceeds what exists — while payment providers time out,
processes crash mid-step, the message broker goes down, and messages arrive twice
or out of order.

Railway ticketing is the demo (think a Tatkal window opening at 10:00 with a
million people and 500 seats). The engine underneath is generic: a hotel room over
a range of nights, a concert seat, a clinic slot and a rental unit over time slots
are all the same shape.

## 2. The central decision: one shape, one constraint

Every kind of inventory is a **resource occupied over a span**:

| Domain | Resource | Span |
|---|---|---|
| Railway | seat | range of station stops `[3,7)` |
| Hotel | room | range of nights `[0,3)` |
| Concert / appointment | seat / slot | `[0,1)` |
| Rental | unit | range of time slots |

"Do not oversell" then becomes one sentence the database can enforce:
*two live allocations of the same resource must not overlap.*

```sql
ALTER TABLE allocations ADD CONSTRAINT allocations_no_overlap
  EXCLUDE USING gist (resource_id WITH =, span WITH &&)
  WHERE (state IN ('HELD','CONFIRMED','BLOCKED'));
```

Consequences:

- Overselling is prevented by PostgreSQL **refusing the row** (SQLSTATE 23P01),
  not by application code being careful. A bug anywhere above the database costs
  latency, never a double-booked seat.
- Half-open ranges model the domain exactly: a passenger alighting at stop 5 and
  another boarding at stop 5 do not conflict. That is **segment resale** — one seat
  sold several times across non-overlapping stretches of one journey.
- Expired, released and cancelled rows stay as history but drop out of the
  constraint (the `WHERE` clause), so the audit trail costs no availability.

## 3. The services

```
                     Browser (React console)
                              │
                              ▼
                  ┌───────── gateway :4000 ─────────┐
                  │ rate limit → waiting room → auth │
                  │ → RBAC → load shedding → proxy   │
                  └──┬──────┬──────┬──────┬──────┬───┘
                     │      │      │      │      │
          discovery  │ reservation │ pricing  reconciliation   notification
            :4006    │   :4002     │  :4007      :4004            :4005
          (search)   │  (saga)     │ (fares)  (scoreboard)     (emails)
                     │      │      │               │  read-only    ▲
                     │      ├──────┼──► inventory-engine :4001     │
                     │      │      │    (THE AUTHORITY)            │
                     │      └──────┼──► payment :4003              │
                     │             │    (UNKNOWN state, provider)  │
                     ▼             ▼                               │
     ┌──────────── PostgreSQL 16: one database per service ────────┤
     │  inventory · reservation · payment · reconciliation ·       │
     │  notification · discovery                                    │
     └───── outbox rows ──► relay ──► Kafka (KRaft, 13 topics) ─────┘
                                         │
                            Redis 7: rate limits, waiting room, L2 cache
                            Elasticsearch 8: search index (discovery only)
```

| Service | Owns | Does |
|---|---|---|
| **gateway** | nothing (stateless) | token-bucket rate limiting, virtual waiting room, JWT auth, role checks, event-loop-lag load shedding, proxying with correlation ids |
| **inventory-engine** | allocations, holds, ledger, pools | reserve / confirm / release / cancel; lazy expiry; expiry sweeper; admin block/unblock; invariant views |
| **reservation** | reservations, bookings, sagas | public booking API; durable saga orchestrator driving hold → pay → confirm |
| **payment** | payments, refunds, provider events | payment state machine with `UNKNOWN`; resolver; webhook verification; fault-injecting fake provider |
| **pricing** | nothing (stateless) | server-side fares: base × distance share × demand tier |
| **discovery** | search projection | consumes inventory events, keeps a read model, serves search from Elasticsearch with PostgreSQL fallback, L1/L2 cache |
| **notification** | notifications | consumes booking events, sends each email exactly once, DLQ + replay |
| **reconciliation** | issues, repair log | compares services, raises issues, repairs only safe inventory problems, scoreboard |

## 4. A booking, end to end

1. **Search** (`GET /api/search`) → discovery. Answer comes from Elasticsearch (or
   PostgreSQL if ES is down), via an L1 in-process cache and an L2 Redis cache. It
   carries `as_of` and `authoritative: false`.
2. **Seat map** (`GET /api/events/:id/resources?spanFrom&spanTo`) → inventory,
   read without locks. Also discovery-grade: may be stale by the time you click.
3. **Reserve** (`POST /api/reservations` with an `Idempotency-Key`):
   - gateway: rate limit (reserve bucket: burst 5), verify JWT, optionally require
     a waiting-room admission token, forward with `x-customer-id`;
   - reservation: fairness check (max concurrent holds per customer), **quote the
     price server-side** from pricing (before any transaction), then in **one
     transaction** write the reservation, its items and a saga row, and record the
     idempotency response. Return **202** immediately with a poll URL.
4. **Saga worker** (inside reservation) claims the saga with `FOR UPDATE SKIP LOCKED`
   plus a lease, and executes **one step per claim**:
   - `HOLD_PENDING` → inventory `POST /internal/reserve` (idempotency key
     `saga:<id>:hold`). In one transaction the engine: locks the resource rows in
     sorted order, reaps expired holds on those resources, inserts the hold and
     allocations (the constraint decides), claims pool quantities, appends ledger
     entries, writes an outbox event. → `HOLD_CREATED`.
   - `PAYMENT_PENDING` → payment `POST /internal/charge` (key `saga:<id>:payment`).
     Success → `PAYMENT_AUTHORIZED`. Decline → `PAYMENT_FAILED` → release. **Timeout
     → `PAYMENT_UNKNOWN`**: the resolver asks the provider what happened.
   - `CONFIRM_PENDING` → inventory `POST /internal/confirm`. The confirm is a single
     guarded UPDATE (`… AND expires_at > now()`), so an expired hold can never be
     confirmed. Success → booking row + `booking.confirmed` event → `CONFIRMED`.
     Hold expired after payment → `REFUND_PENDING` → refund.
5. **Poll** (`GET /api/reservations/:id`) shows human-readable progress.
6. **Events**: outbox relays publish to Kafka; notification sends the email once;
   discovery marks the train dirty and refreshes its projection.
7. **Reconciliation** later confirms the services agree.

## 5. Concurrency: how contention is handled

The engine's reserve path is the result of measurement (see
`docs/benchmarks/RESULTS.md`):

| Layer | Role | Correctness dependency? |
|---|---|---|
| Sorted `SELECT … FOR UPDATE` on the resource rows | orderly FIFO queue per seat; no deadlock cycles across multi-seat requests | **No** — throughput |
| Lazy reap of expired holds on those rows | makes the TTL authoritative at the moment it matters | yes (for availability) |
| GiST exclusion constraint | the final arbiter | **Yes — the only one** |

Why the row lock exists: the constraint alone is correct but collapsed under
contention — 1,000 requests for one seat produced **609 deadlocks** and a 30-second
p99, because a GiST exclusion constraint inserts and *then* scans for conflicts,
waiting on in-progress inserters, which forms wait cycles. Queueing on the row first
gave 0 deadlocks and a 186ms p99 (86× throughput).

## 6. Time: holds and expiry

- A hold has `expires_at` set by the **database clock**.
- **Lazy expiry**: `reserve` expires stale holds on exactly the resources it is
  about to touch, inside its own transaction. So the TTL is enforced by the
  authority at the moment of contention, regardless of any background job.
- **Sweeper**: `FOR UPDATE SKIP LOCKED` in batches; many replicas, no leader. It is a
  *freshness* job (returns abandoned seats to browsing users promptly), not a
  correctness dependency.
- **Confirm** checks expiry in the same UPDATE statement, so there is no gap between
  "still valid" and "confirmed".

## 7. Reliability plumbing

| Mechanism | Guarantee | Where |
|---|---|---|
| Claim-first idempotency | two concurrent retries cannot both run; a lost response replays the original | `packages/shared/src/idempotency` |
| Transactional outbox | an event exists iff its business change committed | `outbox/writer.js` |
| Outbox relay | publishes outside any transaction, marks after; head-of-line per aggregate keeps order; backoff with jitter; dead-letters poison rows | `outbox/relay.js` |
| Idempotent consumer | dedupe marker in the same transaction as the effect → effectively-once | `consumer/index.js` |
| `aggregate_seq` guard | out-of-order events for a projection are discarded | `consumer/index.js` |
| Persistent DLQ + replay | poison messages don't stall a partition; replay after a fix | `consumer/index.js`, notification admin API |
| Versioned event contracts | producer and consumer validate; v1→v2 upcasting | `events/schemas.js`, `events/registry.js` |
| Durable saga | progress is a row; crash anywhere, another worker resumes | `reservation/src/saga/orchestrator.js` |
| Failpoints | deterministic crash injection at exact lines | `failpoints/index.js` |

Delivery semantics, stated plainly: Kafka gives **at-least-once**. With the dedupe
row in the consumer's transaction, the **business effect** is effectively-once.
Kafka's own "exactly-once" does not extend to a PostgreSQL write.

## 8. Payments

- A charge row is committed **before** the provider is called, so a crash mid-call
  leaves an attributable record.
- Every transition is a guarded `UPDATE … WHERE state = $expected`, and a trigger
  rejects illegal transitions.
- **Timeout ⇒ `UNKNOWN`**, never `FAILED`. A resolver asks the provider (by our
  idempotency key) and moves to `CAPTURED` or `FAILED`. The charge is never retried.
- Webhooks: HMAC over `timestamp.body` (constant-time compare), 5-minute window,
  deduplicated by provider event id. A bad signature is logged and **never** moves a
  payment (the old system marked it FAILED — money taken, no booking).
- Out-of-order webhooks (capture before authorise) are detected and skipped.

## 9. Admission control and fairness

| Mechanism | Question it answers |
|---|---|
| Token bucket (per user/IP, per route, one Lua script) | is this *one client* asking too often? |
| Virtual waiting room (Lua; signed admission tokens) | how many people may be *inside* at all? |
| Event-loop-lag load shedding (503 + Retry-After) | is *this instance* saturated? |
| Max concurrent holds per customer | can one customer park the inventory? |
| Hold TTL | can abandoned checkouts starve others? |

Redis down → token bucket falls back to a conservative in-process limiter (fails
closed, not open); admitted waiting-room users keep working because tokens are
verified statelessly; bookings are unaffected.

## 10. Read side

- **discovery** is a projection. Inventory events mark a train *dirty* (durably, in
  the consumer's transaction); a refresher re-reads availability from inventory and
  rewrites the projection and the ES index. Events are "this changed" signals, not
  state, so a lost event cannot leave the projection permanently wrong; a periodic
  resync heals anything missed.
- Refreshes are **coalesced**: a hot train emitting hundreds of events a second is
  refreshed at most once per tick.
- Caching: L1 (in-process, 1s) → L2 (Redis, ~5s, jittered TTL) → ES/PG. Cache keys
  carry a version bumped on every refresh, so invalidation is implicit. Single-flight
  stops stampedes.
- Elasticsearch has a **circuit breaker**: after a failure it is skipped for 10s and
  PostgreSQL (trigram word-similarity) answers.

## 11. Pricing

`fare = base × max(0.3, span_share) × demand_tier`, rounded to whole rupees.
Tiers by class occupancy: <50% standard, <80% +10%, <95% +25%, else +50%. One
module (`packages/shared/src/pricing`) is used by both the pricing service and the
search projection, so search's "from ₹X" equals the checkout fare. The price is
quoted server-side and stored on the hold; a client-sent price is ignored.

## 12. Reconciliation

Eleven checks compare services: duplicate booking, ledger drift, payment without
booking, confirmed without payment, booking without allocation, allocation without
booking, orphan payment, expired hold still allocated, payment UNKNOWN too long,
stuck saga, outbox backlog. Rules:

- **Grace windows**, and an issue must be seen in **two passes** before action — no
  snapshot across databases is atomic.
- **Only inventory-only, reversible repairs are automatic** (expire a stranded hold,
  nudge a stuck saga). Anything involving money gets a recommendation and waits for
  a human (`AWAITING_HUMAN`).
- Every repair is written to an append-only repair log.

## 13. The ledger

Every inventory movement appends `(entry_type, delta)`: `CAPACITY_ADDED +1`,
`ALLOCATED −1`, `RELEASED/EXPIRED/CANCELLED/UNBLOCKED +1`, `CONFIRMED 0`,
`BLOCKED −1`. Folding it must equal observed availability; the
`invariant_ledger_drift` view checks that continuously. The ledger is append-only by
trigger.

## 14. Invariants (the scoreboard)

All return zero rows when healthy; tests, lab, reconciliation and the dashboard all
use the same views:

| Id | Invariant | Severity |
|---|---|---|
| I1 | no two live allocations of a resource overlap | CRITICAL |
| I2 | no pool bucket exceeds capacity | CRITICAL |
| I3 | no allocation still HELD past its expiry | HIGH |
| I3b | holds and their allocations agree | HIGH |
| I4 | ledger fold equals state | CRITICAL |
| I7 | no resource-span confirmed twice | CRITICAL |
| I6 | outbox backlog > 60s | MEDIUM (lag, not corruption) |

## 15. Security

- Gateway verifies HS256 JWTs (constant-time); roles `CUSTOMER` / `OPERATOR`;
  operator routes checked at the edge and the operator's identity passed downstream
  as `x-actor` for the audit log.
- Internal APIs require a service token; they are not reachable from outside.
- Idempotency keys are scoped to the caller; reuse with a different body → 422.
- Customers cannot read each other's reservations (404, not 403).
- Webhook HMAC + timestamp window + event-id replay protection.
- Prices are server-side only.
- Production refuses to start with development secrets.
- Append-only audit and ledger tables.

## 16. Consistency guarantees

| Data | Guarantee |
|---|---|
| Allocation | strong — enforced by the constraint |
| Event side effects | effectively-once (at-least-once + idempotent consumer) |
| Search / availability reads | eventually consistent, age exposed |
| Cross-service workflow | convergent, via the saga; checked by reconciliation |

## 17. Deployment

- **Local**: `npm run up` (infra) + `npm run start` (services on the host).
- **Compose**: `npm run up:app` builds one image (`SERVICE` build arg) for all eight.
- **Kubernetes**: `deploy/k8s` — kustomize base with probes (liveness ≠ readiness),
  PodDisruptionBudgets, HPAs, non-root, read-only root FS, a migration Job.
  Production-shaped, **not exercised on a cluster**.

## 18. What was deliberately not built

- Two-phase commit (a saga instead).
- Confluent Schema Registry / Avro (JSON Schema + upcasters instead; see §7).
- Read replicas (policy: search → replica/cache, allocation → primary only).
- A real payment provider in the demo path (Razorpay removed; the fake provider
  exists to inject failures a sandbox cannot).
