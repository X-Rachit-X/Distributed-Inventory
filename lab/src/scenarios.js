'use strict';

/**
 * Contention scenarios.
 *
 * The set sweeps the ratio of demand to supply, because that ratio — not raw
 * request rate — is what determines how a concurrency strategy behaves. A
 * thousand users against a thousand seats is an easy workload at any rate. A
 * thousand users against one seat is a pathological one at any rate.
 *
 * `expectedSuccesses` is stated up front for every scenario. A run whose
 * success count differs from it is either overselling (more) or losing
 * inventory (fewer), and both are failures regardless of how good the latency
 * numbers look.
 */

const SCENARIOS = {
     // ── Single-resource contention: the pure race ────────────────────────
     '10u-1r': { users: 10, resources: 1, expectedSuccesses: 1, group: 'single-resource' },
     '100u-1r': { users: 100, resources: 1, expectedSuccesses: 1, group: 'single-resource' },
     '1000u-1r': { users: 1000, resources: 1, expectedSuccesses: 1, group: 'single-resource' },
     '10000u-1r': {
          users: 10000,
          resources: 1,
          expectedSuccesses: 1,
          group: 'single-resource',
          heavy: true,
     },

     // ── Scarce inventory: the flash-sale shape ───────────────────────────
     '1000u-10r': { users: 1000, resources: 10, expectedSuccesses: 10, group: 'scarce' },
     '10000u-100r': { users: 10000, resources: 100, expectedSuccesses: 100, group: 'scarce', heavy: true },

     // ── Abundant inventory: the control. Contention should be near zero,
     //    so this isolates each strategy's baseline overhead. ─────────────
     '1000u-1000r': { users: 1000, resources: 1000, expectedSuccesses: 1000, group: 'abundant' },

     // ── Segment contention: overlapping ranges on ONE shared resource.
     //    Two claims can conflict without being identical, which a plain
     //    unique constraint on (resource, seat) would miss entirely. ──────
     '500u-1r-segments': {
          users: 500,
          resources: 1,
          spanMode: 'random-overlap',
          spanMax: 10,
          // Non-overlapping claims on one seat may coexist, so the exact count
          // depends on which spans the seeded generator produces. It is derived
          // from the run rather than asserted, and only the overlap count is a
          // pass/fail criterion.
          expectedSuccesses: null,
          group: 'segment',
     },

     // ── Hot inventory: 90% of demand on one of ten events ────────────────
     'hot-event': {
          users: 2000,
          resources: 100,
          hotEventShare: 0.9,
          events: 10,
          expectedSuccesses: null,
          group: 'hot',
     },
};

/**
 * Expand a scenario into a deterministic request plan.
 *
 * Seeded so a run can be reproduced exactly. An unreproducible benchmark cannot
 * be used to compare two commits, which is the only reason to keep the numbers.
 */
function buildPlan(scenario, { seed = 42, resourceIds = [], spanMax = 2 }) {
     const rng = mulberry32(seed);
     const plan = [];

     for (let i = 0; i < scenario.users; i++) {
          const customerId = `lab-user-${i}`;
          let resourceId;
          let spanFrom = 0;
          let spanTo = 1;

          if (scenario.spanMode === 'random-overlap') {
               // All users target the same resource with random overlapping
               // ranges — the segment-booking stress case.
               resourceId = resourceIds[0];
               const max = scenario.spanMax || spanMax;
               spanFrom = Math.floor(rng() * (max - 1));
               const length = 1 + Math.floor(rng() * (max - spanFrom - 1));
               spanTo = spanFrom + length;
          } else if (scenario.resources === 1) {
               resourceId = resourceIds[0];
          } else {
               // Uniform demand across the resource pool.
               resourceId = resourceIds[Math.floor(rng() * resourceIds.length)];
          }

          plan.push({ customerId, resourceId, spanFrom, spanTo, attemptNo: i });
     }

     return plan;
}

/** Deterministic 32-bit PRNG. Small, fast, and reproducible across machines. */
function mulberry32(seed) {
     let a = seed >>> 0;
     return function next() {
          a |= 0;
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
     };
}

module.exports = { SCENARIOS, buildPlan, mulberry32 };
