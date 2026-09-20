'use strict';

/**
 * Concurrency tests for the production reserve path.
 *
 * These exercise the real engine — the same code the service runs — not a
 * simplified model of it. Every assertion is made against DATABASE STATE after
 * the traffic stops, never against how many promises resolved successfully.
 * A system can resolve two promises and write one row, or reject a caller after
 * having written theirs; only the stored rows are evidence.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const { reserve } = require('../../src/engine/reserve');
const { confirm, release, cancelBooking } = require('../../src/engine/confirm');
const {
     testPool,
     seedEvent,
     checkInvariants,
     cleanupEvent,
     fireConcurrently,
     expireHold,
} = require('../helpers');

let pool;
const createdEvents = [];

before(async () => {
     pool = testPool(64);
     await pool.query('SELECT 1');
});

after(async () => {
     for (const eventId of createdEvents) await cleanupEvent(pool, eventId).catch(() => {});
     await pool.end();
});

/** Reserve through the real engine, in its own transaction, as the service does. */
const doReserve = (req) => pool.withTransaction((client) => reserve(client, req));

describe('reserve under concurrency', () => {
     test('100 concurrent requests for 1 seat produce exactly 1 allocation', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const results = await fireConcurrently(100, (i) =>
               doReserve({
                    eventId,
                    customerId: `cust-${i}`,
                    resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
                    ttlSeconds: 60,
               })
          );

          const succeeded = results.filter((r) => r.ok).length;
          const conflicts = results.filter((r) => !r.ok && r.error.status === 409).length;
          const unexpected = results.filter((r) => !r.ok && r.error.status !== 409);

          assert.equal(
               unexpected.length,
               0,
               `unexpected non-conflict failures: ${unexpected.map((u) => u.error.message).join('; ')}`
          );

          // The authoritative check: count the rows.
          const { rows } = await pool.query(
               `SELECT count(*)::int AS live FROM allocations
                 WHERE event_id = $1 AND state IN ('HELD','CONFIRMED','BLOCKED')`,
               [eventId]
          );

          assert.equal(rows[0].live, 1, 'exactly one live allocation must exist');
          assert.equal(succeeded, 1, 'exactly one caller may be told it succeeded');
          assert.equal(conflicts, 99, 'every other caller must receive a 409 conflict');
     });

     test('1000 requests for 10 seats allocate exactly 10 — never 11', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 10 });
          createdEvents.push(eventId);

          const results = await fireConcurrently(1000, (i) =>
               doReserve({
                    eventId,
                    customerId: `cust-${i}`,
                    // Deterministic spread across the ten seats.
                    resources: [{ resourceId: resourceIds[i % 10], spanFrom: 0, spanTo: 1 }],
                    ttlSeconds: 60,
               })
          );

          const { rows } = await pool.query(
               `SELECT count(*)::int AS live FROM allocations
                 WHERE event_id = $1 AND state IN ('HELD','CONFIRMED','BLOCKED')`,
               [eventId]
          );

          assert.equal(rows[0].live, 10, 'exactly ten seats sold');
          assert.equal(results.filter((r) => r.ok).length, 10);

          const inv = await checkInvariants(pool, { eventId });
          assert.ok(inv.clean, `invariants violated: ${JSON.stringify(inv.violations)}`);
     });

     test('overlapping segments conflict; disjoint segments on one seat coexist', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 1, spanMax: 10 });
          createdEvents.push(eventId);
          const resourceId = resourceIds[0];

          // Delhi → Kanpur
          await doReserve({
               eventId,
               customerId: 'a',
               resources: [{ resourceId, spanFrom: 1, spanTo: 4 }],
               ttlSeconds: 60,
          });

          // Overlaps [1,4) — must be refused.
          await assert.rejects(
               doReserve({
                    eventId,
                    customerId: 'b',
                    resources: [{ resourceId, spanFrom: 2, spanTo: 6 }],
                    ttlSeconds: 60,
               }),
               (err) => err.status === 409
          );

          // Starts exactly where the first ends. Half-open ranges mean this is
          // NOT an overlap: one passenger alights as the other boards.
          const adjacent = await doReserve({
               eventId,
               customerId: 'c',
               resources: [{ resourceId, spanFrom: 4, spanTo: 8 }],
               ttlSeconds: 60,
          });
          assert.ok(adjacent.holdId, 'adjacent segment must be allowed — this is the resale case');

          const { rows } = await pool.query(
               `SELECT count(*)::int AS live FROM allocations WHERE resource_id = $1 AND state = 'HELD'`,
               [resourceId]
          );
          assert.equal(rows[0].live, 2, 'one seat, two non-overlapping journeys');
     });

     test('multi-resource reservation is all-or-nothing', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 2 });
          createdEvents.push(eventId);

          // Take the second seat so the pair cannot be satisfied.
          await doReserve({
               eventId,
               customerId: 'blocker',
               resources: [{ resourceId: resourceIds[1], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 60,
          });

          await assert.rejects(
               doReserve({
                    eventId,
                    customerId: 'pair-wanter',
                    resources: [
                         { resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 },
                         { resourceId: resourceIds[1], spanFrom: 0, spanTo: 1 },
                    ],
                    ttlSeconds: 60,
               }),
               (err) => err.status === 409
          );

          // The first seat must NOT have been left held by the failed attempt.
          const { rows } = await pool.query(
               `SELECT count(*)::int AS live FROM allocations
                 WHERE resource_id = $1 AND state IN ('HELD','CONFIRMED')`,
               [resourceIds[0]]
          );
          assert.equal(rows[0].live, 0, 'a failed multi-resource reserve must leave nothing behind');
     });

     test('concurrent opposite-order multi-resource requests do not deadlock', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 2 });
          createdEvents.push(eventId);
          const [a, b] = resourceIds;

          // Half the callers ask for {a,b}, half for {b,a}. Without deterministic
          // ordering inside the engine this is the textbook deadlock setup.
          const results = await fireConcurrently(40, (i) =>
               doReserve({
                    eventId,
                    customerId: `cust-${i}`,
                    resources:
                         i % 2 === 0
                              ? [
                                     { resourceId: a, spanFrom: 0, spanTo: 1 },
                                     { resourceId: b, spanFrom: 0, spanTo: 1 },
                                ]
                              : [
                                     { resourceId: b, spanFrom: 0, spanTo: 1 },
                                     { resourceId: a, spanFrom: 0, spanTo: 1 },
                                ],
                    ttlSeconds: 60,
               })
          );

          const deadlocks = results.filter((r) => !r.ok && r.error.code === '40P01');
          assert.equal(deadlocks.length, 0, 'sorted acquisition must prevent deadlock cycles');
          assert.equal(results.filter((r) => r.ok).length, 1, 'only one caller can get both seats');
     });
});

describe('hold lifecycle', () => {
     test('an expired hold cannot be confirmed, and its seat is reusable', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const hold = await doReserve({
               eventId,
               customerId: 'slow-payer',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 30,
          });

          // Force expiry rather than waiting: the behaviour under test is the
          // engine's response to an elapsed TTL, not the passage of time.
          await expireHold(pool, hold.holdId);

          await assert.rejects(
               pool.withTransaction((c) => confirm(c, { holdId: hold.holdId, bookingId: 'bk-1' })),
               (err) => err.code === 'HOLD_EXPIRED',
               'confirming an expired hold must fail'
          );

          // The seat must be available to the next customer, via lazy reap.
          const next = await doReserve({
               eventId,
               customerId: 'next-customer',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 60,
          });
          assert.ok(next.holdId, 'expired inventory must return to the pool');
     });

     test('confirm is idempotent', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const hold = await doReserve({
               eventId,
               customerId: 'c',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 300,
          });

          const first = await pool.withTransaction((c) =>
               confirm(c, { holdId: hold.holdId, bookingId: 'bk-idem' })
          );
          const second = await pool.withTransaction((c) =>
               confirm(c, { holdId: hold.holdId, bookingId: 'bk-idem' })
          );

          assert.equal(first.alreadyConfirmed, false);
          assert.equal(second.alreadyConfirmed, true, 'a repeated confirm must replay, not re-execute');

          const { rows } = await pool.query(
               `SELECT count(*)::int AS n FROM allocations WHERE hold_id = $1 AND state = 'CONFIRMED'`,
               [hold.holdId]
          );
          assert.equal(rows[0].n, 1);
     });

     test('released inventory becomes immediately available', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const hold = await doReserve({
               eventId,
               customerId: 'abandoner',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 600,
          });
          await pool.withTransaction((c) => release(c, { holdId: hold.holdId, reason: 'abandoned' }));

          const next = await doReserve({
               eventId,
               customerId: 'next',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 600,
          });
          assert.ok(next.holdId);
     });

     test('cancelling a confirmed booking returns the seat', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const hold = await doReserve({
               eventId,
               customerId: 'c',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 300,
          });
          await pool.withTransaction((c) => confirm(c, { holdId: hold.holdId, bookingId: 'bk-cancel' }));
          await pool.withTransaction((c) => cancelBooking(c, { bookingId: 'bk-cancel', reason: 'user' }));

          const next = await doReserve({
               eventId,
               customerId: 'after-cancel',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 300,
          });
          assert.ok(next.holdId, 'a cancelled booking must free its inventory');
     });
});

describe('ledger', () => {
     test('folding the ledger reproduces observed state', async () => {
          const { eventId, resourceIds } = await seedEvent(pool, { resourceCount: 3 });
          createdEvents.push(eventId);

          // A realistic mix: one confirmed, one released, one left held.
          const h1 = await doReserve({
               eventId,
               customerId: 'a',
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 300,
          });
          await pool.withTransaction((c) => confirm(c, { holdId: h1.holdId, bookingId: 'bk-ledger' }));

          const h2 = await doReserve({
               eventId,
               customerId: 'b',
               resources: [{ resourceId: resourceIds[1], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 300,
          });
          await pool.withTransaction((c) => release(c, { holdId: h2.holdId, reason: 'test' }));

          await doReserve({
               eventId,
               customerId: 'c',
               resources: [{ resourceId: resourceIds[2], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 300,
          });

          const { rows } = await pool.query(
               `SELECT count(*)::int AS drifted FROM invariant_ledger_drift WHERE resource_id = ANY($1::uuid[])`,
               [resourceIds]
          );
          assert.equal(rows[0].drifted, 0, 'ledger fold must equal actual state');
     });
});
