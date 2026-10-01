# 05 · Failure scenarios — "what happens if X breaks right here?"

> 📍 **Reading path:** [01](01-level1-big-picture.md) → [02](02-level2-how-it-works.md) → [code](../README.md#step-3-read-the-code-in-the-order-a-booking-flows) → [03](03-level3-deep-dive.md) → **[05 · you are here](05-failure-scenarios.md)** → [06](06-resume-and-interview.md) · [Docs home](../README.md)

The best way to understand a reliable system is to break it in your head. Each row
says **where it breaks**, **what state is left behind**, and **what brings it back
to correct**. Use this page to rehearse interview answers.

Legend: ✅ handled automatically · 👤 handled by a human via reconciliation ·
⚠️ known edge. Several rows here were ⚠️ until the fixes listed in
[06 §4](06-resume-and-interview.md#4-code-review-findings-and-what-was-done-about-them).

---

## 1. Contention (many people, one seat)

| Situation | What happens | Why it's safe |
|---|---|---|
| 1,000 requests for one seat | they queue on the seat's row lock (FIFO); the first inserts its allocation; the rest hit the exclusion constraint → 23P01 → **409** | ✅ the DB refuses the overlap |
| Two multi-seat requests {A,B} and {B,A} | both lock in sorted order (A then B), so one waits for the other | ✅ no deadlock cycle |
| Some code path forgets the row lock | slower (possible deadlocks get retried / 409), but **no oversell** | ✅ the constraint is the authority |
| Redis lock leaks a second request (lab E) | the constraint rejects it (seen once in 1,000) | ✅ |
| The browser shows "available" but the seat was just taken | the stale read is fine; reserve re-checks → 409 → UI offers another seat | ✅ reads aren't authority |
| Lock wait longer than 3 s | `lock_timeout` → error → fail fast instead of a 30-second spinner | ✅ bounded |

## 2. Retries and duplicates

| Situation | What happens | Safety |
|---|---|---|
| Browser retries `POST /reservations` after a lost response | same `Idempotency-Key` → **replay** of the stored 202 (`replayed: true`) | ✅ one reservation |
| Two identical retries arrive at the same instant | one wins the `INSERT … ON CONFLICT` claim; the other gets 409 `IN_PROGRESS` (retryable) | ✅ |
| Same key, different body | 422 | ✅ |
| Someone else's key | 422, and the other user's response is never revealed | ✅ |
| Saga re-runs the hold step after a crash | same key `saga:<id>:hold` → inventory replays the original hold | ✅ one hold |
| Saga re-runs the charge step | `payments.idempotency_key` UNIQUE → returns the existing payment; the provider is also keyed | ✅ one charge |
| Confirm called twice (saga retry, webhook) | hold already CONFIRMED → returns `alreadyConfirmed` | ✅ |
| Release / cancel / block called twice | each returns `alreadyTerminal` / `alreadyCancelled` / `alreadyBlocked` | ✅ |
| Kafka delivers an event twice | `processed_events` PK collision → `DUPLICATE`; notifications also have `UNIQUE(source_event_id, template)` | ✅ one email |
| Provider sends a webhook twice | `provider_events` UNIQUE → `duplicate`, still replies 200 | ✅ |

## 3. Process crashes at exact points (failpoints)

| Crash point (failpoint name) | Left behind | Recovery |
|---|---|---|
| `reserve.before_commit` | nothing (tx rolled back) | ✅ client/saga retries with the same key |
| `confirm.before_commit` | nothing | ✅ saga retries confirm |
| `expiry.after_claim_before_commit` | nothing; locks drop | ✅ the next sweep takes the same holds |
| `outbox.before_publish` | row PENDING with a 30 s lease | ✅ the lease expires and a relay republishes |
| `outbox.after_publish_before_mark` | event in Kafka, row still PENDING | ✅ republished → **duplicate** → consumers dedupe |
| `consumer.after_handle_before_commit` | tx rolls back (effect + marker gone), offset not committed | ✅ redelivered, processed fresh |
| after the consumer commits, before the offset commit | effect + marker committed | ✅ redelivery finds the marker → skipped |
| Saga worker stopped **gracefully** mid-flight (deploy) | leases released by `releaseLeases()` | ✅ another worker resumes at once; the step deadline hasn't passed, so it **re-runs the step**, and the idempotency keys make that safe |
| Saga worker **killed** after a *completed* step | saga in a stable state (e.g. HOLD_CREATED), lease until +60 s | ✅ lease expires → another worker continues (this is what the "abandoned mid-flight" test proves) |
| `saga.after_hold_before_commit` (killed **inside** the hold step) | hold exists in inventory; saga in HOLD_PENDING with a 60 s lease and a 10 s step deadline | ✅ the deadline has passed by the time the lease expires, but hold is idempotent, so the next worker **re-runs the step** (up to 3 attempts) and gets the same hold back. Only after the attempts run out does it time out to HOLD_FAILED |
| killed inside the payment step | saga PAYMENT_PENDING (45 s deadline) | ✅ timeout → PAYMENT_UNKNOWN, by design (a charge is never re-sent blindly). The saga looks the payment up by its idempotency key `saga:<id>:payment` and asks the provider: no row → nothing was charged → release; a row → resolved to CAPTURED or FAILED |
| `saga.after_confirm_before_commit` (killed **inside** the confirm step) | seat CONFIRMED in inventory; saga CONFIRM_PENDING (15 s deadline) | ✅ confirm is idempotent, so the next worker **re-runs it** (up to 5 attempts): inventory answers `alreadyConfirmed` and the booking is issued. If the attempts run out (inventory down for minutes) it refunds, and reconciliation's `ALLOCATION_WITHOUT_BOOKING` check flags the still-confirmed seat for a human 👤 |
| `payment.after_insert_before_charge` | payment row in `CREATED`, provider never called | ✅ a replayed charge returns `CREATED`, which the saga treats as **not paid** → PAYMENT_UNKNOWN. After 120 s the resolver treats the row as abandoned, asks the provider (no record) → FAILED → seat released |
| Any service gets SIGTERM (deploy) | — | ✅ readiness fails → 3 s drain → stop workers (release leases) → close pools |

## 4. Payment failures

| Situation | Path | Safety |
|---|---|---|
| Card declined | payment FAILED → saga PAYMENT_FAILED → RELEASE_PENDING → release hold → COMPENSATED; reservation CANCELLED | ✅ seat back on sale |
| **Provider charges, then times out** (`timeout_after_success`) | payment UNKNOWN → saga PAYMENT_UNKNOWN → `/resolve` asks the provider by our key → CAPTURED → saga PAYMENT_AUTHORIZED → confirm | ✅ **charged exactly once** (e2e check) |
| Provider timed out before the charge landed | UNKNOWN → resolve → `found: false` → FAILED → release | ✅ no money moved |
| Provider returns 500 after capture | treated as indeterminate → UNKNOWN → resolve → CAPTURED | ✅ |
| Provider unreachable for minutes | resolve retries with backoff `250 ms·2^n` (max 5 min); after 10 tries the saga → **MANUAL_REVIEW**; reconciliation `PAYMENT_UNKNOWN_TOO_LONG` | 👤 |
| The payment *service* doesn't answer the saga within 30 s (e.g. `slow` mode = 40 s) | saga marks PAYMENT_UNKNOWN without a paymentId → finds the payment by its idempotency key → "charge still in progress" → retries with backoff → once the provider answers, CAPTURED → booking confirmed | ✅ charged exactly once (e2e check). Rare gap: a request delayed past the timeout *before* creating its row → 👤 `PAYMENT_WITHOUT_BOOKING` |
| Paid, but the hold expired before confirm | confirm updates 0 rows → `HoldExpiredError` → REFUND_PENDING → refund → COMPENSATED | ✅ never a silent loss |
| Refund call fails / unclear | refund row UNKNOWN → saga MANUAL_REVIEW | 👤 no blind payout retry |
| Forged webhook | `signature_failures` row, 400, payment untouched | ✅ |
| Old (replayed) genuine webhook | timestamp > 300 s → rejected | ✅ |
| `authorized` webhook arrives after `captured` | skipped (`out_of_order_skipped`) | ✅ |
| Webhook arrives before our own payment row | `payment_not_found`, but the event row is kept | ✅ the charge response / resolver still settles it |

## 5. Infrastructure outages

| Down | Effect on booking | Effect elsewhere | Recovery |
|---|---|---|---|
| **Kafka** | none: bookings complete (saga uses HTTP + DB) | outbox rows pile up as PENDING; search and emails lag; `I6_outbox_backlog` warns (MEDIUM, not "corruption") | ✅ the relay drains when Kafka returns (931 events in a real outage, zero lost) |
| **Redis** | none | rate limiter falls back to per-instance limits (`x-ratelimit-mode: degraded`); waiting-room tokens still verify (stateless); search loses its L2 cache | ✅ |
| **Elasticsearch** | none | search answers from Postgres (`backend: postgres`); circuit retries ES every 10 s | ✅ |
| **Pricing** | new reservations get **503** (fail closed); in-flight sagas continue | | ✅ "nothing sold at an unknown price" |
| **Inventory** | holds/confirms fail → saga retries with jitter → after max attempts → onTimeout target (e.g. HOLD_FAILED, REFUND_PENDING) | readiness of reservation/gateway goes 503 | ✅ / 👤 |
| **Postgres (one service's DB)** | that service is not ready; liveness stays OK (**no restart loop**) | | ✅ when the DB returns |
| **Discovery refresher dies** | none | search gets stale (age is shown) | ✅ resync every 60 s |
| **Expiry sweeper dies** | none: lazy reap at reserve time keeps the TTL authoritative | seat maps show expired holds as available anyway (expiry is applied in queries) | ✅ reconciliation repairs leftovers |

## 6. Bad data / bugs

| Situation | Caught by |
|---|---|
| A code path writes an allocation without a ledger entry | `I4_ledger_drift` → reconciliation LEDGER_DRIFT (CRITICAL, investigate) |
| Someone tries `UPDATE allocations SET state='HELD'` on a CONFIRMED row | trigger: illegal transition |
| Someone inserts a CONFIRMED allocation directly | insert guard (migration 012) |
| Someone tries to "fix" the ledger with UPDATE | append-only trigger |
| A malformed event is produced | `validate()` in the outbox writer → the request fails before commit |
| A malformed / poison event is consumed | dead-lettered after 1 (bad JSON / schema) or 5 (handler error) attempts; partition keeps moving; replay after fix |
| A producer upgrades to v2 before consumers | consumers read their declared version; v1 → v2 upcast on the way in |
| A future migration weakens the constraint | `I1_overlapping_allocations` and `I7_duplicate_bookings` views catch overlaps independently |
| Editing an old migration file | runner refuses: checksum mismatch |
| Customer parks inventory with a script | max 6 items per reservation, max 12 held at once; rate limit 5 burst on reserve |
| Flash sale with 100k users | waiting room caps active users; load shedding at 500 ms lag |

## 7. Practice questions (answer them, then check above)

1. A user double-clicks Book. How many reservations are created? *(One: same idempotency key, from the console's `newIdempotencyKey()` per attempt.)*
2. The relay crashes after Kafka acknowledged but before `UPDATE … PUBLISHED`. What does the notification service do? *(Receives it twice, dedupes.)*
3. Why can't the saga just retry the charge on timeout? *(It might double-charge. It asks the provider instead.)*
4. Why is a Kafka outage a MEDIUM warning and not a failed health check? *(Inventory is still correct; events are only late.)*
5. Why doesn't reconciliation auto-refund a payment without a booking? *(Money repairs are hard to reverse; maybe the seat can still be honoured. A human decides.)*
6. What if the expiry sweeper is down for an hour? *(Nothing incorrect: lazy expiry + query-time expiry + reconciliation repair.)*

Next: [06 · Resume & interview →](06-resume-and-interview.md)
