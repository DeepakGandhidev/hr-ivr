#!/usr/bin/env bash
#
# Stop the app processes.
#
# Postgres, Supabase and Colima are deliberately left running: they hold your
# data and take minutes to start, so stopping them between runs costs far more
# than it saves. Pass --all to stop those too.
#
set -uo pipefail
cd "$(dirname "$0")/.."

GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok() { echo "  ${GREEN}✓${OFF} $1"; }

for port in 3000 8091; do
  pids=$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null
    ok "stopped whatever was on :$port"
  fi
done

# Next spawns children that outlive the port holder.
pkill -f "next dev" 2>/dev/null && ok "stopped next dev" || true
pkill -f "worker/src/index.js" 2>/dev/null && ok "stopped worker" || true

if [ "${1:-}" = "--all" ]; then
  supabase stop >/dev/null 2>&1 && ok "stopped supabase" || true
  docker compose down >/dev/null 2>&1 && ok "stopped postgres" || true
  colima stop >/dev/null 2>&1 && ok "stopped colima" || true
else
  echo "${DIM}  postgres, supabase and colima left running (use --all to stop them)${OFF}"
fi
