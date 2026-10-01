'use strict';

/**
 * Configuration.
 *
 * Read once at startup and validated immediately, so a misconfigured service
 * fails at boot with a clear message rather than at 3am on the first request
 * that happens to need the missing value.
 */

const { str, num, secret } = require('@tessera/shared/src/config');

module.exports = {
     NODE_ENV: str('NODE_ENV', 'development'),
     PORT: num('PORT', 4001),

     DATABASE_URL: str('INVENTORY_DATABASE_URL', 'postgresql://tessera:tessera@localhost:5432/inventory'),
     DB_POOL_MAX: num('DB_POOL_MAX', 20),

     // Under a flash sale, waiting 30s for a lock is worse for the user than a
     // fast 409 that lets the UI offer another seat.
     LOCK_TIMEOUT_MS: num('LOCK_TIMEOUT_MS', 3_000),
     STATEMENT_TIMEOUT_MS: num('STATEMENT_TIMEOUT_MS', 10_000),

     KAFKA_BROKERS: str('KAFKA_BROKERS'),
     EXPIRY_BATCH_SIZE: num('EXPIRY_BATCH_SIZE', 200),

     // Refuses to boot in production with the development value.
     INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),
};
