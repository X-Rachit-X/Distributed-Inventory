'use strict';

/**
 * API Gateway.
 *
 * The edge. Everything a browser touches comes through here, and nothing behind
 * it is reachable from outside — which is what allows the internal services to
 * trust the identity headers this layer sets.
 *
 * Responsibilities, in the order a request meets them:
 *
 *   1. rate limit        — is this ONE client asking too often?
 *   2. waiting room      — how many people may be inside at all?
 *   3. authenticate      — who is this?
 *   4. proxy             — forward, with identity and correlation attached
 *
 * The order matters. Rate limiting runs before authentication so an unauthenticated
 * flood costs one Redis round trip rather than a JWT verification. The waiting
 * room runs before the expensive work but after cheap rejection, because
 * admitting someone to a queue is more expensive than refusing an abusive client.
 */

require('../../inventory-engine/src/config/env');
require('@tessera/shared/src/observability/tracing');

const express = require('express');
const crypto = require('node:crypto');
const Redis = require('ioredis');

const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { TokenBucket, LIMITS } = require('@tessera/shared/src/admission/token-bucket');
const { WaitingRoom, AdmissionLoop } = require('@tessera/shared/src/admission/waiting-room');
const { metrics, getEventLoopLagMs } = require('@tessera/shared/src/observability/metrics');
const {
     TooManyRequestsError,
     UnauthorizedError,
     LoadSheddingError,
     ServiceUnavailableError,
     BadRequestError,
     ForbiddenError,
} = require('@tessera/shared/src/errors');

const config = require('./config');
const { signToken, verifyToken } = require('./auth');

const logger = createLogger('gateway');

const redis = new Redis(config.REDIS_URL, {
     maxRetriesPerRequest: 2,
     // Never queue commands while Redis is down: a queued rate-limit check that
     // resolves thirty seconds late is worse than an immediate local decision.
     enableOfflineQueue: false,
     retryStrategy: (times) => Math.min(times * 200, 3_000),
});
redis.on('error', (err) => logger.warn('redis unavailable; admission control degraded', { error: err.message }));

const buckets = new TokenBucket({ redis, logger });
const waitingRoom = new WaitingRoom({
     redis,
     tokenSecret: config.WAITING_ROOM_SECRET,
     logger,
     options: {
          maxActive: config.WAITING_ROOM_MAX_ACTIVE,
          dripPerTick: config.WAITING_ROOM_DRIP,
          sessionTtlMs: config.WAITING_ROOM_SESSION_TTL_MS,
     },
});

const admissionLoop = new AdmissionLoop({
     waitingRoom,
     intervalMs: 1_000,
     logger,
     onAdmit: (eventId, admitted) => metrics.waitingRoomAdmitted.inc({ event_id: eventId }, admitted.length),
});

const app = createApp({
     name: 'gateway',
     logger,
     dependencies: [
          {
               name: 'reservation',
               critical: true,
               check: async () => (await fetch(`${config.RESERVATION_URL}/health`)).ok,
          },
          {
               name: 'inventory',
               critical: true,
               check: async () => (await fetch(`${config.INVENTORY_URL}/health`)).ok,
          },
          // Redis loss costs acceleration, not correctness, so it must not
          // remove this instance from the load balancer.
          { name: 'redis', critical: false, check: async () => (await redis.ping()) === 'PONG' },
     ],
});

app.use(cors());

function cors() {
     return (req, res, next) => {
          const origin = req.get('origin');
          if (origin && config.ALLOWED_ORIGINS.includes(origin)) {
               res.set('access-control-allow-origin', origin);
               res.set('access-control-allow-credentials', 'true');
               res.set('vary', 'Origin');
          }
          res.set('access-control-allow-headers', 'content-type, authorization, idempotency-key, x-waiting-room-token');
          res.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
          if (req.method === 'OPTIONS') return res.status(204).end();
          next();
     };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Backpressure
//
// Event-loop lag is the honest saturation signal for a Node process: when the
// loop is behind, accepting more work only deepens the queue that the requests
// doing useful work must traverse. Shedding fast with a Retry-After is kinder
// than a slow timeout, and it is what keeps the database out of trouble.
// ═══════════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
     if (req.path.startsWith('/health') || req.path.startsWith('/ready') || req.path === '/metrics') {
          return next();
     }
     if (getEventLoopLagMs() > config.MAX_EVENT_LOOP_LAG_MS) {
          metrics.loadShed.inc({ route: req.path, reason: 'event_loop_lag' });
          return next(new LoadSheddingError('Server is busy, please retry shortly', 2));
     }
     next();
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Rate limiting
// ═══════════════════════════════════════════════════════════════════════════

/** Which bucket applies to this path. Reserve is the scarce operation. */
function limitFor(path, method) {
     if (path.startsWith('/api/auth')) return { name: 'auth', limit: LIMITS.auth };
     if (path.startsWith('/api/waiting-room')) return { name: 'waitingRoom', limit: LIMITS.waitingRoom };
     if (path.startsWith('/api/events') && method === 'GET') return { name: 'search', limit: LIMITS.search };
     if (path.includes('/cancel')) return { name: 'cancel', limit: LIMITS.cancel };
     if (path.startsWith('/api/reservations') && method === 'POST') return { name: 'reserve', limit: LIMITS.reserve };
     return { name: 'availability', limit: LIMITS.availability };
}

app.use(
     asyncHandler(async (req, res, next) => {
          if (req.path.startsWith('/health') || req.path.startsWith('/ready') || req.path === '/metrics') {
               return next();
          }

          const { name, limit } = limitFor(req.path, req.method);

          // Identify by user when known, by IP otherwise. Behind a proxy the
          // client IP is only trustworthy if `trust proxy` is set AND the proxy
          // is the only thing that can reach this port.
          const identity = req.get('authorization')
               ? `user:${hashIdentity(req.get('authorization'))}`
               : `ip:${req.ip}`;

          const result = await buckets.take(`${name}:${identity}`, limit);

          res.set('x-ratelimit-limit', String(limit.capacity));
          res.set('x-ratelimit-remaining', String(Math.max(0, result.remaining)));
          if (result.degraded) res.set('x-ratelimit-mode', 'degraded');

          if (!result.allowed) {
               metrics.rateLimited.inc({ scope: name, route: req.path });
               return next(
                    new TooManyRequestsError(
                         'Too many requests. Please slow down.',
                         Math.ceil(result.retryAfterMs / 1000)
                    )
               );
          }
          next();
     })
);

const hashIdentity = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

// ═══════════════════════════════════════════════════════════════════════════
// 3 · Auth
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Demo login.
 *
 * Deliberately minimal and clearly labelled: this project's subject is
 * inventory correctness, not credential handling, and a half-built password
 * flow would be worse than an obviously-demo one. Real deployments swap this
 * for an identity provider; everything downstream only needs a verified
 * subject in a signed token.
 */
app.post(
     '/api/auth/login',
     express.json(),
     asyncHandler(async (req, res) => {
          const { email } = req.body || {};
          if (!email || !String(email).includes('@')) {
               throw new BadRequestError('A valid email is required');
          }
          // Stable id from the email, so the same demo user keeps their bookings.
          const normalised = String(email).toLowerCase();
          const customerId = `cust-${hashIdentity(normalised)}`;
          const role = config.OPERATOR_EMAILS.includes(normalised) ? 'OPERATOR' : 'CUSTOMER';
          const token = signToken({ sub: customerId, email, role }, config.JWT_SECRET, config.JWT_TTL_SECONDS);
          res.json({ data: { token, customerId, role, expiresInSeconds: config.JWT_TTL_SECONDS } });
     })
);

function authenticate(required = true) {
     return (req, _res, next) => {
          const header = req.get('authorization');
          if (!header?.startsWith('Bearer ')) {
               return required ? next(new UnauthorizedError('Missing bearer token')) : next();
          }
          const claims = verifyToken(header.slice(7), config.JWT_SECRET);
          if (!claims) return next(new UnauthorizedError('Invalid or expired token'));
          req.customerId = claims.sub;
          req.customerEmail = claims.email;
          req.role = claims.role || 'CUSTOMER';
          next();
     };
}

/**
 * Role check, applied AFTER authentication.
 *
 * Operator actions (withdrawing a seat, resolving a money discrepancy) are
 * enforced here at the edge AND carry the operator's identity downstream as
 * `x-actor`, so the audit log names a person rather than "admin".
 */
function requireRole(role) {
     return (req, _res, next) => {
          if (req.role !== role) {
               return next(new ForbiddenError(`This action requires the ${role} role`));
          }
          next();
     };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Waiting room
// ═══════════════════════════════════════════════════════════════════════════

app.post(
     '/api/waiting-room/:eventId/join',
     authenticate(),
     asyncHandler(async (req, res) => {
          admissionLoop.track(req.params.eventId);
          const result = await waitingRoom.join(req.params.eventId, req.get('x-session-id') || req.customerId);
          const stats = await waitingRoom.stats(req.params.eventId);
          metrics.waitingRoomDepth.set({ event_id: req.params.eventId }, stats.queueDepth);
          res.json({ data: { ...result, ...stats } });
     })
);

app.get(
     '/api/waiting-room/:eventId/status',
     authenticate(),
     asyncHandler(async (req, res) => {
          const status = await waitingRoom.status(
               req.params.eventId,
               req.get('x-session-id') || req.customerId
          );
          res.json({ data: status });
     })
);

app.post(
     '/api/waiting-room/:eventId/leave',
     authenticate(),
     asyncHandler(async (req, res) => {
          await waitingRoom.leave(req.params.eventId, req.get('x-session-id') || req.customerId);
          res.status(204).end();
     })
);

/**
 * Gate the reserve path on an admission token when the waiting room is active.
 *
 * The token is signed and verified here without touching Redis, so a Redis
 * outage does not eject users who are already inside and mid-checkout.
 */
function requireAdmission(req, _res, next) {
     if (!config.WAITING_ROOM_ENABLED) return next();

     const eventId = req.body?.eventId;
     if (!eventId) return next();

     const token = req.get('x-waiting-room-token');
     const verdict = waitingRoom.verifyToken(token, eventId);
     if (!verdict.valid) {
          return next(
               new TooManyRequestsError(
                    `Join the waiting room for this event first (${verdict.reason})`,
                    5,
                    'WAITING_ROOM_REQUIRED'
               )
          );
     }
     next();
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · Proxy
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Forward to an internal service.
 *
 * Attaches the VERIFIED customer id and the correlation ids. The downstream
 * service trusts `x-customer-id` because it is only reachable from inside, and
 * the gateway is the only thing that sets it.
 */
function proxy(targetBase, rewrite) {
     return asyncHandler(async (req, res) => {
          const path = rewrite(req);
          const url = `${targetBase}${path}`;

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), config.UPSTREAM_TIMEOUT_MS);

          try {
               const upstream = await fetch(url, {
                    method: req.method,
                    signal: controller.signal,
                    headers: {
                         'content-type': 'application/json',
                         'x-internal-token': config.INTERNAL_TOKEN,
                         'x-request-id': req.context.requestId,
                         'x-correlation-id': req.context.correlationId,
                         ...(req.customerId ? { 'x-customer-id': req.customerId } : {}),
                         ...(req.customerEmail ? { 'x-actor': req.customerEmail } : {}),
                         ...(req.get('idempotency-key') ? { 'idempotency-key': req.get('idempotency-key') } : {}),
                    },
                    body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body ?? {}) : undefined,
               });

               const body = await upstream.text();
               // Pass the upstream status through unchanged. Collapsing a 409
               // into a 500 here would make correct contention behaviour look
               // like a server fault to the browser.
               res.status(upstream.status);
               const retryAfter = upstream.headers.get('retry-after');
               if (retryAfter) res.set('retry-after', retryAfter);
               res.type('application/json').send(body);
          } catch (err) {
               if (err.name === 'AbortError') {
                    throw new ServiceUnavailableError('Upstream service did not respond in time');
               }
               throw err;
          } finally {
               clearTimeout(timer);
          }
     });
}

app.use(express.json({ limit: '256kb' }));

// Public catalogue and availability.
app.get(
     '/api/events',
     proxy(config.INVENTORY_URL, () => '/v1/events')
);
app.get(
     '/api/events/:eventId/availability',
     proxy(config.INVENTORY_URL, (req) => `/v1/events/${req.params.eventId}/availability${qs(req)}`)
);
app.get(
     '/api/events/:eventId/span-points',
     proxy(config.INVENTORY_URL, (req) => `/v1/events/${req.params.eventId}/span-points`)
);
app.get(
     '/api/events/:eventId/resources',
     proxy(config.INVENTORY_URL, (req) => `/v1/events/${req.params.eventId}/resources${qs(req)}`)
);

// Booking.
app.post(
     '/api/reservations',
     authenticate(),
     requireAdmission,
     proxy(config.RESERVATION_URL, () => '/v1/reservations')
);
app.get(
     '/api/reservations',
     authenticate(),
     proxy(config.RESERVATION_URL, () => '/v1/reservations')
);
app.get(
     '/api/reservations/:id',
     authenticate(),
     proxy(config.RESERVATION_URL, (req) => `/v1/reservations/${req.params.id}`)
);
app.post(
     '/api/reservations/:id/cancel',
     authenticate(),
     proxy(config.RESERVATION_URL, (req) => `/v1/reservations/${req.params.id}/cancel`)
);

// Search (discovery data, never authoritative).
app.get('/api/search', proxy(config.DISCOVERY_URL, (req) => `/v1/search${qs(req)}`));
app.get('/api/stations', proxy(config.DISCOVERY_URL, (req) => `/v1/stations${qs(req)}`));
app.get(
     '/api/events/:eventId/adjacent',
     proxy(config.INVENTORY_URL, (req) => `/v1/events/${req.params.eventId}/adjacent${qs(req)}`)
);

// Pricing. A quote is informational; the binding price is set server-side
// when the reservation is created.
app.post('/api/pricing/quote', proxy(config.PRICING_URL, () => '/v1/quote'));
app.get('/api/pricing/rules', proxy(config.PRICING_URL, () => '/v1/fare-rules'));

// A customer's notifications.
app.get('/api/notifications', authenticate(), proxy(config.NOTIFICATION_URL, () => '/v1/notifications'));

// Operational read-outs, used by the dashboard. Read-only and public so the
// correctness scoreboard can be shown to anyone.
app.get(
     '/api/ops/invariants',
     proxy(config.INVENTORY_URL, () => '/admin/invariants')
);
app.get('/api/ops/scoreboard', proxy(config.RECONCILIATION_URL, () => '/v1/scoreboard'));
app.get('/api/ops/discovery', proxy(config.DISCOVERY_URL, () => '/v1/status'));
app.get('/api/ops/notifications', proxy(config.NOTIFICATION_URL, () => '/v1/status'));

// Operator-only.
app.get(
     '/api/ops/issues',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.RECONCILIATION_URL, (req) => `/v1/issues${qs(req)}`)
);
app.get(
     '/api/ops/reconciliation-runs',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.RECONCILIATION_URL, () => '/v1/runs')
);
app.post(
     '/api/ops/reconcile',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.RECONCILIATION_URL, () => '/admin/run')
);
app.post(
     '/api/ops/issues/:id/:action',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.RECONCILIATION_URL, (req) => `/admin/issues/${req.params.id}/${req.params.action}`)
);
app.post(
     '/api/ops/resources/:resourceId/block',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.INVENTORY_URL, (req) => `/admin/resources/${req.params.resourceId}/block`)
);
app.post(
     '/api/ops/resources/:resourceId/unblock',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.INVENTORY_URL, (req) => `/admin/resources/${req.params.resourceId}/unblock`)
);
app.get(
     '/api/ops/unresolved-payments',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.PAYMENT_URL, () => '/admin/unresolved')
);
app.post(
     '/api/ops/provider-mode',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.PAYMENT_URL, () => '/admin/provider-mode')
);
app.get(
     '/api/ops/dead-letters',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.NOTIFICATION_URL, () => '/admin/dead-letters')
);
app.post(
     '/api/ops/dead-letters/replay',
     authenticate(),
     requireRole('OPERATOR'),
     proxy(config.NOTIFICATION_URL, () => '/admin/dead-letters/replay')
);

const qs = (req) => {
     const q = new URLSearchParams(req.query).toString();
     return q ? `?${q}` : '';
};

app.use(errorMiddleware(logger));

// ════════════════════════════════════════════════════════════════════════════

async function main() {
     admissionLoop.start();
     listen({
          app,
          port: config.PORT,
          name: 'gateway',
          logger,
          workers: [{ name: 'admission', stop: () => admissionLoop.stop() }],
          resources: [{ name: 'redis', close: () => redis.quit() }],
     });
}

main().catch((err) => {
     logger.error('failed to start', { error: err.message, stack: err.stack });
     process.exit(1);
});
