#!/bin/bash
# Run every end-to-end test against a running relay (default localhost:8788),
# one at a time with a pause + browser cleanup between them — the tests each
# spawn 2-3 headless Chromium contexts, and running them concurrently starves
# page loads on a laptop. Start the app first: `npm start`.
set -e
cd "$(dirname "$0")/.."
export CIRCLE_URL="${CIRCLE_URL:-http://localhost:8788}"

tests=(e2ee-adversarial passkey-identity cosign chat notes skill)
fails=0
for t in "${tests[@]}"; do
  printf '%-20s ' "$t"
  if node "test/$t.mjs" 2>/tmp/circle-test-err | grep -q "MILESTONE PASS"; then
    echo "PASS"
  else
    echo "FAIL"; tail -3 /tmp/circle-test-err; fails=$((fails + 1))
  fi
  # Kill both possible cached-browser names — on this machine playwright uses
  # Chromium, not "Google Chrome for Testing"; leaving contexts alive starves
  # later tests' page loads (they flake with "no claim offer").
  pkill -f "Google Chrome for Testing" 2>/dev/null || true
  pkill -f "Chromium" 2>/dev/null || true
  sleep 5
done
echo "----"
[ "$fails" -eq 0 ] && echo "all green" || { echo "$fails failed"; exit 1; }
