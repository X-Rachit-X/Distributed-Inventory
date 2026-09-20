'use strict';

/**
 * Service bootstrap.
 *
 * Every Tessera service gets the same shell so that operational behaviour is
 * identical everywhere: the same health semantics, the same error shape, the
 * same correlation ids, and the same shutdown sequence.
 *
 * The shutdown sequence is the part worth reading. A pod that exits the moment
 * it receives SIGTERM drops in-flight requests and abandons leases, which shows
 * up as customer-visible errors during every routine deploy. Here:
 *
 *   1. readiness starts failing, so the load balancer stops sending new work
 *   2. a grace period lets in-flight requests finish
 *   3. workers stop claiming, and release the leases they hold
 *   4. connections close
 *
 * Health and readiness are deliberately different questions. Liveness asks "is
 * this process wedged and in need of a restart?" — restarting because the
 * database is down would turn a database outage into a restart loop that makes
 * recovery slower. Readiness asks "should traffic come here right now?"
 */

const express = require('express');
const crypto = require('node:crypto');
const { metricsHandler, startEventLoopLagProbe, getEventLoopLagMs } = require('../observability/metrics');
const { withContext, addContext } = require('../observability/logger');
const { TesseraError } = require('../errors');
const failpoints = require('../failpoints');

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {object} opts.logger
 * @param {Array<{name: string, check: () => Promise<boolean>, critical?: boolean}>} [opts.dependencies]
 */
function createApp({ name, logger, dependencies = [] }) {
     const app = express();

     app.disable('x-powered-by');
     app.set('trust proxy', true);
     app.use(express.json({ limit: '256kb' }));

     // Correlation. Every log line, every event and every downstream call in
     // this request carries these ids, which is what makes one reservation
     // followable across seven services during an incident.
     app.use((req, res, next) => {
          const requestId = req.get('x-request-id') || crypto.randomUUID();
          const correlationId = req.get('x-correlation-id') || requestId;
          const traceId = req.get('traceparent') || null;

          req.context = { requestId, correlationId, traceId, service: name };
          res.set('x-request-id', requestId);

          withContext({ request_id: requestId, correlation_id: correlationId, trace_id: traceId }, () =>
               next()
          );
     });

     app.use((req, res, next) => {
          const started = process.hrtime.bigint();
          res.on('finish', () => {
               const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
               // 4xx is the client's problem and normal under contention; only
               // 5xx is ours. Logging them at the same level trains people to
               // ignore the log.
               const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'debug' : 'info';
               logger[level]('request', {
                    method: req.method,
                    path: req.route?.path || req.path,
                    status: res.statusCode,
                    durationMs: +durationMs.toFixed(1),
               });
          });
          next();
     });

     // Liveness: is the process itself functional? Deliberately does NOT check
     // dependencies.
     app.get('/health', (_req, res) => {
          res.json({ status: 'ok', service: name, uptimeSeconds: Math.floor(process.uptime()) });
     });

     // Readiness: should this instance receive traffic?
     app.get('/ready', async (_req, res) => {
          const results = await Promise.all(
               dependencies.map(async (dep) => {
                    try {
                         const ok = await dep.check();
                         return { name: dep.name, ok, critical: dep.critical !== false };
                    } catch (err) {
                         return { name: dep.name, ok: false, critical: dep.critical !== false, error: err.message };
                    }
               })
          );

          // A non-critical dependency being down degrades the service without
          // removing it from the pool. Redis is the canonical example: losing
          // it costs acceleration, not correctness.
          const blocking = results.filter((r) => r.critical && !r.ok);
          const degraded = results.filter((r) => !r.critical && !r.ok);

          res.status(blocking.length === 0 && !app.locals.draining ? 200 : 503).json({
               status: app.locals.draining ? 'draining' : blocking.length === 0 ? 'ready' : 'not-ready',
               service: name,
               degraded: degraded.map((d) => d.name),
               dependencies: results,
               eventLoopLagMs: +getEventLoopLagMs().toFixed(1),
          });
     });

     app.get('/metrics', metricsHandler);

     // Never mounted unless FAILPOINTS_ENABLED is set, and never in production.
     const fpRouter = failpoints.router(express);
     if (fpRouter) {
          app.use('/_failpoints', fpRouter);
          logger.warn('failpoints are ENABLED — this must never be a production configuration');
     }

     startEventLoopLagProbe();

     return app;
}

/** Wrap an async handler so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Error middleware. Mount LAST, after all routes.
 *
 * The important property: a conflict is rendered as a conflict, with its code
 * intact, so a client can distinguish "someone took that seat" (do not retry
 * blindly) from "we broke" (retrying may help).
 */
function errorMiddleware(logger) {
     // eslint-disable-next-line no-unused-vars
     return (err, req, res, _next) => {
          if (err instanceof TesseraError) {
               if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
               if (err.status >= 500) {
                    logger.error('request failed', { code: err.code, message: err.message, stack: err.stack });
               }
               return res.status(err.status).json(err.toJSON());
          }

          // PostgreSQL constraint violations that escaped a handler are still
          // conflicts, not server errors. Returning 500 here would make a
          // correctly functioning system look broken under load.
          if (err.code === '23P01' || err.code === '23505') {
               return res.status(409).json({
                    error: { code: 'CONFLICT', message: 'The requested resource is no longer available' },
               });
          }

          logger.error('unhandled error', { message: err.message, stack: err.stack });
          res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
     };
}

/**
 * Start listening, with graceful shutdown.
 *
 * @param {object} opts
 * @param {import('express').Express} opts.app
 * @param {number} opts.port
 * @param {Array<{name: string, stop: () => Promise<void>|void}>} [opts.workers]
 * @param {Array<{name: string, close: () => Promise<void>}>} [opts.resources]
 */
function listen({ app, port, name, logger, workers = [], resources = [], drainMs = 3_000 }) {
     const server = app.listen(port, () => {
          logger.info(`${name} listening`, { port, pid: process.pid });
     });

     // Bound how long a connection may stay idle between requests, so shutdown
     // is not held hostage by a keep-alive nobody is using.
     server.keepAliveTimeout = 65_000;
     server.headersTimeout = 70_000;

     let shuttingDown = false;

     async function shutdown(signal) {
          if (shuttingDown) return;
          shuttingDown = true;
          logger.info('shutting down', { signal });

          // 1. Fail readiness first so the load balancer stops sending work,
          //    while we keep serving what is already in flight.
          app.locals.draining = true;
          await new Promise((r) => setTimeout(r, drainMs));

          // 2. Stop accepting new connections.
          await new Promise((resolve) => server.close(resolve));

          // 3. Stop workers and release their leases, so another replica can
          //    pick the work up immediately rather than waiting for expiry.
          for (const worker of workers) {
               try {
                    await worker.stop();
                    logger.info('worker stopped', { worker: worker.name });
               } catch (err) {
                    logger.error('worker failed to stop cleanly', { worker: worker.name, error: err.message });
               }
          }

          // 4. Close pools and clients.
          for (const resource of resources) {
               try {
                    await resource.close();
               } catch (err) {
                    logger.error('resource failed to close', { resource: resource.name, error: err.message });
               }
          }

          logger.info('shutdown complete');
          process.exit(0);
     }

     process.on('SIGTERM', () => shutdown('SIGTERM'));
     process.on('SIGINT', () => shutdown('SIGINT'));

     process.on('unhandledRejection', (reason) => {
          logger.error('unhandled promise rejection', { reason: String(reason?.stack || reason) });
     });
     process.on('uncaughtException', (err) => {
          // An uncaught exception leaves the process in an unknown state.
          // Logging and continuing risks serving corrupt results; exiting lets
          // the orchestrator restart a clean one.
          logger.error('uncaught exception, exiting', { error: err.message, stack: err.stack });
          process.exit(1);
     });

     return { server, shutdown };
}

module.exports = { createApp, asyncHandler, errorMiddleware, listen };
