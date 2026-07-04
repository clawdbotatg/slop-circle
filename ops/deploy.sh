#!/bin/bash
# Deploy circle to the slopcomputer box. ALWAYS rebuilds web + relay first —
# the live relay runs relay/dist/index.js (compiled), so a stale dist means
# new relay endpoints (bus, blob store) silently 404 in production even though
# `npm start` (which runs src via tsx) works locally. Build → rsync → restart.
set -e
cd "$(dirname "$0")/.."

HOST="${CIRCLE_DEPLOY_HOST:-slopcomputer}"
REMOTE="${CIRCLE_DEPLOY_PATH:-~/slop-circle}"

echo "→ Building web + relay locally…"
npm run build -w web >/dev/null
npm run build -w relay >/dev/null

echo "→ Rsyncing to $HOST:$REMOTE …"
rsync -az \
  --exclude '.git' --exclude '.circle-data' --exclude '.circle-secret' --exclude 'test' \
  ./ "$HOST:$REMOTE/"

echo "→ Restarting circle-relay…"
ssh "$HOST" 'sudo systemctl restart circle-relay && sleep 2 && systemctl is-active circle-relay && curl -s localhost:8789/healthz && echo'

echo "→ Health check…"
code=$(curl -s -o /dev/null -w "%{http_code}" https://circle.slop.computer/)
echo "  https://circle.slop.computer → $code"
[ "$code" = "200" ] && echo "✓ deployed" || { echo "✗ site not healthy"; exit 1; }
