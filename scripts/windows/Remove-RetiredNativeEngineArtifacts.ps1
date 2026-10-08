# Remove only obsolete engine artifacts created under this workspace. Never
# touch Linux/container source, another checkout, or antivirus installed by users.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Import-Module (Join-Path $repo 'packaging\windows\Payloads.psm1')
$base=Assert-PlainNativePath (Join-Path $repo 'artifacts\windows-native')
$targets=[Collections.Generic.List[string]]::new()
foreach($relative in @('tools\clamav-1.5.4','cache\clamav-1.5.4.win.x64.zip','cache\clamav-database')){
    $targets.Add((Join-Path $base $relative))
}
foreach($entry in Get-ChildItem -LiteralPath (Join-Path $base 'staging') -Directory -Filter 'runtimes-*'){
    $targets.Add((Join-Path $entry.FullName 'payload\clamav'))
}
foreach($entry in Get-ChildItem -LiteralPath (Join-Path $base 'test-installations') -Directory -Filter 'josi-app-*'){
    foreach($relative in @('program\clamav','data\clamav')){$targets.Add((Join-Path $entry.FullName $relative))}
}
function Check-Tree([string]$Path,[string]$Target){
    $checked=Assert-PlainNativePath $Path
    if($checked -ine $Target -and !$checked.StartsWith($Target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'A retired artifact escaped its named target'}
    $item=Get-Item -LiteralPath $checked -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Retired artifact cleanup refuses reparse points'}
    if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $checked -Force){Check-Tree $child.FullName $Target}}
    elseif(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($checked)){throw 'Retired artifact cleanup refuses linked files'}
}
$existing=[Collections.Generic.List[string]]::new()
foreach($path in $targets){
    $target=Assert-PlainNativePath $path
    if(!$target.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase) -or
        $target -notmatch '\\(?:tools\\clamav-1\.5\.4|cache\\clamav-1\.5\.4\.win\.x64\.zip|cache\\clamav-database|staging\\runtimes-[a-f0-9]+\\payload\\clamav|test-installations\\josi-app-[a-f0-9]+\\(?:program|data)\\clamav)$'){
        throw 'A computed cleanup path is outside the fixed workspace artifact allowlist'
    }
    if(Test-Path -LiteralPath $target){Check-Tree $target $target;$existing.Add($target)}
}
# Validate all targets before the first recursive deletion, using one shell.
foreach($target in $existing){Remove-Item -LiteralPath $target -Recurse -Force}
[ordered]@{passed=$true;removedTargets=$existing.Count;installedProductTouched=$false;linuxSourceTouched=$false;
    currentPayloadsTouched=$false;historicalLogsPreserved=$true;time=[DateTime]::UtcNow.ToString('o')} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\retired-engine-artifacts.json') -Encoding UTF8
Write-Output ('Removed '+$existing.Count+' obsolete workspace engine artifact targets; unrelated files and historical logs preserved.')
