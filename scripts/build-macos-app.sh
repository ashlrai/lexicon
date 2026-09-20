#!/usr/bin/env bash
# Builds and packages the LexiconBar menu bar app.
#
#   scripts/build-macos-app.sh            # release build -> apps/macos/build/LexiconBar.app (+ .zip)
#   SKIP_ICON=1 scripts/build-macos-app.sh   # skip the icon render (faster; Finder shows a generic icon)
#
# Steps: `swift build -c release` in apps/macos/LexiconBar, assemble the .app
# (Info.plist with LSUIElement and the usage descriptions, version from
# package.json), render an .icns from the SF Symbol "waveform", codesign,
# zip with ditto. No Xcode project, no third-party tools.
#
# SIGNING. The app is signed with the local "LexiconBar Local Signing"
# certificate when it exists, and ad-hoc otherwise. This matters more than it
# sounds: macOS ties the Accessibility grant to the app's designated
# requirement, and an ad-hoc signature's requirement is the cdhash of the
# binary, so it changes on every build and the grant silently stops working
# (the System Settings switch stays on; tccd denies with "Failed to match
# existing code requirement"). A certificate's requirement does not change,
# so the grant is given once and survives every rebuild. Create the identity
# with scripts/make-signing-identity.sh; see docs/MACOS-APP.md.
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

IDENTITY="${LEXICONBAR_SIGN_IDENTITY:-LexiconBar Local Signing}"
KEYCHAIN="${LEXICONBAR_SIGN_KEYCHAIN:-$HOME/Library/Keychains/lexiconbar-signing.keychain-db}"
PASS_FILE="${LEXICONBAR_SIGN_PASSWORD_FILE:-$HOME/Library/Application Support/LexiconBar/signing-keychain.password}"

# A keychain of our own is locked again after a reboot; unlocking it here is
# what keeps codesign from putting up a password dialog mid-build.
if [ -f "$KEYCHAIN" ] && [ -f "$PASS_FILE" ]; then
  security unlock-keychain -p "$(cat "$PASS_FILE")" "$KEYCHAIN" 2>/dev/null || true
fi

if security find-identity -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY\""; then
  echo "==> codesign ($IDENTITY)"
  codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$APP"
  SIGNED_WITH="$IDENTITY"
else
  echo "==> codesign (ad-hoc)"
  codesign --force --sign - --timestamp=none "$APP"
  SIGNED_WITH="ad-hoc"
  cat >&2 <<EOF

warning: signed ad-hoc, so this build's designated requirement is its cdhash
warning: and changes again on the next build. Any Accessibility grant given to
warning: it will stop working, and the only cure is to remove the row in
warning: System Settings > Privacy & Security > Accessibility with - and add
warning: the app again. Fix it once with:  scripts/make-signing-identity.sh

EOF
fi
codesign --verify --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

# The designated requirement is the thing TCC remembers. Print it on every
# build so a change is visible at the moment it happens rather than the next
# time Fix everywhere quietly does nothing.
REQUIREMENT="$(codesign -d -r- "$APP" 2>/dev/null | sed -n 's/^designated => //p')"
CDHASH="$(codesign -d --verbose=4 "$APP" 2>&1 | sed -n 's/^CDHash=//p')"
echo "    signed with        $SIGNED_WITH"
echo "    cdhash             ${CDHASH:-unknown}"
echo "    designated => ${REQUIREMENT:-unknown}"

echo "==> zipping"
ditto -c -k --keepParent "$APP" "$ZIP"

echo
echo "Built $APP"
echo "Zip   $ZIP"
echo "Run   open \"$APP\""
echo "First launch of a locally signed app: right-click > Open, or: xattr -d com.apple.quarantine \"$APP\""
if [ "$SIGNED_WITH" = "ad-hoc" ]; then
  echo "Sign  scripts/make-signing-identity.sh   # so the Accessibility grant survives the next build"
fi
