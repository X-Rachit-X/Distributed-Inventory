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

const {
     ServiceUnavailableError,
     TesseraError,
     NotFoundError,
     BadRequestError,
} = require('@tessera/shared/src/errors');
const { httpRequest, isTimeout } = require('@tessera/shared/src/http/client');

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
          let res;
          try {
               res = await httpRequest(`${this.baseUrl}${path}`, {
                    method: 'POST',
                    timeoutMs: this.timeoutMs,
                    headers: {
                         'x-internal-token': this.internalToken,
                         ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
                    },
                    json: body,
               });
          } catch (err) {
               if (isTimeout(err)) {
                    throw new ServiceUnavailableError(`inventory engine timed out after ${this.timeoutMs}ms`);
               }
               throw err;
          }
          if (!res.ok) throw toError(res.status, res.body);
          return res.body?.data ?? res.body;
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
     cancelBooking(req) {
          return this.#call('/internal/cancel-booking', req, req.idempotencyKey);
     }
}

/**
 * Payment client.
 *
 * Separate from the inventory client for one reason that matters: a TIMEOUT
 * HERE IS NOT A FAILURE. The charge may have gone through. The error is marked
 * `indeterminate` so the saga records UNKNOWN and asks the provider, rather
 * than assuming the worst and releasing a seat the customer paid for.
 */
class HttpPaymentClient {
     constructor({ baseUrl, internalToken, timeoutMs = 30_000, logger }) {
          this.baseUrl = baseUrl.replace(/\/$/, '');
          this.internalToken = internalToken;
          this.timeoutMs = timeoutMs;
          this.logger = logger;
     }

     async #call(path, body, method = 'POST') {
          let res;
          try {
               res = await httpRequest(`${this.baseUrl}${path}`, {
                    method,
                    timeoutMs: this.timeoutMs,
                    headers: { 'x-internal-token': this.internalToken },
                    json: method === 'GET' ? undefined : body,
               });
          } catch (err) {
               if (isTimeout(err)) {
                    const timeout = new ServiceUnavailableError(
                         `payment service did not answer within ${this.timeoutMs}ms`
                    );
                    // The flag the saga keys on to record UNKNOWN.
                    timeout.indeterminate = true;
                    timeout.code = 'PROVIDER_TIMEOUT';
                    throw timeout;
               }
               throw err;
          }
          if (!res.ok) {
               const err = toError(res.status, res.body);
               // A 5xx from the payment service may mean the provider was
               // reached and we lost the answer. Treat it as unknown.
               if (res.status >= 500) err.indeterminate = true;
               throw err;
          }
          return res.body?.data ?? res.body;
     }

     charge(req) {
          return this.#call('/internal/charge', req);
     }
     resolveUnknown(paymentId) {
          return this.#call(`/internal/payments/${paymentId}/resolve`, {});
     }
     refund(req) {
          return this.#call(`/internal/payments/${req.paymentId}/refund`, req);
     }
     get(paymentId) {
          return this.#call(`/internal/payments/${paymentId}`, null, 'GET');
     }

     /**
      * The payment created under an idempotency key, or null if none exists.
      *
      * How the saga recovers a charge whose response it never saw: the
      * payment row is committed before the provider is called, so "no row"
      * means the charge never started, and "a row" can be resolved by its id.
      */
     async findByKey(idempotencyKey) {
          try {
               const path = `/internal/payments/by-key/${encodeURIComponent(idempotencyKey)}`;
               return await this.#call(path, null, 'GET');
          } catch (err) {
               if (err.status === 404) return null;
               throw err;
          }
     }
}

/**
 * Pricing client.
 *
 * Called by the reservation API BEFORE its database transaction opens: a
 * network call inside a transaction holds its connection and row locks for as
 * long as the remote service takes. Fails closed: if prices cannot be
 * determined, nothing is sold.
 */
class HttpPricingClient {
     constructor({ baseUrl, timeoutMs = 5_000 }) {
          this.baseUrl = baseUrl.replace(/\/$/, '');
          this.timeoutMs = timeoutMs;
     }

     /**
      * Price seat items server-side. Any price the client sent is ignored.
      *
      * @returns {Promise<{ quoteId, totalCents, items, byKey: Map }>} `byKey` finds
      *   a quoted item by `resourceId-or-code:spanFrom:spanTo`.
      */
     async quote(eventId, items) {
          let res;
          try {
               res = await httpRequest(`${this.baseUrl}/v1/quote`, {
                    method: 'POST',
                    timeoutMs: this.timeoutMs,
                    json: { eventId, items },
               });
          } catch (err) {
               throw new ServiceUnavailableError(
                    isTimeout(err) ? 'Pricing did not respond in time' : 'Pricing is unavailable'
               );
          }
          if (res.status === 404) throw new NotFoundError(res.body?.error?.message || 'Seat not found');
          if (res.status === 400) throw new BadRequestError(res.body?.error?.message || 'Invalid items');
          if (!res.ok) throw new ServiceUnavailableError('Pricing is unavailable');

          const quote = res.body.data;
          const byKey = new Map();
          for (const q of quote.items) {
               byKey.set(`${q.resourceId}:${q.spanFrom}:${q.spanTo}`, q);
               byKey.set(`${q.resourceCode}:${q.spanFrom}:${q.spanTo}`, q);
          }
          return { byKey, totalCents: quote.totalCents, items: quote.items, quoteId: quote.quoteId };
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

     cancelBooking(req) {
          return this.pool.withTransaction((client) =>
               this.engine.cancelBooking(client, { bookingId: req.bookingId, reason: req.reason })
          );
     }
}

class InProcessPaymentClient {
     constructor({ service }) {
          this.service = service;
     }
     cancelBooking() {
          return Promise.resolve({ ok: true });
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
     findByKey(idempotencyKey) {
          return this.service.findByIdempotencyKey(idempotencyKey);
     }
}

module.exports = {
     HttpInventoryClient,
     HttpPaymentClient,
     HttpPricingClient,
     InProcessInventoryClient,
     InProcessPaymentClient,
     toError,
};
