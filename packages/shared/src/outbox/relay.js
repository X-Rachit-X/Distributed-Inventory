'use strict';

/**
 * Transactional outbox — relay side.
 *
 * Moves committed outbox rows to Kafka. Three properties matter.
 *
 * 1. NEVER LOSE. The publish happens outside any database transaction, and the
 *    row is only marked PUBLISHED afterwards. A crash in between re-publishes
 *    the event — at-least-once, which consumers deduplicate. The inverse design
 *    (mark first, publish after) would be at-most-once, i.e. silent loss.
 *
 * 2. NEVER HOLD A CONNECTION ACROSS THE NETWORK. Claiming rows and marking them
 *    published are two short transactions with the Kafka round trip between
 *    them. Holding a transaction open across a broker call is how an unhealthy
 *    Kafka becomes database connection exhaustion.
 *
 * 3. PRESERVE PER-AGGREGATE ORDER. Several relay replicas claiming with
 *    SKIP LOCKED can otherwise publish event #2 of a reservation before event
 *    #1: two workers grab both rows, and the second one wins the race to Kafka.
 *    The claim query therefore takes only the head-of-line pending event per
 *    aggregate. Ordering across different aggregates is not constrained, which
 *    is what allows the relay to stay parallel.
 *
 * Kafka being down is not an error condition: rows stay PENDING and the relay
 * catches up when the broker returns. That is the whole point of the pattern.
 */

const { failpoint } = require('../failpoints');
const { metrics } = require('../observability/metrics');
const { toHeaders } = require('../events/envelope');

const DEFAULTS = {
     batchSize: 100,
     pollIntervalMs: 250,
     idlePollIntervalMs: 1_000,
     maxAttempts: 10,
     leaseSeconds: 30,
     baseBackoffMs: 100,
     maxBackoffMs: 60_000,
};

class OutboxRelay {
     /**
      * @param {object} deps
      * @param {import('pg').Pool} deps.pool
      * @param {import('kafkajs').Producer} deps.producer
      * @param {object} deps.logger
      * @param {string} deps.service     Label for metrics.
      * @param {object} [deps.options]
      */
     constructor({ pool, producer, logger, service, options = {} }) {
          this.pool = pool;
          this.producer = producer;
          this.logger = logger;
          this.service = service;
          this.opts = { ...DEFAULTS, ...options };
          this.workerId = `${service}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
          this.running = false;
          this.timer = null;
     }

     start() {
          if (this.running) return;
          this.running = true;
          this.logger.info('outbox relay started', { workerId: this.workerId });
          this.#loop();
     }

     async stop() {
          this.running = false;
          if (this.timer) clearTimeout(this.timer);
          // Release our leases so another replica picks the work up immediately
          // rather than waiting for them to expire.
          await this.pool
               .query(
                    `UPDATE outbox_events SET lease_owner = NULL, lease_until = NULL
                      WHERE lease_owner = $1 AND status = 'PENDING'`,
                    [this.workerId]
               )
               .catch(() => {});
          this.logger.info('outbox relay stopped', { workerId: this.workerId });
     }

     async #loop() {
          while (this.running) {
               let published = 0;
               try {
                    published = await this.tick();
               } catch (err) {
                    this.logger.error('outbox relay tick failed', { error: err.message });
               }
               const delay = published > 0 ? this.opts.pollIntervalMs : this.opts.idlePollIntervalMs;
               await new Promise((resolve) => {
                    this.timer = setTimeout(resolve, delay);
                    this.timer.unref?.();
               });
          }
     }

     /** One claim → publish → mark cycle. Returns the number published. */
     async tick() {
          const batch = await this.#claim();
          if (batch.length === 0) {
               await this.#reportPending();
               return 0;
          }

          let published = 0;
          for (const row of batch) {
               try {
                    await this.#publishOne(row);
                    published += 1;
               } catch (err) {
                    await this.#recordFailure(row, err);
               }
          }
          return published;
     }

     /**
      * Claim a batch under a lease.
      *
      * The `NOT EXISTS` clause is the ordering guard: a row is only claimable if
      * no older pending row exists for the same aggregate. Combined with
      * SKIP LOCKED this yields "parallel across aggregates, strictly sequential
      * within one".
      */
     async #claim() {
          const { rows } = await this.pool.query(
               `WITH claimable AS (
                    SELECT o.id
                      FROM outbox_events o
                     WHERE o.status = 'PENDING'
                       AND o.next_attempt_at <= now()
                       AND (o.lease_until IS NULL OR o.lease_until < now())
                       AND NOT EXISTS (
                            SELECT 1 FROM outbox_events older
                             WHERE older.aggregate_id = o.aggregate_id
                               AND older.status = 'PENDING'
                               AND older.id < o.id
                       )
                     ORDER BY o.id
                     FOR UPDATE SKIP LOCKED
                     LIMIT $1
               )
               UPDATE outbox_events o
                  SET lease_owner = $2,
                      lease_until = now() + ($3 || ' seconds')::interval,
                      attempt_count = o.attempt_count + 1
                 FROM claimable c
                WHERE o.id = c.id
            RETURNING o.id, o.event_id, o.topic, o.event_type, o.event_version,
                      o.aggregate_id, o.aggregate_seq, o.payload, o.correlation_id,
                      o.causation_id, o.trace_id, o.attempt_count, o.created_at`,
               [this.opts.batchSize, this.workerId, String(this.opts.leaseSeconds)]
          );
          return rows;
     }

     async #publishOne(row) {
          const envelope = {
               event_id: row.event_id,
               event_type: row.event_type,
               event_version: row.event_version,
               aggregate_id: row.aggregate_id,
               aggregate_seq: row.aggregate_seq,
               occurred_at: row.created_at.toISOString(),
               correlation_id: row.correlation_id,
               causation_id: row.causation_id,
               trace_id: row.trace_id,
               payload: row.payload,
          };

          // Chaos scenario: the row is committed, but we die before it reaches
          // Kafka. Expected recovery — it stays PENDING and is retried.
          await failpoint('outbox.before_publish');

          await this.producer.send({
               topic: row.topic,
               messages: [
                    {
                         key: row.aggregate_id,
                         value: JSON.stringify(envelope),
                         headers: toHeaders(envelope),
                    },
               ],
          });

          // Chaos scenario: Kafka accepted the event, but we die before marking
          // it. Expected recovery — the event is published twice and consumers
          // deduplicate it. This is why consumer dedupe is mandatory, not optional.
          await failpoint('outbox.after_publish_before_mark');

          await this.pool.query(
               `UPDATE outbox_events
                   SET status = 'PUBLISHED', published_at = now(), lease_owner = NULL, lease_until = NULL
                 WHERE id = $1`,
               [row.id]
          );

          const latencySec = (Date.now() - row.created_at.getTime()) / 1000;
          metrics.outboxPublishLatency.observe(
               { service: this.service, event_type: row.event_type },
               latencySec
          );
          metrics.outboxPublished.inc({ service: this.service, event_type: row.event_type });
     }

     /** Back off, or dead-letter a poison event that will never succeed. */
     async #recordFailure(row, err) {
          const attempts = row.attempt_count;
          const isPoison = attempts >= this.opts.maxAttempts;

          if (isPoison) {
               await this.pool.query(
                    `UPDATE outbox_events
                        SET status = 'DEAD_LETTER', last_error = $2, lease_owner = NULL, lease_until = NULL
                      WHERE id = $1`,
                    [row.id, String(err.message).slice(0, 2000)]
               );
               this.logger.error('outbox event dead-lettered', {
                    eventId: row.event_id,
                    eventType: row.event_type,
                    attempts,
                    error: err.message,
               });
               metrics.dlqMessages.inc({ consumer: `${this.service}-outbox`, reason: 'publish_failed' });
               return;
          }

          // Full jitter: a broker outage resolves into a spread of retries
          // rather than every relay replica hammering it on the same tick.
          const ceiling = Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** attempts);
          const delayMs = Math.floor(Math.random() * ceiling);

          await this.pool.query(
               `UPDATE outbox_events
                   SET next_attempt_at = now() + ($2 || ' milliseconds')::interval,
                       last_error = $3, lease_owner = NULL, lease_until = NULL
                 WHERE id = $1`,
               [row.id, String(delayMs), String(err.message).slice(0, 2000)]
          );

          this.logger.warn('outbox publish failed, will retry', {
               eventId: row.event_id,
               attempts,
               delayMs,
               error: err.message,
          });
     }

     async #reportPending() {
          const { rows } = await this.pool.query(
               `SELECT count(*)::int AS pending FROM outbox_events WHERE status = 'PENDING'`
          );
          metrics.outboxPending.set({ service: this.service }, rows[0].pending);
     }
}

module.exports = { OutboxRelay };

/**
 * Connect a Kafka producer and start a relay for one service.
 *
 * Every service with an outbox starts its relay the same way, so the wiring
 * lives here rather than being copied into each `index.js`. Kafka being
 * unreachable at boot is deliberately not fatal: outbox rows simply stay
 * PENDING, and the relay catches up once it is started against a live broker.
 *
 * @returns {Promise<{relay: OutboxRelay, producer: object, stop: () => Promise<void>} | null>}
 *   null when Kafka is not configured or not reachable.
 */
async function startOutboxRelay({ pool, logger, service, brokers, clientId = service }) {
     if (!brokers) {
          logger.warn('KAFKA_BROKERS not set; outbox relay disabled. Events will accumulate as PENDING.');
          return null;
     }
     const { Kafka } = require('kafkajs');
     const { kafkaSecurityOptions } = require('../config/kafka');
     const kafka = new Kafka({ clientId, brokers: brokers.split(','), retry: { retries: 8 }, ...kafkaSecurityOptions() });
     // Idempotent producer with one request in flight: Kafka itself drops a
     // retried duplicate and cannot reorder two sends from this relay.
     const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
     try {
          await producer.connect();
     } catch (err) {
          logger.error('outbox relay failed to start; events will accumulate as PENDING', { error: err.message });
          return null;
     }
     const relay = new OutboxRelay({ pool, producer, logger, service });
     relay.start();
     return {
          relay,
          producer,
          async stop() {
               await relay.stop();
               await producer.disconnect().catch(() => {});
          },
     };
}

module.exports.startOutboxRelay = startOutboxRelay;
