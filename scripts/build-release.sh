#!/usr/bin/env bash
# Assembles a double-click, no-npm-required release bundle.
# Usage: scripts/build-release.sh <mac-arm64|win-x64>
set -euo pipefail

PLATFORM="${1:?usage: build-release.sh <mac-arm64|win-x64>}"
NODE_VERSION="22.23.2"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.release-cache"
OUT="$ROOT/release/$PLATFORM"

mkdir -p "$CACHE"
rm -rf "$OUT"
mkdir -p "$OUT/app"

echo "==> Building app"
(cd "$ROOT" && npm run build)

case "$PLATFORM" in
  mac-arm64)
    NODE_MODULES_SRC="$ROOT/node_modules"
    NODE_ARCHIVE="node-v$NODE_VERSION-darwin-arm64"
    NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE.tar.gz"
    NODE_BIN_IN_ARCHIVE="$NODE_ARCHIVE/bin/node"
    ;;
  win-x64)
    WIN_NM_DIR="$CACHE/win-x64-deps"
    mkdir -p "$WIN_NM_DIR"
    cp "$ROOT/package.json" "$WIN_NM_DIR/"
    [ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$WIN_NM_DIR/"
    echo "==> Installing Windows/x64 node_modules (cross-platform, untested at runtime)"
    (cd "$WIN_NM_DIR" && npm install --os=win32 --cpu=x64 --ignore-scripts)
    NODE_MODULES_SRC="$WIN_NM_DIR/node_modules"
    NODE_ARCHIVE="node-v$NODE_VERSION-win-x64"
    NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE.zip"
    NODE_BIN_IN_ARCHIVE="$NODE_ARCHIVE/node.exe"
    ;;
  *)
    echo "Unknown platform: $PLATFORM (expected mac-arm64 or win-x64)" >&2
    exit 1
    ;;
esac

echo "==> Copying app files"
cp -R "$ROOT/dist" "$OUT/app/dist"
cp -R "$NODE_MODULES_SRC" "$OUT/app/node_modules"
cp "$ROOT/package.json" "$ROOT/vite.config.ts" "$OUT/app/"
cp -R "$ROOT/local" "$OUT/app/local"
cp -R "$ROOT/.openai" "$OUT/app/.openai"
cp -R "$ROOT/build" "$OUT/app/build"

mkdir -p "$OUT/app/data/seed-videos" "$OUT/app/data/videos" "$OUT/app/data/trash"
cp "$ROOT/data/seed-videos/manifest.json" "$OUT/app/data/seed-videos/"
cp "$ROOT"/data/seed-videos/*.mp4 "$OUT/app/data/seed-videos/"
touch "$OUT/app/data/videos/.gitkeep" "$OUT/app/data/trash/.gitkeep"

echo "==> Fetching portable Node $NODE_VERSION for $PLATFORM"
NODE_LOCAL_ARCHIVE="$CACHE/$(basename "$NODE_URL")"
[ -f "$NODE_LOCAL_ARCHIVE" ] || curl -sL "$NODE_URL" -o "$NODE_LOCAL_ARCHIVE"

case "$PLATFORM" in
  mac-arm64)
    tar -xzf "$NODE_LOCAL_ARCHIVE" -C "$CACHE" "$NODE_BIN_IN_ARCHIVE"
    cp "$CACHE/$NODE_BIN_IN_ARCHIVE" "$OUT/app/node"
    chmod +x "$OUT/app/node"
    ;;
  win-x64)
    unzip -oq "$NODE_LOCAL_ARCHIVE" "$NODE_BIN_IN_ARCHIVE" -d "$CACHE"
    cp "$CACHE/$NODE_BIN_IN_ARCHIVE" "$OUT/app/node.exe"
    ;;
esac

echo "==> Writing launcher + docs"
case "$PLATFORM" in
  mac-arm64)
    cp "$ROOT/scripts/launch-macos.command" "$OUT/Launch FLUX 3 Wall.command"
    chmod +x "$OUT/Launch FLUX 3 Wall.command"
    ;;
  win-x64)
    cp "$ROOT/scripts/launch-windows.bat" "$OUT/Launch FLUX 3 Wall.bat"
    ;;
esac
cp "$ROOT/scripts/RELEASE-README.md" "$OUT/README.md"

echo "==> Zipping"
(cd "$ROOT/release" && rm -f "$PLATFORM.zip" && zip -qr "$PLATFORM.zip" "$PLATFORM")

echo "Done: release/$PLATFORM.zip"
du -sh "$OUT" "$ROOT/release/$PLATFORM.zip"
