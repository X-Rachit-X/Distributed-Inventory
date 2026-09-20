'use strict';

/**
 * Versioned event envelope.
 *
 * Every event on every topic has the same outer shape. The fields exist for
 * concrete operational reasons:
 *
 *   event_id       consumer deduplication key (at-least-once delivery is a fact,
 *                  not a failure mode)
 *   aggregate_id   partition key; guarantees per-aggregate ordering
 *   aggregate_seq  monotonic per aggregate, so a consumer can discard an event
 *                  that arrives after a newer one it already applied. This is
 *                  what makes out-of-order delivery survivable rather than
 *                  merely unlikely.
 *   event_version  schema version; v1 consumers keep working when v2 producers
 *                  deploy, via upcasters
 *   correlation_id the business thread (one reservation end to end)
 *   causation_id   the event that caused this one — turns a topic into a graph
 *   trace_id       joins the event stream to distributed traces
 */

const crypto = require('node:crypto');

/**
 * @param {object} args
 * @param {string} args.type          e.g. 'reservation.created'
 * @param {number} [args.version]     schema major version, default 1
 * @param {string} args.aggregateId
 * @param {number} [args.aggregateSeq]
 * @param {object} args.payload
 */
function createEnvelope({
     type,
     version = 1,
     aggregateId,
     aggregateSeq = null,
     payload,
     correlationId = null,
     causationId = null,
     traceId = null,
     occurredAt = new Date(),
}) {
     if (!type) throw new Error('createEnvelope: type is required');
     if (!aggregateId) throw new Error('createEnvelope: aggregateId is required');

     return {
          event_id: crypto.randomUUID(),
          event_type: type,
          event_version: version,
          aggregate_id: String(aggregateId),
          aggregate_seq: aggregateSeq,
          occurred_at: occurredAt.toISOString(),
          correlation_id: correlationId,
          causation_id: causationId,
          trace_id: traceId,
          payload: payload ?? {},
     };
}

/** Kafka headers mirroring envelope metadata, so a consumer can filter without parsing the body. */
function toHeaders(envelope) {
     return {
          'event-id': envelope.event_id,
          'event-type': envelope.event_type,
          'event-version': String(envelope.event_version),
          'aggregate-id': envelope.aggregate_id,
          ...(envelope.aggregate_seq != null ? { 'aggregate-seq': String(envelope.aggregate_seq) } : {}),
          ...(envelope.correlation_id ? { 'correlation-id': envelope.correlation_id } : {}),
          ...(envelope.trace_id ? { traceparent: envelope.trace_id } : {}),
     };
}

module.exports = { createEnvelope, toHeaders };
