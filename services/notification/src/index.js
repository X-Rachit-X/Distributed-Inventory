'use strict';

/**
 * Notification service.
 *
 * Consumes `booking.events` (booking.confirmed and booking.cancelled) and tells
 * customers what happened. Delivery is simulated — rows in a table plus a log line — because
 * the interesting part is not SMTP, it is the consumer guarantees:
 *
 *   - AT-LEAST-ONCE in, EXACTLY ONE email out. The notification and the
 *     processed-events marker commit in one transaction; a redelivered event
 *     finds the marker and stops.
 *   - VERSION-TOLERANT. It reads `booking.confirmed` at v2. Events produced as v1
 *     before the contract changed are upcast on the way in, so a deploy that
 *     bumps the producer does not strand history.
 *   - POISON-TOLERANT. A malformed or schema-invalid message is dead-lettered
 *     with its source coordinates, and the partition keeps moving. Operators
 *     can list dead letters and replay them after fixing the cause.
 */

require('@tessera/shared/src/config/env');
require('@tessera/shared/src/observability/tracing');

const { createPool } = require('@tessera/shared/src/db/pool');
const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { createIdempotentHandler, replayDeadLetters } = require('@tessera/shared/src/consumer');
const { startConsumer } = require('@tessera/shared/src/consumer/runner');
const { UnauthorizedError } = require('@tessera/shared/src/errors');

const { str, num, secret } = require('@tessera/shared/src/config');
const config = {
     PORT: num('NOTIFICATION_PORT', 4005),
     DATABASE_URL:
          str('NOTIFICATION_DATABASE_URL', 'postgresql://tessera:tessera@localhost:5432/notification'),
     KAFKA_BROKERS: str('KAFKA_BROKERS', ''),
     INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),
};

const CONSUMER_GROUP = 'notification-v1';

const logger = createLogger('notification');
const pool = createPool({ connectionString: config.DATABASE_URL, name: 'notification', max: 5 });
const handleOnce = createIdempotentHandler({ pool, consumerName: CONSUMER_GROUP, logger });

const formatRupees = (cents) => `₹${(Number(cents) / 100).toLocaleString('en-IN')}`;

/** Event → notification. Returns null for events this service ignores. */
function render(envelope) {
     const p = envelope.payload;
     switch (envelope.event_type) {
          case 'booking.confirmed':
               return {
                    customerId: p.customer_id,
                    reservationId: p.reservation_id,
                    template: 'booking_confirmed',
                    subject: `Booking confirmed — ${p.reference}`,
                    body:
                         `Your booking ${p.reference} is confirmed. ` +
                         `${p.seat_codes?.length ? `Seats: ${p.seat_codes.join(', ')}. ` : ''}` +
                         `Total ${formatRupees(p.total_cents)} (${p.currency}).`,
               };
          case 'booking.cancelled':
               return {
                    customerId: p.customer_id,
                    reservationId: p.reservation_id,
                    template: 'booking_cancelled',
                    subject: 'Booking cancelled',
                    body: p.refund_initiated
                         ? 'Your booking was cancelled and a refund is on its way.'
                         : 'Your booking was cancelled.',
               };
          default:
               return null;
     }
}

async function handle(envelope) {
     const result = await handleOnce(envelope, async (client) => {
          const note = render(envelope);
          if (!note) return;

          await client.query(
               `INSERT INTO notifications
                       (customer_id, template, subject, body, reservation_id, source_event_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (source_event_id, template) DO NOTHING`,
               [note.customerId, note.template, note.subject, note.body, note.reservationId ?? null, envelope.event_id]
          );

          // The "send". A real deployment calls an email provider here — AFTER
          // the transaction commits, keyed by source_event_id, so a provider
          // retry is also deduplicated on their side.
          logger.info('notification sent', {
               customerId: note.customerId,
               template: note.template,
               subject: note.subject,
          });
     });

     if (result === 'DUPLICATE') {
          logger.info('duplicate delivery absorbed; customer not notified twice', {
               eventId: envelope.event_id,
               eventType: envelope.event_type,
          });
     }
}

const app = createApp({
     name: 'notification',
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

function requireInternal(req, _res, next) {
     if (req.get('x-internal-token') !== config.INTERNAL_TOKEN) {
          return next(new UnauthorizedError('Invalid or missing internal service token'));
     }
     next();
}

/** A customer's inbox. The gateway forwards the verified customer id. */
app.get(
     '/v1/notifications',
     asyncHandler(async (req, res) => {
          const customerId = req.get('x-customer-id');
          if (!customerId) throw new UnauthorizedError('Missing customer identity');
          const { rows } = await pool.query(
               `SELECT id, channel, template, subject, body, reservation_id, status, created_at
                  FROM notifications WHERE customer_id = $1
                 ORDER BY created_at DESC LIMIT 50`,
               [customerId]
          );
          res.json({ data: rows });
     })
);

/** Consumer health: how far behind, and how many events were deduplicated. */
app.get(
     '/v1/status',
     asyncHandler(async (_req, res) => {
          const [processed, notes, dead] = await Promise.all([
               pool.query(`SELECT count(*)::int AS n FROM processed_events WHERE consumer = $1`, [CONSUMER_GROUP]),
               pool.query(`SELECT count(*)::int AS n FROM notifications`),
               pool.query(`SELECT count(*)::int AS n FROM dead_letters WHERE status = 'OPEN'`),
          ]);
          res.json({
               data: {
                    consumerGroup: CONSUMER_GROUP,
                    eventsProcessed: processed.rows[0].n,
                    notificationsSent: notes.rows[0].n,
                    openDeadLetters: dead.rows[0].n,
                    lag: consumerHandle ? await consumerHandle.lag().catch(() => null) : null,
               },
          });
     })
);

app.get(
     '/admin/dead-letters',
     requireInternal,
     asyncHandler(async (_req, res) => {
          const { rows } = await pool.query(
               `SELECT id, event_id, event_type, source_topic, source_partition, source_offset,
                       reason, error_message, attempts, status, created_at
                  FROM dead_letters ORDER BY created_at DESC LIMIT 100`
          );
          res.json({ data: rows });
     })
);

/** Replay dead letters after a fix. Dedupe makes partial-success replays safe. */
app.post(
     '/admin/dead-letters/replay',
     requireInternal,
     asyncHandler(async (req, res) => {
          if (!consumerHandle) throw new UnauthorizedError('Kafka is not connected');
          const result = await replayDeadLetters({
               pool,
               producer: consumerHandle.producer,
               consumerName: CONSUMER_GROUP,
               ids: req.body?.ids ?? null,
               logger,
          });
          res.json({ data: result });
     })
);

app.use(errorMiddleware(logger));

let consumerHandle = null;

async function main() {
     await pool.query('SELECT 1');

     if (config.KAFKA_BROKERS) {
          consumerHandle = await startConsumer({
               clientId: 'notification',
               groupId: CONSUMER_GROUP,
               topics: ['booking.events'],
               brokers: config.KAFKA_BROKERS,
               pool,
               handle,
               logger,
               // Reads booking.confirmed at v2; older v1 events are upcast.
               // Every other type is read at whatever version it was produced.
               readerVersion: { 'booking.confirmed': 2 },
          }).catch((err) => {
               logger.error('consumer failed to start; will serve HTTP without consuming', { error: err.message });
               return null;
          });
     } else {
          logger.warn('KAFKA_BROKERS not set; notification consumer disabled');
     }

     listen({
          app,
          port: config.PORT,
          name: 'notification',
          logger,
          workers: [{ name: 'consumer', stop: () => consumerHandle?.stop() ?? Promise.resolve() }],
          resources: [{ name: 'postgres', close: () => pool.end() }],
     });
}

main().catch((err) => {
     logger.error('failed to start', { error: err.message, stack: err.stack });
     process.exit(1);
});
