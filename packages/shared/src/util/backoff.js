'use strict';

const { isRetryablePgError } = require('../errors');

/**
 * Full-jitter exponential backoff (AWS's "Exponential Backoff and Jitter").
 *
 * Plain exponential backoff synchronises retries: every client that collided at
 * t=0 retries together at t=100ms, collides again, and retries together at
 * t=200ms. Under flash-sale contention that turns a retry policy into a
 * self-inflicted thundering herd. Full jitter spreads the retries across the
 * whole window, which is what actually drains a contention spike.
 */
function fullJitter(attempt, { baseMs = 20, maxMs = 1_000 } = {}) {
     const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
     return Math.floor(Math.random() * ceiling);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry `fn` while `shouldRetry` says the failure is transient.
 *
 * Returns `{ value, attempts }` so callers can record retry counts as a metric —
 * retries hidden inside a helper are how "fast p50, terrible p99" happens.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts]
 * @param {(err: Error) => boolean} [opts.shouldRetry]
 * @param {(info: {attempt:number, delayMs:number, error:Error}) => void} [opts.onRetry]
 * @returns {Promise<{ value: T, attempts: number }>}
 */
async function retry(fn, opts = {}) {
     const maxAttempts = opts.maxAttempts ?? 3;
     const shouldRetry = opts.shouldRetry ?? isRetryablePgError;
     let lastError;

     for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
               const value = await fn(attempt);
               return { value, attempts: attempt };
          } catch (err) {
               lastError = err;
               if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
               const delayMs = fullJitter(attempt, opts);
               opts.onRetry?.({ attempt, delayMs, error: err });
               await sleep(delayMs);
          }
     }
     throw lastError;
}

module.exports = { fullJitter, retry, sleep };
