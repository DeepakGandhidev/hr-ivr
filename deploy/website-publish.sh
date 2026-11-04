#!/usr/bin/env bash
#
# Build pratibha.tech from a content file and put it live.
#
#   deploy/website-publish.sh /path/to/content.json
#
# Run by the admin panel's Publish button (SITE_PUBLISH_SCRIPT points here).
# The site's source lives in SITE_SRC (a copy of sparsh160/pratibha); the build
# reads the content through SITE_CONTENT_FILE and the static output is swapped
# into SITE_TARGET, the folder nginx serves. The swap is rsync's delayed one:
# visitors see the old site until every new file is in place, and a failed
# build changes nothing.
set -euo pipefail

CONTENT=${1:?usage: website-publish.sh <content.json>}
SRC=${SITE_SRC:-/var/agents/pratibha-site-src}
TARGET=${SITE_TARGET:-/var/agents/pratibha-site}
OWNER=${SITE_OWNER:-deploy:deploy}
# Images uploaded in the admin panel; served from the site as /uploads/<name>.
UPLOADS=${SITE_UPLOADS_DIR:-/var/agents/pratibha-uploads}

test -f "$CONTENT" || { echo "Content file not found: $CONTENT"; exit 1; }
test -d "$SRC" || { echo "Site source not found at $SRC"; exit 1; }
CONTENT=$(cd "$(dirname "$CONTENT")" && pwd)/$(basename "$CONTENT")

# One build at a time, even if two publishes slip past the panel's own check.
if command -v flock >/dev/null; then
  exec 9>/tmp/pratibha-website-build.lock
  flock -w 600 9 || { echo "Another website build is still running."; exit 1; }
fi

cd "$SRC"
echo "Building pratibha.tech from $(basename "$CONTENT")"

# Reinstall only when the lockfile changed since the last install. The build
# needs devDependencies (Tailwind, TypeScript): --include=dev, because this runs
# with NODE_ENV=production, which would otherwise leave them out.
STAMP=node_modules/.publish-stamp-dev
if [ ! -f "$STAMP" ] || [ package-lock.json -nt "$STAMP" ]; then
  echo "Installing dependencies"
  npm ci --include=dev --no-audit --no-fund
  touch "$STAMP"
fi

# The build downloads Google Fonts and that fetch fails now and then: try 3 times.
built=0
for attempt in 1 2 3; do
  rm -rf .next out
  if SITE_CONTENT_FILE="$CONTENT" NEXT_TELEMETRY_DISABLED=1 npm run build > /tmp/pratibha-website-build.log 2>&1; then
    built=1; break
  fi
  echo "Build attempt $attempt failed:"; tail -25 /tmp/pratibha-website-build.log
  sleep 5
done
[ "$built" = 1 ] || { echo "The build failed 3 times; the site was not changed."; exit 1; }
tail -15 /tmp/pratibha-website-build.log

for f in out/index.html out/sitemap.xml out/robots.txt; do
  test -s "$f" || { echo "Build output is missing $f; the site was not changed."; exit 1; }
done

if [ -d "$UPLOADS" ]; then
  mkdir -p out/uploads
  cp -p "$UPLOADS"/* out/uploads/ 2>/dev/null || true
  echo "Included $(ls -1 out/uploads | wc -l | tr -d ' ') uploaded images"
fi

echo "Swapping the new build in"
# Files stay owned by the deploy user, as the CI upload leaves them (root only).
CHOWN=()
[ "$(id -u)" = 0 ] && CHOWN=(--chown="$OWNER")
mkdir -p "$TARGET"
rsync -rlpc --delete-delay --delay-updates --chmod=D755,F644 ${CHOWN[@]+"${CHOWN[@]}"} out/ "$TARGET/"

# Keep the content each live build came from, newest 30.
mkdir -p "$SRC/.published"
cp "$CONTENT" "$SRC/.published/"
ls -1t "$SRC"/.published/*.json 2>/dev/null | tail -n +31 | xargs -r rm -f

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://pratibha.tech/ || true)
echo "Live. Homepage answers $code."
