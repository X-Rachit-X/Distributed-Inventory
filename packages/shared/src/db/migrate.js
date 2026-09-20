'use strict';

/**
 * Plain-SQL migration runner.
 *
 * Deliberately not an ORM migration tool. The correctness of this system rests
 * on database features an ORM cannot express: GiST exclusion constraints,
 * partial indexes, range types, triggers that make a ledger append-only, and
 * REVOKE statements. Those belong in SQL that a reviewer can read.
 *
 * Guarantees:
 *   - each file runs at most once, recorded with its checksum;
 *   - a changed checksum on an applied migration is a hard error, not a warning;
 *   - each migration runs inside a transaction, and an advisory lock serialises
 *     concurrent runners (several service replicas booting at once).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Arbitrary but fixed: all Tessera migration runners contend on this one key.
const MIGRATION_ADVISORY_LOCK = 4_244_121;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readMigrations(dir) {
     if (!fs.existsSync(dir)) return [];
     return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.sql'))
          .sort()
          .map((file) => {
               const sql = fs.readFileSync(path.join(dir, file), 'utf8');
               return { name: file, sql, checksum: sha256(sql) };
          });
}

/**
 * @param {import('pg').Pool} pool
 * @param {string|string[]} dirs  Directory (or ordered list) of NNN_name.sql files.
 *   Every service applies the shared correctness primitives first, then its own
 *   schema. Files are merged and ordered by filename across all directories, so
 *   the numeric prefix — not the directory — decides the order.
 * @param {{ logger?: object }} [opts]
 */
async function migrate(pool, dirs, opts = {}) {
     const log = opts.logger || console;
     const dirList = Array.isArray(dirs) ? dirs : [dirs];

     const migrations = dirList.flatMap(readMigrations).sort((a, b) => a.name.localeCompare(b.name));

     const seen = new Set();
     for (const mig of migrations) {
          if (seen.has(mig.name)) {
               throw new Error(`Duplicate migration filename "${mig.name}" across ${dirList.join(', ')}`);
          }
          seen.add(mig.name);
     }

     if (migrations.length === 0) {
          log.warn?.(`No migrations found in ${dirList.join(', ')}`);
          return { applied: [], skipped: [] };
     }

     const client = await pool.connect();
     const applied = [];
     const skipped = [];

     try {
          await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_ADVISORY_LOCK]);

          await client.query(`
               CREATE TABLE IF NOT EXISTS schema_migrations (
                    name        text PRIMARY KEY,
                    checksum    text NOT NULL,
                    applied_at  timestamptz NOT NULL DEFAULT now(),
                    duration_ms integer NOT NULL
               )
          `);

          const { rows: existing } = await client.query('SELECT name, checksum FROM schema_migrations');
          const byName = new Map(existing.map((r) => [r.name, r.checksum]));

          for (const mig of migrations) {
               const prior = byName.get(mig.name);
               if (prior) {
                    if (prior !== mig.checksum) {
                         throw new Error(
                              `Migration ${mig.name} has already been applied but its contents changed ` +
                                   `(recorded ${prior.slice(0, 12)}, found ${mig.checksum.slice(0, 12)}). ` +
                                   `Add a new migration instead of editing an applied one.`
                         );
                    }
                    skipped.push(mig.name);
                    continue;
               }

               const started = Date.now();
               try {
                    await client.query('BEGIN');
                    await client.query(mig.sql);
                    await client.query(
                         'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
                         [mig.name, mig.checksum, Date.now() - started]
                    );
                    await client.query('COMMIT');
                    applied.push(mig.name);
                    log.info?.(`migrated ${mig.name} (${Date.now() - started}ms)`);
               } catch (err) {
                    await client.query('ROLLBACK').catch(() => {});
                    throw new Error(`Migration ${mig.name} failed: ${err.message}`);
               }
          }

          return { applied, skipped };
     } finally {
          await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_ADVISORY_LOCK]).catch(() => {});
          client.release();
     }
}

module.exports = { migrate, readMigrations };
