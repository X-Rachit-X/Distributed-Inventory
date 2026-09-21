'use strict';

/**
 * OpenTelemetry tracing.
 *
 * Must be required BEFORE express, pg, ioredis or kafkajs, because
 * auto-instrumentation works by patching those modules as they load. Every
 * service entry point requires it on its second line, right after the env
 * loader.
 *
 * Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set (the `obs` compose
 * profile runs Jaeger on http://localhost:4319). With it unset this file does
 * nothing, so a developer without Jaeger running sees no exporter errors.
 *
 * What a trace shows: browser → gateway → reservation → pricing / inventory
 * (HTTP), each PostgreSQL statement inside those, and the Kafka produce from the
 * outbox relay. Trace context crosses Kafka in message headers, and the outbox
 * row stores the trace id, so the asynchronous half of a booking can be joined
 * back to the request that started it.
 */

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint && !global.__tesseraTracing) {
     global.__tesseraTracing = true;
     try {
          const { NodeSDK } = require('@opentelemetry/sdk-node');
          const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
          const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
          const { Resource } = require('@opentelemetry/resources');

          const serviceName =
               process.env.OTEL_SERVICE_NAME ||
               (process.argv[1]?.match(/services[\\/]([a-z-]+)[\\/]/)?.[1] ?? 'tessera');

          const sdk = new NodeSDK({
               resource: new Resource({ 'service.name': `tessera-${serviceName}` }),
               traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
               instrumentations: [
                    getNodeAutoInstrumentations({
                         // Filesystem spans are noise for this system.
                         '@opentelemetry/instrumentation-fs': { enabled: false },
                         // Health probes would otherwise dominate every trace list.
                         '@opentelemetry/instrumentation-http': {
                              ignoreIncomingRequestHook: (req) =>
                                   ['/health', '/ready', '/metrics'].includes(req.url),
                         },
                    }),
               ],
          });
          sdk.start();
          process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
     } catch (err) {
          // Tracing is diagnostic. A broken exporter must never stop a service.
          // eslint-disable-next-line no-console
          console.warn(`[tracing] disabled: ${err.message}`);
     }
}

module.exports = {};
