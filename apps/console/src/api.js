/**
 * Gateway client.
 *
 * Two behaviours here matter more than the request plumbing:
 *
 * 1. A 409 IS NOT AN ERROR TO PANIC ABOUT. Under contention, "someone took that
 *    seat" is the system working correctly. The client surfaces it as a typed
 *    conflict so the UI can say something useful and offer another seat, rather
 *    than showing a generic failure.
 *
 * 2. A 429 CARRIES `Retry-After`. Retrying sooner than the server asked makes
 *    throttling worse for everyone, so the delay is honoured rather than guessed.
 */

const BASE = '/api';

export class ApiError extends Error {
     constructor(message, { status, code, retryAfterSeconds }) {
          super(message);
          this.status = status;
          this.code = code;
          this.retryAfterSeconds = retryAfterSeconds;
     }

     /** Expected under contention — the user should be offered an alternative. */
     get isConflict() {
          return this.status === 409;
     }

     get isRateLimited() {
          return this.status === 429;
     }

     /** The system shed load to protect itself. Retrying shortly will work. */
     get isOverloaded() {
          return this.status === 503;
     }
}

let authToken = null;
export const setToken = (token) => {
     authToken = token;
};

async function request(path, { method = 'GET', body, idempotencyKey, headers = {} } = {}) {
     const res = await fetch(`${BASE}${path}`, {
          method,
          headers: {
               'content-type': 'application/json',
               ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
               ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
               ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
     });

     if (res.status === 204) return null;

     const json = await res.json().catch(() => null);

     if (!res.ok) {
          throw new ApiError(json?.error?.message || `Request failed (${res.status})`, {
               status: res.status,
               code: json?.error?.code,
               retryAfterSeconds: Number(res.headers.get('retry-after')) || undefined,
          });
     }

     return json;
}

/**
 * A stable idempotency key for one booking ATTEMPT.
 *
 * Generated once when the user presses Book and reused for every retry of that
 * same attempt, which is the whole point: a retry after a lost response must be
 * recognised as the same request, not as a second booking.
 */
export const newIdempotencyKey = () =>
     `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const api = {
     login: (email) => request('/auth/login', { method: 'POST', body: { email } }),

     listEvents: () => request('/events'),

     availability: (eventId, spanFrom, spanTo) =>
          request(`/events/${eventId}/availability?spanFrom=${spanFrom}&spanTo=${spanTo}`),

     resources: (eventId, spanFrom, spanTo) =>
          request(`/events/${eventId}/resources?spanFrom=${spanFrom}&spanTo=${spanTo}`),

     reserve: (payload, idempotencyKey) =>
          request('/reservations', { method: 'POST', body: payload, idempotencyKey }),

     getReservation: (id) => request(`/reservations/${id}`),

     listReservations: () => request('/reservations'),

     cancel: (id) => request(`/reservations/${id}/cancel`, { method: 'POST' }),

     invariants: () => request('/ops/invariants'),
};
