'use strict';

/**
 * Token bucket rate limiter.
 *
 * ONE Lua script per decision. Redis executes Lua atomically, so refill, check
 * and consume happen with no window between them. The previous implementation
 * used a pipeline followed by a separate `ZRANGE`, which is two round trips
 * with a gap — two concurrent requests could both read "under the limit".
 *
 * It also had a subtler bug worth naming: it added the request to the window
 * BEFORE checking the limit, so rejected requests still counted against the
 * caller. A client being throttled therefore extended its own throttling by
 * continuing to retry, which is precisely when it is most likely to retry.
 * Here a denied request consumes nothing.
 *
 * Why a token bucket rather than a fixed window: a fixed window lets a client
 * spend its whole quota in the last millisecond of one window and again in the
 * first of the next, producing a burst of twice the intended rate at the
 * boundary. A token bucket refills continuously and bounds the burst by
 * capacity.
 *
 * FAILURE POLICY. If Redis is unreachable this limiter fails CLOSED onto a
 * conservative in-process limiter rather than open. Failing open during an
 * incident removes protection exactly when it is needed, and Redis being down
 * is correlated with the system being under stress. Rate limiting is not a
 * correctness mechanism, so a local approximation is an acceptable degradation;
 * no limiting at all is not.
 */

// KEYS[1] = bucket key
// ARGV    = capacity, refillPerSecond, nowMs, requestedTokens, ttlSeconds
//
// Returns: { allowed, remainingTokens, retryAfterMs }
const TOKEN_BUCKET_LUA = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local requested  = tonumber(ARGV[4])
local ttl        = tonumber(ARGV[5])

local state = redis.call('HMGET', key, 'tokens', 'updated')
local tokens  = tonumber(state[1])
local updated = tonumber(state[2])

if tokens == nil then
     tokens = capacity
     updated = now
end

-- Continuous refill, proportional to elapsed time.
local elapsed = math.max(0, now - updated) / 1000
tokens = math.min(capacity, tokens + elapsed * refillRate)

local allowed = 0
local retryAfterMs = 0

if tokens >= requested then
     tokens = tokens - requested
     allowed = 1
else
     -- Denied requests consume NOTHING, so retrying cannot deepen the penalty.
     local deficit = requested - tokens
     retryAfterMs = math.ceil((deficit / refillRate) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'updated', now)
redis.call('EXPIRE', key, ttl)

return { allowed, math.floor(tokens), retryAfterMs }
`;

/** Conservative local fallback for when Redis is unavailable. */
class LocalBucket {
     constructor() {
          this.buckets = new Map();
     }

     take(key, capacity, refillRate, tokens = 1) {
          const now = Date.now();
          let b = this.buckets.get(key);
          if (!b) {
               b = { tokens: capacity, updated: now };
               this.buckets.set(key, b);
          }
          b.tokens = Math.min(capacity, b.tokens + ((now - b.updated) / 1000) * refillRate);
          b.updated = now;

          if (b.tokens >= tokens) {
               b.tokens -= tokens;
               return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0, degraded: true };
          }
          return {
               allowed: false,
               remaining: 0,
               retryAfterMs: Math.ceil(((tokens - b.tokens) / refillRate) * 1000),
               degraded: true,
          };
     }

     /** Keep the map from growing without bound in a long-running process. */
     sweep(maxAgeMs = 300_000) {
          const cutoff = Date.now() - maxAgeMs;
          for (const [key, b] of this.buckets) if (b.updated < cutoff) this.buckets.delete(key);
     }
}

class TokenBucket {
     /**
      * @param {object} deps
      * @param {import('ioredis').Redis} deps.redis
      * @param {object} deps.logger
      */
     constructor({ redis, logger = console }) {
          this.redis = redis;
          this.logger = logger;
          this.local = new LocalBucket();
          this.scriptSha = null;

          const timer = setInterval(() => this.local.sweep(), 60_000);
          timer.unref?.();
     }

     /**
      * @param {string} key              Identity being limited, e.g. `user:42`.
      * @param {object} limit
      * @param {number} limit.capacity   Maximum burst.
      * @param {number} limit.refillPerSecond  Sustained rate.
      * @param {number} [tokens]         Cost of this request.
      */
     async take(key, { capacity, refillPerSecond }, tokens = 1) {
          const redisKey = `tb:${key}`;
          const ttl = Math.max(60, Math.ceil((capacity / refillPerSecond) * 2));

          try {
               // EVALSHA first; cache the SHA so the script body is not resent
               // on every request.
               if (!this.scriptSha) {
                    this.scriptSha = await this.redis.script('LOAD', TOKEN_BUCKET_LUA);
               }

               let result;
               try {
                    result = await this.redis.evalsha(
                         this.scriptSha,
                         1,
                         redisKey,
                         capacity,
                         refillPerSecond,
                         Date.now(),
                         tokens,
                         ttl
                    );
               } catch (err) {
                    // Redis restarted and lost its script cache.
                    if (String(err.message).includes('NOSCRIPT')) {
                         this.scriptSha = await this.redis.script('LOAD', TOKEN_BUCKET_LUA);
                         result = await this.redis.evalsha(
                              this.scriptSha,
                              1,
                              redisKey,
                              capacity,
                              refillPerSecond,
                              Date.now(),
                              tokens,
                              ttl
                         );
                    } else {
                         throw err;
                    }
               }

               const [allowed, remaining, retryAfterMs] = result;
               return { allowed: allowed === 1, remaining, retryAfterMs, degraded: false };
          } catch (err) {
               this.logger.warn?.('token bucket degraded to local limiter', { error: err.message });
               // Per-instance rather than global, so the effective limit is
               // approximately N times the configured one across N instances.
               // Documented and accepted: an approximate limit beats none.
               return this.local.take(key, capacity, refillPerSecond, tokens);
          }
     }
}

/**
 * Per-route limits.
 *
 * Reserve is the scarce operation and gets the tightest budget. Search is cheap
 * and cached, so it can be generous. Waiting-room status is polled by design
 * and must not be throttled into uselessness — throttling a queue-position poll
 * makes users refresh harder.
 */
const LIMITS = {
     search: { capacity: 60, refillPerSecond: 2 },
     availability: { capacity: 120, refillPerSecond: 4 },
     reserve: { capacity: 5, refillPerSecond: 0.2 }, // ~12/minute sustained, burst 5
     confirm: { capacity: 10, refillPerSecond: 0.5 },
     cancel: { capacity: 10, refillPerSecond: 0.5 },
     waitingRoom: { capacity: 60, refillPerSecond: 1 },
     auth: { capacity: 10, refillPerSecond: 0.1 },
};

module.exports = { TokenBucket, LIMITS, TOKEN_BUCKET_LUA };
