'use strict';

/**
 * Search backends.
 *
 * Elasticsearch is the primary: it gives typo-tolerant station matching and
 * combined filtering across date, time windows, class, availability and fare in
 * one query. PostgreSQL is the fallback, over the same projection, using trigram
 * similarity for fuzzy station names.
 *
 * Search degrades rather than fails. If Elasticsearch is down the service keeps
 * answering from PostgreSQL and says so in the response (`backend`), which is
 * the same stance the system takes on Redis: losing an accelerator costs
 * quality, never correctness.
 *
 * The ES client is plain HTTP rather than a library, because the handful of
 * endpoints used here are clearer read as requests than as SDK calls.
 */

const INDEX = 'tessera-trips';

class ElasticIndex {
     constructor({ url, logger }) {
          this.url = url?.replace(/\/$/, '');
          this.logger = logger;
          this.healthy = false;
          // Circuit breaker. After a failure Elasticsearch is skipped until
          // `retryAt`, then tried again. Without this, one timeout against a
          // cold cluster marked it unhealthy forever and search stayed on the
          // PostgreSQL fallback for the life of the process.
          this.retryAt = 0;
     }

     available() {
          return !!this.url && (this.healthy || Date.now() >= this.retryAt);
     }

     trip(err) {
          this.healthy = false;
          this.retryAt = Date.now() + 10_000;
          this.logger.warn('elasticsearch unavailable; using PostgreSQL for 10s', { error: err.message });
     }

     async #req(method, path, body) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          try {
               const res = await fetch(`${this.url}${path}`, {
                    method,
                    signal: controller.signal,
                    headers: { 'content-type': body && typeof body === 'string' ? 'application/x-ndjson' : 'application/json' },
                    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
               });
               const json = await res.json().catch(() => null);
               if (!res.ok && res.status !== 404) {
                    throw new Error(`elasticsearch ${method} ${path} -> ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
               }
               return { status: res.status, json };
          } finally {
               clearTimeout(timer);
          }
     }

     async init() {
          if (!this.url) return false;
          try {
               const { status } = await this.#req('HEAD', `/${INDEX}`).catch(() => ({ status: 0 }));
               if (status === 404 || status === 0) {
                    await this.#req('PUT', `/${INDEX}`, {
                         settings: { number_of_shards: 1, number_of_replicas: 0 },
                         mappings: {
                              // Per-class fields (avail_SL, fare_3A, ...) are
                              // numeric and created dynamically.
                              dynamic_templates: [
                                   {
                                        numbers: {
                                             match_pattern: 'regex',
                                             match: '^(avail|total|fare)_.*',
                                             mapping: { type: 'integer' },
                                        },
                                   },
                              ],
                              properties: {
                                   event_id: { type: 'keyword' },
                                   name: { type: 'text' },
                                   train_number: { type: 'keyword' },
                                   train_name: { type: 'text' },
                                   from_code: { type: 'keyword' },
                                   from_label: { type: 'text' },
                                   from_pos: { type: 'integer' },
                                   to_code: { type: 'keyword' },
                                   to_label: { type: 'text' },
                                   to_pos: { type: 'integer' },
                                   depart_at: { type: 'date' },
                                   arrive_at: { type: 'date' },
                                   travel_date: { type: 'keyword' },
                                   duration_minutes: { type: 'integer' },
                                   total_available: { type: 'integer' },
                                   min_fare: { type: 'integer' },
                                   classes: { type: 'keyword' },
                                   refreshed_at: { type: 'date' },
                              },
                         },
                    });
                    this.logger.info('elasticsearch index created', { index: INDEX });
               }
               this.healthy = true;
               return true;
          } catch (err) {
               this.healthy = false;
               this.logger.warn('elasticsearch unavailable; search will use PostgreSQL', { error: err.message });
               return false;
          }
     }

     /** Replace every document for one event. */
     async indexTrip(docs, eventId) {
          if (!this.url) return;
          try {
               await this.#req('POST', `/${INDEX}/_delete_by_query?refresh=false`, {
                    query: { term: { event_id: eventId } },
               });
               if (docs.length === 0) return;
               const ndjson =
                    docs.map((d) => `${JSON.stringify({ index: { _index: INDEX, _id: d.id } })}\n${JSON.stringify(d)}`).join('\n') +
                    '\n';
               // No refresh=true per write: forcing a refresh on every update is
               // what made the previous search service expensive under load.
               // The index's own refresh interval (1s) is plenty for discovery.
               await this.#req('POST', '/_bulk', ndjson);
               this.healthy = true;
          } catch (err) {
               this.healthy = false;
               this.logger.warn('elasticsearch indexing failed; PostgreSQL remains current', { error: err.message });
          }
     }

     async search(q) {
          const must = [];
          const filter = [];

          if (q.from) must.push(stationClause('from', q.from));
          if (q.to) must.push(stationClause('to', q.to));
          if (q.train) must.push({ multi_match: { query: q.train, fields: ['name', 'train_name', 'train_number'], fuzziness: 'AUTO' } });
          if (q.date) filter.push({ term: { travel_date: q.date } });
          if (q.departAfter || q.departBefore) {
               filter.push({ range: { depart_at: { ...(q.departAfter && { gte: q.departAfter }), ...(q.departBefore && { lte: q.departBefore }) } } });
          }
          if (q.arriveBefore || q.arriveAfter) {
               filter.push({ range: { arrive_at: { ...(q.arriveAfter && { gte: q.arriveAfter }), ...(q.arriveBefore && { lte: q.arriveBefore }) } } });
          }
          const fareField = q.class ? `fare_${q.class}` : 'min_fare';
          if (q.minFareCents != null || q.maxFareCents != null) {
               filter.push({ range: { [fareField]: { ...(q.minFareCents != null && { gte: q.minFareCents }), ...(q.maxFareCents != null && { lte: q.maxFareCents }) } } });
          }
          if (q.class) filter.push({ term: { classes: q.class } });
          if (q.onlyAvailable) filter.push({ range: { [q.class ? `avail_${q.class}` : 'total_available']: { gt: 0 } } });

          try {
               const { json } = await this.#req('POST', `/${INDEX}/_search`, {
                    size: 50,
                    query: { bool: { must, filter } },
                    sort: [{ depart_at: 'asc' }],
               });
               this.healthy = true;
               return (json?.hits?.hits ?? []).map((h) => h._source);
          } catch (err) {
               this.trip(err);
               throw err;
          }
     }
}

/**
 * Station matching: exact code first, then typo-tolerant name.
 * "HWH", "howrah" and "howra" all find Howrah Junction.
 */
function stationClause(side, input) {
     return {
          bool: {
               should: [
                    { term: { [`${side}_code`]: { value: String(input).toUpperCase(), boost: 5 } } },
                    { match: { [`${side}_label`]: { query: input, fuzziness: 'AUTO', prefix_length: 1 } } },
               ],
               minimum_should_match: 1,
          },
     };
}

/**
 * The same search over the PostgreSQL projection. Slower and less forgiving of
 * typos than Elasticsearch, but always available while the database is.
 */
async function searchPostgres(db, q) {
     const params = [];
     const p = (v) => {
          params.push(v);
          return `$${params.length}`;
     };

     const stationMatch = (alias, input) =>
          // word_similarity, not similarity: "kanpr" scores 0.24 against the
          // whole string "Kanpur Central" but 0.67 against its best word.
          `(${alias}.code = upper(${p(input)}) OR word_similarity(${p(input)}, ${alias}.label) > 0.5)`;

     const where = ['s.span_from < s.span_to'];
     if (q.from) where.push(stationMatch('fs', q.from));
     if (q.to) where.push(stationMatch('ts', q.to));
     if (q.date) where.push(`to_char(t.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ${p(q.date)}`);
     if (q.train) where.push(`(t.name ILIKE ${p(`%${q.train}%`)} OR t.train_number = ${p(q.train)})`);
     if (q.class) where.push(`s.class = ${p(q.class)}`);
     if (q.onlyAvailable) where.push('s.available > 0');
     if (q.minFareCents != null) where.push(`s.fare_cents >= ${p(q.minFareCents)}`);
     if (q.maxFareCents != null) where.push(`s.fare_cents <= ${p(q.maxFareCents)}`);

     const { rows } = await db.query(
          `SELECT t.event_id, t.name, t.train_number, t.train_name, t.starts_at,
                  fs.code AS from_code, fs.label AS from_label, fs.position AS from_pos, fs.offset_minutes AS from_offset,
                  ts.code AS to_code, ts.label AS to_label, ts.position AS to_pos, ts.offset_minutes AS to_offset,
                  s.class, s.available, s.total, s.fare_cents, s.tier, s.refreshed_at
             FROM trip_segments s
             JOIN trips t ON t.event_id = s.event_id
             JOIN trip_stops fs ON fs.event_id = s.event_id AND fs.position = s.span_from
             JOIN trip_stops ts ON ts.event_id = s.event_id AND ts.position = s.span_to
            WHERE ${where.join(' AND ')}
            ORDER BY t.starts_at, s.span_from, s.span_to, s.class
            LIMIT 400`,
          params
     );

     // Fold per-class rows into one result per (trip, from, to), matching the
     // shape Elasticsearch returns.
     const grouped = new Map();
     for (const r of rows) {
          const key = `${r.event_id}:${r.from_pos}:${r.to_pos}`;
          if (!grouped.has(key)) {
               const departAt = new Date(new Date(r.starts_at).getTime() + r.from_offset * 60_000);
               const arriveAt = new Date(new Date(r.starts_at).getTime() + r.to_offset * 60_000);
               grouped.set(key, {
                    id: key,
                    event_id: r.event_id,
                    name: r.name,
                    train_number: r.train_number,
                    train_name: r.train_name,
                    from_code: r.from_code,
                    from_label: r.from_label,
                    from_pos: r.from_pos,
                    to_code: r.to_code,
                    to_label: r.to_label,
                    to_pos: r.to_pos,
                    depart_at: departAt.toISOString(),
                    arrive_at: arriveAt.toISOString(),
                    duration_minutes: r.to_offset - r.from_offset,
                    classes: [],
                    total_available: 0,
                    min_fare: null,
                    refreshed_at: r.refreshed_at,
               });
          }
          const doc = grouped.get(key);
          doc.classes.push(r.class);
          doc[`avail_${r.class}`] = r.available;
          doc[`total_${r.class}`] = r.total;
          doc[`fare_${r.class}`] = Number(r.fare_cents);
          doc[`tier_${r.class}`] = r.tier;
          doc.total_available += r.available;
          doc.min_fare = doc.min_fare == null ? Number(r.fare_cents) : Math.min(doc.min_fare, Number(r.fare_cents));
     }

     let docs = [...grouped.values()];
     if (q.departAfter) docs = docs.filter((d) => d.depart_at >= q.departAfter);
     if (q.departBefore) docs = docs.filter((d) => d.depart_at <= q.departBefore);
     if (q.arriveAfter) docs = docs.filter((d) => d.arrive_at >= q.arriveAfter);
     if (q.arriveBefore) docs = docs.filter((d) => d.arrive_at <= q.arriveBefore);
     return docs.slice(0, 50);
}

module.exports = { ElasticIndex, searchPostgres, INDEX };
