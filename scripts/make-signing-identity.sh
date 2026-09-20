#!/usr/bin/env bash
# Creates the local code-signing identity that keeps LexiconBar's macOS
# Accessibility grant alive across rebuilds.
#
#   scripts/make-signing-identity.sh          # create it, or report the one that exists
#   scripts/make-signing-identity.sh --force  # delete and recreate it
#   scripts/make-signing-identity.sh --show   # print what exists and exit
#
# WHY THIS EXISTS
#
# TCC binds an Accessibility grant to the app's *designated requirement* (DR).
# An ad-hoc signature (`codesign --sign -`) has no certificate, so its DR is
# the cdhash of the binary — which changes on every single build. The row in
# System Settings keeps its switch on while tccd denies the app with
# "Failed to match existing code requirement", and toggling the switch does not
# rebind it; only removing the row with − and adding the app again does.
#
# Signing with a certificate instead gives a DR of
#   identifier "ai.ashlr.lexiconbar" and certificate leaf = H"<cert sha1>"
# which depends on the certificate, not on the bytes of the binary. Grant it
# once and every future build is still the same app as far as TCC is concerned.
#
# WHAT IT CREATES
#
#   ~/Library/Keychains/lexiconbar-signing.keychain-db      a keychain of its own
#   ~/Library/Application Support/LexiconBar/signing-keychain.password   (0600)
#   a self-signed 10-year RSA-2048 certificate, "LexiconBar Local Signing",
#   with basicConstraints=critical,CA:false and extendedKeyUsage=codeSigning
#   and the matching private key, both inside that keychain
#   the keychain added to this user's `security list-keychains -d user` list
#
# A keychain of its own, rather than the login keychain, is what makes this
# non-interactive. `security set-key-partition-list` has to be given the
# keychain's password or macOS puts up a dialog, and the login keychain's
# password is the user's own — which we will not ask for and cannot supply.
# A keychain we create has a password we generated, so codesign can use the
# key with no prompt, ever. Nothing else is put in that keychain.
#
# The private key signs local builds of this app and nothing else. It is not a
# Developer ID: Gatekeeper does not trust it, and builds signed with it are
# still "unidentified developer" on anyone else's Mac. For distributing to
# other people, see docs/RELEASING.md.
#
# TO REMOVE IT ALL
#
#   security delete-identity -c "LexiconBar Local Signing" \
#       ~/Library/Keychains/lexiconbar-signing.keychain-db
#   security delete-keychain ~/Library/Keychains/lexiconbar-signing.keychain-db
#   rm -f ~/Library/Application\ Support/LexiconBar/signing-keychain.password
#
# (`security delete-keychain` also drops it from the search list.) After
# removing it, builds fall back to ad-hoc signing and the grant goes back to
# needing a remove-and-re-add on every build.

set -euo pipefail

IDENTITY="${LEXICONBAR_SIGN_IDENTITY:-LexiconBar Local Signing}"
KEYCHAIN="${LEXICONBAR_SIGN_KEYCHAIN:-$HOME/Library/Keychains/lexiconbar-signing.keychain-db}"
PASS_FILE="${LEXICONBAR_SIGN_PASSWORD_FILE:-$HOME/Library/Application Support/LexiconBar/signing-keychain.password}"
DAYS=3650

FORCE=0
SHOW_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --show) SHOW_ONLY=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;$d'; exit 0 ;;
    *) echo "error: unknown argument $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Runs a command with a hard time limit, so a step that unexpectedly wants a
# GUI confirmation reports that instead of hanging the script forever.
run_limited() {
  local limit="$1"; shift
  "$@" & local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

manual_steps() {
  cat >&2 <<EOF

This step needs something only you can give (a keychain password, or a click in
a dialog). Nothing was left half-done; make the certificate by hand instead:

  1. Open Keychain Access.
  2. Menu: Keychain Access > Certificate Assistant > Create a Certificate…
  3. Name:              $IDENTITY
     Identity Type:     Self Signed Root
     Certificate Type:  Code Signing
     Tick "Let me override defaults".
  4. Continue through the pages; a validity of 3650 days is a good choice.
     Leave the key pair as RSA 2048. Specify "login" as the keychain.
  5. Finish, then in the "login" keychain find the new certificate, open it,
     expand "Trust" and set "Code Signing" to "Always Trust" (optional: codesign
     does not require it, but it quiets \`security find-identity -v\`).
  6. Check it is there:
       security find-identity -p codesigning | grep "$IDENTITY"
  7. Build:
       scripts/build-macos-app.sh
     The first build will ask once whether codesign may use the key. Click
     "Always Allow" and it never asks again.

EOF
}

# The identity as codesign will look it up: any keychain in the search list.
find_identity_line() {
  security find-identity -p codesigning 2>/dev/null | grep -F "\"$IDENTITY\"" | head -1 || true
}

cert_sha1() {
  find_identity_line | sed -n 's/^ *[0-9]*) *\([0-9A-F]*\) .*/\1/p'
}

in_search_list() {
  security list-keychains -d user 2>/dev/null | sed 's/^ *"//;s/"$//' | grep -Fqx "$KEYCHAIN"
}

add_to_search_list() {
  local existing
  existing="$(security list-keychains -d user | sed 's/^ *"//;s/"$//' | grep -Fvx "$KEYCHAIN" || true)"
  # shellcheck disable=SC2086
  security list-keychains -d user -s $existing "$KEYCHAIN" >/dev/null
}

report() {
  local line sha1
  line="$(find_identity_line)"
  sha1="$(cert_sha1)"
  say "Identity   $IDENTITY"
  say "Keychain   $KEYCHAIN"
  say "Password   $PASS_FILE"
  say "Cert SHA-1 $sha1"
  say "Listed as  ${line:-(not found)}"
  say ""
  say "Builds signed with it get this designated requirement, whatever changes"
  say "in the binary:"
  say "    identifier \"ai.ashlr.lexiconbar\" and certificate leaf = H\"$(printf '%s' "$sha1" | tr 'A-Z' 'a-z')\""
  say ""
  say "Remove it with:"
  say "    security delete-identity -c \"$IDENTITY\" \"$KEYCHAIN\""
  say "    security delete-keychain \"$KEYCHAIN\""
}

if [ "$SHOW_ONLY" = "1" ]; then
  [ -n "$(find_identity_line)" ] || die "no \"$IDENTITY\" identity found. Run: scripts/make-signing-identity.sh"
  report
  exit 0
fi

if [ "$FORCE" = "1" ]; then
  say "==> removing the existing identity"
  security delete-identity -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1 || true
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -f "$PASS_FILE"
fi

# Already there and usable? Say so and stop: this script is safe to re-run.
if [ -n "$(find_identity_line)" ]; then
  say "==> \"$IDENTITY\" already exists; nothing to do"
  say ""
  report
  exit 0
fi

command -v openssl >/dev/null || die "openssl not found on PATH"

say "==> creating \"$IDENTITY\""

# 1. The keychain, with a password we generate so no dialog is ever needed.
if [ -f "$KEYCHAIN" ] && [ ! -f "$PASS_FILE" ]; then
  die "$KEYCHAIN exists but its password file $PASS_FILE does not.
       Re-create both:  scripts/make-signing-identity.sh --force"
fi

if [ ! -f "$PASS_FILE" ]; then
  mkdir -p "$(dirname "$PASS_FILE")"
  ( umask 077; openssl rand -hex 24 > "$PASS_FILE" )
  chmod 600 "$PASS_FILE"
fi
KC_PASS="$(cat "$PASS_FILE")"
[ -n "$KC_PASS" ] || die "$PASS_FILE is empty; re-create with --force"

if [ ! -f "$KEYCHAIN" ]; then
  security create-keychain -p "$KC_PASS" "$KEYCHAIN" || die "could not create $KEYCHAIN"
  say "    keychain   $KEYCHAIN"
fi
# No auto-lock timeout and no lock on sleep: a locked keychain would put up a
# password dialog in the middle of a build.
security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$KC_PASS" "$KEYCHAIN" || die "could not unlock $KEYCHAIN"

# 2. A self-signed certificate whose extended key usage is code signing.
#    (The Apple "Developer ID Application" OID 1.2.840.113635.100.6.1.13 is for
#    certificates Apple issues; a local certificate neither needs nor may claim it.)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
P12_PASS="$(openssl rand -hex 20)"

cat > "$WORK/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions    = codesign_ext
prompt             = no
[ dn ]
CN = $IDENTITY
[ codesign_ext ]
basicConstraints     = critical,CA:false
keyUsage             = critical,digitalSignature
extendedKeyUsage     = critical,codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" -sha256 \
  -config "$WORK/openssl.cnf" -extensions codesign_ext \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1 \
  || die "openssl could not create the certificate"

openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/identity.p12" -passout "pass:$P12_PASS" -name "$IDENTITY" >/dev/null 2>&1 \
  || die "openssl could not package the certificate and key"
say "    certificate self-signed, $DAYS days, extendedKeyUsage = codeSigning"

# 3. Import it, letting codesign use the key.
status=0
run_limited 30 security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$P12_PASS" \
  -f pkcs12 -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1 || status=$?
if [ "$status" != "0" ]; then
  if [ "$status" = "124" ]; then
    printf 'error: `security import` did not finish; it is probably waiting on a dialog.\n' >&2
  else
    printf 'error: `security import` failed (%s).\n' "$status" >&2
  fi
  manual_steps
  exit 1
fi

# 4. The partition list is what stops codesign being asked "may this tool use
#    the key?" on every build. It needs the keychain's password, which is why
#    this is not the login keychain.
status=0
run_limited 30 security set-key-partition-list \
  -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KEYCHAIN" >/dev/null 2>&1 || status=$?
if [ "$status" != "0" ]; then
  if [ "$status" = "124" ]; then
    printf 'error: `security set-key-partition-list` did not finish; it is waiting on a dialog.\n' >&2
  else
    printf 'error: `security set-key-partition-list` failed (%s).\n' "$status" >&2
  fi
  manual_steps
  exit 1
fi
say "    key usable by codesign with no prompt"

# 5. codesign only looks in the search list, so put it there.
if ! in_search_list; then
  add_to_search_list
  say "    added to the keychain search list"
fi

LINE="$(find_identity_line)"
[ -n "$LINE" ] || { printf 'error: the identity was imported but codesign cannot see it.\n' >&2; manual_steps; exit 1; }

# 6. Prove the key actually signs, here, with no dialog. A build that hangs on
#    a keychain prompt is exactly what this script exists to prevent.
SMOKE="$WORK/Smoke.app"
mkdir -p "$SMOKE/Contents/MacOS"
cp /bin/echo "$SMOKE/Contents/MacOS/Smoke"
cat > "$SMOKE/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Smoke</string>
<key>CFBundleIdentifier</key><string>ai.ashlr.lexiconbar.smoketest</string>
<key>CFBundleName</key><string>Smoke</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF
status=0
run_limited 40 codesign --force --options runtime --timestamp=none \
  --sign "$IDENTITY" "$SMOKE" >/dev/null 2>&1 || status=$?
if [ "$status" != "0" ]; then
  if [ "$status" = "124" ]; then
    printf 'error: codesign did not finish; it is waiting on a keychain dialog.\n' >&2
  else
    printf 'error: codesign could not use the new identity (%s).\n' "$status" >&2
  fi
  manual_steps
  exit 1
fi
say "    test signature made with no prompt"

say ""
report
say ""
say "Next: scripts/build-macos-app.sh"
