#!/usr/bin/env bash
# Chaos scenarios against the running stack.
#
#   bash scripts/chaos.sh kafka     # broker outage: bookings continue, outbox holds events, then drains
#   bash scripts/chaos.sh redis     # cache / rate-limit outage: bookings continue in degraded mode
#   bash scripts/chaos.sh payment   # provider charges then times out: UNKNOWN -> resolved, one charge
#
# Each ends with the correctness check. That last line is the point: whatever
# broke, the invariants hold.
set -u
cd "$(dirname "$0")/.."
BASE="${BASE:-http://localhost:4000}"
COMPOSE="docker compose -f deploy/compose/docker-compose.yml --profile core"

py() { python -c "$1"; }

login() {
     curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$1\"}" \
          | py "import json,sys; print(json.load(sys.stdin)['data']['token'])"
}

book() {
     local event seat
     event=$(curl -s "$BASE/api/events" | py "import json,sys; print(json.load(sys.stdin)['data'][0]['eventId'])")
     seat=$(curl -s "$BASE/api/events/$event/resources?spanFrom=0&spanTo=1" \
          | py "import json,sys; print([r for r in json.load(sys.stdin)['data']['resources'] if r['status']=='AVAILABLE'][0]['resourceId'])")
     curl -s -X POST "$BASE/api/reservations" -H 'content-type: application/json' \
          -H "authorization: Bearer $1" -H "idempotency-key: chaos-$(date +%s%N)" \
          -d "{\"eventId\":\"$event\",\"items\":[{\"resourceId\":\"$seat\",\"spanFrom\":0,\"spanTo\":1}]}" \
          | py "import json,sys; print(json.load(sys.stdin)['data']['reservationId'])"
}

status() {
     curl -s "$BASE/api/reservations/$2" -H "authorization: Bearer $1" \
          | py "import json,sys; d=json.load(sys.stdin)['data']; print(d['state'], '-', d['progress'], d.get('bookingReference') or '')"
}

pending_outbox() {
     local total=0 n
     for db in inventory reservation payment; do
          n=$(docker exec tessera-postgres psql -U tessera -d "$db" -tAc "SELECT count(*) FROM outbox_events WHERE status='PENDING'")
          total=$((total + n))
     done
     echo "$total"
}

verdict() {
     curl -s "$BASE/api/ops/invariants" \
          | py "import json,sys; d=json.load(sys.stdin); print('CORRECTNESS:', 'all invariants hold' if d['correct'] else 'VIOLATED ' + str(d['violations']))"
}

case "${1:-}" in
     kafka)
          tok=$(login chaos-kafka@test.dev)
          echo "stopping Kafka"
          $COMPOSE stop kafka > /dev/null
          id=$(book "$tok")
          sleep 3
          echo "booking with Kafka down: $(status "$tok" "$id")"
          echo "outbox events waiting:   $(pending_outbox)"
          echo "starting Kafka"
          $COMPOSE start kafka > /dev/null
          sleep 25
          echo "outbox events waiting after recovery: $(pending_outbox)"
          ;;
     redis)
          tok=$(login chaos-redis@test.dev)
          echo "stopping Redis"
          $COMPOSE stop redis > /dev/null
          id=$(book "$tok")
          sleep 3
          echo "booking with Redis down: $(status "$tok" "$id")"
          curl -s -o /dev/null -D - "$BASE/api/events" | grep -i "x-ratelimit-mode" || echo "(rate limiter running on the local fallback)"
          echo "starting Redis"
          $COMPOSE start redis > /dev/null
          ;;
     payment)
          ops=$(login ops@tessera.dev)
          tok=$(login chaos-pay@test.dev)
          curl -s -X POST "$BASE/api/ops/provider-mode" -H 'content-type: application/json' \
               -H "authorization: Bearer $ops" -d '{"mode":"timeout_after_success"}' > /dev/null
          echo "provider now charges the customer and then times out"
          id=$(book "$tok")
          for i in 1 2 3 4 5 6 7 8; do
               sleep 1
               echo "  $(status "$tok" "$id")"
          done
          curl -s -X POST "$BASE/api/ops/provider-mode" -H 'content-type: application/json' \
               -H "authorization: Bearer $ops" -d '{"mode":"ok"}' > /dev/null
          docker exec tessera-postgres psql -U tessera -d payment -tAc \
               "SELECT 'charges for this reservation: ' || count(*) FROM payments WHERE reservation_id = '$id'"
          ;;
     *)
          echo "usage: bash scripts/chaos.sh kafka|redis|payment"
          exit 1
          ;;
esac
verdict
