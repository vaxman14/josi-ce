# Build-time official payload staging only. Never a runtime downloader.
[CmdletBinding()]
param([string[]]$Component = @('caddy', 'inno-setup'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$lock = Get-Content -LiteralPath (Join-Path $repo 'packaging\windows\upstream-lock.json') -Raw | ConvertFrom-Json
foreach ($id in $Component) {
    $entry = @($lock.components | Where-Object { $_.id -eq $id })
    if ($entry.Count -ne 1) { throw 'Unknown or duplicate component' }
    $entry = $entry[0]
    if ([uri]::new($entry.url).Scheme -ne 'https' -or $entry.asset -match '[/\\]' -or $entry.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid upstream lock' }
    $target = Join-Path $base ('cache\' + $entry.asset)
    if (!(Test-Path -LiteralPath $target)) {
        Invoke-WebRequest -Uri $entry.url -OutFile ($target + '.partial') -TimeoutSec 300
        if ((Get-Item -LiteralPath ($target + '.partial')).Length -ne $entry.size -or
            (Get-FileHash -LiteralPath ($target + '.partial')).Hash -ne $entry.sha256) { throw "Verification failed: $id" }
        Move-Item -LiteralPath ($target + '.partial') -Destination $target
    }
    if ((Get-Item -LiteralPath $target).Length -ne $entry.size -or
        (Get-FileHash -LiteralPath $target).Hash -ne $entry.sha256) { throw "Cache verification failed: $id" }
    if ($entry.asset.EndsWith('.zip')) {
        Expand-Archive -LiteralPath $target -DestinationPath (Join-Path $base ('tools\' + $id + '-' + $entry.version)) -Force
    }
    Write-Output "Verified $id $($entry.version)"
}
