#!/bin/bash
# One-command local run: builds the client and starts the relay serving it.
# Open http://localhost:8788 in two tabs to test a call (use localhost, NOT
# 127.0.0.1 — passkeys need a real domain or "localhost" as the WebAuthn RP).
set -e
cd "$(dirname "$0")/.."

# A stable dev session secret so room cookies survive relay restarts. For a
# real deployment set CIRCLE_SESSION_SECRET yourself (openssl rand -hex 32).
if [ -z "$CIRCLE_SESSION_SECRET" ]; then
  if [ -f .circle-secret ]; then
    CIRCLE_SESSION_SECRET="$(cat .circle-secret)"
  else
    CIRCLE_SESSION_SECRET="$(openssl rand -hex 32)"
    echo "$CIRCLE_SESSION_SECRET" > .circle-secret
  fi
  export CIRCLE_SESSION_SECRET
fi

export CIRCLE_WEB_DIST="$(pwd)/web/dist"
export CIRCLE_DATA_DIR="${CIRCLE_DATA_DIR:-$(pwd)/.circle-data}"
# Use CIRCLE_PORT, not PORT — PORT is often already set in a shell (e.g. the
# clawd-harness exports 8787), which would collide. Force the relay's PORT.
export PORT="${CIRCLE_PORT:-8788}"

echo "Building client…"
npm run build -w web >/dev/null

echo ""
echo "  circle is running →  http://localhost:$PORT"
echo ""
echo "  To test a call: open that URL in TWO browser tabs, pick a room name +"
echo "  password in the first (it creates the room), then paste the same link"
echo "  into the second. Turn on your camera in both."
echo ""
echo "  (Two tabs on this machine connect directly. Two DIFFERENT people on"
echo "   different networks need a public HTTPS deploy + TURN — see ops/deploy.)"
echo ""

exec npm run start -w relay
