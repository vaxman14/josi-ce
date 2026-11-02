# Puts a fresh demo root (New-DemoServer.ps1 -Fresh) back to "not set up":
# stops its API, worker and database, deletes its data folder and creates the
# server again from nothing, exactly as New-DemoServer.ps1 made it, then starts
# it. About half a minute. The seeded demo root and the shared sidecars (replay
# model, mail sink) are not touched.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\demo\Reset-FreshDemo.ps1
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-fresh')
$ErrorActionPreference = 'Stop'
$demoFile = Join-Path $Root 'demo.json'
if (!(Test-Path $demoFile)) { throw "No demo server in $Root. Run New-DemoServer.ps1 -Fresh first." }
$demo = Get-Content -Raw $demoFile | ConvertFrom-Json
if (!($demo.PSObject.Properties['fresh'] -and $demo.fresh)) { throw "$Root is not a fresh demo root; Reset-Demo.ps1 resets the seeded demo." }
$tools = if ($demo.PSObject.Properties['tools'] -and $demo.tools) { $demo.tools } else { 'C:\Dev\josi-dev' }
$data = Join-Path $Root 'data'
$dev = Join-Path (Split-Path $PSScriptRoot -Parent) 'dev'
if (Test-Path (Join-Path $data 'config\runtime.json')) {
    & (Join-Path $dev 'Stop-DevServer.ps1') -Root $Root -Tools $tools
}
# Everything the server made lives under data: database, secrets, the setup
# token, uploads, logs. Removed whole; the sidecars' pid files are per root
# and this root never owns a shared sidecar after a reset.
if (Test-Path $data) { Remove-Item -LiteralPath $data -Recurse -Force }
& (Join-Path $dev 'New-DevServer.ps1') -Root $Root -Tools $tools -DatabasePort ([int]$demo.databasePort) -ApiPort ([int]$demo.apiPort)
& (Join-Path $PSScriptRoot 'Start-DemoServer.ps1') -Root $Root
Write-Host "Fresh demo reset: $($demo.address) is not set up again."
