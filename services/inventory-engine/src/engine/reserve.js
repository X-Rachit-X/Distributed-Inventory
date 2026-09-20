'use strict';

/**
 * RESERVE — the hot path.
 *
 * Everything in this file exists to make one transaction as short as possible
 * while remaining impossible to get wrong.
 *
 * Transaction boundary (spec §64):
 *
 *     BEGIN
 *       reap expired holds on the target resources   ← TTL enforced here, by DB clock
 *       insert hold
 *       insert allocations                           ← exclusion constraint decides
 *       claim pool quantities                        ← CHECK constraint decides
 *       append ledger entries
 *       write outbox event
 *     COMMIT
 *
 * What is deliberately NOT inside: no payment call, no Kafka publish, no HTTP
 * request, no Redis round trip, no waiting on a user. A transaction that waits
 * on an external system holds row locks for the duration of that system's worst
 * day, and converts a slow dependency into database connection exhaustion.
 *
 * Two subtleties worth stating explicitly:
 *
 * 1. LAZY EXPIRY. A hold that has passed its TTL still occupies its span as far
 *    as the exclusion constraint is concerned — the constraint cannot read a
 *    clock. So reserve reaps expired holds for exactly the resources it is
 *    about to touch, in the same transaction, before inserting. This makes the
 *    TTL authoritative at the moment it matters. The background sweeper then
 *    becomes a freshness optimisation (it keeps availability counts honest for
 *    browsing users) rather than a correctness dependency — if it dies, nobody
 *    is wrongly denied a seat.
 *
 * 2. DETERMINISTIC ORDERING. Multi-resource requests sort their items by
 *    (resource_id, span lower bound) before inserting. Two concurrent requests
 *    for seats {A,B} and {B,A} would otherwise grab them in opposite orders and
 *    deadlock. Sorting gives every transaction in the system one global order,
 *    so a cycle cannot form. PostgreSQL would detect and break the deadlock
 *    anyway, but at the cost of an aborted transaction and a latency spike.
 */

const crypto = require('node:crypto');
const ledger = require('./ledger');
const { enqueue, nextSeq } = require('@tessera/shared/src/outbox/writer');
const { failpoint } = require('@tessera/shared/src/failpoints');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const {
     ConflictError,
     NotFoundError,
     BadRequestError,
     isOversellPrevented,
} = require('@tessera/shared/src/errors');

const DEFAULT_TTL_SECONDS = 600;
const MAX_TTL_SECONDS = 1800;
const MIN_TTL_SECONDS = 30;

/** `[lo,hi)` — half-open, matching the `int4range` semantics in the schema. */
const spanLiteral = (lo, hi) => `[${lo},${hi})`;

/**
 * Reserve inventory, creating a hold.
 *
 * @param {import('pg').PoolClient} client  Transaction client supplied by the caller.
 * @param {object} req
 * @param {string} req.eventId
 * @param {string} req.customerId
 * @param {Array<{resourceId?:string, resourceCode?:string, spanFrom:number, spanTo:number}>} [req.resources]
 * @param {Array<{poolCode:string, quantity:number}>} [req.pools]
 * @param {number} [req.ttlSeconds]
 * @param {string} [req.reservationId]
 * @param {object} [req.context]  actor, requestId, correlationId, traceId
 * @returns {Promise<object>} the created hold
 */
async function reserve(client, req) {
     const ctx = req.context || {};
     const actor = ctx.actor || req.customerId;

     const ttlSeconds = Math.min(
          Math.max(req.ttlSeconds || DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS),
          MAX_TTL_SECONDS
     );

     const resourceReqs = req.resources || [];
     const poolReqs = req.pools || [];
     if (resourceReqs.length === 0 && poolReqs.length === 0) {
          throw new BadRequestError('A reservation must request at least one resource or pool item');
     }

     // ── 1. Event must be open for business ────────────────────────────────
     const { rows: eventRows } = await client.query(
          `SELECT id, state, span_max, domain, name FROM inventory_events WHERE id = $1`,
          [req.eventId]
     );
     if (eventRows.length === 0) throw new NotFoundError(`Unknown inventory event ${req.eventId}`);
     const event = eventRows[0];
     if (event.state !== 'ACTIVE') {
          throw new ConflictError(`Event is ${event.state}, not open for reservations`, 'EVENT_NOT_ACTIVE');
     }

     // ── 2. Resolve resource codes and validate spans ──────────────────────
     const resolved = await resolveResources(client, req.eventId, resourceReqs, event.span_max);

     // ── 3. Deterministic ordering — the deadlock guard ────────────────────
     resolved.sort((a, b) =>
          a.resourceId === b.resourceId ? a.spanFrom - b.spanFrom : a.resourceId.localeCompare(b.resourceId)
     );

     // ── 4. Queue on the resource rows, in sorted order ────────────────────
     //
     // This step was added because the Contention Lab measured what happens
     // without it. Relying on the exclusion constraint alone — a bare INSERT,
     // no prior lock — is perfectly CORRECT but performs catastrophically under
     // single-resource contention: at 1,000 concurrent requests for one seat,
     // 609 of them died with SQLSTATE 40P01 (deadlock detected) and p99 hit the
     // 30-second statement timeout, for 6.7 requests/second.
     //
     // The cause is specific to how PostgreSQL enforces exclusion constraints.
     // Unlike a unique index, which uses speculative insertion, a GiST
     // exclusion constraint inserts the row and THEN scans for conflicts,
     // waiting on any conflicting transaction still in progress. Many
     // simultaneous inserters therefore wait on one another, the wait graph
     // develops cycles, and the deadlock detector starts aborting transactions.
     //
     // Taking a row lock on the resources first gives that contention an
     // ORDERLY place to queue: one waiter at a time per resource, FIFO, no
     // cycles. Same workload, same correctness, 0 deadlocks, p99 186ms, 575
     // requests/second — an 86x improvement.
     //
     // This lock is a THROUGHPUT optimisation, not the correctness mechanism.
     // The exclusion constraint below remains the authority. If a future code
     // path forgets this lock or takes it on the wrong row, the constraint
     // still refuses to store an overlap; the system gets slow, not wrong.
     // That separation is the entire architectural claim.
     if (resolved.length > 0) {
          const resourceIds = [...new Set(resolved.map((r) => r.resourceId))].sort();
          await client.query(
               `SELECT id FROM inventory_resources
                 WHERE id = ANY($1::uuid[])
                 ORDER BY id
                   FOR UPDATE`,
               [resourceIds]
          );
     }

     // ── 5. Reap expired holds on exactly these resources ──────────────────
     if (resolved.length > 0) {
          await reapExpired(client, resolved.map((r) => r.resourceId), ctx);
     }

     // ── 6. Create the hold ────────────────────────────────────────────────
     const holdId = req.holdId || crypto.randomUUID();
     const { rows: holdRows } = await client.query(
          `INSERT INTO holds (id, event_id, customer_id, reservation_id, state, expires_at,
                              item_count, correlation_id, trace_id)
           VALUES ($1, $2, $3, $4, 'ACTIVE', now() + ($5 || ' seconds')::interval, $6, $7, $8)
           RETURNING id, expires_at, created_at`,
          [
               holdId,
               req.eventId,
               req.customerId,
               req.reservationId || null,
               String(ttlSeconds),
               resolved.length + poolReqs.length,
               ctx.correlationId || null,
               ctx.traceId || null,
          ]
     );
     const hold = holdRows[0];

     // ── 7. Claim the resources ────────────────────────────────────────────
     const allocations = [];
     const ledgerEntries = [];
     let totalCents = 0;

     for (const item of resolved) {
          const span = spanLiteral(item.spanFrom, item.spanTo);
          try {
               const { rows } = await client.query(
                    `INSERT INTO allocations
                            (event_id, resource_id, span, state, hold_id, customer_id, expires_at, price_cents)
                     VALUES ($1, $2, $3::int4range, 'HELD', $4, $5, $6, $7)
                     RETURNING id, span, price_cents`,
                    [
                         req.eventId,
                         item.resourceId,
                         span,
                         holdId,
                         req.customerId,
                         hold.expires_at,
                         item.priceCents,
                    ]
               );

               const alloc = rows[0];
               allocations.push({
                    allocationId: alloc.id,
                    resourceId: item.resourceId,
                    resourceCode: item.code,
                    spanFrom: item.spanFrom,
                    spanTo: item.spanTo,
                    priceCents: Number(alloc.price_cents),
               });
               totalCents += Number(alloc.price_cents);

               ledgerEntries.push({
                    eventId: req.eventId,
                    resourceId: item.resourceId,
                    span,
                    entryType: 'ALLOCATED',
                    delta: -1,
                    allocationId: alloc.id,
                    holdId,
                    actor,
                    reason: 'reserve',
                    requestId: ctx.requestId,
                    correlationId: ctx.correlationId,
                    traceId: ctx.traceId,
               });
          } catch (err) {
               if (isOversellPrevented(err)) {
                    // The database refused to create an overlapping live
                    // allocation. This is the system working, not failing.
                    metrics.oversellPrevented.inc({ event_id: req.eventId });
                    throw new ConflictError(
                         `${item.code} is already taken for the requested span`,
                         'RESOURCE_UNAVAILABLE',
                         { resourceCode: item.code, spanFrom: item.spanFrom, spanTo: item.spanTo }
                    );
               }
               throw err;
          }
     }

     // ── 8. Claim pool quantities ──────────────────────────────────────────
     const poolClaims = [];
     for (const poolReq of poolReqs) {
          const claim = await claimPool(client, {
               eventId: req.eventId,
               code: poolReq.poolCode,
               quantity: poolReq.quantity,
               holdId,
               expiresAt: hold.expires_at,
          });
          poolClaims.push(claim);
          totalCents += claim.priceCents;
          ledgerEntries.push({
               eventId: req.eventId,
               poolId: claim.poolId,
               bucket: claim.bucket,
               entryType: 'ALLOCATED',
               delta: -claim.quantity,
               holdId,
               actor,
               reason: 'reserve',
               requestId: ctx.requestId,
               correlationId: ctx.correlationId,
               traceId: ctx.traceId,
          });
     }

     await client.query(`UPDATE holds SET total_cents = $2 WHERE id = $1`, [holdId, totalCents]);

     // ── 9. Ledger ─────────────────────────────────────────────────────────
     await ledger.append(client, ledgerEntries);

     // ── 10. Outbox, in the same transaction as everything above ────────────
     const seq = await nextSeq(client, req.eventId);
     await enqueue(client, {
          topic: 'inventory.events',
          type: 'inventory.held',
          aggregateId: req.eventId,
          aggregateSeq: seq,
          correlationId: ctx.correlationId,
          traceId: ctx.traceId,
          payload: {
               hold_id: holdId,
               event_id: req.eventId,
               customer_id: req.customerId,
               reservation_id: req.reservationId || null,
               expires_at: hold.expires_at.toISOString(),
               total_cents: totalCents,
               items: allocations.map((a) => ({
                    allocation_id: a.allocationId,
                    resource_id: a.resourceId,
                    resource_code: a.resourceCode,
                    span_from: a.spanFrom,
                    span_to: a.spanTo,
               })),
               pool_items: poolClaims.map((p) => ({
                    pool_id: p.poolId,
                    pool_code: p.code,
                    quantity: p.quantity,
               })),
          },
     });

     // Chaos scenario: everything is written but not yet committed. Expected
     // recovery — the transaction rolls back and no inventory is consumed.
     await failpoint('reserve.before_commit');

     return {
          holdId,
          eventId: req.eventId,
          customerId: req.customerId,
          reservationId: req.reservationId || null,
          expiresAt: hold.expires_at,
          createdAt: hold.created_at,
          totalCents,
          allocations,
          poolClaims,
     };
}

/**
 * Turn resource codes into ids, validate spans against the event's axis, and
 * carry prices forward.
 *
 * One query for the whole batch: resolving N resources with N queries would
 * multiply the transaction's lock-hold time by N for no reason.
 */
async function resolveResources(client, eventId, reqs, spanMax) {
     if (reqs.length === 0) return [];

     for (const r of reqs) {
          if (!Number.isInteger(r.spanFrom) || !Number.isInteger(r.spanTo)) {
               throw new BadRequestError('spanFrom and spanTo must be integers');
          }
          if (r.spanFrom < 0 || r.spanTo <= r.spanFrom) {
               throw new BadRequestError(
                    `Invalid span [${r.spanFrom},${r.spanTo}): the end must come after the start`
               );
          }
          if (r.spanTo > spanMax) {
               throw new BadRequestError(
                    `Span end ${r.spanTo} exceeds this event's axis (max ${spanMax})`
               );
          }
     }

     const ids = reqs.filter((r) => r.resourceId).map((r) => r.resourceId);
     const codes = reqs.filter((r) => !r.resourceId && r.resourceCode).map((r) => r.resourceCode);

     const { rows } = await client.query(
          `SELECT id, code, class, base_price_cents, state
             FROM inventory_resources
            WHERE event_id = $1 AND (id = ANY($2::uuid[]) OR code = ANY($3::text[]))`,
          [eventId, ids, codes]
     );

     const byId = new Map(rows.map((r) => [r.id, r]));
     const byCode = new Map(rows.map((r) => [r.code, r]));

     return reqs.map((r) => {
          const row = r.resourceId ? byId.get(r.resourceId) : byCode.get(r.resourceCode);
          if (!row) {
               throw new NotFoundError(`Resource ${r.resourceId || r.resourceCode} not found in this event`);
          }
          if (row.state !== 'ENABLED') {
               throw new ConflictError(`Resource ${row.code} is ${row.state}`, 'RESOURCE_DISABLED');
          }
          return {
               resourceId: row.id,
               code: row.code,
               class: row.class,
               priceCents: r.priceCents ?? Number(row.base_price_cents),
               spanFrom: r.spanFrom,
               spanTo: r.spanTo,
          };
     });
}

/**
 * Expire holds that have passed their TTL, limited to the given resources.
 *
 * Scoped deliberately: a global expiry scan on the hot path would make every
 * reservation pay for the whole table. Touching only the rows this request is
 * about to contend on keeps it proportional to the request.
 */
async function reapExpired(client, resourceIds, ctx = {}) {
     const { rows: expired } = await client.query(
          `UPDATE allocations
              SET state = 'EXPIRED'
            WHERE state = 'HELD'
              AND expires_at <= now()
              AND resource_id = ANY($1::uuid[])
        RETURNING id, event_id, resource_id, hold_id, span`,
          [resourceIds]
     );

     if (expired.length === 0) return 0;

     await ledger.append(
          client,
          expired.map((a) => ({
               eventId: a.event_id,
               resourceId: a.resource_id,
               span: a.span,
               entryType: 'EXPIRED',
               delta: +1,
               allocationId: a.id,
               holdId: a.hold_id,
               actor: 'system:lazy-reap',
               reason: 'hold_ttl_elapsed',
               requestId: ctx.requestId,
               traceId: ctx.traceId,
          }))
     );

     // Close out any hold with no live allocations left.
     const holdIds = [...new Set(expired.map((a) => a.hold_id).filter(Boolean))];
     if (holdIds.length > 0) {
          await client.query(
               `UPDATE holds
                   SET state = 'EXPIRED'
                 WHERE id = ANY($1::uuid[])
                   AND state = 'ACTIVE'
                   AND NOT EXISTS (
                        SELECT 1 FROM allocations a WHERE a.hold_id = holds.id AND a.state = 'HELD'
                   )`,
               [holdIds]
          );
     }

     metrics.holdsExpired.inc({ reaped_by: 'lazy' }, expired.length);
     return expired.length;
}

/**
 * Claim `quantity` units from a pool.
 *
 * Bucket selection starts at a hash of the hold id rather than always at bucket
 * 0. Starting at 0 would make bucket 0 the hot row and defeat the sharding
 * entirely. On a full bucket the claim walks to the next one, so capacity is
 * never stranded just because the first choice was busy.
 */
async function claimPool(client, { eventId, code, quantity, holdId, expiresAt }) {
     if (!Number.isInteger(quantity) || quantity <= 0) {
          throw new BadRequestError('Pool quantity must be a positive integer');
     }

     const { rows: poolRows } = await client.query(
          `SELECT id, bucket_count, price_cents FROM inventory_pools WHERE event_id = $1 AND code = $2`,
          [eventId, code]
     );
     if (poolRows.length === 0) throw new NotFoundError(`Pool ${code} not found in this event`);
     const pool = poolRows[0];

     const start = Math.abs(hashCode(holdId)) % pool.bucket_count;

     for (let i = 0; i < pool.bucket_count; i++) {
          const bucket = (start + i) % pool.bucket_count;

          // Conditional update: the WHERE clause is the availability check, so
          // check and claim are one atomic statement. There is no window in
          // which another transaction could take the capacity between them.
          const { rows } = await client.query(
               `UPDATE pool_buckets
                   SET held = held + $3
                 WHERE pool_id = $1 AND bucket = $2
                   AND capacity - held - confirmed >= $3
             RETURNING bucket, capacity, held, confirmed`,
               [pool.id, bucket, quantity]
          );

          if (rows.length > 0) {
               const { rows: claimRows } = await client.query(
                    `INSERT INTO pool_claims (hold_id, pool_id, bucket, quantity, state, expires_at)
                     VALUES ($1, $2, $3, $4, 'HELD', $5)
                     RETURNING id`,
                    [holdId, pool.id, bucket, quantity, expiresAt]
               );
               return {
                    claimId: claimRows[0].id,
                    poolId: pool.id,
                    code,
                    bucket,
                    quantity,
                    priceCents: Number(pool.price_cents) * quantity,
               };
          }
     }

     throw new ConflictError(`Pool ${code} has no capacity for ${quantity} unit(s)`, 'POOL_EXHAUSTED', {
          poolCode: code,
          quantity,
     });
}

function hashCode(str) {
     let h = 0;
     for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
     return h;
}

module.exports = { reserve, reapExpired, claimPool, resolveResources, spanLiteral, DEFAULT_TTL_SECONDS };
