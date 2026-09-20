'use strict';

/**
 * CONFIRM, RELEASE, CANCEL — the transitions out of a hold.
 *
 * The rule that matters here is that CONFIRM must be impossible to perform on
 * an expired hold. Not "unlikely", not "checked first" — impossible. The check
 * and the write are one statement:
 *
 *     UPDATE allocations SET state = 'CONFIRMED'
 *      WHERE hold_id = $1 AND state = 'HELD' AND expires_at > now()
 *
 * If the TTL elapsed a microsecond ago, zero rows update and the whole
 * transaction rolls back. There is no window between checking the expiry and
 * acting on it, because there is no separate check.
 *
 * The row count is then compared against the hold's item count. A partial
 * confirmation — some allocations still live, others reaped — must not produce
 * a half-confirmed booking, so anything other than "all of them" aborts.
 */

const ledger = require('./ledger');
const { enqueue, nextSeq } = require('@tessera/shared/src/outbox/writer');
const { failpoint } = require('@tessera/shared/src/failpoints');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const { NotFoundError, ConflictError, HoldExpiredError, ForbiddenError } = require('@tessera/shared/src/errors');

/**
 * Confirm every allocation belonging to a hold, turning it into a booking.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} req
 * @param {string} req.holdId
 * @param {string} req.bookingId
 * @param {string} [req.customerId]  When present, ownership is enforced.
 * @param {object} [req.context]
 */
async function confirm(client, req) {
     const ctx = req.context || {};
     const actor = ctx.actor || req.customerId || 'system';

     // Lock the hold row first. Serialises confirm against a concurrent
     // release, cancel or sweeper touching the same hold.
     const { rows: holdRows } = await client.query(
          `SELECT id, event_id, customer_id, state, expires_at, item_count, total_cents, created_at
             FROM holds
            WHERE id = $1
            FOR UPDATE`,
          [req.holdId]
     );
     if (holdRows.length === 0) throw new NotFoundError(`Hold ${req.holdId} not found`);
     const hold = holdRows[0];

     if (req.customerId && hold.customer_id !== req.customerId) {
          throw new ForbiddenError('This hold belongs to another customer');
     }

     // Idempotent confirm: a retried confirmation of an already-confirmed hold
     // returns the same answer rather than erroring. The payment webhook and
     // the saga worker can both arrive here for the same hold.
     if (hold.state === 'CONFIRMED') {
          const { rows } = await client.query(
               `SELECT id, resource_id, booking_id, lower(span) AS span_from, upper(span) AS span_to, price_cents
                  FROM allocations WHERE hold_id = $1 AND state = 'CONFIRMED'`,
               [req.holdId]
          );
          return {
               holdId: req.holdId,
               bookingId: rows[0]?.booking_id ?? req.bookingId,
               alreadyConfirmed: true,
               allocations: rows.map(mapAllocation),
          };
     }

     if (hold.state !== 'ACTIVE') {
          throw new ConflictError(`Hold is ${hold.state} and cannot be confirmed`, 'HOLD_NOT_ACTIVE');
     }
     if (new Date(hold.expires_at) <= new Date()) {
          throw new HoldExpiredError('Hold expired before confirmation', {
               expiredAt: hold.expires_at,
          });
     }

     // The atomic confirm. Expiry is part of the predicate, not a prior check.
     const { rows: confirmed } = await client.query(
          `UPDATE allocations
              SET state = 'CONFIRMED', booking_id = $2
            WHERE hold_id = $1
              AND state = 'HELD'
              AND expires_at > now()
        RETURNING id, resource_id, event_id, span, lower(span) AS span_from, upper(span) AS span_to,
                  price_cents, booking_id`,
          [req.holdId, req.bookingId]
     );

     const { rows: poolClaims } = await client.query(
          `UPDATE pool_claims
              SET state = 'CONFIRMED', booking_id = $2, updated_at = now()
            WHERE hold_id = $1 AND state = 'HELD'
        RETURNING id, pool_id, bucket, quantity`,
          [req.holdId, req.bookingId]
     );

     const expectedItems = hold.item_count;
     const actualItems = confirmed.length + poolClaims.length;
     if (actualItems !== expectedItems) {
          // Some allocations were reaped between the hold row lock and here, or
          // the hold was partially released. A partially confirmed booking is
          // worse than a failed one; abort and let the caller compensate.
          throw new HoldExpiredError(
               `Hold is no longer whole: ${actualItems} of ${expectedItems} items are still live`,
               { expected: expectedItems, actual: actualItems }
          );
     }

     // Move the quantity accounting from held to confirmed. Total occupancy is
     // unchanged, so no capacity is freed or consumed by this step.
     for (const claim of poolClaims) {
          await client.query(
               `UPDATE pool_buckets
                   SET held = held - $3, confirmed = confirmed + $3
                 WHERE pool_id = $1 AND bucket = $2`,
               [claim.pool_id, claim.bucket, claim.quantity]
          );
     }

     await client.query(`UPDATE holds SET state = 'CONFIRMED', reservation_id = COALESCE(reservation_id, $2) WHERE id = $1`, [
          req.holdId,
          req.reservationId || null,
     ]);

     // delta 0: the resource was already unavailable while HELD. The entry
     // exists to record the transition, not to move capacity.
     await ledger.append(client, [
          ...confirmed.map((a) => ({
               eventId: a.event_id,
               resourceId: a.resource_id,
               span: a.span,
               entryType: 'CONFIRMED',
               delta: 0,
               allocationId: a.id,
               holdId: req.holdId,
               bookingId: req.bookingId,
               actor,
               reason: 'confirm',
               requestId: ctx.requestId,
               correlationId: ctx.correlationId,
               traceId: ctx.traceId,
          })),
          ...poolClaims.map((c) => ({
               eventId: hold.event_id,
               poolId: c.pool_id,
               bucket: c.bucket,
               entryType: 'CONFIRMED',
               delta: 0,
               holdId: req.holdId,
               bookingId: req.bookingId,
               actor,
               reason: 'confirm',
               requestId: ctx.requestId,
               traceId: ctx.traceId,
          })),
     ]);

     const seq = await nextSeq(client, hold.event_id);
     await enqueue(client, {
          topic: 'inventory.events',
          type: 'inventory.confirmed',
          aggregateId: hold.event_id,
          aggregateSeq: seq,
          correlationId: ctx.correlationId,
          traceId: ctx.traceId,
          payload: {
               hold_id: req.holdId,
               booking_id: req.bookingId,
               event_id: hold.event_id,
               customer_id: hold.customer_id,
               total_cents: Number(hold.total_cents),
               items: confirmed.map((a) => ({
                    allocation_id: a.id,
                    resource_id: a.resource_id,
                    span_from: a.span_from,
                    span_to: a.span_to,
               })),
          },
     });

     metrics.holdDuration.observe(
          { outcome: 'confirmed' },
          (Date.now() - new Date(hold.created_at).getTime()) / 1000
     );

     await failpoint('confirm.before_commit');

     return {
          holdId: req.holdId,
          bookingId: req.bookingId,
          eventId: hold.event_id,
          alreadyConfirmed: false,
          allocations: confirmed.map(mapAllocation),
     };
}

/**
 * Release an active hold, returning its inventory immediately.
 *
 * Used when a user abandons checkout or a saga compensates. Releasing early is
 * always better than waiting for the TTL: it puts scarce inventory back in
 * front of customers minutes sooner during a flash sale.
 */
async function release(client, req) {
     const ctx = req.context || {};
     const actor = ctx.actor || req.customerId || 'system';

     const { rows: holdRows } = await client.query(
          `SELECT id, event_id, customer_id, state, created_at FROM holds WHERE id = $1 FOR UPDATE`,
          [req.holdId]
     );
     if (holdRows.length === 0) throw new NotFoundError(`Hold ${req.holdId} not found`);
     const hold = holdRows[0];

     if (req.customerId && hold.customer_id !== req.customerId) {
          throw new ForbiddenError('This hold belongs to another customer');
     }

     // Idempotent: releasing an already-terminal hold is a no-op, because a
     // compensating saga may legitimately retry after a partial failure.
     if (hold.state !== 'ACTIVE') {
          return { holdId: req.holdId, state: hold.state, released: 0, alreadyTerminal: true };
     }

     const { rows: released } = await client.query(
          `UPDATE allocations SET state = 'RELEASED', reason = $2
            WHERE hold_id = $1 AND state = 'HELD'
        RETURNING id, resource_id, event_id, span`,
          [req.holdId, req.reason || 'released']
     );

     const { rows: poolClaims } = await client.query(
          `UPDATE pool_claims SET state = 'RELEASED', updated_at = now()
            WHERE hold_id = $1 AND state = 'HELD'
        RETURNING pool_id, bucket, quantity`,
          [req.holdId]
     );
     for (const claim of poolClaims) {
          await client.query(`UPDATE pool_buckets SET held = held - $3 WHERE pool_id = $1 AND bucket = $2`, [
               claim.pool_id,
               claim.bucket,
               claim.quantity,
          ]);
     }

     await client.query(`UPDATE holds SET state = 'RELEASED' WHERE id = $1`, [req.holdId]);

     await ledger.append(client, [
          ...released.map((a) => ({
               eventId: a.event_id,
               resourceId: a.resource_id,
               span: a.span,
               entryType: 'RELEASED',
               delta: +1,
               allocationId: a.id,
               holdId: req.holdId,
               actor,
               reason: req.reason || 'released',
               requestId: ctx.requestId,
               correlationId: ctx.correlationId,
               traceId: ctx.traceId,
          })),
          ...poolClaims.map((c) => ({
               eventId: hold.event_id,
               poolId: c.pool_id,
               bucket: c.bucket,
               entryType: 'RELEASED',
               delta: +c.quantity,
               holdId: req.holdId,
               actor,
               reason: req.reason || 'released',
               requestId: ctx.requestId,
               traceId: ctx.traceId,
          })),
     ]);

     const seq = await nextSeq(client, hold.event_id);
     await enqueue(client, {
          topic: 'inventory.events',
          type: 'inventory.released',
          aggregateId: hold.event_id,
          aggregateSeq: seq,
          correlationId: ctx.correlationId,
          traceId: ctx.traceId,
          payload: {
               hold_id: req.holdId,
               event_id: hold.event_id,
               reason: req.reason || 'released',
               released_count: released.length,
               resource_ids: released.map((a) => a.resource_id),
          },
     });

     metrics.holdDuration.observe(
          { outcome: 'released' },
          (Date.now() - new Date(hold.created_at).getTime()) / 1000
     );

     return { holdId: req.holdId, state: 'RELEASED', released: released.length, alreadyTerminal: false };
}

/**
 * Cancel a confirmed booking, returning its inventory.
 *
 * The only supported route from CONFIRMED back to available — matching the
 * schema's transition guard, which permits CONFIRMED → CANCELLED and nothing
 * else. Refunding is a separate concern owned by the payment service; this call
 * moves inventory only.
 */
async function cancelBooking(client, req) {
     const ctx = req.context || {};
     const actor = ctx.actor || 'system';

     const { rows: allocations } = await client.query(
          `SELECT id, resource_id, event_id, span, hold_id, state
             FROM allocations
            WHERE booking_id = $1
            FOR UPDATE`,
          [req.bookingId]
     );

     if (allocations.length === 0) {
          throw new NotFoundError(`No allocations found for booking ${req.bookingId}`);
     }

     const live = allocations.filter((a) => a.state === 'CONFIRMED');
     if (live.length === 0) {
          // Already cancelled. Idempotent by design: cancellation can be driven
          // by a user action, a saga compensation and a schedule cancellation.
          return { bookingId: req.bookingId, cancelled: 0, alreadyCancelled: true };
     }

     await client.query(
          `UPDATE allocations SET state = 'CANCELLED', reason = $2
            WHERE booking_id = $1 AND state = 'CONFIRMED'`,
          [req.bookingId, req.reason || 'cancelled']
     );

     const { rows: poolClaims } = await client.query(
          `UPDATE pool_claims SET state = 'CANCELLED', updated_at = now()
            WHERE booking_id = $1 AND state = 'CONFIRMED'
        RETURNING pool_id, bucket, quantity`,
          [req.bookingId]
     );
     for (const claim of poolClaims) {
          await client.query(
               `UPDATE pool_buckets SET confirmed = confirmed - $3 WHERE pool_id = $1 AND bucket = $2`,
               [claim.pool_id, claim.bucket, claim.quantity]
          );
     }

     const eventId = live[0].event_id;

     await ledger.append(client, [
          ...live.map((a) => ({
               eventId: a.event_id,
               resourceId: a.resource_id,
               span: a.span,
               entryType: 'CANCELLED',
               delta: +1,
               allocationId: a.id,
               holdId: a.hold_id,
               bookingId: req.bookingId,
               actor,
               reason: req.reason || 'cancelled',
               requestId: ctx.requestId,
               correlationId: ctx.correlationId,
               traceId: ctx.traceId,
          })),
          ...poolClaims.map((c) => ({
               eventId,
               poolId: c.pool_id,
               bucket: c.bucket,
               entryType: 'CANCELLED',
               delta: +c.quantity,
               bookingId: req.bookingId,
               actor,
               reason: req.reason || 'cancelled',
               requestId: ctx.requestId,
               traceId: ctx.traceId,
          })),
     ]);

     const seq = await nextSeq(client, eventId);
     await enqueue(client, {
          topic: 'inventory.events',
          type: 'inventory.cancelled',
          aggregateId: eventId,
          aggregateSeq: seq,
          correlationId: ctx.correlationId,
          traceId: ctx.traceId,
          payload: {
               booking_id: req.bookingId,
               event_id: eventId,
               reason: req.reason || 'cancelled',
               cancelled_count: live.length,
               resource_ids: live.map((a) => a.resource_id),
          },
     });

     return { bookingId: req.bookingId, eventId, cancelled: live.length, alreadyCancelled: false };
}

const mapAllocation = (a) => ({
     allocationId: a.id,
     resourceId: a.resource_id,
     spanFrom: a.span_from,
     spanTo: a.span_to,
     priceCents: a.price_cents != null ? Number(a.price_cents) : undefined,
     bookingId: a.booking_id,
});

module.exports = { confirm, release, cancelBooking };
