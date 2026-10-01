'use strict';

const { str, num, flag, secret } = require('@tessera/shared/src/config');

const config = {
     NODE_ENV: str('NODE_ENV', 'development'),
     PORT: num('GATEWAY_PORT', 4000),

     INVENTORY_URL: str('INVENTORY_URL', 'http://localhost:4001'),
     RESERVATION_URL: str('RESERVATION_URL', 'http://localhost:4002'),
     PAYMENT_URL: str('PAYMENT_URL', 'http://localhost:4003'),
     RECONCILIATION_URL: str('RECONCILIATION_URL', 'http://localhost:4004'),
     NOTIFICATION_URL: str('NOTIFICATION_URL', 'http://localhost:4005'),
     DISCOVERY_URL: str('DISCOVERY_URL', 'http://localhost:4006'),
     PRICING_URL: str('PRICING_URL', 'http://localhost:4007'),

     // Emails granted the OPERATOR role at sign-in. Demo-grade identity: a real
     // deployment takes roles from the identity provider's claims.
     OPERATOR_EMAILS: str('OPERATOR_EMAILS', 'ops@tessera.dev').split(',').map((e) => e.trim().toLowerCase()),
     REDIS_URL: str('REDIS_URL', 'redis://localhost:6379'),

     INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),
     JWT_SECRET: secret('JWT_SECRET'),
     JWT_TTL_SECONDS: num('JWT_TTL_SECONDS', 3600),
     WAITING_ROOM_SECRET: secret('WAITING_ROOM_SECRET'),

     ALLOWED_ORIGINS: str('ALLOWED_ORIGINS', 'http://localhost:5173,http://localhost:4173').split(','),
     UPSTREAM_TIMEOUT_MS: num('UPSTREAM_TIMEOUT_MS', 10000),

     // Shed above this. Node cannot do useful work while the loop is behind;
     // accepting more only lengthens the queue.
     MAX_EVENT_LOOP_LAG_MS: num('MAX_EVENT_LOOP_LAG_MS', 500),

     // Off by default: a waiting room in front of an uncontended event is pure
     // friction. It is switched on for a specific sale, not left on globally.
     WAITING_ROOM_ENABLED: flag('WAITING_ROOM_ENABLED'),
     WAITING_ROOM_MAX_ACTIVE: num('WAITING_ROOM_MAX_ACTIVE', 100),
     WAITING_ROOM_DRIP: num('WAITING_ROOM_DRIP', 10),
     WAITING_ROOM_SESSION_TTL_MS: num('WAITING_ROOM_SESSION_TTL_MS', 600000),
};

module.exports = config;
