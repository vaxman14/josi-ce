# Compiles the public Josi CE Windows installer (packaging\windows\JosiCE.iss)
# from the verified installer kit and the release payloads. One EXE carries
# everything; nothing is downloaded at install time.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\Build-Installer.ps1
# Inputs: artifacts\windows-native\evidence\installer-kit.json (Build-InstallerKit.ps1)
#         artifacts\windows-native\evidence\release-assets.json (Build-ReleasePayloads.mjs)
# Output: artifacts\windows-native\installers\<id>\Josi-CE-<version>-Windows-x64.exe
#         and evidence\installer.json
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; $env:PSModulePath = ''
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$kit = Get-Content (Join-Path $base 'evidence\installer-kit.json') -Raw | ConvertFrom-Json
$assets = Get-Content (Join-Path $base 'evidence\release-assets.json') -Raw | ConvertFrom-Json
if (!$kit.passed -or !$assets.archivesVerified -or !$assets.installable) { throw 'A verified installer kit and verified release payloads are required' }
$null = & (Join-Path $kit.root 'Initialize-NativeSetup.ps1') -Root $kit.root -ExpectedKitHash $kit.kitSha256
$manifest = Join-Path $assets.output 'release-manifest.json'
$decoded = Read-NativeManifest $manifest $assets.manifestSha256 $assets.candidate
foreach ($component in $decoded.components) {
  if (!(Test-NativePayload $component (Join-Path $assets.output $component.asset))) { throw "Payload changed: $($component.asset)" }
}
$compiler = Join-Path $base 'tools\inno-7.1.0\ISCC.exe'
if ((Get-AuthenticodeSignature $compiler).Status -ne 'Valid') { throw 'The Inno Setup compiler is not the signed one from packaging\windows\upstream-lock.json' }
$output = Join-Path $base ('installers\' + $assets.candidate + '-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($output)
# Windows file versions have four numeric parts: 1.0.0 -> 1.0.0.0, 1.0.0-rc.2 -> 1.0.0.2.
$numeric = if ($assets.candidate -match '^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.?(\d+))?$') {
  '{0}.{1}.{2}.{3}' -f $Matches[1], $Matches[2], $Matches[3], ($(if ($Matches[4]) { $Matches[4] } else { '0' }))
} else { throw 'The version must look like 1.0.0 or 1.0.0-rc.2' }
# The app project derives obj\Josi.ico from assets\icon-512.png on every build.
$icon = Join-Path $repo 'apps\windows-native\obj\Josi.ico'
if (!(Test-Path $icon)) { throw "App icon missing (build apps\windows-native first): $icon" }
& $compiler '/Q' ('/DKitRoot=' + $kit.root) ('/DReleaseRoot=' + $assets.output) ('/DKitHash=' + $kit.kitSha256) ('/DManifestHash=' + $assets.manifestSha256) `
  ('/DCandidateVersion=' + $assets.candidate) ('/DNumericVersion=' + $numeric) ('/DOutputRoot=' + $output) ('/DAppIcon=' + $icon) (Join-Path $repo 'packaging\windows\JosiCE.iss')
if ($LASTEXITCODE) { throw 'The installer did not compile' }
$exe = Join-Path $output ('Josi-CE-' + $assets.candidate + '-Windows-x64.exe')
if (!(Test-Path -LiteralPath $exe)) { throw 'The compiler produced no installer' }
$report = [ordered]@{ built = $true; path = $exe; size = (Get-Item $exe).Length; sha256 = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  candidate = $assets.candidate; kitSha256 = $kit.kitSha256; manifestSha256 = $assets.manifestSha256; payloads = $assets.output; signed = $false }
$report | ConvertTo-Json | Set-Content (Join-Path $base 'evidence\installer.json') -Encoding UTF8
"Built $exe ($([Math]::Round($report.size / 1MB)) MB, sha256 $($report.sha256))"
