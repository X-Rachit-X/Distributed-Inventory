'use strict';

/**
 * Ledger writes.
 *
 * Every inventory movement appends an entry carrying a signed delta against
 * AVAILABLE units. Folding those deltas must reproduce current state exactly;
 * `invariant_ledger_drift` checks that continuously. So these calls are not
 * optional bookkeeping that can be skipped on a fast path — omitting one
 * registers as a correctness violation, which is the point.
 */

/**
 * Append ledger entries. Must run inside the caller's transaction, alongside
 * the state change it describes.
 *
 * @param {import('pg').PoolClient} client
 * @param {Array<object>} entries
 */
async function append(client, entries) {
     if (!entries || entries.length === 0) return;

     // One multi-row INSERT rather than N round trips: this runs on the hot
     // reserve path, where each extra round trip is time spent holding row locks.
     const cols = [
          'event_id',
          'resource_id',
          'pool_id',
          'bucket',
          'span',
          'entry_type',
          'delta',
          'allocation_id',
          'hold_id',
          'booking_id',
          'actor',
          'reason',
          'request_id',
          'correlation_id',
          'trace_id',
     ];

     const values = [];
     const tuples = entries.map((e, i) => {
          const base = i * cols.length;
          values.push(
               e.eventId,
               e.resourceId ?? null,
               e.poolId ?? null,
               e.bucket ?? null,
               e.span ?? null,
               e.entryType,
               e.delta,
               e.allocationId ?? null,
               e.holdId ?? null,
               e.bookingId ?? null,
               e.actor ?? 'system',
               e.reason ?? null,
               e.requestId ?? null,
               e.correlationId ?? null,
               e.traceId ?? null
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::int4range, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`;
     });

     await client.query(
          `INSERT INTO inventory_ledger (${cols.join(', ')}) VALUES ${tuples.join(', ')}`,
          values
     );
}

/**
 * Fold the ledger for one resource and compare against observed state.
 * Used by the reconciliation worker and by `npm run verify`.
 */
async function foldResource(db, resourceId) {
     const { rows } = await db.query(
          `SELECT
                (SELECT COALESCE(sum(delta), 0) FROM inventory_ledger WHERE resource_id = $1) AS ledger_available,
                (SELECT 1 - count(*) FROM allocations
                  WHERE resource_id = $1 AND state IN ('HELD','CONFIRMED','BLOCKED')) AS actual_available`,
          [resourceId]
     );
     const r = rows[0];
     return {
          resourceId,
          ledgerAvailable: Number(r.ledger_available),
          actualAvailable: Number(r.actual_available),
          drift: Number(r.ledger_available) - Number(r.actual_available),
     };
}

/**
 * Record the opening balance for newly created resources.
 *
 * A resource that exists but has no `CAPACITY_ADDED` entry is inventory the
 * ledger cannot account for, and `invariant_ledger_drift` reports it as drift.
 * Every path that creates resources must call this, in the same transaction.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} eventId
 * @param {string[]} resourceIds
 * @param {object} [ctx]
 */
async function recordCapacity(client, eventId, resourceIds, ctx = {}) {
     if (!resourceIds || resourceIds.length === 0) return;
     await append(
          client,
          resourceIds.map((resourceId) => ({
               eventId,
               resourceId,
               entryType: 'CAPACITY_ADDED',
               delta: +1,
               actor: ctx.actor || 'system:catalog-sync',
               reason: ctx.reason || 'resource created',
               requestId: ctx.requestId,
               correlationId: ctx.correlationId,
               traceId: ctx.traceId,
          }))
     );
}

module.exports = { append, foldResource, recordCapacity };
