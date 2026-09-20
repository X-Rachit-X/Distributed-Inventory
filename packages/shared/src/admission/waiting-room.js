'use strict';

/**
 * Virtual waiting room.
 *
 * NOT RATE LIMITING. The two solve different problems and the distinction is
 * the reason both exist:
 *
 *   Rate limiting answers "is this ONE client asking too often?" It is a
 *   per-identity fairness control. It cannot save a system from a flash sale,
 *   because 100,000 users each making one perfectly reasonable request is not a
 *   rate-limit violation by anyone — and it still melts the database.
 *
 *   The waiting room answers "how many people may be INSIDE the system at all?"
 *   It is macro admission control. It bounds total concurrency regardless of how
 *   politely each individual behaves.
 *
 * DISTRIBUTED CORRECTNESS. With five gateway instances all admitting users, the
 * obvious implementation — read the active count, compare to the cap, admit —
 * is a read-then-write race that admits five times the cap. Every decision here
 * is a single Lua script, which Redis executes atomically, so the cap holds no
 * matter how many instances call it simultaneously.
 *
 * WHY REDIS IS ACCEPTABLE HERE. The waiting room is not a correctness mechanism
 * for inventory. If Redis loses the queue, the worst outcome is that users must
 * rejoin and admission briefly over- or under-shoots. No seat is double-sold,
 * because inventory correctness lives in PostgreSQL and is independent of this.
 * That is exactly why a queue may live in Redis and an allocation may not.
 *
 * Admitted users carry a signed token, verified statelessly at the edge, so a
 * Redis outage does not eject people who are already inside and mid-checkout.
 */

const crypto = require('node:crypto');

/**
 * Join the queue.
 *
 * INCR issues a strictly increasing ticket, so position is stable and fair
 * even when two users arrive in the same millisecond. Re-joining with the same
 * session returns the ORIGINAL position rather than sending the user to the
 * back — a dropped connection must not cost someone their place.
 */
const JOIN_LUA = `
local queueKey   = KEYS[1]
local seqKey     = KEYS[2]
local memberKey  = KEYS[3]
local sessionId  = ARGV[1]
local now        = tonumber(ARGV[2])
local ttl        = tonumber(ARGV[3])

local existing = redis.call('ZSCORE', queueKey, sessionId)
if existing then
     redis.call('EXPIRE', memberKey, ttl)
     return { tonumber(existing), 0 }
end

local ticket = redis.call('INCR', seqKey)
redis.call('ZADD', queueKey, ticket, sessionId)
redis.call('HSET', memberKey, 'joined', now, 'ticket', ticket)
redis.call('EXPIRE', memberKey, ttl)
return { ticket, 1 }
`;

/**
 * Admit up to the available capacity.
 *
 * The number admitted is the minimum of remaining capacity and the drip rate,
 * computed INSIDE the script from the live active count. No instance can act on
 * a stale count, because no instance ever sees one.
 *
 * Admitted sessions move from the queue to an `active` sorted set scored by
 * expiry, so an abandoned session releases its slot without any cleanup job.
 */
const ADMIT_LUA = `
local queueKey  = KEYS[1]
local activeKey = KEYS[2]
local now       = tonumber(ARGV[1])
local maxActive = tonumber(ARGV[2])
local dripLimit = tonumber(ARGV[3])
local sessionTtlMs = tonumber(ARGV[4])

-- Reclaim slots whose sessions expired. Doing this first means capacity is
-- always computed against reality rather than against stale reservations.
redis.call('ZREMRANGEBYSCORE', activeKey, '-inf', now)

local active = redis.call('ZCARD', activeKey)
local capacity = maxActive - active
if capacity <= 0 then
     return {}
end

local take = math.min(capacity, dripLimit)
local admitted = redis.call('ZRANGE', queueKey, 0, take - 1)

for i, sessionId in ipairs(admitted) do
     redis.call('ZREM', queueKey, sessionId)
     redis.call('ZADD', activeKey, now + sessionTtlMs, sessionId)
end

return admitted
`;

/** Heartbeat: extend an active session, but only if it is still active. */
const HEARTBEAT_LUA = `
local activeKey = KEYS[1]
local sessionId = ARGV[1]
local now       = tonumber(ARGV[2])
local ttlMs     = tonumber(ARGV[3])

local score = redis.call('ZSCORE', activeKey, sessionId)
if not score or tonumber(score) <= now then
     return 0
end
redis.call('ZADD', activeKey, now + ttlMs, sessionId)
return 1
`;

const DEFAULTS = {
     maxActive: 100, // users allowed inside simultaneously
     dripPerTick: 10, // admitted per admission cycle
     sessionTtlMs: 600_000, // how long an admitted session stays valid
     queueTtlSeconds: 3600,
};

class WaitingRoom {
     /**
      * @param {object} deps
      * @param {import('ioredis').Redis} deps.redis
      * @param {string} deps.tokenSecret  Signs admission tokens.
      */
     constructor({ redis, tokenSecret, logger = console, options = {} }) {
          this.redis = redis;
          this.tokenSecret = tokenSecret;
          this.logger = logger;
          this.opts = { ...DEFAULTS, ...options };
     }

     #keys(eventId) {
          return {
               queue: `wr:{${eventId}}:queue`,
               seq: `wr:{${eventId}}:seq`,
               active: `wr:{${eventId}}:active`,
               member: (s) => `wr:{${eventId}}:m:${s}`,
          };
     }

     /**
      * Join, or return the existing place.
      * @returns {{sessionId, ticket, position, aheadOfYou, rejoined}}
      */
     async join(eventId, sessionId = null) {
          const session = sessionId || crypto.randomUUID();
          const k = this.#keys(eventId);

          const [ticket, isNew] = await this.redis.eval(
               JOIN_LUA,
               3,
               k.queue,
               k.seq,
               k.member(session),
               session,
               Date.now(),
               this.opts.queueTtlSeconds
          );

          const position = await this.redis.zrank(k.queue, session);
          return {
               sessionId: session,
               ticket,
               position: position === null ? 0 : position + 1,
               aheadOfYou: position === null ? 0 : position,
               rejoined: isNew === 0,
          };
     }

     /**
      * Admit the next batch. Safe to call from every instance concurrently.
      * @returns {Promise<string[]>} admitted session ids
      */
     async admit(eventId) {
          const k = this.#keys(eventId);
          const admitted = await this.redis.eval(
               ADMIT_LUA,
               2,
               k.queue,
               k.active,
               Date.now(),
               this.opts.maxActive,
               this.opts.dripPerTick,
               this.opts.sessionTtlMs
          );
          return admitted || [];
     }

     /**
      * Where a session stands, and its token if it is already inside.
      */
     async status(eventId, sessionId) {
          const k = this.#keys(eventId);
          const [activeScore, rank, queueDepth, activeCount] = await Promise.all([
               this.redis.zscore(k.active, sessionId),
               this.redis.zrank(k.queue, sessionId),
               this.redis.zcard(k.queue),
               this.redis.zcard(k.active),
          ]);

          if (activeScore && Number(activeScore) > Date.now()) {
               return {
                    state: 'ADMITTED',
                    token: this.issueToken(eventId, sessionId, Number(activeScore)),
                    expiresAt: new Date(Number(activeScore)).toISOString(),
                    queueDepth,
                    activeCount,
               };
          }

          if (rank === null) {
               return { state: 'NOT_IN_QUEUE', queueDepth, activeCount };
          }

          // A rough estimate is far better than none: a user given no sense of
          // progress refreshes constantly, which is the load the waiting room
          // exists to prevent.
          const ahead = rank;
          const perSecond = this.opts.dripPerTick / (this.opts.admitIntervalMs ?? 1000 / 1000);
          const etaSeconds = Math.ceil(ahead / Math.max(1, perSecond));

          return {
               state: 'QUEUED',
               position: rank + 1,
               aheadOfYou: ahead,
               estimatedWaitSeconds: etaSeconds,
               queueDepth,
               activeCount,
          };
     }

     /** Extend an active session. Returns false once it has lapsed. */
     async heartbeat(eventId, sessionId) {
          const k = this.#keys(eventId);
          const ok = await this.redis.eval(
               HEARTBEAT_LUA,
               1,
               k.active,
               sessionId,
               Date.now(),
               this.opts.sessionTtlMs
          );
          return ok === 1;
     }

     /** Release a slot when a user finishes or leaves. */
     async leave(eventId, sessionId) {
          const k = this.#keys(eventId);
          await Promise.all([
               this.redis.zrem(k.active, sessionId),
               this.redis.zrem(k.queue, sessionId),
               this.redis.del(k.member(sessionId)),
          ]);
     }

     async stats(eventId) {
          const k = this.#keys(eventId);
          await this.redis.zremrangebyscore(k.active, '-inf', Date.now());
          const [queueDepth, activeCount] = await Promise.all([
               this.redis.zcard(k.queue),
               this.redis.zcard(k.active),
          ]);
          return { eventId, queueDepth, activeCount, maxActive: this.opts.maxActive };
     }

     // ── Admission tokens ──────────────────────────────────────────────────
     //
     // Signed and self-describing, so the gateway verifies them without a Redis
     // lookup. Two benefits: no Redis round trip on the hot path, and a Redis
     // outage does not evict users who are already inside.

     issueToken(eventId, sessionId, expiresAtMs) {
          const payload = Buffer.from(JSON.stringify({ e: eventId, s: sessionId, x: expiresAtMs })).toString(
               'base64url'
          );
          const sig = crypto.createHmac('sha256', this.tokenSecret).update(payload).digest('base64url');
          return `${payload}.${sig}`;
     }

     verifyToken(token, eventId) {
          if (!token || typeof token !== 'string') return { valid: false, reason: 'missing token' };
          const [payload, sig] = token.split('.');
          if (!payload || !sig) return { valid: false, reason: 'malformed token' };

          const expected = crypto.createHmac('sha256', this.tokenSecret).update(payload).digest('base64url');
          const a = Buffer.from(sig);
          const b = Buffer.from(expected);
          // Constant-time comparison: a plain === leaks how much of the
          // signature matched, which is enough to forge one given attempts.
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
               return { valid: false, reason: 'bad signature' };
          }

          let claims;
          try {
               claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
          } catch {
               return { valid: false, reason: 'unreadable payload' };
          }

          if (claims.x < Date.now()) return { valid: false, reason: 'token expired' };
          // Binding to the event stops a token minted for a quiet event being
          // used to jump the queue for a busy one.
          if (eventId && claims.e !== eventId) return { valid: false, reason: 'token is for a different event' };

          return { valid: true, sessionId: claims.s, eventId: claims.e, expiresAt: claims.x };
     }
}

/**
 * Background admitter. Runs on every instance; the Lua script makes that safe.
 */
class AdmissionLoop {
     constructor({ waitingRoom, eventIds = [], intervalMs = 1000, logger = console, onAdmit = null }) {
          this.waitingRoom = waitingRoom;
          this.eventIds = new Set(eventIds);
          this.intervalMs = intervalMs;
          this.logger = logger;
          this.onAdmit = onAdmit;
          this.timer = null;
     }

     track(eventId) {
          this.eventIds.add(eventId);
     }

     start() {
          if (this.timer) return;
          this.timer = setInterval(async () => {
               for (const eventId of this.eventIds) {
                    try {
                         const admitted = await this.waitingRoom.admit(eventId);
                         if (admitted.length > 0) {
                              this.onAdmit?.(eventId, admitted);
                              this.logger.debug?.('admitted from waiting room', {
                                   eventId,
                                   count: admitted.length,
                              });
                         }
                    } catch (err) {
                         this.logger.error?.('admission cycle failed', { eventId, error: err.message });
                    }
               }
          }, this.intervalMs);
          this.timer.unref?.();
     }

     stop() {
          if (this.timer) clearInterval(this.timer);
          this.timer = null;
     }
}

module.exports = { WaitingRoom, AdmissionLoop, JOIN_LUA, ADMIT_LUA };
