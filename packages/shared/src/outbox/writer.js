'use strict';

/**
 * Transactional outbox — write side.
 *
 * The problem: a service must both change its database and tell the world.
 * Doing them as two operations is a dual write, and a dual write has no correct
 * ordering:
 *
 *     COMMIT; publish()   → crash between them loses the event forever
 *     publish(); COMMIT   → rollback leaves a lie on the bus
 *
 * The fix is to make the announcement part of the same transaction. The event
 * is inserted as a row alongside the business change, so it commits or vanishes
 * with it. A separate relay moves committed rows to Kafka later.
 *
 * This trades "instant publish" for "never lost", and it is the trade this
 * system wants: a subscriber seeing an event a hundred milliseconds late is
 * invisible to users, while a confirmed booking that never emitted its event is
 * a support ticket.
 */

const { createEnvelope } = require('../events/envelope');
const { validate } = require('../events/registry');

/**
 * Append an event to the outbox. MUST be called with the same client as the
 * business writes, inside their transaction.
 *
 * @param {import('pg').PoolClient} client  Transaction client — not a pool.
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.type
 * @param {number} [args.version]
 * @param {string} args.aggregateId
 * @param {number} [args.aggregateSeq]
 * @param {object} args.payload
 * @param {string} [args.correlationId]
 * @param {string} [args.causationId]
 * @param {string} [args.traceId]
 * @returns {Promise<object>} the envelope as stored
 */
async function enqueue(client, args) {
     const envelope = createEnvelope({
          type: args.type,
          version: args.version ?? 1,
          aggregateId: args.aggregateId,
          aggregateSeq: args.aggregateSeq ?? null,
          payload: args.payload,
          correlationId: args.correlationId ?? null,
          causationId: args.causationId ?? null,
          traceId: args.traceId ?? null,
     });

     // Validate before the row is written. A malformed event caught here is a
     // failed request; caught at the consumer it is a poison message that has
     // already been committed as fact.
     validate(envelope);

     await client.query(
          `INSERT INTO outbox_events
                 (event_id, topic, event_type, event_version, aggregate_id, aggregate_seq,
                  payload, correlation_id, causation_id, trace_id, status, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', now())`,
          [
               envelope.event_id,
               args.topic,
               envelope.event_type,
               envelope.event_version,
               envelope.aggregate_id,
               envelope.aggregate_seq,
               JSON.stringify(envelope.payload),
               envelope.correlation_id,
               envelope.causation_id,
               envelope.trace_id,
          ]
     );

     return envelope;
}

/**
 * Next sequence number for an aggregate.
 *
 * Consumers use this to discard stale events, so it must be monotonic per
 * aggregate. Taken from a per-aggregate counter table rather than a global
 * sequence: a global sequence would be a single hot row shared by every
 * aggregate in the service, which is precisely the contention this project
 * exists to avoid.
 */
async function nextSeq(client, aggregateId) {
     const { rows } = await client.query(
          `INSERT INTO aggregate_sequences (aggregate_id, seq) VALUES ($1, 1)
           ON CONFLICT (aggregate_id) DO UPDATE SET seq = aggregate_sequences.seq + 1
           RETURNING seq`,
          [String(aggregateId)]
     );
     return rows[0].seq;
}

module.exports = { enqueue, nextSeq };
