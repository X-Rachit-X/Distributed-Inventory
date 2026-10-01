'use strict';

/**
 * UNKNOWN-payment resolver.
 *
 * The most important background worker in the system. Every row it processes is
 * money whose fate is genuinely undetermined: the provider may have charged the
 * customer, or may not have, and we cannot tell from here.
 *
 * It never guesses and never retries the charge. It asks the provider, using our
 * own idempotency key as the reference, and records whatever the provider says.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` so several replicas can run without two
 * of them resolving the same payment — which would be harmless here (the query
 * is read-only at the provider) but would double the API calls against a
 * provider that is, by hypothesis, already having a bad day.
 */

const { metrics } = require('@tessera/shared/src/observability/metrics');
const { STALE_CREATED_SECONDS } = require('../service/payment.service');

class ResolverWorker {
     constructor({ pool, payments, logger, options = {} }) {
          this.pool = pool;
          this.payments = payments;
          this.logger = logger;
          this.opts = { intervalMs: 2_000, batchSize: 20, ...options };
          this.timer = null;
          this.running = false;
     }

     start() {
          if (this.running) return;
          this.running = true;
          this.logger.info('payment resolver started', { intervalMs: this.opts.intervalMs });
          this.#loop();
     }

     stop() {
          this.running = false;
          if (this.timer) clearTimeout(this.timer);
          this.logger.info('payment resolver stopped');
     }

     async #loop() {
          while (this.running) {
               let handled = 0;
               try {
                    handled = await this.tick();
               } catch (err) {
                    this.logger.error('resolver tick failed', { error: err.message });
               }
               await new Promise((resolve) => {
                    this.timer = setTimeout(resolve, handled > 0 ? 250 : this.opts.intervalMs);
                    this.timer.unref?.();
               });
          }
     }

     async tick() {
          // Claim due payments. The row lock is released when this short
          // transaction ends; the actual provider call happens outside it, so a
          // slow provider never holds a database connection.
          const { rows: due } = await this.pool.withTransaction(async (client) =>
               client.query(
                    // UNKNOWN payments that are due, plus CREATED payments that
                    // were abandoned mid-charge (the process died after
                    // committing the row). Both mean "ask the provider".
                    `SELECT id FROM payments
                      WHERE (state = 'UNKNOWN' AND (next_resolve_at IS NULL OR next_resolve_at <= now()))
                         OR (state = 'CREATED' AND created_at < now() - ($2 || ' seconds')::interval)
                      ORDER BY COALESCE(unknown_since, created_at)
                        FOR UPDATE SKIP LOCKED
                      LIMIT $1`,
                    [this.opts.batchSize, String(STALE_CREATED_SECONDS)]
               )
          );

          if (due.length === 0) {
               const { rows } = await this.pool.query(
                    `SELECT count(*)::int AS n FROM payments WHERE state = 'UNKNOWN'`
               );
               metrics.paymentUnknown.set(rows[0].n);
               return 0;
          }

          let resolved = 0;
          for (const payment of due) {
               try {
                    const result = await this.payments.resolveUnknown(payment.id);
                    if (result.resolved) {
                         resolved += 1;
                         this.logger.info('indeterminate payment resolved', {
                              paymentId: payment.id,
                              state: result.state,
                         });
                    }
               } catch (err) {
                    this.logger.error('failed to resolve payment', {
                         paymentId: payment.id,
                         error: err.message,
                    });
               }
          }

          const { rows } = await this.pool.query(
               `SELECT count(*)::int AS n FROM payments WHERE state = 'UNKNOWN'`
          );
          metrics.paymentUnknown.set(rows[0].n);

          return resolved;
     }
}

module.exports = { ResolverWorker };
