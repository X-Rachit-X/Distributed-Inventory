'use strict';

/**
 * Outbound HTTP with a deadline.
 *
 * Every call one service makes to another goes through here, so each has the
 * same two properties:
 *
 *   - a hard deadline covering the whole exchange, including reading the body.
 *     A call without one can hang forever, holding whatever the caller holds;
 *   - a timeout that is reported as itself (`UPSTREAM_TIMEOUT`), never as a
 *     generic failure. For a payment, "it did not answer" means UNKNOWN, which
 *     is a different outcome from "it said no".
 *
 * It does not interpret status codes. Callers know what a 404 or a 409 means
 * for them; this only moves bytes and enforces the deadline.
 */

class UpstreamTimeoutError extends Error {
     constructor(method, url, timeoutMs) {
          super(`${method} ${url} did not respond within ${timeoutMs}ms`);
          this.name = 'UpstreamTimeoutError';
          this.code = 'UPSTREAM_TIMEOUT';
          this.timeoutMs = timeoutMs;
     }
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method]     Default GET.
 * @param {object} [opts.headers]
 * @param {any}    [opts.json]       Sent as a JSON body with a JSON content type.
 * @param {string} [opts.body]       Sent as-is (use with your own content type).
 * @param {number} [opts.timeoutMs]  Deadline for the whole exchange. Default 5000.
 * @param {'json'|'text'} [opts.as]  How to read the response body. Default json;
 *                                   an unparseable JSON body reads as null.
 * @returns {Promise<{ status: number, ok: boolean, headers: Headers, body: any }>}
 */
async function httpRequest(url, { method = 'GET', headers = {}, json, body, timeoutMs = 5000, as = 'json' } = {}) {
     const controller = new AbortController();
     const timer = setTimeout(() => controller.abort(), timeoutMs);
     try {
          const res = await fetch(url, {
               method,
               signal: controller.signal,
               headers: json !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
               body: json !== undefined ? JSON.stringify(json) : body,
          });
          const text = await res.text();
          let parsed = text;
          if (as === 'json') {
               try {
                    parsed = text ? JSON.parse(text) : null;
               } catch {
                    parsed = null;
               }
          }
          return { status: res.status, ok: res.ok, headers: res.headers, body: parsed };
     } catch (err) {
          if (err.name === 'AbortError') throw new UpstreamTimeoutError(method, url, timeoutMs);
          throw err;
     } finally {
          clearTimeout(timer);
     }
}

/** Readiness probe for another service: true when its /health answers 2xx in time. */
async function isHealthy(baseUrl, timeoutMs = 2000) {
     const res = await httpRequest(`${baseUrl.replace(/\/$/, '')}/health`, { timeoutMs });
     return res.ok;
}

const isTimeout = (err) => err?.code === 'UPSTREAM_TIMEOUT';

module.exports = { httpRequest, isHealthy, isTimeout, UpstreamTimeoutError };
