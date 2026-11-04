#!/usr/bin/env bash
#
# Ship admin panel code changes (no website rebuild).
#
#   BASE=<commit the server runs> ./deploy/admin-update.sh
#
# Backs up the code, copies the files changed since BASE, applies any pending
# migrations, rebuilds the admin panel and restarts only pratibha-admin. The
# portal, worker, call line and pratibha.tech are untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST_SSH=${HOST_SSH:-pratibha-vps}
APP_DIR=/var/agents/pratibha-v2
BASE=${BASE:?set BASE to the commit the server is running}
TS=$(date +%Y%m%d-%H%M%S)

LIST=$(mktemp)
git diff --name-only --diff-filter=ACMR "$BASE" HEAD > "$LIST"
echo "Files:"; sed 's/^/  /' "$LIST"

ssh "$HOST_SSH" "mkdir -p /root/deploy-backups && tar --exclude=node_modules --exclude=.next -czf /root/deploy-backups/admin-update-$TS-code.tgz -C /var/agents pratibha-v2 && echo 'Backup: /root/deploy-backups/admin-update-$TS-code.tgz'"
rsync -az --no-owner --no-group --files-from="$LIST" ./ "$HOST_SSH:$APP_DIR/"
rm -f "$LIST"

ssh "$HOST_SSH" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
chmod +x deploy/*.sh
mkdir -p /var/agents/pratibha-uploads
npm run db:generate >/dev/null
(cd packages/prisma && npx prisma migrate deploy | tail -1)
# The admin panel imports packages/shared from its built dist/.
npm run build -w packages/shared >/dev/null
npm run build -w apps/admin 2>&1 | grep -E 'Compiled|rror' || true
test -f apps/admin/.next/BUILD_ID || { echo "Admin build failed; the running panel was not restarted."; exit 1; }
pm2 restart pratibha-admin --update-env >/dev/null && pm2 save >/dev/null
sleep 3
echo "admin sign-in page: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/sign-in)"
REMOTE
