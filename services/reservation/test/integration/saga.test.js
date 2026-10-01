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

// ════════════════════════════════════════════════════════════════════════════
// Edge cases found by reading the code (docs/learn/06 §4). Each test below
// failed against the code before its fix.
// ════════════════════════════════════════════════════════════════════════════

/** Tick until the saga reaches `target`, failing if it never does. */
async function tickUntil(sagaId, target, maxTicks = 20) {
     for (let i = 0; i < maxTicks; i++) {
          if ((await sagaState(sagaId)).state === target) return;
          const worked = await orchestrator.tick({ batchSize: 10 });
          if (worked === 0) await new Promise((r) => setTimeout(r, 60));
     }
     assert.fail(`saga never reached ${target} (stuck in ${(await sagaState(sagaId)).state})`);
}

const sagaContext = async (sagaId) =>
     (await resPool.query(`SELECT context FROM sagas WHERE id = $1`, [sagaId])).rows[0].context;

const reservationRow = async (reservationId) =>
     (await resPool.query(`SELECT state, payment_id FROM reservations WHERE id = $1`, [reservationId])).rows[0];

describe('payments the saga never saw finish', () => {
     test('a charge left in CREATED is never treated as paid', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);
          const { sagaId, reservationId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'created-replay',
          });
          await tickUntil(sagaId, 'HOLD_CREATED');

          // An earlier charge attempt committed its payment row, then the
          // payment process died before calling the provider. No money moved.
          const key = `saga:${sagaId}:payment`;
          await payPool.query(
               `INSERT INTO payments (reservation_id, customer_id, amount_cents, idempotency_key, provider)
                VALUES ($1, 'created-replay', 1000, $2, 'fake')`,
               [reservationId, key]
          );

          // The saga's charge is replayed and comes back CREATED.
          await orchestrator.tick({ batchSize: 10 });
          assert.equal(
               (await sagaState(sagaId)).state,
               'PAYMENT_UNKNOWN',
               'CREATED is not proof of payment; the saga must ask, not confirm'
          );

          // Once the row is stale, resolution asks the provider, which has no
          // record of it: the booking fails and the seat goes back on sale.
          await payPool.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE idempotency_key = $1`, [
               key,
          ]);
          await drive(40);

          assert.notEqual((await reservationRow(reservationId)).state, 'CONFIRMED');
          assert.equal((await sagaState(sagaId)).state, 'COMPENSATED');
          assert.equal(await liveAllocations(eventId), 0, 'the seat must be released');
          const { rows } = await payPool.query(`SELECT state FROM payments WHERE idempotency_key = $1`, [key]);
          assert.equal(rows[0].state, 'FAILED');
     });

     test('a charge whose response was lost is found by its key and the booking completes', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);
          const { sagaId, reservationId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'lost-response',
          });
          await tickUntil(sagaId, 'HOLD_CREATED');

          // The charge succeeded, but the saga never received the answer (its
          // call to the payment service timed out), so it holds no payment id.
          const charged = await payments.charge({
               reservationId,
               customerId: 'lost-response',
               amountCents: 1000,
               idempotencyKey: `saga:${sagaId}:payment`,
          });
          assert.equal(charged.state, 'CAPTURED');
          await resPool.query(`UPDATE sagas SET state = 'PAYMENT_PENDING' WHERE id = $1`, [sagaId]);
          await resPool.query(
               `UPDATE sagas SET state = 'PAYMENT_UNKNOWN', next_run_at = now(),
                       step_deadline_at = now() + interval '5 minutes', lease_owner = NULL, lease_until = NULL,
                       context = context - 'paymentId'
                 WHERE id = $1`,
               [sagaId]
          );

          await drive(30);

          assert.equal((await sagaState(sagaId)).state, 'CONFIRMED', 'the customer paid, so the booking completes');
          assert.equal((await reservationRow(reservationId)).payment_id, charged.paymentId);
          const { rows } = await payPool.query(`SELECT count(*)::int AS n FROM payments WHERE reservation_id = $1`, [
               reservationId,
          ]);
          assert.equal(rows[0].n, 1, 'exactly one charge');
     });

     test('resolution completes even when the payment was settled by someone else first', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);
          const { sagaId, reservationId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'settled-first',
               paymentMode: 'timeout_after_success',
          });
          await tickUntil(sagaId, 'PAYMENT_UNKNOWN');
          const { paymentId } = await sagaContext(sagaId);

          // The payment service's own resolver gets to it before the saga does.
          const settled = await payments.resolveUnknown(paymentId);
          assert.equal(settled.state, 'CAPTURED');

          await drive(30);

          assert.equal(
               (await sagaState(sagaId)).state,
               'CONFIRMED',
               'an already-captured payment must not leave the saga waiting for an answer that came'
          );
          assert.equal(
               (await reservationRow(reservationId)).payment_id,
               paymentId,
               'the reservation must record the payment, or reconciliation reports it as unpaid'
          );
     });

     test('the payment resolver settles charges abandoned in CREATED, each with its event', async () => {
          const { ResolverWorker } = require('../../../payment/src/workers/resolver.worker');
          const neverCharged = `abandoned-${crypto.randomUUID()}`;
          const charged = `abandoned-${crypto.randomUUID()}`;
          for (const key of [neverCharged, charged]) {
               await payPool.query(
                    `INSERT INTO payments (reservation_id, customer_id, amount_cents, idempotency_key, provider, created_at)
                     VALUES ($1, 'abandoned', 1000, $2, 'fake', now() - interval '10 minutes')`,
                    [crypto.randomUUID(), key]
               );
          }
          // The provider did take the money for one of them before the process died.
          await provider.charge({ idempotencyKey: charged, amountCents: 1000 });

          await new ResolverWorker({ pool: payPool, payments, logger: silentLogger }).tick();

          const stateOf = async (key) =>
               (await payPool.query(`SELECT id, state FROM payments WHERE idempotency_key = $1`, [key])).rows[0];
          const a = await stateOf(neverCharged);
          const b = await stateOf(charged);
          assert.equal(a.state, 'FAILED', 'no record at the provider means no money moved');
          assert.equal(b.state, 'CAPTURED', 'the provider took the money, so the payment is captured');

          // The state change and its event commit together: exactly one each.
          const events = async (paymentId, type) =>
               (
                    await payPool.query(
                         `SELECT count(*)::int AS n FROM outbox_events WHERE payload->>'payment_id' = $1 AND event_type = $2`,
                         [paymentId, type]
                    )
               ).rows[0].n;
          assert.equal(await events(a.id, 'payment.failed'), 1);
          assert.equal(await events(b.id, 'payment.captured'), 1);
     });
});

describe('a worker that dies inside a step', () => {
     test('re-runs the hold step instead of failing the booking', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);
          const { sagaId } = await createReservation({ eventId, resourceIds, customerId: 'died-in-hold' });

          // The dead worker had marked the step started; its deadline has
          // lapsed by the time anyone else may claim the saga.
          await resPool.query(
               `UPDATE sagas SET state = 'HOLD_PENDING', step_deadline_at = now() - interval '1 second', next_run_at = now()
                 WHERE id = $1`,
               [sagaId]
          );

          await drive(30);

          assert.equal((await sagaState(sagaId)).state, 'CONFIRMED');
     });

     test('re-runs the confirm step instead of refunding a customer whose seat was confirmed', async () => {
          const { eventId, resourceIds } = await seedEvent(invPool, { resourceCount: 1 });
          createdEvents.push(eventId);
          const { sagaId, reservationId } = await createReservation({
               eventId,
               resourceIds,
               customerId: 'died-in-confirm',
          });
          await tickUntil(sagaId, 'PAYMENT_AUTHORIZED');
          const { holdId, paymentId } = await sagaContext(sagaId);

          // The dead worker's confirm committed in inventory, then it died
          // before recording that, with the step's deadline now lapsed.
          await invPool.withTransaction((c) => inventoryEngine.confirm(c, { holdId, bookingId: reservationId }));
          await resPool.query(
               `UPDATE sagas SET state = 'CONFIRM_PENDING', step_deadline_at = now() - interval '1 second',
                       next_run_at = now(), lease_owner = NULL, lease_until = NULL
                 WHERE id = $1`,
               [sagaId]
          );

          await drive(30);

          assert.equal((await sagaState(sagaId)).state, 'CONFIRMED', 'the seat is confirmed, so the booking is issued');
          const { rows } = await payPool.query(`SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1`, [paymentId]);
          assert.equal(rows[0].n, 0, 'nobody may be refunded for a seat they hold');
     });
});
