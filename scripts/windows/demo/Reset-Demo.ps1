# Restores the seeded demo state between takes without restarting anything:
# clears the demo account's conversations, folders, memories, approvals and
# PC Control state in the demo database, then seeds them again from seed.json.
# The app, if open in demo mode, picks the new state up on its next refresh
# (or use `Josi.exe --demo-reset`, which runs this and reloads the app).
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-demo')
$ErrorActionPreference = 'Stop'
if (!(Test-Path (Join-Path $Root 'demo.json'))) { throw "No demo server in $Root. Run New-DemoServer.ps1 and Start-DemoServer.ps1 first." }
& (Get-Command node).Source (Join-Path $PSScriptRoot 'seed-demo.mjs') $Root --reset
if ($LASTEXITCODE) { throw 'the demo reset did not finish' }
