# Builds a Josi CE for Windows release from this checkout: one signed installer
# (server + app, every component embedded), its checksum file, and optionally a
# draft GitHub release. Every step is one of the existing build scripts; this
# file only runs them in order and signs what must be signed between them.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\Build-Release.ps1 -Version 1.0.0
#   ... -Sign      signs Josi.exe, JosiLauncher.exe and the installer with Azure Trusted
#                  Signing (publisher\windows-signing.json names the endpoint, account and
#                  certificate profile; the Azure sign-in is the publisher's, done beforehand
#                  with "az login"; nothing secret is stored or read by this script)
#   ... -Publish   creates a DRAFT GitHub release v<Version> with the installer and
#                  SHA256SUMS.txt through the gh CLI (the publisher reviews and publishes it)
#   ... -SkipProvision  skip the download/verify of pinned inputs (already done on this PC)
#
# One-time machine preparation this script does not do:
#   - Install Git, Node.js 24, the .NET SDK (8 or 10 with the 8 desktop runtime), Visual Studio
#     Build Tools with the Windows 10 SDK (signtool), the Azure CLI and the gh CLI.
#   - Prepare the private Python with the voice packages: scripts\windows\Prepare-VoiceSpike.ps1
#     (it pins everything it downloads). Its result lives in artifacts\windows-native\tools\python-3.12.15.
#   - Have the pinned subscription CLIs in a node_modules folder (-CliRoot): the dev server's
#     C:\Dev\josi-dev\cli after "npm ci" there.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Version,
  [string]$CliRoot = 'C:\Dev\josi-dev\cli\node_modules',
  [switch]$Sign,
  [string]$SigningConfig = '',
  [switch]$Publish,
  [switch]$SkipProvision
)
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$') { throw 'Version must look like 1.0.0 or 1.0.0-rc.1' }
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$scripts = $PSScriptRoot
$node = Join-Path $base 'tools\node-v24.21.0-win-x64\node.exe'
$python = Join-Path $base 'tools\python-3.12.15\python\python.exe'
$osPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($folder in 'cache', 'tools', 'evidence', 'staging', 'sources\winsw', 'installers', 'releases') { $null = New-Item -ItemType Directory -Force (Join-Path $base $folder) }
function Step([string]$text) { Write-Host ''; Write-Host ('== ' + $text) -ForegroundColor Cyan }
function Run([string]$label, [scriptblock]$block) { & $block; if ($LASTEXITCODE) { throw "$label failed" } }
# The build scripts clear PSModulePath and set environment for their own run,
# so each one gets its own PowerShell process.
function Script([string]$name, [string[]]$arguments = @()) {
  & $osPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $scripts $name) @arguments
  if ($LASTEXITCODE) { throw "$name failed" }
}
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Fetch([string]$url, [string]$target, [long]$size, [string]$sha) {
  if (!(Test-Path -LiteralPath $target)) {
    & curl.exe -sL --retry 3 -o ($target + '.partial') $url
    if ($LASTEXITCODE) { throw "Download failed: $url" }
    Move-Item -LiteralPath ($target + '.partial') -Destination $target
  }
  if ((Get-Item -LiteralPath $target).Length -ne $size -or (Sha $target) -cne $sha) { throw "Pinned download does not match: $target" }
}
function Evidence([string]$name) { Get-Content -LiteralPath (Join-Path $base "evidence\$name.json") -Raw | ConvertFrom-Json }

if (!$SkipProvision) {
  Step 'Pinned inputs'
  foreach ($component in 'caddy', 'inno-setup', 'winsw') { Script 'Get-UpstreamSpikes.ps1' @('-Component', $component) | Out-Null }
  Fetch 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip' (Join-Path $base 'cache\node-v24.21.0-win-x64.zip') 37618919 '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
  if (!(Test-Path $node)) { Expand-Archive -LiteralPath (Join-Path $base 'cache\node-v24.21.0-win-x64.zip') -DestinationPath (Join-Path $base 'tools') -Force }
  $upstream = Get-Content (Join-Path $repo 'packaging\windows\upstream-lock.json') -Raw | ConvertFrom-Json
  $pg = $upstream.components | Where-Object id -eq 'postgresql'
  Fetch $pg.url (Join-Path $base ('cache\' + $pg.asset)) $pg.size $pg.sha256
  Fetch 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-pc-windows-msvc-install_only.tar.gz' (Join-Path $base 'cache\cpython-3.12.15-20261003-windows-x64.tar.gz') 46509797 '4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08'
  $ffmpeg = Get-Content (Join-Path $repo 'packaging\windows\ffmpeg.lock.json') -Raw | ConvertFrom-Json
  Fetch $ffmpeg.url (Join-Path $base 'cache\ffmpeg-9.0.2.zip') $ffmpeg.size $ffmpeg.sha256
  if (!(Test-Path (Join-Path $base 'tools\inno-7.1.0\ISCC.exe'))) {
    $p = Start-Process (Join-Path $base 'cache\innosetup-7.1.0-x64.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/CURRENTUSER', '/NORESTART', ('/DIR=' + (Join-Path $base 'tools\inno-7.1.0')) -Wait -PassThru
    if ($p.ExitCode) { throw 'Inno Setup did not install into the tools folder' }
  }
  # The MSVC redistributable DLLs the private runtimes carry (pinned in msvc-supplement.lock.json).
  $msvc = Get-Content (Join-Path $scripts 'msvc-supplement.lock.json') -Raw | ConvertFrom-Json
  $redist = $msvc.packages | Where-Object id -eq 'Microsoft.VC.14.50.18.0.CRT.Redist.X64.base'
  $vsix = Join-Path $base ('cache\msvc-supplement\' + $redist.id + '.vsix'); $null = New-Item -ItemType Directory -Force (Split-Path $vsix)
  Fetch $redist.url $vsix $redist.size $redist.sha256
  $unpacked = Join-Path $base ('tools\msvc-supplement\' + $redist.id)
  if (!(Test-Path $unpacked)) { Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($vsix, $unpacked) }
  # Voice models, pinned per file in services\voice-box\models.lock.json.
  if (!(Test-Path $python)) { throw "The private Python is missing. Run scripts\windows\Prepare-VoiceSpike.ps1 once (it prepares $python with the voice packages)." }
  if (!(Test-Path (Join-Path $base 'cache\voice-models\base.en\model.bin'))) { Run 'voice models' { & $python -I (Join-Path $repo 'services\voice-box\download_models.py') (Join-Path $base 'cache\voice-models') } }
  # Josi's service host: upstream WinSW at a pinned commit plus the reviewed one-line patch.
  $hostLock = Get-Content (Join-Path $repo 'packaging\windows\service-host.lock.json') -Raw | ConvertFrom-Json
  $hostBinary = Join-Path $base ('cache\' + $hostLock.asset)
  if (!(Test-Path $hostBinary) -or (Sha $hostBinary) -cne $hostLock.sha256) {
    $source = Join-Path $base ('sources\winsw\winsw-' + $hostLock.upstreamCommit + '.zip')
    if (!(Test-Path $source)) { & curl.exe -sL --retry 3 -o $source ('https://github.com/winsw/winsw/archive/' + $hostLock.upstreamCommit + '.zip'); if ($LASTEXITCODE) { throw 'WinSW source download failed' } }
    if ((Sha $source) -cne $hostLock.sourceArchiveSha256) { throw 'WinSW source archive does not match service-host.lock.json' }
    Script 'Build-ServiceHost.ps1' | Out-Null
    $built = Evidence 'service-host-build'
    if ($built.sha256 -cne $hostLock.sha256 -or $built.size -ne $hostLock.size) { throw "The service host built here (sha256 $($built.sha256)) differs from service-host.lock.json; review the build before updating the lock." }
    Copy-Item -LiteralPath $built.binary -Destination $hostBinary -Force
  }
}

Step 'Setup bridge, launcher and app'
Script 'Build-NativeSetupHelper.ps1' | Out-Null
$helperFile = Join-Path $base 'evidence\native-setup-helper.json'; $helper = Get-Content $helperFile -Raw | ConvertFrom-Json
$probeFile = Join-Path $env:TEMP ('josi-probe-' + [Guid]::NewGuid().ToString('N')); Set-Content $probeFile 'x'
$probe = & $osPowerShell -NoProfile -NonInteractive -Command "Add-Type -Path '$($helper.binary)'; [Josi.NativeSetup.FileAttributes]::IsSingleRegularFile('$probeFile')"
Remove-Item $probeFile
if ("$probe" -ne 'True') { throw 'The precompiled setup bridge did not load in Windows PowerShell 5.1' }
$helper.testedInOsPowerShell = $true; $helper | ConvertTo-Json | Set-Content $helperFile -Encoding UTF8
Script 'Build-OnboardingLauncher.ps1' | Out-Null
Script 'Build-NativeApp.ps1' | Out-Null

$signing = $null
if ($Sign) {
  if (!$SigningConfig) { $SigningConfig = Join-Path $repo 'publisher\windows-signing.json' }
  $signing = Get-Content -LiteralPath $SigningConfig -Raw | ConvertFrom-Json
  foreach ($key in 'endpoint', 'account', 'profile') { if (!$signing.$key) { throw "$SigningConfig needs '$key'" } }
}
function SignFiles([string[]]$files) {
  foreach ($file in $files) { Script 'Sign-WindowsArtifacts.ps1' @('-Endpoint', $signing.endpoint, '-Account', $signing.account, '-Profile', $signing.profile, '-Files', $file) }
}
if ($Sign) {
  Step 'Signing the app and the launcher'
  # The kit builder re-verifies these by hash, so the evidence is updated to the signed bytes.
  foreach ($name in 'native-app', 'onboarding-launcher') {
    $file = Join-Path $base "evidence\$name.json"; $record = Get-Content $file -Raw | ConvertFrom-Json
    SignFiles @($record.binary)
    $record.size = (Get-Item -LiteralPath $record.binary).Length; $record.sha256 = Sha $record.binary
    if ($record.PSObject.Properties['signed']) { $record.signed = $true } else { $record | Add-Member -NotePropertyName signed -NotePropertyValue $true }
    $record | ConvertTo-Json | Set-Content $file -Encoding UTF8
  }
}

Step 'Installer kit'
Script 'Build-InstallerKit.ps1' | Out-Null

Step "Application payload $Version (isolated source snapshot; several minutes)"
Run 'application' { & $node (Join-Path $scripts 'Build-Application.mjs') $Version | Out-Null }

Step 'Runtime payload (Node, Python with the voice packages, PostgreSQL, Caddy, voice models)'
Run 'runtimes' { & $python -I (Join-Path $scripts 'build_runtimes.py') | Out-Null }

Step 'Component archives and release manifest'
Run 'payloads' { & $node (Join-Path $scripts 'Build-ReleasePayloads.mjs') --cli-root $CliRoot | Out-Null }

Step 'Installer'
Script 'Build-Installer.ps1' | Out-Null
$installer = Evidence 'installer'
if ($Sign) {
  Step 'Signing the installer'
  SignFiles @($installer.path)
  $installer.size = (Get-Item -LiteralPath $installer.path).Length; $installer.sha256 = Sha $installer.path; $installer.signed = $true
  $installer | ConvertTo-Json | Set-Content (Join-Path $base 'evidence\installer.json') -Encoding UTF8
}

Step 'Release folder'
$release = Join-Path $base ('releases\' + $Version)
if (Test-Path $release) { Remove-Item $release -Recurse -Force }
$null = New-Item -ItemType Directory -Force $release
Copy-Item -LiteralPath $installer.path -Destination $release
$exeName = Split-Path $installer.path -Leaf
Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Value ((Sha (Join-Path $release $exeName)) + '  ' + $exeName) -Encoding ascii
$notes = @("Josi CE $Version for Windows.", '',
  "Download $exeName, run it, and Josi opens when it is done. Windows 10 or 11, 64-bit, about 4 GB of disk.", '',
  'Check the file: its SHA-256 is in SHA256SUMS.txt, and the signer shown under Properties > Digital Signatures is SOCAL RECEPTIONIST LLC.' + $(if (!$Sign) { ' (This build is NOT signed.)' } else { '' }), '',
  'Source and help: https://github.com/vaxman14/josi-ce and https://get.heyjosi.com')
Set-Content -LiteralPath (Join-Path $release 'RELEASE-NOTES.md') -Value ($notes -join "`n") -Encoding UTF8
Write-Host ("Installer: {0} ({1} MB, sha256 {2}, signed: {3})" -f (Join-Path $release $exeName), [Math]::Round($installer.size / 1MB), $installer.sha256, $Sign.IsPresent)

if ($Publish) {
  Step "Draft GitHub release v$Version"
  & gh release create ("v$Version") --repo vaxman14/josi-ce --draft --title ("Josi CE $Version") --notes-file (Join-Path $release 'RELEASE-NOTES.md') (Join-Path $release $exeName) (Join-Path $release 'SHA256SUMS.txt')
  if ($LASTEXITCODE) { throw 'gh release create failed' }
  Write-Host 'Draft release created. Review it on GitHub and press Publish when the Mac and Linux files are attached too.'
}
