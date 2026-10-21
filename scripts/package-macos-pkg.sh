#!/bin/sh
# Builds a combined macOS PKG: the app, with the bundled CLI linked into
# /usr/local/bin by the package's postinstall. A DMG cannot run a script, which
# is why this exists as a second artifact rather than a replacement.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
TARGET=""
if [ "${1:-}" = "--target" ]; then
  TARGET="${2:?--target needs a triple}"
fi
TARGET_ROOT="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
APP="$TARGET_ROOT/${TARGET:+$TARGET/}release/bundle/macos/Moka Canvas.app"
OUT="$ROOT/release/Moka Canvas-$VERSION.pkg"

if [ ! -d "$APP" ]; then
  echo "Build the app bundle first: make package-macos" >&2
  exit 1
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/Applications"
cp -R "$APP" "$STAGE/Applications/Moka Canvas.app"

mkdir -p "$ROOT/release"
pkgbuild \
  --root "$STAGE" \
  --scripts "$ROOT/src-tauri/installer/macos" \
  --identifier app.mokacanvas.pkg \
  --version "$VERSION" \
  --install-location "/" \
  "$OUT"

echo "Created $OUT"
