# API reference

> 📍 **Reference page:** endpoint and event shapes. To see how a booking moves through these endpoints, read [learn/02](learn/02-level2-how-it-works.md). New here? Start at the [docs home](README.md).

The browser talks only to the **gateway** on `:4000`, under `/api`. Everything
else is internal and requires the `x-internal-token` header.

Conventions:

- Errors: `{ "error": { "code": "…", "message": "…" } }`.
- **409 is expected under contention** ("someone else took that seat"). It is not a
  server fault. 429 = rate limited (honour `Retry-After`). 503 = shed or dependency
  down (retry shortly).
- Mutations take an `Idempotency-Key` header. Same key + same body → the original
  response replayed (`"replayed": true`). Same key + different body → 422.
- Read endpoints that return availability carry `as_of` and `authoritative: false`.
- Every response has `x-request-id`; pass `x-correlation-id` to thread a flow.

## Public API (gateway :4000)

### Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | `{ email }` | Demo sign-in. Returns `{ token, customerId, role }`. `ops@tessera.dev` gets `OPERATOR`. |

Send `Authorization: Bearer <token>` on authenticated routes.

### Discovery (no auth)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/search?from&to&date&class&train&departAfter&departBefore&arriveAfter&arriveBefore&minFare&maxFare&onlyAvailable` | Typo-tolerant. Returns trips with per-class availability and fares. Response also has `backend` (`elasticsearch`/`postgres`), `cache` (`L1`/`L2`/`MISS`/`COALESCED`), `ageSeconds`. |
| GET | `/api/stations?q=` | Station autocomplete. |
| GET | `/api/events` | Departures with live available counts. |
| GET | `/api/events/:eventId/span-points` | The stops of a journey, in order, with times. |
| GET | `/api/events/:eventId/availability?spanFrom&spanTo` | Per-class counts for a journey. |
| GET | `/api/events/:eventId/resources?spanFrom&spanTo` | Every seat with status `AVAILABLE/HELD/SOLD/BLOCKED` **for that span**. |
| GET | `/api/events/:eventId/adjacent?count&spanFrom&spanTo&class` | Candidate runs of N adjacent free seats. |

### Pricing (no auth)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/pricing/quote` | `{ eventId, items:[{resourceId, spanFrom, spanTo}] }` → fare per item with distance share and demand tier. Informational — the binding price is set server-side at reservation time. |
| GET | `/api/pricing/rules` | The tiers, for explaining a price. |

### Reservations (auth)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/reservations` | **Idempotency-Key required.** Body `{ eventId, items:[{resourceId, spanFrom, spanTo, passengerName?}], ttlSeconds? }`. Any `priceCents` sent is ignored. Returns **202** `{ reservationId, state:"PENDING", pollUrl, quote }`. The saga continues in the background. |
| GET | `/api/reservations/:id` | `{ state, progress, bookingReference, holdExpiresAt, items, settled }`. Poll until `settled`. Another customer's id → 404. |
| GET | `/api/reservations` | Your last 50. |
| POST | `/api/reservations/:id/cancel` | Idempotent. Confirmed → release inventory + refund. In flight → saga compensates. |
| GET | `/api/notifications` | Your notifications. |

Reservation `state`: `PENDING → HELD → AWAITING_PAYMENT → CONFIRMED`, or `FAILED` /
`CANCELLED` / `EXPIRED`. `progress` is a human sentence derived from the saga state.

### Waiting room (auth; enforced on reserve when `WAITING_ROOM_ENABLED=true`)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/waiting-room/:eventId/join` | `{ sessionId, ticket, position, aheadOfYou, rejoined }`. Rejoining keeps your place. |
| GET | `/api/waiting-room/:eventId/status` | `QUEUED` with position and estimated wait, or `ADMITTED` with a signed token. Send it as `x-waiting-room-token` on reserve. |
| POST | `/api/waiting-room/:eventId/leave` | Frees your slot. |

### Operations

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/ops/invariants` | public | Correctness invariants from the inventory DB. 500 only for CRITICAL/HIGH violations. |
| GET | `/api/ops/scoreboard` | public | Correctness counters from reconciliation. |
| GET | `/api/ops/discovery`, `/api/ops/notifications` | public | Consumer status: events processed, lag, staleness. |
| GET | `/api/ops/issues?status=open\|all` | OPERATOR | Reconciliation issues. |
| POST | `/api/ops/reconcile` | OPERATOR | Run a reconciliation pass now. |
| POST | `/api/ops/issues/:id/{resolve\|ignore\|retry}` | OPERATOR | `{ reason }` required; logged. |
| POST | `/api/ops/resources/:resourceId/block` | OPERATOR | `{ reason, spanFrom?, spanTo? }`. **409 if held or sold** — a customer's claim wins. |
| POST | `/api/ops/resources/:resourceId/unblock` | OPERATOR | `{ reason }`. |
| GET | `/api/ops/unresolved-payments` | OPERATOR | Payments in UNKNOWN. |
| POST | `/api/ops/provider-mode` | OPERATOR | `{ mode }` for the fake provider: `ok, decline, timeout_after_success, timeout_before_success, slow, error_after_success, duplicate_webhook, out_of_order_webhook`. |
| GET | `/api/ops/dead-letters` | OPERATOR | Notification DLQ. |
| POST | `/api/ops/dead-letters/replay` | OPERATOR | `{ ids? }` replays after a fix; dedupe makes it safe. |

## Internal APIs (service-to-service)

| Service | Method | Path | Called by |
|---|---|---|---|
| inventory | POST | `/internal/reserve` (Idempotency-Key) | reservation saga |
| inventory | POST | `/internal/confirm` | saga |
| inventory | POST | `/internal/release` | saga compensation |
| inventory | POST | `/internal/cancel-booking` | reservation cancel |
| inventory | GET | `/v1/events/:id/segment-availability` | discovery |
| inventory | POST | `/admin/resources/:id/{block,unblock}` | gateway (operator) |
| payment | POST | `/internal/charge` | saga |
| payment | POST | `/internal/payments/:id/resolve` | saga (UNKNOWN) |
| payment | POST | `/internal/payments/:id/refund` | saga / cancel |
| payment | POST | `/webhooks/provider` | the payment provider (HMAC-signed, raw body) |
| pricing | POST | `/v1/quote` | reservation |
| reconciliation | GET | `/v1/scoreboard`, `/v1/issues`, `/v1/runs` | gateway |
| notification | GET | `/v1/notifications`, `/v1/status`, `/admin/dead-letters` | gateway |
| discovery | GET | `/v1/search`, `/v1/stations`, `/v1/status`; POST `/admin/rebuild` | gateway |

Every service also serves `GET /health` (liveness: process only), `GET /ready`
(readiness: dependencies, draining), `GET /metrics` (Prometheus).

## Events (Kafka)

| Topic | Key | Types | Producer → consumers |
|---|---|---|---|
| `inventory.events` (6p) | event id | `inventory.held/confirmed/released/cancelled/expired/blocked/unblocked` v1 | inventory → discovery |
| `payment.events` (6p) | reservation id | `payment.captured/failed` v1 | payment → (analytics) |
| `booking.events` (6p) | reservation id | `booking.confirmed` **v2** (v1 upcast), `booking.cancelled` v1 | reservation → notification |
| `*.dlq` | original key | dead letters | consumers |

Envelope: `{ event_id, event_type, event_version, aggregate_id, aggregate_seq,
occurred_at, correlation_id, causation_id, trace_id, payload }`. Schemas in
`packages/shared/src/events/schemas.js`.

## How to explain the API in an interview

1. **"POST /reservations returns 202, not 201."** The reservation becomes durable in
   one fast transaction and a saga worker drives payment and confirmation. Holding a
   request open across a payment ties a connection and the user's patience to the
   slowest external system; a client that disconnects, a pod that restarts and a
   40-second provider all converge to the same place.
2. **"Idempotency-Key is mandatory on reserve."** The key is claimed atomically
   before any work, and the original response is stored and replayed — so a retry
   after a lost response returns the same reservation instead of taking a second
   seat. Keys are scoped to the caller.
3. **"409 is a success condition."** Under contention most reserve attempts should
   get 409. Clients must not blindly retry a 409; they should offer another seat.
4. **"Reads are labelled non-authoritative."** Availability and search carry
   `as_of`. The UI says the data may be stale. Only the reserve step decides.
5. **"The price in the request is ignored."** Server-side pricing is locked into the
   hold.
6. **"The public API has no internal ids of other customers."** Wrong owner → 404.
