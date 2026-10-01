'use strict';

const { str, num, flag, secret, isProduction } = require('@tessera/shared/src/config');

const DEFAULT_OPERATOR_EMAIL = 'ops@tessera.dev';

function operatorEmails() {
     const emails = str('OPERATOR_EMAILS', DEFAULT_OPERATOR_EMAIL)
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean);
     if (isProduction() && emails.includes(DEFAULT_OPERATOR_EMAIL)) {
          throw new Error(
               `OPERATOR_EMAILS must not include ${DEFAULT_OPERATOR_EMAIL} in production: sign-in has no password, so anyone could become an operator`
          );
     }
     return emails;
}

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
     //
     // Sign-in has no password, so in a public deployment whoever types an
     // operator email IS an operator. The address therefore works like a
     // shared secret, and production refuses the well-known default.
     OPERATOR_EMAILS: operatorEmails(),
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
