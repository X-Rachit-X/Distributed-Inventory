'use strict';

/**
 * Deterministic fault injection.
 *
 * The chaos scenarios this system must survive are defined by *where* the crash
 * happens, not by which process died:
 *
 *   - outbox row committed, crash BEFORE the Kafka publish   → row stays PENDING, retried
 *   - Kafka publish succeeded, crash BEFORE marking PUBLISHED → duplicate event, consumer dedupes
 *   - business row committed, crash BEFORE the HTTP response → client retry replays idempotently
 *
 * `docker kill` cannot reliably land in those windows. A named failpoint can:
 * production code calls `await failpoint('outbox.after_publish_before_mark')`,
 * which is a no-op (a few nanoseconds, no allocation) unless explicitly armed.
 *
 * Safety: failpoints are inert unless FAILPOINTS_ENABLED=true, and the arming
 * endpoint is never mounted in the production profile.
 */

const ENABLED = process.env.FAILPOINTS_ENABLED === 'true';

/** @type {Map<string, {action: string, count: number, probability: number, delayMs: number, hits: number}>} */
const armed = new Map();

/**
 * Arm a failpoint.
 * @param {string} name
 * @param {object} spec
 * @param {'crash'|'throw'|'delay'|'drop'} spec.action
 *   crash — process.exit(9), simulating SIGKILL at this exact line
 *   throw — raise an error, simulating a downstream failure
 *   delay — sleep, simulating a slow dependency or a lease expiring mid-work
 *   drop  — signal the caller to silently skip its side effect (returns true)
 * @param {number} [spec.count]        How many times to fire before disarming. Default 1.
 * @param {number} [spec.probability]  0..1, fire probabilistically. Default 1.
 * @param {number} [spec.delayMs]      For action 'delay'.
 */
function arm(name, spec) {
     if (!ENABLED) throw new Error('Failpoints are disabled (set FAILPOINTS_ENABLED=true)');
     armed.set(name, {
          action: spec.action,
          count: spec.count ?? 1,
          probability: spec.probability ?? 1,
          delayMs: spec.delayMs ?? 0,
          message: spec.message ?? `failpoint ${name} fired`,
          hits: 0,
     });
}

function disarm(name) {
     armed.delete(name);
}

function disarmAll() {
     armed.clear();
}

function list() {
     return [...armed.entries()].map(([name, f]) => ({ name, ...f }));
}

/**
 * Evaluation point. Compiles to a single boolean check when disabled.
 *
 * @param {string} name
 * @returns {Promise<boolean>} true when the caller should SKIP its side effect ('drop').
 */
async function failpoint(name) {
     if (!ENABLED || armed.size === 0) return false;
     const f = armed.get(name);
     if (!f) return false;
     if (f.probability < 1 && Math.random() > f.probability) return false;

     f.hits += 1;
     if (f.count > 0 && f.hits >= f.count) armed.delete(name);

     switch (f.action) {
          case 'crash':
               // Bypass every shutdown hook, finally block and buffer flush.
               // This is the point: an orderly exit would not test crash recovery.
               // eslint-disable-next-line no-console
               console.error(`[failpoint] ${name}: crashing process`);
               process.exit(9);
               return false; // unreachable, kept for type clarity
          case 'throw': {
               const err = new Error(f.message);
               err.code = 'FAILPOINT';
               err.failpoint = name;
               throw err;
          }
          case 'delay':
               await new Promise((r) => setTimeout(r, f.delayMs));
               return false;
          case 'drop':
               return true;
          default:
               return false;
     }
}

/**
 * Express router exposing arm/disarm/list. Mount ONLY when failpoints are enabled.
 * Returns null otherwise so a caller can `if (r) app.use('/_failpoints', r)`.
 */
function router(express) {
     if (!ENABLED) return null;
     const r = express.Router();
     r.use(express.json());
     r.get('/', (_req, res) => res.json({ enabled: true, armed: list() }));
     r.post('/:name', (req, res) => {
          try {
               arm(req.params.name, req.body || {});
               res.status(201).json({ armed: req.params.name, spec: req.body });
          } catch (err) {
               res.status(400).json({ error: err.message });
          }
     });
     r.delete('/:name', (req, res) => {
          disarm(req.params.name);
          res.status(204).end();
     });
     r.delete('/', (_req, res) => {
          disarmAll();
          res.status(204).end();
     });
     return r;
}

module.exports = { failpoint, arm, disarm, disarmAll, list, router, ENABLED };
