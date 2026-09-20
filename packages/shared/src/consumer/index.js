'use strict';

/**
 * Idempotent Kafka consumer with a durable dead-letter queue.
 *
 * On delivery semantics, stated plainly because it is the single most
 * misrepresented claim in event-driven systems:
 *
 *   Kafka does NOT give application-level exactly-once. Its "exactly-once
 *   semantics" covers Kafka-to-Kafka stream processing with transactional
 *   offsets. The moment a handler writes to PostgreSQL or calls a payment
 *   provider, that guarantee does not reach the side effect.
 *
 *   What this system uses instead:
 *
 *       at-least-once delivery  +  idempotent consumer  =  effectively-once effect
 *
 *   The dedupe row is written in the SAME TRANSACTION as the business effect.
 *   That is what makes it airtight: either both happen or neither does, so a
 *   redelivery after a crash finds the marker and skips.
 *
 * Out-of-order delivery is handled separately, by `aggregate_seq`. Ordering is
 * only guaranteed within a partition; a retry, a rebalance or a relay race can
 * still reorder. A handler that declares a `projection` is protected by a
 * monotonic sequence check.
 */

const { validate, upcast } = require('../events/registry');
const { metrics } = require('../observability/metrics');
const { failpoint } = require('../failpoints');

/**
 * Deduplicating transactional handler.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {string} deps.consumerName  Stable identity; changing it replays history.
 * @param {object} deps.logger
 * @returns {(envelope: object, handler: (client, envelope) => Promise<void>, opts?: object) => Promise<'PROCESSED'|'DUPLICATE'|'STALE'>}
 */
function createIdempotentHandler({ pool, consumerName, logger }) {
     return async function handleOnce(envelope, handler, opts = {}) {
          return pool.withTransaction(async (client) => {
               // Claim the event. ON CONFLICT DO NOTHING makes the check and the
               // claim one atomic step; a plain SELECT-then-INSERT would let two
               // concurrent deliveries both pass the check.
               const { rows } = await client.query(
                    `INSERT INTO processed_events (consumer, event_id, event_type, aggregate_id, aggregate_seq)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (consumer, event_id) DO NOTHING
                     RETURNING event_id`,
                    [
                         consumerName,
                         envelope.event_id,
                         envelope.event_type,
                         envelope.aggregate_id,
                         envelope.aggregate_seq,
                    ]
               );

               if (rows.length === 0) {
                    metrics.duplicateEvents.inc({
                         consumer: consumerName,
                         event_type: envelope.event_type,
                    });
                    logger.debug('duplicate event skipped', {
                         eventId: envelope.event_id,
                         eventType: envelope.event_type,
                    });
                    return 'DUPLICATE';
               }

               // Staleness guard for projections: drop an event whose aggregate
               // sequence is not newer than what we already applied.
               if (opts.projection && envelope.aggregate_seq != null) {
                    const { rows: seqRows } = await client.query(
                         `INSERT INTO projection_offsets (consumer, aggregate_id, last_seq)
                          VALUES ($1, $2, $3)
                          ON CONFLICT (consumer, aggregate_id) DO UPDATE
                               SET last_seq = EXCLUDED.last_seq
                             WHERE projection_offsets.last_seq < EXCLUDED.last_seq
                          RETURNING last_seq`,
                         [consumerName, envelope.aggregate_id, envelope.aggregate_seq]
                    );
                    if (seqRows.length === 0) {
                         metrics.staleEvents.inc({
                              consumer: consumerName,
                              event_type: envelope.event_type,
                         });
                         logger.debug('stale event discarded', {
                              eventId: envelope.event_id,
                              aggregateId: envelope.aggregate_id,
                              aggregateSeq: envelope.aggregate_seq,
                         });
                         return 'STALE';
                    }
               }

               await handler(client, envelope);

               // Chaos scenario: effect and marker are committed together, but
               // we die before the offset commit. Expected recovery — redelivery
               // finds the marker and skips.
               await failpoint('consumer.after_handle_before_commit');

               return 'PROCESSED';
          });
     };
}

/**
 * Wrap a KafkaJS `eachMessage` with parsing, schema validation, upcasting,
 * retry accounting and dead-lettering.
 *
 * Retry counts live in the database, not in a Map. An in-memory counter resets
 * on every restart and every consumer-group rebalance, so a poison message can
 * loop forever while appearing to be on its first attempt.
 */
function withDLQ({ pool, consumerName, logger, dlqTopic, producer, maxAttempts = 5, readerVersion = null }) {
     return async function eachMessage({ topic, partition, message, heartbeat }) {
          const raw = message.value?.toString();
          let envelope;

          try {
               envelope = JSON.parse(raw);
          } catch (err) {
               await deadLetter({
                    pool,
                    producer,
                    dlqTopic,
                    consumerName,
                    logger,
                    topic,
                    partition,
                    message,
                    reason: 'MALFORMED_JSON',
                    error: err,
                    attempts: 1,
               });
               return;
          }

          try {
               validate(envelope);
               if (readerVersion && envelope.event_version < readerVersion) {
                    envelope = upcast(envelope, readerVersion);
               }
          } catch (err) {
               await deadLetter({
                    pool,
                    producer,
                    dlqTopic,
                    consumerName,
                    logger,
                    topic,
                    partition,
                    message,
                    reason: 'SCHEMA_INVALID',
                    error: err,
                    attempts: 1,
                    envelope,
               });
               return;
          }

          const attempts = await bumpAttempts(pool, consumerName, envelope.event_id);

          try {
               await this.handle(envelope, { topic, partition, heartbeat });
               await clearAttempts(pool, consumerName, envelope.event_id);
               metrics.eventsConsumed.inc({
                    consumer: consumerName,
                    event_type: envelope.event_type,
                    outcome: 'ok',
               });
          } catch (err) {
               metrics.eventsConsumed.inc({
                    consumer: consumerName,
                    event_type: envelope.event_type,
                    outcome: 'error',
               });

               if (attempts >= maxAttempts) {
                    await deadLetter({
                         pool,
                         producer,
                         dlqTopic,
                         consumerName,
                         logger,
                         topic,
                         partition,
                         message,
                         reason: 'MAX_ATTEMPTS_EXCEEDED',
                         error: err,
                         attempts,
                         envelope,
                    });
                    await clearAttempts(pool, consumerName, envelope.event_id);
                    return; // move on; the partition must not stall on one bad event
               }

               logger.warn('event processing failed, will be redelivered', {
                    eventId: envelope.event_id,
                    eventType: envelope.event_type,
                    attempts,
                    maxAttempts,
                    error: err.message,
               });
               throw err; // let KafkaJS redeliver
          }
     };
}

async function bumpAttempts(pool, consumer, eventId) {
     const { rows } = await pool.query(
          `INSERT INTO consumer_attempts (consumer, event_id, attempts, last_attempt_at)
           VALUES ($1, $2, 1, now())
           ON CONFLICT (consumer, event_id) DO UPDATE
                SET attempts = consumer_attempts.attempts + 1, last_attempt_at = now()
           RETURNING attempts`,
          [consumer, eventId]
     );
     return rows[0].attempts;
}

const clearAttempts = (pool, consumer, eventId) =>
     pool.query('DELETE FROM consumer_attempts WHERE consumer = $1 AND event_id = $2', [consumer, eventId]);

/**
 * Record a poison message durably and forward it to the DLQ topic.
 *
 * The database row is what makes replay possible: it keeps the full payload,
 * the failure reason, the stack, the attempt count and the original
 * topic/partition/offset, so an operator can fix the bug and re-drive it.
 */
async function deadLetter({
     pool,
     producer,
     dlqTopic,
     consumerName,
     logger,
     topic,
     partition,
     message,
     reason,
     error,
     attempts,
     envelope = null,
}) {
     const payload = message.value?.toString() ?? null;

     try {
          await pool.query(
               `INSERT INTO dead_letters
                      (consumer, event_id, event_type, source_topic, source_partition, source_offset,
                       payload, reason, error_message, error_stack, attempts)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (consumer, event_id) DO UPDATE
                     SET attempts = EXCLUDED.attempts,
                         error_message = EXCLUDED.error_message,
                         error_stack = EXCLUDED.error_stack,
                         reason = EXCLUDED.reason,
                         status = 'OPEN',
                         updated_at = now()`,
               [
                    consumerName,
                    envelope?.event_id ?? `raw:${topic}:${partition}:${message.offset}`,
                    envelope?.event_type ?? null,
                    topic,
                    partition,
                    message.offset,
                    payload,
                    reason,
                    String(error.message).slice(0, 2000),
                    String(error.stack ?? '').slice(0, 8000),
                    attempts,
               ]
          );
     } catch (dbErr) {
          logger.error('failed to persist dead letter', { error: dbErr.message });
     }

     if (producer && dlqTopic) {
          try {
               await producer.send({
                    topic: dlqTopic,
                    messages: [
                         {
                              key: message.key,
                              value: message.value,
                              headers: {
                                   ...message.headers,
                                   'dlq-consumer': consumerName,
                                   'dlq-reason': reason,
                                   'dlq-error': String(error.message).slice(0, 500),
                                   'dlq-source-topic': topic,
                                   'dlq-source-partition': String(partition),
                                   'dlq-source-offset': String(message.offset),
                                   'dlq-attempts': String(attempts),
                                   'dlq-at': new Date().toISOString(),
                              },
                         },
                    ],
               });
          } catch (kErr) {
               logger.error('failed to forward to DLQ topic', { error: kErr.message });
          }
     }

     metrics.dlqMessages.inc({ consumer: consumerName, reason });
     logger.error('message dead-lettered', {
          consumer: consumerName,
          reason,
          topic,
          partition,
          offset: message.offset,
          attempts,
          error: error.message,
     });
}

/**
 * Replay dead letters back onto their original topic after a fix.
 * The dedupe table still protects against double effects, so replaying an
 * event that did partially succeed is safe.
 */
async function replayDeadLetters({ pool, producer, consumerName, ids = null, limit = 100, logger }) {
     const { rows } = await pool.query(
          `SELECT id, event_id, source_topic, payload
             FROM dead_letters
            WHERE consumer = $1 AND status = 'OPEN'
              AND ($2::bigint[] IS NULL OR id = ANY($2))
            ORDER BY id
            LIMIT $3`,
          [consumerName, ids, limit]
     );

     let replayed = 0;
     for (const row of rows) {
          try {
               const env = JSON.parse(row.payload);
               await producer.send({
                    topic: row.source_topic,
                    messages: [{ key: env.aggregate_id ?? null, value: row.payload }],
               });
               await pool.query(
                    `UPDATE dead_letters SET status = 'REPLAYED', replayed_at = now(), updated_at = now() WHERE id = $1`,
                    [row.id]
               );
               replayed += 1;
          } catch (err) {
               logger?.error('replay failed', { id: row.id, error: err.message });
          }
     }
     return { replayed, considered: rows.length };
}

module.exports = { createIdempotentHandler, withDLQ, deadLetter, replayDeadLetters };
