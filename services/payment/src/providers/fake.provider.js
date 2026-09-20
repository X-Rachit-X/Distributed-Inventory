'use strict';

/**
 * Fault-injecting payment provider.
 *
 * Real gateway sandboxes can simulate a declined card. They cannot simulate the
 * failures that actually break reservation systems:
 *
 *   - the charge succeeds and the response is lost in the network
 *   - the webhook arrives twice
 *   - the webhook for capture arrives BEFORE the one for authorisation
 *   - the provider takes 40 seconds to answer and our deadline passes
 *   - the provider returns 500 after having taken the money
 *
 * Those are precisely the cases the saga's UNKNOWN state and the resolver exist
 * to handle, so they have to be reproducible on demand. This provider makes
 * them a configuration value.
 *
 * It keeps an internal "provider-side" ledger, deliberately separate from our
 * database, so that `getStatus()` can tell the truth about a charge our own
 * records know nothing about — which is the entire point of resolution.
 */

const crypto = require('node:crypto');

const MODES = [
     'ok', // authorise and capture normally
     'decline', // provider refuses the charge
     'timeout_after_success', // charge succeeds, we never hear back  ← the dangerous one
     'timeout_before_success', // request never reached the provider
     'slow', // answers, but after a long delay
     'error_after_success', // 500 returned after the money moved
     'duplicate_webhook', // same webhook delivered twice
     'out_of_order_webhook', // capture webhook precedes authorisation
];

class FakeProvider {
     /**
      * @param {object} opts
      * @param {string} opts.webhookSecret  Shared secret for HMAC signing.
      * @param {string} [opts.mode]         Default behaviour.
      * @param {number} [opts.slowMs]
      */
     constructor({ webhookSecret, mode = 'ok', slowMs = 40_000, logger = console } = {}) {
          this.name = 'fake';
          this.webhookSecret = webhookSecret || 'tessera-dev-webhook-secret';
          this.mode = mode;
          this.slowMs = slowMs;
          this.logger = logger;

          // The provider's own books. Survives independently of our database,
          // which is what makes `getStatus` meaningful after a lost response.
          this.charges = new Map();
          this.webhookSink = null;
     }

     setMode(mode) {
          if (!MODES.includes(mode)) throw new Error(`Unknown mode ${mode}. Known: ${MODES.join(', ')}`);
          this.mode = mode;
     }

     /** Where to deliver webhooks. In tests, a function; in the stack, an HTTP post. */
     onWebhook(fn) {
          this.webhookSink = fn;
     }

     /**
      * Create and attempt a charge.
      *
      * `idempotencyKey` is ours. A repeat with the same key returns the ORIGINAL
      * charge rather than creating a second one — the behaviour every real
      * provider offers and that makes a safe retry possible at all.
      */
     async charge({ idempotencyKey, amountCents, currency = 'INR', reservationId, mode }) {
          const effective = mode || this.mode;

          const existing = [...this.charges.values()].find((c) => c.idempotencyKey === idempotencyKey);
          if (existing) {
               return this.#respond(existing, effective, { replayed: true });
          }

          const charge = {
               providerPaymentId: `fk_pay_${crypto.randomUUID().slice(0, 12)}`,
               providerRef: `fk_ord_${crypto.randomUUID().slice(0, 12)}`,
               idempotencyKey,
               amountCents,
               currency,
               reservationId,
               state: 'CREATED',
               createdAt: new Date(),
          };
          this.charges.set(charge.providerPaymentId, charge);

          switch (effective) {
               case 'decline':
                    charge.state = 'FAILED';
                    charge.failureReason = 'card_declined';
                    return { ok: false, state: 'FAILED', reason: 'card_declined', ...this.#ids(charge) };

               case 'timeout_before_success':
                    // The request never landed. No money moved — but we cannot
                    // know that from here, which is exactly why the caller must
                    // record UNKNOWN rather than assume either way.
                    this.charges.delete(charge.providerPaymentId);
                    throw this.#timeoutError();

               case 'timeout_after_success':
                    // THE DANGEROUS ONE. The customer has been charged.
                    charge.state = 'CAPTURED';
                    charge.capturedAt = new Date();
                    this.#emitWebhookLater(charge, 'payment.captured', 1500);
                    throw this.#timeoutError();

               case 'error_after_success':
                    charge.state = 'CAPTURED';
                    charge.capturedAt = new Date();
                    this.#emitWebhookLater(charge, 'payment.captured', 1000);
                    {
                         const err = new Error('provider returned 500 after capture');
                         err.code = 'PROVIDER_ERROR';
                         err.httpStatus = 500;
                         throw err;
                    }

               case 'slow':
                    await new Promise((r) => setTimeout(r, this.slowMs));
                    charge.state = 'CAPTURED';
                    charge.capturedAt = new Date();
                    return { ok: true, state: 'CAPTURED', ...this.#ids(charge) };

               case 'duplicate_webhook':
                    charge.state = 'CAPTURED';
                    charge.capturedAt = new Date();
                    this.#emitWebhookLater(charge, 'payment.captured', 100);
                    this.#emitWebhookLater(charge, 'payment.captured', 300); // same event id
                    return { ok: true, state: 'CAPTURED', ...this.#ids(charge) };

               case 'out_of_order_webhook':
                    charge.state = 'CAPTURED';
                    charge.capturedAt = new Date();
                    // Capture first, authorisation second.
                    this.#emitWebhookLater(charge, 'payment.captured', 100);
                    this.#emitWebhookLater(charge, 'payment.authorized', 400);
                    return { ok: true, state: 'CAPTURED', ...this.#ids(charge) };

               case 'ok':
               default:
                    charge.state = 'CAPTURED';
                    charge.capturedAt = new Date();
                    this.#emitWebhookLater(charge, 'payment.captured', 50);
                    return { ok: true, state: 'CAPTURED', ...this.#ids(charge) };
          }
     }

     /**
      * Authoritative status lookup.
      *
      * This is how an UNKNOWN payment is resolved: ask the provider what it
      * believes, using our own reference. Guessing, or retrying the charge, is
      * how customers get charged twice.
      */
     async getStatus({ idempotencyKey, providerPaymentId }) {
          const charge = providerPaymentId
               ? this.charges.get(providerPaymentId)
               : [...this.charges.values()].find((c) => c.idempotencyKey === idempotencyKey);

          if (!charge) return { found: false, state: 'NOT_FOUND' };
          return {
               found: true,
               state: charge.state,
               amountCents: charge.amountCents,
               failureReason: charge.failureReason ?? null,
               ...this.#ids(charge),
          };
     }

     async refund({ providerPaymentId, amountCents, idempotencyKey }) {
          const charge = this.charges.get(providerPaymentId);
          if (!charge) {
               const err = new Error('unknown payment');
               err.code = 'NOT_FOUND';
               throw err;
          }
          if (charge.state !== 'CAPTURED') {
               const err = new Error(`cannot refund a payment in state ${charge.state}`);
               err.code = 'INVALID_STATE';
               throw err;
          }
          charge.refunded = (charge.refunded ?? 0) + amountCents;
          return {
               ok: true,
               providerRefundId: `fk_ref_${crypto.randomUUID().slice(0, 12)}`,
               idempotencyKey,
          };
     }

     // ── Webhook signing ──────────────────────────────────────────────────
     //
     // Timestamp is inside the signed payload, so an attacker cannot replay a
     // captured webhook outside the freshness window without invalidating the
     // signature.

     sign(rawBody, timestamp) {
          return crypto
               .createHmac('sha256', this.webhookSecret)
               .update(`${timestamp}.${rawBody}`)
               .digest('hex');
     }

     verify(rawBody, signature, timestamp, toleranceSeconds = 300) {
          const age = Math.abs(Date.now() / 1000 - Number(timestamp));
          if (!Number.isFinite(age) || age > toleranceSeconds) {
               return { valid: false, reason: 'timestamp outside tolerance window' };
          }
          const expected = this.sign(rawBody, timestamp);
          const a = Buffer.from(expected);
          const b = Buffer.from(String(signature ?? ''));
          // Constant-time compare: a naive === leaks how much of the signature
          // matched, which is enough to forge one given enough attempts.
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
               return { valid: false, reason: 'signature mismatch' };
          }
          return { valid: true };
     }

     #emitWebhookLater(charge, eventType, delayMs) {
          if (!this.webhookSink) return;
          const eventId = `fk_evt_${crypto.createHash('sha1').update(`${charge.providerPaymentId}:${eventType}`).digest('hex').slice(0, 16)}`;
          const body = JSON.stringify({
               id: eventId,
               type: eventType,
               created: Math.floor(Date.now() / 1000),
               data: {
                    payment_id: charge.providerPaymentId,
                    order_ref: charge.providerRef,
                    amount: charge.amountCents,
                    currency: charge.currency,
                    reservation_id: charge.reservationId,
               },
          });
          const timestamp = Math.floor(Date.now() / 1000);
          const timer = setTimeout(() => {
               this.webhookSink({ body, signature: this.sign(body, timestamp), timestamp }).catch((err) =>
                    this.logger.error?.('fake provider webhook delivery failed', { error: err.message })
               );
          }, delayMs);
          timer.unref?.();
     }

     #timeoutError() {
          const err = new Error('provider did not respond within the deadline');
          err.code = 'PROVIDER_TIMEOUT';
          // The flag the payment service keys on to record UNKNOWN rather than
          // FAILED. A timeout is an absence of information, not a negative answer.
          err.indeterminate = true;
          return err;
     }

     #ids(charge) {
          return { providerPaymentId: charge.providerPaymentId, providerRef: charge.providerRef };
     }

     #respond(charge, mode, extra = {}) {
          if (charge.state === 'FAILED') {
               return { ok: false, state: 'FAILED', reason: charge.failureReason, ...this.#ids(charge), ...extra };
          }
          return { ok: true, state: charge.state, ...this.#ids(charge), ...extra };
     }
}

module.exports = { FakeProvider, MODES };
