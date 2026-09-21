'use strict';

/**
 * Reconciliation service — HTTP.
 *
 * Runs the reconciliation worker on a schedule and exposes what it found:
 * the correctness scoreboard, the open issues, and the controlled repair path.
 *
 * It is the one component with read access to other services' databases, through
 * read-only roles. That is a documented exception to "each service owns its
 * data": reconciliation's whole job is to compare services against each other,
 * and doing that through their own APIs would let a sick service hide its own
 * inconsistency.
 *
 * Repairs involving money are never automatic. `POST /admin/issues/:id/retry`
 * is the human path: an operator who has looked at the evidence decides.
 */

require('../../inventory-engine/src/config/env');
require('@tessera/shared/src/observability/tracing');

const { createPool } = require('@tessera/shared/src/db/pool');
const { createLogger } = require('@tessera/shared/src/observability/logger');
const { createApp, asyncHandler, errorMiddleware, listen } = require('@tessera/shared/src/http/server');
const { NotFoundError, UnauthorizedError, BadRequestError } = require('@tessera/shared/src/errors');
const { ReconciliationWorker } = require('./worker');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
     PORT: num(process.env.RECONCILIATION_PORT, 4004),
     INTERNAL_TOKEN: process.env.INTERNAL_TOKEN || 'dev-internal-token',
     INTERVAL_MS: num(process.env.RECONCILIATION_INTERVAL_MS, 30_000),
     urls: {
          recon: process.env.RECONCILIATION_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/reconciliation',
          inventory: process.env.INVENTORY_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/inventory',
          reservation:
               process.env.RESERVATION_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/reservation',
          payment: process.env.PAYMENT_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/payment',
     },
};

const logger = createLogger('reconciliation');

const recon = createPool({ connectionString: config.urls.recon, name: 'reconciliation', max: 5 });
// Read pools: reconciliation OBSERVES other services. Kept small, because a
// comparison job must never compete with the traffic it is auditing.
const inventory = createPool({ connectionString: config.urls.inventory, name: 'recon-inventory', max: 3 });
const reservation = createPool({ connectionString: config.urls.reservation, name: 'recon-reservation', max: 3 });
const payment = createPool({ connectionString: config.urls.payment, name: 'recon-payment', max: 3 });

const worker = new ReconciliationWorker({
     recon,
     inventory,
     reservation,
     payment,
     // Write access is limited to the two inventory-only, reversible repairs the
     // worker is allowed to perform. Payments are deliberately absent.
     repairers: { inventory, reservation },
     logger,
     options: { intervalMs: config.INTERVAL_MS, autoRepair: true, minSightingsBeforeRepair: 2 },
});

const app = createApp({
     name: 'reconciliation',
     logger,
     dependencies: [
          {
               name: 'postgres',
               critical: true,
               check: async () => {
                    await recon.query('SELECT 1');
                    return true;
               },
          },
     ],
});

function requireInternal(req, _res, next) {
     if (req.get('x-internal-token') !== config.INTERNAL_TOKEN) {
          return next(new UnauthorizedError('Invalid or missing internal service token'));
     }
     next();
}

/** The correctness scoreboard. Every counter should read zero. */
app.get(
     '/v1/scoreboard',
     asyncHandler(async (_req, res) => {
          const board = await worker.scoreboard();

          const { rows: inv } = await inventory.query(`SELECT invariant, severity, violations FROM invariant_summary`);
          const { rows: outbox } = await Promise.all(
               [inventory, reservation, payment].map((db) =>
                    db.query(`SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                                     count(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead
                                FROM outbox_events`)
               )
          ).then((results) => ({
               rows: results.map((r) => r.rows[0]),
          }));
          const { rows: dlq } = await Promise.all(
               [inventory, reservation, payment].map((db) =>
                    db.query(`SELECT count(*)::int AS open FROM dead_letters WHERE status = 'OPEN'`)
               )
          ).then((results) => ({ rows: results.map((r) => r.rows[0]) }));
          const { rows: dupes } = await Promise.all(
               [inventory, reservation, payment].map((db) =>
                    db.query(`SELECT count(*)::int AS n FROM processed_events`)
               )
          ).then((results) => ({ rows: results.map((r) => r.rows[0]) }));

          const oversells =
               Number(inv.find((r) => r.invariant === 'I1_overlapping_allocations')?.violations ?? 0) +
               Number(inv.find((r) => r.invariant === 'I2_oversold_pools')?.violations ?? 0);

          const counters = {
               oversells,
               duplicateBookings: Number(inv.find((r) => r.invariant === 'I7_duplicate_bookings')?.violations ?? 0),
               orphanedHolds: Number(inv.find((r) => r.invariant === 'I3_expired_still_held')?.violations ?? 0),
               ledgerMismatches: Number(inv.find((r) => r.invariant === 'I4_ledger_drift')?.violations ?? 0),
               unpublishedOutbox: outbox.reduce((s, r) => s + r.pending, 0),
               deadLetteredOutbox: outbox.reduce((s, r) => s + r.dead, 0),
               openDeadLetters: dlq.reduce((s, r) => s + r.open, 0),
               paymentsWithoutBooking: board.paymentsWithoutBooking,
               stuckSagas: board.stuckSagas,
               openIssues: board.openIssues,
               criticalIssues: board.criticalIssues,
          };

          // "All clear" is about CORRECTNESS. An outbox backlog means events
          // are late, not that inventory is wrong, so it is reported separately
          // rather than turning the whole board red during a broker outage.
          const correctnessKeys = [
               'oversells',
               'duplicateBookings',
               'orphanedHolds',
               'ledgerMismatches',
               'paymentsWithoutBooking',
               'criticalIssues',
          ];

          res.json({
               data: {
                    counters,
                    correct: correctnessKeys.every((k) => counters[k] === 0),
                    allClear: Object.values(counters).every((v) => v === 0),
                    lastReconciledAt: board.lastRunAt,
                    eventsDeduplicatedAcrossServices: dupes.reduce((s, r) => s + r.n, 0),
               },
               as_of: new Date().toISOString(),
          });
     })
);

app.get(
     '/v1/issues',
     asyncHandler(async (req, res) => {
          const status = req.query.status || 'open';
          const filter =
               status === 'all'
                    ? ''
                    : status === 'open'
                      ? `WHERE repair_status IN ('OPEN','AWAITING_HUMAN')`
                      : `WHERE repair_status = $1`;
          const params = status === 'all' || status === 'open' ? [] : [status.toUpperCase()];

          const { rows } = await recon.query(
               `SELECT id, kind, severity, entity_type, entity_id, expected, actual, detail,
                       money_involved, repair_status, recommended_action, repair_detail,
                       seen_count, first_seen_at, last_seen_at, resolved_at
                  FROM reconciliation_issues
                  ${filter}
                 ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                          last_seen_at DESC
                 LIMIT 200`,
               params
          );
          res.json({ data: rows });
     })
);

app.get(
     '/v1/runs',
     asyncHandler(async (_req, res) => {
          const { rows } = await recon.query(
               `SELECT id, started_at, finished_at, checks_run, issues_found, issues_repaired, duration_ms
                  FROM recon_runs ORDER BY started_at DESC LIMIT 20`
          );
          res.json({ data: rows });
     })
);

/** Run a pass now rather than waiting for the schedule. */
app.post(
     '/admin/run',
     requireInternal,
     asyncHandler(async (_req, res) => {
          const result = await worker.run();
          res.json({ data: result });
     })
);

/**
 * Human-approved action on an issue.
 *
 * `resolve` records that an operator handled it out of band (for example a
 * refund issued from the provider dashboard). `ignore` accepts it as benign.
 * Both leave an entry in the append-only repair log naming who did it and why.
 */
app.post(
     '/admin/issues/:id/:action',
     requireInternal,
     asyncHandler(async (req, res) => {
          const { id, action } = req.params;
          if (!['resolve', 'ignore', 'retry'].includes(action)) {
               throw new BadRequestError('action must be resolve, ignore or retry');
          }
          const actor = req.get('x-actor') || 'operator';
          const reason = req.body?.reason;
          if (!reason) throw new BadRequestError('A reason is required for any manual action');

          const { rows } = await recon.query(`SELECT * FROM reconciliation_issues WHERE id = $1`, [id]);
          if (rows.length === 0) throw new NotFoundError('Issue not found');
          const issue = rows[0];

          if (action === 'retry') {
               // Re-open so the next pass re-evaluates it. For inventory issues
               // this re-enables the safe automatic repair.
               await recon.query(
                    `UPDATE reconciliation_issues SET repair_status = 'OPEN', seen_count = 1 WHERE id = $1`,
                    [id]
               );
               await worker.run();
          } else {
               await recon.query(
                    `UPDATE reconciliation_issues
                        SET repair_status = $2, repaired_by = $3, repair_detail = $4, resolved_at = now()
                      WHERE id = $1`,
                    [id, action === 'resolve' ? 'REPAIRED_BY_HUMAN' : 'IGNORED', actor, reason]
               );
          }

          await recon.query(
               `INSERT INTO repair_log (issue_id, action, automatic, actor, before, after, outcome, detail)
                VALUES ($1, $2, false, $3, $4, $5, 'SUCCESS', $6)`,
               [
                    id,
                    `MANUAL_${action.toUpperCase()}`,
                    actor,
                    JSON.stringify({ repair_status: issue.repair_status }),
                    JSON.stringify({ action }),
                    reason,
               ]
          );

          const { rows: after } = await recon.query(`SELECT * FROM reconciliation_issues WHERE id = $1`, [id]);
          res.json({ data: after[0] });
     })
);

app.use(errorMiddleware(logger));

async function main() {
     await recon.query('SELECT 1');
     worker.start();
     listen({
          app,
          port: config.PORT,
          name: 'reconciliation',
          logger,
          workers: [{ name: 'reconciliation', stop: () => worker.stop() }],
          resources: [
               { name: 'recon', close: () => recon.end() },
               { name: 'inventory', close: () => inventory.end() },
               { name: 'reservation', close: () => reservation.end() },
               { name: 'payment', close: () => payment.end() },
          ],
     });
}

main().catch((err) => {
     logger.error('failed to start', { error: err.message, stack: err.stack });
     process.exit(1);
});
