'use strict';

/**
 * Reservation service — the public booking API.
 *
 * The shape of the flow matters as much as the code:
 *
 *   POST /v1/reservations   creates the reservation and its saga, then RETURNS.
 *                           It does not wait for payment or confirmation.
 *   GET  /v1/reservations/:id  reports progress.
 *
 * Returning immediately is deliberate. Holding an HTTP request open across a
 * payment authorisation ties a connection, a thread of attention and a user's
 * patience to the slowest external system in the flow. Instead the reservation
 * becomes durable state in one fast transaction, and the saga worker drives it
 * forward — so a client that disconnects, a pod that restarts, or a provider
 * that takes forty seconds all end at the same place.
 */

require('@tessera/shared/src/config/env');
require('@tessera/shared/src/observability/tracing');

const { createPool } = require('@tessera/shared/src/db/pool');
const { startOutboxRelay } = require('@tessera/shared/src/outbox/relay');
const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { withIdempotency } = require('@tessera/shared/src/idempotency');
const { isHealthy } = require('@tessera/shared/src/http/client');
const { enqueue, nextSeq } = require('@tessera/shared/src/outbox/writer');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const {
     BadRequestError,
     NotFoundError,
     ConflictError,
     UnauthorizedError,
} = require('@tessera/shared/src/errors');

const { SagaOrchestrator } = require('./saga/orchestrator');
const { HttpInventoryClient, HttpPaymentClient, HttpPricingClient } = require('./clients');
const { SagaWorker } = require('./workers/saga.worker');

const config = require('./config');
const logger = createLogger('reservation');

const pool = createPool({
     connectionString: config.DATABASE_URL,
     name: 'reservation',
     max: config.DB_POOL_MAX,
});

const inventory = new HttpInventoryClient({
     baseUrl: config.INVENTORY_URL,
     internalToken: config.INTERNAL_TOKEN,
     timeoutMs: config.INVENTORY_TIMEOUT_MS,
     logger,
});

const paymentsClient = new HttpPaymentClient({
     baseUrl: config.PAYMENT_URL,
     internalToken: config.INTERNAL_TOKEN,
     // Longer than the inventory timeout: a payment provider is allowed to be
     // slow, and a timeout here means UNKNOWN rather than failure.
     timeoutMs: config.PAYMENT_TIMEOUT_MS,
     logger,
});

const pricing = new HttpPricingClient({ baseUrl: config.PRICING_URL, timeoutMs: config.PRICING_TIMEOUT_MS });

const app = createApp({
     name: 'reservation',
     logger,
     dependencies: [
          {
               name: 'postgres',
               critical: true,
               check: async () => {
                    await pool.query('SELECT 1');
                    return true;
               },
          },
          {
               name: 'inventory-engine',
               critical: true,
               check: () => isHealthy(config.INVENTORY_URL),
          },
     ],
});

/**
 * Identify the caller.
 *
 * The gateway validates the JWT and forwards the verified subject. A service
 * behind the gateway trusting a header only works because the internal network
 * is not reachable from outside; the internal token check is what enforces that
 * assumption rather than assuming it.
 */
function requireCustomer(req, _res, next) {
     const customerId = req.get('x-customer-id');
     if (!customerId) return next(new UnauthorizedError('Missing customer identity'));
     req.customerId = customerId;
     next();
}

const ctxOf = (req) => ({
     requestId: req.context.requestId,
     correlationId: req.context.correlationId,
     traceId: req.context.traceId,
});

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a reservation.
 *
 * One transaction writes the reservation, its items and its saga. Everything
 * after that is the saga worker's job.
 */
app.post(
     '/v1/reservations',
     requireCustomer,
     asyncHandler(async (req, res) => {
          const { eventRef, eventId, items, ttlSeconds, paymentMode } = req.body || {};
          const key = req.get('idempotency-key');

          if (!key) throw new BadRequestError('An Idempotency-Key header is required');
          if (!eventId && !eventRef) throw new BadRequestError('eventId or eventRef is required');
          if (!Array.isArray(items) || items.length === 0) {
               throw new BadRequestError('items must be a non-empty array');
          }
          if (items.length > config.MAX_ITEMS_PER_RESERVATION) {
               throw new BadRequestError(
                    `At most ${config.MAX_ITEMS_PER_RESERVATION} items per reservation`,
                    'TOO_MANY_ITEMS'
               );
          }

          // Fairness: cap how much inventory one customer may hold at once, so
          // a script cannot park the whole event in holds while real users wait.
          const { rows: active } = await pool.query(
               `SELECT COALESCE(sum(item_count), 0)::int AS held
                  FROM reservations
                 WHERE customer_id = $1 AND state IN ('PENDING','HELD','AWAITING_PAYMENT')`,
               [req.customerId]
          );
          if (active[0].held + items.length > config.MAX_CONCURRENT_HOLDS) {
               throw new ConflictError(
                    `You already hold ${active[0].held} item(s). Complete or cancel them first.`,
                    'TOO_MANY_ACTIVE_HOLDS'
               );
          }

          // Server-side price, quoted BEFORE the transaction opens. Any
          // `priceCents` the client sent is ignored.
          const seatItems = items.filter((i) => i.resourceId || i.resourceCode);
          const quote =
               seatItems.length === 0
                    ? { byKey: new Map(), totalCents: 0, items: [] }
                    : await pricing.quote(
                           eventId,
                           seatItems.map((i) => ({
                                resourceId: i.resourceId,
                                resourceCode: i.resourceCode,
                                spanFrom: i.spanFrom ?? 0,
                                spanTo: i.spanTo ?? 1,
                           }))
                      );
          const fareFor = (i) =>
               quote.byKey.get(`${i.resourceId ?? i.resourceCode}:${i.spanFrom ?? 0}:${i.spanTo ?? 1}`);

          const result = await withIdempotency(
               pool,
               { scope: 'reservation.create', key, ownerId: req.customerId, request: req.body },
               async (client) => {
                    // Seat fares come from the quote. Pool items (meals) are
                    // priced by the inventory engine at hold time, so the hold's
                    // total — not this estimate — is what gets charged.
                    const totalCents = quote.totalCents;

                    const { rows } = await client.query(
                         `INSERT INTO reservations
                                 (customer_id, event_ref, event_id, state, item_count, total_cents,
                                  idempotency_key, correlation_id, trace_id)
                          VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8)
                          RETURNING id, created_at`,
                         [
                              req.customerId,
                              eventRef ?? eventId,
                              eventId ?? null,
                              items.length,
                              totalCents,
                              key,
                              req.context.correlationId,
                              req.context.traceId,
                         ]
                    );
                    const reservation = rows[0];

                    for (const item of items) {
                         await client.query(
                              `INSERT INTO reservation_items
                                      (reservation_id, resource_code, resource_id, span_from, span_to,
                                       pool_code, quantity, price_cents, passenger_name, passenger_age)
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                              [
                                   reservation.id,
                                   // The quote knows the human-facing seat code
                                   // even when the client sent only an id.
                                   item.resourceCode ?? fareFor(item)?.resourceCode ?? null,
                                   item.resourceId ?? null,
                                   item.spanFrom ?? null,
                                   item.spanTo ?? null,
                                   item.poolCode ?? null,
                                   item.quantity ?? 1,
                                   fareFor(item)?.fareCents ?? 0,
                                   item.passengerName ?? null,
                                   item.passengerAge ?? null,
                              ]
                         );
                    }

                    // The saga carries everything it needs to drive the flow,
                    // so a worker that picks it up after a restart has no
                    // dependency on in-memory state.
                    await SagaOrchestrator.create(client, {
                         reservationId: reservation.id,
                         correlationId: req.context.correlationId,
                         traceId: req.context.traceId,
                         context: {
                              eventId,
                              customerId: req.customerId,
                              resources: items
                                   .filter((i) => i.resourceId || i.resourceCode)
                                   .map((i) => ({
                                        resourceId: i.resourceId,
                                        resourceCode: i.resourceCode,
                                        spanFrom: i.spanFrom ?? 0,
                                        spanTo: i.spanTo ?? 1,
                                        // The quoted fare travels with the item
                                        // and is recorded on the allocation.
                                        priceCents: fareFor(i)?.fareCents,
                                   })),
                              pools: items
                                   .filter((i) => i.poolCode)
                                   .map((i) => ({ poolCode: i.poolCode, quantity: i.quantity ?? 1 })),
                              ttlSeconds: ttlSeconds ?? config.DEFAULT_TTL_SECONDS,
                              totalCents,
                              paymentMode,
                         },
                    });

                    return {
                         status: 202,
                         body: {
                              reservationId: reservation.id,
                              state: 'PENDING',
                              createdAt: reservation.created_at,
                              // Tell the client how to follow progress rather
                              // than making it guess a polling interval.
                              pollUrl: `/v1/reservations/${reservation.id}`,
                              pollAfterMs: 500,
                              quote: {
                                   quoteId: quote.quoteId,
                                   totalCents: quote.totalCents,
                                   items: quote.items.map((q) => ({
                                        resourceCode: q.resourceCode,
                                        fareCents: q.fareCents,
                                        tier: q.tier.label,
                                   })),
                              },
                         },
                    };
               }
          );

          metrics.reservationAttempts.inc({ event_id: eventId ?? 'unknown', strategy: 'api' });

          res.status(result.replayed ? 200 : 202).json({ data: result.body, replayed: result.replayed });
     })
);

/** Progress. The client polls this after creating a reservation. */
app.get(
     '/v1/reservations/:id',
     requireCustomer,
     asyncHandler(async (req, res) => {
          const { rows } = await pool.query(
               `SELECT r.id, r.customer_id, r.state, r.total_cents, r.item_count, r.hold_expires_at,
                       r.failure_reason, r.created_at, r.updated_at,
                       b.reference AS booking_reference, b.issued_at,
                       s.state AS saga_state,
                       COALESCE(json_agg(json_build_object(
                            'resourceCode', i.resource_code, 'spanFrom', i.span_from, 'spanTo', i.span_to,
                            'poolCode', i.pool_code, 'quantity', i.quantity, 'priceCents', i.price_cents,
                            'passengerName', i.passenger_name
                       )) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
                  FROM reservations r
                  LEFT JOIN bookings b ON b.reservation_id = r.id
                  LEFT JOIN sagas s ON s.reservation_id = r.id
                  LEFT JOIN reservation_items i ON i.reservation_id = r.id
                 WHERE r.id = $1
                 GROUP BY r.id, b.reference, b.issued_at, s.state`,
               [req.params.id]
          );

          if (rows.length === 0) throw new NotFoundError('Reservation not found');
          const r = rows[0];

          // Do not leak another customer's reservation. 404 rather than 403,
          // so the endpoint does not confirm that an id exists.
          if (r.customer_id !== req.customerId) throw new NotFoundError('Reservation not found');

          res.json({
               data: {
                    reservationId: r.id,
                    state: r.state,
                    // The saga state is the honest answer to "what is happening
                    // right now", which a single status field cannot express.
                    progress: describeProgress(r.saga_state, r.state),
                    totalCents: Number(r.total_cents),
                    itemCount: r.item_count,
                    holdExpiresAt: r.hold_expires_at,
                    bookingReference: r.booking_reference,
                    issuedAt: r.issued_at,
                    failureReason: r.failure_reason,
                    items: r.items,
                    createdAt: r.created_at,
                    settled: ['CONFIRMED', 'CANCELLED', 'FAILED', 'EXPIRED'].includes(r.state),
               },
          });
     })
);

app.get(
     '/v1/reservations',
     requireCustomer,
     asyncHandler(async (req, res) => {
          const { rows } = await pool.query(
               `SELECT r.id, r.state, r.total_cents, r.item_count, r.created_at, b.reference
                  FROM reservations r
                  LEFT JOIN bookings b ON b.reservation_id = r.id
                 WHERE r.customer_id = $1
                 ORDER BY r.created_at DESC
                 LIMIT 50`,
               [req.customerId]
          );
          res.json({ data: rows });
     })
);

/**
 * Cancel. Idempotent. Allowed once confirmed, or while seats are held and no
 * charge has started; otherwise a retryable 409.
 */
app.post(
     '/v1/reservations/:id/cancel',
     requireCustomer,
     asyncHandler(async (req, res) => {
          const { rows } = await pool.query(
               `SELECT id, customer_id, state, hold_id, payment_id FROM reservations WHERE id = $1`,
               [req.params.id]
          );
          if (rows.length === 0) throw new NotFoundError('Reservation not found');
          const reservation = rows[0];
          if (reservation.customer_id !== req.customerId) throw new NotFoundError('Reservation not found');

          if (['CANCELLED', 'FAILED', 'EXPIRED'].includes(reservation.state)) {
               return res.json({ data: { reservationId: reservation.id, state: reservation.state, alreadySettled: true } });
          }

          if (reservation.state === 'CONFIRMED') {
               // A confirmed booking: release the inventory, record the
               // cancellation and its event in ONE transaction, then refund.
               await inventory.cancelBooking({
                    bookingId: reservation.id,
                    reason: 'cancelled by customer',
                    idempotencyKey: `cancel:${reservation.id}`,
               });
               const refundDue = !!reservation.payment_id;
               await pool.withTransaction(async (client) => {
                    const { rowCount } = await client.query(
                         `UPDATE reservations SET state = 'CANCELLED', failure_reason = 'cancelled by customer'
                           WHERE id = $1 AND state = 'CONFIRMED'`,
                         [reservation.id]
                    );
                    // A concurrent cancel already did this; don't announce it twice.
                    if (rowCount === 0) return;
                    await client.query(
                         `UPDATE bookings SET state = 'CANCELLED', cancelled_at = now()
                           WHERE reservation_id = $1 AND state = 'CONFIRMED'`,
                         [reservation.id]
                    );
                    const seq = await nextSeq(client, reservation.id);
                    await enqueue(client, {
                         topic: 'booking.events',
                         type: 'booking.cancelled',
                         aggregateId: reservation.id,
                         aggregateSeq: seq,
                         correlationId: req.context.correlationId,
                         payload: {
                              reservation_id: reservation.id,
                              customer_id: reservation.customer_id,
                              reason: 'cancelled by customer',
                              refund_initiated: refundDue,
                         },
                    });
               });
               if (refundDue) {
                    // After the commit, never inside it: a provider call must not
                    // hold database locks. The refund key makes a retry safe.
                    await paymentsClient
                         .refund({
                              paymentId: reservation.payment_id,
                              reason: 'cancelled by customer',
                              idempotencyKey: `refund:${reservation.id}`,
                         })
                         .catch((err) =>
                              // The inventory is already released; a refund we
                              // cannot complete becomes a reconciliation issue
                              // rather than a failed request for the customer.
                              logger.error('refund failed after cancellation; reconciliation will pick it up', {
                                   reservationId: reservation.id,
                                   error: err.message,
                              })
                         );
               }
               return res.json({
                    data: { reservationId: reservation.id, state: 'CANCELLED', refundInitiated: refundDue },
               });
          }

          // Still in flight. Cancelling is only safe while the saga rests in
          // HOLD_CREATED: seats held, no charge started. The compensation path
          // then releases the hold exactly as it would on any other failure.
          //
          // This is a compare-and-swap on that one state. In any other
          // in-flight state a step is running or money may be moving, and the
          // saga's state machine (enforced by a trigger) has no cancel arrow
          // from there. The answer is a retryable 409, never a 500.
          const { rowCount } = await pool.query(
               `UPDATE sagas SET state = 'RELEASE_PENDING', next_run_at = now(),
                                 lease_owner = NULL, lease_until = NULL
                 WHERE reservation_id = $1 AND state = 'HOLD_CREATED'`,
               [reservation.id]
          );
          if (rowCount === 0) {
               const err = new ConflictError(
                    'This booking is being processed and cannot be cancelled at this moment. Try again shortly.',
                    'BOOKING_IN_PROGRESS'
               );
               err.retryAfterSeconds = 2;
               throw err;
          }

          res.status(202).json({
               data: { reservationId: reservation.id, state: 'CANCELLING', pollUrl: `/v1/reservations/${reservation.id}` },
          });
     })
);

/** Human-readable progress, so a UI does not have to encode saga states. */
function describeProgress(sagaState, reservationState) {
     const map = {
          CREATED: 'Starting',
          HOLD_PENDING: 'Securing your seats',
          HOLD_CREATED: 'Seats held',
          PAYMENT_PENDING: 'Processing payment',
          PAYMENT_UNKNOWN: 'Confirming payment with your bank',
          PAYMENT_AUTHORIZED: 'Payment received',
          CONFIRM_PENDING: 'Issuing your booking',
          CONFIRMED: 'Booked',
          HOLD_FAILED: 'Those seats were taken',
          PAYMENT_FAILED: 'Payment was declined',
          RELEASE_PENDING: 'Releasing your seats',
          RELEASED: 'Seats released',
          REFUND_PENDING: 'Refunding your payment',
          COMPENSATED: reservationState === 'CANCELLED' ? 'Cancelled' : 'Not completed',
          MANUAL_REVIEW: 'Under review by our team',
     };
     return map[sagaState] ?? 'In progress';
}

app.use(errorMiddleware(logger));

// ════════════════════════════════════════════════════════════════════════════

const orchestrator = new SagaOrchestrator({ pool, inventory, payments: paymentsClient, logger });
const sagaWorker = new SagaWorker({ orchestrator, logger, options: { intervalMs: config.SAGA_INTERVAL_MS } });

let relayHandle = null;

async function main() {
     await pool.query('SELECT 1');
     sagaWorker.start();
     // Kafka being unavailable must not stop the service: outbox rows wait as
     // PENDING and the relay catches up. That is the point of the pattern.
     relayHandle = await startOutboxRelay({
          pool,
          logger,
          service: 'reservation',
          brokers: config.KAFKA_BROKERS,
     });

     listen({
          app,
          port: config.PORT,
          name: 'reservation',
          logger,
          workers: [
               { name: 'saga', stop: () => sagaWorker.stop() },
               { name: 'outbox-relay', stop: () => relayHandle?.stop() ?? Promise.resolve() },
          ],
          resources: [
               { name: 'postgres', close: () => pool.end() },
          ],
     });
}

main().catch((err) => {
     logger.error('failed to start', { error: err.message, stack: err.stack });
     process.exit(1);
});
