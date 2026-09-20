#!/usr/bin/env bash
# =============================================================================
# Explicit topic creation.
#
# Partition counts are a design decision, not a default:
#
#   - A topic's partition count is the hard ceiling on consumer parallelism.
#     One partition means one consumer, forever, no matter how many replicas run.
#   - Ordering is guaranteed only WITHIN a partition. Each topic below is keyed
#     by the aggregate whose ordering actually matters, so that everything about
#     one reservation (or one event's inventory) lands on one partition and
#     arrives in order.
#
#   reservation.events  key = reservation_id   saga steps must not reorder
#   inventory.events    key = event_id         one journey's availability updates
#                                              must apply in order; keying by
#                                              resource would scatter them and
#                                              make the read model inconsistent
#   payment.events      key = reservation_id   payment and reservation steps
#                                              interleave in one saga
#   booking.events      key = reservation_id   user-visible lifecycle
#   notification.events key = customer_id      per-customer ordering
#   reconciliation.events key = issue_id       independent, order-free
#
# DLQ topics mirror their source's partitioning so replayed messages keep the
# same locality.
# =============================================================================
set -euo pipefail

BROKER="${BOOTSTRAP:-kafka:29092}"
PARTITIONS_DEFAULT=6
REPLICATION=1   # single-broker laptop cluster; 3 in any real deployment

create() {
  local topic="$1" partitions="${2:-$PARTITIONS_DEFAULT}" retention="${3:-604800000}"
  if kafka-topics --bootstrap-server "$BROKER" --describe --topic "$topic" >/dev/null 2>&1; then
    echo "  = $topic (exists)"
    return 0
  fi
  kafka-topics --bootstrap-server "$BROKER" --create \
    --topic "$topic" \
    --partitions "$partitions" \
    --replication-factor "$REPLICATION" \
    --config retention.ms="$retention" \
    --config min.insync.replicas=1 >/dev/null
  echo "  + $topic (${partitions}p)"
}

echo "Creating Tessera topics on $BROKER"

# Domain events
create reservation.events     6
create inventory.events       6
create payment.events         6
create booking.events         6
create notification.events    3
create reconciliation.events  3
create catalog.events         3

# Dead-letter queues. Retained far longer than source topics: a poison message
# is only useful if it is still there when someone gets round to fixing it.
create reservation.events.dlq   3 2592000000
create inventory.events.dlq     3 2592000000
create payment.events.dlq       3 2592000000
create booking.events.dlq       3 2592000000
create notification.events.dlq  3 2592000000
create catalog.events.dlq       3 2592000000

echo "Topics ready:"
kafka-topics --bootstrap-server "$BROKER" --list | sed 's/^/  /'
