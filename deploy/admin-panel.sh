#!/usr/bin/env bash
#
# Deploy the admin panel to the pratibha.tech server, with the portal and
# worker changes it depends on.
#
#   ./deploy/admin-panel.sh
#
# Settings (environment, all optional):
#   HOST_SSH     ssh alias of the server            (pratibha-vps)
#   APP_DIR      app directory on the server        (/var/agents/pratibha-v2)
#   ADMIN_HOST   hostname the panel answers on      (pratibha-admin.200-234-44-81.sslip.io)
#   OWNER_EMAIL  first Owner's email                (deepak@promonkey.tech)
#   OWNER_NAME   first Owner's name                 (Deepak)
#   PANEL_ON     ADMIN_PANEL_ENABLED value          (true)
#
# The order is the safe one: nothing changes on the server until a code
# backup and a database dump both exist, and the running apps are restarted
# only after every build has succeeded. Secrets are read and written on the
# server; none of them crosses this connection except the new Owner's
# password, which is generated here and printed once at the end.
#
# Rollback (code): ./deploy/admin-panel.sh rollback <timestamp>
# The schema change is additive, so the previous code runs against it as is;
# the database dump is for disaster recovery, not for this rollback.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST_SSH=${HOST_SSH:-pratibha-vps}
APP_DIR=${APP_DIR:-/var/agents/pratibha-v2}
ADMIN_HOST=${ADMIN_HOST:-pratibha-admin.200-234-44-81.sslip.io}
OWNER_EMAIL=${OWNER_EMAIL:-deepak@promonkey.tech}
OWNER_NAME=${OWNER_NAME:-Deepak}
PANEL_ON=${PANEL_ON:-true}
TS=$(date +%Y%m%d-%H%M%S)
BACKUPS=/root/deploy-backups

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "${1:-}" = "rollback" ]; then
  STAMP=${2:?usage: admin-panel.sh rollback <timestamp>}
  say "Rolling the code back to the backup taken at $STAMP"
  ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$BACKUPS/admin-panel-$STAMP-code.tgz" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; TARBALL=$2
test -f "$TARBALL"
cd "$(dirname "$APP_DIR")"
tar -xzf "$TARBALL"
cd "$APP_DIR"
npm install --no-audit --no-fund >/dev/null
npm run db:generate >/dev/null
npm run build -w apps/web
pm2 restart pratibha-web pratibha-v2
pm2 delete pratibha-admin 2>/dev/null || true
pm2 save
echo "Rolled back. The admin panel is stopped; its nginx site can stay, it now answers 502."
REMOTE
  exit 0
fi

say "1/8  Backups on the server (code, and a database dump)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$BACKUPS" "$TS" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; BACKUPS=$2; TS=$3
mkdir -p "$BACKUPS"
tar --exclude=node_modules --exclude=.next -czf "$BACKUPS/admin-panel-$TS-code.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
DBURL=$(grep -E '^DATABASE_URL=' "$APP_DIR/packages/prisma/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
pg_dump --no-owner "$DBURL" | gzip > "$BACKUPS/admin-panel-$TS-db.sql.gz"
test -s "$BACKUPS/admin-panel-$TS-db.sql.gz"
ls -la "$BACKUPS/admin-panel-$TS-"*
REMOTE

say "2/8  Code"
rsync -az --no-owner --no-group \
  --exclude node_modules --exclude .next --exclude .git --exclude '.env*' --exclude '*.tsbuildinfo' \
  --exclude .dev-logs --exclude 'src/generated' --exclude '.DS_Store' --exclude 'supabase/.temp' \
  --exclude 'Pratibha Jobs page redesign*' --exclude 'new*.md' \
  ./ "$HOST_SSH:$APP_DIR/"

say "3/8  Install, generate, migrate"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
npm install --no-audit --no-fund
npm run db:generate
(cd packages/shared && npx tsc -p tsconfig.json)
(cd packages/prisma && npx prisma migrate deploy)
REMOTE

say "4/8  Admin database role and environment (written on the server only)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$ADMIN_HOST" "$PANEL_ON" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; ADMIN_HOST=$2; PANEL_ON=$3
cd "$APP_DIR"
val() { local key=$1; shift; grep -hE "^${key}=" "$@" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
DBURL=$(val DATABASE_URL packages/prisma/.env)
ENVFILE=apps/admin/.env.local

if [ ! -f "$ENVFILE" ]; then
  PW=$(openssl rand -hex 24)
  psql "$DBURL" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pratibha_admin') THEN
    CREATE ROLE pratibha_admin NOSUPERUSER BYPASSRLS;
  END IF;
END \$\$;
ALTER ROLE pratibha_admin LOGIN PASSWORD '$PW';
GRANT USAGE ON SCHEMA public TO pratibha_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pratibha_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pratibha_admin;
REVOKE UPDATE, DELETE, TRUNCATE ON activity_log FROM pratibha_admin;
SQL
  ADMIN_DB_URL=$(node -e 'const u=new URL(process.argv[1]); u.username="pratibha_admin"; u.password=process.argv[2]; console.log(u.toString())' "$DBURL" "$PW")

  WEBENV="apps/web/.env.local apps/web/.env .env"
  SUPA_URL=$(val NEXT_PUBLIC_SUPABASE_URL $WEBENV)
  SUPA_KEY=$(val SUPABASE_SERVICE_ROLE_KEY $WEBENV apps/worker/.env)
  umask 077
  {
    echo "# Written by deploy/admin-panel.sh. The admin panel's own secrets; never the portal's."
    echo "ADMIN_PANEL_ENABLED=$PANEL_ON"
    echo "ADMIN_APP_DATABASE_URL=$ADMIN_DB_URL"
    echo "DATABASE_URL=$ADMIN_DB_URL"
    echo "ADMIN_SECRET_KEY=$(openssl rand -hex 32)"
    echo "ADMIN_BASE_URL=https://$ADMIN_HOST"
    echo "PORTAL_BASE_URL=https://pratibha.tech"
    echo "SUPABASE_URL=$SUPA_URL"
    echo "SUPABASE_SERVICE_ROLE_KEY=$SUPA_KEY"
    for k in RESEND_API_KEY RESEND_FROM_DOMAIN INVOICE_SELLER_NAME INVOICE_SELLER_GSTIN INVOICE_SELLER_ADDRESS INVOICE_SELLER_STATE INVOICE_NUMBER_PREFIX; do
      v=$(val "$k" $WEBENV); [ -n "$v" ] && echo "$k=$v"
    done
  } > "$ENVFILE"
  echo "Wrote $ENVFILE (service role key: $([ -n "$SUPA_KEY" ] && echo found || echo MISSING, Sign in as and member resets will say so))"
else
  sed -i "s/^ADMIN_PANEL_ENABLED=.*/ADMIN_PANEL_ENABLED=$PANEL_ON/" "$ENVFILE"
  echo "Kept the existing $ENVFILE"
fi
REMOTE

say "5/8  Builds (the running apps keep serving until these all pass)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
npm run build -w apps/web
npm run build -w apps/admin
REMOTE

say "6/8  Restart the portal and worker; start the admin panel"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
if ss -ltnp 2>/dev/null | grep -q ':3100 ' && ! pm2 describe pratibha-admin >/dev/null 2>&1; then
  echo "Port 3100 is taken by something else; stopping before anything restarts." >&2
  exit 1
fi
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
if pm2 describe pratibha-admin >/dev/null 2>&1; then
  pm2 restart pratibha-admin
else
  pm2 start npm --name pratibha-admin --cwd "$1/apps/admin" -- run start
fi
pm2 save
REMOTE

say "7/8  nginx and an HTTPS certificate for $ADMIN_HOST"
ssh "$HOST_SSH" bash -s -- "$ADMIN_HOST" "$OWNER_EMAIL" <<'REMOTE'
set -euo pipefail
ADMIN_HOST=$1; EMAIL=$2
SITE=/etc/nginx/sites-available/pratibha-admin
if [ ! -f "$SITE" ]; then
  cat > "$SITE" <<NGINX
# Pratibha admin panel: its own hostname, so its cookies never meet the portal's.
server {
    listen 80;
    server_name $ADMIN_HOST;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
NGINX
  ln -sf "$SITE" /etc/nginx/sites-enabled/pratibha-admin
  nginx -t
  systemctl reload nginx
fi
command -v certbot >/dev/null || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx; }
certbot --nginx -d "$ADMIN_HOST" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
nginx -t
systemctl reload nginx
REMOTE

say "8/8  First Owner, and smoke tests"
OWNER_PW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)
if printf '%s' "$OWNER_PW" | ssh "$HOST_SSH" "cd $APP_DIR/apps/admin && set -a && . ./.env.local && set +a && node scripts/create-owner.mjs --name '$OWNER_NAME' --email '$OWNER_EMAIL' --password-stdin"; then
  CREATED=1
else
  CREATED=0
  echo "An Owner already exists; no new password was set. (Run create-owner with --recovery on the server if needed.)"
fi

sleep 3
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
echo "admin sign-in        $(code "https://$ADMIN_HOST/sign-in")"
echo "portal login         $(code https://pratibha.tech/login)"
echo "public pricing API   $(code https://pratibha.tech/api/public/pricing)"
ssh "$HOST_SSH" "pm2 ls"

say "Done. Backup stamp: $TS"
echo "Admin URL:  https://$ADMIN_HOST"
if [ "$CREATED" = 1 ]; then
  echo "Email:      $OWNER_EMAIL"
  echo "Password:   $OWNER_PW"
  echo "Sign in, then turn on two step verification from the banner."
fi
echo "Rollback:   ./deploy/admin-panel.sh rollback $TS"
