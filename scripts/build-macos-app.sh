#!/usr/bin/env bash
# Builds and packages the LexiconBar menu bar app.
#
#   scripts/build-macos-app.sh            # release build -> apps/macos/build/LexiconBar.app (+ .zip)
#   SKIP_ICON=1 scripts/build-macos-app.sh   # skip the icon render (faster; Finder shows a generic icon)
#
# Steps: `swift build -c release` in apps/macos/LexiconBar, assemble the .app
# (Info.plist with LSUIElement and the usage descriptions, version from
# package.json), render an .icns from the SF Symbol "waveform", ad-hoc
# codesign, zip with ditto. No Xcode project, no third-party tools.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/apps/macos/LexiconBar"
OUT="$ROOT/apps/macos/build"
APP="$OUT/LexiconBar.app"
ZIP="$OUT/LexiconBar.app.zip"
NAME="LexiconBar"

VERSION="$(sed -n 's/^  *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
: "${VERSION:=0.0.0}"
BUILD_NUMBER="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"

echo "==> swift build -c release ($NAME $VERSION, build $BUILD_NUMBER)"
(cd "$PKG" && swift build -c release --product "$NAME")
BIN_DIR="$(cd "$PKG" && swift build -c release --product "$NAME" --show-bin-path)"
BIN="$BIN_DIR/$NAME"
[ -x "$BIN" ] || { echo "error: $BIN not found" >&2; exit 1; }

echo "==> assembling $APP"
rm -rf "$APP" "$ZIP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$NAME"
chmod +x "$APP/Contents/MacOS/$NAME"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD_NUMBER/g" "$PKG/Packaging/Info.plist.in" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

if [ "${SKIP_ICON:-0}" != "1" ]; then
  echo "==> rendering AppIcon.icns"
  ICONSET="$OUT/AppIcon.iconset"
  MASTER="$OUT/icon-1024.png"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  if swift "$PKG/Packaging/render-icon.swift" "$MASTER" 1024 2>/dev/null; then
    for spec in 16:16x16 32:16x16@2x 32:32x32 64:32x32@2x 128:128x128 256:128x128@2x 256:256x256 512:256x256@2x 512:512x512 1024:512x512@2x; do
      px="${spec%%:*}"; name="${spec##*:}"
      sips -z "$px" "$px" "$MASTER" --out "$ICONSET/icon_$name.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
    rm -rf "$ICONSET" "$MASTER"
  else
    echo "warning: icon render failed; shipping without AppIcon.icns" >&2
  fi
fi

echo "==> codesign (ad-hoc)"
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

echo "==> zipping"
ditto -c -k --keepParent "$APP" "$ZIP"

echo
echo "Built $APP"
echo "Zip   $ZIP"
echo "Run   open \"$APP\""
echo "First launch of an ad-hoc signed app: right-click > Open, or: xattr -d com.apple.quarantine \"$APP\""
