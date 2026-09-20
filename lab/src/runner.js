'use strict';

/**
 * Contention Lab runner.
 *
 * Executes a scenario against a strategy and then — this is the part that
 * matters — VERIFIES THE RESULT AGAINST THE DATABASE.
 *
 * Counting HTTP 200s or resolved promises proves nothing. A system can return
 * success to two callers while writing one row, or return an error after
 * writing two. The only trustworthy question is "how many rows claim the same
 * resource-span?", and that is answered by querying stored state after the
 * traffic stops.
 *
 * Every run records its seed, workload, environment and git commit, so a number
 * can be reproduced and compared across commits. A run whose invariants fail is
 * marked INVALID and its performance figures are not reported — a fast system
 * that overselt is not a fast system.
 */

const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const os = require('node:os');
const { SCENARIOS, buildPlan } = require('./scenarios');
const { STRATEGIES } = require('./strategies');

class LabRunner {
     /**
      * @param {object} deps
      * @param {import('pg').Pool} deps.pool        Workload pool: one connection per virtual user.
      * @param {import('pg').Pool} [deps.adminPool] Separate pool for setup, verification and
      *   contention sampling. Kept apart deliberately — instrumentation that competes for
      *   connections with the workload perturbs the thing it is trying to measure, and under
      *   full saturation the sampler would simply stop returning data.
      */
     constructor({ pool, adminPool = null, redis = null, logger = console }) {
          this.pool = pool;
          this.adminPool = adminPool || pool;
          this.redis = redis;
          this.logger = logger;
     }

     /**
      * Run one scenario against one strategy.
      *
      * @param {object} opts
      * @param {string} opts.scenario
      * @param {string} opts.strategy
      * @param {number} [opts.seed]
      * @param {number} [opts.concurrency]  Simultaneous in-flight requests.
      * @param {number} [opts.bucketCount]  For pool strategies.
      */
     async run(opts) {
          const scenario = SCENARIOS[opts.scenario];
          if (!scenario) throw new Error(`Unknown scenario: ${opts.scenario}`);
          const strategy = STRATEGIES[opts.strategy];
          if (!strategy) throw new Error(`Unknown strategy: ${opts.strategy}`);
          if (strategy.needsRedis && !this.redis) {
               throw new Error(`Strategy ${strategy.id} requires Redis; none configured`);
          }

          const seed = opts.seed ?? 42;
          const runId = crypto.randomUUID();
          const concurrency = opts.concurrency ?? Math.min(scenario.users, 200);
          const bucketCount = opts.bucketCount ?? 1;

          const env = this.#environment();

          await this.adminPool.query(
               `INSERT INTO lab.runs (id, scenario, strategy, users, resources, seed, git_commit, git_dirty, params)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
               [
                    runId,
                    opts.scenario,
                    strategy.id,
                    scenario.users,
                    scenario.resources,
                    seed,
                    env.gitCommit,
                    env.gitDirty,
                    JSON.stringify({ concurrency, bucketCount, spanMode: scenario.spanMode ?? null }),
               ]
          );

          // ── Seed the run's private inventory ──────────────────────────────
          const resourceIds = await this.#seed(runId, scenario, strategy, bucketCount);

          const plan = buildPlan(scenario, {
               seed,
               resourceIds,
               spanMax: scenario.spanMax ?? 2,
          });

          const ctx = { pool: this.pool, redis: this.redis, runId, bucketCount };

          // ── Sample database contention while traffic runs ────────────────
          const sampler = this.#startContentionSampler();

          const startedAt = Date.now();
          const observations = await this.#execute(plan, strategy, ctx, concurrency);
          const wallMs = Date.now() - startedAt;

          const contention = sampler.stop();

          await this.#persistObservations(runId, observations);

          // ── Verify against stored state, not against responses ──────────
          const verification = await this.#verify(runId, scenario, strategy);
          const stats = this.#summarise(observations, wallMs);

          const valid =
               verification.oversells === 0 &&
               verification.overlaps === 0 &&
               (scenario.expectedSuccesses == null ||
                    verification.distinctClaims === scenario.expectedSuccesses);

          const results = {
               runId,
               scenario: opts.scenario,
               strategy: strategy.id,
               strategyName: strategy.name,
               expectedSafe: strategy.expectedSafe,
               seed,
               concurrency,
               bucketCount: strategy.isPool ? bucketCount : undefined,
               wallMs,
               ...stats,
               ...verification,
               contention,
               environment: env,
               // A run that violated an invariant is not a valid data point for
               // throughput or latency, however good those numbers look.
               valid,
               verdict: this.#verdict(strategy, verification, scenario),
          };

          await this.adminPool.query(`UPDATE lab.runs SET finished_at = now(), results = $2 WHERE id = $1`, [
               runId,
               JSON.stringify(results),
          ]);

          return results;
     }

     /** Create this run's isolated inventory. */
     async #seed(runId, scenario, strategy, bucketCount) {
          if (strategy.isPool) {
               const capacity = scenario.resources;
               const perBucket = Math.floor(capacity / bucketCount);
               const remainder = capacity % bucketCount;
               const table = strategy.table === 'pool-unsafe' ? 'lab.pool_buckets_unsafe' : 'lab.pool_buckets';
               for (let b = 0; b < bucketCount; b++) {
                    await this.adminPool.query(
                         `INSERT INTO ${table} (run_id, bucket, capacity, taken) VALUES ($1, $2, $3, 0)`,
                         [runId, b, perBucket + (b < remainder ? 1 : 0)]
                    );
               }
               return [];
          }

          // Real resource rows are reused as identifiers so that the lab
          // exercises the same id shape as production, but all lab state lives
          // in the `lab` schema and never touches the allocations table.
          const ids = Array.from({ length: scenario.resources }, () => crypto.randomUUID());
          const values = ids.map((_, i) => `($1, $${i + 2}, 'AVAILABLE', 0)`).join(', ');
          await this.adminPool.query(
               `INSERT INTO lab.resource_state (run_id, resource_id, status, version) VALUES ${values}`,
               [runId, ...ids]
          );
          return ids;
     }

     /**
      * Drive the plan with bounded concurrency, warm connections and a
      * starting barrier.
      *
      * Three deliberate properties, each learned by getting it wrong first:
      *
      * 1. WARM CONNECTIONS. Every worker acquires its database client and
      *    completes a round trip BEFORE any measured work begins. The first
      *    version connected lazily inside each request, and connection setup
      *    took long enough that worker 1 finished its whole transaction before
      *    worker 40 had a socket. The requests were serialised by connection
      *    establishment, so the naive strategy never actually raced and
      *    reported zero oversells — a false clean bill of health.
      *
      * 2. STARTING BARRIER. All workers wait on one promise and are released
      *    together, so the contended statements genuinely overlap. Without it,
      *    the workload is a staggered trickle and contention is whatever the
      *    ramp happened to produce.
      *
      * 3. ONE CLIENT PER VIRTUAL USER. Each worker owns its connection for the
      *    run, which models a connected client and keeps pool queueing out of
      *    the latency figures. Pool pressure is a real concern, but it belongs
      *    in the HTTP benchmarks where the service's own pool is under test —
      *    not mixed into a measurement of locking behaviour.
      */
     async #execute(plan, strategy, ctx, concurrency) {
          const observations = new Array(plan.length);
          const workerCount = Math.min(concurrency, plan.length);
          let cursor = 0;

          // The barrier every worker waits on.
          let releaseStart;
          const startGate = new Promise((resolve) => {
               releaseStart = resolve;
          });

          let readyCount = 0;
          let allReady;
          const readyGate = new Promise((resolve) => {
               allReady = resolve;
          });

          const worker = async (workerId) => {
               // Acquire and warm this worker's dedicated connection.
               const client = await this.pool.connect();
               try {
                    await client.query('SELECT 1');

                    if (++readyCount === workerCount) allReady();
                    await startGate;

                    const workerCtx = { ...ctx, client };

                    for (;;) {
                         const index = cursor++;
                         if (index >= plan.length) return;
                         const req = plan[index];

                         const startedAt = new Date();
                         const t0 = process.hrtime.bigint();
                         let result;
                         try {
                              result = await strategy.reserve(workerCtx, req);
                         } catch (err) {
                              result = { outcome: 'ERROR', retries: 0, detail: err.message };
                         }
                         const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;

                         observations[index] = {
                              worker: workerId,
                              attemptNo: req.attemptNo,
                              outcome: result.outcome,
                              latencyMs,
                              retries: result.retries ?? 0,
                              sqlstate: result.sqlstate ?? null,
                              detail: result.detail ?? null,
                              shed: result.shed ?? false,
                              startedAt,
                         };
                    }
               } finally {
                    // One release per acquire, on every path. The first version
                    // returned early on "seat taken" without releasing, which
                    // leaked a connection per losing request and deadlocked the
                    // pool a few dozen requests into the run.
                    client.release();
               }
          };

          const workers = Array.from({ length: workerCount }, (_, i) => worker(i));

          // Release the barrier once every worker is connected — or if a worker
          // died during warm-up, so a failure cannot hang the run forever.
          Promise.race([readyGate, Promise.allSettled(workers)]).then(() => releaseStart());

          await Promise.all(workers);
          return observations;
     }

     /**
      * Sample `pg_stat_activity` while the workload runs.
      *
      * Without this, a slow p99 is unexplained. With it, the report can say
      * *why*: transactions parked on a tuple lock, on the GiST index, or simply
      * queueing for a connection.
      */
     #startContentionSampler(intervalMs = 100) {
          const samples = [];
          let deadlocksStart = null;

          const capture = async () => {
               try {
                    const { rows } = await this.adminPool.query(
                         `SELECT wait_event_type, wait_event, count(*)::int AS n
                            FROM pg_stat_activity
                           WHERE datname = current_database() AND state = 'active'
                           GROUP BY 1, 2`
                    );
                    samples.push(rows);
               } catch {
                    /* sampling must never affect the run */
               }
          };

          this.adminPool
               .query(`SELECT deadlocks, xact_rollback FROM pg_stat_database WHERE datname = current_database()`)
               .then(({ rows }) => {
                    deadlocksStart = rows[0];
               })
               .catch(() => {});

          const timer = setInterval(capture, intervalMs);
          timer.unref?.();

          return {
               stop: () => {
                    clearInterval(timer);
                    const waits = {};
                    for (const sample of samples) {
                         for (const row of sample) {
                              const key = `${row.wait_event_type ?? 'Running'}:${row.wait_event ?? '-'}`;
                              waits[key] = (waits[key] ?? 0) + row.n;
                         }
                    }
                    const total = Object.values(waits).reduce((a, b) => a + b, 0) || 1;
                    const topWaits = Object.entries(waits)
                         .sort((a, b) => b[1] - a[1])
                         .slice(0, 8)
                         .map(([event, n]) => ({ event, samples: n, share: +(n / total).toFixed(3) }));
                    return { sampleCount: samples.length, topWaits, deadlocksStart };
               },
          };
     }

     async #persistObservations(runId, observations) {
          const CHUNK = 500;
          for (let i = 0; i < observations.length; i += CHUNK) {
               const chunk = observations.slice(i, i + CHUNK).filter(Boolean);
               if (chunk.length === 0) continue;
               const values = [];
               const tuples = chunk.map((o, j) => {
                    const b = j * 8;
                    values.push(
                         runId,
                         o.worker,
                         o.attemptNo,
                         o.outcome,
                         o.latencyMs,
                         o.retries,
                         o.sqlstate,
                         o.startedAt
                    );
                    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
               });
               await this.adminPool.query(
                    `INSERT INTO lab.observations
                            (run_id, worker, attempt_no, outcome, latency_ms, retries, sqlstate, started_at)
                     VALUES ${tuples.join(', ')}`,
                    values
               );
          }
     }

     /**
      * Ask the database what actually happened.
      *
      * `distinctClaims` counts resource-spans claimed at least once — the real
      * number of units sold. `oversells` counts those claimed more than once.
      */
     async #verify(runId, scenario, strategy) {
          if (strategy.isPool) {
               const table = strategy.table === 'pool-unsafe' ? 'lab.pool_buckets_unsafe' : 'lab.pool_buckets';
               const { rows } = await this.adminPool.query(
                    `SELECT COALESCE(sum(taken), 0)::int AS taken,
                            COALESCE(sum(capacity), 0)::int AS capacity,
                            COALESCE(sum(GREATEST(taken - capacity, 0)), 0)::int AS excess
                       FROM ${table} WHERE run_id = $1`,
                    [runId]
               );
               const r = rows[0];
               return {
                    distinctClaims: r.taken,
                    capacity: r.capacity,
                    oversells: r.excess,
                    overlaps: 0,
               };
          }

          const table = strategy.table === 'guarded' ? 'lab.allocations_guarded' : 'lab.allocations_unsafe';
          const oversellView = strategy.table === 'guarded' ? 'lab.oversells_guarded' : 'lab.oversells_unsafe';

          const { rows: claims } = await this.adminPool.query(
               `SELECT count(DISTINCT (resource_id, span))::int AS distinct_claims,
                       count(*)::int AS total_rows
                  FROM ${table}
                 WHERE run_id = $1 AND state IN ('HELD','CONFIRMED')`,
               [runId]
          );

          const { rows: oversells } = await this.adminPool.query(
               `SELECT COALESCE(sum(claim_count - 1), 0)::int AS extra
                  FROM ${oversellView} WHERE run_id = $1`,
               [runId]
          );

          // Overlap check matters for segment scenarios, where two conflicting
          // claims are not identical rows and therefore invisible to a
          // duplicate-row check.
          let overlaps = 0;
          if (strategy.table !== 'guarded') {
               const { rows } = await this.adminPool.query(
                    `SELECT count(*)::int AS n FROM lab.overlaps_unsafe WHERE run_id = $1`,
                    [runId]
               );
               overlaps = rows[0].n;
          }

          return {
               distinctClaims: claims[0].distinct_claims,
               totalRows: claims[0].total_rows,
               capacity: scenario.resources,
               oversells: oversells[0].extra,
               overlaps,
          };
     }

     #summarise(observations, wallMs) {
          const done = observations.filter(Boolean);
          const latencies = done.map((o) => o.latencyMs).sort((a, b) => a - b);

          const count = (outcome) => done.filter((o) => o.outcome === outcome).length;
          const pct = (p) => {
               if (latencies.length === 0) return 0;
               const idx = Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1);
               return +latencies[Math.max(0, idx)].toFixed(2);
          };

          return {
               attempts: done.length,
               successes: count('SUCCESS'),
               conflicts: count('CONFLICT'),
               errors: count('ERROR'),
               timeouts: count('TIMEOUT'),
               shed: done.filter((o) => o.shed).length,
               totalRetries: done.reduce((sum, o) => sum + o.retries, 0),
               throughputPerSec: +(done.length / (wallMs / 1000)).toFixed(1),
               latency: {
                    p50: pct(50),
                    p95: pct(95),
                    p99: pct(99),
                    max: latencies.length ? +latencies[latencies.length - 1].toFixed(2) : 0,
                    mean: latencies.length
                         ? +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)
                         : 0,
               },
          };
     }

     #verdict(strategy, verification, scenario) {
          if (verification.oversells > 0 || verification.overlaps > 0) {
               // Report in customer terms. "2016 overlapping pairs" is the pair
               // count for 64 rows on one seat and reads as a bigger number than
               // the fact it describes; what a reviewer needs to know is how many
               // people were sold the same thing.
               const people = verification.oversells + 1;
               const detail =
                    `${people} customers hold the same resource-span ` +
                    `(${verification.oversells} more than capacity allows)` +
                    (verification.overlaps > 0 ? `, ${verification.overlaps} overlapping pair(s)` : '');
               return strategy.expectedSafe
                    ? `UNEXPECTED OVERSELL — ${strategy.id} was expected to be safe: ${detail}`
                    : `OVERSOLD AS PREDICTED — ${detail}; this is why the constraint exists`;
          }
          if (scenario.expectedSuccesses != null && verification.distinctClaims !== scenario.expectedSuccesses) {
               return (
                    `INVENTORY LOST — ${verification.distinctClaims} of ${scenario.expectedSuccesses} units ` +
                    `were allocated; no oversell, but capacity went unsold`
               );
          }
          return 'CORRECT — no duplicate or overlapping claims';
     }

     #environment() {
          let gitCommit = null;
          let gitDirty = null;
          try {
               gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
               gitDirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
          } catch {
               /* not a git checkout */
          }
          return {
               gitCommit,
               gitDirty,
               node: process.version,
               platform: `${os.platform()} ${os.release()}`,
               cpus: os.cpus().length,
               cpuModel: os.cpus()[0]?.model ?? 'unknown',
               totalMemGb: +(os.totalmem() / 1024 ** 3).toFixed(1),
               // Everything here runs on one developer laptop with the database
               // in a Docker VM. These numbers characterise relative behaviour
               // between strategies; they are not production capacity figures.
               note: 'single-machine run; Docker Desktop VM; not a production capacity measurement',
          };
     }

     /** Remove a run's lab data. Production tables are never touched. */
     async cleanup(runId) {
          for (const table of [
               'lab.observations',
               'lab.allocations_unsafe',
               'lab.allocations_guarded',
               'lab.resource_state',
               'lab.pool_buckets',
               'lab.pool_buckets_unsafe',
          ]) {
               await this.adminPool.query(`DELETE FROM ${table} WHERE run_id = $1`, [runId]);
          }
     }
}

module.exports = { LabRunner };
