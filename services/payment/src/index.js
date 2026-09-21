'use strict';

/**
 * Payment service — HTTP.
 *
 * The webhook route is mounted with a RAW body parser, before any JSON parsing.
 * This is not a style preference: an HMAC is computed over the exact bytes the
 * provider sent, and `JSON.parse` followed by `JSON.stringify` does not
 * reproduce them — key order, whitespace and number formatting all shift. A
 * service that verifies a re-serialised body will reject valid webhooks and,
 * worse, may accept crafted ones.
 */

require('../../inventory-engine/src/config/env');
require('@tessera/shared/src/observability/tracing');

const express = require('express');
const { createPool } = require('@tessera/shared/src/db/pool');
const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const { BadRequestError, UnauthorizedError } = require('@tessera/shared/src/errors');

const { PaymentService } = require('./service/payment.service');
const { FakeProvider } = require('./providers/fake.provider');
const { ResolverWorker } = require('./workers/resolver.worker');

const config = require('./config');
const logger = createLogger('payment');

const pool = createPool({
     connectionString: config.DATABASE_URL,
     name: 'payment',
     max: config.DB_POOL_MAX,
});

const provider = new FakeProvider({
     webhookSecret: config.WEBHOOK_SECRET,
     mode: config.PROVIDER_MODE,
     logger,
});

const payments = new PaymentService({ pool, provider, logger });

// Deliver the provider's asynchronous webhooks back into this process. In a
// real deployment the provider posts over HTTP; the handling path is identical.
provider.onWebhook(async ({ body, signature, timestamp }) => {
     try {
          await payments.handleWebhook({ rawBody: body, signature, timestamp, sourceIp: 'provider-callback' });
     } catch (err) {
          logger.error('provider callback failed', { error: err.message });
     }
});

const app = createApp({
     name: 'payment',
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

// ── Webhook: raw body, mounted before any JSON parsing ──────────────────────
app.post(
     '/webhooks/provider',
     express.raw({ type: '*/*', limit: '256kb' }),
     asyncHandler(async (req, res) => {
          const signature = req.get('x-tessera-signature');
          const timestamp = req.get('x-tessera-timestamp');

          if (!signature || !timestamp) {
               throw new BadRequestError('Missing signature or timestamp header', 'INVALID_SIGNATURE');
          }

          const result = await payments.handleWebhook({
               rawBody: req.body.toString('utf8'),
               signature,
               timestamp,
               sourceIp: req.ip,
          });

          // Always 200 for an accepted event, including duplicates: a provider
          // that receives an error retries, and retrying a duplicate we already
          // handled correctly would be pure noise.
          res.json({ received: true, ...result });
     })
);

// ── Internal API ────────────────────────────────────────────────────────────

app.post(
     '/internal/charge',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { reservationId, customerId, amountCents, currency, idempotencyKey, mode } = req.body || {};
          if (!idempotencyKey) throw new BadRequestError('idempotencyKey is required');

          const result = await payments.charge({
               reservationId,
               customerId,
               amountCents,
               currency,
               idempotencyKey,
               mode,
          });
          res.status(result.replayed ? 200 : 201).json({ data: result });
     })
);

app.post(
     '/internal/payments/:paymentId/resolve',
     requireInternal,
     asyncHandler(async (req, res) => {
          const result = await payments.resolveUnknown(req.params.paymentId);
          res.json({ data: result });
     })
);

app.post(
     '/internal/payments/:paymentId/refund',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { amountCents, reason, idempotencyKey } = req.body || {};
          const result = await payments.refund({
               paymentId: req.params.paymentId,
               amountCents,
               reason,
               idempotencyKey,
          });
          res.json({ data: result });
     })
);

app.get(
     '/internal/payments/:paymentId',
     requireInternal,
     asyncHandler(async (req, res) => {
          res.json({ data: await payments.get(req.params.paymentId) });
     })
);

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Payments awaiting resolution. The highest-priority operational queue in the
 * system: each row is money whose fate is genuinely unknown.
 */
app.get(
     '/admin/unresolved',
     requireInternal,
     asyncHandler(async (_req, res) => {
          const { rows } = await pool.query(`SELECT * FROM payments_awaiting_resolution ORDER BY unknown_for DESC`);
          metrics.paymentUnknown.set(rows.length);
          res.json({ data: rows, count: rows.length });
     })
);

/**
 * Switch the fake provider's failure mode at runtime, for chaos scenarios.
 * Only available when the fake provider is in use.
 */
app.post(
     '/admin/provider-mode',
     requireInternal,
     asyncHandler(async (req, res) => {
          if (provider.name !== 'fake') {
               throw new BadRequestError('Provider mode can only be set on the fake provider');
          }
          provider.setMode(req.body?.mode);
          logger.warn('provider failure mode changed', { mode: req.body?.mode });
          res.json({ data: { mode: req.body?.mode } });
     })
);

app.use(errorMiddleware(logger));

// ════════════════════════════════════════════════════════════════════════════

const resolver = new ResolverWorker({ pool, payments, logger });

let relayHandle = null;
async function startRelay() {
     if (!config.KAFKA_BROKERS) {
          logger.warn('KAFKA_BROKERS not set; outbox relay disabled');
          return null;
     }
     const { Kafka } = require('kafkajs');
     const { OutboxRelay } = require('@tessera/shared/src/outbox/relay');
     const kafka = new Kafka({ clientId: 'payment', brokers: config.KAFKA_BROKERS.split(',') });
     const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
     await producer.connect();
     const relay = new OutboxRelay({ pool, producer, logger, service: 'payment' });
     relay.start();
     return { relay, producer };
}

async function main() {
     await pool.query('SELECT 1');
     resolver.start();
     relayHandle = await startRelay().catch((err) => {
          logger.error('outbox relay failed to start', { error: err.message });
          return null;
     });

     listen({
          app,
          port: config.PORT,
          name: 'payment',
          logger,
          workers: [
               { name: 'resolver', stop: () => resolver.stop() },
               { name: 'outbox-relay', stop: () => relayHandle?.relay.stop() ?? Promise.resolve() },
          ],
          resources: [
               { name: 'kafka', close: () => relayHandle?.producer.disconnect() ?? Promise.resolve() },
               { name: 'postgres', close: () => pool.end() },
          ],
     });
}

main().catch((err) => {
     logger.error('failed to start', { error: err.message, stack: err.stack });
     process.exit(1);
});
