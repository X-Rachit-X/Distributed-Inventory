'use strict';

/**
 * Error taxonomy.
 *
 * The distinction that matters most in this system is CONFLICT vs FAILURE.
 * A conflict ("someone else took that seat") is a correct, expected outcome of a
 * correctly working system under contention — it must be a 409, must be cheap,
 * and must never be retried blindly. A failure is a fault. Load tests count
 * these separately, because a run where conflicts became 500s looks successful
 * on a latency graph while being badly broken.
 */

class TesseraError extends Error {
     constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null, retryable = false } = {}) {
          super(message);
          this.name = this.constructor.name;
          this.status = status;
          this.code = code;
          this.details = details;
          this.retryable = retryable;
          Error.captureStackTrace?.(this, this.constructor);
     }

     toJSON() {
          return { error: { code: this.code, message: this.message, details: this.details } };
     }
}

class BadRequestError extends TesseraError {
     constructor(message, code = 'BAD_REQUEST', details = null) {
          super(message, { status: 400, code, details });
     }
}

class UnauthorizedError extends TesseraError {
     constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
          super(message, { status: 401, code });
     }
}

class ForbiddenError extends TesseraError {
     constructor(message = 'Not permitted', code = 'FORBIDDEN') {
          super(message, { status: 403, code });
     }
}

class NotFoundError extends TesseraError {
     constructor(message = 'Not found', code = 'NOT_FOUND') {
          super(message, { status: 404, code });
     }
}

/**
 * The resource was taken by someone else, or state moved under us.
 * Expected under contention. Not a fault.
 */
class ConflictError extends TesseraError {
     constructor(message, code = 'CONFLICT', details = null) {
          super(message, { status: 409, code, details });
     }
}

/** A hold expired before it could be confirmed. Distinct from a plain conflict. */
class HoldExpiredError extends ConflictError {
     constructor(message = 'Hold has expired', details = null) {
          super(message, 'HOLD_EXPIRED', details);
     }
}

/** An idempotent request is still executing on another connection. */
class InProgressError extends TesseraError {
     constructor(message = 'A request with this idempotency key is still in progress', retryAfterSeconds = 1) {
          super(message, { status: 409, code: 'IDEMPOTENT_REQUEST_IN_PROGRESS', retryable: true });
          this.retryAfterSeconds = retryAfterSeconds;
     }
}

/** Same idempotency key, different request body. Always a client bug or an attack. */
class IdempotencyKeyReuseError extends TesseraError {
     constructor(message = 'Idempotency-Key was reused with a different request body') {
          super(message, { status: 422, code: 'IDEMPOTENCY_KEY_REUSE' });
     }
}

class TooManyRequestsError extends TesseraError {
     constructor(message = 'Rate limit exceeded', retryAfterSeconds = 1, code = 'RATE_LIMITED') {
          super(message, { status: 429, code, retryable: true });
          this.retryAfterSeconds = retryAfterSeconds;
     }
}

/**
 * Admission control rejected the request to protect the database.
 * Deliberately distinct from rate limiting: this is about *system* capacity,
 * not about one client's request frequency.
 */
class LoadSheddingError extends TesseraError {
     constructor(message = 'Server is shedding load', retryAfterSeconds = 2) {
          super(message, { status: 503, code: 'LOAD_SHED', retryable: true });
          this.retryAfterSeconds = retryAfterSeconds;
     }
}

class ServiceUnavailableError extends TesseraError {
     constructor(message = 'Dependency unavailable', code = 'SERVICE_UNAVAILABLE') {
          super(message, { status: 503, code, retryable: true });
     }
}

/** A CAS update found the row already changed by another process. */
class StaleStateError extends ConflictError {
     constructor(message = 'State changed concurrently', details = null) {
          super(message, 'STALE_STATE', details);
     }
}

// ── PostgreSQL error classification ─────────────────────────────────────────
// These SQLSTATEs are the difference between "expected contention" and "bug".

const PG = {
     UNIQUE_VIOLATION: '23505',
     EXCLUSION_VIOLATION: '23P01',
     CHECK_VIOLATION: '23514',
     FOREIGN_KEY_VIOLATION: '23503',
     SERIALIZATION_FAILURE: '40001',
     DEADLOCK_DETECTED: '40P01',
     LOCK_NOT_AVAILABLE: '55P03',
     QUERY_CANCELED: '57014',
};

/** The exclusion constraint fired: two live allocations would have overlapped. */
const isOversellPrevented = (err) => err && err.code === PG.EXCLUSION_VIOLATION;

/** Transient contention. Safe to retry with backoff — the transaction did not commit. */
const isRetryablePgError = (err) =>
     !!err &&
     (err.code === PG.SERIALIZATION_FAILURE ||
          err.code === PG.DEADLOCK_DETECTED ||
          err.code === PG.LOCK_NOT_AVAILABLE);

module.exports = {
     TesseraError,
     BadRequestError,
     UnauthorizedError,
     ForbiddenError,
     NotFoundError,
     ConflictError,
     HoldExpiredError,
     InProgressError,
     IdempotencyKeyReuseError,
     TooManyRequestsError,
     LoadSheddingError,
     ServiceUnavailableError,
     StaleStateError,
     PG,
     isOversellPrevented,
     isRetryablePgError,
};
