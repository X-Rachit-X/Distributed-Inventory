'use strict';

const crypto = require('node:crypto');
const { createPool } = require('@tessera/shared/src/db/pool');

const CONNECTION_STRING =
     process.env.INVENTORY_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/inventory';

function testPool(max = 40) {
     return createPool({
          connectionString: CONNECTION_STRING,
          name: 'test',
          max,
          // Tests deliberately create heavy contention; a short lock timeout
          // would turn legitimate queueing into spurious failures.
          lockTimeoutMs: 20_000,
          statementTimeoutMs: 30_000,
          connectionTimeoutMillis: 20_000,
     });
}

/**
 * Create an isolated inventory event with `resourceCount` resources.
 * Every test gets its own event, so tests never contend with each other and can
 * run against a database that already holds data from previous runs.
 */
async function seedEvent(pool, { resourceCount = 1, spanMax = 2, domain = 'RAIL', prefix = 'T' } = {}) {
     const externalRef = `test-${crypto.randomUUID()}`;
     const { rows } = await pool.query(
          `INSERT INTO inventory_events (external_ref, domain, name, starts_at, span_kind, span_max)
           VALUES ($1, $2, 'Test Event', now() + interval '1 day', $3, $4)
           RETURNING id`,
          [externalRef, domain, domain === 'RAIL' ? 'SEGMENT' : 'WHOLE', spanMax]
     );
     const eventId = rows[0].id;

     const codes = Array.from({ length: resourceCount }, (_, i) => `${prefix}${i + 1}`);
     const values = codes.map((_, i) => `($1, $${i + 2}, 'STANDARD', 1000)`).join(', ');
     const { rows: resources } = await pool.query(
          `INSERT INTO inventory_resources (event_id, code, class, base_price_cents)
           VALUES ${values}
           RETURNING id, code`,
          [eventId, ...codes]
     );

     // Opening balance. Without it the ledger has no starting point and every
     // allocated resource reports drift.
     await pool.query(
          `INSERT INTO inventory_ledger (event_id, resource_id, entry_type, delta, actor, reason)
           SELECT $1, unnest($2::uuid[]), 'CAPACITY_ADDED', 1, 'test:seed', 'resource created'`,
          [eventId, resources.map((r) => r.id)]
     );

     return { eventId, resources, resourceIds: resources.map((r) => r.id) };
}

/**
 * Check invariants.
 *
 * Pass an `eventId` to scope the check to one event's inventory. A test must
 * assert on what it caused: a global check fails when an unrelated event has an
 * unpublished outbox row, which is an operational signal rather than an
 * inventory-correctness defect.
 */
async function checkInvariants(pool, { eventId = null } = {}) {
     const { rows } = eventId
          ? await pool.query(`SELECT * FROM invariants_for_event($1)`, [eventId])
          : await pool.query(`SELECT invariant, severity, violations FROM invariant_summary`);
     return {
          all: rows,
          violations: rows.filter((r) => Number(r.violations) > 0),
          clean: rows.every((r) => Number(r.violations) === 0),
     };
}

/**
 * Force a hold to have expired.
 *
 * Both timestamps move together because the schema enforces
 * `expires_at > created_at`; rewriting only the expiry would violate that check
 * and fail for the wrong reason. Shifting the whole hold into the past models a
 * hold that was created earlier and has since timed out, which is the state
 * under test. Waiting out a real TTL is not an option — the minimum is 30s.
 */
async function expireHold(pool, holdId) {
     await pool.query(
          `UPDATE holds
              SET created_at = now() - interval '2 hours',
                  expires_at = now() - interval '1 hour'
            WHERE id = $1`,
          [holdId]
     );
     await pool.query(
          `UPDATE allocations SET expires_at = now() - interval '1 hour' WHERE hold_id = $1 AND state = 'HELD'`,
          [holdId]
     );
}

/** Remove one event and everything derived from it. */
async function cleanupEvent(pool, eventId) {
     // Ledger and audit rows are append-only by trigger, so they are left in
     // place; they are scoped to the event and harmless.
     await pool.query(`DELETE FROM allocations WHERE event_id = $1`, [eventId]);
     await pool.query(`DELETE FROM holds WHERE event_id = $1`, [eventId]);
     await pool.query(`DELETE FROM pool_claims WHERE pool_id IN (SELECT id FROM inventory_pools WHERE event_id = $1)`, [eventId]);
     await pool.query(`DELETE FROM inventory_resources WHERE event_id = $1`, [eventId]);
     await pool.query(`DELETE FROM inventory_events WHERE id = $1`, [eventId]);
}

/**
 * Fire `count` operations simultaneously, behind a starting barrier.
 *
 * The barrier matters: without it, setup cost staggers the calls and the
 * "concurrent" test quietly becomes a sequential one that passes for the wrong
 * reason. This harness exists because that is exactly what happened the first
 * time the Contention Lab was written.
 */
async function fireConcurrently(count, fn) {
     let release;
     const gate = new Promise((resolve) => {
          release = resolve;
     });

     const tasks = Array.from({ length: count }, (_, i) =>
          (async () => {
               await gate;
               try {
                    return { ok: true, value: await fn(i) };
               } catch (err) {
                    return { ok: false, error: err };
               }
          })()
     );

     // Let every task reach the gate before releasing them.
     await new Promise((r) => setImmediate(r));
     release();
     return Promise.all(tasks);
}

module.exports = {
     testPool,
     seedEvent,
     checkInvariants,
     cleanupEvent,
     fireConcurrently,
     expireHold,
     CONNECTION_STRING,
};
