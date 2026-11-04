#!/usr/bin/env bash
#
# Deploy the fully configurable admin panel (Platform settings for every knob,
# API keys, AI prompt versions) with the portal and worker changes that read
# those settings.
#
#   ./deploy/admin-config.sh
#   ./deploy/admin-config.sh rollback <timestamp>
#
# Same order as the other deploy scripts: nothing changes until a code backup
# and a database dump exist, and the running apps restart only after every
# build passes. The one migration is additive (app_runtime_reports, where the
# portal and worker report the values they run with), so rolling the code back
# needs no schema change.
#
# On deploy day nothing behaves differently: until a value is saved in the
# panel, every app keeps using its .env and built-in defaults.
#
# The admin panel encrypts API keys with the same EMAIL_SECRET_KEY the portal
# and worker use to read them. Step 4 copies it into the admin's env on the
# server; the key never crosses this connection.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST_SSH=${HOST_SSH:-pratibha-vps}
APP_DIR=${APP_DIR:-/var/agents/pratibha-v2}
TS=$(date +%Y%m%d-%H%M%S)
BACKUPS=/root/deploy-backups

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

build_all() {
  ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
npm install --no-audit --no-fund
npm run db:generate
(cd packages/shared && npx tsc -p tsconfig.json)
(cd packages/prisma && npx prisma migrate deploy)
npm run build -w apps/web
npm run build -w apps/admin
REMOTE
}

restart_apps() {
  ssh "$HOST_SSH" bash -s <<'REMOTE'
set -euo pipefail
pm2 restart pratibha-web
pm2 restart pratibha-admin
# A worker restart ends any call in progress, so wait (up to five minutes)
# for the line to be quiet first.
for _ in $(seq 1 60); do
  active=$(curl -s -m 3 http://127.0.0.1:8091/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).activeCalls??0)}catch{console.log(0)}})')
  [ "${active:-0}" = "0" ] && break
  echo "Waiting for $active live call(s) to finish before restarting the worker…"
  sleep 5
done
pm2 restart pratibha-v2
pm2 save
REMOTE
}

if [ "${1:-}" = "rollback" ]; then
  STAMP=${2:?usage: admin-config.sh rollback <timestamp>}
  say "Rolling the code back to the backup taken at $STAMP"
  ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$BACKUPS/admin-config-$STAMP-code.tgz" <<'REMOTE'
set -euo pipefail
test -f "$2"
cd "$(dirname "$1")"
tar -xzf "$2"
REMOTE
  build_all
  restart_apps
  echo "Rolled back. Settings saved in the panel stay in the database and are ignored by the old code."
  exit 0
fi

say "1/6  Backups on the server (code, and a database dump)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$BACKUPS" "$TS" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; BACKUPS=$2; TS=$3
mkdir -p "$BACKUPS"
tar --exclude=node_modules --exclude=.next -czf "$BACKUPS/admin-config-$TS-code.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
DBURL=$(grep -E '^DATABASE_URL=' "$APP_DIR/packages/prisma/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
pg_dump --no-owner "$DBURL" | gzip > "$BACKUPS/admin-config-$TS-db.sql.gz"
test -s "$BACKUPS/admin-config-$TS-db.sql.gz"
ls -la "$BACKUPS/admin-config-$TS-"*
REMOTE

say "2/6  Code"
rsync -az --no-owner --no-group \
  --exclude node_modules --exclude .next --exclude .git --exclude '.env*' --exclude '*.tsbuildinfo' \
  --exclude .dev-logs --exclude 'src/generated' --exclude '.DS_Store' --exclude 'supabase/.temp' \
  --exclude 'Pratibha Jobs page redesign*' --exclude 'new*.md' \
  ./ "$HOST_SSH:$APP_DIR/"

# rsync without --delete (so server-only files survive) leaves behind source
# files the repo has deleted, and Next.js still compiles them. Remove the
# ones this release deleted; a stale route importing removed code fails the
# whole build.
ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
for stale in \
  apps/admin/src/app/api/settings/test-email \
  apps/web/src/app/webhook/email-forward \
  apps/admin/.next/types/app/api/settings/test-email; do
  if [ -e "$stale" ]; then rm -rf "$stale" && echo "Removed stale $stale"; fi
done
REMOTE

say "3/6  Install, generate, build (the running apps keep serving until this passes)"
build_all

say "4/6  Admin panel can encrypt API keys (EMAIL_SECRET_KEY, copied on the server)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
ADMIN_ENV=apps/admin/.env.local
if grep -q '^EMAIL_SECRET_KEY=' "$ADMIN_ENV" 2>/dev/null; then
  echo "Admin already has EMAIL_SECRET_KEY"
else
  KEY=$(grep -hE '^EMAIL_SECRET_KEY=' apps/web/.env.local apps/worker/.env 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$KEY" ]; then
    umask 077
    printf 'EMAIL_SECRET_KEY=%s\n' "$KEY" >> "$ADMIN_ENV"
    echo "Copied EMAIL_SECRET_KEY into the admin env"
  else
    echo "No EMAIL_SECRET_KEY found in the portal or worker env; API keys cannot be saved in the panel until one is set in all three." >&2
  fi
fi
REMOTE

say "5/6  Restart"
restart_apps

say "6/6  Smoke tests"
sleep 6
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
echo "portal login           $(code https://pratibha.tech/login)"
echo "public pricing API     $(code https://pratibha.tech/api/public/pricing)"
echo "admin sign-in          $(code https://pratibha-admin.200-234-44-81.sslip.io/sign-in)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
cd "$1"
DBURL=$(grep -E '^DATABASE_URL=' packages/prisma/.env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
echo "apps reporting         $(psql "$DBURL" -Atc "select string_agg(app || ' @ ' || to_char(reported_at, 'HH24:MI:SS'), ', ') from app_runtime_reports")"
pm2 ls
REMOTE

say "Done. Backup stamp: $TS"
echo "Rollback:   ./deploy/admin-config.sh rollback $TS"
