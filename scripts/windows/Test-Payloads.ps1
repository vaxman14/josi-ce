# Invoke with the inbox Windows PowerShell 5.1; do not change execution policy.
[CmdletBinding()]
param([switch]$Network, [switch]$Resume)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$env:TEMP = Join-Path $repo 'artifacts\windows-native\cache'
$env:TMP = $env:TEMP
Import-Module (Join-Path $repo 'packaging\windows\Payloads.psm1') -Force
$root = Join-Path $repo ('artifacts\windows-native\test-installations\payloads-' + [guid]::NewGuid().ToString('N'))
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
$null = [IO.Directory]::CreateDirectory($root, $acl)
$path = Join-Path $root 'manifest.json'
$version = '0.0.0-test'
$components = @('josi', 'node', 'python', 'postgresql', 'caddy', 'voice-models') | ForEach-Object {
    [ordered]@{ id=$_; version='1.0.0'; architecture='x64'; asset=($_ + '.zip'); size=1;
        sha256=('a' * 64); license='MIT'; licenseSource='https://example.test/license';
        redistributionEvidence=('licenses/' + $_ + '.txt');
        url=('https://github.com/vaxman14/josi-ce/releases/download/windows-v' + $version + '/' + $_ + '.zip') }
}
$manifest = [ordered]@{ schemaVersion=1; product='Josi CE Server'; version=$version;
    releaseTag=('windows-v' + $version); architecture='x64'; components=@($components) }
function Write-Fixture($Value) {
    [IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (!$rejected) { throw 'Invalid release data was accepted' }
}
$hash = Write-Fixture $manifest
$checked = Read-NativeManifest $path $hash $version
if (@($checked.components).Count -ne 6) { throw 'Release inventory test failed' }
Assert-Rejected { Read-NativeManifest $path ('0' * 64) $version }
Assert-Rejected { Read-NativeManifest $path $hash '1.2.3' }
Assert-Rejected { Read-SignedNativeManifest $path (Join-Path $root 'absent.cat') $hash $version }
$mutations = @(
    { param($m) $m.components = @($m.components | Select-Object -First 5) },
    { param($m) $m.components += $m.components[0] },
    { param($m) $m.components[1].id = 'josi' },
    { param($m) $m.components[0].url = 'https://github.com/vaxman14/josi-ce/releases/latest/download/josi.zip' },
    { param($m) $m.components[0].url = $m.components[0].url.Replace('https:', 'http:') },
    { param($m) $m.components[0].url = $m.components[0].url.Replace('github.com/', 'github.com.evil.test/') },
    { param($m) $m.components[0].asset = '../josi.zip' },
    { param($m) $m.components[0].asset = 'renamed.zip' },
    { param($m) $m.components[0].sha256 = 'unknown' },
    { param($m) $m.components[0].size = 1.5 },
    { param($m) $m.components[0].size = -1 },
    { param($m) $m.components[0].size = $true },
    { param($m) $m.components[0].license = '' },
    { param($m) $m.components[0].architecture = 'arm64' }
)
foreach ($mutation in $mutations) {
    $copy = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    & $mutation $copy
    $badHash = Write-Fixture $copy
    Assert-Rejected { Read-NativeManifest $path $badHash $version }
}
$hash = Write-Fixture $manifest
$cache = Join-Path $root 'cache'
$null = [IO.Directory]::CreateDirectory((Join-Path $cache $hash))
$fixture = Join-Path (Join-Path $cache $hash) 'josi.zip'
[IO.File]::WriteAllBytes($fixture, [byte[]](1,2,3))
$component = [pscustomobject]@{ id='josi'; asset='josi.zip'; size=3;
    sha256=(Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant() }
if ((Get-NativePayload $component $hash $cache '') -ne $fixture) { throw 'Verified cache reuse failed' }
[IO.File]::WriteAllBytes($fixture, [byte[]](3,2,1))
Assert-Rejected { Get-NativePayload $component $hash $cache '' }
$junction = Join-Path $root 'linked-cache'
$null = New-Item -ItemType Junction -Path $junction -Target $cache
Assert-Rejected { Assert-PlainNativePath (Join-Path $junction 'payload.zip') }
$networkVerified = $false
$resumeVerified = $false
if ($Network) {
    # Existing public checksum text, never executed or treated as a runtime.
    # The digest and byte size are published in GitHub's exact release metadata.
    $download = [pscustomobject]@{ id='checksum-test'; asset='SHA256SUMS.txt'; size=697;
        sha256='f00b1ccc9069a7cdab235e85566c02080a8194935993d196a9e553d1194986ca';
        url='https://github.com/vaxman14/josi-ce/releases/download/desktop-v0.6.5/SHA256SUMS.txt' }
    $downloaded = Get-NativePayload $download $hash $cache '' -MaximumSeconds 90
    if (!(Test-NativePayload $download $downloaded)) { throw 'Real GitHub transfer verification failed' }
    if ((Get-NativePayload $download $hash $cache '') -ne $downloaded) { throw 'Downloaded cache reuse failed' }
    $networkVerified = $true
}
if ($Resume) {
    # Transport fixture only: download the existing desktop EXE but never run it.
    $download = [pscustomobject]@{ id='resume-test'; asset='Josi-CE-Setup-0.6.5-Windows-x64.exe'; size=106346056;
        sha256='885b6523d0334b4cea9acfbd81a121f03d1103650d91894b35f6b6e58d05b885';
        url='https://github.com/vaxman14/josi-ce/releases/download/desktop-v0.6.5/Josi-CE-Setup-0.6.5-Windows-x64.exe' }
    $cancel = Join-Path $root 'cancel'
    $script:canceledAt = [long]0
    $script:cancelFixture = $cancel
    Assert-Rejected {
        Get-NativePayload $download $hash $cache $cancel -MaximumSeconds 180 -Progress {
            param($id, $bytes, $total)
            if ($bytes -gt 0 -and $bytes -lt $total -and !$script:canceledAt) {
                $script:canceledAt = $bytes
                [IO.File]::WriteAllText($script:cancelFixture, 'cancel')
            }
        }
    }
    if (!$script:canceledAt) { throw 'Transfer finished before a partial cancellation could be tested' }
    $name = 'Josi CE payload ' + $hash + ' resume-test'
    $suspended = @(Get-BitsTransfer | Where-Object { $_.DisplayName -ceq $name })
    if ($suspended.Count -ne 1 -or [string]$suspended[0].JobState -ne 'Suspended' -or
        $suspended[0].BytesTransferred -le 0) { throw 'Partial download was not preserved' }
    Remove-Item -LiteralPath $cancel
    $downloaded = Get-NativePayload $download $hash $cache '' -MaximumSeconds 180
    if (!(Test-NativePayload $download $downloaded)) { throw 'Resumed download did not verify' }
    $resumeVerified = $true
}
$report = [ordered]@{ passed=$true; invalidManifestCases=17; badCacheRefused=$true;
    exactHashCacheReused=$true; githubBitsDownloadVerified=$networkVerified;
    signedManifestTested=$false; cancellationResumeTested=$resumeVerified; installerTested=$false }
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'artifacts\windows-native\evidence\payload-download.json') -Encoding UTF8
$report | ConvertTo-Json
