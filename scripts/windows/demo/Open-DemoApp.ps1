# Opens the Windows Josi app in demo mode against the demo server. The app is
# started through WMI so it never belongs to the terminal or tool session that
# ran this script. Extra arguments are passed to the app, for example:
#   Open-DemoApp.ps1 -Open files
#   Open-DemoApp.ps1 -Thread 2
[CmdletBinding()]
param(
    [string]$Root = 'C:\Dev\josi-demo',
    # A sidebar section to open once signed in (chat, files, models, tasks, …).
    [string]$Open = '',
    # A conversation to open: its id, its 1-based position in the sidebar, or part of its title.
    [string]$Thread = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$app = Join-Path $repo 'apps\windows-native\bin\Release\net8.0-windows10.0.19041.0\Josi.exe'
if (!(Test-Path $app)) { throw "Build the app first: dotnet build $(Join-Path $repo 'apps\windows-native') -c Release" }
if (!(Test-Path (Join-Path $Root 'demo.json'))) { throw "No demo server in $Root. Run New-DemoServer.ps1 and Start-DemoServer.ps1 first." }
$arguments = '--demo'
if ($Open) { $arguments += ' --open ' + $Open }
if ($Thread) { $arguments += ' --thread "' + $Thread + '"' }
$command = '"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') + '" /d /c set "JOSI_DEMO_ROOT=' + $Root + '" && start "" "' + $app + '" ' + $arguments
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command; CurrentDirectory = (Split-Path $app); ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0) { throw "Windows could not open Josi (code $($result.ReturnValue))" }
