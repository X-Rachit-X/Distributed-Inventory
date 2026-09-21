-- ============================================================================
-- Notification service.
--
-- The simplest consumer in the system, and deliberately so: it exists to show
-- the consumer-side guarantees in isolation.
--
-- A notification is written in the SAME transaction as the processed_events
-- marker for the event that caused it. A redelivered event therefore finds the
-- marker and stops, and the customer receives one email, not two — which is
-- the difference between at-least-once delivery and an at-least-once
-- *experience*.
--
-- The unique (event_id, template) constraint is a second, independent line of
-- defence: even if the dedupe marker were somehow bypassed, the database would
-- refuse a duplicate notification for the same event.
-- ============================================================================

CREATE TABLE notifications (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     customer_id    text        NOT NULL,
     channel        text        NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL','SMS','PUSH')),
     template       text        NOT NULL,
     subject        text        NOT NULL,
     body           text        NOT NULL,
     reservation_id uuid,
     source_event_id uuid       NOT NULL,
     status         text        NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','FAILED','SUPPRESSED')),
     created_at     timestamptz NOT NULL DEFAULT now(),
     UNIQUE (source_event_id, template)
);

CREATE INDEX notifications_customer_idx ON notifications (customer_id, created_at DESC);
