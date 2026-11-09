# Builds the Josi Client installer: the app alone, for connecting to a server that
# runs somewhere else. Build-Release.ps1 calls this after the server installer.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\Build-ClientInstaller.ps1 -Version 1.1.0 -Output <folder> [-Sign]
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$Output,
  [switch]$Sign,
  [string]$SigningConfig = ''
)
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$project = Join-Path $repo 'apps\windows-native\Josi.Windows.csproj'
$compiler = Join-Path $base 'tools\inno-7.1.0\ISCC.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw "Inno Setup is missing: $compiler" }
$numeric = ($Version -split '-')[0]
$stage = Join-Path $base ('staging\client-app-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force $stage, $Output

function SignFile([string]$file) {
  if (!$Sign) { return }
  if (!$SigningConfig) { $SigningConfig = Join-Path $repo 'publisher\windows-signing.json' }
  $signing = Get-Content -LiteralPath $SigningConfig -Raw | ConvertFrom-Json
  & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Sign-WindowsArtifacts.ps1') `
    -Endpoint $signing.endpoint -Account $signing.account -Profile $signing.profile -Files $file
  if ($LASTEXITCODE) { throw "Signing failed: $file" }
}

& dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:DebugType=None -p:GenerateDocumentationFile=false -p:JosiEdition=Client "-p:Version=$numeric" "-p:InformationalVersion=$Version" -o $stage -nologo -v q
if ($LASTEXITCODE) { throw 'Josi Client did not build' }
$binary = Join-Path $stage 'Josi.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Josi.exe was not produced' }
SignFile $binary

$icon = Join-Path $stage 'Josi.ico'
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'apps\windows-native\tools\New-Icon.ps1') (Join-Path $repo 'apps\windows-native\assets\icon-512.png') $icon
if ($LASTEXITCODE) { throw 'The icon was not made' }

& $compiler "/DAppVersionText=$Version" "/DNumericVersion=$numeric" "/DSourceExe=$binary" "/DOutputRoot=$Output" "/DAppIcon=$icon" (Join-Path $repo 'packaging\windows\JosiClient.iss')
if ($LASTEXITCODE) { throw 'The Josi Client installer did not compile' }
$installer = Join-Path $Output "Josi-Client-$Version-Windows-x64.exe"
SignFile $installer
"Built $installer ($([Math]::Round((Get-Item -LiteralPath $installer).Length / 1MB, 1)) MB)"
