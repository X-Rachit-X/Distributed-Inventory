'use strict';

/**
 * Availability reads.
 *
 * These answer "what looks free right now?" for browsing users. They are
 * DISCOVERY DATA, not authority, and the distinction is load-bearing:
 *
 *   - a read is a snapshot taken without locks, so it may be stale by the time
 *     the user clicks;
 *   - `reserve` re-validates everything inside its own transaction against the
 *     exclusion constraint.
 *
 * So a stale read costs a user one retry and a 409. It can never cause an
 * oversell. That is what makes it safe to cache these aggressively while
 * refusing to cache anything on the write path.
 *
 * Expiry is applied in the QUERY rather than by waiting for a sweeper, so a
 * hold that lapsed a second ago already reads as available. Otherwise
 * availability would lag the truth by up to one sweep interval and users would
 * see seats as taken that anyone could actually book.
 */

const { NotFoundError } = require('@tessera/shared/src/errors');

/**
 * Aggregate counts for one event.
 *
 * @param {number} [opts.spanFrom] Restrict to a sub-range: a passenger travelling
 *   stops 2→5 cares only about seats free across that stretch, not about seats
 *   free for the whole line.
 */
async function getAvailability(db, eventId, opts = {}) {
     const { rows: eventRows } = await db.query(
          `SELECT id, external_ref, domain, name, starts_at, span_kind, span_max, state
             FROM inventory_events WHERE id::text = $1 OR external_ref = $1`,
          [eventId]
     );
     if (eventRows.length === 0) throw new NotFoundError(`Event ${eventId} not found`);
     const event = eventRows[0];

     const spanFrom = opts.spanFrom ?? 0;
     const spanTo = opts.spanTo ?? event.span_max;

     const { rows } = await db.query(
          `WITH occupied AS (
                SELECT DISTINCT a.resource_id
                  FROM allocations a
                 WHERE a.event_id = $1
                   AND a.state IN ('HELD','CONFIRMED','BLOCKED')
                   -- An expired hold occupies nothing, even before the sweeper
                   -- has reached it.
                   AND (a.state <> 'HELD' OR a.expires_at > now())
                   AND a.span && int4range($2, $3)
           )
           SELECT r.class,
                  count(*)::int AS total,
                  count(*) FILTER (WHERE o.resource_id IS NULL)::int AS available,
                  min(r.base_price_cents) FILTER (WHERE o.resource_id IS NULL) AS from_price_cents
             FROM inventory_resources r
             LEFT JOIN occupied o ON o.resource_id = r.id
            WHERE r.event_id = $1 AND r.state = 'ENABLED'
            GROUP BY r.class
            ORDER BY r.class`,
          [event.id, spanFrom, spanTo]
     );

     const { rows: poolRows } = await db.query(
          `SELECT p.code, p.capacity,
                  (p.capacity - COALESCE(sum(b.held + b.confirmed), 0))::int AS available,
                  p.price_cents
             FROM inventory_pools p
             LEFT JOIN pool_buckets b ON b.pool_id = p.id
            WHERE p.event_id = $1
            GROUP BY p.id
            ORDER BY p.code`,
          [event.id]
     );

     const totals = rows.reduce(
          (acc, r) => ({ total: acc.total + r.total, available: acc.available + r.available }),
          { total: 0, available: 0 }
     );

     return {
          eventId: event.id,
          externalRef: event.external_ref,
          name: event.name,
          domain: event.domain,
          startsAt: event.starts_at,
          state: event.state,
          span: { from: spanFrom, to: spanTo, max: event.span_max, kind: event.span_kind },
          totals,
          byClass: rows.map((r) => ({
               class: r.class,
               total: r.total,
               available: r.available,
               fromPriceCents: r.from_price_cents == null ? null : Number(r.from_price_cents),
          })),
          pools: poolRows.map((p) => ({
               code: p.code,
               capacity: p.capacity,
               available: p.available,
               priceCents: Number(p.price_cents),
          })),
     };
}

/**
 * Per-resource status, for a seat map.
 *
 * Returns every resource with a status for the REQUESTED span, which is why a
 * seat can read AVAILABLE for stops 2→5 while being sold for 0→2.
 */
async function getResources(db, eventId, opts = {}) {
     const { rows: eventRows } = await db.query(
          `SELECT id, span_max FROM inventory_events WHERE id::text = $1 OR external_ref = $1`,
          [eventId]
     );
     if (eventRows.length === 0) throw new NotFoundError(`Event ${eventId} not found`);
     const event = eventRows[0];

     const spanFrom = opts.spanFrom ?? 0;
     const spanTo = opts.spanTo ?? event.span_max;

     const { rows } = await db.query(
          `SELECT r.id, r.code, r.class, r.row_idx, r.col_idx, r.base_price_cents,
                  g.code AS group_code, g.kind AS group_kind,
                  CASE
                       WHEN r.state = 'RETIRED' THEN 'RETIRED'
                       WHEN bool_or(a.state = 'BLOCKED')   THEN 'BLOCKED'
                       WHEN bool_or(a.state = 'CONFIRMED') THEN 'SOLD'
                       WHEN bool_or(a.state = 'HELD')      THEN 'HELD'
                       ELSE 'AVAILABLE'
                  END AS status
             FROM inventory_resources r
             LEFT JOIN resource_groups g ON g.id = r.group_id
             LEFT JOIN allocations a
                    ON a.resource_id = r.id
                   AND a.state IN ('HELD','CONFIRMED','BLOCKED')
                   AND (a.state <> 'HELD' OR a.expires_at > now())
                   AND a.span && int4range($2, $3)
            WHERE r.event_id = $1
            GROUP BY r.id, g.code, g.kind
            ORDER BY g.code NULLS FIRST, r.row_idx NULLS FIRST, r.col_idx NULLS FIRST, r.code`,
          [event.id, spanFrom, spanTo]
     );

     const filtered = opts.class ? rows.filter((r) => r.class === opts.class) : rows;

     return {
          eventId: event.id,
          span: { from: spanFrom, to: spanTo },
          resources: filtered.map((r) => ({
               resourceId: r.id,
               code: r.code,
               class: r.class,
               group: r.group_code,
               row: r.row_idx,
               col: r.col_idx,
               priceCents: Number(r.base_price_cents),
               status: r.status,
          })),
     };
}

/**
 * Find N adjacent resources — "two seats together".
 *
 * Adjacency is same group, same row, consecutive columns. The query returns
 * candidate groups ordered by position so the allocator can try them in turn;
 * it does NOT reserve them, because availability discovered here can still be
 * taken by someone else before the reserve transaction runs. The caller treats
 * this as a ranked list of candidates and lets the constraint arbitrate.
 */
async function findAdjacent(db, eventId, { count = 2, spanFrom = 0, spanTo = null, resourceClass = null } = {}) {
     const { rows: eventRows } = await db.query(
          `SELECT id, span_max FROM inventory_events WHERE id::text = $1 OR external_ref = $1`,
          [eventId]
     );
     if (eventRows.length === 0) throw new NotFoundError(`Event ${eventId} not found`);
     const event = eventRows[0];
     const upper = spanTo ?? event.span_max;

     const { rows } = await db.query(
          `WITH free AS (
                SELECT r.id, r.code, r.group_id, r.row_idx, r.col_idx, r.base_price_cents
                  FROM inventory_resources r
                 WHERE r.event_id = $1
                   AND r.state = 'ENABLED'
                   AND ($4::text IS NULL OR r.class = $4)
                   AND NOT EXISTS (
                        SELECT 1 FROM allocations a
                         WHERE a.resource_id = r.id
                           AND a.state IN ('HELD','CONFIRMED','BLOCKED')
                           AND (a.state <> 'HELD' OR a.expires_at > now())
                           AND a.span && int4range($2, $3)
                   )
           ), numbered AS (
                -- Consecutive columns form a run when (col_idx - row_number)
                -- is constant: the classic gaps-and-islands technique.
                SELECT *, col_idx - row_number() OVER (PARTITION BY group_id, row_idx ORDER BY col_idx) AS run
                  FROM free
                 WHERE col_idx IS NOT NULL
           )
           SELECT group_id, row_idx,
                  array_agg(id ORDER BY col_idx) AS resource_ids,
                  array_agg(code ORDER BY col_idx) AS codes,
                  sum(base_price_cents) AS total_cents
             FROM numbered
            GROUP BY group_id, row_idx, run
           HAVING count(*) >= $5
            ORDER BY row_idx, min(col_idx)
            LIMIT 20`,
          [event.id, spanFrom, upper, resourceClass, count]
     );

     return rows.map((r) => ({
          groupId: r.group_id,
          row: r.row_idx,
          // A run longer than requested is trimmed to exactly what was asked
          // for, so a request for 2 does not consume a block of 4.
          resourceIds: r.resource_ids.slice(0, count),
          codes: r.codes.slice(0, count),
     }));
}

/**
 * Availability for EVERY (from, to) stop pair, per class, in one query.
 *
 * This is what the search read model is built from. A seat is available for a
 * pair only if no live allocation overlaps that exact span, so the answer for
 * Kanpur→Prayagraj genuinely differs from Delhi→Howrah — which a single
 * whole-route count would hide.
 *
 * Cost is pairs × seats (28 × 336 for the seed data), evaluated in one pass
 * with the live allocations pulled once into a CTE. It runs on the discovery
 * side's schedule, never on the booking path.
 */
async function getSegmentAvailability(db, eventId) {
     const { rows: eventRows } = await db.query(
          `SELECT id, span_max FROM inventory_events WHERE id::text = $1 OR external_ref = $1`,
          [eventId]
     );
     if (eventRows.length === 0) throw new NotFoundError(`Event ${eventId} not found`);
     const event = eventRows[0];

     const { rows } = await db.query(
          `WITH pairs AS (
                SELECT f, t
                  FROM generate_series(0, $2 - 1) AS f,
                       generate_series(1, $2) AS t
                 WHERE t > f
           ), live AS (
                SELECT resource_id, span
                  FROM allocations
                 WHERE event_id = $1
                   AND state IN ('HELD','CONFIRMED','BLOCKED')
                   AND (state <> 'HELD' OR expires_at > now())
           )
           SELECT p.f AS span_from, p.t AS span_to, r.class,
                  count(*)::int AS total,
                  count(*) FILTER (WHERE NOT EXISTS (
                       SELECT 1 FROM live l
                        WHERE l.resource_id = r.id AND l.span && int4range(p.f, p.t)
                  ))::int AS available,
                  min(r.base_price_cents) AS min_base_cents
             FROM pairs p
            CROSS JOIN inventory_resources r
            WHERE r.event_id = $1 AND r.state = 'ENABLED'
            GROUP BY p.f, p.t, r.class
            ORDER BY p.f, p.t, r.class`,
          [event.id, event.span_max]
     );

     return {
          eventId: event.id,
          spanMax: event.span_max,
          segments: rows.map((r) => ({
               spanFrom: r.span_from,
               spanTo: r.span_to,
               class: r.class,
               total: r.total,
               available: r.available,
               minBaseCents: Number(r.min_base_cents),
          })),
     };
}

module.exports = { getAvailability, getResources, findAdjacent, getSegmentAvailability };
