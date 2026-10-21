# Builds the native Windows app (apps/windows-native) as one self-contained
# x64 executable for the installer kit, and records its hash as evidence the
# kit builder verifies. Local developer build only; nothing is published.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\Build-NativeApp.ps1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$project = Join-Path $repo 'apps\windows-native\Josi.Windows.csproj'
$base = Join-Path $repo 'artifacts\windows-native'
$out = Join-Path $base ('staging\native-app-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force $out, (Join-Path $base 'evidence')

& dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:DebugType=None -p:GenerateDocumentationFile=false -o $out -nologo -v q
if ($LASTEXITCODE) { throw 'The native app did not build' }
$binary = Join-Path $out 'Josi.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Josi.exe was not produced' }
$extra = @(Get-ChildItem -LiteralPath $out -File | Where-Object { $_.Name -ne 'Josi.exe' })
if ($extra.Count) { throw ('The single-file build left extra files: ' + (($extra | ForEach-Object Name) -join ', ')) }

$commit = (& git -C $repo rev-parse HEAD).Trim()
$dirty = [bool](& git -C $repo status --porcelain -- apps/windows-native)
$report = [ordered]@{
  passed = $true; binary = $binary; size = (Get-Item -LiteralPath $binary).Length
  sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
  architecture = 'x64'; framework = 'net8.0-windows10.0.19041.0'; selfContained = $true
  sourceCommit = $commit; sourceClean = -not $dirty; signed = $false
}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\native-app.json') -Encoding UTF8
"Built $binary ($([Math]::Round($report.size / 1MB, 1)) MB, sha256 $($report.sha256))."
