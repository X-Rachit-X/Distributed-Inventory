'use strict';

/**
 * Event contracts.
 *
 * Every event type that crosses a service boundary is declared here, with its
 * version. The outbox writer validates against these BEFORE the row is written,
 * and every consumer validates again before handling. A malformed event is
 * therefore a failed request at the producer, not a poison message that has
 * already been committed as fact.
 *
 * Evolution rules (see docs/research/schema-evolution.md):
 *
 *   - within a version, changes are ADDITIVE and OPTIONAL only. Required fields
 *     are never added and never removed. A v1 consumer that receives a v1 event
 *     carrying extra fields keeps working, because `additionalProperties` is
 *     left open deliberately.
 *   - a breaking change is a NEW VERSION with an UPCASTER from the previous
 *     one. A consumer declares the version it reads; older events are upcast
 *     to it on the way in. Producers can therefore move first.
 *
 * `booking.confirmed` exists in v1 and v2 to exercise exactly that path:
 * v2 introduced an explicit currency and the seat codes, and the upcaster
 * fills them for historical v1 events.
 */

const { registerSchema, registerUpcaster } = require('./registry');

const uuid = { type: 'string', minLength: 1 };
const nullableUuid = { type: ['string', 'null'] };
const cents = { type: 'integer', minimum: 0 };
const timestamp = { type: 'string', minLength: 10 };

const allocationItem = {
     type: 'object',
     required: ['resource_id'],
     properties: {
          allocation_id: uuid,
          resource_id: uuid,
          resource_code: { type: 'string' },
          span_from: { type: 'integer', minimum: 0 },
          span_to: { type: 'integer', minimum: 1 },
     },
};

// ── inventory.events ────────────────────────────────────────────────────────

registerSchema('inventory.held', 1, {
     type: 'object',
     required: ['hold_id', 'event_id', 'customer_id', 'expires_at', 'items'],
     properties: {
          hold_id: uuid,
          event_id: uuid,
          customer_id: { type: 'string', minLength: 1 },
          reservation_id: nullableUuid,
          expires_at: timestamp,
          total_cents: cents,
          items: { type: 'array', items: allocationItem },
          pool_items: { type: 'array' },
     },
});

registerSchema('inventory.confirmed', 1, {
     type: 'object',
     required: ['hold_id', 'booking_id', 'event_id', 'items'],
     properties: {
          hold_id: uuid,
          booking_id: { type: 'string', minLength: 1 },
          event_id: uuid,
          customer_id: { type: 'string' },
          total_cents: cents,
          items: { type: 'array', items: allocationItem },
     },
});

const releaseLike = {
     type: 'object',
     required: ['event_id'],
     properties: {
          event_id: uuid,
          hold_id: nullableUuid,
          booking_id: { type: ['string', 'null'] },
          reason: { type: 'string' },
          resource_ids: { type: 'array', items: { type: 'string' } },
     },
};

registerSchema('inventory.released', 1, releaseLike);
registerSchema('inventory.cancelled', 1, releaseLike);
registerSchema('inventory.expired', 1, releaseLike);

registerSchema('inventory.blocked', 1, {
     type: 'object',
     required: ['resource_id', 'reason'],
     properties: { resource_id: uuid, resource_code: { type: 'string' }, reason: { type: 'string' }, span: { type: 'string' } },
});

registerSchema('inventory.unblocked', 1, {
     type: 'object',
     required: ['resource_id'],
     properties: { resource_id: uuid, reason: { type: ['string', 'null'] } },
});

// ── payment.events ──────────────────────────────────────────────────────────

registerSchema('payment.captured', 1, {
     type: 'object',
     required: ['payment_id'],
     properties: {
          payment_id: uuid,
          reservation_id: nullableUuid,
          amount_cents: cents,
          provider_payment_id: { type: ['string', 'null'] },
          state: { type: 'string' },
          via: { type: 'string' },
          resolved_from_unknown: { type: 'boolean' },
     },
});

registerSchema('payment.failed', 1, {
     type: 'object',
     required: ['payment_id'],
     properties: {
          payment_id: uuid,
          reservation_id: nullableUuid,
          reason: { type: ['string', 'null'] },
          state: { type: 'string' },
          via: { type: 'string' },
     },
});

// ── booking.events ──────────────────────────────────────────────────────────

registerSchema('booking.confirmed', 1, {
     type: 'object',
     required: ['reservation_id', 'customer_id', 'reference', 'total_cents'],
     properties: {
          reservation_id: uuid,
          customer_id: { type: 'string', minLength: 1 },
          reference: { type: 'string', minLength: 1 },
          total_cents: cents,
     },
});

registerSchema('booking.confirmed', 2, {
     type: 'object',
     required: ['reservation_id', 'customer_id', 'reference', 'total_cents', 'currency'],
     properties: {
          reservation_id: uuid,
          customer_id: { type: 'string', minLength: 1 },
          reference: { type: 'string', minLength: 1 },
          total_cents: cents,
          // v2: explicit currency. v1 implied INR, which was true until it
          // wasn't — the upcaster makes the implicit assumption explicit.
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          seat_codes: { type: 'array', items: { type: 'string' } },
     },
});

registerUpcaster('booking.confirmed', 1, (payload) => ({
     ...payload,
     currency: 'INR',
     seat_codes: payload.seat_codes ?? [],
}));

registerSchema('booking.cancelled', 1, {
     type: 'object',
     required: ['reservation_id', 'customer_id'],
     properties: {
          reservation_id: uuid,
          customer_id: { type: 'string' },
          reason: { type: 'string' },
          refund_initiated: { type: 'boolean' },
     },
});

/** Topic → the event types it carries. Documentation, and a check for the producer. */
const TOPICS = {
     'inventory.events': [
          'inventory.held',
          'inventory.confirmed',
          'inventory.released',
          'inventory.cancelled',
          'inventory.expired',
          'inventory.blocked',
          'inventory.unblocked',
     ],
     'payment.events': ['payment.captured', 'payment.failed'],
     'booking.events': ['booking.confirmed', 'booking.cancelled'],
};

module.exports = { TOPICS };
