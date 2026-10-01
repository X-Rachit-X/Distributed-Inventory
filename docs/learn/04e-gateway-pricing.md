# 04e · File by file — `services/gateway` and `services/pricing`

## Part 1 — Gateway (port 4000), the front door

```
gateway/src/
├── index.js          middleware chain + every public route
├── auth.js           hand-rolled HS256 JWT sign/verify
└── config/index.js   upstream URLs, secrets, limits, operator emails
```

The gateway is the **only** thing a browser can reach. That is why internal
services can trust the `x-customer-id` header it sets.

### The order a request meets the code (`src/index.js`)

```
request
  │ 0. createApp shell: request/correlation ids, request log, /health /ready /metrics
  │ 1. cors()                      allow-listed origins; preflight → 204
  │ 2. load shedding               event-loop lag > 500 ms → 503 LOAD_SHED, Retry-After 2
  │ 3. rate limiting (token bucket) per route bucket × identity → 429 + Retry-After
  │ 4. per-route: authenticate()   verify JWT → req.customerId, req.role
  │ 5. per-route: requireRole('OPERATOR') / requireAdmission (waiting room)
  │ 6. proxy(...)                  forward with internal token + identity + ids
  ▼
upstream service
```

Cheap rejections come first: rate limiting runs before JWT verification, so an
unauthenticated flood costs one Redis round trip instead of a crypto check.

### Walkthrough

| Lines | What | Why |
|---|---|---|
| 1-21 | comment: responsibilities and their order | |
| 49-56 | `new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy })` + error handler | **no offline queue**: a rate-limit check that answers 30 s late is worse than an immediate local decision |
| 58-68 | `TokenBucket`, `WaitingRoom` (max active, drip, session TTL from config) | |
| 70-75 | `AdmissionLoop` every 1 s, metric on admit | |
| 77-95 | readiness deps: reservation + inventory **critical**; **redis non-critical** | losing Redis costs acceleration, not correctness, so the instance stays in the load balancer |
| 97-112 | `cors()`: echo only allow-listed origins; allowed headers include `idempotency-key`, `x-waiting-room-token` | |
| 122-131 | load shedding middleware (skips health/metrics paths) | |
| 138-145 | `limitFor(path, method)`: auth / waitingRoom / search (GET events) / cancel / **reserve (POST reservations)** / availability (default) | the scarce operation gets the tightest budget |
| 147-179 | rate limit: identity = `user:<sha256(authorization) first 16>` or `ip:<ip>`; key `name:identity`; sets `x-ratelimit-limit/remaining` and `x-ratelimit-mode: degraded` when Redis is down; denied → 429 | |
| 196-211 | `POST /api/auth/login`: demo login by email → `customerId = cust-<hash(email)>` (stable, so the same user keeps their bookings); `role = OPERATOR` if the email is in `OPERATOR_EMAILS` (default `ops@tessera.dev`); sign a JWT (1 h) | deliberately minimal: the project is about inventory, not passwords |
| 213-226 | `authenticate(required)`: `Bearer` token → `verifyToken` → set `customerId`, `customerEmail`, `role` | |
| 235-242 | `requireRole(role)` → 403 | |
| 248-279 | waiting room: `join` (tracks the event in the admission loop), `status`, `leave`; session = `x-session-id` or customer id | |
| 287-305 | `requireAdmission`: only if `WAITING_ROOM_ENABLED`; verify the signed token **without Redis**, bound to `body.eventId`; invalid → 429 `WAITING_ROOM_REQUIRED` | users already inside survive a Redis outage |
| 318-359 | **`proxy(targetBase, rewrite)`**: `fetch` with timeout (`UPSTREAM_TIMEOUT_MS` 10 s), headers `x-internal-token`, `x-request-id`, `x-correlation-id`, `x-customer-id`, `x-actor` (the email, for audit logs), `idempotency-key`; **pass the upstream status through unchanged** (a 409 must stay a 409); copy `retry-after`; timeout → 503 | |
| 361 | `express.json()` | |
| 364-490 | the route table ↓ | |

### Route table

| Public route | → Upstream | Guard |
|---|---|---|
| `GET /api/events`, `/api/events/:id/{availability, span-points, resources, adjacent}` | inventory `/v1/...` | rate limit only |
| `POST /api/reservations` | reservation `/v1/reservations` | **auth + waiting room** |
| `GET /api/reservations`, `/api/reservations/:id`, `POST …/:id/cancel` | reservation | auth |
| `GET /api/search`, `/api/stations` | discovery | — |
| `POST /api/pricing/quote`, `GET /api/pricing/rules` | pricing | — |
| `GET /api/notifications` | notification | auth |
| `GET /api/ops/invariants`, `/scoreboard`, `/discovery`, `/notifications` | inventory / recon / discovery / notification | public read-outs (so anyone can see the correctness scoreboard) |
| `GET /api/ops/issues`, `/reconciliation-runs`; `POST /api/ops/reconcile`, `/issues/:id/:action` | reconciliation | **OPERATOR** |
| `POST /api/ops/resources/:id/block`, `/unblock` | inventory admin | **OPERATOR** |
| `GET /api/ops/unresolved-payments`, `POST /api/ops/provider-mode` | payment admin | **OPERATOR** |
| `GET /api/ops/dead-letters`, `POST /api/ops/dead-letters/replay` | notification admin | **OPERATOR** |

`qs(req)` rebuilds the query string. `main()` starts the admission loop and
`listen`s with graceful shutdown (stops the loop, quits Redis).

### `src/auth.js`, a JWT by hand

```js
signToken(claims, secret, ttl):
  header  = b64url({"alg":"HS256","typ":"JWT"})
  payload = b64url({...claims, iat: now, exp: now + ttl})
  sig     = HMAC-SHA256(secret, header + "." + payload) → base64url
  return header.payload.sig

verifyToken(token, secret):
  3 parts? → recompute sig → timingSafeEqual (length check first) → parse payload → exp > now? → claims
  any failure → null   (so a bad token is a 401, never a 500)
```
Hand-rolled on purpose so you can *see* what is verified. Production would use an
identity provider, and nothing downstream would change.

### `src/config/index.js`

Upstream URLs (4001-4007), `OPERATOR_EMAILS`, Redis URL, secrets
(`INTERNAL_TOKEN`, `JWT_SECRET`, `WAITING_ROOM_SECRET`), JWT TTL 3600 s, allowed
origins (Vite dev 5173 / preview 4173), upstream timeout 10 s, max event-loop lag
500 ms, waiting room **off by default** ("a waiting room in front of an uncontended
event is pure friction"), max active 100, drip 10, session 10 min. **Production
refuses any dev secret.**

---

## Part 2 — Pricing (port 4007)

`services/pricing/src/index.js`: one file, stateless.

| Lines | What | Why |
|---|---|---|
| 1-16 | comment: never trust client prices ("the classic way a booking system sells a first-class seat for one rupee"); caches availability for ~2 s because a 2-second-old demand tier is still correct | |
| 29-35 | config: port, inventory URL, cache TTL 2000 ms, quote validity 600 s | |
| 46-67 | **`cached(key, loader)` with single-flight**: fresh hit → return; otherwise if a load for this key is in flight, **return the same promise**; else start the load, store it in `inflight`, cache the result, and remove it from `inflight` in `finally` | prevents a cache stampede exactly when the system is busiest |
| 69-83 | `inventoryGet(path)`: 4 s timeout; 404 → NotFound; other non-OK → 503 | |
| 89-100 | `spanSnapshot(eventId, from, to)` (cached): `/resources` + `/availability` in parallel → maps `byClass`, `byId`, `byCode`, `spanMax` | everything needed to price one span |
| 121-183 | `POST /v1/quote`: validate (≤ 12 items, `spanTo > spanFrom`); per item: find the seat, class availability → **`fare()` from `@tessera/shared/src/pricing`**; return per-item `fareCents`, `basePriceCents`, `spanShare`, `tier {code,label,multiplier}`, `classAvailable/Total`, plus `quoteId`, `totalCents`, `validUntil` | a receipt can *explain* the price |
| 186-199 | `GET /v1/fare-rules`: the tiers, so the UI needn't hard-code them | |

Worked example with the seed data. The seed creates 8 stops at positions 0…7, so
`span_max = stops − 1 = 7` (and 7·8/2 = 28 stop pairs). Take a 3A seat with base
fare ₹1,960 (`196_000` paise), travelling stop 1 → stop 4, in a class that is 85%
full:

```
share = max(0.3, (4 − 1) / 7) = 0.4286
tier  = occupancy 0.85 → HIGH_DEMAND × 1.25
fare  = 196000 × 3/7 × 1.25 = 105,000 paise → ₹1,050
```

Next: [04f · Discovery, notification, reconciliation →](04f-discovery-notification-reconciliation.md)
