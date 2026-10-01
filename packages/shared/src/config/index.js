'use strict';

/**
 * Configuration helpers shared by every service.
 *
 * Each service reads its settings once at boot and validates them immediately,
 * so a misconfiguration fails at startup with a clear message rather than on the
 * first request that happens to need the value.
 *
 * These helpers used to be copied into each service, in two variants. The
 * looser variant turned a mistyped number into NaN without complaint, and three
 * services had no production check on the internal token at all.
 */

const isProduction = () => process.env.NODE_ENV === 'production';

/** A string setting. Unset or empty falls back. */
function str(name, fallback = '') {
     const value = process.env[name];
     return value === undefined || value === '' ? fallback : value;
}

/** A numeric setting. Unset or empty falls back; anything non-numeric is a boot error. */
function num(name, fallback) {
     const raw = process.env[name];
     if (raw === undefined || raw === '') return fallback;
     const parsed = Number(raw);
     if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
     return parsed;
}

/** A boolean setting: only the exact string "true" enables it. */
const flag = (name) => process.env[name] === 'true';

/**
 * Development defaults for shared secrets. Convenient on a laptop, a
 * vulnerability anywhere else.
 */
const DEV_SECRETS = {
     INTERNAL_TOKEN: 'dev-internal-token',
     JWT_SECRET: 'dev-jwt-secret',
     WAITING_ROOM_SECRET: 'dev-waiting-room-secret',
     PAYMENT_WEBHOOK_SECRET: 'dev-webhook-secret',
};

/**
 * A secret setting. Outside production it falls back to its development value;
 * in production a missing or development value refuses to boot.
 *
 * @param {keyof DEV_SECRETS} name
 */
function secret(name) {
     const dev = DEV_SECRETS[name];
     if (dev === undefined) throw new Error(`Unknown secret ${name}`);
     const value = str(name, isProduction() ? '' : dev);
     if (isProduction() && (value === '' || value === dev)) {
          throw new Error(`${name} must be set to a real secret in production`);
     }
     return value;
}

module.exports = { str, num, flag, secret, isProduction, DEV_SECRETS };
