#!/bin/bash
cd "$(dirname "$0")/app" || exit 1
# Only remove quarantine from the bundled executables needed by the wall.
for binary in node node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd; do
  if [ -f "$binary" ]; then xattr -d com.apple.quarantine "$binary" 2>/dev/null || true; fi
done
./node local/run.mjs --production --open "$@"
if [ $? -ne 0 ]; then read -r -p "Press Enter to close this window."; fi
