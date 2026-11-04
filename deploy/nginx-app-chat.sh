#!/usr/bin/env bash
#
# Let https://pratibha.tech/app-chat.html reach the portal.
#
#   ./deploy/nginx-app-chat.sh
#
# The pratibha.tech nginx site has a `location ~* \.html$` block for the static
# marketing pages that never falls back to the app, so any .html address the
# portal serves (the Saarthi chat page the mobile app opens) answers 404. This
# adds `try_files $uri @app;` to that block: static pages are still served
# first, exactly as before.
#
# Backs up the config, validates it with `nginx -t`, and only then reloads; on
# a failed check the backup is put back and nothing changes.
set -euo pipefail
HOST_SSH=${HOST_SSH:-pratibha-vps}

ssh "$HOST_SSH" bash -s <<'REMOTE'
set -euo pipefail
F=/etc/nginx/sites-available/pratibha.tech
mkdir -p /root/nginx-backups
B=/root/nginx-backups/pratibha.tech.$(date +%Y%m%d-%H%M%S)

if grep -q 'try_files $uri @app;  # app-chat' "$F"; then
  echo "Already applied."
  exit 0
fi

cp "$F" "$B"
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """    location ~* \\.html$ {
        add_header Cache-Control "no-cache, must-revalidate";
    }"""
new = """    location ~* \\.html$ {
        try_files $uri @app;  # app-chat: static pages first, else the portal
        add_header Cache-Control "no-cache, must-revalidate";
    }"""
if old not in s:
    sys.exit("The .html block is not as expected; nothing changed.")
open(p, "w").write(s.replace(old, new, 1))
PY

if nginx -t; then
  systemctl reload nginx
  echo "Reloaded. Backup: $B"
else
  cp "$B" "$F"
  echo "nginx -t failed; the previous config is back in place." >&2
  exit 1
fi
REMOTE

code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
echo "app-chat.html   $(code https://pratibha.tech/app-chat.html)   (expect 200)"
echo "homepage        $(code https://pratibha.tech/)   (expect 200)"
echo "pricing page    $(code https://pratibha.tech/pricing)   (expect 200)"
