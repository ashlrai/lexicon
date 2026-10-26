#!/bin/sh
# Installs @ashlr/lexicon and, on a terminal, runs `lexicon setup`.
#
#   curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
#
# Needs Node 20 or newer. Installs from the npm registry when the package is
# published there, otherwise from GitHub at its latest stable release tag.
# Failed discovery stops without installing a mutable branch. Under sudo it
# installs but skips setup, which must run as the user. POSIX sh only.
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
    Linux)   say "  Ubuntu's apt nodejs package is often older than Node ${MIN_NODE}. Prefer nvm, below." >&2
             say "  Elsewhere: sudo dnf install nodejs, or https://github.com/nodesource/distributions" >&2 ;;
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
  ''|*[!0-9]*)
    node_hint
    fail "could not read the Node version from: $(node --version 2>&1) (run \`node --version\` to see what PATH selects)" ;;
esac
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  node_hint
  fail "Node ${MIN_NODE}+ is required, found ${NODE_VERSION}"
fi
have npm || fail "npm was not found on PATH (it ships with Node)"
say "node v${NODE_VERSION} ok"

# 2. Install ------------------------------------------------------------------
SPEC=""
EXPECTED_VERSION=""
if [ -n "${LEXICON_REF:-}" ]; then
  SPEC="github:${REPO}#${LEXICON_REF}"
else
  # Pin the actual version we discovered; @latest could change between this
  # lookup and npm install. Validate responses before constructing a spec.
  if NPM_VERSION="$(npm view "$PKG" version 2>/dev/null)" && \
    node -e 'process.exit(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(process.argv[1]) ? 0 : 1)' -- "$NPM_VERSION"; then
    EXPECTED_VERSION="$NPM_VERSION"
    SPEC="${PKG}@${NPM_VERSION}"
  else
    have curl || fail "could not resolve a published version; install curl and retry, or set LEXICON_REF to an explicit reviewed ref"
    RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)" \
      || fail "could not resolve a published version; retry later or set LEXICON_REF to an explicit reviewed ref"
    TAG="$(printf '%s' "$RELEASE_JSON" | node -e '
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const release = JSON.parse(raw);
          const tag = release.tag_name;
          if (release.draft === true || release.prerelease === true || typeof tag !== "string" || !/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) process.exit(1);
          process.stdout.write(tag);
        } catch { process.exit(1); }
      });
    ')" || fail "latest release did not identify a stable version; retry later or set LEXICON_REF to an explicit reviewed ref"
    EXPECTED_VERSION="${TAG#v}"
    SPEC="github:${REPO}#${TAG}"
  fi
fi
say "installing ${SPEC} (npm install -g)..."
if ! npm install -g "$SPEC"; then
  say "" >&2
  say "npm install -g failed. If it was a permissions error, either:" >&2
  say "  - fix the npm prefix: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally" >&2
  say "  - or rerun with sudo:  curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sudo sh" >&2
  say "    (under sudo it installs only; then run lexicon setup as yourself, without sudo)" >&2
  fail "install failed"
fi

# 3. Verify -------------------------------------------------------------------
if ! have lexicon; then
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
      # npm on Windows puts its shims in the prefix itself, not in a bin/
      # under it, and prints the prefix as a Windows path.
      NPM_BIN="$NPM_PREFIX"
      if [ -n "$NPM_BIN" ] && have cygpath; then NPM_BIN="$(cygpath -u "$NPM_BIN" 2>/dev/null || printf '%s' "$NPM_PREFIX")"; fi
      BIN_HINT="the directory npm prefix -g prints (npm on Windows has no bin/ under it)" ;;
    *)
      NPM_BIN="${NPM_PREFIX}/bin"
      BIN_HINT="the bin directory under: npm prefix -g" ;;
  esac
  if [ -n "$NPM_PREFIX" ] && [ -x "${NPM_BIN}/lexicon" ]; then
    say "lexicon is installed in ${NPM_BIN} but that directory is not on PATH; add it, then run: lexicon setup" >&2
  fi
  fail "lexicon not on PATH; open a new terminal (or run: hash -r) and run: lexicon --version, and if it is still missing, add ${BIN_HINT}"
fi
INSTALLED_VERSION="$(lexicon --version)" || fail "the installed lexicon did not answer --version; run lexicon --version to see its error, then rerun this installer"
if [ -n "$EXPECTED_VERSION" ] && [ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]; then
  fail "lexicon on PATH reports ${INSTALLED_VERSION}, expected ${EXPECTED_VERSION}; fix PATH (command -v lexicon shows which one runs) before running setup"
fi
say "installed lexicon ${INSTALLED_VERSION}"

# 4. Setup --------------------------------------------------------------------
if [ "${LEXICON_NO_SETUP:-0}" = "1" ]; then
  say "skipping setup (LEXICON_NO_SETUP=1); run: lexicon setup"
  exit 0
fi
# `| sudo sh` (the permissions fallback above) runs as root: setup would write
# root's lexicon and agent configs, not the user's, so leave it to them.
if [ -n "${SUDO_USER:-}" ] && [ "$(id -u 2>/dev/null || echo)" = "0" ]; then
  say "skipping setup under sudo: it would configure root, not ${SUDO_USER}; as ${SUDO_USER}, without sudo, run: lexicon setup"
  exit 0
fi
if [ -t 0 ] && [ -t 1 ]; then
  say ""
  # A failed client or serve install returns 1 but the lexicon is in place; do not abort the shell.
  lexicon setup || say "setup finished with warnings; rerun: lexicon setup"
elif [ -t 1 ] && ( : </dev/tty ) 2>/dev/null; then
  # `curl | sh`: stdin is the pipe, but the terminal is still there. Open it to
  # check: /dev/tty is mode 666, so `-r` holds even with no controlling
  # terminal (setsid, some CI runners), where opening it fails.
  say ""
  lexicon setup </dev/tty || say "setup finished with warnings; rerun: lexicon setup"
else
  say "no terminal to ask the setup questions on; run: lexicon setup"
fi
