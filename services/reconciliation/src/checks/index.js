'use strict';

/**
 * Reconciliation checks (eleven).
 *
 * Each check answers one question of the form "these two services should agree
 * about X — do they?" and returns the disagreements.
 *
 * Three rules every check obeys:
 *
 * 1. GRACE WINDOW. The system spans several databases and no snapshot across
 *    them is atomic. A reservation confirmed a moment ago legitimately has no
 *    booking row yet. Every check therefore ignores anything younger than its
 *    grace window. Without this, reconciliation reports a continuous stream of
 *    in-flight state, everyone learns to ignore it, and it stops being useful
 *    exactly when something real goes wrong.
 *
 * 2. READ-ONLY. Checks observe; they never repair. Repair is a separate,
 *    explicit decision recorded in the repair log.
 *
 * 3. MONEY IS FLAGGED. A check declares whether its issue involves money. That
 *    flag is what stops the repairer from automating anything financial.
 */

/**
 * A hold whose TTL elapsed but whose inventory is still withheld.
 *
 * Inventory-only and fully reversible, so this is the one class of issue that
 * is safe to repair automatically.
 */
const expiredHoldStillAllocated = {
     name: 'EXPIRED_HOLD_STILL_ALLOCATED',
     graceSeconds: 120,
     async run({ inventory, graceSeconds }) {
          const { rows } = await inventory.query(
               `SELECT a.id AS allocation_id, a.resource_id, a.hold_id, a.expires_at, a.event_id
                  FROM allocations a
                 WHERE a.state = 'HELD'
                   AND a.expires_at < now() - ($1 || ' seconds')::interval
                 LIMIT 500`,
               [String(graceSeconds)]
          );

          return rows.map((r) => ({
               kind: 'EXPIRED_HOLD_STILL_ALLOCATED',
               severity: 'HIGH',
               entityType: 'allocation',
               entityId: r.allocation_id,
               expected: { state: 'EXPIRED' },
               actual: { state: 'HELD', expiresAt: r.expires_at },
               detail: `allocation ${r.allocation_id} passed its TTL but still withholds inventory`,
               moneyInvolved: false,
               recommendedAction: 'expire the allocation and release the resource',
               context: { holdId: r.hold_id, resourceId: r.resource_id, eventId: r.event_id },
          }));
     },
};

/**
 * The ledger's fold disagrees with observed inventory state.
 *
 * Means inventory moved without being recorded — a code path that writes
 * allocations but skips the ledger. Always a defect, never normal.
 */
const ledgerDrift = {
     name: 'LEDGER_DRIFT',
     graceSeconds: 60,
     async run({ inventory }) {
          const { rows } = await inventory.query(
               `SELECT resource_id, ledger_available, actual_available, drift
                  FROM invariant_ledger_drift LIMIT 500`
          );

          return rows.map((r) => ({
               kind: 'LEDGER_DRIFT',
               severity: 'CRITICAL',
               entityType: 'resource',
               entityId: r.resource_id,
               expected: { available: Number(r.ledger_available) },
               actual: { available: Number(r.actual_available) },
               detail:
                    `ledger says ${r.ledger_available} available, state says ${r.actual_available} ` +
                    `(drift ${r.drift}) — inventory moved without a ledger entry`,
               moneyInvolved: false,
               // Deliberately not auto-repaired: we do not know which side is
               // wrong. Writing a correcting entry could paper over the bug.
               recommendedAction: 'investigate which code path changed inventory without recording it',
          }));
     },
};

/** Two confirmed allocations for the same resource-span. The nightmare case. */
const duplicateBooking = {
     name: 'DUPLICATE_BOOKING',
     graceSeconds: 0,
     async run({ inventory }) {
          const { rows } = await inventory.query(
               `SELECT resource_id, span::text AS span, confirmed_count, booking_ids
                  FROM invariant_duplicate_bookings LIMIT 100`
          );

          return rows.map((r) => ({
               kind: 'DUPLICATE_BOOKING',
               severity: 'CRITICAL',
               entityType: 'resource',
               entityId: `${r.resource_id}:${r.span}`,
               expected: { confirmedCount: 1 },
               actual: { confirmedCount: Number(r.confirmed_count), bookingIds: r.booking_ids },
               detail: `${r.confirmed_count} confirmed bookings claim resource ${r.resource_id} over ${r.span}`,
               moneyInvolved: true,
               recommendedAction: 'escalate immediately: customers have been sold the same unit',
          }));
     },
};

/**
 * Money captured with no confirmed booking behind it.
 *
 * The check customers care about most. Never auto-repaired — the right action
 * depends on whether the seat can still be honoured.
 */
const paymentWithoutBooking = {
     name: 'PAYMENT_WITHOUT_BOOKING',
     graceSeconds: 300,
     async run({ payment, reservation, graceSeconds }) {
          const { rows: captured } = await payment.query(
               `SELECT id, reservation_id, amount_cents, captured_at
                  FROM payments
                 WHERE state = 'CAPTURED'
                   AND captured_at < now() - ($1 || ' seconds')::interval
                 LIMIT 500`,
               [String(graceSeconds)]
          );
          if (captured.length === 0) return [];

          // Cross-service comparison is done by collecting ids and querying the
          // other service's database. There are no cross-database joins: each
          // service owns its schema, and this is the one component allowed to
          // read more than one, through read-only roles.
          const reservationIds = captured.map((p) => p.reservation_id).filter(Boolean);
          const { rows: confirmed } = reservationIds.length
               ? await reservation.query(
                      `SELECT id FROM reservations WHERE id = ANY($1::uuid[]) AND state = 'CONFIRMED'`,
                      [reservationIds]
                 )
               : { rows: [] };
          const confirmedSet = new Set(confirmed.map((r) => r.id));

          return captured
               .filter((p) => !confirmedSet.has(p.reservation_id))
               .map((p) => ({
                    kind: 'PAYMENT_WITHOUT_BOOKING',
                    severity: 'CRITICAL',
                    entityType: 'payment',
                    entityId: p.id,
                    expected: { reservationState: 'CONFIRMED' },
                    actual: { reservationState: 'not confirmed', capturedAt: p.captured_at },
                    detail:
                         `payment ${p.id} captured ${p.amount_cents} but reservation ` +
                         `${p.reservation_id} is not confirmed`,
                    moneyInvolved: true,
                    recommendedAction:
                         'confirm the booking if inventory is still available, otherwise refund. Human decision.',
                    context: { reservationId: p.reservation_id, amountCents: Number(p.amount_cents) },
               }));
     },
};

/** A confirmed booking with no captured payment. Revenue leakage. */
const confirmedWithoutPayment = {
     name: 'CONFIRMED_WITHOUT_PAYMENT',
     graceSeconds: 300,
     async run({ payment, reservation, graceSeconds }) {
          const { rows: bookings } = await reservation.query(
               `SELECT r.id, r.payment_id, r.total_cents, r.updated_at
                  FROM reservations r
                 WHERE r.state = 'CONFIRMED'
                   AND r.updated_at < now() - ($1 || ' seconds')::interval
                 LIMIT 500`,
               [String(graceSeconds)]
          );
          if (bookings.length === 0) return [];

          const paymentIds = bookings.map((b) => b.payment_id).filter(Boolean);
          const { rows: paid } = paymentIds.length
               ? await payment.query(
                      `SELECT id FROM payments
                        WHERE id = ANY($1::uuid[])
                          AND state IN ('CAPTURED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')`,
                      [paymentIds]
                 )
               : { rows: [] };
          const paidSet = new Set(paid.map((p) => p.id));

          return bookings
               .filter((b) => !b.payment_id || !paidSet.has(b.payment_id))
               .map((b) => ({
                    kind: 'CONFIRMED_WITHOUT_PAYMENT',
                    severity: 'CRITICAL',
                    entityType: 'reservation',
                    entityId: b.id,
                    expected: { paymentState: 'CAPTURED' },
                    actual: { paymentId: b.payment_id ?? null },
                    detail: `reservation ${b.id} is confirmed but has no captured payment`,
                    moneyInvolved: true,
                    recommendedAction: 'verify with the provider; the seat was issued without confirmed funds',
               }));
     },
};

/**
 * A reservation confirmed in the reservation service with no confirmed seat in
 * inventory. The customer holds a ticket for a seat the authority does not
 * reserve for them, so the seat could be sold again.
 *
 * The booking id written on allocations is the reservation id.
 */
const bookingWithoutAllocation = {
     name: 'BOOKING_WITHOUT_ALLOCATION',
     graceSeconds: 120,
     async run({ inventory, reservation, graceSeconds }) {
          const { rows: confirmed } = await reservation.query(
               `SELECT id FROM reservations
                 WHERE state = 'CONFIRMED'
                   AND updated_at < now() - ($1 || ' seconds')::interval
                 LIMIT 500`,
               [String(graceSeconds)]
          );
          if (confirmed.length === 0) return [];

          const ids = confirmed.map((r) => r.id);
          const { rows: held } = await inventory.query(
               `SELECT DISTINCT booking_id FROM allocations
                 WHERE booking_id = ANY($1::text[]) AND state = 'CONFIRMED'`,
               [ids]
          );
          const allocated = new Set(held.map((r) => r.booking_id));

          return ids
               .filter((id) => !allocated.has(id))
               .map((id) => ({
                    kind: 'BOOKING_WITHOUT_ALLOCATION',
                    severity: 'CRITICAL',
                    entityType: 'reservation',
                    entityId: id,
                    expected: { allocation: 'CONFIRMED' },
                    actual: { allocation: 'none' },
                    detail: `reservation ${id} is confirmed but inventory holds no confirmed seat for it`,
                    // A paying customer may not have a seat.
                    moneyInvolved: true,
                    recommendedAction: 're-confirm a seat for the customer if one is free, otherwise refund. Human decision.',
               }));
     },
};

/**
 * A seat confirmed in inventory for a reservation that is not confirmed — the
 * reverse of the check above. The seat is withheld from sale with no ticket
 * behind it. Releasing it means cancelling a booking, which is never automatic.
 */
const allocationWithoutBooking = {
     name: 'ALLOCATION_WITHOUT_BOOKING',
     graceSeconds: 300,
     async run({ inventory, reservation, graceSeconds }) {
          const { rows: allocations } = await inventory.query(
               `SELECT booking_id, array_agg(id) AS allocation_ids, min(event_id::text) AS event_id
                  FROM allocations
                 WHERE state = 'CONFIRMED'
                   -- Age from creation: a booking normally confirms seconds after
                   -- its hold, so a seat older than the grace window with no
                   -- confirmed reservation is not in flight.
                   AND created_at < now() - ($1 || ' seconds')::interval
                 GROUP BY booking_id
                 LIMIT 500`,
               [String(graceSeconds)]
          );
          if (allocations.length === 0) return [];

          // Booking ids are reservation ids for every booking the saga issues.
          // Anything that is not a UUID was not issued by the saga, so it is
          // left alone rather than reported.
          const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const candidates = allocations.filter((a) => uuid.test(a.booking_id));
          if (candidates.length === 0) return [];

          const { rows: confirmed } = await reservation.query(
               `SELECT id::text AS id FROM reservations WHERE id = ANY($1::uuid[]) AND state = 'CONFIRMED'`,
               [candidates.map((a) => a.booking_id)]
          );
          const live = new Set(confirmed.map((r) => r.id));

          return candidates
               .filter((a) => !live.has(a.booking_id))
               .map((a) => ({
                    kind: 'ALLOCATION_WITHOUT_BOOKING',
                    severity: 'HIGH',
                    entityType: 'booking',
                    entityId: a.booking_id,
                    expected: { reservationState: 'CONFIRMED' },
                    actual: { reservationState: 'not confirmed', allocations: a.allocation_ids.length },
                    detail:
                         `${a.allocation_ids.length} seat(s) are confirmed for booking ${a.booking_id}, ` +
                         `but its reservation is not confirmed: capacity withheld with no ticket behind it`,
                    // Freeing the seat cancels a booking; the customer may have been refunded or not.
                    moneyInvolved: true,
                    recommendedAction:
                         'check whether the customer was refunded; if so, cancel the booking in inventory to free the seat',
                    context: { eventId: a.event_id },
               }));
     },
};

/** A payment whose reservation does not exist at all. */
const orphanPayment = {
     name: 'ORPHAN_PAYMENT',
     graceSeconds: 300,
     async run({ payment, reservation, graceSeconds }) {
          const { rows: payments } = await payment.query(
               `SELECT id, reservation_id, amount_cents, state
                  FROM payments
                 WHERE created_at < now() - ($1 || ' seconds')::interval
                   AND state IN ('CAPTURED','AUTHORIZED','UNKNOWN')
                 ORDER BY created_at DESC
                 LIMIT 500`,
               [String(graceSeconds)]
          );
          if (payments.length === 0) return [];

          const { rows: existing } = await reservation.query(
               `SELECT id FROM reservations WHERE id = ANY($1::uuid[])`,
               [payments.map((p) => p.reservation_id)]
          );
          const known = new Set(existing.map((r) => r.id));

          return payments
               .filter((p) => !known.has(p.reservation_id))
               .map((p) => ({
                    kind: 'ORPHAN_PAYMENT',
                    severity: 'CRITICAL',
                    entityType: 'payment',
                    entityId: p.id,
                    expected: { reservation: 'exists' },
                    actual: { reservation: null, state: p.state },
                    detail: `payment ${p.id} (${p.state}, ${p.amount_cents}) references reservation ${p.reservation_id}, which does not exist`,
                    moneyInvolved: true,
                    recommendedAction: 'find who created this charge; refund it if no booking can be matched',
               }));
     },
};

/** A saga that stopped progressing. */
const stuckSaga = {
     name: 'STUCK_SAGA',
     graceSeconds: 120,
     async run({ reservation, graceSeconds }) {
          const { rows } = await reservation.query(
               `SELECT id, reservation_id, state, attempts, last_error,
                       extract(epoch FROM (now() - updated_at))::int AS stalled_seconds
                  FROM sagas
                 WHERE state NOT IN ('CONFIRMED','COMPENSATED','RELEASED')
                   AND updated_at < now() - ($1 || ' seconds')::interval
                 LIMIT 200`,
               [String(graceSeconds)]
          );

          return rows.map((r) => ({
               kind: 'STUCK_SAGA',
               severity: r.state === 'MANUAL_REVIEW' ? 'HIGH' : 'MEDIUM',
               entityType: 'saga',
               entityId: r.id,
               expected: { state: 'progressing' },
               actual: { state: r.state, attempts: r.attempts, stalledSeconds: r.stalled_seconds },
               detail: `saga ${r.id} has not moved in ${r.stalled_seconds}s (state ${r.state})`,
               // MANUAL_REVIEW means money is already under question.
               moneyInvolved: ['PAYMENT_UNKNOWN', 'MANUAL_REVIEW', 'REFUND_PENDING'].includes(r.state),
               recommendedAction:
                    r.state === 'MANUAL_REVIEW'
                         ? 'a human must decide; the saga deliberately stopped here'
                         : 're-drive the saga step',
               context: { sagaState: r.state, reservationId: r.reservation_id },
          }));
     },
};

/** A payment stuck in UNKNOWN for too long. */
const paymentUnknownTooLong = {
     name: 'PAYMENT_UNKNOWN_TOO_LONG',
     graceSeconds: 600,
     async run({ payment, graceSeconds }) {
          const { rows } = await payment.query(
               `SELECT id, reservation_id, amount_cents, resolve_attempts,
                       extract(epoch FROM (now() - unknown_since))::int AS unknown_seconds
                  FROM payments
                 WHERE state = 'UNKNOWN'
                   AND unknown_since < now() - ($1 || ' seconds')::interval
                 LIMIT 200`,
               [String(graceSeconds)]
          );

          return rows.map((r) => ({
               kind: 'PAYMENT_UNKNOWN_TOO_LONG',
               severity: 'CRITICAL',
               entityType: 'payment',
               entityId: r.id,
               expected: { state: 'resolved' },
               actual: { state: 'UNKNOWN', attempts: r.resolve_attempts, unknownSeconds: r.unknown_seconds },
               detail:
                    `payment ${r.id} has been UNKNOWN for ${r.unknown_seconds}s after ` +
                    `${r.resolve_attempts} resolution attempts`,
               moneyInvolved: true,
               recommendedAction: 'check the provider dashboard manually; automated resolution is not converging',
          }));
     },
};

/** Events committed to the outbox but never published. */
const outboxBacklog = {
     name: 'OUTBOX_BACKLOG',
     graceSeconds: 120,
     async run({ inventory, reservation, payment, graceSeconds }) {
          const issues = [];
          for (const [service, db] of [
               ['inventory', inventory],
               ['reservation', reservation],
               ['payment', payment],
          ]) {
               const { rows } = await db.query(
                    `SELECT count(*)::int AS pending,
                            min(created_at) AS oldest,
                            count(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead
                       FROM outbox_events
                      WHERE status IN ('PENDING','DEAD_LETTER')
                        AND created_at < now() - ($1 || ' seconds')::interval`,
                    [String(graceSeconds)]
               );
               const r = rows[0];
               if (r.pending > 0) {
                    issues.push({
                         kind: 'OUTBOX_BACKLOG',
                         severity: r.dead > 0 ? 'HIGH' : 'MEDIUM',
                         entityType: 'service',
                         entityId: service,
                         expected: { pending: 0 },
                         actual: { pending: r.pending, deadLettered: r.dead, oldest: r.oldest },
                         detail:
                              `${service} has ${r.pending} unpublished outbox events ` +
                              `(${r.dead} dead-lettered), oldest ${r.oldest}`,
                         moneyInvolved: false,
                         recommendedAction:
                              r.dead > 0
                                   ? 'inspect dead-lettered events and replay after fixing'
                                   : 'check the relay worker and Kafka connectivity',
                    });
               }
          }
          return issues;
     },
};

const ALL_CHECKS = [
     duplicateBooking,
     ledgerDrift,
     paymentWithoutBooking,
     confirmedWithoutPayment,
     bookingWithoutAllocation,
     allocationWithoutBooking,
     orphanPayment,
     expiredHoldStillAllocated,
     paymentUnknownTooLong,
     stuckSaga,
     outboxBacklog,
];

module.exports = { ALL_CHECKS };
