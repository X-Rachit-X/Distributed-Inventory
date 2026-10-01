'use strict';

/**
 * Load .env from the repository root, if present.
 *
 * Every service, the seed script and the e2e runner require this first, so it
 * lives in the shared package rather than inside any one service.
 *
 * Deliberately tolerant: in Docker and in CI the environment is already set and
 * no file exists. A missing .env is normal, not an error.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const envPath = path.join(ROOT, '.env');

if (fs.existsSync(envPath)) {
     for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq === -1) continue;
          const key = trimmed.slice(0, eq).trim();
          let value = trimmed.slice(eq + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
               value = value.slice(1, -1);
          }
          // Real environment variables always win over the file, so a container
          // or CI override is never silently replaced by a checked-in default.
          if (process.env[key] === undefined) process.env[key] = value;
     }
}
