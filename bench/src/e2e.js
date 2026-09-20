#!/usr/bin/env node
'use strict';

/**
 * End-to-end acceptance run against the LIVE stack.
 *
 * Everything here goes over HTTP through the real services, with real
 * PostgreSQL behind them. It is the difference between "the engine is correct
 * in a unit test" and "the system is correct when assembled".
 *
 * The final check is the one that matters: after all the traffic, query the
 * authoritative database and assert the invariants. A run that oversold is a
 * failed run no matter what the responses said.
 *
 *   node bench/src/e2e.js
 */

require('../../services/inventory-engine/src/config/env');

const { createPool } = require('@tessera/shared/src/db/pool');

const INVENTORY = process.env.INVENTORY_URL || 'http://localhost:4001';
const RESERVATION = process.env.RESERVATION_URL || 'http://localhost:4002';
const PAYMENT = process.env.PAYMENT_URL || 'http://localhost:4003';
const TOKEN = process.env.INTERNAL_TOKEN || 'dev-internal-token';

const c = {
     reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
     red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
     if (condition) {
          passed += 1;
          console.log(`  ${c.green}PASS${c.reset}  ${name}${detail ? c.dim + '  ' + detail + c.reset : ''}`);
     } else {
          failed += 1;
          failures.push(name);
          console.log(`  ${c.red}FAIL${c.reset}  ${name}${detail ? '  ' + detail : ''}`);
     }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
     const res = await fetch(url, {
          ...opts,
          headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
     });
     const json = await res.json().catch(() => null);
     return { status: res.status, body: json };
}

const reserve = (customerId, body, key) =>
     api(`${RESERVATION}/v1/reservations`, {
          method: 'POST',
          headers: { 'x-customer-id': customerId, 'idempotency-key': key },
          body,
     });

/**
 * Poll until the reservation settles.
 *
 * `settleFully` additionally waits for the saga to finish compensating. A
 * reservation reports FAILED the instant payment is declined, but the hold is
 * released a beat later by the compensation step — so a test that asserts on
 * inventory immediately after seeing FAILED is racing the system rather than
 * testing it.
 */
const poll = async (reservationId, customerId, maxMs = 15_000, settleFully = false) => {
     const deadline = Date.now() + maxMs;
     let last = null;
     while (Date.now() < deadline) {
          const { body } = await api(`${RESERVATION}/v1/reservations/${reservationId}`, {
               headers: { 'x-customer-id': customerId },
          });
          last = body?.data;
          const compensationDone =
               !settleFully || ['Booked', 'Cancelled', 'Not completed'].includes(last?.progress);
          if (last?.settled && compensationDone) return last;
          await sleep(250);
     }
     return last;
};

async function main() {
     console.log(`\n${c.bold}${c.cyan}Tessera end-to-end acceptance${c.reset}`);
     console.log(`${c.dim}against the live stack — inventory, reservation, payment${c.reset}\n`);

     const invPool = createPool({
          connectionString:
               process.env.INVENTORY_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/inventory',
          name: 'e2e',
          max: 8,
     });

     // ── Services reachable ────────────────────────────────────────────────
     console.log(`${c.bold}Services${c.reset}`);
     for (const [name, url] of [['inventory', INVENTORY], ['reservation', RESERVATION], ['payment', PAYMENT]]) {
          const { status } = await api(`${url}/health`).catch(() => ({ status: 0 }));
          check(`${name} is reachable`, status === 200);
     }
     if (failed > 0) {
          console.log(`\n${c.red}Stack is not running. Start it with: npm run dev${c.reset}\n`);
          process.exit(1);
     }

     // Fresh event per run, so repeated runs never interfere.
     const { rows: events } = await invPool.query(
          `SELECT id, name FROM inventory_events WHERE state = 'ACTIVE' ORDER BY starts_at LIMIT 1`
     );
     if (events.length === 0) {
          console.log(`\n${c.red}No inventory. Run: node bench/src/seed.js${c.reset}\n`);
          process.exit(1);
     }
     const eventId = events[0].id;

     const seatFor = async (cls) => {
          const { rows } = await invPool.query(
               `SELECT r.id, r.code FROM inventory_resources r
                 WHERE r.event_id = $1 AND r.class = $2
                   AND NOT EXISTS (
                        SELECT 1 FROM allocations a
                         WHERE a.resource_id = r.id AND a.state IN ('HELD','CONFIRMED','BLOCKED')
                           AND (a.state <> 'HELD' OR a.expires_at > now())
                   )
                 ORDER BY random() LIMIT 1`,
               [eventId, cls]
          );
          return rows[0];
     };

     // ── 1. Happy path ─────────────────────────────────────────────────────
     console.log(`\n${c.bold}1 · Booking flow${c.reset}`);
     {
          const seat = await seatFor('2A');
          const { body } = await reserve(
               'e2e-happy',
               { eventId, items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 3, priceCents: 285_000 }] },
               `e2e-happy-${Date.now()}`
          );
          const result = await poll(body.data.reservationId, 'e2e-happy');
          check('a reservation reaches CONFIRMED', result?.state === 'CONFIRMED', result?.state);
          check('a booking reference is issued', !!result?.bookingReference, result?.bookingReference);

          const { rows } = await invPool.query(
               `SELECT state, booking_id FROM allocations WHERE resource_id = $1`,
               [seat.id]
          );
          check('the seat is CONFIRMED in the authoritative database', rows[0]?.state === 'CONFIRMED');
     }

     // ── 2. Idempotency ────────────────────────────────────────────────────
     console.log(`\n${c.bold}2 · Idempotency${c.reset}`);
     {
          const seat = await seatFor('3A');
          const key = `e2e-idem-${Date.now()}`;
          const payload = { eventId, items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 2, priceCents: 196_000 }] };

          const first = await reserve('e2e-idem', payload, key);
          const second = await reserve('e2e-idem', payload, key);

          check(
               'a replayed request returns the SAME reservation',
               first.body.data.reservationId === second.body.data.reservationId,
               first.body.data.reservationId
          );
          check('the replay is marked as such', second.body.replayed === true);

          // Let the saga actually take the hold before counting allocations.
          await poll(first.body.data.reservationId, 'e2e-idem');

          const { rows } = await invPool.query(
               `SELECT count(*)::int AS n FROM allocations WHERE resource_id = $1 AND state IN ('HELD','CONFIRMED')`,
               [seat.id]
          );
          check('only ONE allocation exists for the retried request', rows[0].n === 1, `${rows[0].n} allocation(s)`);

          // A different body under the same key is a client bug or an attack.
          const conflicting = await reserve('e2e-idem', { ...payload, items: [] }, key);
          check(
               'reusing a key with a different body is rejected',
               conflicting.status === 422 || conflicting.status === 400,
               `HTTP ${conflicting.status}`
          );
     }

     // ── 3. Contention: the headline guarantee ─────────────────────────────
     console.log(`\n${c.bold}3 · Contention — 50 customers, 1 seat${c.reset}`);
     {
          const seat = await seatFor('1A');
          const attempts = 50;

          // Fire together, so the requests genuinely overlap.
          const results = await Promise.all(
               Array.from({ length: attempts }, (_, i) =>
                    reserve(
                         `e2e-race-${i}`,
                         { eventId, items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 4, priceCents: 480_000 }] },
                         `e2e-race-${Date.now()}-${i}`
                    ).catch(() => ({ status: 0, body: null }))
               )
          );

          const accepted = results.filter((r) => r.status === 202 || r.status === 200);
          // Let the sagas settle: some accepted reservations will lose the seat
          // at the inventory step and compensate.
          await sleep(6_000);

          const { rows } = await invPool.query(
               `SELECT count(*)::int AS live FROM allocations
                 WHERE resource_id = $1 AND state IN ('HELD','CONFIRMED')
                   AND (state <> 'HELD' OR expires_at > now())`,
               [seat.id]
          );

          check(
               `exactly ONE customer holds the seat`,
               rows[0].live === 1,
               `${rows[0].live} live allocation(s) from ${attempts} simultaneous attempts`
          );
          check('every request got an answer', accepted.length + results.filter((r) => r.status >= 400).length === attempts);

          const { rows: sagas } = await invPool.query(
               `SELECT count(*)::int AS n FROM allocations WHERE resource_id = $1`,
               [seat.id]
          );
          console.log(`  ${c.dim}${accepted.length} accepted, ${sagas[0].n} allocation row(s) written in total${c.reset}`);
     }

     // ── 4. Payment declined → seat released ───────────────────────────────
     console.log(`\n${c.bold}4 · Payment declined${c.reset}`);
     {
          const seat = await seatFor('SL');
          const { body } = await reserve(
               'e2e-decline',
               {
                    eventId,
                    items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 2, priceCents: 75_000 }],
                    paymentMode: 'decline',
               },
               `e2e-decline-${Date.now()}`
          );
          const result = await poll(body.data.reservationId, 'e2e-decline', 15_000, true);

          check('the reservation does not confirm', result?.state !== 'CONFIRMED', result?.state);

          const { rows } = await invPool.query(
               `SELECT count(*)::int AS live FROM allocations
                 WHERE resource_id = $1 AND state IN ('HELD','CONFIRMED') AND (state <> 'HELD' OR expires_at > now())`,
               [seat.id]
          );
          check('the seat is released, not stranded', rows[0].live === 0, `${rows[0].live} still held`);

          // And it is genuinely sellable again.
          const retry = await reserve(
               'e2e-decline-next',
               { eventId, items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 2, priceCents: 75_000 }] },
               `e2e-decline-next-${Date.now()}`
          );
          const retryResult = await poll(retry.body.data.reservationId, 'e2e-decline-next');
          check('the released seat can be sold to someone else', retryResult?.state === 'CONFIRMED', retryResult?.state);
     }

     // ── 5. Payment timeout → UNKNOWN → resolved ───────────────────────────
     console.log(`\n${c.bold}5 · Provider timeout after a successful charge${c.reset}`);
     {
          const seat = await seatFor('3A');
          const { body } = await reserve(
               'e2e-unknown',
               {
                    eventId,
                    items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 2, priceCents: 196_000 }],
                    // The provider charges the customer and the response is lost.
                    paymentMode: 'timeout_after_success',
               },
               `e2e-unknown-${Date.now()}`
          );

          const result = await poll(body.data.reservationId, 'e2e-unknown', 25_000);
          check(
               'the booking completes after resolution with the provider',
               result?.state === 'CONFIRMED',
               result?.state
          );

          const payPool = createPool({
               connectionString:
                    process.env.PAYMENT_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/payment',
               name: 'e2e-pay',
               max: 2,
          });
          const { rows } = await payPool.query(
               `SELECT count(*)::int AS n FROM payments WHERE reservation_id = $1`,
               [body.data.reservationId]
          );
          check('the customer was charged exactly ONCE', rows[0].n === 1, `${rows[0].n} payment(s)`);
          await payPool.end();
     }

     // ── 6. Segment booking ────────────────────────────────────────────────
     console.log(`\n${c.bold}6 · Segment booking — one seat, two journeys${c.reset}`);
     {
          const seat = await seatFor('SL');

          const first = await reserve(
               'e2e-seg-a',
               { eventId, items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 3, priceCents: 75_000 }] },
               `e2e-seg-a-${Date.now()}`
          );
          await poll(first.body.data.reservationId, 'e2e-seg-a');

          // Overlaps [0,3) — must be refused.
          const overlapping = await reserve(
               'e2e-seg-b',
               { eventId, items: [{ resourceId: seat.id, spanFrom: 2, spanTo: 5, priceCents: 75_000 }] },
               `e2e-seg-b-${Date.now()}`
          );
          const overlapResult = await poll(overlapping.body.data.reservationId, 'e2e-seg-b');
          check('an overlapping segment is refused', overlapResult?.state !== 'CONFIRMED', overlapResult?.state);

          // Starts where the first ends — half-open ranges mean no conflict.
          const adjacent = await reserve(
               'e2e-seg-c',
               { eventId, items: [{ resourceId: seat.id, spanFrom: 3, spanTo: 6, priceCents: 75_000 }] },
               `e2e-seg-c-${Date.now()}`
          );
          const adjacentResult = await poll(adjacent.body.data.reservationId, 'e2e-seg-c');
          check(
               'an adjacent segment on the SAME seat is allowed',
               adjacentResult?.state === 'CONFIRMED',
               adjacentResult?.state
          );
     }

     // ── 7. Admin block policy ─────────────────────────────────────────────
     console.log(`\n${c.bold}7 · Administrative block${c.reset}`);
     {
          const free = await seatFor('3A');
          const blocked = await api(`${INVENTORY}/admin/resources/${free.id}/block`, {
               method: 'POST',
               headers: { 'x-internal-token': TOKEN, 'x-actor': 'ops-demo' },
               body: { reason: 'seat damaged' },
          });
          check('a free seat can be blocked', blocked.status === 200, `HTTP ${blocked.status}`);

          const sell = await reserve(
               'e2e-blocked',
               { eventId, items: [{ resourceId: free.id, spanFrom: 0, spanTo: 2, priceCents: 196_000 }] },
               `e2e-blocked-${Date.now()}`
          );
          const sellResult = await poll(sell.body.data.reservationId, 'e2e-blocked');
          check('a blocked seat cannot be sold', sellResult?.state !== 'CONFIRMED', sellResult?.state);

          // A held seat must NOT be seizable by an operator.
          const held = await seatFor('2A');
          const holdRes = await reserve(
               'e2e-holder',
               { eventId, items: [{ resourceId: held.id, spanFrom: 0, spanTo: 2, priceCents: 285_000 }] },
               `e2e-holder-${Date.now()}`
          );
          await poll(holdRes.body.data.reservationId, 'e2e-holder');

          const seize = await api(`${INVENTORY}/admin/resources/${held.id}/block`, {
               method: 'POST',
               headers: { 'x-internal-token': TOKEN, 'x-actor': 'ops-demo' },
               body: { reason: 'attempted seizure of a sold seat' },
          });
          check(
               'a SOLD seat cannot be blocked out from under the customer',
               seize.status === 409,
               `HTTP ${seize.status} ${seize.body?.error?.code ?? ''}`
          );

          await api(`${INVENTORY}/admin/resources/${free.id}/unblock`, {
               method: 'POST',
               headers: { 'x-internal-token': TOKEN },
               body: { reason: 'demo cleanup' },
          });
     }

     // ── 8. Security ───────────────────────────────────────────────────────
     console.log(`\n${c.bold}8 · Security${c.reset}`);
     {
          const noToken = await api(`${INVENTORY}/internal/reserve`, { method: 'POST', body: { eventId } });
          check('the internal API rejects an unauthenticated call', noToken.status === 401);

          const forged = await fetch(`${PAYMENT}/webhooks/provider`, {
               method: 'POST',
               headers: {
                    'content-type': 'application/json',
                    'x-tessera-signature': 'deadbeef'.repeat(8),
                    'x-tessera-timestamp': String(Math.floor(Date.now() / 1000)),
               },
               body: JSON.stringify({ id: 'forged', type: 'payment.captured', data: {} }),
          });
          check('a forged webhook signature is rejected', forged.status === 400, `HTTP ${forged.status}`);

          // One customer must not be able to read another's reservation.
          const seat = await seatFor('SL');
          const mine = await reserve(
               'e2e-owner',
               { eventId, items: [{ resourceId: seat.id, spanFrom: 0, spanTo: 2, priceCents: 75_000 }] },
               `e2e-owner-${Date.now()}`
          );
          const snoop = await api(`${RESERVATION}/v1/reservations/${mine.body.data.reservationId}`, {
               headers: { 'x-customer-id': 'e2e-attacker' },
          });
          check("another customer cannot read someone else's reservation", snoop.status === 404);
     }

     // ── 9. The authoritative check ────────────────────────────────────────
     console.log(`\n${c.bold}9 · Invariants after all of the above${c.reset}`);
     {
          const { rows } = await invPool.query(`SELECT * FROM invariant_summary`);
          for (const row of rows) {
               const n = Number(row.violations);
               const isCorrectness = ['CRITICAL', 'HIGH'].includes(row.severity);
               if (isCorrectness) {
                    check(`${row.invariant}`, n === 0, n === 0 ? '' : `${n} violation(s)`);
               } else if (n > 0) {
                    console.log(`  ${c.yellow}WARN${c.reset}  ${row.invariant}  ${c.dim}${n} (delivery lag, not corruption)${c.reset}`);
               }
          }
     }

     await invPool.end();

     // ── Summary ───────────────────────────────────────────────────────────
     console.log(`\n${'─'.repeat(64)}`);
     if (failed === 0) {
          console.log(`${c.green}${c.bold}  ${passed} checks passed${c.reset}  ${c.dim}no oversells, no lost inventory, no duplicate charges${c.reset}\n`);
     } else {
          console.log(`${c.red}${c.bold}  ${failed} of ${passed + failed} checks FAILED${c.reset}`);
          for (const f of failures) console.log(`    ${c.red}·${c.reset} ${f}`);
          console.log();
     }
     process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
     console.error(`\n${c.red}${err.stack || err.message}${c.reset}\n`);
     process.exit(1);
});
