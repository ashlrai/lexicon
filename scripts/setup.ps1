# One-command development setup for Windows. Safe to run again. No prompts.
# Installs Node 20 when the copy on PATH is missing or older, then runs
# scripts/setup.mjs (lockfile install and the smoke test).
# On macOS and Linux, use: bash scripts/setup.sh
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'package.json'))) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
Set-Location $Root

function Node-Major([string]$VersionText) {
  if ($VersionText -match '^v?(\d+)') { return [int]$Matches[1] }
  return 0
}

function Current-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $version = & node --version
  if ((Node-Major $version) -ge 20) { return $cmd.Source }
  return $null
}

$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { throw 'setup: no home directory (USERPROFILE or HOME)' }
$PrefixRoot = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $HomeDir '.local/share' }
$Prefix = Join-Path $PrefixRoot 'lexicon-dev/node'
$NodeFileName = if ($env:OS -eq 'Windows_NT') { 'node.exe' } else { 'node' }
$PrefixNode = Join-Path $Prefix $NodeFileName

function Save-Https([string]$Url, [string]$OutFile) {
  if ($Url -notmatch '^https://') { throw "setup: refusing non-HTTPS URL $Url" }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) { throw 'setup: curl.exe is required so Node is downloaded over HTTPS only' }
  & curl.exe --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --retry 3 --output $OutFile $Url
  if ($LASTEXITCODE -ne 0) { throw "setup: download failed ($LASTEXITCODE) $Url" }
}

function Use-PrefixNode {
  if (Test-Path $PrefixNode) {
    $version = & $PrefixNode --version
    if ((Node-Major $version) -ge 20) {
      $env:Path = "$(Split-Path $PrefixNode);$env:Path"
      return $true
    }
  }
  return $false
}

if (-not (Current-Node)) {
  if (-not (Use-PrefixNode)) {
    if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
      Write-Error "setup: on macOS and Linux run: bash scripts/setup.sh"
    }
    Write-Host "downloading Node 20 for Windows"
    $arch = if ([Environment]::Is64BitOperatingSystem) {
      if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    } else { throw 'setup: 32-bit Windows is not supported' }
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lexicon-node-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      $sumsPath = Join-Path $tmp 'SHASUMS256.txt'
      Save-Https 'https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt' $sumsPath
      $name = Select-String -Path $sumsPath -Pattern "node-v[0-9.]+-win-$arch\.zip$" | Select-Object -First 1
      if (-not $name) { throw "setup: no Node zip for win-$arch" }
      $file = ($name.Line -split '\s+')[-1]
      $hash = ($name.Line -split '\s+')[0].ToLower()
      $zip = Join-Path $tmp $file
      Save-Https "https://nodejs.org/dist/latest-v20.x/$file" $zip
      $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
      if ($actual -ne $hash) { throw "setup: Node download checksum did not match" }
      if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix }
      New-Item -ItemType Directory -Path (Split-Path $Prefix) -Force | Out-Null
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $extracted = Join-Path $tmp ($file -replace '\.zip$','')
      Move-Item $extracted $Prefix
    } finally {
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    }
    if (-not (Use-PrefixNode)) { throw 'setup: Node 20 is still not on PATH after install' }
    Write-Host "installed node $(& node --version) at $Prefix"
  } else {
    Write-Host "node $(& node --version) from $Prefix"
  }
} else {
  Write-Host "node $(& node --version) already on PATH"
}

& node (Join-Path $PSScriptRoot 'setup.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
