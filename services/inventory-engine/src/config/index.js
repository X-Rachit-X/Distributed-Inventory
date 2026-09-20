'use strict';

/**
 * Configuration.
 *
 * Read once at startup and validated immediately, so a misconfigured service
 * fails at boot with a clear message rather than at 3am on the first request
 * that happens to need the missing value.
 */

const required = (name, fallback) => {
     const value = process.env[name] ?? fallback;
     if (value === undefined || value === '') {
          throw new Error(`Missing required environment variable ${name}`);
     }
     return value;
};

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
     PORT: num('PORT', 4001),

     DATABASE_URL: required('INVENTORY_DATABASE_URL', 'postgresql://tessera:tessera@localhost:5432/inventory'),
     DB_POOL_MAX: num('DB_POOL_MAX', 20),

     // Under a flash sale, waiting 30s for a lock is worse for the user than a
     // fast 409 that lets the UI offer another seat.
     LOCK_TIMEOUT_MS: num('LOCK_TIMEOUT_MS', 3_000),
     STATEMENT_TIMEOUT_MS: num('STATEMENT_TIMEOUT_MS', 10_000),

     KAFKA_BROKERS: process.env.KAFKA_BROKERS || '',
     EXPIRY_BATCH_SIZE: num('EXPIRY_BATCH_SIZE', 200),

     INTERNAL_TOKEN: required('INTERNAL_TOKEN', isProduction ? undefined : 'dev-internal-token'),
};

// A development default for a shared secret is a convenience in development
// and a vulnerability in production. Refuse to start rather than run with it.
if (isProduction && config.INTERNAL_TOKEN === 'dev-internal-token') {
     throw new Error('INTERNAL_TOKEN must be set to a real secret in production');
}

module.exports = config;
