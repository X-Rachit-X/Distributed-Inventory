#!/usr/bin/env node
'use strict';

/**
 * Contention Lab CLI.
 *
 *   npm run lab -- run --scenario 1000u-1r --strategy all
 *   npm run lab -- run --scenario 1000u-10r --strategy F --seed 7
 *   npm run lab -- ablation --scenario 1000u-1r
 *   npm run lab -- list
 */

const path = require('node:path');
const fs = require('node:fs');
const Redis = require('ioredis');
const { createPool } = require('@tessera/shared/src/db/pool');
const { LabRunner } = require('../runner');
const { SCENARIOS } = require('../scenarios');
const { STRATEGIES, DEFAULT_SET } = require('../strategies');

const ROOT = path.resolve(__dirname, '../../..');
const RESULTS_DIR = path.join(ROOT, 'bench', 'results', 'lab');

const c = {
     reset: '\x1b[0m',
     bold: '\x1b[1m',
     dim: '\x1b[2m',
     red: '\x1b[31m',
     green: '\x1b[32m',
     yellow: '\x1b[33m',
     blue: '\x1b[34m',
     cyan: '\x1b[36m',
};

function parseArgs(argv) {
     const args = { _: [] };
     for (let i = 0; i < argv.length; i++) {
          const a = argv[i];
          if (a.startsWith('--')) {
               const key = a.slice(2);
               const next = argv[i + 1];
               if (next && !next.startsWith('--')) {
                    args[key] = next;
                    i++;
               } else {
                    args[key] = true;
               }
          } else {
               args._.push(a);
          }
     }
     return args;
}

function printTable(results) {
     const head = [
          'Strategy'.padEnd(30),
          'Rows'.padStart(6),
          'Units'.padStart(6),
          'Extra'.padStart(6),
          'Conflict'.padStart(9),
          'Error'.padStart(6),
          'p50'.padStart(9),
          'p99'.padStart(9),
          'RPS'.padStart(8),
     ].join(' ');

     console.log(`\n${c.bold}${head}${c.reset}`);
     console.log('─'.repeat(head.length));

     for (const r of results) {
          const oversell = r.oversells + r.overlaps;
          // 'Extra' = claims beyond capacity, i.e. customers who were sold
          // something already sold. The number that decides safe vs unsafe.
          const extra = r.oversells;
          const flag = extra > 0 ? `${c.red}${String(extra).padStart(6)}${c.reset}` : `${c.green}${'0'.padStart(6)}${c.reset}`;
          const name = `${r.strategy}  ${r.strategyName}`.padEnd(30);
          console.log(
               [
                    oversell > 0 ? `${c.red}${name}${c.reset}` : name,
                    String(r.totalRows ?? r.distinctClaims).padStart(6),
                    String(r.distinctClaims).padStart(6),
                    flag,
                    String(r.conflicts).padStart(9),
                    (r.errors > 0 ? c.yellow : '') + String(r.errors).padStart(6) + (r.errors > 0 ? c.reset : ''),
                    `${r.latency.p50}ms`.padStart(9),
                    `${r.latency.p99}ms`.padStart(9),
                    String(r.throughputPerSec).padStart(8),
               ].join(' ')
          );
     }
     console.log();
}

async function cmdRun(args, deps) {
     const scenarioName = args.scenario || '1000u-1r';
     const scenario = SCENARIOS[scenarioName];
     if (!scenario) {
          console.error(`Unknown scenario "${scenarioName}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
          process.exit(1);
     }

     let strategyIds;
     if (!args.strategy || args.strategy === 'all') {
          strategyIds = DEFAULT_SET;
     } else if (args.strategy === 'every') {
          strategyIds = Object.keys(STRATEGIES);
     } else {
          strategyIds = String(args.strategy).split(',').map((s) => s.trim().toUpperCase());
     }

     if (!deps.redis) strategyIds = strategyIds.filter((id) => !STRATEGIES[id]?.needsRedis);

     const seed = args.seed ? Number(args.seed) : 42;
     const concurrency = args.concurrency ? Number(args.concurrency) : undefined;
     const bucketCount = args.buckets ? Number(args.buckets) : 1;

     console.log(`\n${c.bold}${c.cyan}Tessera Contention Lab${c.reset}`);
     console.log(`${c.dim}scenario${c.reset} ${scenarioName}  ` +
          `${c.dim}users${c.reset} ${scenario.users}  ` +
          `${c.dim}resources${c.reset} ${scenario.resources}  ` +
          `${c.dim}seed${c.reset} ${seed}`);
     if (scenario.expectedSuccesses != null) {
          console.log(`${c.dim}expected successful allocations:${c.reset} ${c.bold}${scenario.expectedSuccesses}${c.reset}`);
     }

     const runner = new LabRunner(deps);
     const results = [];

     for (const id of strategyIds) {
          const strategy = STRATEGIES[id];
          if (!strategy) {
               console.error(`  unknown strategy ${id}, skipping`);
               continue;
          }
          process.stdout.write(`\n  ${c.dim}running${c.reset} ${id} ${strategy.title} ... `);
          const result = await runner.run({
               scenario: scenarioName,
               strategy: id,
               seed,
               concurrency,
               bucketCount,
          });
          results.push(result);

          const bad = result.oversells + result.overlaps > 0;
          process.stdout.write(bad ? `${c.red}OVERSOLD${c.reset}\n` : `${c.green}ok${c.reset}\n`);
          console.log(`    ${c.dim}${result.verdict}${c.reset}`);
     }

     printTable(results);

     // Contention detail for the slowest strategy — the "why" behind p99.
     const slowest = [...results].sort((a, b) => b.latency.p99 - a.latency.p99)[0];
     if (slowest?.contention?.topWaits?.length) {
          console.log(`${c.bold}Where time went for ${slowest.strategy} (highest p99):${c.reset}`);
          for (const w of slowest.contention.topWaits) {
               console.log(`  ${String(w.event).padEnd(36)} ${String(Math.round(w.share * 100)).padStart(3)}% of active samples`);
          }
          console.log();
     }

     const artifact = writeArtifact(scenarioName, seed, results);
     console.log(`${c.dim}results written to${c.reset} ${path.relative(ROOT, artifact)}\n`);

     const unexpected = results.filter(
          (r) => r.expectedSafe && (r.oversells > 0 || r.overlaps > 0)
     );
     if (unexpected.length > 0) {
          console.log(`${c.red}${c.bold}A strategy expected to be safe oversold. That is a real defect.${c.reset}\n`);
          process.exitCode = 1;
     }
}

/**
 * Layer ablation.
 *
 * Runs the SAME naive strategy with and without the database constraint. This
 * isolates what each defensive layer actually contributes, and demonstrates
 * that the constraint catches a bug the application logic did not.
 */
async function cmdAblation(args, deps) {
     const scenarioName = args.scenario || '1000u-1r';
     const seed = args.seed ? Number(args.seed) : 42;
     const runner = new LabRunner(deps);

     console.log(`\n${c.bold}${c.cyan}Layer ablation${c.reset}  ${c.dim}scenario${c.reset} ${scenarioName}`);
     console.log(
          `${c.dim}The same flawed application logic, run with and without the final database guard.${c.reset}\n`
     );

     const naiveUnguarded = await runner.run({ scenario: scenarioName, strategy: 'A', seed });

     // Strategy F is the same workload with no application-level check at all,
     // relying purely on the constraint.
     const constraintOnly = await runner.run({ scenario: scenarioName, strategy: 'F', seed });

     const rows = [
          {
               label: 'Application check only (no constraint)',
               result: naiveUnguarded,
          },
          {
               label: 'Constraint only (no application check)',
               result: constraintOnly,
          },
     ];

     console.log(`${c.bold}${'Configuration'.padEnd(42)}${'Sold'.padStart(6)}${'Oversell'.padStart(10)}${c.reset}`);
     console.log('─'.repeat(58));
     for (const { label, result } of rows) {
          const over = result.oversells + result.overlaps;
          const colour = over > 0 ? c.red : c.green;
          console.log(
               `${label.padEnd(42)}${String(result.distinctClaims).padStart(6)}${colour}${String(over).padStart(10)}${c.reset}`
          );
     }

     console.log(
          `\n${c.dim}Reading: the application check alone does not prevent overselling, because the check\n` +
               `and the write are separate operations. The constraint alone does, because they are not.${c.reset}\n`
     );

     writeArtifact(`ablation-${scenarioName}`, seed, rows.map((r) => r.result));
}

function cmdList() {
     console.log(`\n${c.bold}Scenarios${c.reset}`);
     for (const [name, s] of Object.entries(SCENARIOS)) {
          const expected = s.expectedSuccesses == null ? 'derived' : String(s.expectedSuccesses);
          console.log(
               `  ${name.padEnd(20)} ${c.dim}${String(s.users).padStart(6)} users → ${String(s.resources).padStart(5)} resources, ` +
                    `expect ${expected}${s.heavy ? '  [heavy]' : ''}${c.reset}`
          );
     }
     console.log(`\n${c.bold}Strategies${c.reset}`);
     for (const [id, s] of Object.entries(STRATEGIES)) {
          const safety = s.expectedSafe ? `${c.green}safe${c.reset}` : `${c.red}UNSAFE by design${c.reset}`;
          console.log(`  ${id.padEnd(4)} ${s.title.padEnd(48)} ${safety}`);
          console.log(`       ${c.dim}${s.summary}${c.reset}`);
     }
     console.log();
}

function writeArtifact(scenarioName, seed, results) {
     fs.mkdirSync(RESULTS_DIR, { recursive: true });
     const stamp = new Date().toISOString().replace(/[:.]/g, '-');
     const commit = results[0]?.environment?.gitCommit ?? 'nogit';
     const file = path.join(RESULTS_DIR, `${scenarioName}-${stamp}-${commit}.json`);
     fs.writeFileSync(
          file,
          JSON.stringify(
               {
                    scenario: scenarioName,
                    seed,
                    generatedAt: new Date().toISOString(),
                    environment: results[0]?.environment ?? null,
                    results,
               },
               null,
               2
          )
     );
     return file;
}

async function main() {
     const args = parseArgs(process.argv.slice(2));
     const command = args._[0] || 'run';

     if (command === 'list') {
          cmdList();
          return;
     }

     const connectionString =
          process.env.INVENTORY_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/inventory';

     // Concurrency is capped at the workload pool size, because each virtual
     // user holds a connection for the whole run. Asking for more concurrency
     // than connections would just queue inside the pool and measure that
     // queue instead of the locking behaviour under test.
     const concurrency = Number(args.concurrency || process.env.LAB_CONCURRENCY || 64);

     const pool = createPool({
          connectionString,
          name: 'lab-workload',
          max: concurrency,
          // Lab transactions may legitimately wait a long time under extreme
          // contention; a short lock timeout here would report timeouts where
          // the interesting observation is the wait itself.
          lockTimeoutMs: Number(args.lockTimeout || 15_000),
          statementTimeoutMs: 30_000,
          connectionTimeoutMillis: 20_000,
     });

     // Instrumentation gets its own connections. Sharing the workload pool
     // would let setup and sampling steal capacity from the experiment, and
     // would silently stop sampling exactly when the system is most saturated
     // and the samples matter most.
     const adminPool = createPool({
          connectionString,
          name: 'lab-admin',
          max: 4,
          statementTimeoutMs: 30_000,
     });

     args.concurrency = concurrency;

     let redis = null;
     const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
     try {
          redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false });
          await redis.connect();
          await redis.ping();
     } catch {
          console.warn(`${c.yellow}Redis unavailable at ${redisUrl}; strategy E will be skipped.${c.reset}`);
          try { redis?.disconnect(); } catch { /* already down */ }
          redis = null;
     }

     try {
          if (command === 'run') await cmdRun(args, { pool, adminPool, redis });
          else if (command === 'ablation') await cmdAblation(args, { pool, adminPool, redis });
          else {
               console.error(`Unknown command "${command}". Use: run | ablation | list`);
               process.exitCode = 1;
          }
     } finally {
          await pool.end();
          await adminPool.end();
          redis?.disconnect();
     }
}

main().catch((err) => {
     console.error(`\n${c.red}${err.stack || err.message}${c.reset}\n`);
     process.exit(1);
});
