'use strict';

/**
 * Saga worker loop.
 *
 * Thin by design: the orchestrator holds all the logic, and this only decides
 * how often to ask for work. It polls faster while there is work and backs off
 * when idle, so an empty system is not doing constant database round trips
 * while a busy one stays responsive.
 */

class SagaWorker {
     constructor({ orchestrator, logger, options = {} }) {
          this.orchestrator = orchestrator;
          this.logger = logger;
          this.opts = { intervalMs: 250, idleIntervalMs: 1_000, batchSize: 20, ...options };
          this.running = false;
          this.timer = null;
     }

     start() {
          if (this.running) return;
          this.running = true;
          this.logger.info('saga worker started', { workerId: this.orchestrator.workerId });
          this.#loop();
     }

     async stop() {
          this.running = false;
          if (this.timer) clearTimeout(this.timer);
          // Release leases held by this worker so another replica can take the
          // sagas immediately, instead of waiting for the lease to expire.
          await this.orchestrator.releaseLeases?.().catch(() => {});
          this.logger.info('saga worker stopped');
     }

     async #loop() {
          while (this.running) {
               let worked = 0;
               try {
                    worked = await this.orchestrator.tick({ batchSize: this.opts.batchSize });
               } catch (err) {
                    this.logger.error('saga tick failed', { error: err.message });
               }
               await new Promise((resolve) => {
                    this.timer = setTimeout(resolve, worked > 0 ? this.opts.intervalMs : this.opts.idleIntervalMs);
                    this.timer.unref?.();
               });
          }
     }
}

module.exports = { SagaWorker };
