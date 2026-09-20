'use strict';

/**
 * Claim-first idempotency.
 *
 * The bug this replaces is the classic one (and the one the v1 codebase had):
 *
 *     const existing = await findKey(key);        // (1) check
 *     if (existing) return existing.response;
 *     const result = await doTheWork();           // (2) act
 *     await saveKey(key, result);                 // (3) record
 *
 * Two concurrent retries of the same request both pass (1) and both run (2).
 * For a payment that means two charges. The window is small, and small windows
 * are exactly what a client retry storm finds.
 *
 * Here the key is *claimed* with a single atomic statement before any work
 * happens:
 *
 *     INSERT ... ON CONFLICT DO NOTHING RETURNING *
 *
 * The winner gets a row and executes. Everyone else reads the existing row and
 * either replays the stored response or is told the original is still running.
 *
 * The second guarantee is response fidelity. A committed reservation whose HTTP
 * response was lost must replay *the original response*, not a fresh lookup —
 * so the status code and body are stored verbatim. Deterministic failures are
 * replayed too: if the first attempt was rejected as a conflict, the retry gets
 * the same conflict rather than a second chance at the inventory.
 *
 * For database-only mutations, pass the caller's transaction client. The
 * idempotency record then commits atomically with the business rows, which
 * closes the "committed but not recorded" gap entirely.
 */

const crypto = require('node:crypto');
const { InProgressError, IdempotencyKeyReuseError, TesseraError } = require('../errors');
const { PG } = require('../errors');

const hashRequest = (body) =>
     crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

const DEFAULT_TTL_HOURS = 24;

/**
 * Attempt to claim a key.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} db
 * @param {object} args
 * @param {string} args.scope      Namespace, e.g. 'reservation.create'.
 * @param {string} args.key        Client-supplied Idempotency-Key.
 * @param {string} [args.ownerId]  Scoping the key to a user prevents one client
 *                                 from squatting or hijacking another's key.
 * @param {any}    args.request    Request payload, hashed for reuse detection.
 * @param {number} [args.ttlHours]
 * @returns {Promise<{outcome:'CLAIMED'|'REPLAY'|'IN_PROGRESS', record?: object}>}
 */
async function claim(db, { scope, key, ownerId = null, request, ttlHours = DEFAULT_TTL_HOURS }) {
     const requestHash = hashRequest(request);

     const { rows } = await db.query(
          `INSERT INTO idempotency_keys (scope, key, owner_id, request_hash, state, expires_at)
           VALUES ($1, $2, $3, $4, 'IN_PROGRESS', now() + ($5 || ' hours')::interval)
           ON CONFLICT (scope, key) DO NOTHING
           RETURNING scope, key, state`,
          [scope, key, ownerId, requestHash, String(ttlHours)]
     );

     if (rows.length > 0) return { outcome: 'CLAIMED', record: rows[0] };

     // Someone else owns the key. Decide whether this is a replay, a collision
     // with an in-flight request, or an abusive reuse of the key.
     const { rows: existing } = await db.query(
          `SELECT scope, key, owner_id, request_hash, state, response_status, response_body, created_at
             FROM idempotency_keys
            WHERE scope = $1 AND key = $2`,
          [scope, key]
     );

     if (existing.length === 0) {
          // The row expired and was cleaned up between our INSERT and SELECT.
          // Treat as contention; the caller retries and will win the next claim.
          throw new InProgressError('Idempotency record vanished mid-claim; retry');
     }

     const rec = existing[0];

     if (rec.owner_id && ownerId && rec.owner_id !== ownerId) {
          // Another user's key. Never leak their response.
          throw new IdempotencyKeyReuseError('Idempotency-Key belongs to a different caller');
     }
     if (rec.request_hash !== requestHash) {
          throw new IdempotencyKeyReuseError();
     }
     if (rec.state === 'IN_PROGRESS') {
          throw new InProgressError();
     }

     return { outcome: 'REPLAY', record: rec };
}

/** Record the final response for a claimed key, in the caller's transaction. */
async function complete(db, { scope, key, status, body, state = 'COMPLETED' }) {
     await db.query(
          `UPDATE idempotency_keys
              SET state = $3, response_status = $4, response_body = $5, completed_at = now()
            WHERE scope = $1 AND key = $2`,
          [scope, key, state, status, body == null ? null : JSON.stringify(body)]
     );
}

/**
 * Release a claim so the request can be retried from scratch.
 * Used for *infrastructure* failures (database unreachable, timeout) where we
 * genuinely do not know whether work happened — not for business rejections,
 * which are recorded as deterministic outcomes instead.
 */
async function abandon(db, { scope, key }) {
     await db.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND state = 'IN_PROGRESS'`, [
          scope,
          key,
     ]);
}

/**
 * Run `fn` under idempotency, using a single transaction that covers both the
 * business writes and the idempotency record.
 *
 * `fn` receives the transaction client and returns `{ status, body }`.
 * Business rejections (a TesseraError with status < 500) are recorded as
 * deterministic FAILED outcomes and replayed on retry — a request rejected for
 * a real reason must stay rejected, or a retry loop becomes a second attempt at
 * scarce inventory.
 *
 * @param {import('pg').Pool} pool
 * @param {object} args  As in `claim`.
 * @param {(client: import('pg').PoolClient) => Promise<{status:number, body:any}>} fn
 */
async function withIdempotency(pool, args, fn) {
     // Claim in its own short transaction so the claim is visible to competing
     // requests immediately, rather than being held invisible until the (possibly
     // slow) business transaction commits.
     const claimResult = await claim(pool, args);

     if (claimResult.outcome === 'REPLAY') {
          const rec = claimResult.record;
          return {
               replayed: true,
               status: rec.response_status ?? 200,
               body: rec.response_body ?? null,
               failed: rec.state === 'FAILED',
          };
     }

     try {
          return await pool.withTransaction(async (client) => {
               const result = await fn(client);
               await complete(client, {
                    scope: args.scope,
                    key: args.key,
                    status: result.status,
                    body: result.body,
                    state: 'COMPLETED',
               });
               return { replayed: false, ...result };
          });
     } catch (err) {
          const isBusinessRejection = err instanceof TesseraError && err.status < 500 && !err.retryable;

          if (isBusinessRejection) {
               // Deterministic outcome: record it so retries replay the rejection.
               await complete(pool, {
                    scope: args.scope,
                    key: args.key,
                    status: err.status,
                    body: err.toJSON(),
                    state: 'FAILED',
               }).catch(() => {});
          } else {
               // Unknown outcome. Free the key so an honest retry can run again.
               await abandon(pool, args).catch(() => {});
          }
          throw err;
     }
}

/** Delete expired records. Run periodically; safe to run concurrently. */
async function cleanup(db, { batchSize = 1000 } = {}) {
     const { rowCount } = await db.query(
          `DELETE FROM idempotency_keys
            WHERE ctid IN (
                 SELECT ctid FROM idempotency_keys WHERE expires_at < now() LIMIT $1
            )`,
          [batchSize]
     );
     return rowCount;
}

module.exports = { claim, complete, abandon, withIdempotency, cleanup, hashRequest, PG };
