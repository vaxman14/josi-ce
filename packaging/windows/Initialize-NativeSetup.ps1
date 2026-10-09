# The signed bootstrap supplies the exact kit hash. No downloaded script or
# source compiler is trusted before the embedded inventory has been verified.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$ExpectedKitHash)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(![Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or
    $ExpectedKitHash -cnotmatch '^[a-f0-9]{64}$' -or $Root -notmatch '^[A-Za-z]:\\'){throw 'Invalid private installer context'}
$root=[IO.Path]::GetFullPath($Root)
$path=Join-Path $root 'kit-inventory.json'
$item=Get-Item -LiteralPath $path -Force
if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536 -or
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedKitHash){throw 'Installer kit integrity failed'}
$manifest=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$required=@('Initialize-NativeSetup.ps1','Josi.NativeSetup.dll','Configuration.psm1','DataLayout.psm1','Database.psm1',
    'Maintenance.psm1','Payloads.psm1','Services.psm1','Transactions.psm1','service-host.lock.json',
    'Lifecycle.psm1','Diagnostics.psm1','StartupEvidence.psm1','Invoke-NativeSetup.ps1','WinSW.Josi.exe','JosiLauncher.exe')
if(@($manifest.PSObject.Properties).Count -ne 4 -or $manifest.schemaVersion -ne 1 -or $manifest.product -cne 'Josi CE installer kit' -or
    $manifest.architecture -cne 'x64' -or @($manifest.files).Count -ne $required.Count){throw 'Installer kit identity failed'}
$seen=@{}
foreach($entry in $manifest.files){
    if(@($entry.PSObject.Properties).Count -ne 3 -or $entry.path -cnotin $required -or $seen.ContainsKey($entry.path) -or
        $entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $entry.size -le 0 -or $entry.size -gt 1048576){throw 'Installer kit inventory failed'}
    $seen[$entry.path]=$true
    $file=Join-Path $root $entry.path
    $info=Get-Item -LiteralPath $file -Force
    if($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $info.Length -ne $entry.size -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'Installer kit component integrity failed'}
}
$actual=@(Get-ChildItem -LiteralPath $root -Force)
if($actual.Count -ne $required.Count+1 -or @($actual | Where-Object {$_.PSIsContainer -or $_.Name -cnotin @($required+'kit-inventory.json')}).Count){throw 'Unexpected installer kit content'}
# All bytes, including this DLL, are bound to the bootstrap's expected hash.
# Add-Type loads the precompiled Windows CLR assembly; it compiles no source.
if(!('Josi.NativeSetup.FileAttributes' -as [type])){Add-Type -Path (Join-Path $root 'Josi.NativeSetup.dll')}
foreach($name in @($required+'kit-inventory.json')){
    $file=Join-Path $root $name
    if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($file)){throw 'Linked installer kit file refused'}
}
Import-Module (Join-Path $root 'Payloads.psm1')
$null=Assert-PlainNativePath $root
foreach($name in @('Services','DataLayout','Configuration','Database','Transactions','Maintenance','Lifecycle','Diagnostics','StartupEvidence')){Import-Module (Join-Path $root ($name+'.psm1'))}
[pscustomobject]@{verified=$true;precompiledBridge=$true;runtimeCompilerRequired=$false;kitSha256=$ExpectedKitHash}
