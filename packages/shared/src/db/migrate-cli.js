#!/usr/bin/env node
'use strict';

/**
 * Migrate one or all services.
 *
 *   node packages/shared/src/db/migrate-cli.js            # every service
 *   node packages/shared/src/db/migrate-cli.js inventory  # one service
 */

const path = require('node:path');
const fs = require('node:fs');
const { createPool } = require('./pool');
const { migrate } = require('./migrate');

const ROOT = path.resolve(__dirname, '../../../..');

/** Services that own a SQL-migrated database, in dependency order. */
const SERVICES = [
     { key: 'inventory', dir: 'services/inventory-engine/sql/migrations', env: 'INVENTORY_DATABASE_URL' },
     { key: 'reservation', dir: 'services/reservation/sql/migrations', env: 'RESERVATION_DATABASE_URL' },
     { key: 'payment', dir: 'services/payment/sql/migrations', env: 'PAYMENT_DATABASE_URL' },
     { key: 'reconciliation', dir: 'services/reconciliation/sql/migrations', env: 'RECONCILIATION_DATABASE_URL' },
     { key: 'notification', dir: 'services/notification/sql/migrations', env: 'NOTIFICATION_DATABASE_URL' },
     { key: 'discovery', dir: 'services/discovery/sql/migrations', env: 'DISCOVERY_DATABASE_URL' },
];

const DEFAULT_URLS = {
     inventory: 'postgresql://tessera:tessera@localhost:5432/inventory',
     reservation: 'postgresql://tessera:tessera@localhost:5432/reservation',
     payment: 'postgresql://tessera:tessera@localhost:5432/payment',
     reconciliation: 'postgresql://tessera:tessera@localhost:5432/reconciliation',
     notification: 'postgresql://tessera:tessera@localhost:5432/notification',
     discovery: 'postgresql://tessera:tessera@localhost:5432/discovery',
};

/** Shared correctness primitives, applied to every service database first. */
const SHARED_SQL = path.resolve(__dirname, '../../sql');

async function main() {
     const only = process.argv[2];
     const targets = only ? SERVICES.filter((s) => s.key === only) : SERVICES;
     if (targets.length === 0) {
          console.error(`Unknown service "${only}". Known: ${SERVICES.map((s) => s.key).join(', ')}`);
          process.exit(1);
     }

     let failed = false;
     for (const svc of targets) {
          const dir = path.join(ROOT, svc.dir);
          if (!fs.existsSync(dir)) continue;

          const connectionString = process.env[svc.env] || DEFAULT_URLS[svc.key];
          const pool = createPool({ connectionString, name: `migrate-${svc.key}`, max: 1 });
          try {
               const { applied, skipped } = await migrate(pool, [SHARED_SQL, dir], { logger: console });
               console.log(
                    `${svc.key}: ${applied.length} applied, ${skipped.length} already current` +
                         (applied.length ? ` → ${applied.join(', ')}` : '')
               );
          } catch (err) {
               failed = true;
               console.error(`${svc.key}: ${err.message}`);
          } finally {
               await pool.end();
          }
     }
     process.exit(failed ? 1 : 0);
}

main().catch((err) => {
     console.error(err);
     process.exit(1);
});
