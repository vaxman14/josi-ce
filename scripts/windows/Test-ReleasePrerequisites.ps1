# Read-only checks of the tools and pinned inputs needed by Build-Release.ps1.
# Writes a nonsensitive report beneath this checkout; never installs or signs.
[CmdletBinding()]
param([switch]$CheckSigning)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$checks = [System.Collections.Generic.List[object]]::new()
function Check([string]$Name, [bool]$Passed, [string]$Detail) {
  $checks.Add([ordered]@{ name = $Name; passed = $Passed; detail = $Detail })
  $label = if ($Passed) { 'PASS ' } else { 'FAIL ' }
  Write-Host ($label + $Name + ': ' + $Detail)
}
function RequiredFile([string]$Name, [string]$Path) { Check $Name (Test-Path -LiteralPath $Path -PathType Leaf) $Path }
function PinnedFile([string]$Name, [string]$Path, [long]$Size, [string]$Sha256) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { Check $Name $false ('Missing: ' + $Path); return }
  $matched = (Get-Item -LiteralPath $Path).Length -eq $Size
  if ($matched) { $matched = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $Sha256 }
  Check $Name $matched $(if ($matched) { 'Size and SHA-256 match the lock.' } else { 'Size or SHA-256 differs from the lock.' })
}
foreach ($name in 'git', 'dotnet', 'node') {
  $tool = Get-Command $name -ErrorAction SilentlyContinue
  Check $name ($null -ne $tool) $(if ($tool) { $tool.Source } else { 'Not installed.' })
}
RequiredFile 'Pinned Node runtime' (Join-Path $base 'tools\node-v24.21.0-win-x64\node.exe')
RequiredFile 'Private Python runtime' (Join-Path $base 'tools\python-3.12.15\python\python.exe')
RequiredFile 'Inno Setup compiler' (Join-Path $base 'tools\inno-7.1.0\ISCC.exe')
RequiredFile 'TypeScript dependencies' (Join-Path $repo 'node_modules\typescript\lib\tsc.js')
RequiredFile 'Voice model' (Join-Path $base 'cache\voice-models\base.en\model.bin')
$cli = Join-Path $base 'tools\subscription-cli\node_modules'
$cliLock = Get-Content -LiteralPath (Join-Path $repo 'packaging\windows\subscription-cli.lock.json') -Raw | ConvertFrom-Json
$codex = $cliLock | Where-Object id -eq 'codex-win32-x64'
$claude = $cliLock | Where-Object id -eq 'claude-win32-x64'
PinnedFile 'Bundled Codex CLI' (Join-Path $cli '@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe') $codex.binarySize $codex.binarySha256
PinnedFile 'Bundled Claude CLI' (Join-Path $cli '@anthropic-ai\claude-code-win32-x64\claude.exe') $claude.binarySize $claude.binarySha256
$ffmpeg = Get-Content -LiteralPath (Join-Path $repo 'packaging\windows\ffmpeg.lock.json') -Raw | ConvertFrom-Json
PinnedFile 'FFmpeg archive' (Join-Path $base 'cache\ffmpeg-9.0.2.zip') $ffmpeg.size $ffmpeg.sha256
$hostLock = Get-Content -LiteralPath (Join-Path $repo 'packaging\windows\service-host.lock.json') -Raw | ConvertFrom-Json
PinnedFile 'Service host' (Join-Path $base ('cache\' + $hostLock.asset)) $hostLock.size $hostLock.sha256
$upstream = Get-Content -LiteralPath (Join-Path $repo 'packaging\windows\upstream-lock.json') -Raw | ConvertFrom-Json
$postgres = $upstream.components | Where-Object id -eq 'postgresql'
PinnedFile 'PostgreSQL archive' (Join-Path $base ('cache\' + $postgres.asset)) $postgres.size $postgres.sha256
if ($CheckSigning) {
  $signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
  Check 'Windows SDK signing tool' ($null -ne $signTool) $(if ($signTool) { $signTool.FullName } else { 'signtool.exe is missing.' })
  $dlib = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\MicrosoftTrustedSigningClientTools\Azure.CodeSigning.Dlib.dll", "$env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools\Azure.CodeSigning.Dlib.dll", "$env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools\*\Azure.CodeSigning.Dlib.dll", "$env:LOCALAPPDATA\Microsoft\MicrosoftTrustedSigningClientTools\*\Azure.CodeSigning.Dlib.dll", "$env:USERPROFILE\.nuget\packages\microsoft.trusted.signing.client\*\bin\x64\Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  Check 'Artifact Signing client' ($null -ne $dlib) $(if ($dlib) { $dlib.FullName } else { 'Azure.CodeSigning.Dlib.dll is missing.' })
  $configPath = Join-Path $repo 'publisher\windows-signing.json'
  if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Check 'Signing configuration' ([bool]($config.endpoint -and $config.account -and $config.profile)) 'Endpoint, account and certificate profile must be configured.'
  } else { Check 'Signing configuration' $false 'publisher\windows-signing.json is missing.' }
  $azure = Get-Command az -ErrorAction SilentlyContinue
  if ($azure) {
    $accountState = & $azure.Source account show --query state --output tsv 2>$null
    Check 'Azure sign-in' ($LASTEXITCODE -eq 0 -and "$accountState".Trim() -eq 'Enabled') 'Checks account availability only; signing is verified when an artifact is signed.'
  } else { Check 'Azure sign-in' $false 'Azure CLI is missing.' }
}
$passed = @($checks | Where-Object { !$_.passed }).Count -eq 0
$evidence = Join-Path $base 'evidence'
$null = New-Item -ItemType Directory -Force -Path $evidence
$report = [ordered]@{ checkedAt = [DateTime]::UtcNow.ToString('o'); repository = $repo; passed = $passed; signingChecked = $CheckSigning.IsPresent; checks = $checks.ToArray() }
[System.IO.File]::WriteAllText((Join-Path $evidence 'release-prerequisites.json'), ($report | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
if (!$passed) { throw 'Release prerequisites are incomplete. See artifacts\windows-native\evidence\release-prerequisites.json.' }
