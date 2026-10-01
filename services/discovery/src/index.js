'use strict';

/**
 * Discovery service — search.
 *
 *   GET /v1/search?from=NDLS&to=HWH&date=2026-09-21&class=3A&onlyAvailable=true
 *
 * Answers "which trains go where I want, when, and roughly how full are they?"
 * Every answer is DISCOVERY DATA. It carries `as_of` and `authoritative: false`,
 * and nothing on the booking path reads from here: reserve re-validates against
 * the inventory engine. A stale search result can cost a user one retry; it
 * cannot sell a seat twice.
 *
 * Caching, from fastest to slowest:
 *
 *   L1  in-process map, ~1s   — absorbs a single user's keystrokes
 *   L2  Redis, ~5s            — shared across replicas
 *   Elasticsearch / PostgreSQL projection
 *
 * Cache keys include a VERSION that the projection bumps whenever it refreshes a
 * train. Invalidation is therefore implicit: a refresh changes the version, and
 * every older entry simply stops being addressable. There is no "delete these
 * keys" step to get wrong.
 */

require('@tessera/shared/src/config/env');
require('@tessera/shared/src/observability/tracing');

const crypto = require('node:crypto');
const Redis = require('ioredis');
const { createPool } = require('@tessera/shared/src/db/pool');
const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { createIdempotentHandler } = require('@tessera/shared/src/consumer');
const { startConsumer } = require('@tessera/shared/src/consumer/runner');
const { metrics } = require('@tessera/shared/src/observability/metrics');
const { UnauthorizedError, BadRequestError } = require('@tessera/shared/src/errors');

const { ElasticIndex, searchPostgres } = require('./search-index');
const { Projection } = require('./projection');

const { str, num, secret } = require('@tessera/shared/src/config');
const config = {
     PORT: num('DISCOVERY_PORT', 4006),
     DATABASE_URL: str('DISCOVERY_DATABASE_URL', 'postgresql://tessera:tessera@localhost:5432/discovery'),
     INVENTORY_URL: str('INVENTORY_URL', 'http://localhost:4001'),
     KAFKA_BROKERS: str('KAFKA_BROKERS', ''),
     REDIS_URL: str('REDIS_URL', 'redis://localhost:6379'),
     ELASTICSEARCH_URL: str('ELASTICSEARCH_URL', ''),
     INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),
     L1_TTL_MS: num('DISCOVERY_L1_TTL_MS', 1000),
     L2_TTL_SECONDS: num('DISCOVERY_L2_TTL_SECONDS', 5),
};

const CONSUMER_GROUP = 'discovery-projection-v1';

const logger = createLogger('discovery');
const pool = createPool({ connectionString: config.DATABASE_URL, name: 'discovery', max: 8 });
const index = new ElasticIndex({ url: config.ELASTICSEARCH_URL, logger });

const redis = new Redis(config.REDIS_URL, {
     maxRetriesPerRequest: 1,
     enableOfflineQueue: false,
     retryStrategy: (n) => Math.min(n * 200, 3000),
});
redis.on('error', () => {
     /* L2 is optional; reads fall through when Redis is unavailable */
});

// ── Cache versioning ─────────────────────────────────────────────────────────

let localVersion = 0;
async function currentVersion() {
     try {
          const v = await redis.get('discovery:version');
          return v ?? String(localVersion);
     } catch {
          return String(localVersion);
     }
}
async function bumpVersion() {
     localVersion += 1;
     l1.clear();
     try {
          await redis.incr('discovery:version');
     } catch {
          /* local bump is enough for this replica */
     }
}

const projection = new Projection({
     pool,
     inventoryUrl: config.INVENTORY_URL,
     index,
     logger,
     onRefresh: () => {
          bumpVersion();
     },
});

// ── L1 with single-flight ────────────────────────────────────────────────────

const l1 = new Map();
const inflight = new Map();

async function cachedSearch(query) {
     const version = await currentVersion();
     const key = `discovery:search:${version}:${crypto.createHash('sha1').update(JSON.stringify(query)).digest('hex')}`;

     const local = l1.get(key);
     if (local && local.expires > Date.now()) {
          metrics.cacheRequests.inc({ cache: 'discovery-l1', result: 'hit' });
          return { ...local.value, cache: 'L1' };
     }
     metrics.cacheRequests.inc({ cache: 'discovery-l1', result: 'miss' });

     try {
          const shared = await redis.get(key);
          if (shared) {
               metrics.cacheRequests.inc({ cache: 'discovery-l2', result: 'hit' });
               const value = JSON.parse(shared);
               l1.set(key, { value, expires: Date.now() + config.L1_TTL_MS });
               return { ...value, cache: 'L2' };
          }
          metrics.cacheRequests.inc({ cache: 'discovery-l2', result: 'miss' });
     } catch {
          metrics.cacheRequests.inc({ cache: 'discovery-l2', result: 'unavailable' });
     }

     // Single-flight: concurrent identical searches share one backend query.
     if (inflight.has(key)) return { ...(await inflight.get(key)), cache: 'COALESCED' };

     const promise = runSearch(query)
          .then(async (value) => {
               l1.set(key, { value, expires: Date.now() + config.L1_TTL_MS });
               // Jittered TTL, so entries written together do not all expire
               // together and re-create the stampede a moment later.
               const ttl = config.L2_TTL_SECONDS + Math.floor(Math.random() * 3);
               await redis.set(key, JSON.stringify(value), 'EX', ttl).catch(() => {});
               return value;
          })
          .finally(() => inflight.delete(key));
     inflight.set(key, promise);
     return { ...(await promise), cache: 'MISS' };
}

async function runSearch(query) {
     let results;
     let backend;

     if (index.available()) {
          try {
               results = await index.search(query);
               backend = 'elasticsearch';
          } catch (err) {
               logger.warn('elasticsearch search failed; falling back to PostgreSQL', { error: err.message });
          }
     }
     if (!results) {
          results = await searchPostgres(pool, query);
          backend = 'postgres';
     }

     const refreshed = results.map((r) => new Date(r.refreshed_at).getTime()).filter(Boolean);
     const oldest = refreshed.length ? Math.min(...refreshed) : Date.now();
     const ageSeconds = +((Date.now() - oldest) / 1000).toFixed(1);
     metrics.availabilityCacheAge.set({ event_id: 'search' }, ageSeconds);

     return {
          results: results.map(present),
          backend,
          as_of: new Date(oldest).toISOString(),
          ageSeconds,
     };
}

/** Shape a search document for the API: one entry per class, numbers named. */
function present(doc) {
     return {
          eventId: doc.event_id,
          name: doc.name,
          trainNumber: doc.train_number,
          from: { code: doc.from_code, label: doc.from_label, position: doc.from_pos },
          to: { code: doc.to_code, label: doc.to_label, position: doc.to_pos },
          departAt: doc.depart_at,
          arriveAt: doc.arrive_at,
          durationMinutes: doc.duration_minutes,
          totalAvailable: doc.total_available,
          fromFareCents: doc.min_fare,
          classes: (doc.classes ?? []).map((c) => ({
               class: c,
               available: doc[`avail_${c}`],
               total: doc[`total_${c}`],
               fareCents: doc[`fare_${c}`],
               tier: doc[`tier_${c}`] ?? null,
          })),
     };
}

// ── Consumer: inventory events mark trains dirty ────────────────────────────

const handleOnce = createIdempotentHandler({ pool, consumerName: CONSUMER_GROUP, logger });

async function handle(envelope) {
     const eventId = envelope.payload?.event_id ?? envelope.aggregate_id;
     // `projection: true` enables the aggregate_seq guard: an event older than
     // one already applied for this train is discarded rather than applied.
     await handleOnce(
          envelope,
          async (client) => {
               await Projection.markDirty(client, eventId, envelope.event_type);
          },
          { projection: true }
     );
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const app = createApp({
     name: 'discovery',
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
          // Elasticsearch and Redis are accelerators. Losing either degrades
          // search; it does not take this instance out of rotation.
          { name: 'elasticsearch', critical: false, check: async () => index.healthy || (await index.init()) },
          { name: 'redis', critical: false, check: async () => (await redis.ping()) === 'PONG' },
     ],
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

app.get(
     '/v1/search',
     asyncHandler(async (req, res) => {
          const q = req.query;
          if (q.date && !DATE.test(q.date)) throw new BadRequestError('date must be YYYY-MM-DD');

          const query = {
               from: q.from?.trim() || undefined,
               to: q.to?.trim() || undefined,
               date: q.date || undefined,
               class: q.class?.toUpperCase() || undefined,
               train: q.train?.trim() || undefined,
               departAfter: q.departAfter || undefined,
               departBefore: q.departBefore || undefined,
               arriveAfter: q.arriveAfter || undefined,
               arriveBefore: q.arriveBefore || undefined,
               minFareCents: q.minFare != null ? Math.round(Number(q.minFare) * 100) : undefined,
               maxFareCents: q.maxFare != null ? Math.round(Number(q.maxFare) * 100) : undefined,
               onlyAvailable: q.onlyAvailable === 'true',
          };

          const result = await cachedSearch(query);
          res.set('x-cache', result.cache);
          res.json({
               data: result.results,
               backend: result.backend,
               cache: result.cache,
               as_of: result.as_of,
               ageSeconds: result.ageSeconds,
               authoritative: false,
          });
     })
);

/** Stations known to the projection, for autocomplete. */
app.get(
     '/v1/stations',
     asyncHandler(async (req, res) => {
          const prefix = req.query.q?.trim();
          const { rows } = prefix
               ? await pool.query(
                      `SELECT DISTINCT code, label FROM trip_stops
                        WHERE code ILIKE $1 OR label ILIKE $2 OR similarity(label, $3) > 0.3
                        ORDER BY label LIMIT 10`,
                      [`${prefix}%`, `%${prefix}%`, prefix]
                 )
               : await pool.query(`SELECT DISTINCT code, label FROM trip_stops ORDER BY label LIMIT 50`);
          res.json({ data: rows });
     })
);

app.get(
     '/v1/status',
     asyncHandler(async (_req, res) => {
          const [staleness, counts] = await Promise.all([
               projection.staleness(),
               pool.query(`SELECT (SELECT count(*) FROM trips)::int AS trips,
                                  (SELECT count(*) FROM trip_segments)::int AS segments,
                                  (SELECT count(*) FROM processed_events WHERE consumer = $1)::int AS events`,
                          [CONSUMER_GROUP]),
          ]);
          res.json({
               data: {
                    backend: index.healthy ? 'elasticsearch' : 'postgres',
                    trips: counts.rows[0].trips,
                    segments: counts.rows[0].segments,
                    eventsConsumed: counts.rows[0].events,
                    staleness,
                    lag: consumerHandle ? await consumerHandle.lag().catch(() => null) : null,
                    cacheVersion: await currentVersion(),
               },
          });
     })
);

app.post(
     '/admin/rebuild',
     asyncHandler(async (req, res) => {
          if (req.get('x-internal-token') !== config.INTERNAL_TOKEN) {
               throw new UnauthorizedError('Invalid or missing internal service token');
          }
          const queued = await projection.resync();
          res.json({ data: { queued } });
     })
);

app.use(errorMiddleware(logger));

let consumerHandle = null;

async function main() {
     await pool.query('SELECT 1');
     await index.init();
     projection.start({ tickMs: 1000, resyncMs: 60_000 });

     if (config.KAFKA_BROKERS) {
          consumerHandle = await startConsumer({
               clientId: 'discovery',
               groupId: CONSUMER_GROUP,
               topics: ['inventory.events'],
               brokers: config.KAFKA_BROKERS,
               pool,
               handle,
               logger,
          }).catch((err) => {
               logger.error('consumer failed to start; projection will rely on resync', { error: err.message });
               return null;
          });
     }

     listen({
          app,
          port: config.PORT,
          name: 'discovery',
          logger,
          workers: [
               { name: 'projection', stop: () => projection.stop() },
               { name: 'consumer', stop: () => consumerHandle?.stop() ?? Promise.resolve() },
          ],
          resources: [
               { name: 'redis', close: () => redis.quit().catch(() => {}) },
               { name: 'postgres', close: () => pool.end() },
          ],
     });
}

main().catch((err) => {
     logger.error('failed to start', { error: err.message, stack: err.stack });
     process.exit(1);
});
