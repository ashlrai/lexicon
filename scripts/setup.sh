#!/usr/bin/env bash
# One-command development setup. Safe to run again. No prompts.
# macOS and Linux. Installs Node 20 or newer when the copy on PATH is missing
# or older, installs dependencies from the lockfile, and runs the smoke test.
#
#   bash scripts/setup.sh
#
# A downloaded Node lives in ${XDG_DATA_HOME:-$HOME/.local/share}/lexicon-dev/node
# and is used only when PATH does not already have Node 20+.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_MAJOR=20
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/lexicon-dev/node"

say() { printf '%s\n' "$*"; }
fail() { printf 'setup: %s\n' "$*" >&2; exit 1; }

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local version major
  version="$(node --version 2>/dev/null || true)"
  major="${version#v}"
  major="${major%%.*}"
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$MIN_MAJOR" ]
}

verify_sha256() {
  local file="$1" expect="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$expect" "$file" | sha256sum -c -
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\n' "$expect" "$file" | shasum -a 256 -c -
  else
    fail "need sha256sum or shasum to check the Node download"
  fi
}

install_node() {
  local tmp os arch name hash extracted
  command -v curl >/dev/null 2>&1 || fail "curl is required to download Node"
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) fail "this script supports macOS and Linux (uname -s: $(uname -s))" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) fail "this script supports x64 and arm64 (uname -m: $(uname -m))" ;;
  esac

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  say "downloading Node ${MIN_MAJOR} for ${os}-${arch}"
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  name="$(grep -E "node-v[0-9.]+-${os}-${arch}\\.tar\\.gz$" "$tmp/SHASUMS256.txt" | awk '{print $2}' | head -n 1)"
  [ -n "$name" ] || fail "no Node tarball for ${os}-${arch} in the Node 20 index"
  hash="$(awk -v name="$name" '$2 == name { print $1; exit }' "$tmp/SHASUMS256.txt")"
  [ -n "$hash" ] || fail "no checksum for ${name}"
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v20.x/${name}" -o "$tmp/${name}"
  verify_sha256 "$tmp/${name}" "$hash"
  tar -xzf "$tmp/${name}" -C "$tmp"
  extracted="${tmp}/${name%.tar.gz}"
  [ -x "${extracted}/bin/node" ] || fail "the Node archive did not contain bin/node"
  rm -rf "$PREFIX"
  mkdir -p "$(dirname "$PREFIX")"
  mv "$extracted" "$PREFIX"
  rm -rf "$tmp"
  trap - EXIT
}

ensure_node() {
  if node_ok; then
    say "node $(node --version) already on PATH ($(command -v node))"
    return
  fi
  if [ -x "$PREFIX/bin/node" ]; then
    export PATH="$PREFIX/bin:$PATH"
    if node_ok; then
      say "node $(node --version) from ${PREFIX}"
      return
    fi
  fi
  install_node
  export PATH="$PREFIX/bin:$PATH"
  node_ok || fail "Node ${MIN_MAJOR}+ is still not on PATH after install"
  say "installed node $(node --version) at ${PREFIX}"
  say "for later shells: export PATH=\"${PREFIX}/bin:\$PATH\""
}

say "lexicon dev setup (${ROOT})"
ensure_node
command -v npm >/dev/null 2>&1 || fail "npm was not found (it ships with Node)"
say "npm $(npm --version)"

export npm_config_fund=false
export npm_config_audit=false
export npm_config_update_notifier=false

say "npm ci"
npm ci --no-fund --no-audit

say "npm run smoke"
npm run smoke

say "setup complete"
