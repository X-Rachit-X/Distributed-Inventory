'use strict';

/**
 * Event contract registry: JSON Schema validation plus upcasting.
 *
 * Two rules keep the event bus evolvable:
 *
 *   1. Within a major version, changes must be additive and optional. A v1
 *      consumer that receives a v1 event with extra fields keeps working.
 *   2. A breaking change bumps the major version and ships an *upcaster* that
 *      rewrites v1 into v2. Consumers validate against the version they
 *      understand, so a v2 producer can deploy before v1 consumers migrate.
 *
 * A full Confluent Schema Registry with Avro or Protobuf would give compile-time
 * contracts and a compatibility gate in CI. That is researched and designed in
 * docs/research/schema-evolution.md but deliberately NOT implemented here: it
 * adds a stateful service to the deployment for a benefit this project's scale
 * does not yet need. Validation happens at the producer (before the outbox row
 * is written) and at the consumer (before handling), which catches the same
 * class of bug at the cost of a runtime check.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: false });
addFormats(ajv);

/** @type {Map<string, {schema: object, validate: Function}>} key = `${type}.v${version}` */
const schemas = new Map();
/** @type {Map<string, Function>} key = `${type}.v${from}->v${to}` */
const upcasters = new Map();

const schemaKey = (type, version) => `${type}.v${version}`;

function registerSchema(type, version, schema) {
     const key = schemaKey(type, version);
     schemas.set(key, { schema, validate: ajv.compile(schema) });
}

/** Register a function converting a payload from `fromVersion` to `fromVersion + 1`. */
function registerUpcaster(type, fromVersion, fn) {
     upcasters.set(`${type}.v${fromVersion}->v${fromVersion + 1}`, fn);
}

class EventValidationError extends Error {
     constructor(type, version, errors) {
          super(`Event ${type} v${version} failed schema validation: ${ajv.errorsText(errors)}`);
          this.name = 'EventValidationError';
          this.code = 'EVENT_SCHEMA_INVALID';
          this.errors = errors;
     }
}

/**
 * Validate an envelope's payload against its declared version.
 * Unknown types pass through: a consumer should not hard-fail on an event type
 * it was never meant to handle.
 */
function validate(envelope) {
     const key = schemaKey(envelope.event_type, envelope.event_version);
     const entry = schemas.get(key);
     if (!entry) return { valid: true, unknown: true };
     const valid = entry.validate(envelope.payload);
     if (!valid) throw new EventValidationError(envelope.event_type, envelope.event_version, entry.validate.errors);
     return { valid: true, unknown: false };
}

/**
 * Bring an envelope up to `targetVersion` by applying registered upcasters in
 * sequence. Throws if a step is missing, because silently handing a consumer a
 * payload shaped differently than it expects is worse than refusing.
 */
function upcast(envelope, targetVersion) {
     let current = envelope;
     while (current.event_version < targetVersion) {
          const key = `${current.event_type}.v${current.event_version}->v${current.event_version + 1}`;
          const fn = upcasters.get(key);
          if (!fn) {
               throw new Error(
                    `No upcaster ${key}; cannot read ${current.event_type} v${current.event_version} ` +
                         `as v${targetVersion}`
               );
          }
          current = {
               ...current,
               event_version: current.event_version + 1,
               payload: fn(current.payload, current),
          };
     }
     return current;
}

const listSchemas = () => [...schemas.keys()].sort();

module.exports = {
     registerSchema,
     registerUpcaster,
     validate,
     upcast,
     listSchemas,
     EventValidationError,
};
