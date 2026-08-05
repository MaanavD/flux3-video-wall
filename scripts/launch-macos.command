#!/bin/bash
set -e
cd "$(dirname "$0")"

# macOS marks every file extracted from a downloaded zip as quarantined,
# which would otherwise pop a "cannot be opened" Gatekeeper prompt for
# each of node/workerd/etc individually. Strip it now that this script
# (the one thing the user had to approve) is already running.
xattr -dr com.apple.quarantine . 2>/dev/null || true

cd app

if [ ! -f .env.local ]; then
  echo "======================================"
  echo " FLUX 3 Video Wall — first-time setup"
  echo "======================================"
  read -p "Paste your BFL API key (or press Enter to skip for now): " BFL_KEY
  cat > .env.local <<EOF
BFL_API_KEY=$BFL_KEY
BFL_MODEL_ENDPOINT=https://api.bfl.ai/v1/flux-3-video
BFL_RESOLUTION=hd
BFL_CONCURRENCY=8
LOCAL_API_PORT=8788
EOF
  echo "Saved to app/.env.local — edit this file any time to change your key."
  echo ""
fi

cleanup() {
  kill "$API_PID" "$WALL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

./node --env-file-if-exists=.env.local local/server.mjs &
API_PID=$!

./node node_modules/vinext/dist/cli.js start &
WALL_PID=$!

echo "Starting FLUX 3 Video Wall..."
sleep 4
open http://localhost:3000

wait
