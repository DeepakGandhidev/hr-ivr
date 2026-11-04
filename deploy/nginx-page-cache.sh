#!/usr/bin/env bash
#
# Make browsers re-check pratibha.tech's pages on every visit.
#
#   ./deploy/nginx-page-cache.sh
#
# Clean URLs (/, /blog, /pricing) were served with no Cache-Control, so a
# browser could keep showing a page for a while after a Publish in the admin
# panel. This adds "no-cache, must-revalidate" to the static site's two
# locations: browsers still cache, but ask first (a cheap 304 when nothing
# changed). add_header inside a location replaces the server-level headers, so
# the three security headers are repeated there. The dashboard (@app), assets
# and the voice agent are untouched. Backs up the file and reloads only if
# `nginx -t` passes; otherwise restores the backup.
set -euo pipefail
HOST_SSH=${HOST_SSH:-pratibha-vps}

ssh "$HOST_SSH" bash -s <<'REMOTE'
set -euo pipefail
F=/etc/nginx/sites-available/pratibha.tech
B=/root/nginx-backups/pratibha.tech.$(date +%Y%m%d-%H%M%S)
mkdir -p /root/nginx-backups
cp -a "$F" "$B"
echo "Backup: $B"

if grep -q 'Pages change on every Publish' "$F"; then
  echo "Already applied."
  exit 0
fi

python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
hdr = '''        # Pages change on every Publish from the admin panel: browsers must
        # re-check them each visit (a 304 when nothing changed). add_header here
        # replaces the server-level ones, so those are repeated.
        add_header Cache-Control "no-cache, must-revalidate";
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
'''
for old in (
    "    location / {\n        try_files $uri $uri.html $uri/index.html @app;\n    }",
    "    location = / {\n        try_files /index.html =404;\n    }",
):
    assert s.count(old) == 1, f"block not found: {old.splitlines()[0]}"
    s = s.replace(old, old[:-6] + "\n" + hdr + "    }")
open(p, "w").write(s)
PY

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "nginx reloaded."
else
  nginx -t || true
  cp -a "$B" "$F"
  echo "nginx -t failed; restored the backup. Nothing changed."
  exit 1
fi
REMOTE

code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
cc() { curl -sI "$1" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}'; }
echo "/        $(code https://pratibha.tech/)  cache: $(cc https://pratibha.tech/)"
echo "/blog    $(code https://pratibha.tech/blog)  cache: $(cc https://pratibha.tech/blog)"
echo "/login   $(code https://pratibha.tech/login)  (dashboard, unchanged)"
echo "/health  $(code https://pratibha.tech/health)  (call line, unchanged)"
