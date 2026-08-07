#!/bin/sh
# Generates the per-environment config at container start.
#
#   API_BASE        what the browser requests. '/api' keeps it same-origin.
#   API_PROXY_PASS  where nginx forwards /api/. Set it to keep the browser on
#                   this origin, so no CORS is involved at all.
set -e

: "${API_BASE:=/api}"

cat > /usr/share/nginx/html/scripts/config.js <<EOF
// Generated at container start from \$API_BASE. Do not edit in the image.
window.PALROUTE_CONFIG = {
  apiBase: '${API_BASE}',
};
EOF

# nginx includes this unconditionally, so it must exist either way.
if [ -n "${API_PROXY_PASS:-}" ]; then
  cat > /etc/nginx/palroute-api.conf <<EOF
location /api/ {
  proxy_pass ${API_PROXY_PASS};
  proxy_set_header Host              \$host;
  proxy_set_header X-Real-IP         \$remote_addr;
  proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
}
EOF
  echo "PalRoute UI: apiBase=${API_BASE}, proxying /api/ -> ${API_PROXY_PASS}"
else
  : > /etc/nginx/palroute-api.conf
  echo "PalRoute UI: apiBase=${API_BASE}, no /api proxy configured"
fi
