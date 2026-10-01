'use strict';

const { str, num, secret } = require('@tessera/shared/src/config');

module.exports = {
     NODE_ENV: str('NODE_ENV', 'development'),
     PORT: num('RESERVATION_PORT', 4002),
     DATABASE_URL: str('RESERVATION_DATABASE_URL', 'postgresql://tessera:tessera@localhost:5432/reservation'),
     DB_POOL_MAX: num('DB_POOL_MAX', 20),
     KAFKA_BROKERS: str('KAFKA_BROKERS'),
     INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),

     INVENTORY_URL: str('INVENTORY_URL', 'http://localhost:4001'),
     PAYMENT_URL: str('PAYMENT_URL', 'http://localhost:4003'),
     PRICING_URL: str('PRICING_URL', 'http://localhost:4007'),

     // Inventory is fast and local; a slow answer means contention, and failing
     // fast lets the saga retry rather than holding the step open.
     INVENTORY_TIMEOUT_MS: num('INVENTORY_TIMEOUT_MS', 5000),
     // Payments are allowed to be slow. A timeout here is recorded as UNKNOWN,
     // never as failure, so the budget is generous on purpose.
     PAYMENT_TIMEOUT_MS: num('PAYMENT_TIMEOUT_MS', 30000),
     PRICING_TIMEOUT_MS: num('PRICING_TIMEOUT_MS', 5000),

     SAGA_INTERVAL_MS: num('SAGA_INTERVAL_MS', 250),
     DEFAULT_TTL_SECONDS: num('DEFAULT_TTL_SECONDS', 600),

     // Fairness limits. One customer must not be able to park an entire event
     // in holds while real users wait.
     MAX_ITEMS_PER_RESERVATION: num('MAX_ITEMS_PER_RESERVATION', 6),
     MAX_CONCURRENT_HOLDS: num('MAX_CONCURRENT_HOLDS', 12),
};
