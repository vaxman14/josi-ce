# Opens the Windows Josi app against the development server. The app is
# started through WMI so it never belongs to the terminal or tool session that
# ran this script, and keeps running when that session ends.
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-dev')
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$app = Join-Path $repo 'apps\windows-native\bin\Release\net8.0-windows10.0.19041.0\Josi.exe'
if (!(Test-Path $app)) { throw "Build the app first: dotnet build $(Join-Path $repo 'apps\windows-native') -c Release" }
$data = Join-Path $Root 'data'
$command = '"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') + '" /d /c set "JOSI_SERVER_DATA=' + $data + '" && start "" "' + $app + '"'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command; CurrentDirectory = (Split-Path $app); ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0) { throw "Windows could not open Josi (code $($result.ReturnValue))" }
