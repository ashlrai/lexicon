#!/usr/bin/env bash
# Builds LexiconBar.exe and zips it.
#
# Runs on macOS and Linux as well as on Windows: `dotnet publish -r win-x64`
# cross-compiles, and EnableWindowsTargeting in Directory.Build.props is what
# lets a WinForms project restore its targeting pack off Windows. The result
# cannot be *run* anywhere but Windows.
#
#   apps/windows/build/publish.sh              # win-x64
#   RID=win-arm64 apps/windows/build/publish.sh
set -euo pipefail

RID="${RID:-win-x64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/artifacts/$RID"

echo "==> dotnet --version: $(dotnet --version)"

echo "==> Unit tests (portable core)"
dotnet test "$ROOT/tests/LexiconBar.Core.Tests/LexiconBar.Core.Tests.csproj" -c Release --nologo

echo "==> Publish $RID"
rm -rf "$OUT"
dotnet publish "$ROOT/src/LexiconBar.App/LexiconBar.App.csproj" \
  -c Release \
  -r "$RID" \
  --self-contained \
  -o "$OUT" \
  --nologo

# The .pdb files are ~170 KB and only useful to whoever built it; the zip is
# something a cofounder downloads, so keep it to the one file they need.
rm -f "$OUT"/*.pdb

echo "==> Zip"
ZIP="$ROOT/artifacts/LexiconBar-$RID.zip"
rm -f "$ZIP"
(cd "$OUT" && zip -q -r "$ZIP" .)

ls -la "$OUT"
echo
echo "Wrote $ZIP"
echo
echo "This binary has never been run. See docs/WINDOWS-APP.md for the manual"
echo "test script before trusting it with anything you care about."
