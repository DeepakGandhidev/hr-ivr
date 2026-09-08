#!/usr/bin/env bash
#
# Bring the whole stack up in dependency order and say what is running.
#
# The order matters and is not obvious: Colima provides the Docker daemon,
# Postgres and Supabase are containers on it, migrations need Postgres, and both
# apps need all of the above. Starting them by hand in the wrong order fails in
# ways that look like unrelated bugs — a login that hangs, a poller that reports
# no mailboxes.
#
#   ./scripts/dev-up.sh          start everything
#   ./scripts/dev-up.sh --status just report what is up
#
set -uo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "  ${GREEN}✓${OFF} $1"; }
bad()  { echo "  ${RED}✗${OFF} $1"; }
step() { echo "${BOLD}$1${OFF}"; }

WEB_PORT=3000
WORKER_PORT=8091

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
http_ok()   { curl -s -o /dev/null -m 3 "$1" >/dev/null 2>&1; }

status() {
  step "Status"
  colima status >/dev/null 2>&1 && ok "colima (docker daemon)" || bad "colima stopped"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -q pratibha-postgres \
    && ok "postgres :5432" || bad "postgres down"
  http_ok "http://127.0.0.1:54321/auth/v1/health" \
    && ok "supabase auth :54321" || bad "supabase down"
  port_busy "$WEB_PORT"   && ok "web :$WEB_PORT"       || bad "web not running"
  port_busy "$WORKER_PORT" && ok "worker :$WORKER_PORT" || bad "worker not running"
}

if [ "${1:-}" = "--status" ]; then status; exit 0; fi

step "1/5  Docker daemon (colima)"
if colima status >/dev/null 2>&1; then
  ok "already running"
else
  echo "  starting — this takes a minute or two on a cold boot…"
  colima start >/dev/null 2>&1 && ok "started" || { bad "colima failed to start"; exit 1; }
fi

# Colima recreates its socket on each start, but an existing docker context is
# left pointing wherever it pointed before — which is how this setup ended up
# aimed at an unmounted external drive.
SOCK="$HOME/.colima/default/docker.sock"
if [ -S "$SOCK" ]; then
  CURRENT=$(docker context inspect colima --format '{{.Endpoints.docker.Host}}' 2>/dev/null || echo "")
  if [ "$CURRENT" != "unix://$SOCK" ]; then
    docker context update colima --docker "host=unix://$SOCK" >/dev/null 2>&1 && ok "docker context repointed"
  fi
fi

step "2/5  Postgres"
docker compose up -d postgres >/dev/null 2>&1
for _ in $(seq 1 30); do
  docker exec pratibha-postgres pg_isready -U pratibha >/dev/null 2>&1 && break
  sleep 1
done
docker exec pratibha-postgres pg_isready -U pratibha >/dev/null 2>&1 \
  && ok "ready on :5432" || { bad "postgres did not come up"; exit 1; }

step "3/5  Supabase (auth)"
if http_ok "http://127.0.0.1:54321/auth/v1/health"; then
  ok "already running"
else
  echo "  starting — first run pulls images and is slow…"
  supabase start >/dev/null 2>&1
  for _ in $(seq 1 60); do
    http_ok "http://127.0.0.1:54321/auth/v1/health" && break
    sleep 2
  done
  http_ok "http://127.0.0.1:54321/auth/v1/health" \
    && ok "auth ready on :54321" \
    || bad "supabase did not come up — login will fail (run: supabase start)"
fi

step "4/5  Database migrations"
if npm run db:migrate:prod --workspace packages/prisma >/dev/null 2>&1 \
   || (cd packages/prisma && npx prisma migrate deploy >/dev/null 2>&1); then
  ok "schema up to date"
else
  bad "migrations failed — run: cd packages/prisma && npx prisma migrate deploy"
fi

step "5/5  Apps"
for entry in "web:$WEB_PORT:apps/web" "worker:$WORKER_PORT:apps/worker"; do
  name="${entry%%:*}"; rest="${entry#*:}"; port="${rest%%:*}"; dir="${rest#*:}"
  if port_busy "$port"; then
    ok "$name already on :$port"
    continue
  fi
  mkdir -p .dev-logs
  (cd "$dir" && npm run "$([ "$name" = web ] && echo dev || echo start)" > "../../.dev-logs/$name.log" 2>&1 &)
  for _ in $(seq 1 40); do port_busy "$port" && break; sleep 1; done
  port_busy "$port" && ok "$name on :$port" || bad "$name failed — see .dev-logs/$name.log"
done

echo
status
echo
echo "${BOLD}Open${OFF}  http://localhost:$WEB_PORT"
echo "${DIM}Logs  tail -f .dev-logs/web.log .dev-logs/worker.log"
echo "Stop  ./scripts/dev-down.sh${OFF}"
