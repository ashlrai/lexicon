#!/usr/bin/env bash
# Run from any directory in the checkout. Requires installed dependencies.
# Stop at the first failed step so a known failure returns promptly.
set -euo pipefail
SECONDS=0
cd "$(git rev-parse --show-toplevel)"
cache=$(git rev-parse --git-path fast-check-cache)
mkdir -p "$cache"
work=$(mktemp -d)
trap 'printf "Total: %ss\n" "$SECONDS"; rm -rf "$work"' EXIT
step() {
  local name=$1
  shift
  if "$@" >"$work/output" 2>&1; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s\n' "$name"
    cat "$work/output" >&2
    return 1
  fi
}
# Match package.json's checks without npm startup overhead. Keep compiler caches
# in private worktree metadata; lint repeats the package typecheck verbatim.
typecheck() {
  local project index=0 failed=0
  local pids=()
  for project in tsconfig.json extension/tsconfig.json site/tsconfig.json; do
    node_modules/.bin/tsc -p "$project" --noEmit --incremental \
      --tsBuildInfoFile "$cache/$index" >"$work/check-$index" 2>&1 &
    pids+=("$!")
    index=$((index + 1))
  done
  for index in "${!pids[@]}"; do
    wait "${pids[$index]}" || failed=1
    cat "$work/check-$index"
  done
  return "$failed"
}
step typecheck typecheck
step lint node_modules/.bin/tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile "$cache/0"
affected_tests() {
  # Fail closed if the comparison ref is unavailable.
  if ! git rev-parse --verify 'origin/main^{commit}' >/dev/null 2>&1; then
    printf 'Missing origin/main; fetch it before running fast-check.\n' >&2
    return 1
  fi
  # Test-only edits need no traversal of every product test's import graph.
  # Markdown and shell scripts are not imported modules in this repository.
  git diff --name-only -z origin/main...HEAD >"$work/changed" &&
    git diff --name-only -z HEAD >>"$work/changed" &&
    git ls-files --others --exclude-standard -z >>"$work/changed" || return 1
  local file direct=1
  local tests=()
  while IFS= read -r -d '' file; do
    case "$file" in
      tests/*.test.ts|src/*.test.ts|bench/*.test.ts)
        [[ ! -f "$file" ]] || tests+=("$file") ;;
      scripts/fast-check.sh)
        [[ ! -f tests/fast-check.test.ts ]] || tests+=(tests/fast-check.test.ts) ;;
      *.md) ;;
      *) direct=0 ;;
    esac
  done <"$work/changed"
  if ((direct && ${#tests[@]})); then
    node_modules/.bin/vitest run "${tests[@]}" --passWithNoTests
  else
    node_modules/.bin/vitest run --changed origin/main --passWithNoTests
  fi
}
step tests affected_tests
