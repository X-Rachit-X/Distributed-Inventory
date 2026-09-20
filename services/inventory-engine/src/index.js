'use strict';

/**
 * Inventory Engine — HTTP service.
 *
 * The authority for every allocation decision in the system. Other services ask
 * it for inventory; nothing else may write allocations.
 *
 * Two API surfaces:
 *   /internal/*  — called by the reservation service. Requires a service token.
 *   /v1/*        — read-only availability, safe to expose through the gateway.
 *
 * Availability reads are explicitly labelled with `as_of` and described as
 * discovery data. The reserve path re-validates everything against the database,
 * so a stale read can cost a user a retry but can never cause an oversell.
 */

require('./config/env');

const { createPool } = require('@tessera/shared/src/db/pool');
const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { withIdempotency } = require('@tessera/shared/src/idempotency');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const { BadRequestError, UnauthorizedError, NotFoundError } = require('@tessera/shared/src/errors');

const { reserve } = require('./engine/reserve');
const { confirm, release, cancelBooking } = require('./engine/confirm');
const { blockResource, unblockResource } = require('./engine/admin');
const { getAvailability, getResources } = require('./engine/availability');
const { ExpiryWorker } = require('./workers/expiry.worker');

const config = require('./config');
const logger = createLogger('inventory-engine');

const pool = createPool({
     connectionString: config.DATABASE_URL,
     name: 'inventory',
     max: config.DB_POOL_MAX,
     // Reserve is short. A long lock wait here means a flash sale is queueing;
     // failing fast with a 409 is better for the user than a 30-second spinner.
     lockTimeoutMs: config.LOCK_TIMEOUT_MS,
     statementTimeoutMs: config.STATEMENT_TIMEOUT_MS,
});

const app = createApp({
     name: 'inventory-engine',
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
     ],
});

/** Service-to-service auth. The internal API must never be reachable publicly. */
function requireInternal(req, _res, next) {
     const token = req.get('x-internal-token');
     if (!token || token !== config.INTERNAL_TOKEN) {
          return next(new UnauthorizedError('Invalid or missing internal service token'));
     }
     next();
}

const ctxOf = (req) => ({
     requestId: req.context.requestId,
     correlationId: req.context.correlationId,
     traceId: req.context.traceId,
     actor: req.get('x-actor') || 'reservation-service',
});

// ═══════════════════════════════════════════════════════════════════════════
// Internal API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reserve inventory.
 *
 * Idempotency wraps the whole thing: the business writes and the idempotency
 * record commit in ONE transaction, so a retry after a lost response replays
 * the original answer instead of taking a second seat.
 */
app.post(
     '/internal/reserve',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { eventId, customerId, resources, pools, ttlSeconds, reservationId } = req.body || {};
          const key = req.get('idempotency-key') || req.body?.idempotencyKey;

          if (!eventId || !customerId) throw new BadRequestError('eventId and customerId are required');
          if (!key) throw new BadRequestError('An Idempotency-Key is required for reserve');

          metrics.reservationAttempts.inc({ event_id: eventId, strategy: 'production' });
          const started = process.hrtime.bigint();

          const result = await withIdempotency(
               pool,
               { scope: 'inventory.reserve', key, ownerId: customerId, request: req.body },
               async (client) => {
                    const hold = await reserve(client, {
                         eventId,
                         customerId,
                         resources,
                         pools,
                         ttlSeconds,
                         reservationId,
                         context: ctxOf(req),
                    });
                    return { status: 201, body: hold };
               }
          );

          metrics.txDuration.observe(
               { operation: 'reserve', outcome: 'success' },
               Number(process.hrtime.bigint() - started) / 1e9
          );
          metrics.reservationSuccess.inc({ event_id: eventId, strategy: 'production' });

          res.status(result.replayed ? 200 : result.status).json({
               data: result.body,
               replayed: result.replayed,
          });
     })
);

app.post(
     '/internal/confirm',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { holdId, bookingId, customerId } = req.body || {};
          if (!holdId || !bookingId) throw new BadRequestError('holdId and bookingId are required');

          const result = await pool.withTransaction((client) =>
               confirm(client, { holdId, bookingId, customerId, context: ctxOf(req) })
          );
          res.json({ data: result });
     })
);

app.post(
     '/internal/release',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { holdId, customerId, reason } = req.body || {};
          if (!holdId) throw new BadRequestError('holdId is required');

          const result = await pool.withTransaction((client) =>
               release(client, { holdId, customerId, reason, context: ctxOf(req) })
          );
          res.json({ data: result });
     })
);

app.post(
     '/internal/cancel-booking',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { bookingId, reason } = req.body || {};
          if (!bookingId) throw new BadRequestError('bookingId is required');

          const result = await pool.withTransaction((client) =>
               cancelBooking(client, { bookingId, reason, context: ctxOf(req) })
          );
          res.json({ data: result });
     })
);

// ═══════════════════════════════════════════════════════════════════════════
// Public read API — discovery data, explicitly not authoritative
// ═══════════════════════════════════════════════════════════════════════════

app.get(
     '/v1/events/:eventId/availability',
     asyncHandler(async (req, res) => {
          const data = await getAvailability(pool, req.params.eventId, {
               spanFrom: req.query.spanFrom != null ? Number(req.query.spanFrom) : undefined,
               spanTo: req.query.spanTo != null ? Number(req.query.spanTo) : undefined,
          });
          // `as_of` is part of the contract, not decoration: it tells a client
          // how old this answer is so a UI can say "checked a moment ago"
          // rather than implying the number is live.
          res.set('cache-control', 'public, max-age=2');
          res.json({ data, as_of: new Date().toISOString(), authoritative: false });
     })
);

app.get(
     '/v1/events/:eventId/resources',
     asyncHandler(async (req, res) => {
          const data = await getResources(pool, req.params.eventId, {
               spanFrom: req.query.spanFrom != null ? Number(req.query.spanFrom) : undefined,
               spanTo: req.query.spanTo != null ? Number(req.query.spanTo) : undefined,
               class: req.query.class,
          });
          res.json({ data, as_of: new Date().toISOString(), authoritative: false });
     })
);

app.get(
     '/v1/holds/:holdId',
     asyncHandler(async (req, res) => {
          const { rows } = await pool.query(
               `SELECT h.id, h.event_id, h.customer_id, h.state, h.expires_at, h.total_cents,
                       coalesce(json_agg(json_build_object(
                            'allocationId', a.id, 'resourceId', a.resource_id,
                            'spanFrom', lower(a.span), 'spanTo', upper(a.span)
                       )) FILTER (WHERE a.id IS NOT NULL), '[]') AS allocations
                  FROM holds h
                  LEFT JOIN allocations a ON a.hold_id = h.id
                 WHERE h.id = $1
                 GROUP BY h.id`,
               [req.params.holdId]
          );
          if (rows.length === 0) throw new NotFoundError('Hold not found');
          res.json({ data: rows[0] });
     })
);

// ═══════════════════════════════════════════════════════════════════════════
// Admin
// ═══════════════════════════════════════════════════════════════════════════

app.post(
     '/admin/resources/:resourceId/block',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { reason, spanFrom, spanTo } = req.body || {};
          if (!reason) throw new BadRequestError('A reason is required to block a resource');

          const result = await pool.withTransaction((client) =>
               blockResource(client, {
                    resourceId: req.params.resourceId,
                    reason,
                    spanFrom,
                    spanTo,
                    context: { ...ctxOf(req), actor: req.get('x-actor') || 'admin' },
               })
          );
          res.json({ data: result });
     })
);

app.post(
     '/admin/resources/:resourceId/unblock',
     requireInternal,
     asyncHandler(async (req, res) => {
          const result = await pool.withTransaction((client) =>
               unblockResource(client, {
                    resourceId: req.params.resourceId,
                    reason: req.body?.reason,
                    context: { ...ctxOf(req), actor: req.get('x-actor') || 'admin' },
               })
          );
          res.json({ data: result });
     })
);

app.get(
     '/admin/invariants',
     asyncHandler(async (_req, res) => {
          const { rows } = await pool.query(`SELECT * FROM invariant_summary`);

          // Surface the invariants as metrics too, so the scoreboard and an
          // alerting rule read the same numbers the tests assert on.
          for (const row of rows) {
               metrics.invariantViolations.set({ invariant: row.invariant }, Number(row.violations));
          }

          // Two different questions, deliberately separated.
          //
          // CRITICAL and HIGH mean inventory is WRONG — someone may have been
          // sold something twice. That is a failed health check.
          //
          // MEDIUM means a subsystem is LAGGING, typically an outbox backlog
          // because Kafka is down. Inventory is still correct; events are late.
          // Returning 500 for that would make a broker outage look like data
          // corruption, and would train people to ignore this endpoint.
          const corruption = rows.filter(
               (r) => Number(r.violations) > 0 && ['CRITICAL', 'HIGH'].includes(r.severity)
          );
          const lagging = rows.filter(
               (r) => Number(r.violations) > 0 && !['CRITICAL', 'HIGH'].includes(r.severity)
          );

          res.status(corruption.length > 0 ? 500 : 200).json({
               data: rows,
               allClear: corruption.length === 0 && lagging.length === 0,
               correct: corruption.length === 0,
               violations: corruption.map((r) => r.invariant),
               warnings: lagging.map((r) => r.invariant),
          });
     })
);

app.use(errorMiddleware(logger));

// ═══════════════════════════════════════════════════════════════════════════

const expiryWorker = new ExpiryWorker({ pool, logger, options: { batchSize: config.EXPIRY_BATCH_SIZE } });

let outboxRelay = null;
async function startRelay() {
     if (!config.KAFKA_BROKERS) {
          logger.warn('KAFKA_BROKERS not set; outbox relay disabled. Events will accumulate as PENDING.');
          return null;
     }
     const { Kafka } = require('kafkajs');
     const { OutboxRelay } = require('@tessera/shared/src/outbox/relay');

     const kafka = new Kafka({
          clientId: 'inventory-engine',
          brokers: config.KAFKA_BROKERS.split(','),
          retry: { retries: 8 },
     });
     const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
     await producer.connect();

     const relay = new OutboxRelay({ pool, producer, logger, service: 'inventory' });
     relay.start();
     return { relay, producer };
}

async function main() {
     await pool.query('SELECT 1');
     logger.info('database reachable');

     expiryWorker.start();
     const relayHandle = await startRelay().catch((err) => {
          // Kafka being unavailable must not stop the service. Outbox rows
          // accumulate and the relay catches up — that is the whole point.
          logger.error('outbox relay failed to start; events will accumulate', { error: err.message });
          return null;
     });
     outboxRelay = relayHandle;

     listen({
          app,
          port: config.PORT,
          name: 'inventory-engine',
          logger,
          workers: [
               { name: 'expiry', stop: () => expiryWorker.stop() },
               { name: 'outbox-relay', stop: () => outboxRelay?.relay.stop() ?? Promise.resolve() },
          ],
          resources: [
               { name: 'kafka', close: () => outboxRelay?.producer.disconnect() ?? Promise.resolve() },
               { name: 'postgres', close: () => pool.end() },
          ],
     });
}

main().catch((err) => {
     logger.error('failed to start', { error: err.message, stack: err.stack });
     process.exit(1);
});
