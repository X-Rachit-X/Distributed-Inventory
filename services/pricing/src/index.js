'use strict';

/**
 * Pricing service.
 *
 * Quotes fares server-side. The reservation service calls it when a reservation
 * is created and stores the quoted price on each item; that price is what the
 * hold records and what the customer is charged. A price sent by the browser is
 * ignored entirely — letting the client state what it will pay is the classic
 * way a booking system sells a first-class seat for one rupee.
 *
 * Stateless. It reads live availability from the inventory engine to decide the
 * demand tier, and caches that read for a couple of seconds: during a flash sale
 * thousands of quotes for one train would otherwise each trigger an availability
 * scan, and a demand tier that is two seconds old is still the right tier.
 */

require('@tessera/shared/src/config/env');
require('@tessera/shared/src/observability/tracing');

const express = require('express');
const crypto = require('node:crypto');
const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const { fare, TIERS } = require('@tessera/shared/src/pricing');
const { httpRequest, isHealthy, isTimeout } = require('@tessera/shared/src/http/client');
const { BadRequestError, NotFoundError, ServiceUnavailableError } = require('@tessera/shared/src/errors');

const { str, num } = require('@tessera/shared/src/config');
const config = {
     PORT: num('PRICING_PORT', 4007),
     INVENTORY_URL: str('INVENTORY_URL', 'http://localhost:4001'),
     CACHE_TTL_MS: num('PRICING_CACHE_TTL_MS', 2000),
     QUOTE_TTL_SECONDS: num('QUOTE_TTL_SECONDS', 600),
};

const logger = createLogger('pricing');

// ── L1 cache with single-flight ─────────────────────────────────────────────
//
// Single-flight matters as much as the cache itself. Without it, when an entry
// expires under load, every concurrent request misses at once and they all hit
// inventory together — a cache stampede that arrives exactly when the system
// is busiest.

const cache = new Map();
const inflight = new Map();

async function cached(key, loader) {
     const hit = cache.get(key);
     if (hit && hit.expires > Date.now()) {
          metrics.cacheRequests.inc({ cache: 'pricing-l1', result: 'hit' });
          return hit.value;
     }
     metrics.cacheRequests.inc({ cache: 'pricing-l1', result: 'miss' });

     if (inflight.has(key)) return inflight.get(key);

     const promise = loader()
          .then((value) => {
               cache.set(key, { value, expires: Date.now() + config.CACHE_TTL_MS });
               return value;
          })
          .finally(() => inflight.delete(key));
     inflight.set(key, promise);
     return promise;
}

async function inventoryGet(path) {
     let res;
     try {
          res = await httpRequest(`${config.INVENTORY_URL}${path}`, { timeoutMs: 4000 });
     } catch (err) {
          if (isTimeout(err)) throw new ServiceUnavailableError('inventory did not respond in time');
          throw err;
     }
     if (res.status === 404) throw new NotFoundError('Event not found');
     if (!res.ok) throw new ServiceUnavailableError(`inventory returned ${res.status}`);
     return res.body.data;
}

/**
 * Everything needed to price one span of one event: each seat's base price and
 * class, and how many seats of each class are still free for that span.
 */
async function spanSnapshot(eventId, spanFrom, spanTo) {
     return cached(`${eventId}:${spanFrom}:${spanTo}`, async () => {
          const [resources, availability] = await Promise.all([
               inventoryGet(`/v1/events/${eventId}/resources?spanFrom=${spanFrom}&spanTo=${spanTo}`),
               inventoryGet(`/v1/events/${eventId}/availability?spanFrom=${spanFrom}&spanTo=${spanTo}`),
          ]);
          const byClass = new Map(availability.byClass.map((c) => [c.class, c]));
          const byId = new Map(resources.resources.map((r) => [r.resourceId, r]));
          const byCode = new Map(resources.resources.map((r) => [r.code, r]));
          return { spanMax: availability.span.max, byClass, byId, byCode };
     });
}

const app = createApp({
     name: 'pricing',
     logger,
     dependencies: [
          {
               name: 'inventory',
               critical: true,
               check: () => isHealthy(config.INVENTORY_URL),
          },
     ],
});
app.use(express.json());

/**
 * Quote a set of items.
 *
 * Returns per-item fares plus the reason for each (distance share, demand tier),
 * so a receipt can explain a price rather than just state it.
 */
app.post(
     '/v1/quote',
     asyncHandler(async (req, res) => {
          const { eventId, items } = req.body || {};
          if (!eventId) throw new BadRequestError('eventId is required');
          if (!Array.isArray(items) || items.length === 0) throw new BadRequestError('items must be non-empty');
          if (items.length > 12) throw new BadRequestError('at most 12 items per quote');

          const quoted = [];
          for (const item of items) {
               const spanFrom = Number(item.spanFrom ?? 0);
               const spanTo = Number(item.spanTo ?? 1);
               if (!(spanTo > spanFrom)) throw new BadRequestError('spanTo must be greater than spanFrom');

               const snap = await spanSnapshot(eventId, spanFrom, spanTo);
               const resource = item.resourceId ? snap.byId.get(item.resourceId) : snap.byCode.get(item.resourceCode);
               if (!resource) {
                    throw new NotFoundError(`Resource ${item.resourceId || item.resourceCode} not found in this event`);
               }
               if (spanTo > snap.spanMax) throw new BadRequestError(`spanTo exceeds the route (max ${snap.spanMax})`);

               const cls = snap.byClass.get(resource.class) ?? { available: 0, total: 0 };
               const priced = fare({
                    basePriceCents: resource.priceCents,
                    spanFrom,
                    spanTo,
                    spanMax: snap.spanMax,
                    classAvailable: cls.available,
                    classTotal: cls.total,
               });

               quoted.push({
                    resourceId: resource.resourceId,
                    resourceCode: resource.code,
                    class: resource.class,
                    spanFrom,
                    spanTo,
                    fareCents: priced.fareCents,
                    basePriceCents: resource.priceCents,
                    spanShare: priced.spanShare,
                    tier: { code: priced.tier.code, label: priced.tier.label, multiplier: priced.tier.multiplier },
                    // Reported so the UI can say "3 of 64 left" next to a tier.
                    classAvailable: cls.available,
                    classTotal: cls.total,
               });
          }

          const totalCents = quoted.reduce((s, q) => s + q.fareCents, 0);
          res.json({
               data: {
                    quoteId: crypto.randomUUID(),
                    eventId,
                    currency: 'INR',
                    items: quoted,
                    totalCents,
                    quotedAt: new Date().toISOString(),
                    // Informational. The binding price is the one stored on the
                    // hold at reservation time, not this expiry.
                    validUntil: new Date(Date.now() + config.QUOTE_TTL_SECONDS * 1000).toISOString(),
               },
          });
     })
);

/** The rules themselves, so a UI can explain tiers without hard-coding them. */
app.get('/v1/fare-rules', (_req, res) => {
     res.json({
          data: {
               tiers: TIERS.map((t) => ({
                    code: t.code,
                    label: t.label,
                    multiplier: t.multiplier,
                    appliesBelowOccupancy: Number.isFinite(t.upTo) ? t.upTo : null,
               })),
               distance: 'fare scales with the share of the route travelled, floor 30%',
               rounding: 'nearest whole rupee',
          },
     });
});

app.use(errorMiddleware(logger));

listen({ app, port: config.PORT, name: 'pricing', logger });
