#!/usr/bin/env bash
#
# Deploy Gmail/Outlook sign-in and email forwarding to the pratibha.tech server.
#
#   ./deploy/email-providers.sh
#   ./deploy/email-providers.sh rollback <timestamp>
#
# Same order as admin-panel.sh: nothing changes until a code backup and a
# database dump exist, and the running apps restart only after the build
# passes. The migration is additive, so rolling the code back needs no schema
# change.
#
# Secrets (Google/Microsoft client ids) are NOT handled here. This only turns
# on the inbound SMTP receiver in the worker's .env; sign-in buttons appear once
# the owner adds GOOGLE_* / MICROSOFT_* to both env files and restarts.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST_SSH=${HOST_SSH:-pratibha-vps}
APP_DIR=${APP_DIR:-/var/agents/pratibha-v2}
INBOUND_DOMAIN=${INBOUND_DOMAIN:-in.pratibha.tech}
TS=$(date +%Y%m%d-%H%M%S)
BACKUPS=/root/deploy-backups

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

restart_apps() {
  ssh "$HOST_SSH" bash -s <<'REMOTE'
set -euo pipefail
pm2 restart pratibha-web
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
  STAMP=${2:?usage: email-providers.sh rollback <timestamp>}
  say "Rolling the code back to the backup taken at $STAMP"
  ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$BACKUPS/email-$STAMP-code.tgz" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; TARBALL=$2
test -f "$TARBALL"
cd "$(dirname "$APP_DIR")"
tar -xzf "$TARBALL"
cd "$APP_DIR"
npm install --no-audit --no-fund >/dev/null
npm run db:generate >/dev/null
(cd packages/shared && npx tsc -p tsconfig.json)
npm run build -w apps/web
REMOTE
  restart_apps
  echo "Rolled back. The inbound SMTP setting in apps/worker/.env is harmless to the old code."
  exit 0
fi

say "1/6  Backups on the server (code, and a database dump)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$BACKUPS" "$TS" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; BACKUPS=$2; TS=$3
mkdir -p "$BACKUPS"
tar --exclude=node_modules --exclude=.next -czf "$BACKUPS/email-$TS-code.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
DBURL=$(grep -E '^DATABASE_URL=' "$APP_DIR/packages/prisma/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
pg_dump --no-owner "$DBURL" | gzip > "$BACKUPS/email-$TS-db.sql.gz"
test -s "$BACKUPS/email-$TS-db.sql.gz"
ls -la "$BACKUPS/email-$TS-"*
REMOTE

say "2/6  Code"
rsync -az --no-owner --no-group \
  --exclude node_modules --exclude .next --exclude .git --exclude '.env*' --exclude '*.tsbuildinfo' \
  --exclude .dev-logs --exclude 'src/generated' --exclude '.DS_Store' --exclude 'supabase/.temp' \
  --exclude 'Pratibha Jobs page redesign*' --exclude 'new*.md' \
  ./ "$HOST_SSH:$APP_DIR/"
# The forwarding webhook was removed; rsync without --delete would leave it.
ssh "$HOST_SSH" "rm -rf '$APP_DIR/apps/web/src/app/webhook/email-forward'"

say "3/6  Install, generate, migrate"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
npm install --no-audit --no-fund
npm run db:generate
(cd packages/shared && npx tsc -p tsconfig.json)
(cd packages/prisma && npx prisma migrate deploy)
REMOTE

say "4/6  Build (the running apps keep serving until this passes)"
ssh "$HOST_SSH" "cd '$APP_DIR' && npm run build -w apps/web"

say "5/6  Turn on the forwarding receiver and restart"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$INBOUND_DOMAIN" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; DOMAIN=$2
if ss -ltn 2>/dev/null | grep -qE ':25\s' && ! ss -ltnp 2>/dev/null | grep -E ':25\s' | grep -q node; then
  echo "Port 25 is held by another mail server; leaving INBOUND_SMTP_PORT unset." >&2
else
  ENVFILE="$APP_DIR/apps/worker/.env"
  grep -q '^INBOUND_SMTP_PORT=' "$ENVFILE" || echo 'INBOUND_SMTP_PORT=25' >> "$ENVFILE"
  grep -q '^INBOUND_EMAIL_DOMAIN=' "$ENVFILE" || echo "INBOUND_EMAIL_DOMAIN=$DOMAIN" >> "$ENVFILE"
  WEBENV="$APP_DIR/apps/web/.env.local"
  grep -q '^INBOUND_EMAIL_DOMAIN=' "$WEBENV" || echo "INBOUND_EMAIL_DOMAIN=$DOMAIN" >> "$WEBENV"
  echo "Inbound SMTP enabled for $DOMAIN"
fi
REMOTE
restart_apps

say "6/6  Smoke tests"
sleep 4
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
echo "portal login           $(code https://pratibha.tech/login)"
echo "public pricing API     $(code https://pratibha.tech/api/public/pricing)"
echo "old forward webhook    $(curl -s -o /dev/null -w '%{http_code}' -X POST https://pratibha.tech/webhook/email-forward/x)  (expect 404)"
ssh "$HOST_SSH" bash -s <<'REMOTE'
echo "port 25 listener       $(ss -ltnp | grep -E ':25\s' | grep -o 'users:.*' || echo none)"
printf 'QUIT\r\n' | timeout 5 nc -q 3 127.0.0.1 25 2>/dev/null | head -1 | sed 's/^/smtp banner            /'
pm2 ls
REMOTE

say "Done. Backup stamp: $TS"
echo "Rollback:   ./deploy/email-providers.sh rollback $TS"
