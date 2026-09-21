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
     PORT: num('RESERVATION_PORT', 4002),
     DATABASE_URL: process.env.RESERVATION_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/reservation',
     DB_POOL_MAX: num('DB_POOL_MAX', 20),
     KAFKA_BROKERS: process.env.KAFKA_BROKERS || '',
     INTERNAL_TOKEN: process.env.INTERNAL_TOKEN || 'dev-internal-token',

     INVENTORY_URL: process.env.INVENTORY_URL || 'http://localhost:4001',
     PAYMENT_URL: process.env.PAYMENT_URL || 'http://localhost:4003',
     PRICING_URL: process.env.PRICING_URL || 'http://localhost:4007',

     // Inventory is fast and local; a slow answer means contention, and failing
     // fast lets the saga retry rather than holding the step open.
     INVENTORY_TIMEOUT_MS: num('INVENTORY_TIMEOUT_MS', 5000),
     // Payments are allowed to be slow. A timeout here is recorded as UNKNOWN,
     // never as failure, so the budget is generous on purpose.
     PAYMENT_TIMEOUT_MS: num('PAYMENT_TIMEOUT_MS', 30000),

     SAGA_INTERVAL_MS: num('SAGA_INTERVAL_MS', 250),
     DEFAULT_TTL_SECONDS: num('DEFAULT_TTL_SECONDS', 600),

     // Fairness limits. One customer must not be able to park an entire event
     // in holds while real users wait.
     MAX_ITEMS_PER_RESERVATION: num('MAX_ITEMS_PER_RESERVATION', 6),
     MAX_CONCURRENT_HOLDS: num('MAX_CONCURRENT_HOLDS', 12),
};

if (isProduction && config.INTERNAL_TOKEN === 'dev-internal-token') {
     throw new Error('INTERNAL_TOKEN must be set to a real secret in production');
}

module.exports = config;
