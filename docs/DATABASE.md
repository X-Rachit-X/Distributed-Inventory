# Database schema

PostgreSQL 16. **One database per service** (one instance locally). No query joins
across databases; reconciliation reads others through read-only access, as a
documented exception.

Every database also gets the **correctness primitives** (`packages/shared/sql`).

## Shared primitives (every database)

| Table | Purpose | Key detail |
|---|---|---|
| `outbox_events` | events committed with their business change | `status PENDING/PUBLISHED/FAILED/DEAD_LETTER`, `aggregate_id`, `aggregate_seq`, lease columns; partial index on pending rows |
| `aggregate_sequences` | monotonic sequence per aggregate | per-aggregate rows, not one global hot counter |
| `idempotency_keys` | claim-first idempotency | PK `(scope, key)`; `owner_id`, `request_hash`, `state IN_PROGRESS/COMPLETED/FAILED`, stored response |
| `processed_events` | consumer dedupe | PK `(consumer, event_id)`, written in the same tx as the effect |
| `projection_offsets` | out-of-order guard | last applied `aggregate_seq` per consumer and aggregate |
| `consumer_attempts` | retry counts that survive restarts | used by the DLQ wrapper |
| `dead_letters` | poison messages | full payload, source topic/partition/offset, reason, stack, attempts, status |
| `audit_log` | who did what | append-only by trigger |

## inventory (the authority)

```
inventory_events ─┬─< span_points           (stops of a journey, position → station)
                  ├─< resource_groups ─< inventory_resources   (coach → seat, grid position)
                  ├─< holds ─< allocations  (THE table)
                  ├─< inventory_pools ─< pool_buckets, pool_claims   (quantity stock, e.g. meals)
                  └── inventory_ledger      (append-only)
```

**`allocations`** — `resource_id`, `span int4range`, `state allocation_state`
(`HELD, CONFIRMED, BLOCKED, EXPIRED, RELEASED, CANCELLED`), `hold_id`, `booking_id`,
`expires_at`, `price_cents`, `reason`.

Constraints that *are* the business rules:

| Constraint | Rule |
|---|---|
| `allocations_no_overlap` — `EXCLUDE USING gist (resource_id WITH =, span WITH &&) WHERE state IN ('HELD','CONFIRMED','BLOCKED')` | never oversell |
| `span_not_empty`, `span_bounded` | a span is real |
| `held_has_expiry`, `held_has_hold` | a hold always expires and belongs to a hold |
| `confirmed_has_booking`, `blocked_has_reason` | every sale and every block is attributable |
| trigger `allocation_insert_guard` | rows are created only as HELD or BLOCKED — **never directly CONFIRMED** |
| trigger `allocation_transition_guard` | HELD→CONFIRMED/EXPIRED/RELEASED/CANCELLED; CONFIRMED→CANCELLED; BLOCKED→RELEASED; nothing else |
| `pool_bucket_never_oversold` — `CHECK (held + confirmed <= capacity)` | quantity stock never oversold |
| `hold_expiry_after_creation` | sane TTLs |
| trigger `hold_transition_guard` | ACTIVE → terminal only |
| trigger `inventory_ledger_append_only`, `audit_log_append_only` | history cannot be edited |

Partial indexes: `allocations(expires_at) WHERE state='HELD'` (sweeper),
`allocations(hold_id) WHERE state='HELD'` (confirm), `holds(expires_at) WHERE state='ACTIVE'`.

**`inventory_ledger`** — `entry_type` (`CAPACITY_ADDED, ALLOCATED, RELEASED, EXPIRED,
CONFIRMED, CANCELLED, BLOCKED, UNBLOCKED`), signed `delta`, actor, reason,
request/trace ids.

Views: `invariant_overlapping_allocations`, `invariant_oversold_pools`,
`invariant_expired_still_held`, `invariant_hold_allocation_mismatch`,
`invariant_ledger_drift`, `invariant_duplicate_bookings`, `invariant_outbox_backlog`,
`invariant_summary`; function `invariants_for_event(uuid)`.

**`lab` schema** — the Contention Lab's isolated tables, including
`allocations_unsafe` (no constraint — the control group) and `allocations_guarded`.

## reservation

| Table | Notes |
|---|---|
| `reservations` | customer intent; `state PENDING/HELD/AWAITING_PAYMENT/CONFIRMED/FAILED/CANCELLED/EXPIRED`, `hold_id`, `payment_id`, `total_cents` |
| `reservation_items` | seat/span or pool item, **server-quoted** `price_cents` |
| `bookings` | the issued result; unique `reservation_id`, unique human `reference` (`TSR-…`) |
| `sagas` | the durable saga: `state` (18 states), `attempts`, `next_run_at`, `step_deadline_at`, `lease_owner/lease_until`, `context jsonb` |
| `saga_steps` | append-only transition history |

Trigger `saga_transition_guard` encodes the allowed transitions (e.g.
`PAYMENT_UNKNOWN → AUTHORIZED | FAILED | MANUAL_REVIEW` only). Views `stuck_sagas`,
`sagas_needing_attention`.

## payment

| Table | Notes |
|---|---|
| `payments` | `state CREATED/AUTHORIZED/CAPTURED/FAILED/CANCELLED/UNKNOWN/REFUND_PENDING/REFUNDED/PARTIALLY_REFUNDED`; unique `idempotency_key`; resolver columns `unknown_since, resolve_attempts, next_resolve_at` |
| `refunds` | unique `idempotency_key`; trigger: total refunded ≤ captured |
| `provider_events` | every webhook, unique `(provider, provider_event_id)` → replay protection |
| `signature_failures` | forged/invalid webhooks, recorded and **never** acted on |

Trigger `payment_transition_guard` — no path out of `FAILED`; `UNKNOWN` resolves only
to a definite state.

## reconciliation

`recon_runs`, `reconciliation_issues` (unique `(kind, entity_type, entity_id)`,
`severity`, `money_involved`, `repair_status`, `seen_count`), `repair_log`
(append-only), `scoreboard_snapshots`, view `scoreboard_current`.

## notification

`notifications` — unique `(source_event_id, template)`: a second, independent guard
against a duplicate email beyond the consumer's dedupe marker.

## discovery (read model)

`trips`, `trip_stops` (trigram index on `label`), `trip_segments` (availability and
fare for every stop pair × class), `dirty_events` (durable refresh queue with
attempts).

## Why these choices

- **Constraints over code.** Every rule that can be a constraint or trigger is one,
  so a buggy code path, a migration script or a hand-run UPDATE during an incident
  all hit the same wall.
- **Plain SQL migrations**, not an ORM: exclusion constraints, partial indexes,
  range types, triggers and append-only guards are not expressible in Prisma.
  Migrations are checksummed and advisory-locked.
- **Per-aggregate sequences** instead of one global sequence, so no hot row is shared
  by every write.
- **Partial indexes** on the small "live" subset, so hot-path queries stay fast as
  history grows.
