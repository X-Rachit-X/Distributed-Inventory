'use strict';

/**
 * Saga and payment tests.
 *
 * These are the scenarios that decide whether the system is trustworthy:
 *
 *   - payment fails        → is the seat given back?
 *   - payment times out    → is the charge investigated rather than assumed?
 *   - the process dies mid-saga → does another worker finish the job?
 *   - paid, then the hold expired → is the money returned, not silently lost?
 *   - a webhook is replayed → is it applied once?
 *   - a forged webhook arrives → is the payment left untouched?
 *
 * Each runs against real PostgreSQL and the real engine.
 */

const { test, before, after, beforeEach, describe } = require('node:test');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const { createPool } = require('@tessera/shared/src/db/pool');
const inventoryEngine = {
     ...require('../../../inventory-engine/src/engine/reserve'),
     ...require('../../../inventory-engine/src/engine/confirm'),
};
const { PaymentService } = require('../../../payment/src/service/payment.service');
const { FakeProvider } = require('../../../payment/src/providers/fake.provider');
const { SagaOrchestrator } = require('../../src/saga/orchestrator');
const { InProcessInventoryClient, InProcessPaymentClient } = require('../../src/clients');
const { seedEvent, cleanupEvent } = require('../../../inventory-engine/test/helpers');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

let invPool;
let resPool;
let payPool;
let provider;
let payments;
let orchestrator;
const createdEvents = [];

before(async () => {
     invPool = createPool({
          connectionString: process.env.INVENTORY_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/inventory',
          name: 'test-inv',
          max: 10,
     });
     resPool = createPool({
          connectionString: process.env.RESERVATION_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/reservation',
          name: 'test-res',
          max: 10,
     });
     payPool = createPool({
          connectionString: process.env.PAYMENT_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/payment',
          name: 'test-pay',
          max: 10,
     });

     provider = new FakeProvider({ webhookSecret: 'test-secret', logger: silentLogger });
     payments = new PaymentService({ pool: payPool, provider, logger: silentLogger });

     orchestrator = new SagaOrchestrator({
          pool: resPool,
          inventory: new InProcessInventoryClient({ pool: invPool, engine: inventoryEngine }),
          payments: new InProcessPaymentClient({ service: payments }),
          logger: silentLogger,
     });
});

after(async () => {
     for (const eventId of createdEvents) await cleanupEvent(invPool, eventId).catch(() => {});
     await Promise.all([invPool.end(), resPool.end(), payPool.end()]);
});

beforeEach(() => provider.setMode('ok'));

/** Create a reservation plus its saga, exactly as the API does. */
async function createReservation({ eventId, resourceIds, customerId, paymentMode, ttlSeconds = 600 }) {
     return resPool.withTransaction(async (client) => {
          const { rows } = await client.query(
               `INSERT INTO reservations (customer_id, event_ref, event_id, state, item_count, total_cents)
                VALUES ($1, $2, $3, 'PENDING', 1, 1000)
                RETURNING id`,
               [customerId, `evt-${eventId}`, eventId]
          );
          const reservationId = rows[0].id;

          const sagaId = await SagaOrchestrator.create(client, {
               reservationId,
               context: {
                    eventId,
                    customerId,
                    resources: [{ resourceId: resourceIds[0], spanFrom: 0, spanTo: 1 }],
                    ttlSeconds,
                    totalCents: 1000,
                    paymentMode,
               },
          });
          return { reservationId, sagaId };
     });
}

/** Drive the saga until it settles or the step budget runs out. */
async function drive(maxTicks = 25) {
     for (let i = 0; i < maxTicks; i++) {
          const worked = await orchestrator.tick({ batchSize: 10 });
          if (worked === 0) await new Promise((r) => setTimeout(r, 60));
     }
}

const sagaState = async (sagaId) => {
     const { rows } = await resPool.query(`SELECT state, last_error FROM sagas WHERE id = $1`, [sagaId]);
     return rows[0];
};

const liveAllocations = async (eventId) => {
     const { rows } = await invPool.query(
          `SELECT count(*)::int AS n FROM allocations WHERE event_id = $1 AND state IN ('HELD','CONFIRMED')`,
          [eventId]
     );
     return rows[0].n;
};

describe('saga happy path', () => {
     test('reserve → pay → confirm issues a booking', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const { reservationId, sagaId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'happy-customer',
          });

          await drive();

          assert.equal((await sagaState(sagaId)).state, 'CONFIRMED');

          const { rows } = await resPool.query(
               `SELECT r.state, b.reference FROM reservations r
                  LEFT JOIN bookings b ON b.reservation_id = r.id WHERE r.id = $1`,
               [reservationId]
          );
          assert.equal(rows[0].state, 'CONFIRMED');
          assert.ok(rows[0].reference, 'a booking reference must be issued');

          const { rows: alloc } = await invPool.query(
               `SELECT state FROM allocations WHERE event_id = $1`,
               [eventId]
          );
          assert.equal(alloc[0].state, 'CONFIRMED');
     });
});

describe('failure compensation', () => {
     test('a declined payment gives the seat back', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const { sagaId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'declined-customer',
               paymentMode: 'decline',
          });

          await drive();

          const state = (await sagaState(sagaId)).state;
          assert.equal(state, 'COMPENSATED', `expected COMPENSATED, got ${state}`);

          assert.equal(await liveAllocations(eventId), 0, 'the seat must be released, not stranded');
     });

     test('a seat released by compensation can be sold to someone else', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const first = await createReservation({
               eventId,
               resourceIds,
               customerId: 'will-fail',
               paymentMode: 'decline',
          });
          await drive();
          assert.equal((await sagaState(first.sagaId)).state, 'COMPENSATED');

          const second = await createReservation({
               eventId,
               resourceIds,
               customerId: 'will-succeed',
          });
          await drive();
          assert.equal((await sagaState(second.sagaId)).state, 'CONFIRMED');
     });
});

describe('indeterminate payments', () => {
     test('a provider timeout becomes UNKNOWN, not FAILED', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          // The provider takes the money and the response is lost.
          const { sagaId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'timeout-customer',
               paymentMode: 'timeout_after_success',
          });

          // One tick past the hold, one into the payment.
          await orchestrator.tick();
          await orchestrator.tick();
          await orchestrator.tick();

          const { rows } = await resPool.query(
               `SELECT state FROM sagas WHERE id = $1`,
               [sagaId]
          );
          assert.equal(
               rows[0].state,
               'PAYMENT_UNKNOWN',
               'a timeout must never be recorded as failure: the charge may have succeeded'
          );

          const { rows: resRow } = await resPool.query(`SELECT reservation_id FROM sagas WHERE id = $1`, [sagaId]);
          const { rows: pay } = await payPool.query(
               `SELECT state FROM payments WHERE reservation_id = $1`,
               [resRow[0].reservation_id]
          );
          assert.equal(pay[0].state, 'UNKNOWN');
     });

     test('resolution asks the provider and confirms the booking', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const { sagaId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'resolved-customer',
               paymentMode: 'timeout_after_success',
          });

          await drive(40);

          const state = (await sagaState(sagaId)).state;
          assert.equal(
               state,
               'CONFIRMED',
               `the provider confirms the charge succeeded, so the booking must complete (got ${state})`
          );

          // And critically: exactly one charge, never a second attempt.
          const { rows: resRow } = await resPool.query(`SELECT reservation_id FROM sagas WHERE id = $1`, [sagaId]);
          const { rows } = await payPool.query(
               `SELECT count(*)::int AS n FROM payments WHERE reservation_id = $1`,
               [resRow[0].reservation_id]
          );
          assert.equal(rows[0].n, 1, 'the customer must never be charged twice');
     });

     test('a charge that never reached the provider resolves to failure', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const { sagaId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'never-charged',
               paymentMode: 'timeout_before_success',
          });

          await drive(40);

          const state = (await sagaState(sagaId)).state;
          assert.ok(
               ['COMPENSATED', 'RELEASED'].includes(state),
               `no money moved, so the seat must be released (got ${state})`
          );
          assert.equal(await liveAllocations(eventId), 0);
     });
});

describe('crash recovery', () => {
     test('a saga abandoned mid-flight is completed by another worker', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const { sagaId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'crash-customer',
          });

          // Advance one step, then simulate the worker dying: its lease is left
          // behind with no process to release it.
          await orchestrator.tick();
          await resPool.query(
               `UPDATE sagas SET lease_owner = 'dead-worker', lease_until = now() + interval '60 seconds' WHERE id = $1`,
               [sagaId]
          );

          // A second worker cannot touch it while the lease holds.
          const blocked = await orchestrator.tick();
          assert.equal(blocked, 0, 'a leased saga must not be claimed by another worker');

          // The lease expires because nothing renewed it.
          await resPool.query(`UPDATE sagas SET lease_until = now() - interval '1 second' WHERE id = $1`, [sagaId]);

          await drive();
          assert.equal(
               (await sagaState(sagaId)).state,
               'CONFIRMED',
               'a second worker must resume from the last committed state'
          );
     });

     test('two workers racing the same saga do not double-process it', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          await createReservation({ eventId, resourceIds, customerId: 'race-customer' });

          const workerB = new SagaOrchestrator({
               pool: resPool,
               inventory: new InProcessInventoryClient({ pool: invPool, engine: inventoryEngine }),
               payments: new InProcessPaymentClient({ service: payments }),
               logger: silentLogger,
               workerId: 'worker-b',
          });

          // Both tick simultaneously, repeatedly.
          for (let i = 0; i < 12; i++) {
               await Promise.all([orchestrator.tick({ batchSize: 5 }), workerB.tick({ batchSize: 5 })]);
          }

          const { rows } = await invPool.query(
               `SELECT count(*)::int AS n FROM allocations WHERE event_id = $1 AND state IN ('HELD','CONFIRMED')`,
               [eventId]
          );
          assert.equal(rows[0].n, 1, 'concurrent workers must not double-allocate');
     });
});

describe('paid but unbookable', () => {
     test('a hold that expired after payment triggers a refund, never a silent loss', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);

          const { sagaId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'unlucky-customer',
               ttlSeconds: 30,
          });

          // Hold, then charge.
          await orchestrator.tick();
          await orchestrator.tick();

          // The hold lapses in the window between payment and confirmation —
          // the worst realistic case, and the one that loses customers' money
          // in systems that do not handle it.
          const { rows: ctx } = await resPool.query(`SELECT context FROM sagas WHERE id = $1`, [sagaId]);
          const holdId = ctx[0].context.holdId;
          if (holdId) {
               await invPool.query(
                    `UPDATE holds SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`,
                    [holdId]
               );
               await invPool.query(
                    `UPDATE allocations SET expires_at = now() - interval '1 hour' WHERE hold_id = $1 AND state = 'HELD'`,
                    [holdId]
               );
          }

          await drive(30);

          const state = (await sagaState(sagaId)).state;
          assert.ok(
               ['COMPENSATED', 'REFUND_PENDING', 'MANUAL_REVIEW'].includes(state),
               `payment taken but seat lost must lead to refund or human review, got ${state}`
          );

          // The payment database has no `sagas` table — services own their own
          // schemas and there are no cross-database joins anywhere in this
          // system. Resolve the id in the reservation database first.
          const { rows: resRow } = await resPool.query(`SELECT reservation_id FROM sagas WHERE id = $1`, [sagaId]);
          const { rows: refunds } = await payPool.query(
               `SELECT count(*)::int AS n FROM refunds
                 WHERE payment_id IN (SELECT id FROM payments WHERE reservation_id = $1)`,
               [resRow[0].reservation_id]
          );
          assert.ok(refunds[0].n >= 1 || state === 'MANUAL_REVIEW', 'the money must be accounted for');
     });
});

describe('webhook handling', () => {
     test('a replayed webhook is applied exactly once', async () => {
          const result = await payments.charge({
               reservationId: crypto.randomUUID(),
               customerId: 'webhook-customer',
               amountCents: 5000,
               idempotencyKey: `wh-${Date.now()}`,
          });

          const status = await provider.getStatus({ providerPaymentId: result.providerPaymentId });
          assert.ok(status.found, 'the provider must know about the charge');
          // Unique per run: replay protection is durable, so reusing a fixed
          // event id would make the second run see the first run's row.
          const eventId = `evt-replay-${crypto.randomUUID()}`;
          const body = JSON.stringify({
               id: eventId,
               type: 'payment.captured',
               data: { payment_id: status.providerPaymentId, order_ref: status.providerRef, amount: 5000 },
          });
          const ts = Math.floor(Date.now() / 1000);
          const sig = provider.sign(body, ts);

          const first = await payments.handleWebhook({ rawBody: body, signature: sig, timestamp: ts });
          const second = await payments.handleWebhook({ rawBody: body, signature: sig, timestamp: ts });

          assert.notEqual(first.status, 'duplicate');
          assert.equal(second.status, 'duplicate', 'a replayed webhook must be recognised and ignored');
     });

     test('a forged signature is rejected and changes nothing', async () => {
          const result = await payments.charge({
               reservationId: crypto.randomUUID(),
               customerId: 'forgery-target',
               amountCents: 7000,
               idempotencyKey: `forge-${Date.now()}`,
          });

          const before = await payments.get(result.paymentId);

          const body = JSON.stringify({
               id: `evt-forged-${crypto.randomUUID()}`,
               type: 'payment.failed',
               data: { payment_id: result.providerPaymentId },
          });

          await assert.rejects(
               payments.handleWebhook({
                    rawBody: body,
                    signature: 'deadbeef'.repeat(8),
                    timestamp: Math.floor(Date.now() / 1000),
               }),
               (err) => err.code === 'INVALID_SIGNATURE'
          );

          const after = await payments.get(result.paymentId);
          assert.equal(
               after.state,
               before.state,
               'a forged webhook must not move the payment — the old code marked it FAILED here'
          );

          const { rows } = await payPool.query(`SELECT count(*)::int AS n FROM signature_failures`);
          assert.ok(rows[0].n >= 1, 'the attempt must be recorded');
     });

     test('an expired timestamp is rejected even with a valid signature', async () => {
          const body = JSON.stringify({ id: `evt-stale-${crypto.randomUUID()}`, type: 'payment.captured', data: {} });
          const oldTs = Math.floor(Date.now() / 1000) - 3600;

          await assert.rejects(
               payments.handleWebhook({ rawBody: body, signature: provider.sign(body, oldTs), timestamp: oldTs }),
               (err) => err.code === 'INVALID_SIGNATURE',
               'a captured webhook replayed an hour later must not be accepted'
          );
     });
});
