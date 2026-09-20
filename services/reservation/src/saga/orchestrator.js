'use strict';

/**
 * Durable saga orchestrator.
 *
 * The saga's position is a row in PostgreSQL, not a stack frame. A worker
 * claims a due saga under a lease, executes EXACTLY ONE step, commits the
 * resulting state, and lets go. Kill the process at any instant and another
 * worker resumes from the last committed state.
 *
 * Forward path:
 *
 *   CREATED → HOLD_PENDING → HOLD_CREATED → PAYMENT_PENDING
 *           → PAYMENT_AUTHORIZED → CONFIRM_PENDING → CONFIRMED
 *
 * Failure paths:
 *
 *   hold fails         → HOLD_FAILED → COMPENSATED           (nothing to undo)
 *   payment fails      → PAYMENT_FAILED → RELEASE_PENDING → RELEASED → COMPENSATED
 *   payment unknown    → PAYMENT_UNKNOWN → (ask the provider) → AUTHORIZED | FAILED
 *   confirm fails      → REFUND_PENDING → COMPENSATED        (money must come back)
 *   anything ambiguous → MANUAL_REVIEW                       (a human decides)
 *
 * Why one step per claim, rather than running the whole saga in a loop: each
 * step commits independently, so the crash window is one step wide instead of
 * one saga wide. It also means a slow payment provider parks a single saga
 * rather than occupying a worker for the entire booking flow.
 *
 * NO DISTRIBUTED TRANSACTION. Two-phase commit across inventory, payment and
 * reservation would need all three plus the network healthy for the duration of
 * a human entering card details, and would hold locks throughout. The saga
 * accepts temporary inconsistency and guarantees convergence instead.
 */

const { enqueue, nextSeq } = require('@tessera/shared/src/outbox/writer');
const { failpoint } = require('@tessera/shared/src/failpoints');
const { metrics } = require('@tessera/shared/src/observability/metrics');

/**
 * Per-step policy.
 *
 * `timeoutMs` is how long the step may take before it is considered stuck.
 * `indeterminateOnTimeout` marks the steps where a timeout does NOT mean
 * failure — for payment, the money may have moved, so the saga must ask rather
 * than assume.
 */
const STEP_POLICY = {
     HOLD_PENDING: { timeoutMs: 10_000, maxAttempts: 3, onTimeout: 'HOLD_FAILED' },
     PAYMENT_PENDING: {
          timeoutMs: 45_000,
          maxAttempts: 1, // never re-charge automatically
          onTimeout: 'PAYMENT_UNKNOWN',
          indeterminateOnTimeout: true,
     },
     PAYMENT_UNKNOWN: { timeoutMs: 300_000, maxAttempts: 10, onTimeout: 'MANUAL_REVIEW' },
     CONFIRM_PENDING: { timeoutMs: 15_000, maxAttempts: 5, onTimeout: 'REFUND_PENDING' },
     RELEASE_PENDING: { timeoutMs: 15_000, maxAttempts: 5, onTimeout: 'MANUAL_REVIEW' },
     REFUND_PENDING: { timeoutMs: 30_000, maxAttempts: 5, onTimeout: 'MANUAL_REVIEW' },
};

class SagaOrchestrator {
     /**
      * @param {object} deps
      * @param {import('pg').Pool} deps.pool
      * @param {object} deps.inventory  Client for the inventory engine.
      * @param {object} deps.payments   Client for the payment service.
      * @param {object} deps.logger
      */
     constructor({ pool, inventory, payments, logger, workerId }) {
          this.pool = pool;
          this.inventory = inventory;
          this.payments = payments;
          this.logger = logger;
          this.workerId = workerId || `saga-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
     }

     /** Start a saga for a reservation. Called in the reservation's transaction. */
     static async create(client, { reservationId, correlationId, traceId, context = {} }) {
          const { rows } = await client.query(
               `INSERT INTO sagas (reservation_id, state, next_run_at, correlation_id, trace_id, context)
                VALUES ($1, 'CREATED', now(), $2, $3, $4)
                RETURNING id`,
               [reservationId, correlationId ?? null, traceId ?? null, JSON.stringify(context)]
          );
          return rows[0].id;
     }

     /**
      * Claim and run one batch of due sagas.
      *
      * SKIP LOCKED plus a lease: workers take disjoint sets without
      * coordinating, and a worker that dies mid-step has its lease expire so
      * the saga becomes claimable again.
      */
     async tick({ batchSize = 20 } = {}) {
          const claimed = await this.#claim(batchSize);
          if (claimed.length === 0) return 0;

          for (const saga of claimed) {
               try {
                    await this.#step(saga);
               } catch (err) {
                    await this.#recordFailure(saga, err);
               }
          }
          return claimed.length;
     }

     async #claim(batchSize) {
          const { rows } = await this.pool.query(
               `WITH due AS (
                     SELECT id FROM sagas
                      WHERE state NOT IN ('CONFIRMED','COMPENSATED','RELEASED','MANUAL_REVIEW')
                        AND next_run_at <= now()
                        AND (lease_until IS NULL OR lease_until < now())
                      ORDER BY next_run_at
                        FOR UPDATE SKIP LOCKED
                      LIMIT $1
                )
                UPDATE sagas s
                   SET lease_owner = $2,
                       lease_until = now() + interval '60 seconds',
                       attempts = s.attempts + 1
                  FROM due
                 WHERE s.id = due.id
             RETURNING s.id, s.reservation_id, s.state, s.attempts, s.max_attempts,
                       s.correlation_id, s.trace_id, s.context, s.step_deadline_at`,
               [batchSize, this.workerId]
          );
          return rows;
     }

     /** Execute exactly one transition. */
     async #step(saga) {
          const started = Date.now();

          // A step whose deadline has passed takes its timeout path instead of
          // being retried forever.
          if (saga.step_deadline_at && new Date(saga.step_deadline_at) < new Date()) {
               return this.#onTimeout(saga);
          }

          switch (saga.state) {
               case 'CREATED':
                    return this.#beginHold(saga, started);
               case 'HOLD_PENDING':
                    return this.#awaitHold(saga, started);
               case 'HOLD_CREATED':
                    return this.#beginPayment(saga, started);
               case 'PAYMENT_PENDING':
                    return this.#awaitPayment(saga, started);
               case 'PAYMENT_UNKNOWN':
                    return this.#resolvePayment(saga, started);
               case 'PAYMENT_AUTHORIZED':
                    return this.#beginConfirm(saga, started);
               case 'CONFIRM_PENDING':
                    return this.#awaitConfirm(saga, started);
               case 'PAYMENT_FAILED':
               case 'TIMED_OUT':
                    return this.#transition(saga, 'RELEASE_PENDING', 'OK', 'compensating');
               case 'RELEASE_PENDING':
                    return this.#releaseHold(saga, started);
               case 'RELEASED':
                    return this.#transition(saga, 'COMPENSATED', 'OK', 'compensation complete');
               case 'HOLD_FAILED':
                    return this.#transition(saga, 'COMPENSATED', 'OK', 'nothing to compensate');
               case 'REFUND_PENDING':
                    return this.#refund(saga, started);
               default:
                    this.logger.warn('saga in unhandled state', { sagaId: saga.id, state: saga.state });
                    return this.#transition(saga, 'MANUAL_REVIEW', 'FAILED', `unhandled state ${saga.state}`);
          }
     }

     // ── Forward steps ────────────────────────────────────────────────────

     async #beginHold(saga, started) {
          await this.#transition(saga, 'HOLD_PENDING', 'OK', 'requesting hold', {
               deadlineMs: STEP_POLICY.HOLD_PENDING.timeoutMs,
               runInMs: 0,
          });

          const ctx = saga.context;
          try {
               // Derived from the saga id, so a retry after a lost response is
               // recognised by the inventory engine as the same request.
               const idempotencyKey = `saga:${saga.id}:hold`;
               const hold = await this.inventory.reserve({
                    idempotencyKey,
                    eventId: ctx.eventId,
                    customerId: ctx.customerId,
                    resources: ctx.resources,
                    pools: ctx.pools,
                    ttlSeconds: ctx.ttlSeconds ?? 600,
                    reservationId: saga.reservation_id,
                    correlationId: saga.correlation_id,
               });

               await failpoint('saga.after_hold_before_commit');

               await this.pool.withTransaction(async (client) => {
                    await client.query(
                         `UPDATE reservations
                             SET state = 'HELD', hold_id = $2, hold_expires_at = $3, total_cents = $4
                           WHERE id = $1`,
                         [saga.reservation_id, hold.holdId, hold.expiresAt, hold.totalCents]
                    );
                    await this.#transitionIn(client, saga, 'HOLD_CREATED', 'OK', 'hold created', {
                         context: { ...ctx, holdId: hold.holdId, totalCents: hold.totalCents },
                         runInMs: 0,
                    });
               });

               this.#observe(saga, 'HOLD_CREATED', started);
          } catch (err) {
               if (err.status === 409) {
                    // Inventory is gone. A legitimate business outcome, not a
                    // fault: fail fast rather than retrying into a wall.
                    await this.#fail(saga, 'HOLD_FAILED', err.message);
                    return;
               }
               throw err;
          }
     }

     async #awaitHold(saga) {
          // Reached only after a crash between the transition and the response.
          // The idempotency key means re-issuing the same request is safe.
          return this.#beginHold(saga, Date.now());
     }

     async #beginPayment(saga, started) {
          const ctx = saga.context;

          await this.#transition(saga, 'PAYMENT_PENDING', 'OK', 'charging', {
               deadlineMs: STEP_POLICY.PAYMENT_PENDING.timeoutMs,
               runInMs: 0,
          });

          const idempotencyKey = `saga:${saga.id}:payment`;
          let result;
          try {
               result = await this.payments.charge({
                    idempotencyKey,
                    reservationId: saga.reservation_id,
                    customerId: ctx.customerId,
                    amountCents: ctx.totalCents,
                    mode: ctx.paymentMode,
               });
          } catch (err) {
               // The charge outcome is unknown. Never retry it here.
               // Ask the provider promptly. A customer whose money may have
               // moved should not wait seconds for the first enquiry; backoff
               // applies to subsequent attempts, not the first.
               await this.#transition(saga, 'PAYMENT_UNKNOWN', 'RETRY', `provider error: ${err.message}`, {
                    deadlineMs: STEP_POLICY.PAYMENT_UNKNOWN.timeoutMs,
                    runInMs: 250,
               });
               return;
          }

          if (result.state === 'UNKNOWN') {
               await this.#transition(saga, 'PAYMENT_UNKNOWN', 'RETRY', 'provider did not confirm', {
                    deadlineMs: STEP_POLICY.PAYMENT_UNKNOWN.timeoutMs,
                    runInMs: 250,
                    context: { ...ctx, paymentId: result.paymentId },
               });
               return;
          }

          if (result.state === 'FAILED') {
               await this.pool.query(
                    `UPDATE reservations SET state = 'FAILED', failure_reason = $2 WHERE id = $1`,
                    [saga.reservation_id, result.reason ?? 'payment_failed']
               );
               await this.#fail(saga, 'PAYMENT_FAILED', result.reason ?? 'payment failed');
               return;
          }

          await this.pool.withTransaction(async (client) => {
               await client.query(
                    `UPDATE reservations SET state = 'AWAITING_PAYMENT', payment_id = $2 WHERE id = $1`,
                    [saga.reservation_id, result.paymentId]
               );
               await this.#transitionIn(client, saga, 'PAYMENT_AUTHORIZED', 'OK', 'payment captured', {
                    context: { ...ctx, paymentId: result.paymentId },
                    runInMs: 0,
               });
          });

          this.#observe(saga, 'PAYMENT_AUTHORIZED', started);
     }

     async #awaitPayment(saga) {
          // Crash between transition and provider response. The payment
          // service's own idempotency makes re-issuing safe; it returns the
          // existing payment rather than charging again.
          return this.#beginPayment(saga, Date.now());
     }

     /**
      * Ask the provider what happened. The ONLY exit from UNKNOWN.
      */
     async #resolvePayment(saga) {
          const ctx = saga.context;
          if (!ctx.paymentId) {
               // No payment id means the charge request never landed, so no
               // money moved. Safe to treat as failure.
               await this.#fail(saga, 'PAYMENT_FAILED', 'charge never reached the provider');
               return;
          }

          const result = await this.payments.resolveUnknown(ctx.paymentId);

          if (!result.resolved) {
               if (saga.attempts >= STEP_POLICY.PAYMENT_UNKNOWN.maxAttempts) {
                    await this.#transition(
                         saga,
                         'MANUAL_REVIEW',
                         'FAILED',
                         'provider never resolved; money may be held'
                    );
                    return;
               }
               const delayMs = Math.min(300_000, 250 * 2 ** saga.attempts);
               await this.#reschedule(saga, delayMs, `awaiting provider: ${result.reason ?? 'unavailable'}`);
               return;
          }

          if (result.state === 'FAILED') {
               await this.#fail(saga, 'PAYMENT_FAILED', 'provider confirmed the charge did not succeed');
               return;
          }

          await this.#transition(saga, 'PAYMENT_AUTHORIZED', 'OK', 'resolved: provider confirms payment', {
               runInMs: 0,
          });
     }

     async #beginConfirm(saga, started) {
          const ctx = saga.context;

          await this.#transition(saga, 'CONFIRM_PENDING', 'OK', 'confirming inventory', {
               deadlineMs: STEP_POLICY.CONFIRM_PENDING.timeoutMs,
               runInMs: 0,
          });

          const bookingId = ctx.bookingId ?? saga.reservation_id;

          try {
               await this.inventory.confirm({
                    holdId: ctx.holdId,
                    bookingId,
                    idempotencyKey: `saga:${saga.id}:confirm`,
               });
          } catch (err) {
               if (err.code === 'HOLD_EXPIRED' || err.status === 409) {
                    // The customer has PAID and the seat is gone. Money must go
                    // back; this is never silently dropped.
                    this.logger.error('hold expired after payment; refunding', {
                         sagaId: saga.id,
                         reservationId: saga.reservation_id,
                    });
                    await this.#transition(saga, 'REFUND_PENDING', 'FAILED', 'hold expired after payment', {
                         deadlineMs: STEP_POLICY.REFUND_PENDING.timeoutMs,
                         runInMs: 0,
                    });
                    metrics.sagaCompensations.inc({ reason: 'hold_expired_after_payment' });
                    return;
               }
               throw err;
          }

          await failpoint('saga.after_confirm_before_commit');

          await this.pool.withTransaction(async (client) => {
               const reference = `TSR-${saga.reservation_id.slice(0, 8).toUpperCase()}`;
               await client.query(
                    `INSERT INTO bookings (reservation_id, customer_id, reference, total_cents, payment_id)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (reservation_id) DO NOTHING`,
                    [saga.reservation_id, ctx.customerId, reference, ctx.totalCents, ctx.paymentId ?? null]
               );
               await client.query(
                    `UPDATE reservations SET state = 'CONFIRMED', booking_id = (
                          SELECT id FROM bookings WHERE reservation_id = $1
                     ) WHERE id = $1`,
                    [saga.reservation_id]
               );

               const seq = await nextSeq(client, saga.reservation_id);
               await enqueue(client, {
                    topic: 'booking.events',
                    type: 'booking.confirmed',
                    aggregateId: saga.reservation_id,
                    aggregateSeq: seq,
                    correlationId: saga.correlation_id,
                    payload: {
                         reservation_id: saga.reservation_id,
                         customer_id: ctx.customerId,
                         reference,
                         total_cents: ctx.totalCents,
                    },
               });

               await this.#transitionIn(client, saga, 'CONFIRMED', 'OK', 'booking issued');
          });

          this.#observe(saga, 'CONFIRMED', started);
     }

     async #awaitConfirm(saga) {
          return this.#beginConfirm(saga, Date.now());
     }

     // ── Compensation ─────────────────────────────────────────────────────

     async #releaseHold(saga) {
          const ctx = saga.context;
          if (ctx.holdId) {
               try {
                    await this.inventory.release({
                         holdId: ctx.holdId,
                         reason: 'saga compensation',
                         idempotencyKey: `saga:${saga.id}:release`,
                    });
               } catch (err) {
                    // Releasing is idempotent and the hold expires on its own,
                    // so a failure here is recoverable rather than terminal.
                    this.logger.warn('release failed; TTL will reclaim the hold', {
                         sagaId: saga.id,
                         error: err.message,
                    });
               }
          }

          await this.pool.withTransaction(async (client) => {
               await client.query(
                    `UPDATE reservations SET state = 'CANCELLED' WHERE id = $1 AND state NOT IN ('CONFIRMED','CANCELLED')`,
                    [saga.reservation_id]
               );
               // RELEASED and COMPENSATED are recorded as two transitions, for
               // the history, but applied in ONE step.
               //
               // The claim query treats RELEASED as terminal and will not pick
               // it up again, so leaving the saga there would strand it one
               // transition short of done — visible in tests as a saga stuck in
               // RELEASED forever. Either the claim filter or this step had to
               // change; finishing here is cheaper than a second claim cycle
               // and keeps 'compensation finished' a single atomic fact.
               await this.#transitionIn(client, saga, 'RELEASED', 'OK', 'hold released', { runInMs: 0 });
               await this.#transitionIn(
                    client,
                    { ...saga, state: 'RELEASED' },
                    'COMPENSATED',
                    'OK',
                    'compensation complete'
               );
          });
          metrics.sagaCompensations.inc({ reason: 'released' });
     }

     async #refund(saga) {
          const ctx = saga.context;
          if (!ctx.paymentId) {
               await this.#transition(saga, 'MANUAL_REVIEW', 'FAILED', 'refund needed but no payment recorded');
               return;
          }

          const result = await this.payments.refund({
               paymentId: ctx.paymentId,
               reason: 'booking could not be completed',
               idempotencyKey: `saga:${saga.id}:refund`,
          });

          if (result.state === 'UNKNOWN') {
               // A refund we cannot confirm is a human's problem. Retrying a
               // payout blindly risks paying twice.
               await this.#transition(saga, 'MANUAL_REVIEW', 'FAILED', 'refund outcome unknown');
               return;
          }

          await this.pool.withTransaction(async (client) => {
               await client.query(
                    `UPDATE reservations SET state = 'CANCELLED', failure_reason = 'refunded' WHERE id = $1`,
                    [saga.reservation_id]
               );
               await this.#transitionIn(client, saga, 'COMPENSATED', 'OK', 'refunded');
          });
          metrics.sagaCompensations.inc({ reason: 'refunded' });
     }

     // ── Timeout, failure, bookkeeping ────────────────────────────────────

     async #onTimeout(saga) {
          const policy = STEP_POLICY[saga.state];
          const target = policy?.onTimeout ?? 'MANUAL_REVIEW';

          this.logger.warn('saga step timed out', {
               sagaId: saga.id,
               state: saga.state,
               movingTo: target,
               // The distinction that matters: for a payment step a timeout
               // means "we do not know", never "it failed".
               indeterminate: !!policy?.indeterminateOnTimeout,
          });

          await this.#transition(saga, target, 'TIMEOUT', `step ${saga.state} exceeded its deadline`, {
               runInMs: 0,
               deadlineMs: STEP_POLICY[target]?.timeoutMs,
          });
     }

     async #fail(saga, state, reason) {
          await this.#transition(saga, state, 'FAILED', reason, { runInMs: 0 });
     }

     async #recordFailure(saga, err) {
          const policy = STEP_POLICY[saga.state];
          const maxAttempts = policy?.maxAttempts ?? saga.max_attempts;

          if (saga.attempts >= maxAttempts) {
               const target = policy?.onTimeout ?? 'MANUAL_REVIEW';
               this.logger.error('saga exhausted its attempts', {
                    sagaId: saga.id,
                    state: saga.state,
                    attempts: saga.attempts,
                    error: err.message,
               });
               await this.#transition(saga, target, 'FAILED', err.message, { runInMs: 0 });
               return;
          }

          // Full jitter, so a downstream outage does not produce a synchronised
          // retry storm when it recovers.
          const delayMs = Math.floor(Math.random() * Math.min(60_000, 500 * 2 ** saga.attempts));
          await this.#reschedule(saga, delayMs, err.message);
     }

     async #reschedule(saga, delayMs, reason) {
          await this.pool.query(
               `UPDATE sagas
                   SET next_run_at = now() + ($2 || ' milliseconds')::interval,
                       last_error = $3, lease_owner = NULL, lease_until = NULL
                 WHERE id = $1`,
               [saga.id, String(delayMs), String(reason).slice(0, 2000)]
          );
          await this.pool.query(
               `INSERT INTO saga_steps (saga_id, from_state, to_state, attempt, outcome, detail)
                VALUES ($1, $2, $2, $3, 'RETRY', $4)`,
               [saga.id, saga.state, saga.attempts, String(reason).slice(0, 2000)]
          );
     }

     async #transition(saga, toState, outcome, detail, opts = {}) {
          return this.pool.withTransaction((client) =>
               this.#transitionIn(client, saga, toState, outcome, detail, opts)
          );
     }

     async #transitionIn(client, saga, toState, outcome, detail, opts = {}) {
          const deadline = opts.deadlineMs ? `now() + interval '${Number(opts.deadlineMs)} milliseconds'` : 'NULL';
          const runIn = opts.runInMs ?? 0;

          const params = [saga.id, toState, String(runIn)];
          let contextClause = '';
          if (opts.context) {
               contextClause = ', context = $4';
               params.push(JSON.stringify(opts.context));
          }

          await client.query(
               `UPDATE sagas
                   SET state = $2,
                       next_run_at = now() + ($3 || ' milliseconds')::interval,
                       step_deadline_at = ${deadline},
                       lease_owner = NULL,
                       lease_until = NULL,
                       attempts = CASE WHEN state <> $2 THEN 0 ELSE attempts END
                       ${contextClause}
                 WHERE id = $1`,
               params
          );

          await client.query(
               `INSERT INTO saga_steps (saga_id, from_state, to_state, attempt, outcome, detail)
                VALUES ($1, $2, $3, $4, $5, $6)`,
               [saga.id, saga.state, toState, saga.attempts, outcome, detail ? String(detail).slice(0, 2000) : null]
          );

          metrics.sagaTransitions.inc({ from: saga.state, to: toState });
     }

     #observe(saga, toState, started) {
          this.logger.info('saga advanced', {
               sagaId: saga.id,
               reservationId: saga.reservation_id,
               from: saga.state,
               to: toState,
               durationMs: Date.now() - started,
          });
     }
}

module.exports = { SagaOrchestrator, STEP_POLICY };
