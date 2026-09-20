<#
.SYNOPSIS
    Builds LexiconBar.exe and zips it. The Windows-native twin of publish.sh.

.EXAMPLE
    pwsh apps\windows\build\publish.ps1
    pwsh apps\windows\build\publish.ps1 -Rid win-arm64
#>
[CmdletBinding()]
param(
    [string]$Rid = 'win-x64'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "artifacts\$Rid"

Write-Host "==> dotnet --version: $(dotnet --version)"

Write-Host '==> Unit tests (portable core)'
dotnet test (Join-Path $root 'tests\LexiconBar.Core.Tests\LexiconBar.Core.Tests.csproj') -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed.' }

Write-Host "==> Publish $Rid"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet publish (Join-Path $root 'src\LexiconBar.App\LexiconBar.App.csproj') `
    -c Release `
    -r $Rid `
    --self-contained `
    -o $out `
    --nologo
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }

Get-ChildItem -Path $out -Filter *.pdb | Remove-Item -Force

Write-Host '==> Zip'
$zip = Join-Path $root "artifacts\LexiconBar-$Rid.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip

Get-ChildItem $out
Write-Host ''
Write-Host "Wrote $zip"
