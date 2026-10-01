# 06 · Resume value, interview prep, and honest notes

> 📍 **Reading path:** [01](01-level1-big-picture.md) → [02](02-level2-how-it-works.md) → [code](../README.md#step-3-read-the-code-in-the-order-a-booking-flows) → [03](03-level3-deep-dive.md) → [05](05-failure-scenarios.md) → **[06 · you are here](06-resume-and-interview.md)** · [Docs home](../README.md)

## 1. Is this project worth putting on a resume? Short answer: yes, strongly

Most portfolio backends are CRUD + JWT + maybe Redis. Interviewers have seen
hundreds. This project is different in four ways.

| What interviewers look for | What Tessera shows | Evidence in the repo |
|---|---|---|
| **Depth on one hard problem** | oversell-proof inventory under extreme contention | exclusion constraint, row-lock queue, lab results |
| **Distributed-systems literacy** | outbox, idempotent consumers, saga, DLQ, schema versioning, at-least-once vs exactly-once stated *correctly* | `packages/shared`, the reservation saga |
| **Production thinking** | timeouts, graceful shutdown, liveness vs readiness, load shedding, fail-closed limits, append-only audit, secrets refused in production | `http/server.js`, `pool.js`, configs |
| **Scientific honesty** | hypotheses written **before** measuring, wrong predictions published, every number reproducible, limits stated | `docs/benchmarks/HYPOTHESES.md`, `RESULTS.md`, README "Honest scope" |

The fourth one is rare and gets noticed. Saying "my prediction was wrong, here is
why, and it changed the production code" signals senior judgement.

**Best fit roles:** backend / platform / SDE-2-level backend, fintech and payments,
e-commerce and ticketing, marketplaces, logistics, anything with "inventory",
"booking" or "ledger" in it.

**What it does *not* prove** (so don't overclaim): real production traffic,
multi-node Kafka/Postgres operations, Kubernetes on a real cluster, a measured
horizontal scaling curve. All numbers come from one laptop.

## 2. Resume bullets (pick 3–5, all backed by measured numbers)

> **Tessera: Distributed Reservation & Inventory Platform** · Node.js, PostgreSQL, Kafka, Redis, Elasticsearch, React, Docker, Kubernetes

- Built an 8-service booking platform that **cannot oversell by construction**:
  modelled all inventory as resources occupied over integer ranges and enforced
  non-overlap with a **PostgreSQL GiST exclusion constraint**. Verified with 50 and
  1,000 simultaneous buyers per seat, by counting stored rows.
- Built a **Contention Lab** comparing 9 locking strategies under 1,000-to-1
  contention. Showed naive check-then-write sold one seat to **64 customers**, and
  found that the constraint alone caused **609 deadlocks**. A sorted row-lock queue
  in front of it gave **0 deadlocks, 186 ms p99 and 86× the throughput**.
- Guaranteed **no lost and no duplicate side effects** with a transactional outbox
  (per-aggregate ordered relay, jittered retries, dead-lettering), claim-first
  idempotency keys with response replay, and **idempotent Kafka consumers** that
  dedupe in the same transaction as their effect. **931 events** survived a
  multi-hour Kafka outage with zero loss.
- Built a **durable saga orchestrator** (hold → pay → confirm) stored as rows, with
  leases, compare-and-swap transitions and DB-enforced state machines, plus
  compensation (release / refund). Payments model timeouts as **UNKNOWN** and
  resolve them by querying the provider: **exactly one charge** under
  charge-then-timeout fault injection.
- Added flash-sale **admission control**: atomic Redis-Lua token buckets that fail
  closed, a virtual waiting room with HMAC admission tokens, event-loop-lag load
  shedding. Added a **reconciliation service** with grace windows and a strict
  "never auto-repair money" policy, plus an append-only inventory ledger checked by
  invariant views.
- 40 integration tests + 31 live end-to-end checks; Prometheus/Grafana,
  OpenTelemetry/Jaeger, deterministic failpoints for crash testing.

**One-liner for the top of a resume:**
*"Designed a distributed booking engine that provably never double-sells (Postgres
exclusion constraints), survives crashes and payment timeouts (outbox, saga,
UNKNOWN state), and measured 9 concurrency strategies to justify the design."*

## 3. How to explain it in an interview

### The 30-second pitch
"Tessera sells scarce inventory, like train seats, to thousands of people at once.
The core idea is to model every booking as a resource occupied over a range and
let PostgreSQL enforce 'no two live bookings overlap' with an exclusion constraint.
That way overselling is impossible at the storage layer, and everything else, like
Redis, caches and locks, is just for speed. Around that I built the reliability
plumbing a real booking system needs: a transactional outbox, idempotency, a
durable saga for hold-pay-confirm, an UNKNOWN payment state for timeouts, and a
reconciliation service. I also measured the design: the naive approach sold one
seat to 64 people, and my first 'correct' design deadlocked 609 times out of 1,000,
which led to the final design."

### The 2-minute walkthrough (draw this)
```
Browser → Gateway (rate limit, JWT, waiting room) → Reservation (202 + saga row)
   saga worker: Inventory.reserve ─► Payment.charge ─► Inventory.confirm
   each service: business write + outbox row in ONE tx → relay → Kafka → consumers (dedupe)
   Reconciliation compares DBs every 30 s; money issues → humans
```

### Likely questions, with short answers

| Question | Answer |
|---|---|
| Why not just `SELECT … FOR UPDATE` and check in code? | It is correct only if *every* code path remembers to do it. A constraint is enforced on every write, including hand-run SQL. I *do* use the row lock, for throughput, but correctness doesn't depend on it |
| Why did the constraint alone deadlock? | GiST exclusion inserts first and then checks, waiting on in-progress conflicting inserters. Many concurrent inserters on one key form wait cycles. A row lock first turns that into a FIFO queue |
| Why not Redis locks? | Redis is fast, and in my lab it was the fastest, but it has no durability guarantee. It leaked once in 1,000 and the constraint caught it. I treat it as a load filter, never as the source of truth |
| What is the outbox pattern and why? | It solves the dual-write problem: the event is a row in the same transaction, and a relay publishes it later. "Event exists iff change committed." The trade is a little latency for never losing an event |
| Exactly-once with Kafka? | Kafka gives at-least-once to an external DB. I get *effectively-once effects* by inserting `(consumer, event_id)` in the same transaction as the effect |
| How do you keep event order? | Partition key = aggregate id. The relay only publishes the oldest pending event per aggregate. Consumers drop events with an older `aggregate_seq` |
| Why a saga and not 2PC? | 2PC would hold locks across services while a human types card details, and every participant would have to be up. A saga commits locally per step and compensates on failure |
| What if the worker dies mid-saga? | The saga is a row with a lease. On a graceful stop the lease is released and the step re-runs safely (deterministic idempotency keys). On a hard crash the lease outlives the step deadline, so the step takes its *timeout path* (hold → failed, payment → UNKNOWN, confirm → refund). That is a conservative outcome, never a double effect |
| Payment timeout? | It's UNKNOWN, never FAILED. We never retry the charge; we ask the provider by our idempotency key. If it can't be resolved → MANUAL_REVIEW |
| Paid but the hold expired? | Confirm is one guarded UPDATE `… AND expires_at > now()`. Zero rows → refund path. Never a silent loss |
| How do you know it's correct? | Invariant views that return 0 rows when healthy, used by tests, the lab, reconciliation and the dashboard; plus an append-only ledger whose fold must equal state |
| Why separate databases per service? | Ownership. Joining across services is impossible, so coupling is visible. Reconciliation is the documented read-only exception |
| How does it scale? | Stateless services scale horizontally. Workers use SKIP LOCKED + leases with no leader. Contention is per seat, not global. Hot counters are sharded into buckets. Honest caveat: no measured scaling curve yet |
| Webhook security? | Raw-body HMAC with a timestamp, constant-time compare, a 5-minute window, dedupe by provider event id, and a bad signature never changes a payment |
| What would you do next? | See "improvements" below. Also: run k6 for real, measure a scaling curve, run on a real cluster |

### Behavioural stories (STAR), from `docs/CHALLENGES.md`
1. *My benchmark lied*: lazy connections serialised the "concurrent" test. Fixed with warm connections + a barrier → found 64 oversells.
2. *My correct design was 86× too slow*: 609 deadlocks → row-lock queue.
3. *A race found by running two replicas*: lease released mid-step → keepLease + CAS.
4. *The ledger flagged correct data*: no opening balance → `CAPACITY_ADDED` and a better view.
5. *A real Kafka outage*: 931 events waited in the outbox, all delivered.

## 4. Honest notes from reading the code

I read every file while writing these docs. These are places where the code and its
comments disagree, or where an edge case isn't fully closed. None of them can cause
an **oversell**: the constraint holds regardless. Knowing them makes you *more*
credible in an interview ("here's what I'd harden next"). Treat them as a
reviewer's reading of the code, not as tested bugs.

| # | Where | Observation | Impact | Possible fix |
|---|---|---|---|---|
| 1 | `orchestrator.js` `#beginPayment` + `payment.service.js` `charge()` | a duplicate charge request returns the existing row's state. If that row is stuck in **`CREATED`** (payment process crashed after insert, before calling the provider), the saga's `else` branch treats `CREATED` as success → PAYMENT_AUTHORIZED → booking confirmed without a capture | seat issued unpaid; reconciliation flags `CONFIRMED_WITHOUT_PAYMENT` (👤) | treat any state other than CAPTURED/AUTHORIZED as UNKNOWN in the saga; let the resolver also pick up stale `CREATED` rows |
| 2 | `payment.service.js` header comment at `after_insert_before_charge` | says "the resolver will pick it up", but `resolver.worker.js` only scans `state = 'UNKNOWN'` | a `CREATED` row can sit forever | include `CREATED` older than N seconds in the resolver query |
| 3 | `payment.service.js` `charge()` / `resolveUnknown()` | the state transition and `#publish` (outbox) are **separate transactions**. The webhook path does both in one | a crash in between drops a `payment.*` event. Nothing consumes `payment.events` yet, so the impact is low today | do the transition and enqueue in one `withTransaction` |
| 4 | saga step deadlines vs lease | `HOLD_PENDING` 10 s, `CONFIRM_PENDING` 15 s, `PAYMENT_PENDING` 45 s are shorter than the 60 s lease. After a hard crash mid-step, the next worker sees the deadline passed and takes the timeout path instead of re-running the idempotent step | a crash inside confirm → refund while the allocation stays CONFIRMED (a seat is lost for resale); a crash inside payment → paymentId unknown → released while money may be captured (👤) | re-run idempotent steps before timing out, or record `paymentId` before calling, or add a "confirmed allocation without booking" reconciliation check |
| 5 | `reservation/src/index.js` cancel endpoint | moves in-flight sagas to `RELEASE_PENDING` from `CREATED / HOLD_PENDING / PAYMENT_PENDING`, but the trigger only allows `HOLD_CREATED → RELEASE_PENDING` | the trigger correctly refuses, and the API returns 500 instead of a friendly 409 | only allow cancel from HOLD_CREATED, or set a "cancel requested" flag the saga honours at the next safe point |
| 6 | `discovery/src/projection.js` `tick()` | HTTP calls to inventory and ES happen while the `dirty_events` transaction is open | bends Rule 2 (read-model DB, small batches, timeouts) | claim with a lease, commit, refresh, then delete |
| 7 | `notification/src/index.js` | the header says it consumes `payment.events`; the code subscribes only to `booking.events`. `booking.cancelled` is rendered but never produced | comment drift | update the comment, or emit `booking.cancelled` from the cancel path |
| 8 | `waiting-room.js` `status()` | `this.opts.admitIntervalMs ?? 1000 / 1000` parses as `admitIntervalMs ?? 1` (operator precedence) | only the ETA estimate is affected | `(this.opts.admitIntervalMs ?? 1000) / 1000` |
| 9 | reconciliation | `BOOKING_WITHOUT_ALLOCATION` and `ORPHAN_PAYMENT` are allowed `kind`s in the schema, but no check implements them | coverage gap | add the two checks (they would also catch #4) |
| 10 | gateway header comment | lists the order "rate limit → waiting room → auth", but the code runs load-shed → rate limit → **auth → waiting room** | comment drift only | fix the comment |

## 5. Improvements you could talk about (roadmap ideas)

- Fix the honest notes above (all small, local changes).
- Run the k6 flash-sale script and record results; measure a horizontal scaling curve
  (1, 2, 4 reservation workers).
- Read replicas for search; partition `allocations` by event date; archive old
  outbox and processed rows.
- A real payment provider adapter (the fake one stays for chaos tests).
- Avro or Protobuf + a schema registry with CI compatibility checks.
- Kubernetes on a real cluster, with PodDisruptionBudgets exercised during a rolling
  deploy.

Next: [07 · Glossary →](07-glossary.md)
