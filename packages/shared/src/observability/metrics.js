'use strict';

/**
 * Prometheus metrics.
 *
 * The metric set is chosen so that the project's central claim — "inventory stays
 * correct under contention" — is *observable*, not merely asserted:
 *
 *   - conflicts are counted separately from errors, because a conflict is the
 *     system working correctly and an error is not;
 *   - `oversell_prevented_total` counts exclusion-constraint firings, i.e. how
 *     often the last line of defence actually caught something;
 *   - `invariant_violations` is the number that must stay at zero forever.
 */

const client = require('prom-client');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'tessera_' });

const buckets = {
     // Request latency: fine-grained at the low end, where reserve should live.
     latency: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
     // Lock waits and DB queue times are the contention signal; they can spike far higher.
     wait: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
};

const m = {
     // ── Reservation funnel ────────────────────────────────────────────────
     reservationAttempts: new client.Counter({
          name: 'tessera_reservation_attempts_total',
          help: 'Reservation attempts received',
          labelNames: ['event_id', 'strategy'],
          registers: [registry],
     }),
     reservationSuccess: new client.Counter({
          name: 'tessera_reservation_success_total',
          help: 'Reservations that acquired inventory',
          labelNames: ['event_id', 'strategy'],
          registers: [registry],
     }),
     reservationConflict: new client.Counter({
          name: 'tessera_reservation_conflict_total',
          help: 'Reservations rejected because inventory was taken (expected under contention, not an error)',
          labelNames: ['event_id', 'strategy', 'reason'],
          registers: [registry],
     }),
     reservationError: new client.Counter({
          name: 'tessera_reservation_error_total',
          help: 'Reservations that failed due to a fault',
          labelNames: ['event_id', 'code'],
          registers: [registry],
     }),
     oversellPrevented: new client.Counter({
          name: 'tessera_oversell_prevented_total',
          help: 'Times the database exclusion constraint rejected an overlapping allocation',
          labelNames: ['event_id'],
          registers: [registry],
     }),
     holdDuration: new client.Histogram({
          name: 'tessera_hold_duration_seconds',
          help: 'Time from hold creation to its terminal state',
          labelNames: ['outcome'],
          buckets: [1, 5, 15, 30, 60, 120, 300, 600, 900],
          registers: [registry],
     }),
     holdsExpired: new client.Counter({
          name: 'tessera_hold_expired_total',
          help: 'Holds that reached their TTL without being confirmed',
          labelNames: ['reaped_by'],
          registers: [registry],
     }),

     // ── Contention and database health ────────────────────────────────────
     txDuration: new client.Histogram({
          name: 'tessera_tx_duration_seconds',
          help: 'Database transaction duration',
          labelNames: ['operation', 'outcome'],
          buckets: buckets.latency,
          registers: [registry],
     }),
     lockWait: new client.Histogram({
          name: 'tessera_lock_wait_seconds',
          help: 'Observed wait acquiring row locks',
          labelNames: ['operation'],
          buckets: buckets.wait,
          registers: [registry],
     }),
     txRetries: new client.Counter({
          name: 'tessera_tx_retries_total',
          help: 'Transaction retries after serialization failure, deadlock or lock timeout',
          labelNames: ['operation', 'sqlstate'],
          registers: [registry],
     }),
     dbPool: new client.Gauge({
          name: 'tessera_db_pool_connections',
          help: 'Database pool connections by state',
          labelNames: ['pool', 'state'],
          registers: [registry],
     }),
     eventLoopLag: new client.Gauge({
          name: 'tessera_event_loop_lag_seconds',
          help: 'Event loop lag; the saturation signal for admission control',
          registers: [registry],
     }),

     // ── Messaging ─────────────────────────────────────────────────────────
     outboxPending: new client.Gauge({
          name: 'tessera_outbox_pending',
          help: 'Outbox rows awaiting publication',
          labelNames: ['service'],
          registers: [registry],
     }),
     outboxPublishLatency: new client.Histogram({
          name: 'tessera_outbox_publish_latency_seconds',
          help: 'Delay between outbox row commit and successful publish',
          labelNames: ['service', 'event_type'],
          buckets: buckets.wait,
          registers: [registry],
     }),
     outboxPublished: new client.Counter({
          name: 'tessera_outbox_published_total',
          help: 'Outbox rows published to Kafka',
          labelNames: ['service', 'event_type'],
          registers: [registry],
     }),
     eventsConsumed: new client.Counter({
          name: 'tessera_events_consumed_total',
          help: 'Events processed by consumers',
          labelNames: ['consumer', 'event_type', 'outcome'],
          registers: [registry],
     }),
     duplicateEvents: new client.Counter({
          name: 'tessera_duplicate_events_total',
          help: 'Events skipped because the consumer had already processed them',
          labelNames: ['consumer', 'event_type'],
          registers: [registry],
     }),
     staleEvents: new client.Counter({
          name: 'tessera_stale_events_total',
          help: 'Events discarded because a newer aggregate sequence was already applied',
          labelNames: ['consumer', 'event_type'],
          registers: [registry],
     }),
     dlqMessages: new client.Counter({
          name: 'tessera_dlq_messages_total',
          help: 'Messages routed to a dead-letter queue',
          labelNames: ['consumer', 'reason'],
          registers: [registry],
     }),

     // ── Admission, fairness, cache ────────────────────────────────────────
     rateLimited: new client.Counter({
          name: 'tessera_rate_limited_total',
          help: 'Requests rejected by the token bucket',
          labelNames: ['scope', 'route'],
          registers: [registry],
     }),
     loadShed: new client.Counter({
          name: 'tessera_load_shed_total',
          help: 'Requests shed by admission control to protect the database',
          labelNames: ['route', 'reason'],
          registers: [registry],
     }),
     waitingRoomDepth: new client.Gauge({
          name: 'tessera_waiting_room_depth',
          help: 'Users currently queued in the waiting room',
          labelNames: ['event_id'],
          registers: [registry],
     }),
     waitingRoomActive: new client.Gauge({
          name: 'tessera_waiting_room_active',
          help: 'Users currently admitted and active',
          labelNames: ['event_id'],
          registers: [registry],
     }),
     waitingRoomAdmitted: new client.Counter({
          name: 'tessera_waiting_room_admitted_total',
          help: 'Users admitted from the waiting room',
          labelNames: ['event_id'],
          registers: [registry],
     }),
     cacheRequests: new client.Counter({
          name: 'tessera_cache_requests_total',
          help: 'Read-model cache lookups',
          labelNames: ['cache', 'result'],
          registers: [registry],
     }),
     availabilityCacheAge: new client.Gauge({
          name: 'tessera_availability_cache_age_seconds',
          help: 'Age of the newest availability projection entry served',
          labelNames: ['event_id'],
          registers: [registry],
     }),

     // ── Saga, payment, reconciliation ─────────────────────────────────────
     sagaTransitions: new client.Counter({
          name: 'tessera_saga_transitions_total',
          help: 'Saga state transitions',
          labelNames: ['from', 'to'],
          registers: [registry],
     }),
     sagaCompensations: new client.Counter({
          name: 'tessera_saga_compensation_total',
          help: 'Saga compensations executed',
          labelNames: ['reason'],
          registers: [registry],
     }),
     sagaStuck: new client.Gauge({
          name: 'tessera_saga_stuck',
          help: 'Sagas past their step deadline',
          registers: [registry],
     }),
     paymentTransitions: new client.Counter({
          name: 'tessera_payment_transitions_total',
          help: 'Payment state transitions',
          labelNames: ['from', 'to'],
          registers: [registry],
     }),
     paymentUnknown: new client.Gauge({
          name: 'tessera_payment_unknown',
          help: 'Payments in UNKNOWN state awaiting provider resolution',
          registers: [registry],
     }),
     reconciliationIssues: new client.Gauge({
          name: 'tessera_reconciliation_issues',
          help: 'Open reconciliation issues',
          labelNames: ['severity', 'kind'],
          registers: [registry],
     }),
     invariantViolations: new client.Gauge({
          name: 'tessera_invariant_violations',
          help: 'Invariant violations found by the verifier. Must be zero.',
          labelNames: ['invariant'],
          registers: [registry],
     }),
};

// ── Pool instrumentation ────────────────────────────────────────────────────

const registeredPools = new Map();

const poolMetrics = {
     register(name, pool) {
          registeredPools.set(name, pool);
     },
     collect() {
          for (const [name, pool] of registeredPools) {
               m.dbPool.set({ pool: name, state: 'total' }, pool.totalCount);
               m.dbPool.set({ pool: name, state: 'idle' }, pool.idleCount);
               m.dbPool.set({ pool: name, state: 'waiting' }, pool.waitingCount);
          }
     },
};

// ── Event-loop lag ──────────────────────────────────────────────────────────
// Lag is the honest saturation signal for a Node service: when the loop is
// behind, adding requests only deepens the queue. Admission control reads this.

let lagMs = 0;
let lagTimer = null;

function startEventLoopLagProbe(intervalMs = 500) {
     if (lagTimer) return;
     let last = process.hrtime.bigint();
     lagTimer = setInterval(() => {
          const now = process.hrtime.bigint();
          const elapsedMs = Number(now - last) / 1e6;
          lagMs = Math.max(0, elapsedMs - intervalMs);
          m.eventLoopLag.set(lagMs / 1000);
          last = now;
     }, intervalMs);
     lagTimer.unref();
}

const getEventLoopLagMs = () => lagMs;

/** Express handler serving the Prometheus scrape. */
async function metricsHandler(_req, res) {
     poolMetrics.collect();
     res.set('Content-Type', registry.contentType);
     res.end(await registry.metrics());
}

module.exports = {
     registry,
     metrics: m,
     poolMetrics,
     metricsHandler,
     startEventLoopLagProbe,
     getEventLoopLagMs,
     client,
};
