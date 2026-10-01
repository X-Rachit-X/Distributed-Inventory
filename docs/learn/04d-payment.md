# 04d · File by file — `services/payment` (money, with UNKNOWN)

> 📍 **Reference page:** look things up here, no need to read it top to bottom. Reading path: [01](01-level1-big-picture.md) → [02](02-level2-how-it-works.md) → [code](../README.md#step-3-read-the-code-in-the-order-a-booking-flows) → [03](03-level3-deep-dive.md) → [05](05-failure-scenarios.md) → [06](06-resume-and-interview.md) · [Docs home](../README.md) · [File map](04-file-map.md)

```
payment/
├── sql/migrations/010_payment_core.sql   payments, refunds, provider_events, signature_failures (+triggers)
├── src/index.js                          raw-body webhook route, internal API, operator API, resolver + relay
├── src/service/payment.service.js        ⭐ charge, resolveUnknown, handleWebhook, refund
├── src/providers/fake.provider.js        fault-injecting provider with its own "books"
├── src/workers/resolver.worker.js        resolves UNKNOWN payments
└── src/config/index.js                   refuses dev secrets in production
```

The idea in one picture:

```
Tessera ──charge──► provider
                    provider charges the card
        ◄── × network timeout
Tessera knows NOTHING.   Mark FAILED? → customer charged, no ticket.
                         Mark SUCCESS? → ticket that may be unpaid.
                         Retry?        → maybe charged twice.
Correct: record UNKNOWN, then ASK the provider (by our idempotency key).
```

---

## `sql/migrations/010_payment_core.sql`

| Lines | Object | Explanation |
|---|---|---|
| 1-27 | comment | "UNKNOWN is a state", plus the old bug: a bad signature moved the order to FAILED, so the real webhook arriving later was rejected and the customer was charged with no booking |
| 29-72 | `payments` | `amount_cents > 0`, `state` (CREATED, AUTHORIZED, CAPTURED, FAILED, CANCELLED, **UNKNOWN**, REFUND_PENDING, REFUNDED, PARTIALLY_REFUNDED), **`idempotency_key UNIQUE`** (one payment per key, enforced by the DB), `provider_ref`, `provider_payment_id UNIQUE`, resolver columns `unknown_since`, `resolve_attempts`, `next_resolve_at`. Partial index `payments_unknown_idx` = the resolver's work queue |
| 87-121 | `payment_transition_guard()` | CREATED→{AUTHORIZED, CAPTURED, FAILED, CANCELLED, UNKNOWN}; AUTHORIZED→{CAPTURED, FAILED, CANCELLED, UNKNOWN}; CAPTURED→REFUND_PENDING; UNKNOWN→{AUTHORIZED, CAPTURED, FAILED, CANCELLED}; REFUND_PENDING→{REFUNDED, PARTIALLY_REFUNDED, CAPTURED}; PARTIALLY_REFUNDED→{REFUND_PENDING, REFUNDED}. **FAILED has no exit.** Stamps `authorized_at`, `captured_at`, `unknown_since` automatically |
| 127-141 | `refunds` | separate rows (partial refunds keep history), `idempotency_key UNIQUE`, state incl. `UNKNOWN` |
| 145-166 | `refund_cannot_exceed_payment()` trigger | sum of non-failed refunds + the new one ≤ paid amount. A cross-row rule, which a CHECK can't express |
| 176-189 | `provider_events` | every webhook, **`UNIQUE (provider, provider_event_id)`** → replay protection + audit trail |
| 194-201 | `signature_failures` | forged/invalid webhooks are recorded here and **never** touch a payment |
| 207-221 | views `payments_awaiting_resolution`, `invariant_captured_without_reservation` | ops read-outs |

---

## `src/service/payment.service.js` ⭐

Header rules: (1) a timeout is not a failure, (2) a bad signature never moves a
payment, (3) every transition is guarded in SQL.

### `charge()` (lines 268-346)

| Step | Code | Why |
|---|---|---|
| validate | idempotency key required; amount > 0 | |
| claim | `INSERT payments (…) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, state` | the unique index is the atomic gate |
| duplicate | no row → `SELECT` the existing one → return `{paymentId, state, replayed: true}` | **never charge twice**. The saga's retry gets the same payment |
| commit first | the INSERT ran on the pool (auto-commit) **before** the provider call | a crash mid-call still leaves an attributable row |
| failpoint | `payment.after_insert_before_charge` | |
| call | `provider.charge({idempotencyKey, amount, currency, reservationId, mode})` | our key goes to the provider too |
| indeterminate error | `err.indeterminate` OR `PROVIDER_TIMEOUT` OR `httpStatus >= 500` → `#transition(CREATED → UNKNOWN, {failure_reason, next_resolve_at: +250ms})` → return `{state: 'UNKNOWN'}` | "Do NOT retry the charge — that is how a customer gets billed twice" |
| definite error | other errors → FAILED | |
| declined | `!result.ok` → FAILED + publish `payment.failed` | |
| success | `#transition(CREATED → result.state, {provider ids})` + publish `payment.captured` | |

### `resolveUnknown(paymentId)` (lines 354-415)

1. Load only if still `UNKNOWN` (else `{resolved: false, reason: 'not in UNKNOWN state'}`).
2. `provider.getStatus({idempotencyKey, providerPaymentId})`.
3. Provider unreachable → `resolve_attempts+1`, `next_resolve_at = now + min(300 s, 250 ms·2^attempts)` → `{resolved: false}`. **Never guess.**
4. `found: false` → no money moved → UNKNOWN → FAILED, publish `payment.failed`.
5. Otherwise map the provider's state (CAPTURED / AUTHORIZED / else FAILED) → transition + publish (with `resolved_from_unknown: true`).

### `handleWebhook({rawBody, signature, timestamp, sourceIp})` (lines 424-526)

| Step | Code | Why |
|---|---|---|
| verify | `provider.verify(rawBody, sig, ts)` | |
| bad → | `INSERT signature_failures …` then throw 400 `INVALID_SIGNATURE` | **deliberately not a payment transition** |
| record (in tx) | `INSERT provider_events … ON CONFLICT DO NOTHING RETURNING id` | dedupe by the provider's event id |
| duplicate | no row → `{status: 'duplicate'}` | |
| find payment | `SELECT … WHERE provider_payment_id = $1 FOR UPDATE` | lock it against a concurrent resolver/charge |
| not found | `{status: 'payment_not_found'}`, but the event row is kept | a webhook can outrun our own record |
| map type | `payment.captured` → CAPTURED, `payment.authorized` → AUTHORIZED, `payment.failed` → FAILED, else ignored | |
| out of order | current CAPTURED and the webhook says AUTHORIZED → mark processed, **skip** | don't walk backwards (the trigger would reject it anyway) |
| same state | mark processed, `already_in_state` | |
| apply | UPDATE state + mark processed + **outbox `payment.events` in the same transaction** | |

### `refund()` (lines 535-602)

1. Key required. Existing refund with this key → return it (`replayed`).
2. Payment must be CAPTURED or PARTIALLY_REFUNDED, else 409 `PAYMENT_NOT_REFUNDABLE`.
3. `INSERT refunds (INITIATED)`. The trigger blocks over-refunding.
4. Payment → REFUND_PENDING.
5. `provider.refund(...)`: success → refund COMPLETED, payment REFUNDED or
   PARTIALLY_REFUNDED. **Error → refund `UNKNOWN`, left for a human** ("a duplicate
   refund is a real loss").

### `#transition(id, from, to, fields)` (lines 616-644)

Builds `UPDATE payments SET state = $3 [, field = $n …] WHERE id = $1 AND state = $2`.
`rowCount 0` → log "state moved concurrently" and return `false`. **CAS again.**

### `#publish(paymentId, type, payload)` (lines 646-658)

Its own small transaction: `nextSeq(aggregate = reservation_id or payment id)` +
`enqueue('payment.events', …)`.

> 🔍 Note for the curious: in `charge()` and `resolveUnknown()` the state
> transition and `#publish` are **two separate transactions** (the webhook path does
> them in one). A crash exactly between them would update the payment but drop its
> event. Today nothing consumes `payment.events`, and reconciliation compares
> database state rather than events, so money correctness doesn't depend on it.
> It is still a small deviation from the "change + event in one tx" rule. See
> [06 · honest notes](06-resume-and-interview.md#4-honest-notes-from-reading-the-code).

---

## `src/providers/fake.provider.js`

Why a fake? Real sandboxes can simulate a decline, but **not** "charged then the
response was lost", duplicate webhooks, or out-of-order webhooks. Those are the
cases that break booking systems.

| Mode | Behaviour |
|---|---|
| `ok` | CAPTURED, webhook after 50 ms |
| `decline` | FAILED `card_declined` |
| `timeout_before_success` | deletes its own record (no money moved), throws a timeout |
| **`timeout_after_success`** | **CAPTURED, then throws a timeout**; webhook after 1.5 s. "The dangerous one" |
| `error_after_success` | CAPTURED, then throws HTTP 500 |
| `slow` | waits 40 s, then CAPTURED |
| `duplicate_webhook` | same captured webhook twice (same event id) |
| `out_of_order_webhook` | captured at 100 ms, authorized at 400 ms |

Implementation details:
- `this.charges` is the provider's **own books**, independent of our DB. That is
  what makes `getStatus` meaningful after a lost response.
- `charge()` with an existing idempotency key returns the **original** charge,
  like every real provider.
- `getStatus` looks up by provider id or by our idempotency key.
- `sign(rawBody, ts)` = `HMAC-SHA256(secret, "${ts}.${rawBody}")` in hex.
  `verify()` checks the timestamp is within 300 s, then `timingSafeEqual`.
- The webhook event id is a sha1 of `paymentId:eventType`, so duplicates really share
  one id.
- `#timeoutError()` sets `code PROVIDER_TIMEOUT` and `indeterminate: true`.

---

## `src/workers/resolver.worker.js`

- "The most important background worker": each row is money of unknown fate.
- `tick()`: a short transaction `SELECT id FROM payments WHERE state='UNKNOWN' AND
  (next_resolve_at IS NULL OR <= now()) ORDER BY unknown_since FOR UPDATE SKIP LOCKED
  LIMIT 20`. The lock is released when that tx ends, and the **provider calls happen
  outside it**.
- For each → `payments.resolveUnknown(id)`. Updates the `payment_unknown` gauge.
- Loop: 250 ms if it resolved something, else 2 s.

## `src/index.js`

| Route | Notes |
|---|---|
| `POST /webhooks/provider` | **`express.raw({type:'*/*'})`**, mounted on this route so the HMAC is computed over the exact bytes received (re-serialised JSON wouldn't match). Requires `x-tessera-signature` + `x-tessera-timestamp`. Always 200 for accepted events, **including duplicates**, so the provider stops retrying |
| `POST /internal/charge` | 201 new / 200 replayed |
| `POST /internal/payments/:id/resolve` | used by the saga |
| `POST /internal/payments/:id/refund` | |
| `GET /internal/payments/:id` | |
| `GET /admin/unresolved` | the UNKNOWN queue |
| `POST /admin/provider-mode` | switch fake-provider mode at runtime (chaos) |

At boot, `provider.onWebhook(...)` delivers the fake provider's webhooks straight
into `handleWebhook` (in production the provider would POST over HTTP; the handling
code is identical). Then the resolver and outbox relay start.

## `src/config/index.js`

Port 4003, pool 10, provider mode from `PAYMENT_PROVIDER_MODE`. **In production it
throws if the internal token or the webhook secret is still the dev default.**

Next: [04e · Gateway & pricing →](04e-gateway-pricing.md)
