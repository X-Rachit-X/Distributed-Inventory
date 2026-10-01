'use strict';

/**
 * Connection security for Kafka, from the environment.
 *
 * The local and single-server stacks run Kafka on a private network with no
 * authentication, so by default this returns nothing and the client connects
 * in plain text. Managed Kafka (Confluent Cloud, Amazon MSK, Redpanda Cloud,
 * Aiven...) requires TLS and a SASL login; these variables switch that on
 * without a code change:
 *
 *   KAFKA_SSL=true
 *   KAFKA_SASL_MECHANISM=plain | scram-sha-256 | scram-sha-512
 *   KAFKA_SASL_USERNAME=...
 *   KAFKA_SASL_PASSWORD=...
 *
 * Both Kafka clients (the outbox relay's producer and the consumer runner)
 * spread this into their KafkaJS options, so they cannot disagree.
 */

const { str, flag } = require('./index');

const MECHANISMS = new Set(['plain', 'scram-sha-256', 'scram-sha-512']);

function kafkaSecurityOptions() {
     const options = {};
     if (flag('KAFKA_SSL')) options.ssl = true;

     const mechanism = str('KAFKA_SASL_MECHANISM').toLowerCase();
     if (mechanism) {
          if (!MECHANISMS.has(mechanism)) {
               throw new Error(`KAFKA_SASL_MECHANISM must be one of ${[...MECHANISMS].join(', ')}, got "${mechanism}"`);
          }
          const username = str('KAFKA_SASL_USERNAME');
          const password = str('KAFKA_SASL_PASSWORD');
          if (!username || !password) {
               throw new Error('KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required with KAFKA_SASL_MECHANISM');
          }
          options.sasl = { mechanism, username, password };
     }
     return options;
}

module.exports = { kafkaSecurityOptions };
