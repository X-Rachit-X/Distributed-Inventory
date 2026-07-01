# ScaleRail — System Architecture

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Service Inventory](#2-service-inventory)
3. [Core Data Flows](#3-core-data-flows)
4. [Database Design](#4-database-design)
5. [Kafka Event Topology](#5-kafka-event-topology)
6. [Seat Locking Strategy](#6-seat-locking-strategy)
7. [Authentication & Security](#7-authentication--security)
8. [Search Architecture](#8-search-architecture)
9. [Segment Booking](#9-segment-booking)
10. [Deployment Topology](#10-deployment-topology)

---

## 1. System Overview

ScaleRail is a **microservices-based railway ticketing platform** designed around three core principles:

- **No shared databases** — each service owns its data schema
- **Async where possible** — inter-service communication uses Kafka for post-payment flows
- **Idempotency** — every mutation operation is idempotent to handle retries safely

### High-Level Context Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                        Browser / Client                            │
│                React 18 + Vite · Tailwind · Zustand               │
└────────────────────────────┬───────────────────────────────────────┘
                             │ HTTPS
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                         API Gateway                                │
│     - JWT validation                                               │
│     - Request forwarding (http-proxy-middleware)                   │
│     - Rate limiting                                                │
│     - Internal secret injection (X-Internal-Secret header)        │
│     Port: 3000                                                     │
└────┬───────┬────────┬──────────┬──────────┬──────────┬────────────┘
     │       │        │          │          │          │
     ▼       ▼        ▼          ▼          ▼          ▼
  User   Booking   Search    Inventory  Payment    Admin
  Svc    Svc       Svc       Svc        Svc        Svc
  :3001  :3002     :3003     :3004      :3005      :3007
```

---

## 2. Service Inventory

### 2.1 API Gateway (`api-gateway/`)

**Responsibility**: Single ingress point. Validates JWTs, forwards requests to the appropriate downstream service, and injects `X-Internal-Secret` + `X-User-*` headers.

**Routes proxied**:

| Prefix | Target |
|---|---|
| `/api/users/*` | User Service |
| `/api/search/*` | Search Service |
| `/api/inventory/*` | Inventory Service |
| `/api/bookings/*` | Booking Service |
| `/api/payments/*` | Payment Service |
| `/api/admin/*` | Admin Service |

---

### 2.2 User Service (`user-service/`)

**Responsibility**: User registration (OTP-based), login, JWT issuance, refresh token rotation, profile management.

**Key design decisions**:
- OTP stored in Redis with a 10-minute TTL, not in the database
- Refresh tokens stored as HTTP-only `SameSite=Strict` cookies
- Access tokens are short-lived (15 min); refresh tokens last 7 days
- Device fingerprinting added to refresh tokens to detect theft

**Key dependencies**: PostgreSQL (user data), Redis (OTP + refresh token store), Kafka (produce notification events)

---

### 2.3 Booking Service (`booking-service/`)

**Responsibility**: Orchestrates the full booking lifecycle using a **saga pattern**.

**Booking states**:
```
INITIATED → SEATS_HELD → PAYMENT_PENDING → CONFIRMED
                      ↘                 ↘
                      FAILED          CANCELLED → REFUND_PENDING → REFUNDED
```

**Idempotency**: Every `POST /bookings` request requires a client-generated `idempotencyKey` (UUID). The service stores this key and returns the existing result if the same key is replayed.

**Key dependencies**: PostgreSQL, Kafka (produce booking events + consume payment events)

---

### 2.4 Inventory Service (`inventory-service/`)

**Responsibility**: Owns `seat_inventory` and `schedule` tables. Handles seat status management with Redis locking.

**Seat states**:
```
AVAILABLE → LOCKED (Redis TTL) → BOOKED
                             ↘ AVAILABLE (on timeout)
         → CANCELLED
```

**Segment awareness**: Each seat can track partial-route bookings via `from_sequence` / `to_sequence` columns, enabling multi-passenger overlap detection.

**Key dependencies**: PostgreSQL, Redis (seat locks), Kafka (consume booking events, produce inventory events)

---

### 2.5 Payment Service (`payment-service/`)

**Responsibility**: Creates Razorpay orders, verifies webhook signatures, emits payment events to Kafka.

**Payment flow**:
1. Booking Service calls Payment Service → creates Razorpay order
2. Frontend opens Razorpay checkout widget
3. User pays → Razorpay calls webhook
4. Payment Service verifies HMAC signature → emits `payment.completed` to Kafka
5. Booking Service consumes event → confirms booking

**Key dependencies**: PostgreSQL, Razorpay SDK, Kafka

---

### 2.6 Search Service (`search-service/`)

**Responsibility**: Elasticsearch-backed train search with fuzzy matching.

**Index**: `trains` index with station names, departure times, and seat summary denormalized for fast retrieval.

**Fuzzy search**: Uses Elasticsearch `multi_match` with `fuzziness: AUTO` — handles typos like "Mumbai" vs "Mumbay".

**Kafka consumer**: Listens to train/schedule updates from Admin Service to keep the index fresh.

**Key dependencies**: Elasticsearch 8.12, Kafka

---

### 2.7 Notification Service (`notification-service/`)

**Responsibility**: Pure consumer — listens to Kafka events and sends transactional emails.

**Events handled**:
- `notification.booking_confirmed` → sends booking confirmation email
- `notification.booking_cancelled` → sends cancellation email
- `notification.otp` → sends OTP email for registration

**Key dependencies**: Kafka, SMTP (Nodemailer)

---

### 2.8 Admin Service (`admin-service/`)

**Responsibility**: CRUD API for stations, trains, routes, and schedules. Also triggers Elasticsearch index updates via Kafka.

**Key dependencies**: PostgreSQL (shared admin schema), Kafka

---

## 3. Core Data Flows

### 3.1 User Registration

```
Browser
  │
  ├─ POST /api/users/auth/register/send-otp
  │     User Service: validates → stores OTP in Redis (10 min TTL) → publishes notification.otp
  │
  │  [Kafka] → Notification Service → sends OTP email
  │
  ├─ POST /api/users/auth/register/verify-otp
  │     User Service: reads Redis → matches OTP → creates user in Postgres → deletes OTP
  │
  └─ Response: { message: "Email verified" }
```

### 3.2 Train Search

```
Browser
  │
  └─ GET /api/search/trains?from=DEL&to=MUM&date=2025-01-15
       API Gateway → Search Service
       Search Service: Elasticsearch multi_match query
         → returns ranked train results with seat summaries
```

### 3.3 Booking Saga (Happy Path)

```
Browser
  │
  ├─ 1. GET /api/inventory/:scheduleId/seats
  │       Inventory Service: fetches seats, applies segment filter if needed
  │
  ├─ 2. POST /api/bookings  { scheduleId, seatIds, passengers, idempotencyKey }
  │       API Gateway → Booking Service
  │       Booking Service:
  │         a. Creates booking record (INITIATED)
  │         b. Calls Inventory Service (internal): lock seats in Redis + mark LOCKED
  │         c. Creates Razorpay order via Payment Service (internal)
  │         d. Updates booking to SEATS_HELD / PAYMENT_PENDING
  │         e. Returns { bookingId, paymentOrder: { gatewayOrderId, amount, keyId } }
  │
  ├─ 3. [Browser opens Razorpay Checkout]
  │
  ├─ 4. POST /api/payments/webhook  (Razorpay → Payment Service directly)
  │       Payment Service: verifies HMAC signature → emits payment.completed to Kafka
  │
  ├─ 5. [Kafka] payment.completed
  │       Booking Service consumer: updates booking → CONFIRMED
  │       Inventory Service consumer: marks seats BOOKED (removes Redis lock)
  │       Booking Service: emits notification.booking_confirmed
  │
  ├─ 6. [Kafka] notification.booking_confirmed
  │       Notification Service: sends confirmation email
  │
  └─ 7. Browser polls GET /api/bookings/:id → sees CONFIRMED status
```

### 3.4 Cancellation & Refund

```
Browser: DELETE /api/bookings/:id
  │
  Booking Service:
    ├─ Validates booking is cancellable (CONFIRMED / SEATS_HELD / PAYMENT_PENDING)
    ├─ Updates status → CANCELLED
    ├─ Calls Inventory Service: releases seat locks / marks seats CANCELLED
    ├─ Calls Payment Service: initiates Razorpay refund if payment was captured
    └─ Emits notification.booking_cancelled → email sent
```

---

## 4. Database Design

### User Service (PostgreSQL)

```sql
users
  id            UUID PRIMARY KEY
  first_name    VARCHAR
  last_name     VARCHAR
  email         VARCHAR UNIQUE
  password_hash VARCHAR
  is_verified   BOOLEAN
  created_at    TIMESTAMP

refresh_tokens
  id         UUID PRIMARY KEY
  user_id    UUID REFERENCES users
  token_hash VARCHAR
  expires_at TIMESTAMP
  revoked    BOOLEAN
```

### Booking Service (PostgreSQL)

```sql
bookings
  id               UUID PRIMARY KEY
  user_id          UUID
  train_id         UUID
  schedule_id      UUID
  train_name       VARCHAR
  train_number     VARCHAR
  departure_date   DATE
  status           ENUM (INITIATED|SEATS_HELD|PAYMENT_PENDING|CONFIRMED|FAILED|CANCELLED|REFUND_PENDING|REFUNDED)
  total_amount     INTEGER (paise)
  seat_count       INTEGER
  failure_reason   VARCHAR
  idempotency_key  VARCHAR UNIQUE
  from_station_id  UUID
  to_station_id    UUID
  from_seq         INTEGER
  to_seq           INTEGER
  created_at       TIMESTAMP

booking_seats
  id         UUID PRIMARY KEY
  booking_id UUID REFERENCES bookings
  seat_id    UUID
  seat_number INTEGER
  seat_type   ENUM
  price       INTEGER

booking_passengers
  id         UUID PRIMARY KEY
  booking_id UUID REFERENCES bookings
  name       VARCHAR
  age        INTEGER
  gender     ENUM
```

### Inventory Service (PostgreSQL)

```sql
trains
  id           UUID PRIMARY KEY
  name         VARCHAR
  number       VARCHAR UNIQUE
  total_seats  INTEGER

routes
  id           UUID PRIMARY KEY
  train_id     UUID REFERENCES trains

route_stations
  id               UUID PRIMARY KEY
  route_id         UUID REFERENCES routes
  station_id       UUID REFERENCES stations
  sequence_number  INTEGER
  arrival_time     TIME
  departure_time   TIME

schedules
  id             UUID PRIMARY KEY
  train_id       UUID
  route_id       UUID
  departure_date DATE
  status         ENUM (SCHEDULED|RUNNING|ARRIVED|CANCELLED)

seat_inventory
  id              UUID PRIMARY KEY
  schedule_id     UUID REFERENCES schedules
  seat_number     INTEGER
  seat_type       ENUM (SLEEPER|AC_3_TIER|AC_2_TIER|AC_FIRST|GENERAL)
  price           INTEGER
  status          ENUM (AVAILABLE|LOCKED|BOOKED|CANCELLED)
  from_seq        INTEGER   -- segment booking: locked from this sequence
  to_seq          INTEGER   -- segment booking: locked to this sequence
  booking_id      UUID
  locked_until    TIMESTAMP
  updated_at      TIMESTAMP
```

---

## 5. Kafka Event Topology

### Topics and Producers → Consumers

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Kafka Topics                                   │
├──────────────────────────┬──────────────┬───────────────────────────┤
│ Topic                    │ Producer     │ Consumer(s)               │
├──────────────────────────┼──────────────┼───────────────────────────┤
│ booking.created          │ Booking Svc  │ Inventory Svc             │
│ booking.confirmed        │ Booking Svc  │ Notification Svc          │
│ booking.cancelled        │ Booking Svc  │ Inventory Svc, Notif Svc  │
│ inventory.seats_held     │ Inventory Svc│ Booking Svc               │
│ inventory.seats_released │ Inventory Svc│ Booking Svc               │
│ payment.order_created    │ Payment Svc  │ Booking Svc               │
│ payment.completed        │ Payment Svc  │ Booking Svc               │
│ payment.failed           │ Payment Svc  │ Booking Svc               │
│ payment.refund_initiated │ Payment Svc  │ Booking Svc, Notif Svc    │
│ notification.otp         │ User Svc     │ Notification Svc          │
│ notification.*           │ Booking Svc  │ Notification Svc          │
│ train.upserted           │ Admin Svc    │ Search Svc                │
│ schedule.upserted        │ Admin Svc    │ Search Svc, Inventory Svc │
└──────────────────────────┴──────────────┴───────────────────────────┘
```

**Dead Letter Queue (DLQ)**: Every consumer wraps processing in a try/catch. On repeated failure (after retries), messages are routed to a `.dlq` topic for inspection via Kafka UI.

---

## 6. Seat Locking Strategy

Seat locking uses **Redis** to prevent race conditions during concurrent bookings:

### Lock lifecycle

```
1. User selects seats → frontend displays available seats
2. POST /bookings → Inventory Service acquires Redis lock for each seatId:
   SETEX seat:lock:{seatId} 600 {userId}  (10-minute TTL)
3. Seat status in Postgres updated: AVAILABLE → LOCKED
4. If payment succeeds → seat status: LOCKED → BOOKED (Redis lock removed)
5. If payment fails or times out → Redis TTL expires → background job resets seat to AVAILABLE
```

### Segment-aware locking

For partial-route bookings, a seat may be `BOOKED` for segment A→B but `AVAILABLE` for C→D. The inventory service checks segment overlap using `from_seq` / `to_seq` ranges:

```sql
-- A seat is unavailable for a requested segment [reqFrom, reqTo] if:
NOT (existing.to_seq <= reqFrom OR existing.from_seq >= reqTo)
```

---

## 7. Authentication & Security

### JWT Flow

```
Login → { accessToken (15min) } + Set-Cookie: refreshToken (7d, HttpOnly, SameSite=Strict)
  │
  ├─ accessToken stored in memory (Zustand store, never localStorage)
  ├─ All API calls: Authorization: Bearer <accessToken>
  │
  └─ On 401: Axios interceptor → POST /auth/refresh
               → new accessToken + rotated refreshToken cookie
               → Retry original request
```

### Internal Service Auth

All inter-service calls (Booking → Inventory, Booking → Payment) carry an `X-Internal-Secret` header injected by the API Gateway. Each downstream service validates this header to reject unauthenticated direct access.

### Razorpay Webhook Verification

```js
// Payment Service webhook handler:
const body = req.rawBody; // must be raw Buffer, not parsed JSON
const signature = req.headers['x-razorpay-signature'];
const digest = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
                     .update(body).digest('hex');
if (digest !== signature) throw new Error('Invalid webhook signature');
```

---

## 8. Search Architecture

### Elasticsearch Index: `trains`

```json
{
  "mappings": {
    "properties": {
      "trainId": { "type": "keyword" },
      "trainName": { "type": "text", "analyzer": "standard" },
      "trainNumber": { "type": "keyword" },
      "scheduleId": { "type": "keyword" },
      "fromStation": {
        "properties": {
          "stationId": { "type": "keyword" },
          "name": { "type": "text", "analyzer": "standard" },
          "code": { "type": "keyword" },
          "departure": { "type": "keyword" }
        }
      },
      "toStation": { "...same as fromStation..." },
      "departureDate": { "type": "date" },
      "seatSummary": {
        "properties": {
          "SLEEPER": { "type": "integer" },
          "AC_3_TIER": { "type": "integer" },
          "AC_2_TIER": { "type": "integer" },
          "total": { "type": "integer" }
        }
      }
    }
  }
}
```

### Query strategy

```
GET /api/search/trains?from=DEL&to=MUM&date=2025-01-15

→ Elasticsearch bool query:
  must: [
    { multi_match: { query: "DEL", fields: ["fromStation.name", "fromStation.code"], fuzziness: "AUTO" } },
    { multi_match: { query: "MUM", fields: ["toStation.name", "toStation.code"],   fuzziness: "AUTO" } },
  ]
  filter: [
    { term: { departureDate: "2025-01-15" } },    // if date provided
    { range: { "seatSummary.total": { gt: 0 } } } // only trains with seats
  ]
```

---

## 9. Segment Booking

ScaleRail supports **partial-route booking** — a user can board at any intermediate station and alight at another, not just the train's origin/destination.

### How it works

1. Search returns trains with `from.sequenceNumber` and `to.sequenceNumber` for the requested stations
2. Frontend stores these in Zustand (`fromStation`, `toStation`)
3. `GET /inventory/:scheduleId/seats?fromSeq=2&toSeq=5` — the Inventory Service filters seats based on segment overlap
4. `POST /bookings` — includes `fromStationId`, `toStationId`, `fromSeq`, `toSeq`
5. Booking record stores segment; seat lock stores the segment range

This means seats on the same coach can be sold multiple times for non-overlapping segments, maximizing train capacity.

---

## 10. Deployment Topology

### Local Development (Docker Compose)

```
docker-compose.yml provisions:
  postgres     → single Postgres instance, multiple databases
  redis        → Redis Stack (Redis + RedisInsight)
  zookeeper    → Kafka coordinator
  kafka        → Single-broker Confluent Kafka
  kafka-ui     → provectuslabs/kafka-ui
  elasticsearch → 8.12, single-node
  kibana        → 8.12
  pgadmin       → dpage/pgadmin4
```

### Production Recommendations

| Component | Recommendation |
|---|---|
| API Gateway | Horizontal scale behind Nginx/ALB |
| Microservices | Kubernetes Deployments (2+ replicas each) |
| PostgreSQL | AWS RDS Multi-AZ or CockroachDB |
| Redis | ElastiCache (Redis 7 Cluster Mode) |
| Kafka | Confluent Cloud or AWS MSK (3+ brokers) |
| Elasticsearch | Elastic Cloud or AWS OpenSearch (3-node) |
| Frontend | Vercel / Netlify / CloudFront + S3 |
| Secrets | AWS Secrets Manager / HashiCorp Vault |
| Observability | Datadog / Grafana + Prometheus |
