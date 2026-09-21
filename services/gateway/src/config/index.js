'use strict';

const num = (name, fallback) => {
     const raw = process.env[name];
     if (raw === undefined || raw === '') return fallback;
     const parsed = Number(raw);
     if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
     return parsed;
};

const isProduction = process.env.NODE_ENV === 'production';

const config = {
     NODE_ENV: process.env.NODE_ENV || 'development',
     PORT: num('GATEWAY_PORT', 4000),

     INVENTORY_URL: process.env.INVENTORY_URL || 'http://localhost:4001',
     RESERVATION_URL: process.env.RESERVATION_URL || 'http://localhost:4002',
     PAYMENT_URL: process.env.PAYMENT_URL || 'http://localhost:4003',
     RECONCILIATION_URL: process.env.RECONCILIATION_URL || 'http://localhost:4004',
     NOTIFICATION_URL: process.env.NOTIFICATION_URL || 'http://localhost:4005',
     DISCOVERY_URL: process.env.DISCOVERY_URL || 'http://localhost:4006',
     PRICING_URL: process.env.PRICING_URL || 'http://localhost:4007',

     // Emails granted the OPERATOR role at sign-in. Demo-grade identity: a real
     // deployment takes roles from the identity provider's claims.
     OPERATOR_EMAILS: (process.env.OPERATOR_EMAILS || 'ops@tessera.dev').split(',').map((e) => e.trim().toLowerCase()),
     REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

     INTERNAL_TOKEN: process.env.INTERNAL_TOKEN || 'dev-internal-token',
     JWT_SECRET: process.env.JWT_SECRET || 'dev-jwt-secret',
     JWT_TTL_SECONDS: num('JWT_TTL_SECONDS', 3600),
     WAITING_ROOM_SECRET: process.env.WAITING_ROOM_SECRET || 'dev-waiting-room-secret',

     ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173').split(','),
     UPSTREAM_TIMEOUT_MS: num('UPSTREAM_TIMEOUT_MS', 10000),

     // Shed above this. Node cannot do useful work while the loop is behind;
     // accepting more only lengthens the queue.
     MAX_EVENT_LOOP_LAG_MS: num('MAX_EVENT_LOOP_LAG_MS', 500),

     // Off by default: a waiting room in front of an uncontended event is pure
     // friction. It is switched on for a specific sale, not left on globally.
     WAITING_ROOM_ENABLED: process.env.WAITING_ROOM_ENABLED === 'true',
     WAITING_ROOM_MAX_ACTIVE: num('WAITING_ROOM_MAX_ACTIVE', 100),
     WAITING_ROOM_DRIP: num('WAITING_ROOM_DRIP', 10),
     WAITING_ROOM_SESSION_TTL_MS: num('WAITING_ROOM_SESSION_TTL_MS', 600000),
};

if (isProduction) {
     for (const [key, dev] of [
          ['INTERNAL_TOKEN', 'dev-internal-token'],
          ['JWT_SECRET', 'dev-jwt-secret'],
          ['WAITING_ROOM_SECRET', 'dev-waiting-room-secret'],
     ]) {
          if (config[key] === dev) throw new Error(`${key} must be set to a real secret in production`);
     }
}

module.exports = config;
