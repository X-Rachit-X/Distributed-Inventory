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
- 50 integration tests + 39 live end-to-end checks; Prometheus/Grafana,
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
| What if the worker dies mid-saga? | The saga is a row with a lease. Another worker resumes from the last committed state. Hold and confirm are idempotent, so if the dead worker's step deadline has passed, the step is simply re-run (up to its attempt limit) rather than timed out. Payment never re-charges: a lost charge response is recovered by looking the payment up by its idempotency key and asking the provider |
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

## 4. Code-review findings and what was done about them

Reading every file for these docs turned up places where the code and its comments
disagreed, or where an edge case wasn't closed. Fixing them turned up a few more.
**None could cause an oversell**: the constraint holds regardless. Every fix has a
test that fails on the old code and passes on the new.

This is a good interview story in its own right: *review → reproduce with a failing
test → fix → prove.*

### Found by reading the code

| # | Finding | Impact before | Fix | Proof |
|---|---|---|---|---|
| 1 | A replayed charge stuck in **`CREATED`** (payment process died before calling the provider) was treated by the saga as paid | seat issued with no payment | saga treats only CAPTURED/AUTHORIZED as paid; anything else goes to PAYMENT_UNKNOWN and is resolved by asking | test *a charge left in CREATED is never treated as paid* |
| 2 | The resolver only scanned `UNKNOWN`, although a comment said abandoned `CREATED` rows would be picked up | an abandoned charge sat forever | resolver also claims `CREATED` rows older than 120 s, moves them to UNKNOWN, asks the provider | test *the payment resolver settles charges abandoned in CREATED* |
| 3 | `charge()` / `resolveUnknown()` changed state and wrote the outbox event in **two** transactions | a crash between them dropped the event | `#transition` writes the state change and its event in one transaction | same test asserts exactly one event per change |
| 4 | Step deadlines (10–45 s) are shorter than the 60 s lease, so after a hard crash mid-step the next worker took the **timeout path** | crash in confirm → customer refunded while the seat stayed sold; crash in payment → paid customer released | hold and confirm re-run on deadline (they are idempotent) until their attempt limit; payment recovers a lost response by idempotency key | tests *re-runs the hold step…*, *re-runs the confirm step…*, *a charge whose response was lost…* |
| 5 | Cancelling an in-flight booking tried transitions the trigger forbids | HTTP 500 | cancel is a compare-and-swap from HOLD_CREATED only; otherwise a retryable **409 `BOOKING_IN_PROGRESS`** | e2e *cancelling mid-payment is refused with a retryable 409* |
| 6 | Discovery held a DB transaction open across HTTP calls | broke Rule 2 | refresh queue uses a lease (migration 012); no transaction spans the network | e2e *the refresh queue drains* |
| 7 | `booking.cancelled` was rendered by notification but never produced | no cancellation email | the confirmed-cancel path writes reservation, booking and the event in one transaction | e2e *the customer is told about the cancellation, once* |
| 8 | Waiting-room ETA: `admitIntervalMs ?? 1000 / 1000` parses as `?? 1` | wrong wait estimate whenever the interval was configured | parenthesised, with the interval as a real option | test *estimates the wait…* |
| 9 | `BOOKING_WITHOUT_ALLOCATION` and `ORPHAN_PAYMENT` were declared kinds with no check; nothing looked for a confirmed seat with no booking | gaps in the safety net | three new checks (eleven in total), all money-flagged → human | three new reconciliation tests |
| 10 | Gateway and notification header comments described a different order and a topic that wasn't consumed | misleading docs in code | comments corrected | — |
| 11 | `TIMED_OUT` was a saga state nothing could reach | dead complexity | removed by migration 011 | full suite |

### Found while fixing

| # | Finding | Impact before | Fix |
|---|---|---|---|
| 12 | **`npm run migrate` failed on any fresh database**: the shared `001` and inventory's `011` both created the audit trigger | a new clone could not set up | new migration `010a` that runs only on fresh installs (applied files stay untouched, as the project's rule requires) |
| 13 | The payment service's own resolver could settle a payment before the saga asked; the saga treated "not UNKNOWN" as unresolved | a correctly paid booking drifted to MANUAL_REVIEW | `resolveUnknown()` is idempotent: an already-settled payment returns its state |
| 14 | After resolving an UNKNOWN payment the saga never recorded `payment_id` on the reservation | reconciliation would raise a false `CONFIRMED_WITHOUT_PAYMENT` five minutes later | recorded in the same transaction as the step |
| 15 | Three services had no production check on the internal token, and config parsing silently produced `NaN` | weaker production safety | one shared config helper: validated numbers, secrets refused in production everywhere |
| 16 | Elasticsearch indexing ignored the circuit breaker search already respected | refreshes paid two timeouts each while ES was down | writes respect the breaker; resync re-indexes after recovery |

### Clean-up (no behaviour change)

`startRelay()` existed in three services, the config helper in eight, and
hand-rolled `fetch` + `AbortController` + timer in six places (some readiness
probes had no timeout at all). Each now has one shared implementation:
`startOutboxRelay()`, `@tessera/shared/src/config`, `@tessera/shared/src/http/client`.
The `.env` loader moved from inside the inventory service to the shared package.

### Still open (worth knowing)

- A charge request delayed in flight past the saga's 30 s timeout could create its
  payment row after the saga concluded "never started". Reconciliation's
  `PAYMENT_WITHOUT_BOOKING` check catches this for a human.
- Reconciliation checks sample up to 500 rows per pass, so at large scale an old
  issue can drop out of the sample and be marked "resolved itself".

## 5. Improvements you could talk about (roadmap ideas)

- Run the k6 flash-sale script and record results; measure a horizontal scaling curve
  (1, 2, 4 reservation workers).
- Read replicas for search; partition `allocations` by event date; archive old
  outbox and processed rows.
- A real payment provider adapter (the fake one stays for chaos tests).
- Avro or Protobuf + a schema registry with CI compatibility checks.
- Kubernetes on a real cluster, with PodDisruptionBudgets exercised during a rolling
  deploy.

Next: [07 · Glossary →](07-glossary.md)
