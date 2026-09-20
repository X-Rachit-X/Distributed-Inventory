'use strict';

/**
 * Administrative inventory adjustment.
 *
 * A train operator finds seat A12 damaged and withdraws it from sale. The
 * question that decides whether this feature is safe is: what happens if
 * someone is already holding it?
 *
 * THE POLICY, stated so there is no undefined behaviour:
 *
 *   resource is free          → BLOCKED immediately
 *   resource is HELD          → REJECTED (409), naming the hold and its expiry
 *   resource is CONFIRMED     → REJECTED (409); only cancel-and-refund frees it
 *
 * Rejecting rather than seizing is deliberate. A customer mid-checkout with a
 * valid hold has a stronger claim than an operator's convenience, and holds
 * expire on their own within minutes. Seizing a CONFIRMED seat would silently
 * invalidate a paid ticket without triggering a refund — the system would have
 * taken money for something it then took away.
 *
 * A block is itself an allocation with `state = 'BLOCKED'`, so it participates
 * in the same exclusion constraint as everything else. An operator cannot block
 * a seat that is sold, and a seat that is blocked cannot then be sold, with no
 * extra code enforcing either direction.
 */

const ledger = require('./ledger');
const { enqueue, nextSeq } = require('@tessera/shared/src/outbox/writer');
const { ConflictError, NotFoundError, isOversellPrevented } = require('@tessera/shared/src/errors');

async function blockResource(client, { resourceId, reason, spanFrom, spanTo, context = {} }) {
     const { rows: resourceRows } = await client.query(
          `SELECT r.id, r.code, r.event_id, r.state, e.span_max
             FROM inventory_resources r
             JOIN inventory_events e ON e.id = r.event_id
            WHERE r.id = $1
              FOR UPDATE OF r`,
          [resourceId]
     );
     if (resourceRows.length === 0) throw new NotFoundError(`Resource ${resourceId} not found`);
     const resource = resourceRows[0];

     const from = spanFrom ?? 0;
     const to = spanTo ?? resource.span_max;
     const span = `[${from},${to})`;

     // Report WHY it cannot be blocked, with the detail an operator needs to
     // decide what to do: wait for the hold, or cancel the booking.
     const { rows: conflicts } = await client.query(
          `SELECT id, state, expires_at, booking_id, customer_id
             FROM allocations
            WHERE resource_id = $1
              AND state IN ('HELD','CONFIRMED','BLOCKED')
              AND (state <> 'HELD' OR expires_at > now())
              AND span && $2::int4range`,
          [resourceId, span]
     );

     if (conflicts.length > 0) {
          const held = conflicts.find((c) => c.state === 'HELD');
          const confirmed = conflicts.find((c) => c.state === 'CONFIRMED');
          const blocked = conflicts.find((c) => c.state === 'BLOCKED');

          if (blocked) {
               // Idempotent: blocking an already-blocked resource is a no-op,
               // so a retried admin action does not error.
               return { resourceId, code: resource.code, alreadyBlocked: true, allocationId: blocked.id };
          }
          if (confirmed) {
               throw new ConflictError(
                    `${resource.code} is sold (booking ${confirmed.booking_id}). Cancel and refund the booking first.`,
                    'RESOURCE_CONFIRMED',
                    { bookingId: confirmed.booking_id }
               );
          }
          throw new ConflictError(
               `${resource.code} is held by a customer until ${held.expires_at.toISOString()}. ` +
                    `Retry after the hold expires, or cancel it explicitly.`,
               'RESOURCE_HELD',
               { holdId: held.id, expiresAt: held.expires_at }
          );
     }

     let allocation;
     try {
          const { rows } = await client.query(
               `INSERT INTO allocations (event_id, resource_id, span, state, reason)
                VALUES ($1, $2, $3::int4range, 'BLOCKED', $4)
                RETURNING id`,
               [resource.event_id, resourceId, span, reason]
          );
          allocation = rows[0];
     } catch (err) {
          if (isOversellPrevented(err)) {
               // Someone reserved it between the check and the insert. The
               // constraint caught it, exactly as it would for a customer.
               throw new ConflictError(
                    `${resource.code} was claimed while the block was being applied`,
                    'RESOURCE_UNAVAILABLE'
               );
          }
          throw err;
     }

     await ledger.append(client, [
          {
               eventId: resource.event_id,
               resourceId,
               span,
               entryType: 'BLOCKED',
               delta: -1,
               allocationId: allocation.id,
               actor: context.actor || 'admin',
               reason,
               requestId: context.requestId,
               traceId: context.traceId,
          },
     ]);

     await writeAudit(client, {
          actor: context.actor || 'admin',
          action: 'RESOURCE_BLOCKED',
          entityType: 'resource',
          entityId: resourceId,
          oldState: { status: 'AVAILABLE' },
          newState: { status: 'BLOCKED', span },
          reason,
          context,
     });

     const seq = await nextSeq(client, resource.event_id);
     await enqueue(client, {
          topic: 'inventory.events',
          type: 'inventory.blocked',
          aggregateId: resource.event_id,
          aggregateSeq: seq,
          payload: { resource_id: resourceId, resource_code: resource.code, reason, span },
     });

     return { resourceId, code: resource.code, allocationId: allocation.id, span, blocked: true };
}

async function unblockResource(client, { resourceId, reason, context = {} }) {
     const { rows } = await client.query(
          `UPDATE allocations SET state = 'RELEASED', reason = $2
            WHERE resource_id = $1 AND state = 'BLOCKED'
        RETURNING id, event_id, span`,
          [resourceId, reason || 'unblocked by operator']
     );

     if (rows.length === 0) {
          return { resourceId, alreadyAvailable: true };
     }

     await ledger.append(
          client,
          rows.map((a) => ({
               eventId: a.event_id,
               resourceId,
               span: a.span,
               entryType: 'UNBLOCKED',
               delta: +1,
               allocationId: a.id,
               actor: context.actor || 'admin',
               reason: reason || 'unblocked by operator',
               requestId: context.requestId,
               traceId: context.traceId,
          }))
     );

     await writeAudit(client, {
          actor: context.actor || 'admin',
          action: 'RESOURCE_UNBLOCKED',
          entityType: 'resource',
          entityId: resourceId,
          oldState: { status: 'BLOCKED' },
          newState: { status: 'AVAILABLE' },
          reason,
          context,
     });

     const seq = await nextSeq(client, rows[0].event_id);
     await enqueue(client, {
          topic: 'inventory.events',
          type: 'inventory.unblocked',
          aggregateId: rows[0].event_id,
          aggregateSeq: seq,
          payload: { resource_id: resourceId, reason },
     });

     return { resourceId, unblocked: rows.length };
}

/** Who did what, to which entity, and what changed. */
async function writeAudit(client, { actor, action, entityType, entityId, oldState, newState, reason, context }) {
     await client.query(
          `INSERT INTO audit_log
                  (actor_id, actor_role, action, entity_type, entity_id, old_state, new_state,
                   reason, request_id, trace_id, service)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'inventory-engine')`,
          [
               actor,
               'ADMIN',
               action,
               entityType,
               entityId,
               JSON.stringify(oldState ?? null),
               JSON.stringify(newState ?? null),
               reason ?? null,
               context.requestId ?? null,
               context.traceId ?? null,
          ]
     );
}

module.exports = { blockResource, unblockResource, writeAudit };
