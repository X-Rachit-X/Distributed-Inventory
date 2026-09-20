'use strict';

/**
 * Reconciliation worker.
 *
 * Runs the checks, records what it finds, and repairs only what is safe.
 *
 * THE CONFIRMATION RULE. Cross-service state is not atomic, so a single
 * observation proves nothing: a mismatch seen once may simply be a saga
 * mid-flight. An issue is only ACTED ON once it has been seen in more than one
 * pass, separated by at least one interval. A mismatch that disappears in the
 * meantime is recorded as RESOLVED_ITSELF, which is valuable — it shows the
 * system converging rather than being broken.
 *
 * THE MONEY RULE. `moneyInvolved` issues are never repaired automatically, no
 * matter how obvious the fix looks. An automated refund loop that misfires
 * during an incident is worse than the inconsistency it was trying to correct,
 * because it is much harder to reverse. Those issues get a recommended action
 * and wait for a human who can see the whole picture.
 */

const { ALL_CHECKS } = require('./checks');
const { metrics } = require('@tessera/shared/src/observability/metrics');

class ReconciliationWorker {
     /**
      * @param {object} deps
      * @param {import('pg').Pool} deps.recon      Its own database.
      * @param {import('pg').Pool} deps.inventory  Read-only.
      * @param {import('pg').Pool} deps.reservation Read-only.
      * @param {import('pg').Pool} deps.payment    Read-only.
      * @param {object} [deps.repairers]  Write-capable clients, for safe repairs only.
      */
     constructor({ recon, inventory, reservation, payment, repairers = {}, logger, options = {} }) {
          this.recon = recon;
          this.inventory = inventory;
          this.reservation = reservation;
          this.payment = payment;
          this.repairers = repairers;
          this.logger = logger;
          this.opts = {
               intervalMs: 30_000,
               autoRepair: true,
               minSightingsBeforeRepair: 2,
               ...options,
          };
          this.timer = null;
     }

     start() {
          if (this.timer) return;
          this.logger.info('reconciliation worker started', { intervalMs: this.opts.intervalMs });
          this.run().catch((err) => this.logger.error('initial recon run failed', { error: err.message }));
          this.timer = setInterval(
               () => this.run().catch((err) => this.logger.error('recon run failed', { error: err.message })),
               this.opts.intervalMs
          );
          this.timer.unref?.();
     }

     stop() {
          if (this.timer) clearInterval(this.timer);
          this.timer = null;
     }

     /** One full pass over every check. */
     async run() {
          const started = Date.now();
          const { rows } = await this.recon.query(
               `INSERT INTO recon_runs (started_at) VALUES (now()) RETURNING id`
          );
          const runId = rows[0].id;

          let found = 0;
          let repaired = 0;
          let checksRun = 0;
          const seenKeys = new Set();

          for (const check of ALL_CHECKS) {
               try {
                    const issues = await check.run({
                         inventory: this.inventory,
                         reservation: this.reservation,
                         payment: this.payment,
                         graceSeconds: check.graceSeconds,
                    });
                    checksRun += 1;

                    for (const issue of issues) {
                         seenKeys.add(`${issue.kind}:${issue.entityType}:${issue.entityId}`);
                         const record = await this.#record(runId, issue);
                         found += 1;

                         if (this.opts.autoRepair && (await this.#maybeRepair(record, issue))) {
                              repaired += 1;
                         }
                    }
               } catch (err) {
                    this.logger.error('check failed', { check: check.name, error: err.message });
               }
          }

          // Anything previously open that no longer appears has resolved on its
          // own. Recording that is what keeps the issue list trustworthy.
          await this.#closeResolved(seenKeys);

          const durationMs = Date.now() - started;
          await this.recon.query(
               `UPDATE recon_runs
                   SET finished_at = now(), checks_run = $2, issues_found = $3,
                       issues_repaired = $4, duration_ms = $5
                 WHERE id = $1`,
               [runId, checksRun, found, repaired, durationMs]
          );

          await this.#snapshot();

          this.logger.info('reconciliation pass complete', {
               runId,
               checksRun,
               found,
               repaired,
               durationMs,
          });

          return { runId, checksRun, found, repaired, durationMs };
     }

     /**
      * Upsert the issue, incrementing its sighting count.
      *
      * The unique key is (kind, entityType, entityId), so the same problem seen
      * across many passes is ONE issue with a rising count rather than a flood
      * of duplicates.
      */
     async #record(runId, issue) {
          const { rows } = await this.recon.query(
               `INSERT INTO reconciliation_issues
                       (run_id, kind, severity, entity_type, entity_id, expected, actual,
                        detail, money_involved, recommended_action)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (kind, entity_type, entity_id) DO UPDATE
                     SET seen_count = reconciliation_issues.seen_count + 1,
                         last_seen_at = now(),
                         actual = EXCLUDED.actual,
                         detail = EXCLUDED.detail,
                         run_id = EXCLUDED.run_id,
                         -- An issue that had resolved and came back is open again.
                         repair_status = CASE
                              WHEN reconciliation_issues.repair_status = 'RESOLVED_ITSELF' THEN 'OPEN'
                              ELSE reconciliation_issues.repair_status
                         END
             RETURNING id, seen_count, repair_status, money_involved`,
               [
                    runId,
                    issue.kind,
                    issue.severity,
                    issue.entityType,
                    issue.entityId,
                    JSON.stringify(issue.expected ?? null),
                    JSON.stringify(issue.actual ?? null),
                    issue.detail,
                    issue.moneyInvolved,
                    issue.recommendedAction ?? null,
               ]
          );
          return rows[0];
     }

     /**
      * Repair, if and only if it is safe.
      *
      * @returns {Promise<boolean>} whether a repair was performed
      */
     async #maybeRepair(record, issue) {
          if (record.repair_status !== 'OPEN') return false;

          // Money: stop. Record the recommendation and wait for a human.
          if (issue.moneyInvolved) {
               await this.recon.query(
                    `UPDATE reconciliation_issues SET repair_status = 'AWAITING_HUMAN' WHERE id = $1`,
                    [record.id]
               );
               this.logger.warn('issue needs human judgement; not repairing automatically', {
                    issueId: record.id,
                    kind: issue.kind,
                    action: issue.recommendedAction,
               });
               return false;
          }

          // Confirmation: a single sighting may be in-flight state.
          if (record.seen_count < this.opts.minSightingsBeforeRepair) {
               this.logger.debug?.('issue seen once; waiting for confirmation', {
                    issueId: record.id,
                    kind: issue.kind,
               });
               return false;
          }

          const repairer = this.#repairerFor(issue.kind);
          if (!repairer) {
               await this.recon.query(
                    `UPDATE reconciliation_issues SET repair_status = 'AWAITING_HUMAN' WHERE id = $1`,
                    [record.id]
               );
               return false;
          }

          try {
               const outcome = await repairer(issue);
               await this.recon.query(
                    `UPDATE reconciliation_issues
                        SET repair_status = 'AUTO_REPAIRED', repair_detail = $2,
                            repaired_by = 'reconciliation-worker', resolved_at = now()
                      WHERE id = $1`,
                    [record.id, outcome.detail]
               );
               await this.#logRepair(record.id, issue, outcome, true);
               this.logger.info('issue repaired automatically', { issueId: record.id, kind: issue.kind });
               return true;
          } catch (err) {
               await this.#logRepair(record.id, issue, { detail: err.message }, true, 'FAILED');
               await this.recon.query(
                    `UPDATE reconciliation_issues SET repair_status = 'AWAITING_HUMAN', repair_detail = $2 WHERE id = $1`,
                    [record.id, `automatic repair failed: ${err.message}`]
               );
               return false;
          }
     }

     /**
      * The repair table.
      *
      * Only inventory-only, reversible actions appear here. Everything
      * financial is absent by design, not by oversight.
      */
     #repairerFor(kind) {
          const repairs = {
               /**
                * Expire an allocation whose TTL passed.
                *
                * Safe because it only returns inventory that was already owed
                * back to the pool, and the guarded UPDATE re-checks the
                * condition — if the hold was confirmed in the meantime, zero
                * rows change and nothing is broken.
                */
               EXPIRED_HOLD_STILL_ALLOCATED: async (issue) => {
                    const db = this.repairers.inventory;
                    if (!db) throw new Error('no write-capable inventory client configured');

                    const { rowCount } = await db.query(
                         `UPDATE allocations
                             SET state = 'EXPIRED', reason = 'reconciliation: TTL elapsed'
                           WHERE id = $1 AND state = 'HELD' AND expires_at < now()`,
                         [issue.entityId]
                    );
                    if (rowCount === 0) {
                         return { detail: 'no longer applicable; the allocation had already moved on' };
                    }

                    await db.query(
                         `INSERT INTO inventory_ledger
                                 (event_id, resource_id, entry_type, delta, allocation_id, hold_id, actor, reason)
                          VALUES ($1, $2, 'EXPIRED', 1, $3, $4, 'reconciliation-worker', 'TTL elapsed')`,
                         [
                              issue.context.eventId,
                              issue.context.resourceId,
                              issue.entityId,
                              issue.context.holdId,
                         ]
                    );

                    await db.query(
                         `UPDATE holds SET state = 'EXPIRED'
                           WHERE id = $1 AND state = 'ACTIVE'
                             AND NOT EXISTS (
                                  SELECT 1 FROM allocations a WHERE a.hold_id = holds.id AND a.state = 'HELD'
                             )`,
                         [issue.context.holdId]
                    );

                    return { detail: 'expired the allocation and returned the resource to the pool' };
               },

               /**
                * Nudge a stalled saga to run again.
                *
                * Safe because the saga's own steps are idempotent and its state
                * machine enforces legal transitions — the worst case is a step
                * re-executing harmlessly. Sagas in MANUAL_REVIEW are excluded:
                * they stopped on purpose.
                */
               STUCK_SAGA: async (issue) => {
                    if (issue.context.sagaState === 'MANUAL_REVIEW') {
                         throw new Error('MANUAL_REVIEW sagas are never re-driven automatically');
                    }
                    const db = this.repairers.reservation;
                    if (!db) throw new Error('no write-capable reservation client configured');

                    const { rowCount } = await db.query(
                         `UPDATE sagas
                             SET next_run_at = now(), lease_owner = NULL, lease_until = NULL,
                                 last_error = 'nudged by reconciliation'
                           WHERE id = $1 AND state NOT IN ('CONFIRMED','COMPENSATED','RELEASED','MANUAL_REVIEW')`,
                         [issue.entityId]
                    );
                    return {
                         detail:
                              rowCount > 0
                                   ? 'cleared the lease and scheduled the saga to run immediately'
                                   : 'saga had already reached a terminal state',
                    };
               },
          };

          return repairs[kind] ?? null;
     }

     async #logRepair(issueId, issue, outcome, automatic, result = 'SUCCESS') {
          await this.recon.query(
               `INSERT INTO repair_log (issue_id, action, automatic, actor, before, after, outcome, detail)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
               [
                    issueId,
                    issue.kind,
                    automatic,
                    automatic ? 'reconciliation-worker' : 'human',
                    JSON.stringify(issue.actual ?? null),
                    JSON.stringify(issue.expected ?? null),
                    result,
                    outcome.detail ?? null,
               ]
          );
     }

     /** Mark issues that no longer appear as having resolved themselves. */
     async #closeResolved(seenKeys) {
          const { rows } = await this.recon.query(
               `SELECT id, kind, entity_type, entity_id FROM reconciliation_issues
                 WHERE repair_status IN ('OPEN','AWAITING_HUMAN')`
          );

          const gone = rows.filter((r) => !seenKeys.has(`${r.kind}:${r.entity_type}:${r.entity_id}`));
          if (gone.length === 0) return;

          await this.recon.query(
               `UPDATE reconciliation_issues
                   SET repair_status = 'RESOLVED_ITSELF', resolved_at = now()
                 WHERE id = ANY($1::uuid[])`,
               [gone.map((g) => g.id)]
          );
          this.logger.info('issues resolved without intervention', { count: gone.length });
     }

     /** Capture the correctness scoreboard. */
     async #snapshot() {
          const { rows } = await this.recon.query(`SELECT * FROM scoreboard_current`);
          const s = rows[0];
          const metricsPayload = {
               critical_issues: Number(s.critical_issues),
               open_issues: Number(s.open_issues),
               duplicate_bookings: Number(s.duplicate_bookings),
               ledger_mismatches: Number(s.ledger_mismatches),
               orphaned_holds: Number(s.orphaned_holds),
               payments_without_booking: Number(s.payments_without_booking),
               stuck_sagas: Number(s.stuck_sagas),
          };
          const allClear = Object.values(metricsPayload).every((v) => v === 0);

          await this.recon.query(
               `INSERT INTO scoreboard_snapshots (metrics, all_clear) VALUES ($1, $2)`,
               [JSON.stringify(metricsPayload), allClear]
          );

          for (const [kind, count] of Object.entries(metricsPayload)) {
               metrics.reconciliationIssues.set({ severity: 'all', kind }, count);
          }
     }

     /** The live scoreboard, for the dashboard and for chaos assertions. */
     async scoreboard() {
          const { rows } = await this.recon.query(`SELECT * FROM scoreboard_current`);
          const s = rows[0];
          const counters = {
               oversells: Number(s.duplicate_bookings),
               duplicateBookings: Number(s.duplicate_bookings),
               orphanedHolds: Number(s.orphaned_holds),
               ledgerMismatches: Number(s.ledger_mismatches),
               paymentsWithoutBooking: Number(s.payments_without_booking),
               stuckSagas: Number(s.stuck_sagas),
               openIssues: Number(s.open_issues),
               criticalIssues: Number(s.critical_issues),
          };
          return {
               ...counters,
               allClear: Object.values(counters).every((v) => v === 0),
               lastRunAt: s.last_run_at,
          };
     }
}

module.exports = { ReconciliationWorker };
