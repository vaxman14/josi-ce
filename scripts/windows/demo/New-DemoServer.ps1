# Creates the demo server: a second development Josi CE server in its own
# folder with its own database, on its own ports, that shares the development
# server's pinned tools (PostgreSQL, CLIs, Python, ffmpeg) without touching the
# development server's data. One-time.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\demo\New-DemoServer.ps1
[CmdletBinding()]
param(
    [string]$Root = 'C:\Dev\josi-demo',
    [string]$Tools = 'C:\Dev\josi-dev',
    [int]$DatabasePort = 15433,
    [int]$ApiPort = 8090,
    [int]$ModelPort = 18090
)
$ErrorActionPreference = 'Stop'
if ($Root.TrimEnd('\') -ieq $Tools.TrimEnd('\')) { throw 'The demo root must be a different folder from the development server.' }
$dev = Join-Path (Split-Path $PSScriptRoot -Parent) 'dev'
& (Join-Path $dev 'New-DevServer.ps1') -Root $Root -Tools $Tools -DatabasePort $DatabasePort -ApiPort $ApiPort
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$demo = [ordered]@{ version = 1; root = $Root; dataDir = (Join-Path $Root 'data'); tools = $Tools; apiPort = $ApiPort
    address = "http://localhost:$ApiPort"; modelPort = $ModelPort; repo = $repo }
[IO.File]::WriteAllText((Join-Path $Root 'demo.json'), ($demo | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "Demo server created in $Root (API $ApiPort, database $DatabasePort). Next: Start-DemoServer.ps1 (it seeds the demo on first start)."
