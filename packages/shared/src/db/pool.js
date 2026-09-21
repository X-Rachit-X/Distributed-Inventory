'use strict';

/**
 * PostgreSQL connection pool with explicit, measured limits.
 *
 * Two production concerns drive every setting here:
 *
 *   1. Connection exhaustion (spec §65). A pool that is allowed to grow without
 *      bound turns a slow query into a total outage: every request queues for a
 *      connection, the queue grows, and the database sees more concurrent work
 *      than it can schedule. We cap the pool and measure the queue instead.
 *
 *   2. Unbounded lock waits. Under contention a `SELECT ... FOR UPDATE` can park
 *      behind a long transaction forever. `lock_timeout` turns that into a fast,
 *      retryable error; `statement_timeout` bounds everything else; and
 *      `idle_in_transaction_session_timeout` kills a transaction whose client
 *      wandered off holding row locks.
 *
 * These timeouts are set per connection at creation time, so every query on
 * every pooled connection inherits them without per-call ceremony.
 */

const { Pool } = require('pg');
const { poolMetrics } = require('../observability/metrics');

const DEFAULTS = {
     max: 10,
     min: 0,
     idleTimeoutMillis: 30_000,
     // If no connection is free within this window, fail fast rather than
     // letting the caller queue behind an unbounded backlog.
     connectionTimeoutMillis: 5_000,
     statementTimeoutMs: 10_000,
     lockTimeoutMs: 3_000,
     idleInTransactionTimeoutMs: 10_000,
};

/**
 * @param {object} opts
 * @param {string} opts.connectionString
 * @param {string} opts.name            Logical name, used to label metrics.
 * @returns {import('pg').Pool & { withTransaction: Function, stats: Function }}
 */
function createPool(opts = {}) {
     const cfg = { ...DEFAULTS, ...opts };
     if (!cfg.connectionString) throw new Error('createPool: connectionString is required');
     const name = cfg.name || 'default';

     const pool = new Pool({
          connectionString: cfg.connectionString,
          max: Number(cfg.max),
          min: Number(cfg.min),
          idleTimeoutMillis: cfg.idleTimeoutMillis,
          connectionTimeoutMillis: cfg.connectionTimeoutMillis,
          application_name: `tessera-${name}`,
          // Guardrails are passed as startup parameters, so the server applies
          // them before the connection is handed to anyone.
          //
          // The first version ran `SET statement_timeout ...` from a 'connect'
          // listener without awaiting it. pg hands the client to the caller at
          // the same moment, so the caller's first query could overlap the SET:
          // pg logged "client.query() when the client is already executing a
          // query", and for that first query the timeouts were not guaranteed
          // to be in force yet. Startup options have no such window.
          options: [
               `-c statement_timeout=${Number(cfg.statementTimeoutMs)}`,
               `-c lock_timeout=${Number(cfg.lockTimeoutMs)}`,
               `-c idle_in_transaction_session_timeout=${Number(cfg.idleInTransactionTimeoutMs)}`,
          ].join(' '),
     });

     pool.on('error', (err) => {
          // An idle client erroring out is normal during database restarts.
          // Swallow it here so it cannot crash the process as an unhandled 'error' event.
          if (pool.__onBackgroundError) pool.__onBackgroundError(err);
     });

     poolMetrics.register(name, pool);

     /**
      * Run `fn` inside a transaction, guaranteeing release of the connection.
      *
      * The callback receives a dedicated client. Never perform network I/O to
      * another service inside it — that is exactly the pattern that converts a
      * slow downstream into database connection exhaustion (spec §65).
      *
      * @param {(client: import('pg').PoolClient) => Promise<any>} fn
      * @param {{ isolation?: 'READ COMMITTED'|'REPEATABLE READ'|'SERIALIZABLE', readOnly?: boolean, lockTimeoutMs?: number }} [txOpts]
      */
     pool.withTransaction = async function withTransaction(fn, txOpts = {}) {
          const client = await pool.connect();
          let began = false;
          try {
               const isolation = txOpts.isolation ? ` ISOLATION LEVEL ${txOpts.isolation}` : '';
               const mode = txOpts.readOnly ? ' READ ONLY' : '';
               await client.query(`BEGIN${isolation}${mode}`);
               began = true;
               if (txOpts.lockTimeoutMs != null) {
                    await client.query(`SET LOCAL lock_timeout = ${Number(txOpts.lockTimeoutMs)}`);
               }
               const result = await fn(client);
               await client.query('COMMIT');
               return result;
          } catch (err) {
               if (began) {
                    try {
                         await client.query('ROLLBACK');
                    } catch {
                         /* Connection is already broken; releasing it below discards it. */
                    }
               }
               throw err;
          } finally {
               client.release();
          }
     };

     pool.stats = () => ({
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          max: Number(cfg.max),
     });

     return pool;
}

module.exports = { createPool, POOL_DEFAULTS: DEFAULTS };
