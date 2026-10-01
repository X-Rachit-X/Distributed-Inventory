# 07 · Glossary (A–Z)

One line each. → points to where it lives or where to read more.

| Term | Meaning |
|---|---|
| **2PC (two-phase commit)** | a protocol to commit across several databases at once. Deliberately *not* used: it holds locks across services. → saga |
| **202 Accepted** | "request stored, still being processed". Returned by `POST /reservations` |
| **409 Conflict** | expected contention ("someone else took it"). Not a fault |
| **23P01** | Postgres SQLSTATE for an exclusion-constraint violation, i.e. "oversell prevented" |
| **40P01** | Postgres SQLSTATE "deadlock detected" |
| **ACID** | Atomic, Consistent, Isolated, Durable: the guarantees of a DB transaction |
| **Adjacent seats** | "N seats together", found with the gaps-and-islands SQL trick → `availability.js findAdjacent` |
| **Admission control** | deciding whether to accept work at all (rate limit, waiting room, load shedding) |
| **Advisory lock** | an application-defined Postgres lock on a number. Used to serialise migrations |
| **Aggregate / aggregate_id** | the entity an event is about (a train run, a reservation). Also the Kafka partition key |
| **aggregate_seq** | a per-aggregate increasing number on each event, used to drop stale events |
| **Ajv** | the JSON Schema validator library used for event contracts |
| **Allocation** | a row saying "resource R is occupied over span S in state X". The core table |
| **Append-only** | a table whose rows can't be updated or deleted (enforced by trigger): ledger, audit, saga_steps, repair_log |
| **AsyncLocalStorage** | Node feature that carries per-request context (ids) through async calls, used by the logger |
| **At-least-once** | delivery that never loses messages but may duplicate them |
| **Audit log** | who did what to which entity and why |
| **Backoff (exponential, full jitter)** | waiting longer after each failure, randomised to avoid synchronised retries |
| **Barrier (starting)** | a promise all concurrent test workers await, so they really start together |
| **BLOCKED** | an allocation an operator created to withdraw a seat. Uses the same constraint |
| **btree_gist** | Postgres extension that lets a GiST index handle equality (`resource_id =`) |
| **Bucket (pool)** | one of N rows splitting a quantity counter, to avoid a hot row |
| **Bulkhead** | a cap on concurrent in-flight work, beyond which requests are shed → lab H |
| **CAS (compare-and-swap)** | `UPDATE … WHERE state = expected`. 0 rows means someone else changed it |
| **Causation id** | the id of the event that caused this event |
| **Circuit breaker** | stop calling a failing dependency for a while, use a fallback, then retry → discovery ES |
| **Coalescing** | merging many "train X changed" signals into one refresh |
| **Compensation** | the "undo" step of a saga (release a hold, refund a payment) |
| **Consumer group** | Kafka consumers sharing a topic's partitions |
| **Consumer lag** | how many messages a consumer is behind the end of the topic |
| **Correlation id** | one id following a business flow across services, logs and events |
| **CQRS / read model / projection** | a separate, query-optimised copy of data (discovery) |
| **Dead letter / DLQ** | where poison messages are parked for a human to inspect and replay |
| **Deadlock** | two transactions waiting on each other's locks forever. Postgres kills one |
| **Dedupe (consumer)** | skipping an already-processed event via `processed_events` |
| **Dirty event** | a row saying "this train's search data needs a refresh" |
| **Discovery data** | data for browsing that may be stale; labelled `authoritative: false` |
| **Drain** | on shutdown, stop accepting new requests but finish current ones |
| **Dual write** | writing to a DB and a broker as two operations, which can't be made atomic → outbox |
| **Effectively-once** | at-least-once delivery + an idempotent consumer → the effect happens once |
| **Envelope** | the standard outer shape of every event (id, type, version, aggregate, seq, ids, payload) |
| **Event (inventory_events)** | a bookable occurrence (one train run on one date). Not a Kafka message! |
| **Event-loop lag** | how far behind Node's event loop is: the gateway's overload signal |
| **Exclusion constraint** | Postgres rule "no two rows may have = X and overlapping Y" → `allocations_no_overlap` |
| **Failpoint** | a named spot in code where a crash/throw/delay can be injected for tests |
| **Fail closed / open** | on dependency failure, deny (closed) or allow (open). Rate limiting fails closed to a local limiter |
| **Fold (ledger)** | summing all deltas to reconstruct the current balance |
| **Gaps and islands** | SQL technique to find consecutive runs (adjacent seats) |
| **GiST** | Generalized Search Tree index; supports range overlap `&&` |
| **Grace window** | how long reconciliation waits before considering a mismatch real |
| **Half-open range `[a,b)`** | includes a, excludes b. `[0,3)` and `[3,5)` don't overlap |
| **Head-of-line (outbox)** | only the oldest pending event per aggregate may be published next |
| **HMAC** | a keyed hash used as a signature (JWT, webhooks, waiting-room tokens) |
| **Hold** | a temporary claim on items with an expiry (TTL), parent of allocations |
| **Hot row** | one row everyone updates, so everyone queues on it |
| **HPA / PDB** | Kubernetes Horizontal Pod Autoscaler / PodDisruptionBudget |
| **Idempotency key** | a client-chosen unique id per attempt, letting the server recognise retries |
| **IN_PROGRESS / REPLAY / CLAIMED** | the outcomes of an idempotency claim |
| **Indeterminate** | an error where we don't know whether the operation happened (timeout, 5xx) |
| **int4range** | Postgres integer range type, used for `span` |
| **Invariant** | a condition that must always hold; here, SQL views that must return 0 rows |
| **JWT (HS256)** | a signed token `header.payload.signature` carrying user id, role and expiry |
| **KRaft** | Kafka's built-in consensus mode (no ZooKeeper) |
| **Lazy expiry / lazy reap** | expiring stale holds at the moment someone needs those seats |
| **Lease** | a lock with an expiry, so a dead worker's claim frees itself |
| **Ledger** | the append-only list of inventory movements with signed deltas |
| **Liveness vs readiness** | "is the process alive?" (`/health`) vs "should it get traffic?" (`/ready`) |
| **Load shedding** | rejecting requests quickly (503) when overloaded |
| **lock_timeout / statement_timeout / idle_in_transaction_session_timeout** | Postgres limits on lock waits, query time and abandoned transactions |
| **Lua script (Redis)** | code Redis runs atomically, used for the token bucket and waiting room |
| **MANUAL_REVIEW** | the saga state meaning "a human must decide" (money unclear) |
| **Migration** | a versioned SQL file that changes the schema; checksummed, never edited |
| **Orchestration vs choreography** | a central coordinator drives the steps vs services react to each other's events |
| **Outbox (transactional)** | events written as rows in the same transaction as the change, published later by a relay |
| **Oversell** | selling the same unit to more than one customer |
| **p50 / p99** | latency below which 50% / 99% of requests complete |
| **Partial index** | an index over only rows matching a WHERE (e.g. live holds) |
| **Partition (Kafka)** | an ordered shard of a topic; order is guaranteed only within one |
| **Pessimistic vs optimistic locking** | lock first (`FOR UPDATE`) vs check-on-write (CAS) |
| **Poison message** | a message that fails every time it's processed |
| **Pool (inventory)** | quantity stock without identity (meals) |
| **Pool (DB connection)** | a bounded set of reusable DB connections |
| **Processed events** | the consumer dedupe table `(consumer, event_id)` |
| **Projection offsets** | the highest `aggregate_seq` applied per aggregate per consumer |
| **Race condition / TOCTOU** | a result depending on timing; time-of-check to time-of-use gap |
| **RBAC** | role-based access control (CUSTOMER / OPERATOR) |
| **READ COMMITTED** | Postgres' default isolation; each statement sees committed data as of its start |
| **Reconciliation** | a periodic cross-service audit with safe auto-repair and human escalation |
| **Relay (outbox)** | the worker publishing outbox rows to Kafka |
| **Resource** | an individually bookable thing (seat, room, slot) |
| **Resync** | a periodic full refresh that heals anything event-driven updates missed |
| **Saga** | a multi-step distributed workflow with compensations, stored durably |
| **Segment resale** | selling one seat for several non-overlapping stretches of a journey |
| **Single-flight** | concurrent identical cache misses share one backend call |
| **SKIP LOCKED** | `FOR UPDATE SKIP LOCKED`: claim unlocked rows, skip locked ones (work queues) |
| **Span** | the occupied range on a resource's axis (stops, nights, slots) |
| **span_max** | the length of an event's axis (e.g. stops − 1) |
| **Stampede (cache)** | many requests hitting the backend at once when an entry expires |
| **State machine (DB-enforced)** | allowed transitions checked by a trigger on every UPDATE |
| **Timing-safe compare** | comparing secrets in constant time so timing leaks nothing |
| **Token bucket** | a rate limiter refilling tokens continuously; burst = capacity |
| **TTL** | time-to-live (holds, cache entries, idempotency keys, sessions) |
| **UNKNOWN (payment)** | the provider didn't answer: the outcome is unknown and must be resolved by asking |
| **Upcaster** | a function converting an old event version to a newer one |
| **Versioned cache key** | a cache key containing a version that is bumped to invalidate everything at once |
| **Waiting room** | a queue capping how many users are inside during a flash sale |
| **Webhook** | an HTTP callback from the payment provider; must be verified and deduplicated |
| **word_similarity / pg_trgm** | Postgres trigram fuzzy matching, the discovery fallback search |

← Back to the [course index](README.md)
