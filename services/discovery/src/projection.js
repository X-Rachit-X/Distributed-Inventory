'use strict';

/**
 * Projection refresher.
 *
 * Turns "event X changed" into an up-to-date search model for X, by re-reading
 * authoritative availability from the inventory engine.
 *
 * Refreshes are COALESCED. During a flash sale one popular train can emit
 * hundreds of inventory events a second; refreshing on each would multiply
 * that load onto inventory for no benefit, because only the latest state
 * matters to a searcher. Events mark a train dirty; the refresher picks each
 * dirty train up at most once per tick and reads its current state once.
 *
 * Claiming uses SKIP LOCKED, so several discovery replicas share the work
 * without refreshing the same train twice.
 */

const { fare } = require('@tessera/shared/src/pricing');
const { metrics } = require('@tessera/shared/src/observability/metrics');

// Seeded routes carry no timetable, so stop times are derived: 150 minutes per
// stop. A real deployment reads the timetable from the catalogue.
const DEFAULT_MINUTES_PER_STOP = 150;
const MAX_REFRESH_ATTEMPTS = 5;

class Projection {
     constructor({ pool, inventoryUrl, index, logger, onRefresh }) {
          this.pool = pool;
          this.inventoryUrl = inventoryUrl.replace(/\/$/, '');
          this.index = index;
          this.logger = logger;
          this.onRefresh = onRefresh;
          this.timer = null;
          this.resyncTimer = null;
     }

     async #get(path) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
               const res = await fetch(`${this.inventoryUrl}${path}`, { signal: controller.signal });
               if (res.status === 404) {
                    const err = new Error(`inventory ${path} -> 404`);
                    err.notFound = true;
                    throw err;
               }
               if (!res.ok) throw new Error(`inventory ${path} -> ${res.status}`);
               return (await res.json()).data;
          } finally {
               clearTimeout(timer);
          }
     }

     /** Mark a train dirty. Called inside the consumer's dedupe transaction. */
     static async markDirty(client, eventId, reason) {
          await client.query(
               `INSERT INTO dirty_events (event_id, reason) VALUES ($1, $2)
                ON CONFLICT (event_id) DO UPDATE SET marked_at = now(), reason = EXCLUDED.reason`,
               [eventId, reason]
          );
     }

     /** Rebuild one train's rows here and in the search index. */
     async refresh(eventId) {
          let segmentData;
          let stops;
          let events;
          try {
               [segmentData, stops, events] = await Promise.all([
                    this.#get(`/v1/events/${eventId}/segment-availability`),
                    this.#get(`/v1/events/${eventId}/span-points`),
                    this.#get(`/v1/events`),
               ]);
          } catch (err) {
               if (err.notFound) {
                    // The train no longer exists in inventory. That is a definite
                    // answer, not a transient failure: remove it from search.
                    await this.pool.query(`DELETE FROM trips WHERE event_id = $1`, [eventId]);
                    await this.index.indexTrip([], eventId);
                    return { removed: true };
               }
               throw err;
          }
          const event = events.find((e) => e.eventId === eventId);
          if (!event) {
               // Cancelled or closed: remove it from search entirely.
               await this.pool.query(`DELETE FROM trips WHERE event_id = $1`, [eventId]);
               await this.index.indexTrip([], eventId);
               return { removed: true };
          }

          const trainNumber = event.metadata?.trainNumber ?? null;
          const trainName = event.metadata?.trainName ?? null;

          // Price every segment with the SAME rules the pricing service uses,
          // so "from ₹X" in search matches the fare at checkout.
          const priced = segmentData.segments.map((s) => {
               const f = fare({
                    basePriceCents: s.minBaseCents,
                    spanFrom: s.spanFrom,
                    spanTo: s.spanTo,
                    spanMax: segmentData.spanMax,
                    classAvailable: s.available,
                    classTotal: s.total,
               });
               return { ...s, fareCents: f.fareCents, tier: f.tier.code };
          });

          const stopRows = stops.map((sp) => ({
               position: sp.position,
               code: sp.code ?? sp.ref,
               label: sp.label,
               offset: sp.metadata?.offsetMinutes ?? sp.position * DEFAULT_MINUTES_PER_STOP,
          }));

          await this.pool.withTransaction(async (client) => {
               await client.query(
                    `INSERT INTO trips (event_id, external_ref, name, train_number, train_name, starts_at, span_max, refreshed_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
                     ON CONFLICT (event_id) DO UPDATE
                          SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at,
                              span_max = EXCLUDED.span_max, refreshed_at = now()`,
                    [eventId, event.externalRef, event.name, trainNumber, trainName, event.startsAt, event.spanMax]
               );

               await client.query(`DELETE FROM trip_stops WHERE event_id = $1`, [eventId]);
               for (const s of stopRows) {
                    await client.query(
                         `INSERT INTO trip_stops (event_id, position, code, label, offset_minutes) VALUES ($1, $2, $3, $4, $5)`,
                         [eventId, s.position, s.code, s.label, s.offset]
                    );
               }

               await client.query(`DELETE FROM trip_segments WHERE event_id = $1`, [eventId]);
               if (priced.length > 0) {
                    const values = [];
                    const params = [eventId];
                    let i = 2;
                    for (const s of priced) {
                         values.push(`($1, $${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, now())`);
                         params.push(s.spanFrom, s.spanTo, s.class, s.available, s.total, s.fareCents, s.tier);
                         i += 7;
                    }
                    await client.query(
                         `INSERT INTO trip_segments
                                 (event_id, span_from, span_to, class, available, total, fare_cents, tier, refreshed_at)
                          VALUES ${values.join(', ')}`,
                         params
                    );
               }
          });

          // One search document per (from, to) pair, classes flattened in.
          const byPair = new Map();
          for (const s of priced) {
               const key = `${s.spanFrom}:${s.spanTo}`;
               if (!byPair.has(key)) byPair.set(key, []);
               byPair.get(key).push(s);
          }
          const startsMs = new Date(event.startsAt).getTime();
          const stopAt = new Map(stopRows.map((s) => [s.position, s]));
          const refreshedAt = new Date().toISOString();

          const docs = [];
          for (const [key, segs] of byPair) {
               const [from, to] = key.split(':').map(Number);
               const fs = stopAt.get(from);
               const ts = stopAt.get(to);
               if (!fs || !ts) continue;
               const departAt = new Date(startsMs + fs.offset * 60_000);
               const doc = {
                    id: `${eventId}:${from}:${to}`,
                    event_id: eventId,
                    name: event.name,
                    train_number: trainNumber,
                    train_name: trainName,
                    from_code: fs.code,
                    from_label: fs.label,
                    from_pos: from,
                    to_code: ts.code,
                    to_label: ts.label,
                    to_pos: to,
                    depart_at: departAt.toISOString(),
                    arrive_at: new Date(startsMs + ts.offset * 60_000).toISOString(),
                    travel_date: departAt.toISOString().slice(0, 10),
                    duration_minutes: ts.offset - fs.offset,
                    classes: segs.map((s) => s.class),
                    total_available: segs.reduce((n, s) => n + s.available, 0),
                    min_fare: Math.min(...segs.map((s) => s.fareCents)),
                    refreshed_at: refreshedAt,
               };
               for (const s of segs) {
                    doc[`avail_${s.class}`] = s.available;
                    doc[`total_${s.class}`] = s.total;
                    doc[`fare_${s.class}`] = s.fareCents;
                    doc[`tier_${s.class}`] = s.tier;
               }
               docs.push(doc);
          }
          await this.index.indexTrip(docs, eventId);

          this.onRefresh?.(eventId);
          return { segments: priced.length, documents: docs.length };
     }

     /** Process dirty trains. Coalesced, crash-safe, safe across replicas. */
     async tick() {
          return this.pool.withTransaction(async (client) => {
               const { rows } = await client.query(
                    `SELECT event_id, attempts FROM dirty_events
                      ORDER BY marked_at
                        FOR UPDATE SKIP LOCKED
                      LIMIT 10`
               );
               for (const { event_id: eventId, attempts } of rows) {
                    try {
                         await this.refresh(eventId);
                         // Deleted only after a successful refresh, in the same
                         // transaction that claimed it: a failed refresh leaves
                         // the train dirty for the next tick.
                         await client.query(`DELETE FROM dirty_events WHERE event_id = $1`, [eventId]);
                    } catch (err) {
                         if (attempts + 1 >= MAX_REFRESH_ATTEMPTS) {
                              // Poison: drop it. Resync re-marks the train if it
                              // still exists, so nothing is lost for good.
                              await client.query(`DELETE FROM dirty_events WHERE event_id = $1`, [eventId]);
                              this.logger.error('projection refresh abandoned', { eventId, error: err.message });
                              continue;
                         }
                         // Back of the queue, so one failing train cannot starve the rest.
                         await client.query(
                              `UPDATE dirty_events SET attempts = attempts + 1, marked_at = now(), last_error = $2
                                WHERE event_id = $1`,
                              [eventId, String(err.message).slice(0, 500)]
                         );
                         this.logger.warn('projection refresh failed; requeued', { eventId, error: err.message });
                    }
               }
               return rows.length;
          });
     }

     /**
      * Full resync. Picks up trains that never produced an event (bulk-seeded
      * inventory) and heals anything a lost event left behind.
      */
     async resync() {
          const events = await this.#get('/v1/events');
          for (const e of events) {
               await this.pool.query(
                    `INSERT INTO dirty_events (event_id, reason) VALUES ($1, 'resync') ON CONFLICT DO NOTHING`,
                    [e.eventId]
               );
          }
          // Trains that disappeared from inventory disappear from search.
          const ids = events.map((e) => e.eventId);
          const { rows: gone } = await this.pool.query(
               `SELECT event_id FROM trips WHERE NOT (event_id = ANY($1::uuid[]))`,
               [ids]
          );
          for (const g of gone) {
               await this.pool.query(`DELETE FROM trips WHERE event_id = $1`, [g.event_id]);
               await this.index.indexTrip([], g.event_id);
          }
          return events.length;
     }

     start({ tickMs = 1000, resyncMs = 60_000 } = {}) {
          const loop = async () => {
               try {
                    await this.tick();
               } catch (err) {
                    this.logger.error('projection tick failed', { error: err.message });
               }
               this.timer = setTimeout(loop, tickMs);
               this.timer.unref?.();
          };
          loop();

          const resync = () =>
               this.resync().catch((err) => this.logger.warn('resync failed', { error: err.message }));
          resync();
          this.resyncTimer = setInterval(resync, resyncMs);
          this.resyncTimer.unref?.();
     }

     stop() {
          if (this.timer) clearTimeout(this.timer);
          if (this.resyncTimer) clearInterval(this.resyncTimer);
     }

     /** Age of the oldest row in the projection — the staleness a searcher might see. */
     async staleness() {
          const { rows } = await this.pool.query(
               `SELECT extract(epoch FROM (now() - min(refreshed_at)))::float AS oldest,
                       extract(epoch FROM (now() - max(refreshed_at)))::float AS newest,
                       (SELECT count(*)::int FROM dirty_events) AS pending
                  FROM trips`
          );
          const r = rows[0];
          metrics.availabilityCacheAge.set({ event_id: 'all' }, r.oldest ?? 0);
          return { oldestSeconds: r.oldest, newestSeconds: r.newest, pendingRefreshes: r.pending };
     }
}

module.exports = { Projection };
