# Creates the demo server: a second development Josi CE server in its own
# folder with its own database, on its own ports, that shares the development
# server's pinned tools (PostgreSQL, CLIs, Python, ffmpeg) without touching the
# development server's data. One-time.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\demo\New-DemoServer.ps1
#
# -Fresh creates a demo root that is never seeded: its server stays "not set
# up", so first-run setup itself can be recorded (AUTOMATION.md). Reset it
# with Reset-FreshDemo.ps1, which recreates it from nothing.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\demo\New-DemoServer.ps1 -Fresh
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Tools = 'C:\Dev\josi-dev',
    [int]$DatabasePort = 0,
    [int]$ApiPort = 0,
    [int]$ModelPort = 18090,
    [int]$MailPort = 2525,
    [switch]$Fresh
)
$ErrorActionPreference = 'Stop'
if (!$Root) { $Root = if ($Fresh) { 'C:\Dev\josi-fresh' } else { 'C:\Dev\josi-demo' } }
if (!$DatabasePort) { $DatabasePort = if ($Fresh) { 15434 } else { 15433 } }
if (!$ApiPort) { $ApiPort = if ($Fresh) { 8091 } else { 8090 } }
if ($Root.TrimEnd('\') -ieq $Tools.TrimEnd('\')) { throw 'The demo root must be a different folder from the development server.' }
$dev = Join-Path (Split-Path $PSScriptRoot -Parent) 'dev'
& (Join-Path $dev 'New-DevServer.ps1') -Root $Root -Tools $Tools -DatabasePort $DatabasePort -ApiPort $ApiPort
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$demo = [ordered]@{ version = 1; root = $Root; dataDir = (Join-Path $Root 'data'); tools = $Tools; apiPort = $ApiPort; databasePort = $DatabasePort
    address = "http://localhost:$ApiPort"; modelPort = $ModelPort; mailPort = $MailPort; repo = $repo; node = (Get-Command node).Source }
if ($Fresh) { $demo.fresh = $true }
[IO.File]::WriteAllText((Join-Path $Root 'demo.json'), ($demo | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
if ($Fresh) { Write-Host "Fresh demo server created in $Root (API $ApiPort, database $DatabasePort), not set up. Next: Start-DemoServer.ps1 -Root $Root." }
else { Write-Host "Demo server created in $Root (API $ApiPort, database $DatabasePort). Next: Start-DemoServer.ps1 (it seeds the demo on first start)." }
