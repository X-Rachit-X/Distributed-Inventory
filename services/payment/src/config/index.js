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
     PORT: num('PAYMENT_PORT', 4003),
     DATABASE_URL: process.env.PAYMENT_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/payment',
     DB_POOL_MAX: num('DB_POOL_MAX', 10),
     KAFKA_BROKERS: process.env.KAFKA_BROKERS || '',
     INTERNAL_TOKEN: process.env.INTERNAL_TOKEN || 'dev-internal-token',
     WEBHOOK_SECRET: process.env.PAYMENT_WEBHOOK_SECRET || 'dev-webhook-secret',
     PROVIDER_MODE: process.env.PAYMENT_PROVIDER_MODE || 'ok',
     RESOLVE_INTERVAL_MS: num('PAYMENT_RESOLVE_INTERVAL_MS', 2000),
};

if (isProduction) {
     if (config.INTERNAL_TOKEN === 'dev-internal-token') {
          throw new Error('INTERNAL_TOKEN must be set to a real secret in production');
     }
     if (config.WEBHOOK_SECRET === 'dev-webhook-secret') {
          throw new Error('PAYMENT_WEBHOOK_SECRET must be set to a real secret in production');
     }
}

module.exports = config;
