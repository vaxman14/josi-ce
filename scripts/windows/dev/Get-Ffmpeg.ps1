# Downloads the pinned ffmpeg (packaging/windows/ffmpeg.lock.json) for the
# development server, verifies the archive's size and SHA-256 against the
# lock, and keeps only ffmpeg.exe, ffprobe.exe and the licence under
# <Root>\ffmpeg. Start-DevServer.ps1 points the server at them.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\dev\Get-Ffmpeg.ps1
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-dev')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$lock = Get-Content -Raw (Join-Path $repo 'packaging\windows\ffmpeg.lock.json') | ConvertFrom-Json
$target = Join-Path $Root 'ffmpeg'
$cache = Join-Path $Root 'cache'
$null = New-Item -ItemType Directory -Force $cache
$archive = Join-Path $cache ("ffmpeg-" + $lock.version + '.zip')
function Test-Archive { (Test-Path -LiteralPath $archive) -and (Get-Item -LiteralPath $archive).Length -eq $lock.size -and (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $lock.sha256 }
if (!(Test-Archive)) {
  $partial = $archive + '.partial'
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri $lock.url -OutFile $partial
  Move-Item -Force -LiteralPath $partial -Destination $archive
  if (!(Test-Archive)) { Remove-Item -LiteralPath $archive -Force; throw 'The downloaded ffmpeg archive does not match the pinned size and SHA-256.' }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }
  $null = New-Item -ItemType Directory -Force $target
  foreach ($wanted in $lock.files) {
    $entry = $zip.Entries | Where-Object { $_.FullName -match ('^[^/]+/' + [regex]::Escape($wanted) + '$') } | Select-Object -First 1
    if (!$entry) { throw "The pinned archive has no $wanted" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $target (Split-Path $wanted -Leaf)), $true)
  }
} finally { $zip.Dispose() }
$version = & (Join-Path $target 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1
"Pinned ffmpeg ready in ${target}: $version"
