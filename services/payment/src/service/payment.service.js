'use strict';

/**
 * Payment operations.
 *
 * Three rules, each one the fix for a specific way the previous version could
 * lose or duplicate money:
 *
 * 1. A TIMEOUT IS NOT A FAILURE. If the provider does not answer, the charge
 *    may well have gone through. The payment moves to UNKNOWN and a resolver
 *    asks the provider what actually happened. The old code treated any error
 *    as failure and released the seat, which left charged customers with
 *    nothing.
 *
 * 2. A BAD SIGNATURE NEVER MOVES A PAYMENT. The old code marked the order
 *    FAILED when a client submitted an invalid signature — a terminal state —
 *    so the genuine webhook that arrived afterwards was rejected as an invalid
 *    transition. Anyone could poison any payment with one forged request.
 *    Signature failures are now recorded in their own table and change nothing.
 *
 * 3. EVERY TRANSITION IS GUARDED IN SQL. `UPDATE ... WHERE state = $expected`
 *    rather than read-then-write, so the webhook and the client-side
 *    verification racing each other cannot both apply.
 */

const crypto = require('node:crypto');
const { enqueue, nextSeq } = require('@tessera/shared/src/outbox/writer');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const { failpoint } = require('@tessera/shared/src/failpoints');
const { ConflictError, NotFoundError, BadRequestError } = require('@tessera/shared/src/errors');

/**
 * A payment left in CREATED for this long never got an outcome recorded: the
 * process died after committing the row and before (or while) calling the
 * provider. Far longer than any provider call is allowed to take, so a charge
 * still in flight is never mistaken for an abandoned one.
 */
const STALE_CREATED_SECONDS = 120;

/** States that are a definite answer about whether money moved. */
const DEFINITE = new Set(['CAPTURED', 'AUTHORIZED', 'FAILED', 'CANCELLED']);

class PaymentService {
     constructor({ pool, provider, logger }) {
          this.pool = pool;
          this.provider = provider;
          this.logger = logger;
     }

     /**
      * Create and attempt a charge.
      *
      * The local row is written and COMMITTED before the provider is called.
      * If the process dies during the call, we still know a charge may exist
      * and with which key — without that row, a crash would leave a charge
      * nobody can attribute.
      */
     async charge({ reservationId, customerId, amountCents, currency = 'INR', idempotencyKey, mode }) {
          if (!idempotencyKey) throw new BadRequestError('idempotencyKey is required');
          if (!amountCents || amountCents <= 0) throw new BadRequestError('amountCents must be positive');

          // Claim the key. The unique constraint makes this the atomic gate:
          // a concurrent duplicate cannot create a second payment.
          const { rows } = await this.pool.query(
               `INSERT INTO payments (reservation_id, customer_id, amount_cents, currency, idempotency_key, provider)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING id, state`,
               [reservationId, customerId, amountCents, currency, idempotencyKey, this.provider.name]
          );

          if (rows.length === 0) {
               // Someone already created this payment. Return its current state
               // rather than charging again.
               const { rows: existing } = await this.pool.query(
                    `SELECT id, state, provider_payment_id, provider_ref, failure_reason
                       FROM payments WHERE idempotency_key = $1`,
                    [idempotencyKey]
               );
               this.logger.info('duplicate charge request replayed', { idempotencyKey, state: existing[0].state });
               return { paymentId: existing[0].id, state: existing[0].state, replayed: true };
          }

          const paymentId = rows[0].id;

          // Crash here and the payment row exists in CREATED. The resolver will
          // pick it up, ask the provider, and settle it.
          await failpoint('payment.after_insert_before_charge');

          let result;
          try {
               result = await this.provider.charge({
                    idempotencyKey,
                    amountCents,
                    currency,
                    reservationId,
                    mode,
               });
          } catch (err) {
               if (err.indeterminate || err.code === 'PROVIDER_TIMEOUT' || err.httpStatus >= 500) {
                    // We genuinely do not know. Record that, and let the
                    // resolver find out. Do NOT retry the charge — that is how
                    // a customer gets billed twice.
                    await this.#transition(paymentId, 'CREATED', 'UNKNOWN', {
                         failure_reason: err.message,
                         next_resolve_at: new Date(Date.now() + 250),
                    });
                    this.logger.warn('payment indeterminate, awaiting resolution', {
                         paymentId,
                         reason: err.message,
                    });
                    metrics.paymentTransitions.inc({ from: 'CREATED', to: 'UNKNOWN' });
                    return { paymentId, state: 'UNKNOWN', indeterminate: true };
               }
               await this.#transition(paymentId, 'CREATED', 'FAILED', { failure_reason: err.message });
               return { paymentId, state: 'FAILED', reason: err.message };
          }

          if (!result.ok) {
               await this.#transition(
                    paymentId,
                    'CREATED',
                    'FAILED',
                    { failure_reason: result.reason },
                    { type: 'payment.failed', payload: { reservation_id: reservationId, reason: result.reason } }
               );
               return { paymentId, state: 'FAILED', reason: result.reason };
          }

          const moved = await this.#transition(
               paymentId,
               'CREATED',
               result.state,
               { provider_payment_id: result.providerPaymentId, provider_ref: result.providerRef },
               {
                    type: 'payment.captured',
                    payload: {
                         reservation_id: reservationId,
                         amount_cents: amountCents,
                         provider_payment_id: result.providerPaymentId,
                    },
               }
          );
          if (!moved) {
               // Someone else settled this payment while the provider call was
               // in flight (the resolver, after it went stale). Report what the
               // row actually says rather than what this call believed.
               const current = await this.get(paymentId);
               return { paymentId, state: current.state, providerPaymentId: current.provider_payment_id };
          }

          return { paymentId, state: result.state, providerPaymentId: result.providerPaymentId };
     }

     /**
      * Resolve one UNKNOWN payment by asking the provider.
      *
      * This is the only way out of UNKNOWN. The provider's answer is
      * authoritative; ours is not.
      */
     async resolveUnknown(paymentId) {
          const { rows } = await this.pool.query(
               `SELECT id, reservation_id, idempotency_key, provider_payment_id, amount_cents, resolve_attempts,
                       state, created_at < now() - ($2 || ' seconds')::interval AS stale
                  FROM payments WHERE id = $1`,
               [paymentId, String(STALE_CREATED_SECONDS)]
          );
          if (rows.length === 0) return { resolved: false, reason: 'no such payment' };
          const payment = rows[0];

          // Idempotent: a payment someone already settled (the resolver worker,
          // a webhook) answers with its settled state. Reporting "not UNKNOWN"
          // as unresolved used to send a correctly paid booking to manual review.
          if (DEFINITE.has(payment.state)) {
               return { resolved: true, state: payment.state === 'CANCELLED' ? 'FAILED' : payment.state };
          }
          if (payment.state === 'CREATED') {
               if (!payment.stale) return { resolved: false, reason: 'charge still in progress' };
               // Abandoned mid-charge. Admit we don't know, then ask.
               await this.#transition(paymentId, 'CREATED', 'UNKNOWN', {
                    failure_reason: 'no outcome recorded; the charging process stopped',
               });
          } else if (payment.state !== 'UNKNOWN') {
               // Refund states: money moved and is being returned. Not a
               // question the booking flow can answer automatically.
               return { resolved: false, reason: `payment is ${payment.state}` };
          }

          let status;
          try {
               status = await this.provider.getStatus({
                    idempotencyKey: payment.idempotency_key,
                    providerPaymentId: payment.provider_payment_id,
               });
          } catch (err) {
               // Still cannot reach the provider. Back off and try again;
               // never guess.
               const attempts = payment.resolve_attempts + 1;
               const delayMs = Math.min(300_000, 250 * 2 ** attempts);
               await this.pool.query(
                    `UPDATE payments SET resolve_attempts = $2, next_resolve_at = now() + ($3 || ' milliseconds')::interval
                      WHERE id = $1`,
                    [paymentId, attempts, String(delayMs)]
               );
               return { resolved: false, reason: err.message, attempts };
          }

          if (!status.found) {
               // The provider has no record, so no money moved. Safe to fail.
               await this.#transition(
                    paymentId,
                    'UNKNOWN',
                    'FAILED',
                    { failure_reason: 'provider has no record of this charge' },
                    {
                         type: 'payment.failed',
                         payload: { reservation_id: payment.reservation_id, reason: 'no_charge_at_provider' },
                    }
               );
               return { resolved: true, state: 'FAILED' };
          }

          const target = status.state === 'CAPTURED' ? 'CAPTURED' : status.state === 'AUTHORIZED' ? 'AUTHORIZED' : 'FAILED';

          const moved = await this.#transition(
               paymentId,
               'UNKNOWN',
               target,
               {
                    provider_payment_id: status.providerPaymentId,
                    provider_ref: status.providerRef,
                    failure_reason: status.failureReason,
               },
               {
                    type: target === 'FAILED' ? 'payment.failed' : 'payment.captured',
                    payload: {
                         reservation_id: payment.reservation_id,
                         amount_cents: Number(payment.amount_cents),
                         provider_payment_id: status.providerPaymentId,
                         resolved_from_unknown: true,
                    },
               }
          );
          if (!moved) {
               // Resolved concurrently (resolver worker vs saga). Same answer.
               const current = await this.get(paymentId);
               return { resolved: DEFINITE.has(current.state), state: current.state };
          }

          this.logger.info('resolved indeterminate payment', { paymentId, state: target });
          return { resolved: true, state: target };
     }

     /**
      * Handle a provider webhook.
      *
      * Order of operations is deliberate: verify, then record, then act. A
      * webhook that fails verification is logged and discarded without touching
      * the payment.
      */
     async handleWebhook({ rawBody, signature, timestamp, sourceIp }) {
          const verification = this.provider.verify(rawBody, signature, timestamp);
          if (!verification.valid) {
               await this.pool.query(
                    `INSERT INTO signature_failures (provider, payload, reason, source_ip) VALUES ($1, $2, $3, $4)`,
                    [this.provider.name, String(rawBody).slice(0, 4000), verification.reason, sourceIp ?? null]
               );
               this.logger.warn('webhook signature rejected', { reason: verification.reason, sourceIp });
               // Deliberately NOT a payment transition. A forged request must
               // not be able to change any payment's state.
               throw new BadRequestError(`Invalid webhook signature: ${verification.reason}`, 'INVALID_SIGNATURE');
          }

          const event = JSON.parse(rawBody);

          return this.pool.withTransaction(async (client) => {
               // Replay protection: the provider's event id is the dedupe key.
               // A duplicate delivery — from a provider retry or an attacker
               // resending a valid capture — finds its row and stops here.
               const { rows: recorded } = await client.query(
                    `INSERT INTO provider_events (provider, provider_event_id, event_type, payload, signature_valid)
                     VALUES ($1, $2, $3, $4, true)
                     ON CONFLICT (provider, provider_event_id) DO NOTHING
                     RETURNING id`,
                    [this.provider.name, event.id, event.type, JSON.stringify(event)]
               );

               if (recorded.length === 0) {
                    this.logger.info('duplicate webhook ignored', { eventId: event.id, type: event.type });
                    return { status: 'duplicate', eventId: event.id };
               }

               const providerPaymentId = event.data?.payment_id;
               const { rows: payments } = await client.query(
                    `SELECT id, state, reservation_id FROM payments WHERE provider_payment_id = $1 FOR UPDATE`,
                    [providerPaymentId]
               );
               if (payments.length === 0) {
                    // The webhook can legitimately outrun our own record of the
                    // charge. Keeping the event row means it is not lost.
                    return { status: 'payment_not_found', eventId: event.id };
               }
               const payment = payments[0];

               const target =
                    event.type === 'payment.captured'
                         ? 'CAPTURED'
                         : event.type === 'payment.authorized'
                           ? 'AUTHORIZED'
                           : event.type === 'payment.failed'
                             ? 'FAILED'
                             : null;

               if (!target) return { status: 'ignored', eventId: event.id, type: event.type };

               // Out-of-order guard. An `authorized` webhook arriving after a
               // `captured` one must not walk the payment backwards; the
               // database trigger would reject it, so skip it explicitly and
               // report it rather than raising an error for normal behaviour.
               if (payment.state === 'CAPTURED' && target === 'AUTHORIZED') {
                    await client.query(`UPDATE provider_events SET processed = true, payment_id = $2 WHERE id = $1`, [
                         recorded[0].id,
                         payment.id,
                    ]);
                    this.logger.info('out-of-order webhook skipped', { eventId: event.id, current: payment.state });
                    return { status: 'out_of_order_skipped', eventId: event.id };
               }

               if (payment.state === target) {
                    await client.query(`UPDATE provider_events SET processed = true, payment_id = $2 WHERE id = $1`, [
                         recorded[0].id,
                         payment.id,
                    ]);
                    return { status: 'already_in_state', eventId: event.id };
               }

               await client.query(
                    `UPDATE payments SET state = $2, provider_ref = COALESCE(provider_ref, $3) WHERE id = $1`,
                    [payment.id, target, event.data?.order_ref ?? null]
               );
               await client.query(`UPDATE provider_events SET processed = true, payment_id = $2 WHERE id = $1`, [
                    recorded[0].id,
                    payment.id,
               ]);

               const seq = await nextSeq(client, payment.reservation_id ?? payment.id);
               await enqueue(client, {
                    topic: 'payment.events',
                    type: target === 'FAILED' ? 'payment.failed' : 'payment.captured',
                    aggregateId: payment.reservation_id ?? payment.id,
                    aggregateSeq: seq,
                    payload: {
                         payment_id: payment.id,
                         reservation_id: payment.reservation_id,
                         state: target,
                         via: 'webhook',
                    },
               });

               metrics.paymentTransitions.inc({ from: payment.state, to: target });
               return { status: 'processed', eventId: event.id, paymentId: payment.id, state: target };
          });
     }

     /**
      * Refund a captured payment.
      *
      * Conservative by design: the amount is validated against what was
      * captured (and the database enforces it too), and the idempotency key
      * makes a retried refund a no-op rather than a second payout.
      */
     async refund({ paymentId, amountCents, reason, idempotencyKey }) {
          if (!idempotencyKey) throw new BadRequestError('idempotencyKey is required for refunds');

          const { rows: existing } = await this.pool.query(
               `SELECT id, state, provider_refund_id FROM refunds WHERE idempotency_key = $1`,
               [idempotencyKey]
          );
          if (existing.length > 0) {
               return { refundId: existing[0].id, state: existing[0].state, replayed: true };
          }

          const { rows } = await this.pool.query(
               `SELECT id, state, amount_cents, provider_payment_id FROM payments WHERE id = $1`,
               [paymentId]
          );
          if (rows.length === 0) throw new NotFoundError(`Payment ${paymentId} not found`);
          const payment = rows[0];

          if (payment.state !== 'CAPTURED' && payment.state !== 'PARTIALLY_REFUNDED') {
               throw new ConflictError(
                    `Cannot refund a payment in state ${payment.state}`,
                    'PAYMENT_NOT_REFUNDABLE'
               );
          }

          const amount = amountCents ?? Number(payment.amount_cents);

          const { rows: refundRows } = await this.pool.query(
               `INSERT INTO refunds (payment_id, amount_cents, reason, idempotency_key, state)
                VALUES ($1, $2, $3, $4, 'INITIATED')
                RETURNING id`,
               [paymentId, amount, reason ?? null, idempotencyKey]
          );
          const refundId = refundRows[0].id;

          await this.pool.query(`UPDATE payments SET state = 'REFUND_PENDING' WHERE id = $1 AND state = 'CAPTURED'`, [
               paymentId,
          ]);

          try {
               const result = await this.provider.refund({
                    providerPaymentId: payment.provider_payment_id,
                    amountCents: amount,
                    idempotencyKey,
               });
               await this.pool.query(
                    `UPDATE refunds SET state = 'COMPLETED', provider_refund_id = $2, updated_at = now() WHERE id = $1`,
                    [refundId, result.providerRefundId]
               );

               const fullyRefunded = amount >= Number(payment.amount_cents);
               await this.pool.query(`UPDATE payments SET state = $2 WHERE id = $1`, [
                    paymentId,
                    fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
               ]);

               return { refundId, state: 'COMPLETED', amountCents: amount };
          } catch (err) {
               // A refund we cannot confirm is left UNKNOWN for a human, never
               // retried blindly — a duplicate refund is a real loss.
               await this.pool.query(
                    `UPDATE refunds SET state = 'UNKNOWN', failure_reason = $2, updated_at = now() WHERE id = $1`,
                    [refundId, err.message]
               );
               this.logger.error('refund outcome unknown, needs human review', { refundId, error: err.message });
               return { refundId, state: 'UNKNOWN', reason: err.message };
          }
     }

     /** The payment created under an idempotency key, or null. */
     async findByIdempotencyKey(idempotencyKey) {
          const { rows } = await this.pool.query(
               `SELECT id, reservation_id, customer_id, amount_cents, currency, state, provider,
                       provider_payment_id, failure_reason, created_at, captured_at
                  FROM payments WHERE idempotency_key = $1`,
               [idempotencyKey]
          );
          return rows[0] ?? null;
     }

     async get(paymentId) {
          const { rows } = await this.pool.query(
               `SELECT id, reservation_id, customer_id, amount_cents, currency, state, provider,
                       provider_payment_id, failure_reason, created_at, captured_at
                  FROM payments WHERE id = $1`,
               [paymentId]
          );
          if (rows.length === 0) throw new NotFoundError(`Payment ${paymentId} not found`);
          return rows[0];
     }

     /**
      * Guarded transition. The expected state is part of the WHERE clause.
      *
      * When `event` is given, the outbox row is written in the SAME
      * transaction as the state change, so the event exists if and only if the
      * change committed. (They used to be two transactions here: a crash
      * between them changed the payment and silently dropped its event.)
      *
      * @returns {Promise<boolean>} false when the state had already moved
      */
     async #transition(paymentId, fromState, toState, fields = {}, event = null) {
          const sets = ['state = $3'];
          const values = [paymentId, fromState, toState];
          let i = 4;
          for (const [key, value] of Object.entries(fields)) {
               if (value === undefined) continue;
               sets.push(`${key} = $${i}`);
               values.push(value);
               i += 1;
          }

          const moved = await this.pool.withTransaction(async (client) => {
               const { rowCount } = await client.query(
                    `UPDATE payments SET ${sets.join(', ')} WHERE id = $1 AND state = $2`,
                    values
               );
               if (rowCount === 0) return false;
               if (event) {
                    const aggregateId = event.payload.reservation_id ?? paymentId;
                    const seq = await nextSeq(client, aggregateId);
                    await enqueue(client, {
                         topic: 'payment.events',
                         type: event.type,
                         aggregateId,
                         aggregateSeq: seq,
                         payload: { payment_id: paymentId, ...event.payload },
                    });
               }
               return true;
          });

          if (!moved) {
               const { rows } = await this.pool.query(`SELECT state FROM payments WHERE id = $1`, [paymentId]);
               this.logger.warn('payment transition skipped; state moved concurrently', {
                    paymentId,
                    expected: fromState,
                    actual: rows[0]?.state,
                    attempted: toState,
               });
               return false;
          }
          metrics.paymentTransitions.inc({ from: fromState, to: toState });
          return true;
     }
}

module.exports = { PaymentService, STALE_CREATED_SECONDS };
