# Stops the demo server (API, worker, PostgreSQL) and the replay model. The
# demo data is kept; Start-DemoServer.ps1 brings it back as it was.
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-demo')
$ErrorActionPreference = 'Stop'
$demoFile = Join-Path $Root 'demo.json'
if (!(Test-Path $demoFile)) { throw "No demo server in $Root." }
$demo = Get-Content -Raw $demoFile | ConvertFrom-Json
$tools = if ($demo.PSObject.Properties['tools'] -and $demo.tools) { $demo.tools } else { 'C:\Dev\josi-dev' }
$data = Join-Path $Root 'data'
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'dev\Stop-DevServer.ps1') -Root $Root -Tools $tools
$pidFile = Join-Path $data 'state\model.pid'
if (Test-Path $pidFile) {
    $id = [int](Get-Content $pidFile)
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -in 'cmd', 'node') { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $id /T /F | Out-Null; Write-Host 'replay model stopped' }
    Remove-Item $pidFile
}
