#!/usr/bin/env bash
# Start the full Tessera stack in the background, one log per service.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="${TESSERA_LOGS:-$ROOT/.logs}"
mkdir -p "$LOGS"

bash "$ROOT/scripts/stop.sh" >/dev/null 2>&1
sleep 1

start() {
  local name="$1" path="$2"
  ( cd "$ROOT" && node "$path" > "$LOGS/$name.log" 2>&1 & )
  echo "  started $name"
}

# Order matters only for readiness reporting; each service tolerates its
# dependencies arriving late.
start inventory services/inventory-engine/src/index.js
start payment   services/payment/src/index.js
sleep 3
start reservation services/reservation/src/index.js
sleep 2
start gateway   services/gateway/src/index.js
sleep 3

echo
for p in 4000 4001 4002 4003; do
  printf "  :%s " "$p"
  curl -s -m 3 "localhost:$p/health" || echo "DOWN"
  echo
done
echo
echo "logs: $LOGS"
