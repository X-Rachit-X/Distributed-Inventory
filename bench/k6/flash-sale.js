// Flash sale through the full HTTP stack: gateway -> reservation -> pricing ->
// inventory, with the saga completing asynchronously.
//
//   docker run --rm -i --network host -e BASE=http://localhost:4000 \
//     grafana/k6 run - < bench/k6/flash-sale.js
//
// Many virtual users race for a handful of seats on one train. The pass
// criterion is NOT the response codes: after the run, the correctness endpoint
// is queried and the test fails if any invariant is violated. Response codes
// show how contention was handled (409 conflict, 429 rate limited) — both
// expected, neither a fault.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:4000';
const SEATS = Number(__ENV.SEATS || 10);

export const options = {
     scenarios: {
          rush: { executor: 'per-vu-iterations', vus: Number(__ENV.VUS || 200), iterations: 1, maxDuration: '2m' },
     },
     thresholds: {
          // Server faults must stay rare. Conflicts and rate limits are not faults.
          server_errors: ['count<5'],
     },
};

const accepted = new Counter('reservations_accepted');
const conflicts = new Counter('reservations_conflict');
const limited = new Counter('reservations_rate_limited');
const serverErrors = new Counter('server_errors');

export function setup() {
     const events = http.get(`${BASE}/api/events`).json('data');
     const eventId = events[0].eventId;
     const seats = http
          .get(`${BASE}/api/events/${eventId}/resources?spanFrom=0&spanTo=1`)
          .json('data.resources')
          .filter((r) => r.status === 'AVAILABLE')
          .slice(0, SEATS)
          .map((r) => r.resourceId);
     return { eventId, seats };
}

export default function (data) {
     const email = `k6-${__VU}-${Date.now()}@load.test`;
     const token = http
          .post(`${BASE}/api/auth/login`, JSON.stringify({ email }), { headers: { 'content-type': 'application/json' } })
          .json('data.token');

     // Every user wants one of the few seats: maximum contention.
     const seat = data.seats[__VU % data.seats.length];
     const res = http.post(
          `${BASE}/api/reservations`,
          JSON.stringify({ eventId: data.eventId, items: [{ resourceId: seat, spanFrom: 0, spanTo: 1 }] }),
          {
               headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${token}`,
                    'idempotency-key': `k6-${__VU}-${__ITER}-${Date.now()}`,
               },
               responseCallback: http.expectedStatuses(200, 202, 409, 429),
          }
     );

     if (res.status === 202 || res.status === 200) accepted.add(1);
     else if (res.status === 409) conflicts.add(1);
     else if (res.status === 429) limited.add(1);
     else if (res.status >= 500) serverErrors.add(1);
}

export function teardown() {
     // Let the sagas settle, then ask the database — not the responses.
     sleep(20);
     const board = http.get(`${BASE}/api/ops/invariants`);
     check(board, { 'no correctness invariant violated': (r) => r.json('correct') === true });
}
