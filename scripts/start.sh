#!/usr/bin/env bash
# Start the whole Tessera application tier in the background.
#
#   bash scripts/start.sh
#
# Infrastructure (PostgreSQL, Redis, Kafka, Elasticsearch) must already be up:
#   npm run up && npm run migrate && npm run seed
#
# Each service is launched fully detached, with its own log in .logs/. On Windows
# the processes are started through PowerShell: a plain `node ... &` from Git
# Bash keeps the parent shell's output pipe open, so the terminal never returns.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

bash "$ROOT/scripts/stop.sh" >/dev/null 2>&1 || true
sleep 1

SERVICES=(
  "inventory:services/inventory-engine/src/index.js"
  "payment:services/payment/src/index.js"
  "pricing:services/pricing/src/index.js"
  "reservation:services/reservation/src/index.js"
  "reconciliation:services/reconciliation/src/index.js"
  "notification:services/notification/src/index.js"
  "discovery:services/discovery/src/index.js"
  "gateway:services/gateway/src/index.js"
)

is_windows() {
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac
}

for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  path="${entry#*:}"
  if [ ! -f "$ROOT/$path" ]; then
    echo "  skip $name (not present)"
    continue
  fi
  if is_windows; then
    # Mixed-style path (C:/...): PowerShell accepts forward slashes, and they
    # cannot be misread as escape characters. An earlier version used
    # backslashes, which escaped the dollar sign in the log name and sent every
    # service's output to a single file literally called '.logs$name.log'.
    winroot="$(cygpath -m "$ROOT")"
    out="$winroot/.logs/$name.log"
    err="$winroot/.logs/$name.err.log"
    powershell.exe -NoProfile -Command "Start-Process -WindowStyle Hidden -WorkingDirectory '$winroot' -FilePath node -ArgumentList '$path' -RedirectStandardOutput '$out' -RedirectStandardError '$err'" > /dev/null
  else
    (cd "$ROOT" && nohup node "$path" > "$LOGS/$name.log" 2> "$LOGS/$name.err.log" < /dev/null &)
  fi
  echo "  started $name"
done

echo
echo "waiting for health (consumers join their Kafka group before listening)..."
for attempt in $(seq 1 20); do
  down=0
  for port in 4000 4001 4002 4003 4004 4005 4006 4007; do
    curl -s -m 2 -o /dev/null "localhost:$port/health" || down=$((down + 1))
  done
  [ "$down" -eq 0 ] && break
  sleep 2
done

for port in 4000 4001 4002 4003 4004 4005 4006 4007; do
  printf "  :%s  " "$port"
  curl -s -m 3 "localhost:$port/health" 2>/dev/null || printf "not responding"
  echo
done
echo
echo "logs:    $LOGS"
echo "console: cd apps/console && npm run dev   ->  http://localhost:5173"
