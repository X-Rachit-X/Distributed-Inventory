'use strict';

/**
 * Concurrency strategies under test.
 *
 * Every strategy implements the same contract, so the only variable between
 * runs is the concurrency mechanism itself:
 *
 *     reserve(ctx, req) -> { outcome: 'SUCCESS' | 'CONFLICT' | 'ERROR', retries, sqlstate?, detail? }
 *
 * `outcome` distinguishes CONFLICT (someone else won — correct behaviour under
 * contention) from ERROR (a fault). Conflating them is the most common way a
 * benchmark flatters a broken system: 999 failed requests look fine if you only
 * count the successes.
 *
 * ── Why each strategy receives `ctx.client` ─────────────────────────────────
 *
 * Each virtual user owns a dedicated, already-connected client for the whole
 * run, handed to it by the runner. The first version of this file called
 * `pool.connect()` inside each strategy, and that silently destroyed the
 * experiment: establishing connections takes long enough that the first virtual
 * user finished its entire transaction before the fortieth had a connection at
 * all. The requests were serialised by connection setup, so the naive strategy
 * never raced and never oversold — it looked safe, which it is not.
 *
 * Warm connections plus a starting barrier (see runner.js) make the requests
 * genuinely simultaneous. That measures the concurrency mechanism rather than
 * the connection pool. Connection-pool pressure is a real concern too, but it
 * is measured separately, through the HTTP benchmarks that exercise the service
 * and its pool end to end.
 *
 * Results are measured, never assumed. Predictions live in
 * docs/benchmarks/HYPOTHESES.md, written before the first run, and the report
 * records predicted-versus-observed including the predictions that were wrong.
 */

const crypto = require('node:crypto');
const { PG } = require('@tessera/shared/src/errors');

const spanLiteral = (from, to) => `[${from},${to})`;

/** Classify a thrown error into the outcome taxonomy. */
function classify(err) {
     const code = err?.code;
     if (
          code === PG.EXCLUSION_VIOLATION ||
          code === PG.UNIQUE_VIOLATION ||
          code === PG.CHECK_VIOLATION
     ) {
          return { outcome: 'CONFLICT', sqlstate: code, detail: 'database constraint rejected the claim' };
     }
     if (code === PG.LOCK_NOT_AVAILABLE) {
          return { outcome: 'CONFLICT', sqlstate: code, detail: 'row was locked by another transaction' };
     }
     if (code === PG.DEADLOCK_DETECTED) {
          return { outcome: 'ERROR', sqlstate: code, detail: 'deadlock detected' };
     }
     if (code === PG.SERIALIZATION_FAILURE) {
          return { outcome: 'CONFLICT', sqlstate: code, detail: 'serialization failure' };
     }
     if (code === PG.QUERY_CANCELED) {
          return { outcome: 'TIMEOUT', sqlstate: code, detail: 'statement or lock timeout' };
     }
     return { outcome: 'ERROR', sqlstate: code ?? null, detail: err?.message ?? String(err) };
}

/** Roll back without masking the original error if the connection is broken. */
const safeRollback = (client) => client.query('ROLLBACK').catch(() => {});

// ═══════════════════════════════════════════════════════════════════════════
// A — NAIVE READ-CHECK-WRITE
//
// The implementation almost everyone writes first:
//
//     if (seat.status === 'AVAILABLE') { markHeld(seat); }
//
// The check and the write are separate statements, so between them any number
// of other transactions can read the same "AVAILABLE" and reach the same
// conclusion. This is the classic time-of-check-to-time-of-use race.
//
// Two details make it oversell rather than merely look risky:
//
//   - the SELECT takes no lock, so every concurrent reader sees AVAILABLE;
//   - the UPDATE's WHERE clause matches on identity only, with no status
//     predicate. Under READ COMMITTED, a blocked UPDATE re-evaluates its WHERE
//     against the newly committed row; because the predicate says nothing about
//     status, every waiter still matches and proceeds. This is exactly the bug
//     in real code that writes `UPDATE seats SET status='HELD' WHERE id=$1`
//     after checking availability in application code.
//
// Runs against the unguarded table, so nothing catches the mistake.
// ═══════════════════════════════════════════════════════════════════════════
function makeNaive({ delayMs = 2 } = {}) {
     return async function naiveReserve(ctx, req) {
          const client = ctx.client;
          try {
               await client.query('BEGIN');

               const { rows } = await client.query(
                    `SELECT status FROM lab.resource_state WHERE run_id = $1 AND resource_id = $2`,
                    [ctx.runId, req.resourceId]
               );

               if (rows.length === 0 || rows[0].status !== 'AVAILABLE') {
                    await client.query('ROLLBACK');
                    return { outcome: 'CONFLICT', retries: 0, detail: 'seat not available at read time' };
               }

               // ← THE WINDOW. Every concurrent request that read AVAILABLE is
               //   now here too, each convinced it may proceed.
               if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

               await client.query(
                    `UPDATE lab.resource_state SET status = 'HELD', holder = $3, version = version + 1
                      WHERE run_id = $1 AND resource_id = $2`,
                    [ctx.runId, req.resourceId, req.customerId]
               );
               await client.query(
                    `INSERT INTO lab.allocations_unsafe (run_id, resource_id, span, customer_id)
                     VALUES ($1, $2, $3::int4range, $4)`,
                    [ctx.runId, req.resourceId, spanLiteral(req.spanFrom, req.spanTo), req.customerId]
               );

               await client.query('COMMIT');
               return { outcome: 'SUCCESS', retries: 0 };
          } catch (err) {
               await safeRollback(client);
               return { ...classify(err), retries: 0 };
          }
     };
}

// ═══════════════════════════════════════════════════════════════════════════
// B — PESSIMISTIC ROW LOCK (SELECT ... FOR UPDATE)
//
// Closes the race by making the read itself exclusive: concurrent transactions
// queue on the row and each sees the previous one's committed result.
//
// Correct. The cost is that every loser WAITS. With 1,000 users on one seat,
// 999 transactions sit holding a database connection until the winner commits.
// That is the mechanism behind connection-pool exhaustion under flash-sale
// traffic, and the lab measures exactly that.
// ═══════════════════════════════════════════════════════════════════════════
async function pessimisticReserve(ctx, req) {
     const client = ctx.client;
     try {
          await client.query('BEGIN');

          const { rows } = await client.query(
               `SELECT status FROM lab.resource_state
                 WHERE run_id = $1 AND resource_id = $2
                   FOR UPDATE`,
               [ctx.runId, req.resourceId]
          );

          if (rows.length === 0 || rows[0].status !== 'AVAILABLE') {
               await client.query('ROLLBACK');
               return { outcome: 'CONFLICT', retries: 0, detail: 'seat taken' };
          }

          await client.query(
               `UPDATE lab.resource_state SET status = 'HELD', holder = $3, version = version + 1
                 WHERE run_id = $1 AND resource_id = $2`,
               [ctx.runId, req.resourceId, req.customerId]
          );
          await client.query(
               `INSERT INTO lab.allocations_unsafe (run_id, resource_id, span, customer_id)
                VALUES ($1, $2, $3::int4range, $4)`,
               [ctx.runId, req.resourceId, spanLiteral(req.spanFrom, req.spanTo), req.customerId]
          );

          await client.query('COMMIT');
          return { outcome: 'SUCCESS', retries: 0 };
     } catch (err) {
          await safeRollback(client);
          return { ...classify(err), retries: 0 };
     }
}

// ═══════════════════════════════════════════════════════════════════════════
// C — SKIP LOCKED
//
// Asks a different question: instead of "may I have THIS seat?", it asks "give
// me ANY free seat". Locked rows are stepped over rather than waited on, so
// nobody queues.
//
// This is the right tool for auto-allocation (general admission, "best
// available"). It is the wrong tool for explicit seat choice, where skipping
// the requested seat would silently hand the user a different one. The lab runs
// it in its proper mode — pick any free resource — which is why its throughput
// is not directly comparable to B or F on a single-seat scenario. That caveat
// is recorded in the report rather than buried.
// ═══════════════════════════════════════════════════════════════════════════
async function skipLockedReserve(ctx, req) {
     const client = ctx.client;
     try {
          await client.query('BEGIN');

          const { rows } = await client.query(
               `SELECT resource_id FROM lab.resource_state
                 WHERE run_id = $1 AND status = 'AVAILABLE'
                 ORDER BY resource_id
                   FOR UPDATE SKIP LOCKED
                 LIMIT 1`,
               [ctx.runId]
          );

          if (rows.length === 0) {
               await client.query('ROLLBACK');
               return { outcome: 'CONFLICT', retries: 0, detail: 'no free resource available' };
          }

          const resourceId = rows[0].resource_id;
          await client.query(
               `UPDATE lab.resource_state SET status = 'HELD', holder = $3, version = version + 1
                 WHERE run_id = $1 AND resource_id = $2`,
               [ctx.runId, resourceId, req.customerId]
          );
          await client.query(
               `INSERT INTO lab.allocations_unsafe (run_id, resource_id, span, customer_id)
                VALUES ($1, $2, $3::int4range, $4)`,
               [ctx.runId, resourceId, spanLiteral(req.spanFrom, req.spanTo), req.customerId]
          );

          await client.query('COMMIT');
          return { outcome: 'SUCCESS', retries: 0, allocatedResourceId: resourceId };
     } catch (err) {
          await safeRollback(client);
          return { ...classify(err), retries: 0 };
     }
}

// ═══════════════════════════════════════════════════════════════════════════
// D — OPTIMISTIC CONCURRENCY (compare-and-swap on a version column)
//
// Takes no locks. Reads a version, then writes conditionally on that version
// being unchanged. Zero rows updated means someone else got there first.
//
// Excellent under low contention: no waiting, no lock manager involvement.
// Under high contention it degenerates — most attempts do their work and then
// discard it, so the database performs the reads for every loser as well as the
// winner. Retries make that worse, which is why the retry count is reported as
// a first-class metric rather than hidden inside the strategy.
// ═══════════════════════════════════════════════════════════════════════════
function makeOptimistic({ maxAttempts = 3 } = {}) {
     return async function optimisticReserve(ctx, req) {
          const client = ctx.client;
          let retries = 0;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
               try {
                    await client.query('BEGIN');

                    const { rows } = await client.query(
                         `SELECT status, version FROM lab.resource_state WHERE run_id = $1 AND resource_id = $2`,
                         [ctx.runId, req.resourceId]
                    );

                    if (rows.length === 0 || rows[0].status !== 'AVAILABLE') {
                         await client.query('ROLLBACK');
                         return { outcome: 'CONFLICT', retries, detail: 'seat taken' };
                    }

                    const expectedVersion = rows[0].version;

                    // The conditional write. If another transaction committed
                    // in between, `version` moved and this matches zero rows.
                    const { rowCount } = await client.query(
                         `UPDATE lab.resource_state
                             SET status = 'HELD', holder = $4, version = version + 1
                           WHERE run_id = $1 AND resource_id = $2 AND version = $3`,
                         [ctx.runId, req.resourceId, expectedVersion, req.customerId]
                    );

                    if (rowCount === 0) {
                         await client.query('ROLLBACK');
                         retries += 1;
                         if (attempt === maxAttempts) {
                              return { outcome: 'CONFLICT', retries, detail: 'CAS lost after max attempts' };
                         }
                         // Full jitter, or every loser retries in lockstep and
                         // collides again — a self-inflicted thundering herd.
                         await new Promise((r) => setTimeout(r, Math.random() * 10 * attempt));
                         continue;
                    }

                    await client.query(
                         `INSERT INTO lab.allocations_unsafe (run_id, resource_id, span, customer_id)
                          VALUES ($1, $2, $3::int4range, $4)`,
                         [ctx.runId, req.resourceId, spanLiteral(req.spanFrom, req.spanTo), req.customerId]
                    );
                    await client.query('COMMIT');
                    return { outcome: 'SUCCESS', retries };
               } catch (err) {
                    await safeRollback(client);
                    return { ...classify(err), retries };
               }
          }
          return { outcome: 'CONFLICT', retries, detail: 'exhausted attempts' };
     };
}

// ═══════════════════════════════════════════════════════════════════════════
// E — DISTRIBUTED LOCK (Redis SET NX) + DATABASE CONSTRAINT
//
// The architecture many popular implementations use. Redis serialises access
// before the database is touched; the constraint remains the real authority.
//
// The important framing: Redis here is a LOAD FILTER, not the source of truth.
// If Redis is flushed, restarted, partitioned, or if a lock expires while its
// holder is still working, the constraint still refuses the overlap. Any design
// that treats the Redis lock as sufficient is relying on a system with no
// durability guarantee to protect a financial invariant.
//
// The cost is an extra network round trip on every request, plus a second
// system that can fail. Whether that buys enough to justify itself is exactly
// what the benchmark is for — and the answer may well be no.
// ═══════════════════════════════════════════════════════════════════════════
const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
     return redis.call('DEL', KEYS[1])
end
return 0
`;

function makeRedisLock({ lockTtlMs = 5_000 } = {}) {
     return async function redisLockReserve(ctx, req) {
          if (!ctx.redis) {
               return { outcome: 'ERROR', retries: 0, detail: 'Redis not configured for this run' };
          }

          const key = `lab:lock:${ctx.runId}:${req.resourceId}`;
          const token = crypto.randomUUID();

          // SET NX PX — atomic acquire with an expiry, so a crashed holder
          // cannot block the resource forever.
          const acquired = await ctx.redis.set(key, token, 'PX', lockTtlMs, 'NX');
          if (acquired !== 'OK') {
               return { outcome: 'CONFLICT', retries: 0, detail: 'redis lock held by another request' };
          }

          try {
               await ctx.client.query(
                    `INSERT INTO lab.allocations_guarded (run_id, resource_id, span, customer_id)
                     VALUES ($1, $2, $3::int4range, $4)`,
                    [ctx.runId, req.resourceId, spanLiteral(req.spanFrom, req.spanTo), req.customerId]
               );
               return { outcome: 'SUCCESS', retries: 0 };
          } catch (err) {
               return { ...classify(err), retries: 0 };
          } finally {
               // Release only our own lock. A plain DEL could delete a lock
               // acquired by someone else after ours expired mid-operation.
               await ctx.redis.eval(RELEASE_LOCK_LUA, 1, key, token).catch(() => {});
          }
     };
}

// ═══════════════════════════════════════════════════════════════════════════
// F — POSTGRESQL-NATIVE (exclusion constraint, single statement)
//
// The production path. One INSERT. No prior read, no application-level check,
// no lock taken by hand, no second system.
//
// Concurrent conflicting inserts block on the GiST index until the first
// commits or aborts; exactly one wins and the rest receive SQLSTATE 23P01,
// which the API surfaces as 409. Because there is no read-then-write, there is
// no window to lose — correctness does not depend on any code above this line
// behaving well.
// ═══════════════════════════════════════════════════════════════════════════
async function postgresNativeReserve(ctx, req) {
     try {
          await ctx.client.query(
               `INSERT INTO lab.allocations_guarded (run_id, resource_id, span, customer_id)
                VALUES ($1, $2, $3::int4range, $4)`,
               [ctx.runId, req.resourceId, spanLiteral(req.spanFrom, req.spanTo), req.customerId]
          );
          return { outcome: 'SUCCESS', retries: 0 };
     } catch (err) {
          return { ...classify(err), retries: 0 };
     }
}

// ═══════════════════════════════════════════════════════════════════════════
// F2 — ORDERLY QUEUE + EXCLUSION CONSTRAINT  (the corrected production path)
//
// Added after measurement, not before. Strategy F — a bare INSERT relying on
// the constraint alone — collapsed under single-resource contention: 609 of
// 1,000 requests died with SQLSTATE 40P01, deadlock detected, and p99 hit the
// 30-second statement timeout.
//
// The mechanism is specific to how PostgreSQL enforces exclusion constraints.
// Unlike a unique index, which uses speculative insertion, a GiST exclusion
// constraint inserts the row and THEN scans for conflicts, waiting on any
// conflicting transaction that is still in progress. With many concurrent
// inserters on one key, they end up waiting on each other, the wait graph forms
// cycles, and the deadlock detector starts killing transactions. The constraint
// is still perfectly correct — nothing oversold — but the throughput collapses.
//
// The fix is to give contention an ORDERLY place to queue before it reaches the
// constraint. Taking a row lock on the resource first turns a chaotic wait graph
// into a single well-behaved FIFO queue per resource, which is why strategy B
// behaved so much better despite doing more work.
//
// Locks are taken in sorted resource order for multi-resource requests, so no
// cycle can form among them either.
//
// The constraint is NOT redundant here. The row lock is a throughput
// optimisation; the constraint is the correctness authority. If a future code
// path forgets the lock, takes it on the wrong row, or a replica misbehaves,
// the constraint still refuses to store the overlap. That separation is the
// whole architectural claim, and strategy E demonstrates it independently: its
// Redis lock let a second request through, and the constraint rejected it.
// ═══════════════════════════════════════════════════════════════════════════
async function orderlyQueueReserve(ctx, req) {
     const client = ctx.client;
     try {
          await client.query('BEGIN');

          // Orderly queue. One waiter at a time per resource, FIFO, no cycles.
          await client.query(
               `SELECT 1 FROM lab.resource_state
                 WHERE run_id = $1 AND resource_id = $2
                   FOR UPDATE`,
               [ctx.runId, req.resourceId]
          );

          // The constraint remains the final arbiter.
          await client.query(
               `INSERT INTO lab.allocations_guarded (run_id, resource_id, span, customer_id)
                VALUES ($1, $2, $3::int4range, $4)`,
               [ctx.runId, req.resourceId, spanLiteral(req.spanFrom, req.spanTo), req.customerId]
          );

          await client.query('COMMIT');
          return { outcome: 'SUCCESS', retries: 0 };
     } catch (err) {
          await safeRollback(client);
          return { ...classify(err), retries: 0 };
     }
}

// ═══════════════════════════════════════════════════════════════════════════
// G — BUCKET-SHARDED QUANTITY POOL
//
// For inventory without individual identity, the bottleneck is one counter row
// that every buyer must update. Splitting capacity across N buckets turns one
// queue into N independent queues.
//
// Two details make the difference between a real fix and a broken one:
//   - each request starts at a DIFFERENT bucket (hashed), otherwise bucket 0
//     becomes the new hot row and nothing was gained;
//   - a full bucket falls through to the next, otherwise capacity is stranded
//     in buckets nobody happened to hash to, and the pool reports sold out
//     while holding stock.
//
// The CHECK constraint is what makes the claim safe: `capacity - taken >= n` in
// the WHERE clause makes check-and-claim a single atomic statement.
// ═══════════════════════════════════════════════════════════════════════════
function makeBucketedPool({ guarded = true } = {}) {
     const table = guarded ? 'lab.pool_buckets' : 'lab.pool_buckets_unsafe';

     return async function bucketedPoolReserve(ctx, req) {
          const bucketCount = ctx.bucketCount || 1;
          const quantity = req.quantity || 1;
          const start = Math.abs(hashCode(req.customerId)) % bucketCount;

          try {
               for (let i = 0; i < bucketCount; i++) {
                    const bucket = (start + i) % bucketCount;

                    const sql = guarded
                         ? `UPDATE ${table} SET taken = taken + $3
                             WHERE run_id = $1 AND bucket = $2 AND capacity - taken >= $3
                         RETURNING bucket`
                         : // Unguarded twin: no capacity predicate and no CHECK
                           // constraint, so the counter can pass its ceiling.
                           `UPDATE ${table} SET taken = taken + $3
                             WHERE run_id = $1 AND bucket = $2
                         RETURNING bucket`;

                    const { rows } = await ctx.client.query(sql, [ctx.runId, bucket, quantity]);
                    if (rows.length > 0) return { outcome: 'SUCCESS', retries: i, bucket };
               }
               return { outcome: 'CONFLICT', retries: bucketCount, detail: 'every bucket full' };
          } catch (err) {
               return { ...classify(err), retries: 0 };
          }
     };
}

// ═══════════════════════════════════════════════════════════════════════════
// H — ADMISSION-CONTROLLED (F, behind a concurrency bulkhead)
//
// Same database mechanism as F, with a semaphore capping how many requests may
// be in flight against the database at once. Everything beyond the cap is shed
// immediately with a retry hint instead of queueing.
//
// The hypothesis: past a certain concurrency, ADDING load reduces goodput,
// because every extra in-flight request lengthens the queue that the requests
// doing useful work must traverse. If true, the correct response to overload is
// to refuse work quickly rather than to accept it and be slow. Shed requests
// are counted separately from conflicts, because shedding is a capacity
// decision, not an inventory outcome.
// ═══════════════════════════════════════════════════════════════════════════
function makeAdmissionControlled({ maxConcurrent = 32 } = {}) {
     let inFlight = 0;

     return async function admissionControlledReserve(ctx, req) {
          if (inFlight >= maxConcurrent) {
               return { outcome: 'CONFLICT', retries: 0, detail: 'SHED: admission control', shed: true };
          }
          inFlight += 1;
          try {
               return await postgresNativeReserve(ctx, req);
          } finally {
               inFlight -= 1;
          }
     };
}

function hashCode(str) {
     let h = 0;
     for (let i = 0; i < String(str).length; i++) h = (Math.imul(31, h) + String(str).charCodeAt(i)) | 0;
     return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGIES = {
     A: {
          id: 'A',
          name: 'naive-read-check-write',
          title: 'Naive read-check-write',
          table: 'unsafe',
          expectedSafe: false,
          summary:
               'Reads status, checks it, then writes. The gap between check and write is a race every concurrent request enters.',
          reserve: makeNaive({ delayMs: 2 }),
     },
     A0: {
          id: 'A0',
          name: 'naive-no-delay',
          title: 'Naive, no artificial delay',
          table: 'unsafe',
          expectedSafe: false,
          summary:
               'Same as A with no injected delay, to show the race is inherent rather than manufactured by the test.',
          reserve: makeNaive({ delayMs: 0 }),
     },
     B: {
          id: 'B',
          name: 'pessimistic-row-lock',
          title: 'Pessimistic row lock (FOR UPDATE)',
          table: 'unsafe',
          expectedSafe: true,
          summary: 'Serialises on the row. Correct, but every loser waits while holding a connection.',
          reserve: pessimisticReserve,
     },
     C: {
          id: 'C',
          name: 'skip-locked',
          title: 'FOR UPDATE SKIP LOCKED',
          table: 'unsafe',
          expectedSafe: true,
          summary: 'Claims any free resource, stepping over locked rows. Built for auto-allocation, not seat choice.',
          reserve: skipLockedReserve,
          allocatesAnyResource: true,
     },
     D: {
          id: 'D',
          name: 'optimistic-cas',
          title: 'Optimistic CAS on a version column',
          table: 'unsafe',
          expectedSafe: true,
          summary: 'No locks; conditional write on an unchanged version. Wasted work grows with contention.',
          reserve: makeOptimistic({ maxAttempts: 3 }),
     },
     E: {
          id: 'E',
          name: 'redis-lock-plus-constraint',
          title: 'Redis SET NX lock + database constraint',
          table: 'guarded',
          expectedSafe: true,
          summary: 'Redis filters load before the database; the constraint remains the authority.',
          reserve: makeRedisLock(),
          needsRedis: true,
     },
     F: {
          id: 'F',
          name: 'postgres-native-exclusion',
          title: 'PostgreSQL exclusion constraint (single statement)',
          table: 'guarded',
          expectedSafe: true,
          summary: 'One INSERT. No read, no application check, no second system. The production path.',
          reserve: postgresNativeReserve,
     },
     F2: {
          id: 'F2',
          name: 'orderly-queue-plus-constraint',
          title: 'Row-lock queue + exclusion constraint',
          table: 'guarded',
          expectedSafe: true,
          summary:
               'Queues contention on the resource row, then lets the constraint decide. The corrected production path.',
          reserve: orderlyQueueReserve,
     },
     G: {
          id: 'G',
          name: 'bucketed-pool',
          title: 'Bucket-sharded quantity pool',
          table: 'pool',
          expectedSafe: true,
          summary: 'Splits a hot counter across N buckets to convert one queue into N.',
          reserve: makeBucketedPool({ guarded: true }),
          isPool: true,
     },
     G0: {
          id: 'G0',
          name: 'bucketed-pool-unsafe',
          title: 'Quantity pool without the CHECK constraint',
          table: 'pool-unsafe',
          expectedSafe: false,
          summary: 'Control group for G: the same counter update with no capacity predicate.',
          reserve: makeBucketedPool({ guarded: false }),
          isPool: true,
     },
     H: {
          id: 'H',
          name: 'admission-controlled',
          title: 'Exclusion constraint behind an admission bulkhead',
          table: 'guarded',
          expectedSafe: true,
          summary: 'Strategy F with bounded in-flight concurrency; excess load is shed rather than queued.',
          reserve: makeAdmissionControlled({ maxConcurrent: 32 }),
     },
};

/** Strategies in the default comparison set (excludes variants and controls). */
const DEFAULT_SET = ['A', 'B', 'C', 'D', 'E', 'F', 'F2', 'H'];

module.exports = { STRATEGIES, DEFAULT_SET, classify, spanLiteral, makeAdmissionControlled };
