'use strict';

/**
 * Kafka consumer runner.
 *
 * Every consumer in Tessera starts through here, so they share one behaviour:
 *
 *   - a named consumer GROUP, so several replicas split the partitions between
 *     them and the topic's partition count is the ceiling on parallelism;
 *   - `eachMessage` wrapped in `withDLQ`: parse, validate against the event
 *     contract, upcast to the version this consumer reads, count attempts in the
 *     database, and dead-letter a poison message instead of stalling the
 *     partition behind it;
 *   - offsets committed only after the handler returns, which is what makes
 *     delivery at-least-once rather than at-most-once;
 *   - a clean disconnect on shutdown, so the group rebalances immediately
 *     instead of waiting out the session timeout.
 *
 * Consumer lag is exported as a metric by polling the group's committed offsets
 * against the topic's end offsets. Lag is the number that says whether a
 * consumer is keeping up; throughput alone does not.
 */

const { Kafka, logLevel } = require('kafkajs');
const { withDLQ } = require('./index');
const { metrics, client: promClient, registry } = require('../observability/metrics');
const { kafkaSecurityOptions } = require('../config/kafka');

const consumerLag = new promClient.Gauge({
     name: 'tessera_kafka_consumer_lag',
     help: 'Messages behind the end of the topic, per consumer group and partition',
     labelNames: ['group', 'topic', 'partition'],
     registers: [registry],
});

/**
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.groupId       Stable. Changing it replays the topic from the start.
 * @param {string[]} opts.topics
 * @param {string} opts.brokers       Comma-separated.
 * @param {import('pg').Pool} opts.pool  The consumer's own database (dedupe, attempts, DLQ).
 * @param {(envelope, meta) => Promise<void>} opts.handle
 * @param {object} opts.logger
 * @param {number} [opts.readerVersion]  Event version this consumer understands.
 */
async function startConsumer({
     clientId,
     groupId,
     topics,
     brokers,
     pool,
     handle,
     logger,
     readerVersion = null,
     maxAttempts = 5,
     fromBeginning = true,
}) {
     const kafka = new Kafka({
          clientId,
          brokers: brokers.split(','),
          ...kafkaSecurityOptions(),
          logLevel: logLevel.WARN,
          retry: { retries: 10, initialRetryTime: 300 },
     });

     const consumer = kafka.consumer({ groupId, sessionTimeout: 30_000, heartbeatInterval: 3_000 });
     const producer = kafka.producer();
     const admin = kafka.admin();

     await Promise.all([consumer.connect(), producer.connect(), admin.connect()]);
     for (const topic of topics) {
          await consumer.subscribe({ topic, fromBeginning });
     }

     await consumer.run({
          // Commit after the handler resolves. A crash mid-handler therefore
          // redelivers the message, and the dedupe table absorbs the repeat.
          autoCommit: true,
          eachMessage: withDLQ({
               pool,
               consumerName: groupId,
               logger,
               producer,
               // DLQ topic mirrors the source topic's name.
               dlqTopic: `${topics[0]}.dlq`,
               handle,
               maxAttempts,
               readerVersion,
          }),
     });

     logger.info('consumer running', { groupId, topics });

     // Lag sampler.
     const lagTimer = setInterval(async () => {
          try {
               for (const topic of topics) {
                    const [ends, committed] = await Promise.all([
                         admin.fetchTopicOffsets(topic),
                         admin.fetchOffsets({ groupId, topics: [topic] }),
                    ]);
                    const committedByPartition = new Map(
                         (committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)])
                    );
                    for (const end of ends) {
                         const done = committedByPartition.get(end.partition);
                         // -1 means nothing committed yet: the whole partition is lag.
                         const lag = Number(end.offset) - (done === undefined || done < 0 ? 0 : done);
                         consumerLag.set({ group: groupId, topic, partition: String(end.partition) }, Math.max(0, lag));
                    }
               }
          } catch {
               /* the broker being briefly unreachable must not crash the consumer */
          }
     }, 5_000);
     lagTimer.unref?.();

     return {
          consumer,
          producer,
          async stop() {
               clearInterval(lagTimer);
               await consumer.disconnect().catch(() => {});
               await producer.disconnect().catch(() => {});
               await admin.disconnect().catch(() => {});
          },
          /** Current lag, summed across partitions — used by the HTTP status endpoint. */
          async lag() {
               let total = 0;
               for (const topic of topics) {
                    const [ends, committed] = await Promise.all([
                         admin.fetchTopicOffsets(topic),
                         admin.fetchOffsets({ groupId, topics: [topic] }),
                    ]);
                    const done = new Map((committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]));
                    for (const end of ends) {
                         const d = done.get(end.partition);
                         total += Math.max(0, Number(end.offset) - (d === undefined || d < 0 ? 0 : d));
                    }
               }
               return total;
          },
     };
}

module.exports = { startConsumer, metrics };
