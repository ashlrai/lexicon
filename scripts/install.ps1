# Install @ashlr/lexicon on Windows.
#
#   irm https://raw.githubusercontent.com/ashlrai/lexicon/main/scripts/install.ps1 | iex
#
# Needs Node 20 or newer. LEXICON_NO_SETUP=1 skips `lexicon setup`.
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "lexicon install: $Message"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "node was not found on PATH. Install Node 20 or newer from https://nodejs.org, then open a new PowerShell and run this again."
}
$versionText = (& node --version)
if ($versionText -notmatch '^v?(\d+)\.') { Fail "could not read the Node version from: $versionText" }
if ([int]$Matches[1] -lt 20) { Fail "Node 20+ is required, found $versionText" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm was not found on PATH (it ships with Node)" }
Write-Host "node $versionText ok"

$pkg = '@ashlr/lexicon'
$spec = $null
$expected = $null
if ($env:LEXICON_REF) {
  $spec = "github:ashlrai/lexicon#$($env:LEXICON_REF)"
} else {
  $published = $null
  try { $published = (& npm view $pkg version).Trim() } catch { $published = $null }
  if ($published -match '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    $expected = $published
    $spec = "${pkg}@${published}"
  } else {
    Fail "could not resolve a published version; retry later or set LEXICON_REF to an explicit reviewed ref"
  }
}

Write-Host "installing $spec (npm install -g)..."
& npm install -g $spec
if ($LASTEXITCODE -ne 0) { Fail "install failed" }

$lex = Get-Command lexicon -ErrorAction SilentlyContinue
if (-not $lex) {
  $prefix = (& npm prefix -g)
  Fail "lexicon not on PATH. Add $prefix to PATH, open a new PowerShell, and run: lexicon --version"
}
$installed = (& lexicon --version).Trim()
if ($expected -and $installed -ne $expected) {
  Fail "lexicon on PATH reports $installed, expected $expected"
}
Write-Host "installed lexicon $installed"

if ($env:LEXICON_NO_SETUP -eq '1') {
  Write-Host "skipping setup (LEXICON_NO_SETUP=1); run: lexicon setup"
  return
}
if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
  Write-Host "no terminal to ask the setup questions on; run: lexicon setup"
  return
}
& lexicon setup
if ($LASTEXITCODE -ne 0) { Write-Host "setup finished with warnings; rerun: lexicon setup" }
