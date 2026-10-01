# ScaleRail — Distributed Reservation & Inventory Infrastructure

> 📍 **History:** the original brief from the ScaleRail era. For what was actually built, use the reading path. New here? Start at the [docs home](../README.md).

You are the lead backend/distributed-systems engineer responsible for transforming an existing project called ScaleRail into a technically deep, production-oriented distributed reservation and inventory platform.

The existing project already has a strong architectural foundation:

* 7 microservices
* API Gateway
* Kafka
* booking saga
* Redis-based temporary seat holds
* PostgreSQL
* row-level locking
* Elasticsearch fuzzy search
* idempotent Razorpay payment handling
* automated refunds
* JWT authentication
* HTTP-only refresh cookies
* Docker

DO NOT throw this architecture away.

The existing weakness is primarily the USE CASE and engineering depth.

Transform it from:

"distributed ticket booking application"

into:

# ScaleRail — Distributed Reservation & Inventory Infrastructure

The central engineering problem is:

> How do we safely allocate scarce inventory to a very large number of concurrent users while preventing overselling, minimizing contention, handling payment failures, recovering from partial failures, maintaining consistent inventory, and remaining available during flash-sale-level traffic?

The resulting system must be useful as a generic reservation/inventory engine that can model:

* railway seats
* airline seats
* hotel rooms
* concert tickets
* appointments
* limited inventory
* rental resources

Railway ticketing remains the primary demo domain.

Do not merely rename classes from "Ticket" to "Inventory."

Actually redesign the domain around scarce-resource allocation.

---

# 1. MANDATORY RESEARCH FIRST

Before changing the implementation, research current open-source projects and engineering references.

At minimum study:

1. TanishqNegi4u/SeatLock
2. Abhics8/Ticket-Blitz
3. arunsah10/EventCart-Distributed-Inventory-Engine
4. Dancan254/tripsaga
5. MstfTurgut/hotel-reservation-system
6. relevant distributed inventory projects
7. relevant ticketing/reservation projects
8. relevant PostgreSQL concurrency implementations
9. relevant Redis reservation/locking implementations
10. relevant Kafka transactional-outbox implementations

Useful references include:

SeatLock:
https://github.com/TanishqNegi4u/SeatLock

TicketBlitz:
https://github.com/Abhics8/Ticket-Blitz

EventCart:
https://github.com/arunsah10/EventCart-Distributed-Inventory-Engine

TripSaga:
https://github.com/Dancan254/tripsaga

Hotel Reservation:
https://github.com/MstfTurgut/hotel-reservation-system

Study these for ideas such as:

* high-concurrency reservation
* PostgreSQL locking
* CAS/version-based concurrency
* database constraints
* reservation TTL
* waiting rooms
* transactional outbox
* Kafka
* idempotency
* compensation
* saga orchestration
* dead-letter queues
* observability
* load testing
* chaos testing
* reconciliation

For every useful idea create:

docs/research/<topic>.md

Document:

* reference project
* problem it solves
* architecture used by reference
* strengths
* limitations
* whether ScaleRail adopts it
* how ScaleRail modifies it
* tradeoffs
* implementation status

Never copy or lightly modify another repository.

Reference repository → understand → redesign → implement independently.

---

# 2. FINAL PRODUCT POSITIONING

The README must no longer describe ScaleRail as simply:

"ticket booking system."

Position it as:

> A distributed reservation and inventory platform engineered to maintain inventory correctness under extreme concurrent demand.

Primary demonstration:

> Thousands of users competing for a small amount of inventory.

Example:

1000 users
→ 100 seats

Expected:

exactly 100 successful reservations

never:

101

The system must prove this through automated load tests and database-level invariant verification.

Do NOT hardcode or invent impressive benchmark numbers.

Generate the numbers experimentally.

---

# 3. CORE ENGINEERING QUESTIONS

The project must answer these questions:

1. How do we prevent overselling?
2. What happens when 10,000 users request the same seat?
3. What happens when two API instances race?
4. What happens if Redis fails?
5. What happens if PostgreSQL fails?
6. What happens if Kafka fails?
7. What happens if payment succeeds but confirmation fails?
8. What happens if payment succeeds and the client times out?
9. What happens if the booking request is retried?
10. What happens if the reservation expires during payment?
11. What happens if the worker processing expiration crashes?
12. What happens if Kafka delivers an event twice?
13. What happens if an event arrives out of order?
14. What happens if inventory and booking state disagree?
15. How does the system recover?
16. How does it behave during a flash sale?
17. How do we protect the database from connection exhaustion?
18. How do we handle hot inventory?
19. How do we provide fairness during extreme demand?
20. How do we measure correctness rather than merely claim it?

---

# 4. FINAL ARCHITECTURE

Target architecture:

```
                     Clients
                        │
                        ▼
                 API Gateway
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    Authentication   Rate Limit   Waiting Room
         │              │              │
         └──────────────┼──────────────┘
                        │
                        ▼
               Search / Availability
                        │
                        ▼
              Reservation Service
                        │
           ┌────────────┼─────────────┐
           │            │             │
           ▼            ▼             ▼
      Inventory       Pricing       Idempotency
        Engine
           │
    ┌──────┴──────┐
    │             │
PostgreSQL      Redis
```

authoritative    acceleration/
state          temporary state
│
▼
Transactional Outbox
│
▼
Kafka
│
┌──────┼──────────┬─────────────┐
▼      ▼          ▼             ▼
Payment Saga   Notifications   Analytics   Reconciliation
│
▼
Payment Service
│
▼
Compensation / Refund

Observability:

Prometheus
Grafana
OpenTelemetry
Distributed tracing

---

# 5. IMPORTANT ARCHITECTURAL RULE

PostgreSQL is authoritative for inventory correctness.

Redis is NOT the final source of truth.

Redis may accelerate:

* temporary holds
* rate limiting
* waiting-room state
* availability caching
* distributed coordination where justified

But the design must remain correct if Redis is unavailable.

This is critical.

Do not create a system where:

Redis says seat available
but
PostgreSQL says seat sold.

Define the source of truth for every piece of state.

---

# 6. DOMAIN REDESIGN

Replace ticket-centric thinking with inventory-centric concepts.

Core entities:

Event
InventoryResource
ResourceGroup
Reservation
ReservationItem
Hold
Booking
Payment
Refund
Customer
WaitingRoomEntry
InventoryLedger
OutboxEvent
Saga
IdempotencyRecord
ReconciliationIssue

For railway mode:

Event:
Train Journey

InventoryResource:
Seat

ResourceGroup:
Coach

For hotel mode:

Event:
Stay

InventoryResource:
Room

For concert mode:

Event:
Concert

InventoryResource:
Seat

The engine should be generic enough that inventory semantics are not hardcoded into railway-specific logic.

---

# 7. INVENTORY STATES

Implement an explicit state machine.

AVAILABLE
↓
HELD
↓
CONFIRMED

Alternative:

HELD
↓
EXPIRED
↓
AVAILABLE

Or:

HELD
↓
CANCELLED
↓
AVAILABLE

Or:

HELD
↓
PAYMENT_FAILED
↓
AVAILABLE

Never allow invalid transitions.

Examples:

AVAILABLE → CONFIRMED

must be invalid if the business flow requires a hold first.

HELD → HELD

should be idempotently handled.

CONFIRMED → AVAILABLE

should only occur through an explicitly supported cancellation/refund workflow.

---

# 8. TEMPORARY HOLD SYSTEM

A reservation should be two-phase.

Phase 1:

RESERVE

Seat:

AVAILABLE
→
HELD

with:

hold_id
reservation_id
expires_at

Phase 2:

CONFIRM

HELD
→
CONFIRMED

If timeout occurs:

HELD
→
EXPIRED
→
AVAILABLE

The TTL must be enforced by the authoritative system, not merely by Redis expiration.

Redis expiration may accelerate cleanup but cannot be the only correctness mechanism.

---

# 9. CONCURRENCY CORRECTNESS

Implement and compare multiple strategies.

Baseline intentionally unsafe version:

READ
→
CHECK AVAILABLE
→
UPDATE

Demonstrate why it fails.

Then implement the correct strategy.

Investigate:

1. PostgreSQL row locks
2. SELECT ... FOR UPDATE
3. SELECT ... FOR UPDATE SKIP LOCKED
4. optimistic version/CAS
5. database unique constraints
6. advisory locks where appropriate

Do not blindly combine every locking mechanism.

For each strategy document:

* correctness
* throughput
* lock contention
* failure behavior
* operational complexity

The database constraint should act as a final invariant where appropriate.

---

# 10. OVERSALE INVARIANT

Define a hard invariant:

For every inventory resource:

confirmed_count + valid_hold_count <= capacity

For a single seat:

confirmed bookings <= 1

For inventory quantity:

allocated quantity <= available capacity.

The load-test harness must query authoritative state after execution and assert these invariants.

---

# 11. CONTENTION SIMULATOR

This should become one of the signature features.

Build:

ScaleRail Contention Lab.

Scenarios:

10 users / 1 seat
100 users / 1 seat
1000 users / 1 seat
10000 users / 1 seat

Then:

1000 users / 10 seats

10000 users / 100 seats

Also:

1000 users / 1000 seats.

Measure:

* successful reservations
* failed reservations
* conflicts
* lock wait
* transaction latency
* p50
* p95
* p99
* throughput
* DB CPU
* connection utilization

Do not report invented results.

Store raw benchmark output.

---

# 12. HOT INVENTORY

Model:

One extremely popular train/event.

Example:

Train X:
100 seats

Traffic:

90% of all requests target Train X.

Detect:

hot inventory.

Measure:

* database contention
* connection pressure
* lock waits
* queue depth
* request latency

Implement mitigation strategies.

---

# 13. WAITING ROOM

Add a virtual waiting room.

Important:

Waiting room ≠ rate limiting.

Rate limiting protects against abusive request frequency.

Waiting room controls macro-level admission during demand spikes.

Flow:

User
↓
Waiting Room
↓
Admission
↓
Reservation system

Features:

* FIFO ordering
* admission rate
* maximum active users
* user position
* token/session
* reconnect
* expiration
* fairness

Optional advanced:

priority classes:

NORMAL
PREMIUM

But do not allow arbitrary priority abuse.

---

# 14. WAITING ROOM CORRECTNESS

The waiting room must be distributed-safe.

If 5 application instances exist:

only the correct number of users should be admitted.

Prevent:

double admission
lost position
duplicate admission
stale entries

Use atomic operations / transactions as appropriate.

Do not implement "check then update" races.

---

# 15. RATE LIMITING

Implement per-user and per-IP rate limiting.

Use token bucket.

Potential Redis Lua implementation:

token bucket state
+
atomic update.

Support:

* reserve endpoint
* confirm endpoint
* search endpoint
* waiting-room endpoint

Different limits may apply.

Document:

rate limiting
vs
waiting room
vs
capacity control.

---

# 16. IDEMPOTENCY

Every mutation endpoint must support an idempotency key.

Examples:

POST /reservations
Idempotency-Key: abc123

If the same request is retried:

return the original result.

Do not create another reservation.

Support:

* success replay
* failure replay
* in-progress state
* conflicting reuse
* TTL/cleanup

Store enough information to safely reproduce the original response.

---

# 17. IDEMPOTENCY FAILURE CASE

Simulate:

Client
→ reservation request
→ server commits
→ network response lost

Client retries.

The system must return:

original reservation

not:

second reservation.

---

# 18. TRANSACTIONAL OUTBOX

Implement:

BEGIN TRANSACTION

update inventory
create reservation
write outbox event

COMMIT

Then:

Outbox Relay
→ Kafka

Never do:

DB COMMIT
→ Kafka publish
as an unprotected dual-write.

Outbox states:

PENDING
PUBLISHED
FAILED
DEAD_LETTER

Include:

event_id
aggregate_id
event_type
payload
created_at
attempt_count

---

# 19. OUTBOX RELAY

Implement:

* batching
* retry
* exponential backoff
* jitter
* idempotent publishing
* event status
* poison-event handling

If Kafka is unavailable:

outbox remains pending.

Once Kafka recovers:

relay catches up.

Do not lose committed business events.

---

# 20. KAFKA DESIGN

Topics:

reservation.events
inventory.events
payment.events
booking.events
notification.events
reconciliation.events

Partition strategy must be intentional.

Possible key:

reservation_id

or:

inventory/event ID.

For resource ordering, choose a key that preserves ordering where business semantics require it.

Document why.

---

# 21. CONSUMER IDEMPOTENCY

Every event consumer must tolerate duplicate delivery.

Maintain:

event_id
consumer_id
processed status

or equivalent deduplication mechanism.

Do not claim Kafka provides application-level exactly-once semantics automatically.

Explain:

at-least-once
+
idempotent consumer
===================

effectively-once business effect.

---

# 22. DEAD LETTER QUEUE

Implement DLQ for:

* malformed events
* repeated processing failure
* schema validation failure
* poison messages

DLQ record:

event ID
original topic
partition
offset
failure reason
stack/error
attempt count
timestamp

Provide a replay mechanism after correction.

---

# 23. SAGA

Use Saga for cross-service workflow.

Reservation flow:

Create hold
↓
Payment authorization
↓
Confirm inventory
↓
Booking confirmed

Failure:

payment failed
↓
release hold

or:

payment succeeded
↓
confirmation failed
↓
compensation/refund

Do not use distributed 2PC.

---

# 24. SAGA ORCHESTRATOR

Prefer an explicit durable state machine.

Example:

CREATED
↓
HOLD_PENDING
↓
HOLD_CREATED
↓
PAYMENT_PENDING
↓
PAYMENT_AUTHORIZED
↓
CONFIRM_PENDING
↓
CONFIRMED

Failure:

PAYMENT_FAILED
↓
RELEASE_PENDING
↓
RELEASED
↓
COMPENSATED

The state machine must survive process crashes.

---

# 25. SAGA TIMEOUTS

Every asynchronous saga step gets:

* timeout
* retry policy
* maximum attempts
* compensation
* terminal failure state

Example:

Payment request sent.

No response for 30 seconds.

Do NOT simply assume payment failed.

Query payment state / use idempotent payment status resolution before compensation.

---

# 26. PAYMENT IDEMPOTENCY

Payment operations require their own idempotency key.

If:

charge request succeeds
but response is lost,

retry must not charge twice.

Payment service must maintain:

payment_id
idempotency_key
status
provider_reference

---

# 27. PAYMENT STATE MACHINE

Implement:

CREATED
→
AUTHORIZED
→
CAPTURED

Failure states:

FAILED
CANCELLED
REFUND_PENDING
REFUNDED

Define exact transitions.

---

# 28. RECONCILIATION ENGINE

This is a major feature.

Periodically compare:

Inventory
vs
Reservations
vs
Payments
vs
Bookings.

Detect:

* confirmed booking without payment
* payment without booking
* expired hold still allocated
* booking missing inventory allocation
* duplicate booking
* orphan payment
* stuck saga

Create:

ReconciliationIssue

with:

severity
entity
expected state
actual state
detected_at
repair status

---

# 29. AUTOMATED REPAIR

Only automate safe repairs.

Examples:

Expired hold still active:

release inventory.

Payment succeeded but booking missing:

investigate/retry confirmation.

Never blindly refund/confirm money-moving operations.

Financial reconciliation must be conservative.

---

# 30. INVENTORY LEDGER

Introduce an inventory ledger.

Every inventory transition creates an immutable record:

ALLOCATED
RELEASED
CONFIRMED
CANCELLED
EXPIRED
ADJUSTED

Example:

seat A1:

ALLOCATED +1
RELEASED -1
ALLOCATED +1
CONFIRMED +1

The ledger becomes an audit trail.

This helps investigate discrepancies.

---

# 31. AVAILABILITY MODEL

Separate:

authoritative inventory state

from:

availability read model.

For high-volume searches:

write model:
PostgreSQL

read model:
Redis / materialized view / Elasticsearch where appropriate.

Availability should eventually be consistent for search if necessary, but the reservation operation must revalidate against authoritative inventory.

Never trust cached availability during final allocation.

---

# 32. SEARCH

Keep Elasticsearch.

Expand it beyond station search.

Support:

* origin
* destination
* date
* departure window
* arrival window
* train/operator
* seat class
* availability
* price range

Search results are not authoritative inventory.

They are discovery data.

---

# 33. CACHE LAYERS

Implement carefully:

L1:
in-process cache

L2:
Redis

Authoritative:
PostgreSQL

Use caching for:

* train metadata
* station metadata
* schedules
* availability summaries
* configuration

Do NOT cache mutable seat ownership as the final source of truth.

---

# 34. CACHE INVALIDATION

When inventory changes:

PostgreSQL
→ outbox
→ Kafka
→ cache invalidation/update

This creates:

write
→ event
→ read-model update

Measure staleness.

Expose:

availability_cache_age

---

# 35. STALE AVAILABILITY

Make the UI aware that:

"available seats shown"

may be stale.

When booking:

recheck authoritative state.

This distinction should be explicitly documented.

---

# 36. RESERVATION EXPIRATION

Implement a sweeper.

But avoid:

every API instance independently scanning everything.

Use:

* database row claiming
* SKIP LOCKED
* distributed scheduling
* advisory transaction locks where justified

Multiple workers must not process the same expiration concurrently.

---

# 37. WORKER DESIGN

Workers:

Reservation Expiry Worker
Outbox Relay
Saga Worker
Reconciliation Worker
Notification Worker

Each must be:

* idempotent
* horizontally scalable
* crash recoverable

---

# 38. WORK QUEUES

Use Kafka where event streaming is appropriate.

Use database-backed work claiming where the workload is tightly coupled to PostgreSQL transactional state.

Do not force Kafka into every background job.

Document the choice.

---

# 39. CONCURRENCY STRATEGY COMPARISON

Build an experimental benchmark comparing:

A. naive SELECT + UPDATE

B. pessimistic row locking

C. SKIP LOCKED

D. optimistic version/CAS

E. Redis lock + DB constraint

F. PostgreSQL-native approach

For each measure:

* correctness
* throughput
* latency
* lock wait
* failure behavior

This becomes one of the strongest interview sections.

---

# 40. DO NOT CLAIM "REDIS LOCK IS THE SOLUTION"

The project should explicitly demonstrate:

Distributed locking is not automatically better than database-native concurrency control.

Use Redis locking only where it solves a real cross-instance coordination problem.

Inventory correctness must ultimately be protected by the authoritative database invariants.

This distinction is important because existing open-source implementations make different tradeoffs: TicketBlitz uses Redis + CAS + DB constraint, while SeatLock demonstrates a PostgreSQL-native approach. ScaleRail should experimentally compare these approaches rather than blindly selecting one.

---

# 41. FLASH-SALE MODE

Build:

ScaleRail Flash Sale Simulator.

Parameters:

users
inventory
arrival rate
burst duration
API instances
DB connections

Example:

50,000 simulated users
100 resources

Do not run huge tests against expensive cloud infrastructure without safeguards.

Start locally.

---

# 42. LOAD TESTING

Use:

k6

Scenarios:

1. normal booking
2. single-resource contention
3. high inventory
4. flash sale
5. repeated retries
6. client timeout
7. payment delay
8. Kafka outage
9. Redis outage
10. DB connection pressure

Collect:

* RPS
* success
* conflict
* timeout
* p50
* p95
* p99
* DB utilization
* Redis utilization
* Kafka lag

---

# 43. FAILURE INJECTION

Implement controlled failures:

* kill reservation service
* kill payment service
* kill worker
* stop Kafka
* stop Redis
* delay Kafka
* delay payment
* DB connection exhaustion
* network timeout
* duplicate events
* reordered events
* worker crash during expiration
* worker crash after DB commit
* worker crash before Kafka publish

For every failure:

Expected behavior
Actual behavior
Recovery
Data invariant

---

# 44. CHAOS SCENARIOS

Scenario:

Worker begins releasing hold.

Crash before commit.

Expected:

transaction rolls back.

Scenario:

DB commit succeeds.

Worker crashes before response.

Expected:

retry is idempotent.

Scenario:

Outbox row committed.

Relay crashes before Kafka publish.

Expected:

row remains pending and is retried.

Scenario:

Kafka publish succeeds.

Relay crashes before marking published.

Expected:

duplicate event possible.

Consumer must safely deduplicate.

---

# 45. DISTRIBUTED TRACING

Trace:

Client
→ Gateway
→ Search
→ Reservation
→ PostgreSQL
→ Outbox
→ Kafka
→ Payment
→ Saga
→ Confirmation

Use:

OpenTelemetry.

Every booking should have:

trace_id
reservation_id
saga_id
idempotency_key

where appropriate.

---

# 46. METRICS

Expose:

booking_attempts_total
booking_success_total
booking_conflict_total
reservation_expired_total
reservation_hold_duration
payment_failure_total
saga_compensation_total
outbox_pending
outbox_publish_latency
kafka_consumer_lag
inventory_conflicts
lock_wait_duration
db_pool_usage
redis_latency
waiting_room_depth
waiting_room_admission_rate
reconciliation_issues
cache_hit_rate

---

# 47. SLO-STYLE METRICS

Define hypothetical service objectives without claiming production guarantees.

Examples:

booking API latency
search latency
reservation success/error rate
event processing lag
reconciliation freshness

Measure actual behavior.

---

# 48. SECURITY

Implement:

* JWT authentication
* refresh-token security
* RBAC
* request validation
* rate limiting
* idempotency
* payment webhook signature validation
* replay protection
* audit logs
* secret management
* PII minimization

Never trust payment callbacks without cryptographic verification.

---

# 49. AUDIT LOG

Record:

who
what
when
resource
old state
new state
request ID
trace ID
service
reason

Examples:

seat held
seat released
seat confirmed
payment authorized
refund issued
admin inventory adjustment

---

# 50. ADMIN INVENTORY ADJUSTMENT

Add controlled administrative operations.

Example:

train operator discovers:

Seat A12 is damaged.

Admin:

A12
AVAILABLE
→
BLOCKED

Later:

BLOCKED
→
AVAILABLE

Every adjustment requires:

* authorization
* reason
* audit event

This makes the system much more realistic.

---

# 51. INVENTORY ADJUSTMENT CONFLICT

What happens if:

seat is held
and admin tries to block it?

Define policy.

Possible:

reject adjustment

or:

allow only after hold expires/cancels.

Never leave undefined behavior.

---

# 52. FAIRNESS

During flash sales, prevent one client from monopolizing the inventory.

Combine:

* waiting room
* per-user rate limits
* reservation TTL
* maximum concurrent holds
* idempotency

Track:

holds per user
active reservations
request rate

---

# 53. ANTI-BOT / ANTI-SCALPING SIGNALS

Do NOT claim sophisticated fraud detection unless actually implemented.

Implement basic signals:

* excessive request rate
* repeated failed reservations
* suspicious concurrency
* excessive account creation
* repeated seat churn

Feed signals into a risk score.

Optionally integrate a simple rules engine.

---

# 54. INVENTORY ALLOCATION ALGORITHMS

For generic quantity inventory:

support:

FIFO allocation

For seats:

explicit seat selection.

For hotel-style inventory:

resource allocation by date range.

Optional advanced:

best-available seat allocation.

Example:

User requests:

2 adjacent seats.

System searches:

same coach
→ adjacent seats
→ class preference
→ availability

This creates a non-trivial allocation algorithm.

---

# 55. ADJACENCY / SEAT ALLOCATION

Represent seat topology.

Example:

A1 A2 A3 A4
B1 B2 B3 B4

Request:

2 seats together.

Find:

A1,A2

instead of arbitrary available seats.

Benchmark allocation under high contention.

---

# 56. INVENTORY RESERVATION FOR MULTI-RESOURCE REQUESTS

Example:

booking requires:

Seat A12
+
Meal M1
+
Luggage L1

All-or-nothing.

Use a local transaction where resources share a DB boundary.

Across services:

Saga.

This demonstrates the distinction between:

local ACID transaction
vs
distributed saga.

---

# 57. PRICING

Keep pricing service separate.

Support:

base price
class multiplier
dynamic availability tier

Optional:

demand-based pricing simulator.

Do not build a complex real-world airline pricing engine.

---

# 58. EVENT SCHEMAS

Define versioned events.

Example:

ReservationCreated.v1

Fields:

event_id
event_version
reservation_id
resource_id
customer_id
quantity
timestamp
correlation_id

Never create undocumented arbitrary JSON events.

---

# 59. SCHEMA EVOLUTION

Support:

v1
→
v2

Consumers should not instantly break.

Research:

Schema Registry / Avro / Protobuf.

Use a schema strategy appropriate for the existing Kafka architecture.

---

# 60. API DESIGN

Expose:

POST /search
GET /availability
POST /reservations
GET /reservations/:id
POST /reservations/:id/confirm
POST /reservations/:id/cancel
GET /bookings/:id
GET /waiting-room/status
POST /payments/webhook

Admin:

POST /inventory/:id/block
POST /inventory/:id/unblock
GET /reconciliation/issues
POST /reconciliation/:id/retry

---

# 61. API IDEMPOTENCY

Mutation endpoints:

POST /reservations
POST /confirm
POST /cancel

must support idempotency.

Payment webhook processing must also be idempotent.

---

# 62. DATABASE DESIGN

Use PostgreSQL as authoritative transactional store.

Tables should include concepts such as:

inventory
inventory_holds
reservations
reservation_items
bookings
payments
refunds
outbox_events
idempotency_keys
saga_instances
inventory_ledger
reconciliation_issues
waiting_room_entries

Use:

* indexes
* unique constraints
* foreign keys
* check constraints

where they enforce real invariants.

---

# 63. DATABASE CONSTRAINTS

Examples:

unique confirmed reservation for a unique seat/event.

Check:

quantity > 0

Check:

expires_at > created_at

Foreign keys:

reservation → customer

reservation_item → inventory

Use DB constraints as defense-in-depth.

---

# 64. TRANSACTION BOUNDARIES

Document every transaction.

Example:

Reserve:

BEGIN
→ lock inventory
→ validate availability
→ create hold
→ update inventory
→ insert outbox
COMMIT

Do NOT:

BEGIN
→ call payment provider
→ wait 5 seconds
→ Kafka
→ external service

inside the DB transaction.

Keep transactions narrow.

---

# 65. CONNECTION POOL PROTECTION

Measure:

* pool size
* queue time
* active connections
* idle connections

Do not hold DB connections while waiting on:

* payment
* Kafka
* HTTP
* WebSocket

This is a major production concern.

---

# 66. READ/WRITE SEPARATION

If read replicas are used:

search/read model
→ replica/cache

authoritative reservation
→ primary

Never perform final inventory allocation using a stale replica.

---

# 67. RECONCILIATION DASHBOARD

Show:

Total inventory
Confirmed
Held
Expired
Available

And:

Payment mismatch
Saga mismatch
Outbox backlog
Stuck holds
Reconciliation issues

This gives the project a strong operational component.

---

# 68. EXPERIMENTAL "CORRECTNESS LAB"

Build a UI/CLI that lets an interviewer run:

Scenario:

1000 users
10 seats

Strategies:

naive
row lock
CAS
Redis lock
hybrid

Then show:

successes
oversells
latency
lock contention

This is one of the strongest features of the project.

The point is not just:

"I know concurrency."

It is:

"I built an experiment that demonstrates why these concurrency strategies behave differently."

---

# 69. CHAOS LAB

Similarly expose:

Kill worker
Stop Kafka
Stop Redis
Delay payment
Crash reservation service

Then show:

system state
saga state
inventory state
recovery

---

# 70. TESTING

Unit tests:

* state machines
* allocation
* idempotency
* pricing
* compensation

Integration tests:

* PostgreSQL
* Redis
* Kafka

Use Testcontainers where practical.

End-to-end:

search
→ reserve
→ payment
→ confirm
→ booking.

---

# 71. CONCURRENCY TESTS

Test:

100 threads same seat

Expected:

1 success
99 conflicts

Then:

1000 requests / 10 seats

Expected:

10 successful allocations.

After test:

query DB.

Assert invariant.

Never rely only on HTTP response counts.

---

# 72. PROPERTY TESTS

Generate:

random resource IDs
random reservation attempts
random retries
random failures

Properties:

never oversell
never confirm expired hold
idempotent retries
released inventory becomes available
confirmed inventory cannot be double-allocated.

---

# 73. LOAD TEST DATA

Generate:

* users
* events
* seats
* routes
* trains
* schedules

Support reproducible seeds.

Every benchmark should state:

seed
workload
environment
commit.

---

# 74. PERFORMANCE REGRESSION

Store benchmark results.

Compare commits.

Detect:

* increased p99
* decreased throughput
* increased DB connections
* increased Kafka lag

Do not optimize only average latency.

---

# 75. DEPLOYMENT

Local:

Docker Compose.

Production-shaped:

Kubernetes.

Services:

gateway
search
reservation
inventory
payment
saga
workers

Infrastructure:

PostgreSQL
Redis
Kafka

Observability:

Prometheus
Grafana
OpenTelemetry

Do not claim production readiness merely because Kubernetes manifests exist.

---

# 76. HORIZONTAL SCALING

Reservation service must be stateless.

Scale:

reservation-service × N

inventory correctness remains intact.

Run:

1 instance
3 instances
5 instances

under contention.

Verify no overselling.

---

# 77. KAFKA CONSUMER SCALING

Workers use consumer groups.

Test:

1 consumer
3 consumers
5 consumers

Measure:

event processing throughput
lag
rebalance time

---

# 78. REDIS FAILURE MODE

Stop Redis.

System should:

* continue authoritative booking if architecture permits
* degrade gracefully
* disable acceleration
* avoid accepting unsafe state

If Redis is required for a particular feature, fail that feature safely rather than silently violating inventory correctness.

---

# 79. KAFKA FAILURE MODE

Stop Kafka.

Existing committed transactions must remain safe.

Outbox accumulates.

When Kafka returns:

relay catches up.

No committed business state should disappear because Kafka was temporarily unavailable.

---

# 80. PAYMENT FAILURE MODE

Payment fails.

Saga:

payment failed
→ release hold
→ reservation cancelled
→ inventory available

Verify through automated tests.

---

# 81. PAYMENT SUCCESS / CONFIRMATION FAILURE

Payment succeeds.

Booking confirmation fails.

Saga must determine payment state and perform correct compensation/retry.

Never simply issue duplicate charge/refund calls.

---

# 82. WORKER CRASH

Kill worker:

after DB commit
before event publish

or:

after event publish
before marking processed.

The system must converge correctly through idempotency.

---

# 83. DATA REPAIR

Create admin repair workflows.

Never manually edit production-like rows.

Repairs should generate audit events.

---

# 84. SECURITY REVIEW

Perform threat modeling for:

* double booking
* payment replay
* idempotency abuse
* JWT theft
* webhook forgery
* rate-limit bypass
* waiting-room manipulation
* privilege escalation
* inventory manipulation
* event injection

Document mitigations.

---

# 85. FINAL OBSERVABILITY

Dashboard sections:

1. Booking traffic
2. Inventory
3. Contention
4. Waiting room
5. Kafka
6. Saga
7. Payments
8. Reconciliation
9. Database
10. Redis
11. Traces
12. Load tests
13. Chaos tests

---

# 86. FINAL BENCHMARK SUITE

Produce reproducible benchmark scenarios:

BENCH-001
single-seat contention

BENCH-002
multi-seat contention

BENCH-003
flash sale

BENCH-004
high availability

BENCH-005
payment delay

BENCH-006
Kafka outage

BENCH-007
Redis outage

BENCH-008
worker crash

BENCH-009
large search workload

BENCH-010
cache-heavy workload

For each:

environment
commit
workload
result
interpretation.

---

# 87. FINAL ARCHITECTURE DOCUMENTATION

Produce:

README.md

ARCHITECTURE.md

CONCURRENCY.md

INVENTORY.md

SAGA.md

IDEMPOTENCY.md

OUTBOX.md

KAFKA.md

FAILURES.md

RECONCILIATION.md

OBSERVABILITY.md

BENCHMARKS.md

SECURITY.md

PROJECT_INTERVIEW.md

---

# 88. PROJECT INTERVIEW BIBLE

The final interview document must allow the developer to answer:

1. Why did you change the original ticket-booking project?
2. What is the actual hard problem?
3. What is the source of truth?
4. How do you prevent overselling?
5. Why PostgreSQL?
6. Why Redis?
7. Why isn't Redis the source of truth?
8. Why Kafka?
9. Why Saga?
10. Why not 2PC?
11. Why transactional outbox?
12. How do you handle duplicate events?
13. What happens if Kafka dies?
14. What happens if Redis dies?
15. What happens if PostgreSQL dies?
16. What happens if payment succeeds but booking fails?
17. What happens if a request is retried?
18. How does idempotency work?
19. How does reservation expiration work?
20. How do multiple workers avoid processing the same hold?
21. Why SKIP LOCKED?
22. Why optimistic vs pessimistic locking?
23. How does the waiting room work?
24. Why is a waiting room different from rate limiting?
25. How do you handle hot inventory?
26. How do you scale horizontally?
27. How do you handle stale cache?
28. How do you reconcile inconsistent state?
29. How do you test concurrency?
30. How do you prove zero overselling?
31. What are the system's consistency guarantees?
32. What are the failure modes?
33. What did your benchmarks show?
34. Which optimization helped?
35. Which optimization failed?
36. What would you change at 10× traffic?
37. What would you change at 100× traffic?

---

# 89. IMPORTANT IMPLEMENTATION RULE

Do not simply add features because they sound impressive.

For every feature use:

PROBLEM
→ REQUIREMENT
→ DESIGN
→ IMPLEMENTATION
→ TEST
→ BENCHMARK
→ FAILURE TEST
→ DOCUMENTATION

If a feature cannot be implemented correctly:

mark it:

RESEARCHED
DESIGNED
NOT IMPLEMENTED

Do not fake implementation.

---

# 90. FINAL DEFINITION OF DONE

ScaleRail is complete only when:

* reservation correctness is proven
* overselling tests exist
* concurrency experiments exist
* inventory state machine works
* temporary holds work
* expiration works
* idempotency works
* transactional outbox works
* Kafka events work
* consumers are idempotent
* DLQ exists
* Saga is durable
* compensation works
* payment failures are handled
* reconciliation works
* inventory ledger exists
* waiting room works
* rate limiting works
* caching works
* cache invalidation works
* search works
* hot inventory is measurable
* contention simulator works
* chaos tests work
* observability works
* load tests work
* Docker deployment works
* Kubernetes deployment is production-shaped
* documentation exists
* interview bible exists

The final system should be defensible as:

> "I transformed a conventional booking application into a distributed inventory-allocation platform and experimentally validated its correctness and behavior under concurrency, failures and flash-sale traffic."

Do not claim production scale unless experimentally demonstrated.

Do not copy reference repositories.

Do not invent benchmark results.

Do not replace PostgreSQL correctness with Redis convenience.

Prioritize:

CORRECTNESS
→ CONSISTENCY
→ FAILURE RECOVERY
→ OBSERVABILITY
→ PERFORMANCE
→ SCALABILITY
→ ADVANCED FEATURES.


Yes — but **I would add only a few final things**. I searched current comparable implementations and the interesting gap is that the strongest projects are increasingly proving correctness and failure behavior rather than merely accumulating technologies. ([GitHub][1])

Your ScaleRail is already very strong. I would add these **6 advanced features**:

### 1. Hot-inventory sharding / contention spreading ⭐⭐⭐⭐⭐

This is probably the biggest addition.

A single flash-sale item/seat can become a **hot key / hot row**.

Instead of:

```text
inventory:concert-123
        ↓
ONE extremely hot record
```

experiment with:

```text
concert-123
 ├── bucket-0
 ├── bucket-1
 ├── bucket-2
 ├── ...
 └── bucket-N
```

Then compare:

* single-key inventory
* bucketed inventory
* controlled queue
* PostgreSQL locking
* optimistic CAS

This lets you discuss **hotspot mitigation**, not just ordinary concurrency. Current inventory-system designs explicitly identify hot SKUs as a bottleneck and use techniques such as bucket sharding or controlled-throughput admission. ([SpaceComplexity][2])

---

### 2. Deadlock-safe multi-resource booking ⭐⭐⭐⭐⭐

Suppose a user books:

```text
2 adjacent seats
```

or:

```text
Flight seat + hotel room + rental car
```

Now multiple resources must be reserved atomically or compensated safely.

Introduce **deterministic resource ordering**:

```text
Sort resource IDs
      ↓
Acquire locks in fixed order
      ↓
Reserve
      ↓
Commit / compensate
```

This gives you a great interview topic:

> “How did you prevent deadlocks when a reservation required multiple inventory resources?”

Real reservation implementations explicitly use deterministic ordering to reduce deadlock risk. ([Shailesh Chaudhari's Blog][3])

---

### 3. UNKNOWN payment state ⭐⭐⭐⭐⭐

This is a subtle but **very impressive** addition.

Don't model payment as only:

```text
SUCCESS / FAILED
```

Add:

```text
INITIATED
AUTHORIZED
CAPTURED
FAILED
UNKNOWN
REFUNDED
```

Example:

```text
ScaleRail → Payment Provider
             ↓
          payment succeeds
             ↓
      network timeout
             ↓
ScaleRail doesn't know result
```

**Do NOT immediately retry payment.**

Instead:

```text
UNKNOWN
   ↓
reconciliation
   ↓
query payment provider
   ↓
SUCCESS / FAILED
```

This is a real distributed-systems failure boundary and makes your Saga/reconciliation story substantially better. A current commerce-system case study uses the same principle: a provider timeout after a committed authorization is represented as `UNKNOWN`, with reconciliation rather than blindly reauthorizing. ([Minh Pham][4])

---

### 4. Inventory ledger as a verifiable accounting system ⭐⭐⭐⭐⭐

You already have the ledger. Make it **mathematically useful**.

Every inventory mutation becomes an immutable event:

```text
ALLOCATED
RELEASED
CONFIRMED
EXPIRED
CANCELLED
ADJUSTED
```

Then periodically calculate:

```text
Initial inventory
+ additions
- allocations
+ releases
- confirmed sales
+ adjustments
=
expected state
```

Compare it against actual PostgreSQL state.

If:

```text
Ledger says: 97 available
DB says:     96 available
```

you have a reconciliation issue.

This transforms the ledger from “another table” into a **correctness mechanism**.

---

### 5. Backpressure + load shedding ⭐⭐⭐⭐

You already have:

* rate limiting
* waiting room
* Kafka
* connection pools

Add an explicit **backpressure strategy**.

For example:

```text
Traffic spike
    ↓
Gateway
    ↓
Admission control
    ↓
Queue
    ↓
Inventory workers
    ↓
PostgreSQL
```

When downstream capacity is exhausted:

```text
Don't keep accepting requests
          ↓
queue / reject / shed load
          ↓
Retry-After
```

Then benchmark:

```text
Without backpressure
vs
With backpressure
```

You can discuss **protecting the database rather than merely scaling it**.

---

### 6. Versioned event contracts + schema evolution ⭐⭐⭐⭐

Since ScaleRail uses Kafka heavily, make events versioned:

```text
reservation.created.v1
reservation.created.v2
payment.completed.v1
booking.confirmed.v1
```

Then demonstrate:

```text
Consumer v1
      ↑
Kafka event
      ↓
Producer v2
```

while maintaining backward compatibility.

Discuss:

* schema evolution
* backward compatibility
* event versioning
* consumer migration
* poison messages
* replay

This gives you another excellent Kafka interview topic.

---

## One more thing I'd add: a **Correctness Scoreboard**

This isn't a technology; it's what makes the whole project impressive.

Create a dashboard showing invariants such as:

```text
╔══════════════════════════════════╗
║      SCALERAIL CORRECTNESS       ║
╠══════════════════════════════════╣
║ Oversells              0         ║
║ Duplicate bookings     0         ║
║ Orphaned holds         0         ║
║ Ledger mismatches      0         ║
║ Unprocessed outbox     0         ║
║ DLQ messages           0         ║
║ Duplicate events       0         ║
║ Reconciliation issues  0         ║
╚══════════════════════════════════╝
```

Then intentionally attack the system with:

* 1,000 users → 1 seat
* duplicate requests
* duplicate Kafka events
* reordered events
* worker crashes
* Redis failure
* Kafka failure
* payment timeout
* DB connection exhaustion
* pod termination
* expired holds
* multi-resource contention

And have the system prove its invariants afterward.

Current projects in this space are already emphasizing concurrency proofs, chaos tests, idempotency and real infrastructure testing; your version can combine those ideas into a much broader correctness laboratory. ([GitHub][1])

### So the final ScaleRail should have this stack

**Core**
→ Distributed reservation/inventory engine

**Correctness**
→ PostgreSQL transactions + CAS + locks + constraints + inventory invariants

**Hotspot handling**
→ Hot-key detection + bucket sharding + admission control

**Distributed workflow**
→ Kafka + Outbox + Idempotent consumers + DLQ + replay + versioned events

**Transactions**
→ Durable Saga + compensation + payment `UNKNOWN` state + reconciliation

**Caching**
→ L1/L2 cache + invalidation + stampede protection + staleness measurement

**Fairness**
→ Virtual waiting room + rate limiting + anti-bot signals

**Reliability**
→ Expiry workers + retries + backoff + circuit breakers + backpressure

**Correctness Lab**
→ concurrency experiments + property tests + chaos + invariant verification

**Observability**
→ OpenTelemetry + Prometheus + Grafana + structured logs + trace correlation

**Performance**
→ k6 + contention benchmarks + p50/p95/p99 + lock waits + DB pool pressure + Kafka lag

**Advanced**
→ multi-resource reservations + deadlock avoidance + hot inventory sharding + schema evolution

**Operations**
→ Docker + Kubernetes + autoscaling + health/readiness + graceful shutdown

---

**I would stop here.** Seriously.

At this point, adding more things like Elasticsearch alternatives, another message broker, GraphQL, gRPC everywhere, another cache, another database, etc. would mostly make the project **larger rather than better**.

The goal now should be:

> **ScaleRail = a distributed inventory correctness + concurrency + transaction + failure-recovery laboratory that happens to have a railway/reservation product on top.**

That is a project you can spend **30–60 minutes defending deeply** instead of one where you spend 5 minutes listing technologies.

[1]: https://github.com/Abhics8/Ticket-Blitz?utm_source=chatgpt.com "GitHub - Abhics8/Ticket-Blitz: Distributed seat booking engine with 3-layer concurrency safety (Redis lock + CAS + DB constraint) — zero oversell proven by k6 race test · GitHub"
[2]: https://spacecomplexity.ai/blog/inventory-reservation-system-design-interview?utm_source=chatgpt.com "Design an Inventory Reservation System: The 45-Minute Walkthrough · SpaceComplexity"
[3]: https://shaileshchaudhari.vercel.app/blog/building-inventory-engine-never-oversells-concurrency?utm_source=chatgpt.com "Building an Inventory Engine That Never Oversells Under Concurrency | Shailesh Chaudhari"
[4]: https://minhpham06.com/projects/commercecore?utm_source=chatgpt.com "CommerceCore Case Study | Minh Pham"


