# Build packaged zips for Chromium (Chrome/Edge/Brave/Opera) and Firefox.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1 -Version 1.0.0

param([string]$Version = "1.0.0")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Files shared by both builds (everything except the manifests + tooling).
$shared = @("popup.html", "popup.js", "content.js", "README.md", "LICENSE", "icons")

$dist = Join-Path $root "dist"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null

function Build-Package($name, $manifestSource) {
  $stage = Join-Path $dist $name
  New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($f in $shared) { Copy-Item $f -Destination $stage -Recurse }
  Copy-Item $manifestSource -Destination (Join-Path $stage "manifest.json")
  $zip = Join-Path $dist "$name-v$Version.zip"
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
  Write-Host "Built $zip"
}

Build-Package "amazon-subscribe-save-cancel-all-chromium" "manifest.json"
Build-Package "amazon-subscribe-save-cancel-all-firefox"  "manifest.firefox.json"

Write-Host "Done. Zips are in dist/"
