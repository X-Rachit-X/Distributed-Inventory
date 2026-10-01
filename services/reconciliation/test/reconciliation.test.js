'use strict';

/**
 * Reconciliation tests.
 *
 * Each test breaks something on purpose, then asserts that reconciliation
 * noticed. A detector nobody has seen fire is not a detector — it is an
 * untested assumption with a dashboard.
 *
 * The most important assertion in this file is the negative one: that money
 * issues are NOT repaired automatically.
 *
 * NOTE ON TEST ISOLATION. An earlier version of this file cleared
 * `reconciliation_issues` and `repair_log` between tests, and every test failed
 * with "repair_log is append-only; DELETE is not permitted". That was the
 * system working: the audit trail refuses to be erased, by anyone, including
 * its own test suite. The tests were rewritten to assert on the specific
 * entities they created rather than on global counts — which is better practice
 * anyway, since it removes any dependence on a shared, mutable starting state.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createPool } = require('@tessera/shared/src/db/pool');
const { ReconciliationWorker } = require('../src/worker');
const { reserve } = require('../../inventory-engine/src/engine/reserve');
const { seedEvent, cleanupEvent } = require('../../inventory-engine/test/helpers');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

let recon;
let invPool;
let resPool;
let payPool;
let worker;
const createdEvents = [];
const createdPayments = [];
const createdReservations = [];

const url = (db) =>
     process.env[`${db.toUpperCase()}_DATABASE_URL`] || `postgresql://tessera:tessera@localhost:5432/${db}`;

before(async () => {
     recon = createPool({ connectionString: url('reconciliation'), name: 't-recon', max: 5 });
     invPool = createPool({ connectionString: url('inventory'), name: 't-inv', max: 5 });
     resPool = createPool({ connectionString: url('reservation'), name: 't-res', max: 5 });
     payPool = createPool({ connectionString: url('payment'), name: 't-pay', max: 5 });

     worker = new ReconciliationWorker({
          recon,
          inventory: invPool,
          reservation: resPool,
          payment: payPool,
          // In production these are separate, write-capable clients; the read
          // paths above use read-only roles.
          repairers: { inventory: invPool, reservation: resPool },
          logger: silent,
          options: { autoRepair: true, minSightingsBeforeRepair: 2 },
     });
});

after(async () => {
     for (const eventId of createdEvents) await cleanupEvent(invPool, eventId).catch(() => {});
     for (const id of createdPayments) await payPool.query('DELETE FROM payments WHERE id = $1', [id]).catch(() => {});
     for (const id of createdReservations) {
          await resPool.query('DELETE FROM sagas WHERE reservation_id = $1', [id]).catch(() => {});
          await resPool.query('DELETE FROM reservations WHERE id = $1', [id]).catch(() => {});
     }
     await Promise.all([recon.end(), invPool.end(), resPool.end(), payPool.end()]);
});

/** The issue for one specific entity, or undefined. */
async function issueFor(kind, entityId) {
     const { rows } = await recon.query(
          `SELECT * FROM reconciliation_issues WHERE kind = $1 AND entity_id = $2`,
          [kind, entityId]
     );
     return rows[0];
}

/** Create a hold and force it well past its TTL and the check's grace window. */
async function strandedHold(customerId) {
     const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
     createdEvents.push(eventId);

     const hold = await invPool.withTransaction((c) =>
          reserve(c, {
               eventId,
               customerId,
               resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
               ttlSeconds: 60,
          })
     );

     await invPool.query(
          `UPDATE holds SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`,
          [hold.holdId]
     );
     await invPool.query(`UPDATE allocations SET expires_at = now() - interval '1 hour' WHERE hold_id = $1`, [
          hold.holdId,
     ]);

     return { eventId, resourceIds, holdId: hold.holdId, allocationId: hold.allocations[0].allocationId };
}

/** A captured payment whose reservation was never confirmed. */
async function orphanPayment(customerId, amountCents = 5000) {
     const reservationId = crypto.randomUUID();
     const { rows } = await payPool.query(
          `INSERT INTO payments (reservation_id, customer_id, amount_cents, idempotency_key, state)
           VALUES ($1, $2, $3, $4, 'CREATED') RETURNING id`,
          [reservationId, customerId, amountCents, `recon-test-${crypto.randomUUID()}`]
     );
     const paymentId = rows[0].id;
     createdPayments.push(paymentId);

     // Reach CAPTURED through the guarded transition, as the real flow does.
     await payPool.query(`UPDATE payments SET state = 'CAPTURED' WHERE id = $1`, [paymentId]);
     await payPool.query(`UPDATE payments SET captured_at = now() - interval '20 minutes' WHERE id = $1`, [
          paymentId,
     ]);

     return { paymentId, reservationId };
}

describe('detection', () => {
     test('finds an expired hold that still withholds inventory', async () => {
          const { allocationId } = await strandedHold('stuck-customer');

          await worker.run();

          const issue = await issueFor('EXPIRED_HOLD_STILL_ALLOCATED', allocationId);
          assert.ok(issue, 'the stranded hold must be detected');
          assert.equal(issue.money_involved, false);
          assert.equal(issue.severity, 'HIGH');
     });

     test('detects ledger drift when inventory moves without being recorded', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          // Simulate a code path that allocates inventory but forgets the
          // ledger — exactly the defect the fold exists to catch.
          const { rows: h } = await invPool.query(
               `INSERT INTO holds (event_id, customer_id, expires_at)
                VALUES ($1, 'sneaky', now() + interval '1 hour') RETURNING id`,
               [eventId]
          );
          await invPool.query(
               `INSERT INTO allocations (event_id, resource_id, span, state, hold_id, customer_id, expires_at)
                VALUES ($1, $2, '[0,1)'::int4range, 'HELD', $3, 'sneaky', now() + interval '1 hour')`,
               [eventId, resourceIds[0], h[0].id]
          );

          await worker.run();

          const issue = await issueFor('LEDGER_DRIFT', resourceIds[0]);
          assert.ok(issue, 'unrecorded inventory movement must surface as drift');
          assert.equal(issue.severity, 'CRITICAL');
          assert.equal(issue.money_involved, false);
     });

     test('detects a captured payment with no confirmed reservation', async () => {
          const { paymentId } = await orphanPayment('orphan-customer');

          await worker.run();

          const issue = await issueFor('PAYMENT_WITHOUT_BOOKING', paymentId);
          assert.ok(issue, 'money taken with nothing behind it must be detected');
          assert.equal(issue.money_involved, true);
          assert.equal(issue.severity, 'CRITICAL');
     });

     test('detects a saga that stopped progressing', async () => {
          const { rows } = await resPool.query(
               `INSERT INTO reservations (customer_id, event_ref, state)
                VALUES ('stalled', 'evt-x', 'PENDING') RETURNING id`
          );
          const reservationId = rows[0].id;
          createdReservations.push(reservationId);

          const { rows: saga } = await resPool.query(
               `INSERT INTO sagas (reservation_id, state, updated_at, next_run_at)
                VALUES ($1, 'PAYMENT_PENDING', now() - interval '10 minutes', now()) RETURNING id`,
               [reservationId]
          );

          await worker.run();

          const issue = await issueFor('STUCK_SAGA', saga[0].id);
          assert.ok(issue, 'a saga that stopped moving must be detected');
     });
});

describe('repair policy', () => {
     test('money issues are never repaired automatically', async () => {
          const { paymentId } = await orphanPayment('no-auto-refund', 9900);

          // Two passes: enough sightings that a non-money issue would be repaired.
          await worker.run();
          await worker.run();

          const issue = await issueFor('PAYMENT_WITHOUT_BOOKING', paymentId);
          assert.ok(issue);
          assert.equal(
               issue.repair_status,
               'AWAITING_HUMAN',
               'a financial inconsistency must wait for a human, never be auto-corrected'
          );
          assert.ok(issue.recommended_action, 'a recommendation must still be offered');

          const { rows: repairs } = await recon.query(
               `SELECT count(*)::int AS n FROM repair_log WHERE issue_id = $1 AND automatic = true`,
               [issue.id]
          );
          assert.equal(repairs[0].n, 0, 'no automatic repair may be logged for a money issue');

          // And the payment itself is untouched.
          const { rows: pay } = await payPool.query(`SELECT state FROM payments WHERE id = $1`, [paymentId]);
          assert.equal(pay[0].state, 'CAPTURED', 'the payment must not have been altered');
     });

     test('an expired hold is repaired only after being confirmed twice', async () => {
          const { allocationId, resourceIds, holdId } = await strandedHold('repairable');

          // First pass: seen once. Not acted on — it could be in-flight state.
          await worker.run();
          let issue = await issueFor('EXPIRED_HOLD_STILL_ALLOCATED', allocationId);
          assert.equal(issue.repair_status, 'OPEN', 'one sighting is not enough to act on');
          assert.equal(issue.seen_count, 1);

          // Second pass: confirmed, and now safe to repair.
          await worker.run();
          issue = await issueFor('EXPIRED_HOLD_STILL_ALLOCATED', allocationId);
          assert.equal(issue.repair_status, 'AUTO_REPAIRED', 'a confirmed inventory issue is safe to repair');

          const { rows: alloc } = await invPool.query(`SELECT state FROM allocations WHERE id = $1`, [
               allocationId,
          ]);
          assert.equal(alloc[0].state, 'EXPIRED', 'the allocation must actually have been expired');

          const { rows: hold } = await invPool.query(`SELECT state FROM holds WHERE id = $1`, [holdId]);
          assert.equal(hold[0].state, 'EXPIRED', 'the parent hold must be closed out too');

          // The repair must itself keep the books straight.
          const { rows: drift } = await invPool.query(
               `SELECT count(*)::int AS n FROM invariant_ledger_drift WHERE resource_id = $1`,
               [resourceIds[0]]
          );
          assert.equal(drift[0].n, 0, 'the repair must leave the ledger consistent');

          // And it must be recorded, since the repair log cannot be erased.
          const { rows: log } = await recon.query(
               `SELECT outcome, automatic FROM repair_log WHERE issue_id = $1`,
               [issue.id]
          );
          assert.equal(log.length, 1);
          assert.equal(log[0].outcome, 'SUCCESS');
          assert.equal(log[0].automatic, true);
     });

     test('an issue that resolves on its own is recorded, not left open', async () => {
          const { allocationId, holdId } = await strandedHold('transient');

          await worker.run();
          const before = await issueFor('EXPIRED_HOLD_STILL_ALLOCATED', allocationId);
          assert.ok(before);
          assert.equal(before.repair_status, 'OPEN');

          // The sweeper gets to it before reconciliation's next pass.
          await invPool.query(`UPDATE allocations SET state = 'EXPIRED' WHERE hold_id = $1 AND state = 'HELD'`, [
               holdId,
          ]);

          await worker.run();
          const after = await issueFor('EXPIRED_HOLD_STILL_ALLOCATED', allocationId);
          assert.equal(
               after.repair_status,
               'RESOLVED_ITSELF',
               'convergence must be recorded, so the issue list stays trustworthy'
          );
     });
});

describe('scoreboard', () => {
     test('reports counters and an all-clear flag', async () => {
          await worker.run();
          const board = await worker.scoreboard();

          for (const key of ['oversells', 'duplicateBookings', 'ledgerMismatches', 'stuckSagas']) {
               assert.equal(typeof board[key], 'number', `${key} must be a number`);
          }
          assert.equal(typeof board.allClear, 'boolean');
          assert.ok(board.lastRunAt, 'the scoreboard must report when it was last refreshed');
     });
});

describe('detection: checks added after the code review', () => {
     test('detects a confirmed reservation with no confirmed seat in inventory', async () => {
          const { rows } = await resPool.query(
               `INSERT INTO reservations (customer_id, event_ref, state, updated_at)
                VALUES ('no-seat', 'evt-x', 'CONFIRMED', now() - interval '10 minutes') RETURNING id`
          );
          const reservationId = rows[0].id;
          createdReservations.push(reservationId);

          await worker.run();

          const issue = await issueFor('BOOKING_WITHOUT_ALLOCATION', reservationId);
          assert.ok(issue, 'a ticket with no seat behind it must be detected');
          assert.equal(issue.severity, 'CRITICAL');
          assert.equal(issue.money_involved, true);
          assert.equal(issue.repair_status, 'AWAITING_HUMAN', 'a paying customer is involved: never automatic');
     });

     test('detects a seat confirmed for a reservation that is not confirmed', async () => {
          const { holdId, allocationId } = await strandedHold('seat-no-ticket');
          // Make the hold live again so it can be confirmed, as the saga would.
          await invPool.query(
               `UPDATE holds SET expires_at = now() + interval '1 hour' WHERE id = $1`,
               [holdId]
          );
          await invPool.query(`UPDATE allocations SET expires_at = now() + interval '1 hour' WHERE hold_id = $1`, [holdId]);

          // The reservation behind it was refunded and cancelled, but the seat
          // stayed confirmed in inventory.
          const { rows } = await resPool.query(
               `INSERT INTO reservations (customer_id, event_ref, state)
                VALUES ('seat-no-ticket', 'evt-x', 'CANCELLED') RETURNING id`
          );
          const reservationId = rows[0].id;
          createdReservations.push(reservationId);
          const { confirm } = require('../../inventory-engine/src/engine/confirm');
          await invPool.withTransaction((c) => confirm(c, { holdId, bookingId: reservationId }));
          await invPool.query(`UPDATE allocations SET created_at = now() - interval '1 hour' WHERE id = $1`, [allocationId]);

          await worker.run();

          const issue = await issueFor('ALLOCATION_WITHOUT_BOOKING', reservationId);
          assert.ok(issue, 'capacity withheld with no ticket behind it must be detected');
          assert.equal(issue.money_involved, true);
          assert.equal(issue.repair_status, 'AWAITING_HUMAN', 'freeing the seat cancels a booking: never automatic');
     });

     test('detects a payment whose reservation does not exist', async () => {
          const { rows } = await payPool.query(
               `INSERT INTO payments (reservation_id, customer_id, amount_cents, idempotency_key, state, created_at)
                VALUES ($1, 'ghost', 1200, $2, 'CREATED', now() - interval '20 minutes') RETURNING id`,
               [crypto.randomUUID(), `recon-test-${crypto.randomUUID()}`]
          );
          const paymentId = rows[0].id;
          createdPayments.push(paymentId);
          await payPool.query(`UPDATE payments SET state = 'CAPTURED' WHERE id = $1`, [paymentId]);

          await worker.run();

          const issue = await issueFor('ORPHAN_PAYMENT', paymentId);
          assert.ok(issue, 'money attached to no reservation at all must be detected');
          assert.equal(issue.money_involved, true);
     });
});
