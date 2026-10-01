'use strict';

/**
 * Deployment smoke test: one real booking through the PUBLIC entry point.
 *
 *   node bench/src/smoke.js https://tessera.example.com
 *   BASE_URL=http://localhost:8080 node bench/src/smoke.js
 *
 * Where `npm run e2e` talks to every service directly (it needs internal ports,
 * the database and the internal token), this script only uses what a browser
 * can reach: `/api/*` on the public address. That makes it the right check
 * after a deploy: it exercises the reverse proxy, the gateway's auth and rate
 * limiting, and the whole booking saga, without any access a visitor lacks.
 *
 * It books one seat on the first active train, waits for CONFIRMED, then
 * cancels the booking so the seat goes back on sale. Run it against your own
 * deployment only.
 */

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

let failed = 0;
const check = (name, ok, detail = '') => {
     if (!ok) failed++;
     console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
     return ok;
};

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
     const res = await fetch(`${BASE}${path}`, {
          method,
          headers: {
               ...(body ? { 'content-type': 'application/json' } : {}),
               ...(token ? { authorization: `Bearer ${token}` } : {}),
               ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
     });
     const json = await res.json().catch(() => null);
     return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
     console.log(`\nTessera smoke test against ${BASE}\n`);

     // 1. The site and the API answer.
     const page = await fetch(BASE, { signal: AbortSignal.timeout(15_000) }).catch((e) => ({ status: 0, e }));
     check('the console page is served', page.status === 200, `HTTP ${page.status}`);

     const inv = await api('/api/ops/invariants');
     check('correctness invariants hold', inv.status === 200, `HTTP ${inv.status}`);

     // 2. There is something to sell.
     const events = await api('/api/events');
     const event = events.body?.data?.find((e) => e.availableResources > 0);
     if (!check('an active train with free seats exists', !!event, event ? '' : 'seed the database first')) return;

     const resources = await api(`/api/events/${event.eventId}/resources?spanFrom=0&spanTo=${event.spanMax}`);
     const seat = resources.body?.data?.resources?.find((r) => r.status === 'AVAILABLE');
     if (!check('a free seat is listed', !!seat)) return;

     // 3. Sign in as a throwaway customer.
     const login = await api('/api/auth/login', { method: 'POST', body: { email: `smoke-${Date.now()}@example.com` } });
     const token = login.body?.data?.token;
     if (!check('sign-in returns a token', !!token, `HTTP ${login.status}`)) return;

     // 4. Book it and follow the saga.
     const created = await api('/api/reservations', {
          method: 'POST',
          token,
          headers: { 'idempotency-key': `smoke-${Date.now()}` },
          body: { eventId: event.eventId, items: [{ resourceId: seat.resourceId, spanFrom: 0, spanTo: 1 }] },
     });
     const reservationId = created.body?.data?.reservationId;
     if (!check('the reservation is accepted (202)', created.status === 202 && !!reservationId, `HTTP ${created.status}`)) {
          return;
     }

     let state = null;
     const deadline = Date.now() + 30_000;
     while (Date.now() < deadline) {
          const r = await api(`/api/reservations/${reservationId}`, { token });
          state = r.body?.data;
          if (state?.settled) break;
          await sleep(500);
     }
     check('the booking is CONFIRMED', state?.state === 'CONFIRMED', `${state?.state} · ${state?.progress ?? ''}`);
     check('a booking reference is issued', !!state?.bookingReference, state?.bookingReference);

     // 5. Give the seat back.
     if (state?.state === 'CONFIRMED') {
          const cancel = await api(`/api/reservations/${reservationId}/cancel`, { method: 'POST', token });
          check('the booking cancels and the seat is released', cancel.status < 300, `HTTP ${cancel.status}`);
     }
}

main()
     .catch((err) => {
          failed++;
          console.error(`  ✗ ${err.message}`);
     })
     .finally(() => {
          console.log(failed === 0 ? '\nSmoke test passed.\n' : `\n${failed} check(s) failed.\n`);
          process.exit(failed === 0 ? 0 : 1);
     });
