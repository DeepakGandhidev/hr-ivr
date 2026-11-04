#!/usr/bin/env bash
#
# Deploy the admin panel's Website section, and move pratibha.tech to being
# built on the server from the content it publishes.
#
#   ./deploy/website-admin.sh <path to the pratibha website repo>
#
# Order: back up code, database and the live site; copy only the files this
# change touches; migrate (additive); build and restart the admin panel only
# (the portal, worker and call line keep running); put the site source on the
# server; import today's content; rebuild the site from it, which should come
# out the same as what is live now.
#
# Rollback: restore /root/deploy-backups/website-admin-<ts>-code.tgz, rebuild
# and restart pratibha-admin; copy /root/site-backups/pratibha-site.<ts> back
# into /var/agents/pratibha-site. The new tables can stay; nothing else reads them.
set -euo pipefail
cd "$(dirname "$0")/.."

SITE_REPO=${1:?usage: website-admin.sh <path to the pratibha website repo>}
HOST_SSH=${HOST_SSH:-pratibha-vps}
APP_DIR=/var/agents/pratibha-v2
SITE_SRC=/var/agents/pratibha-site-src
BASE=${BASE:-96f3218}   # the commit the server is running
TS=$(date +%Y%m%d-%H%M%S)
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/6  Backups (code, database, live site)"
ssh "$HOST_SSH" bash -s -- "$TS" "$APP_DIR" <<'REMOTE'
set -euo pipefail
TS=$1; APP_DIR=$2; B=/root/deploy-backups; mkdir -p "$B" /root/site-backups
tar --exclude=node_modules --exclude=.next -czf "$B/website-admin-$TS-code.tgz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
DBURL=$(grep -E '^DATABASE_URL=' "$APP_DIR/packages/prisma/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
pg_dump --no-owner "$DBURL" | gzip > "$B/website-admin-$TS-db.sql.gz"
cp -a /var/agents/pratibha-site "/root/site-backups/pratibha-site.$TS"
echo "Backups: $B/website-admin-$TS-*, /root/site-backups/pratibha-site.$TS"
REMOTE

say "2/6  Copy the changed files"
LIST=$(mktemp)
git diff --name-only "$BASE" HEAD > "$LIST"
cat "$LIST"
rsync -az --no-owner --no-group --files-from="$LIST" ./ "$HOST_SSH:$APP_DIR/"
rm -f "$LIST"

say "3/6  Generate, migrate, configure, build and restart the admin panel"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$SITE_SRC" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; SITE_SRC=$2
cd "$APP_DIR"
chmod +x deploy/website-publish.sh
npm run db:generate >/dev/null
(cd packages/prisma && npx prisma migrate deploy)
ENVF=apps/admin/.env.local
if ! grep -q '^SITE_PUBLISH_SCRIPT=' "$ENVF"; then
  printf '\n# Website publishing (admin panel -> pratibha.tech)\nSITE_PUBLISH_SCRIPT=%s/deploy/website-publish.sh\nSITE_CONTENT_DIR=%s/.content\nSITE_SRC=%s\nSITE_TARGET=/var/agents/pratibha-site\n' \
    "$APP_DIR" "$SITE_SRC" "$SITE_SRC" >> "$ENVF"
fi
npm run build -w apps/admin
pm2 restart pratibha-admin --update-env
pm2 save >/dev/null
REMOTE

say "4/6  Put the website source on the server"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude .next --exclude out \
  --exclude .published --exclude .content --exclude '*.tsbuildinfo' \
  "$SITE_REPO"/ "$HOST_SSH:$SITE_SRC/"

say "5/6  Import today's content into the admin panel (existing rows are kept)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$SITE_SRC" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; SITE_SRC=$2
cd "$APP_DIR/apps/admin"
ADMIN_DB=$(grep -E '^ADMIN_APP_DATABASE_URL=' .env.local | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
ADMIN_APP_DATABASE_URL="$ADMIN_DB" node scripts/import-website-content.mjs "$SITE_SRC/src/content/defaults.json"
REMOTE

say "6/6  Build pratibha.tech on the server (last published content; the defaults only before the first publish)"
ssh "$HOST_SSH" bash -s -- "$APP_DIR" "$SITE_SRC" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; SITE_SRC=$2
latest=$(ls -1t "$SITE_SRC"/.published/*.json 2>/dev/null | head -1 || true)
content=${latest:-$SITE_SRC/src/content/defaults.json}
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root NODE_ENV=production bash "$APP_DIR/deploy/website-publish.sh" "$content"
REMOTE

say "Checks"
for p in / /about /pricing /blog /privacy /robots.txt /sitemap.xml; do
  printf '%-14s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://pratibha.tech$p")"
done
printf '%-14s %s\n' "/login" "$(curl -s -o /dev/null -w '%{http_code}' https://pratibha.tech/login)"
printf '%-14s %s\n' "/health" "$(curl -s -o /dev/null -w '%{http_code}' https://pratibha.tech/health)"
echo "Done. Open the admin panel → Website."
