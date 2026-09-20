'use strict';

/**
 * Structured logging with correlation identifiers.
 *
 * Every log line carries whichever of these are in scope: trace_id, request_id,
 * reservation_id, saga_id, idempotency_key. That set is what makes a production
 * incident answerable — given one reservation you can follow it across seven
 * services, the outbox, Kafka, the saga and the payment provider.
 */

const winston = require('winston');
const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();

/** Run `fn` with `ctx` merged into the ambient logging context. */
function withContext(ctx, fn) {
     const parent = context.getStore() || {};
     return context.run({ ...parent, ...ctx }, fn);
}

/** Add fields to the current context in place (e.g. once a reservation id exists). */
function addContext(ctx) {
     const store = context.getStore();
     if (store) Object.assign(store, ctx);
}

const getContext = () => context.getStore() || {};

const contextFormat = winston.format((info) => Object.assign(info, getContext()));

function createLogger(service) {
     return winston.createLogger({
          level: process.env.LOG_LEVEL || 'info',
          defaultMeta: { service },
          format: winston.format.combine(
               contextFormat(),
               winston.format.timestamp(),
               winston.format.errors({ stack: true }),
               process.env.LOG_FORMAT === 'pretty'
                    ? winston.format.combine(
                           winston.format.colorize(),
                           winston.format.printf(({ level, message, timestamp, service: s, ...rest }) => {
                                const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
                                return `${timestamp} ${level} [${s}] ${message}${extra}`;
                           })
                      )
                    : winston.format.json()
          ),
          transports: [new winston.transports.Console()],
     });
}

module.exports = { createLogger, withContext, addContext, getContext };
