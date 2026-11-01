# Starts the demo server: the replay model (canned replies), then the demo
# Josi CE server (PostgreSQL, API and worker) in the demo root. On the first
# start it also seeds the demo workspace. Safe to run while the development
# server is up: different folder, different ports.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\demo\Start-DemoServer.ps1
[CmdletBinding()]
param(
    [string]$Root = 'C:\Dev\josi-demo',
    # Seed (or re-seed) after starting even if the demo was seeded before.
    [switch]$Seed
)
$ErrorActionPreference = 'Stop'
$demoFile = Join-Path $Root 'demo.json'
if (!(Test-Path $demoFile)) { throw "No demo server in $Root. Run New-DemoServer.ps1 first." }
$demo = Get-Content -Raw $demoFile | ConvertFrom-Json
$tools = if ($demo.PSObject.Properties['tools'] -and $demo.tools) { $demo.tools } else { 'C:\Dev\josi-dev' }
$modelPort = if ($demo.PSObject.Properties['modelPort'] -and $demo.modelPort) { [int]$demo.modelPort } else { 18090 }
$data = Join-Path $Root 'data'
$node = (Get-Command node).Source
$null = New-Item -ItemType Directory -Force (Join-Path $data 'state'), (Join-Path $data 'logs')

function Start-Independent([string]$CommandLine, [string]$Directory) {
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $CommandLine; CurrentDirectory = $Directory; ProcessStartupInformation = $startup }
    if ($result.ReturnValue -ne 0) { throw "Windows could not start: $CommandLine (code $($result.ReturnValue))" }
    return $result.ProcessId
}

# The replay model: answers from replay.json beside this script.
$pidFile = Join-Path $data 'state\model.pid'
$running = (Test-Path $pidFile) -and (Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue)
if (!$running) {
    $launcher = Join-Path $data 'state\run-model.cmd'
    # One statement per line: inside @( ) PowerShell would split a + chain into separate elements.
    $lines = @('@echo off')
    $lines += 'set "JOSI_DEMO_MODEL_LOG=' + (Join-Path $data 'logs\model.log') + '"'
    $lines += '"' + $node + '" "' + (Join-Path $PSScriptRoot 'replay-model.mjs') + '" ' + $modelPort + ' "' + (Join-Path $PSScriptRoot 'replay.json') + '" 1>>"' + (Join-Path $data 'logs\model.out.log') + '" 2>>"' + (Join-Path $data 'logs\model.err.log') + '"'
    [IO.File]::WriteAllLines($launcher, $lines, [Text.Encoding]::ASCII)
    $id = Start-Independent ('"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') + '" /d /c "' + $launcher + '"') $PSScriptRoot
    Set-Content -Path $pidFile -Value $id
    Write-Host "replay model started (pid $id) on http://127.0.0.1:$modelPort/v1"
} else { Write-Host 'replay model already running' }

& (Join-Path (Split-Path $PSScriptRoot -Parent) 'dev\Start-DevServer.ps1') -Root $Root -Tools $tools

$seeded = $demo.PSObject.Properties['seededAt'] -and $demo.seededAt
if ($Seed -or !$seeded) {
    Write-Host 'seeding the demo workspace…'
    & $node (Join-Path $PSScriptRoot 'seed-demo.mjs') $Root
    if ($LASTEXITCODE) { throw 'seeding did not finish' }
}
Write-Host "Josi demo server: $($demo.address). Open the app with Open-DemoApp.ps1; reset between takes with Reset-Demo.ps1."
