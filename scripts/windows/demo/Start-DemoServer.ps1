# Starts the demo server: the replay model (canned replies) and the mail sink,
# then the demo Josi CE server (PostgreSQL, API and worker) in the demo root.
# On the first start it also seeds the demo workspace. Safe to run while the
# development server is up: different folder, different ports.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\demo\Start-DemoServer.ps1
#
# A fresh root (New-DemoServer.ps1 -Fresh) is never seeded; its server stays
# at first-run setup. The replay model and the mail sink are shared by every
# demo root: whichever starts first owns them.
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
function Setting([string]$Name, $Default) { if ($demo.PSObject.Properties[$Name] -and $demo.$Name) { $demo.$Name } else { $Default } }
$tools = Setting 'tools' 'C:\Dev\josi-dev'
$modelPort = [int](Setting 'modelPort' 18090)
$mailPort = [int](Setting 'mailPort' 2525)
$fresh = [bool](Setting 'fresh' $false)
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
function Test-Port([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $Port); return $true } catch { return $false } finally { $client.Dispose() }
}
# A sidecar: a small Node server beside the demo (the replay model, the mail
# sink). Started hidden and independent of this session, with a pid file in
# this root's state folder; skipped when another root already answers on its port.
function Start-Sidecar([string]$Name, [string]$Script, [int]$Port, [string[]]$Arguments, [hashtable]$Environment) {
    $pidFile = Join-Path $data "state\$Name.pid"
    $running = (Test-Path $pidFile) -and (Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue)
    if ($running) { Write-Host "$Name already running"; return }
    if (Test-Port $Port) { Write-Host "$Name already answering on port $Port (another demo root started it)"; return }
    $launcher = Join-Path $data "state\run-$Name.cmd"
    # One statement per line: inside @( ) PowerShell would split a + chain into separate elements.
    $lines = @('@echo off')
    foreach ($pair in $Environment.GetEnumerator()) { $lines += 'set "' + $pair.Key + '=' + $pair.Value + '"' }
    $quoted = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $lines += '"' + $node + '" "' + (Join-Path $PSScriptRoot $Script) + '" ' + $quoted + ' 1>>"' + (Join-Path $data "logs\$Name.out.log") + '" 2>>"' + (Join-Path $data "logs\$Name.err.log") + '"'
    [IO.File]::WriteAllLines($launcher, $lines, [Text.Encoding]::ASCII)
    $id = Start-Independent ('"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') + '" /d /c "' + $launcher + '"') $PSScriptRoot
    Set-Content -Path $pidFile -Value $id
    Write-Host "$Name started (pid $id) on port $Port"
}

# The replay model: answers from replay.json beside this script.
Start-Sidecar 'model' 'replay-model.mjs' $modelPort @([string]$modelPort, (Join-Path $PSScriptRoot 'replay.json')) @{ JOSI_DEMO_MODEL_LOG = (Join-Path $data 'logs\model.log') }
# The mail sink: every email the demo server sends lands as a .eml file in the
# seeded demo's Files folder, where Josi can show it.
$mailRoot = if ($fresh) { 'C:\Dev\josi-demo' } else { $Root }
$mailDir = Join-Path $mailRoot 'sample-files\mail'
Start-Sidecar 'mail' 'mail-sink.mjs' $mailPort @([string]$mailPort, $mailDir) @{ JOSI_DEMO_MAIL_LOG = (Join-Path $data 'logs\mail.log') }

& (Join-Path (Split-Path $PSScriptRoot -Parent) 'dev\Start-DevServer.ps1') -Root $Root -Tools $tools

if ($fresh) {
    Write-Host "Josi fresh demo server: $($demo.address), not set up. Open the app with Josi.exe --demo-fresh --demo-root $Root; reset with Reset-FreshDemo.ps1."
} else {
    $seeded = $demo.PSObject.Properties['seededAt'] -and $demo.seededAt
    if ($Seed -or !$seeded) {
        Write-Host 'seeding the demo workspace…'
        & $node (Join-Path $PSScriptRoot 'seed-demo.mjs') $Root
        if ($LASTEXITCODE) { throw 'seeding did not finish' }
    }
    Write-Host "Josi demo server: $($demo.address). Open the app with Open-DemoApp.ps1; reset between takes with Reset-Demo.ps1."
}
