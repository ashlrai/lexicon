#!/bin/sh
# Installs @ashlr/lexicon and runs `lexicon setup`.
#
#   curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
#
# Needs Node 20 or newer. Installs from the npm registry when the package is
# published there, otherwise straight from GitHub at the latest tag (falls
# back to main). POSIX sh only: no bashisms.
#
#   LEXICON_NO_SETUP=1   skip `lexicon setup` afterwards
#   LEXICON_REF=<ref>    install this git ref instead of the latest tag
set -eu

PKG="@ashlr/lexicon"
REPO="ashlrai/lexicon"
MIN_NODE=20

say() { printf '%s\n' "$*"; }
fail() { printf 'lexicon install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

node_hint() {
  say "Install Node ${MIN_NODE} or newer first:" >&2
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)  say "  brew install node          (https://brew.sh)" >&2 ;;
    Linux)   say "  sudo apt install nodejs npm   or   sudo dnf install nodejs" >&2 ;;
    MINGW*|MSYS*|CYGWIN*) say "  winget install OpenJS.NodeJS.LTS" >&2 ;;
  esac
  say "  or with nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && nvm install --lts" >&2
}

# 1. Node ---------------------------------------------------------------------
if ! have node; then
  node_hint
  fail "node was not found on PATH"
fi
NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "could not read the Node version from: $(node --version 2>&1)" ;;
esac
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  node_hint
  fail "Node ${MIN_NODE}+ is required, found ${NODE_VERSION}"
fi
have npm || fail "npm was not found on PATH (it ships with Node)"
say "node v${NODE_VERSION} ok"

# 2. Install ------------------------------------------------------------------
SPEC=""
if [ -n "${LEXICON_REF:-}" ]; then
  SPEC="github:${REPO}#${LEXICON_REF}"
elif npm view "$PKG" version >/dev/null 2>&1; then
  SPEC="$PKG"
else
  TAG=""
  if have curl; then
    TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  if [ -n "$TAG" ]; then
    SPEC="github:${REPO}#${TAG}"
  else
    SPEC="github:${REPO}#main"
  fi
fi
say "installing ${SPEC} (npm install -g)..."
if ! npm install -g "$SPEC"; then
  say "" >&2
  say "npm install -g failed. If it was a permissions error, either:" >&2
  say "  - fix the npm prefix: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally" >&2
  say "  - or rerun with sudo:  curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sudo sh" >&2
  fail "install failed"
fi

# 3. Verify -------------------------------------------------------------------
if ! have lexicon; then
  NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
  if [ -x "${NPM_BIN}/lexicon" ]; then
    say "lexicon is installed in ${NPM_BIN} but that directory is not on PATH; add it, then run: lexicon setup" >&2
  fi
  fail "lexicon not on PATH"
fi
say "installed lexicon $(lexicon --version)"

# 4. Setup --------------------------------------------------------------------
if [ "${LEXICON_NO_SETUP:-0}" = "1" ]; then
  say "skipping setup (LEXICON_NO_SETUP=1); run: lexicon setup"
  exit 0
fi
if [ -t 0 ] && [ -t 1 ]; then
  say ""
  # A failed client or serve install returns 1 but the lexicon is in place; do not abort the shell.
  lexicon setup || say "setup finished with warnings; rerun: lexicon setup"
elif [ -t 1 ] && [ -r /dev/tty ]; then
  # `curl | sh`: stdin is the pipe, but the terminal is still there.
  say ""
  lexicon setup </dev/tty || say "setup finished with warnings; rerun: lexicon setup"
else
  say "next: run  lexicon setup"
fi
