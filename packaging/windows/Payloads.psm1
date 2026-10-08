# Windows PowerShell 5.1: use the OS BITS implementation for resumable,
# proxy-aware HTTPS transfers. This module never executes downloaded content.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (!('Josi.NativeSetup.FileAttributes' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeFileAttributes.cs')
}

function Assert-PlainNativePath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Contains([char]0)) { throw 'An absolute local path is required' }
    $full = [IO.Path]::GetFullPath($Path)
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                ![Josi.NativeSetup.FileAttributes]::IsNonRedirecting($current)) { throw 'Installer storage must not contain links' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    return $full
}

function Read-NativeManifest([string]$Path, [string]$ExpectedHash, [string]$ExpectedVersion) {
    if ($ExpectedHash -cnotmatch '^[a-f0-9]{64}$' -or $ExpectedVersion -cnotmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
        throw 'Invalid embedded release identity'
    }
    if ((Get-Item -LiteralPath $Path).Length -gt 1048576 -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedHash) {
        throw 'Release manifest integrity check failed'
    }
    $manifest = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.product -cne 'Josi CE Server' -or
        $manifest.version -cne $ExpectedVersion -or $manifest.architecture -cne 'x64' -or
        $manifest.releaseTag -cne ('windows-v' + $ExpectedVersion)) { throw 'Release identity does not match this installer' }
    $required = @('josi', 'node', 'python', 'postgresql', 'caddy', 'voice-models')
    $components = @($manifest.components)
    if ($components.Count -ne $required.Count) { throw 'Release component inventory is incomplete' }
    $seen = @{}
    $assets = @{}
    foreach ($component in $components) {
        if ($component.id -cnotin $required -or $seen.ContainsKey($component.id)) { throw 'Unexpected or duplicate release component' }
        $seen[$component.id] = $true
        if ($component.version -cnotmatch '^[0-9][0-9A-Za-z.+-]{0,79}$' -or $component.architecture -cne 'x64' -or
            $component.asset -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}\.zip$' -or
            $assets.ContainsKey($component.asset) -or $component.asset.Contains('..') -or
            $component.asset -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\.' -or
            $component.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            ($component.size -isnot [int] -and $component.size -isnot [long]) -or $component.size -le 0 -or $component.size -gt 21474836480 -or
            [decimal]$component.size -ne [Math]::Floor([decimal]$component.size)) { throw 'Invalid release payload identity' }
        $assets[$component.asset] = $true
        $expectedUrl = 'https://github.com/vaxman14/josi-ce/releases/download/' +
            $manifest.releaseTag + '/' + [Uri]::EscapeDataString($component.asset)
        if ($component.url -cne $expectedUrl) { throw 'Payload must use the exact versioned Josi GitHub release' }
        if ([string]::IsNullOrWhiteSpace($component.license) -or $component.license.Length -gt 300 -or
            $component.licenseSource -cnotmatch '^https://[^\s]+$' -or
            $component.redistributionEvidence -cnotmatch '^licenses/[A-Za-z0-9._/-]+$' -or
            $component.redistributionEvidence.Contains('..')) { throw 'Payload license evidence is incomplete' }
    }
    return $manifest
}

function Read-SignedNativeManifest([string]$Path, [string]$Catalog, [string]$ExpectedHash, [string]$ExpectedVersion) {
    # The signed bootstrap EXE embeds the expected manifest hash. A different
    # validly signed manifest therefore cannot substitute another version.
    $manifest = Read-NativeManifest $Path $ExpectedHash $ExpectedVersion
    if ((Get-AuthenticodeSignature -LiteralPath $Catalog).Status -ne 'Valid') { throw 'Release manifest signature is not trusted' }
    $result = Test-FileCatalog -Path $Path -CatalogFilePath $Catalog -Detailed
    if ($result.Status -ne 'Valid') { throw 'Release manifest does not match its signed catalog' }
    return $manifest
}

function Test-NativePayload($Component, [string]$Path) {
    $null = Assert-PlainNativePath $Path
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    return (Get-Item -LiteralPath $Path).Length -eq $Component.size -and
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $Component.sha256
}

function Get-NativePayload($Component, [string]$ManifestHash, [string]$CacheRoot,
    [string]$CancelPath, [scriptblock]$Progress = {}, [int]$MaximumSeconds = 1800) {
    if ($ManifestHash -cnotmatch '^[a-f0-9]{64}$' -or $MaximumSeconds -lt 1 -or $MaximumSeconds -gt 7200) {
        throw 'Invalid download operation'
    }
    $cache = Assert-PlainNativePath $CacheRoot
    if (!(Test-Path -LiteralPath $cache -PathType Container)) { throw 'Private installer cache is not provisioned' }
    $directory = Join-Path $cache $ManifestHash
    $null = Assert-PlainNativePath $directory
    $null = [IO.Directory]::CreateDirectory($directory)
    $destination = Join-Path $directory $Component.asset
    if (Test-NativePayload $Component $destination) { return $destination }
    if (Test-Path -LiteralPath $destination) { throw 'Cached payload failed verification. Repair the installer cache and retry.' }
    $partial = $destination + '.partial'
    $null = Assert-PlainNativePath $partial
    # BITS uses an internal partial file until Complete-BitsTransfer. If a
    # completed transfer was interrupted before promotion, verify and reuse it.
    if (Test-Path -LiteralPath $partial) {
        if (Test-NativePayload $Component $partial) {
            Move-Item -LiteralPath $partial -Destination $destination
            return $destination
        }
        Remove-Item -LiteralPath $partial
    }
    Import-Module BitsTransfer -ErrorAction Stop
    $name = 'Josi CE payload ' + $ManifestHash + ' ' + $Component.id
    $jobs = @(Get-BitsTransfer -ErrorAction Stop | Where-Object { $_.DisplayName -ceq $name })
    if ($jobs.Count -gt 1) { throw 'More than one matching download exists; retry after resolving installer state' }
    $job = if ($jobs.Count -eq 1) { $jobs[0] } else { $null }
    if ($job) {
        $files = @($job.FileList)
        if ($files.Count -ne 1 -or $files[0].RemoteName -cne $Component.url -or
            $files[0].LocalName -ine $partial) { throw 'Existing download does not match this release' }
    } else {
        try {
            # SecurityFlags=1 enables certificate revocation checks. No certificate
            # bypass bits and no HTTPS-to-HTTP redirect permission are granted.
            $job = Start-BitsTransfer -Source $Component.url -Destination $partial -DisplayName $name `
                -Description 'Verified Josi CE installation payload' -TransferType Download -Asynchronous `
                -Suspended -Priority Foreground -ProxyUsage SystemDefault -SecurityFlags 1 `
                -RetryInterval 60 -RetryTimeout 180 -MaxDownloadTime $MaximumSeconds -ErrorAction Stop
        } catch {
            throw ('The Windows download service could not start (0x{0:X8}, {1}). Check your network or proxy and retry.' -f
                $_.Exception.HResult, $_.CategoryInfo.Reason)
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($MaximumSeconds)
    $resumed = $false
    $failure = 'Download was interrupted. Check the network or proxy and retry this installer.'
    try {
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($CancelPath -and (Test-Path -LiteralPath $CancelPath)) {
                # Suspend, rather than discard, so the next installer run resumes.
                Suspend-BitsTransfer -BitsJob $job -ErrorAction SilentlyContinue
                $failure = 'Installation canceled. Verified files and resumable downloads were preserved.'
                throw $failure
            }
            $job = Get-BitsTransfer -JobId $job.JobId -ErrorAction Stop
            & $Progress $Component.id ([long]$job.BytesTransferred) ([long]$Component.size)
            if ($job.BytesTransferred -gt $Component.size -or
                ($job.BytesTotal -ne [UInt64]::MaxValue -and $job.BytesTotal -gt $Component.size)) {
                Remove-BitsTransfer -BitsJob $job -Confirm:$false
                $job = $null
                $failure = 'The download exceeds its pinned size. Nothing was installed.'
                throw $failure
            }
            if ($CancelPath -and (Test-Path -LiteralPath $CancelPath)) {
                Suspend-BitsTransfer -BitsJob $job -ErrorAction SilentlyContinue
                $failure = 'Installation canceled. Verified files and resumable downloads were preserved.'
                throw $failure
            }
            switch ([string]$job.JobState) {
                'Transferred' {
                    Complete-BitsTransfer -BitsJob $job -ErrorAction Stop
                    if (!(Test-NativePayload $Component $partial)) {
                        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
                        $failure = 'Downloaded payload failed size or checksum verification. Nothing was installed.'
                        throw $failure
                    }
                    Move-Item -LiteralPath $partial -Destination $destination
                    return $destination
                }
                'Suspended' {
                    if ($resumed) { throw 'Download was suspended. Run the installer again to resume.' }
                    Resume-BitsTransfer -BitsJob $job -Asynchronous -ErrorAction Stop | Out-Null
                    $resumed = $true
                }
                'Error' {
                    if (!$resumed) {
                        Resume-BitsTransfer -BitsJob $job -Asynchronous -ErrorAction Stop | Out-Null
                        $resumed = $true
                    } else { throw 'Download failed. Check GitHub access, network or proxy, then retry this installer.' }
                }
                'Cancelled' { throw 'Download was canceled. Run the installer again to retry.' }
                'Acknowledged' { throw 'Download state changed unexpectedly. Retry this installer.' }
            }
            Start-Sleep -Milliseconds 250
        }
        Suspend-BitsTransfer -BitsJob $job -ErrorAction SilentlyContinue
        $failure = 'Download timed out. Run the installer again to resume.'
        throw $failure
    } catch {
        # Deliberately do not print BITS ErrorDescription: redirects/proxy errors
        # may include credentials or signed CDN query strings.
        if ($job -and [string]$job.JobState -in @('Connecting', 'Transferring', 'Queued', 'TransientError')) {
            Suspend-BitsTransfer -BitsJob $job -ErrorAction SilentlyContinue
        }
        throw $failure
    }
}

Export-ModuleMember -Function Read-NativeManifest, Read-SignedNativeManifest, Test-NativePayload, Get-NativePayload, Assert-PlainNativePath
