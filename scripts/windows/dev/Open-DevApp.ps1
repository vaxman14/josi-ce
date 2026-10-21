# Opens the Windows Josi app against the development server.
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-dev')
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$app = Join-Path $repo 'apps\windows-native\bin\Release\net8.0-windows10.0.19041.0\Josi.exe'
if (!(Test-Path $app)) { throw "Build the app first: dotnet build $(Join-Path $repo 'apps\windows-native') -c Release" }
$env:JOSI_SERVER_DATA = Join-Path $Root 'data'
Start-Process $app
