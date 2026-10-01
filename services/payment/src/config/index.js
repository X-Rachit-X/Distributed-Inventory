'use strict';

const { str, num, secret } = require('@tessera/shared/src/config');

module.exports = {
     NODE_ENV: str('NODE_ENV', 'development'),
     PORT: num('PAYMENT_PORT', 4003),
     DATABASE_URL: str('PAYMENT_DATABASE_URL', 'postgresql://tessera:tessera@localhost:5432/payment'),
     DB_POOL_MAX: num('DB_POOL_MAX', 10),
     KAFKA_BROKERS: str('KAFKA_BROKERS'),
     // Both refuse to boot in production with their development values.
     INTERNAL_TOKEN: secret('INTERNAL_TOKEN'),
     WEBHOOK_SECRET: secret('PAYMENT_WEBHOOK_SECRET'),
     PROVIDER_MODE: str('PAYMENT_PROVIDER_MODE', 'ok'),
     RESOLVE_INTERVAL_MS: num('PAYMENT_RESOLVE_INTERVAL_MS', 2000),
};
