'use strict';

/**
 * Clients the saga uses to reach other services.
 *
 * Two implementations behind one interface:
 *
 *   HTTP      — production. Separate services, separate databases, real network.
 *   in-process — tests. Calls the engine directly against its own pool.
 *
 * The in-process variant exists so saga behaviour can be tested deterministically
 * (crash exactly here, make the provider time out exactly there) without running
 * a full stack. It is NOT a mock: it executes the same engine code against the
 * same PostgreSQL schema, so a test that passes here exercised the real
 * transaction boundaries and the real constraints. Only the transport differs.
 *
 * Every call carries an idempotency key derived from the saga step, so a retry
 * after a lost response is recognised downstream as the same request rather
 * than a new one.
 */

const { ServiceUnavailableError, TesseraError } = require('@tessera/shared/src/errors');

/** Translate an HTTP error response into the shared error taxonomy. */
function toError(status, body) {
     const message = body?.error?.message || body?.message || `upstream returned ${status}`;
     const code = body?.error?.code || 'UPSTREAM_ERROR';
     const err = new TesseraError(message, { status, code });
     if (code === 'HOLD_EXPIRED') err.code = 'HOLD_EXPIRED';
     return err;
}

class HttpInventoryClient {
     constructor({ baseUrl, internalToken, timeoutMs = 5_000, logger }) {
          this.baseUrl = baseUrl.replace(/\/$/, '');
          this.internalToken = internalToken;
          this.timeoutMs = timeoutMs;
          this.logger = logger;
     }

     async #call(path, body, idempotencyKey) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
               const res = await fetch(`${this.baseUrl}${path}`, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                         'content-type': 'application/json',
                         'x-internal-token': this.internalToken,
                         ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
                    },
                    body: JSON.stringify(body),
               });
               const json = await res.json().catch(() => null);
               if (!res.ok) throw toError(res.status, json);
               return json?.data ?? json;
          } catch (err) {
               if (err.name === 'AbortError') {
                    throw new ServiceUnavailableError(`inventory engine timed out after ${this.timeoutMs}ms`);
               }
               throw err;
          } finally {
               clearTimeout(timer);
          }
     }

     reserve(req) {
          return this.#call('/internal/reserve', req, req.idempotencyKey);
     }
     confirm(req) {
          return this.#call('/internal/confirm', req, req.idempotencyKey);
     }
     release(req) {
          return this.#call('/internal/release', req, req.idempotencyKey);
     }
}

/**
 * Direct client for tests. Same engine, same database, no network.
 */
class InProcessInventoryClient {
     constructor({ pool, engine }) {
          this.pool = pool;
          this.engine = engine;
     }

     reserve(req) {
          return this.pool.withTransaction((client) =>
               this.engine.reserve(client, {
                    eventId: req.eventId,
                    customerId: req.customerId,
                    resources: req.resources,
                    pools: req.pools,
                    ttlSeconds: req.ttlSeconds,
                    reservationId: req.reservationId,
                    context: { correlationId: req.correlationId, actor: req.customerId },
               })
          );
     }

     confirm(req) {
          return this.pool.withTransaction((client) =>
               this.engine.confirm(client, { holdId: req.holdId, bookingId: req.bookingId })
          );
     }

     release(req) {
          return this.pool.withTransaction((client) =>
               this.engine.release(client, { holdId: req.holdId, reason: req.reason })
          );
     }
}

class InProcessPaymentClient {
     constructor({ service }) {
          this.service = service;
     }
     charge(req) {
          return this.service.charge(req);
     }
     resolveUnknown(paymentId) {
          return this.service.resolveUnknown(paymentId);
     }
     refund(req) {
          return this.service.refund(req);
     }
}

module.exports = { HttpInventoryClient, InProcessInventoryClient, InProcessPaymentClient, toError };
