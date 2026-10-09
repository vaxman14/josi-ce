# Local developer build only; no publication or Windows machine mutation.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
Import-Module (Join-Path $repo 'packaging\windows\Payloads.psm1')
$helper=Get-Content -LiteralPath (Join-Path $base 'evidence\native-setup-helper.json') -Raw | ConvertFrom-Json
$launcher=Get-Content -LiteralPath (Join-Path $base 'evidence\onboarding-launcher.json') -Raw | ConvertFrom-Json
if(!$launcher.passed -or !$launcher.testsPassed -or $launcher.sourceSha256 -cne (Get-FileHash (Join-Path $repo 'packaging\windows\launcher\JosiLauncher.cs') -Algorithm SHA256).Hash.ToLowerInvariant() -or
    (Get-FileHash $launcher.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $launcher.sha256){throw 'Verified onboarding launcher required'}
if(!$helper.passed -or !$helper.testedInOsPowerShell -or $helper.architecture -cne 'x64' -or $helper.framework -cne 'net462' -or
    $helper.sourceSha256 -cne (Get-FileHash -LiteralPath (Join-Path $repo 'packaging\windows\NativeFileAttributes.cs') -Algorithm SHA256).Hash.ToLowerInvariant() -or
    (Get-Item -LiteralPath $helper.binary).Length -ne $helper.size -or
    (Get-FileHash -LiteralPath $helper.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $helper.sha256){throw 'Precompiled bridge source or bytes changed; rebuild and test first'}
$root=Assert-PlainNativePath (Join-Path $base ('staging\installer-kit-'+[Guid]::NewGuid().ToString('N')))
$null=[IO.Directory]::CreateDirectory($root)
$files=[Collections.Generic.List[object]]::new()
foreach($name in @('Initialize-NativeSetup.ps1','Josi.NativeSetup.dll','Configuration.psm1','DataLayout.psm1','Database.psm1',
    'Maintenance.psm1','Payloads.psm1','Services.psm1','Transactions.psm1','service-host.lock.json',
    'Lifecycle.psm1','Diagnostics.psm1','StartupEvidence.psm1','Invoke-NativeSetup.ps1','WinSW.Josi.exe','JosiLauncher.exe')){
    $source=if($name -ceq 'Josi.NativeSetup.dll'){$helper.binary}elseif($name -ceq 'JosiLauncher.exe'){$launcher.binary}elseif($name -ceq 'WinSW.Josi.exe'){Join-Path $base 'cache\WinSW.Josi-2.12.0-windows1.exe'}else{Join-Path $repo ('packaging\windows\'+$name)}
    $null=Assert-PlainNativePath $source
    if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($source)){throw 'Linked installer input refused'}
    if($name -ceq 'WinSW.Josi.exe'){
        $pin=Get-Content -LiteralPath (Join-Path $repo 'packaging\windows\service-host.lock.json') -Raw | ConvertFrom-Json
        if((Get-Item -LiteralPath $source).Length -ne $pin.size -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'Service wrapper pin changed'}
    }
    $output=Join-Path $root $name
    [IO.File]::Copy($source,$output,$false)
    $files.Add([ordered]@{path=$name;size=(Get-Item -LiteralPath $output).Length;sha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()})
}
$manifest=[ordered]@{schemaVersion=1;product='Josi CE installer kit';architecture='x64';files=@($files.ToArray())}
$inventory=Join-Path $root 'kit-inventory.json'
[IO.File]::WriteAllText($inventory,($manifest | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$hash=(Get-FileHash -LiteralPath $inventory -Algorithm SHA256).Hash.ToLowerInvariant()
$env:PSModulePath=''
$probe='& '+("'"+(Join-Path $root 'Initialize-NativeSetup.ps1').Replace("'","''")+"'")+' -Root '+("'"+$root.Replace("'","''")+"'")+' -ExpectedKitHash '+("'"+$hash+"'")+' | ConvertTo-Json -Compress'
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
$out=& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $encoded
if($LASTEXITCODE -ne 0){throw 'Private precompiled installer kit failed the OS PowerShell check'}
$result=($out -join "`n") | ConvertFrom-Json
if(!$result.verified -or !$result.precompiledBridge -or $result.runtimeCompilerRequired){throw 'Installer still requires source compilation'}
$report=[ordered]@{passed=$true;root=$root;kitSha256=$hash;helperSha256=$helper.sha256;files=$files.Count;
    osPowerShellTested=$true;containsSourceCompiler=$false;endUserSdkRequired=$false;signed=$false;releaseApproved=$false}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\installer-kit.json') -Encoding UTF8
'Verified installer kit loads the precompiled bridge using OS Windows PowerShell 5.1.'
