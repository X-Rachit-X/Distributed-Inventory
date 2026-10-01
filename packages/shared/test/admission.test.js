'use strict';

/**
 * Admission-control tests.
 *
 * The property that matters is distributed safety: several instances admitting
 * users concurrently must never exceed the cap. That is the exact bug a naive
 * read-then-write implementation has, and the reason every decision here is a
 * single Lua script.
 */

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Redis = require('ioredis');

const { TokenBucket } = require('../src/admission/token-bucket');
const { WaitingRoom } = require('../src/admission/waiting-room');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
let redis;
let eventId;

before(async () => {
     redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true });
     await redis.connect();
});

after(async () => {
     await redis.quit();
});

beforeEach(async () => {
     eventId = `test-${crypto.randomUUID()}`;
});

describe('token bucket', () => {
     test('allows a burst up to capacity, then denies', async () => {
          const tb = new TokenBucket({ redis, logger: silent });
          const key = `tb-test-${crypto.randomUUID()}`;
          const limit = { capacity: 5, refillPerSecond: 1 };

          const results = [];
          for (let i = 0; i < 7; i++) results.push(await tb.take(key, limit));

          assert.equal(results.filter((r) => r.allowed).length, 5, 'burst capacity is 5');
          assert.equal(results.filter((r) => !r.allowed).length, 2);
          assert.ok(results[6].retryAfterMs > 0, 'a denied caller must be told when to return');
     });

     test('a denied request consumes nothing, so retrying does not deepen the penalty', async () => {
          const tb = new TokenBucket({ redis, logger: silent });
          const key = `tb-nopenalty-${crypto.randomUUID()}`;
          const limit = { capacity: 2, refillPerSecond: 10 };

          await tb.take(key, limit);
          await tb.take(key, limit);

          const first = await tb.take(key, limit);
          assert.equal(first.allowed, false);

          // Hammer it while empty. Under the old implementation each of these
          // was added to the window and pushed the reset further out.
          for (let i = 0; i < 20; i++) await tb.take(key, limit);

          // Refill of 10/s means ~2 tokens after 200ms regardless of how many
          // rejected attempts were made in between.
          await new Promise((r) => setTimeout(r, 250));
          const after = await tb.take(key, limit);
          assert.equal(after.allowed, true, 'rejected attempts must not delay recovery');
     });

     test('concurrent calls never exceed capacity', async () => {
          const tb = new TokenBucket({ redis, logger: silent });
          const key = `tb-concurrent-${crypto.randomUUID()}`;
          const limit = { capacity: 10, refillPerSecond: 0.001 }; // effectively no refill

          const results = await Promise.all(
               Array.from({ length: 100 }, () => tb.take(key, limit))
          );

          assert.equal(
               results.filter((r) => r.allowed).length,
               10,
               '100 simultaneous callers, capacity 10 — exactly 10 may pass'
          );
     });

     test('falls back to a local limiter when Redis is unavailable', async () => {
          const broken = { script: () => Promise.reject(new Error('connection refused')) };
          const tb = new TokenBucket({ redis: broken, logger: silent });

          const result = await tb.take('fallback-key', { capacity: 3, refillPerSecond: 1 });
          assert.equal(result.allowed, true);
          assert.equal(result.degraded, true, 'degradation must be visible to the caller');

          // And it still limits, rather than failing open.
          await tb.take('fallback-key', { capacity: 3, refillPerSecond: 1 });
          await tb.take('fallback-key', { capacity: 3, refillPerSecond: 1 });
          const fourth = await tb.take('fallback-key', { capacity: 3, refillPerSecond: 1 });
          assert.equal(fourth.allowed, false, 'a Redis outage must not remove rate limiting entirely');
     });
});

describe('waiting room', () => {
     test('assigns stable FIFO positions', async () => {
          const wr = new WaitingRoom({ redis, tokenSecret: 's', logger: silent });

          const a = await wr.join(eventId);
          const b = await wr.join(eventId);
          const c = await wr.join(eventId);

          assert.equal(a.position, 1);
          assert.equal(b.position, 2);
          assert.equal(c.position, 3);
     });

     test('rejoining keeps the original place', async () => {
          const wr = new WaitingRoom({ redis, tokenSecret: 's', logger: silent });

          const first = await wr.join(eventId);
          await wr.join(eventId);
          await wr.join(eventId);

          // Same session reconnects after dropping its connection.
          const rejoined = await wr.join(eventId, first.sessionId);
          assert.equal(rejoined.position, 1, 'a dropped connection must not cost someone their place');
          assert.equal(rejoined.rejoined, true);
     });

     test('five concurrent instances never admit more than the cap', async () => {
          const maxActive = 10;
          // Five separate instances, as in five gateway pods.
          const instances = Array.from(
               { length: 5 },
               () =>
                    new WaitingRoom({
                         redis,
                         tokenSecret: 's',
                         logger: silent,
                         options: { maxActive, dripPerTick: 10, sessionTtlMs: 60_000 },
                    })
          );

          for (let i = 0; i < 50; i++) await instances[0].join(eventId);

          // All five admit simultaneously. A read-then-write implementation
          // would admit up to 50 here.
          const batches = await Promise.all(instances.map((wr) => wr.admit(eventId)));
          const admitted = batches.flat();

          assert.equal(
               admitted.length,
               maxActive,
               `five instances admitting at once must not exceed ${maxActive}, got ${admitted.length}`
          );
          assert.equal(new Set(admitted).size, admitted.length, 'no session may be admitted twice');

          const stats = await instances[0].stats(eventId);
          assert.equal(stats.activeCount, maxActive);
          assert.equal(stats.queueDepth, 40);
     });

     test('expired sessions release their slots automatically', async () => {
          const wr = new WaitingRoom({
               redis,
               tokenSecret: 's',
               logger: silent,
               options: { maxActive: 2, dripPerTick: 2, sessionTtlMs: 150 },
          });

          for (let i = 0; i < 5; i++) await wr.join(eventId);

          const firstBatch = await wr.admit(eventId);
          assert.equal(firstBatch.length, 2);

          // Nothing may be admitted while the first two hold their slots.
          assert.equal((await wr.admit(eventId)).length, 0);

          // Sessions lapse; capacity returns with no cleanup job involved.
          await new Promise((r) => setTimeout(r, 200));
          const secondBatch = await wr.admit(eventId);
          assert.equal(secondBatch.length, 2, 'abandoned sessions must free their slots');
     });

     test('admission tokens verify, expire, and are bound to their event', async () => {
          const wr = new WaitingRoom({ redis, tokenSecret: 'secret-key', logger: silent });

          const token = wr.issueToken(eventId, 'session-1', Date.now() + 60_000);
          assert.equal(wr.verifyToken(token, eventId).valid, true);

          // A token for another event must not grant entry to this one.
          assert.equal(wr.verifyToken(token, 'different-event').valid, false);

          // Tampering must be detected.
          assert.equal(wr.verifyToken(`${token}x`, eventId).valid, false);

          const expired = wr.issueToken(eventId, 'session-1', Date.now() - 1000);
          assert.equal(wr.verifyToken(expired, eventId).valid, false);

          // A token signed with a different secret must not verify.
          const other = new WaitingRoom({ redis, tokenSecret: 'different-secret', logger: silent });
          assert.equal(wr.verifyToken(other.issueToken(eventId, 's', Date.now() + 60_000), eventId).valid, false);
     });

     test('heartbeat extends an active session but cannot revive a lapsed one', async () => {
          const wr = new WaitingRoom({
               redis,
               tokenSecret: 's',
               logger: silent,
               options: { maxActive: 1, dripPerTick: 1, sessionTtlMs: 200 },
          });

          const joined = await wr.join(eventId);
          await wr.admit(eventId);

          assert.equal(await wr.heartbeat(eventId, joined.sessionId), true);

          await new Promise((r) => setTimeout(r, 260));
          assert.equal(
               await wr.heartbeat(eventId, joined.sessionId),
               false,
               'a lapsed session must not be extendable — its slot belongs to someone else now'
          );
     });
});

describe('waiting room estimate', () => {
     test('estimates the wait from the drip rate and the admission interval', async () => {
          const eventId = `eta-${Date.now()}`;
          const wr = new WaitingRoom({
               redis,
               tokenSecret: 't',
               options: { maxActive: 0, dripPerTick: 10, admitIntervalMs: 2000 },
          });
          let last;
          for (let i = 0; i < 25; i++) last = await wr.join(eventId);
          const status = await wr.status(eventId, last.sessionId);
          // 24 people ahead, 10 admitted every 2 s = 5 per second → about 5 s.
          // A precedence bug once divided by the interval in milliseconds and
          // reported 24 s for any configured interval.
          assert.equal(status.aheadOfYou, 24);
          assert.equal(status.estimatedWaitSeconds, 5);
     });
});
