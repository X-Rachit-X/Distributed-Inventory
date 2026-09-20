'use strict';

/**
 * Hold expiry sweeper.
 *
 * WHY THIS IS NOT LOAD-BEARING. Reserve already reaps expired holds for the
 * resources it touches, inside its own transaction. So a customer is never
 * wrongly denied a seat because this worker is down. What the sweeper adds is
 * *freshness*: it returns abandoned inventory to the availability projection
 * promptly, so browsing users see a seat come back rather than waiting for
 * someone to try reserving it. That distinction is the difference between a
 * background job whose failure is a correctness incident and one whose failure
 * is a visible-but-safe degradation.
 *
 * HOW IT CLAIMS WORK. `FOR UPDATE SKIP LOCKED` over a bounded batch. Each
 * worker locks a disjoint set of rows and skips anything another worker holds,
 * so N replicas do N times the work with no coordination, no leader election
 * and no distributed lock.
 *
 * This deliberately replaces the previous design, which elected a leader via a
 * session-level `pg_try_advisory_lock` taken through a connection pool. That
 * had two defects: the unlock could land on a different pooled connection than
 * the lock, leaking it until the session ended; and a single leader made the
 * sweeper a throughput bottleneck and a single point of failure. SKIP LOCKED
 * needs neither a leader nor a lock that outlives a transaction.
 *
 * CRASH SAFETY. All work happens inside one transaction. A crash mid-batch
 * rolls back and the rows become claimable again the moment the connection
 * drops. There is no lease to expire and no partial state to repair.
 */

const ledger = require('../engine/ledger');
const { enqueue, nextSeq } = require('@tessera/shared/src/outbox/writer');
const { failpoint } = require('@tessera/shared/src/failpoints');
const { metrics } = require('@tessera/shared/src/observability/metrics');

const DEFAULTS = {
     batchSize: 200,
     intervalMs: 5_000,
     idleIntervalMs: 15_000,
};

class ExpiryWorker {
     constructor({ pool, logger, options = {} }) {
          this.pool = pool;
          this.logger = logger;
          this.opts = { ...DEFAULTS, ...options };
          this.running = false;
          this.timer = null;
     }

     start() {
          if (this.running) return;
          this.running = true;
          this.logger.info('hold expiry worker started', { batchSize: this.opts.batchSize });
          this.#loop();
     }

     stop() {
          this.running = false;
          if (this.timer) clearTimeout(this.timer);
          this.logger.info('hold expiry worker stopped');
     }

     async #loop() {
          while (this.running) {
               let swept = 0;
               try {
                    swept = await this.sweep();
               } catch (err) {
                    this.logger.error('expiry sweep failed', { error: err.message });
               }
               const delay = swept > 0 ? this.opts.intervalMs : this.opts.idleIntervalMs;
               await new Promise((resolve) => {
                    this.timer = setTimeout(resolve, delay);
                    this.timer.unref?.();
               });
          }
     }

     /** One batch. Returns how many holds were expired. */
     async sweep() {
          return this.pool.withTransaction(async (client) => {
               // Claim a batch of due holds. SKIP LOCKED means a concurrent
               // worker's rows are stepped over rather than waited on.
               const { rows: due } = await client.query(
                    `SELECT id, event_id, customer_id, created_at, expires_at
                       FROM holds
                      WHERE state = 'ACTIVE' AND expires_at <= now()
                      ORDER BY expires_at
                        FOR UPDATE SKIP LOCKED
                      LIMIT $1`,
                    [this.opts.batchSize]
               );

               if (due.length === 0) return 0;

               const holdIds = due.map((h) => h.id);

               // Chaos scenario: crash after claiming, before committing.
               // Expected recovery — the transaction rolls back, the locks drop
               // and another worker claims the same holds on its next pass.
               await failpoint('expiry.after_claim_before_commit');

               const { rows: expiredAllocations } = await client.query(
                    `UPDATE allocations SET state = 'EXPIRED', reason = 'hold_ttl_elapsed'
                      WHERE hold_id = ANY($1::uuid[]) AND state = 'HELD'
                  RETURNING id, event_id, resource_id, hold_id, span`,
                    [holdIds]
               );

               const { rows: expiredClaims } = await client.query(
                    `UPDATE pool_claims SET state = 'EXPIRED', updated_at = now()
                      WHERE hold_id = ANY($1::uuid[]) AND state = 'HELD'
                  RETURNING pool_id, bucket, quantity, hold_id`,
                    [holdIds]
               );
               for (const claim of expiredClaims) {
                    await client.query(
                         `UPDATE pool_buckets SET held = held - $3 WHERE pool_id = $1 AND bucket = $2`,
                         [claim.pool_id, claim.bucket, claim.quantity]
                    );
               }

               await client.query(`UPDATE holds SET state = 'EXPIRED' WHERE id = ANY($1::uuid[])`, [holdIds]);

               await ledger.append(client, [
                    ...expiredAllocations.map((a) => ({
                         eventId: a.event_id,
                         resourceId: a.resource_id,
                         span: a.span,
                         entryType: 'EXPIRED',
                         delta: +1,
                         allocationId: a.id,
                         holdId: a.hold_id,
                         actor: 'system:expiry-worker',
                         reason: 'hold_ttl_elapsed',
                    })),
                    ...expiredClaims.map((c) => ({
                         eventId: due.find((h) => h.id === c.hold_id)?.event_id,
                         poolId: c.pool_id,
                         bucket: c.bucket,
                         entryType: 'EXPIRED',
                         delta: +c.quantity,
                         holdId: c.hold_id,
                         actor: 'system:expiry-worker',
                         reason: 'hold_ttl_elapsed',
                    })),
               ]);

               // One event per affected inventory event, so the availability
               // projection can refresh. Grouped rather than per-allocation:
               // a sweep of 200 holds on one train should not emit 200 events.
               const byEvent = new Map();
               for (const a of expiredAllocations) {
                    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, []);
                    byEvent.get(a.event_id).push(a.resource_id);
               }
               for (const [eventId, resourceIds] of byEvent) {
                    const seq = await nextSeq(client, eventId);
                    await enqueue(client, {
                         topic: 'inventory.events',
                         type: 'inventory.expired',
                         aggregateId: eventId,
                         aggregateSeq: seq,
                         payload: {
                              event_id: eventId,
                              reason: 'hold_ttl_elapsed',
                              expired_count: resourceIds.length,
                              resource_ids: resourceIds,
                         },
                    });
               }

               metrics.holdsExpired.inc({ reaped_by: 'sweeper' }, due.length);
               for (const h of due) {
                    metrics.holdDuration.observe(
                         { outcome: 'expired' },
                         (Date.now() - new Date(h.created_at).getTime()) / 1000
                    );
               }

               this.logger.info('expired holds swept', {
                    holds: due.length,
                    allocations: expiredAllocations.length,
                    poolClaims: expiredClaims.length,
               });

               return due.length;
          });
     }
}

module.exports = { ExpiryWorker };
