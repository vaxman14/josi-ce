# One-time revision of this workspace's owned, unsigned physical test only.
# Requires UAC. Preserve database, artifacts, secrets and recovery material.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallationId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
Import-Module (Join-Path $repo 'packaging\windows\DataLayout.psm1')
Import-Module (Join-Path $repo 'packaging\windows\Payloads.psm1')
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Windows administrator approval is required to revise the owned native test'}
if($InstallationId -cne 'b5a3b94c72624209908a5a965bf6867d'){throw 'This operation is limited to the existing synthetic acceptance installation'}
function Assert([bool]$Condition,[string]$Text){if(!$Condition){throw $Text}}
$product=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Josi CE Server')
$data=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server')
$programMarker=Get-Content -LiteralPath (Join-Path $product 'installation.json') -Raw | ConvertFrom-Json
$dataMarker=Get-Content -LiteralPath (Join-Path $data 'installation.json') -Raw | ConvertFrom-Json
Assert ($programMarker.installationId -ceq $InstallationId -and $programMarker.purpose -ceq 'native-service-acceptance' -and
    $dataMarker.installationId -ceq $InstallationId -and $dataMarker.product -ceq 'Josi CE Server') 'The standard folders are not owned by this test'
$names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy','JosiDefinitions')
Assert (!@(Get-Service -Name $names -ErrorAction SilentlyContinue).Count) 'The previous test registrations must already be removed'
Assert (!@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($product+'\',[StringComparison]::OrdinalIgnoreCase)}).Count) 'A product process is still using the previous runtime'
$app=Get-Content -LiteralPath (Join-Path $base 'evidence\application-build.json') -Raw | ConvertFrom-Json
$runtime=Get-Content -LiteralPath (Join-Path $base 'evidence\runtime-build.json') -Raw | ConvertFrom-Json
Assert ($app.version -ceq '0.1.78-native.2') 'This test revision requires the reviewed AMSI candidate'
$program=Assert-PlainNativePath (Join-Path $product ('versions\'+$app.version))
Assert ($program.StartsWith($product+'\versions\',[StringComparison]::OrdinalIgnoreCase)) 'The new runtime escaped the owned version folder'
$null=[IO.Directory]::CreateDirectory($program)
$all=@{}
foreach($pair in @(@($app.payload,(Join-Path $app.build 'reports\payload-inventory.json')),@($runtime.payload,(Join-Path $runtime.reports 'file-inventory.json')))){
    $source=Assert-PlainNativePath $pair[0]
    Assert ($source.StartsWith($base+'\staging\',[StringComparison]::OrdinalIgnoreCase)) 'A payload is outside this workspace staging'
    $entries=Get-Content -LiteralPath $pair[1] -Raw | ConvertFrom-Json
    foreach($entry in $entries){
        Assert ($entry.path -is [string] -and $entry.path -cnotmatch '(^/|\\|:|(^|/)\.\.(/|$)|[\x00-\x1f])' -and
            $entry.path -notmatch 'clamav|clamscan|freshclam|libclam|clamd|JosiDefinitions|windows_scanner|\.cv[dl]$|\.cld$|Dockerfile|compose\.ya?ml$') 'A prohibited or unsafe payload name remains'
        Assert (!$all.ContainsKey($entry.path.ToLowerInvariant())) 'The independent payloads overlap'
        $all[$entry.path.ToLowerInvariant()]=$true
        $inputPath=Assert-PlainNativePath (Join-Path $source $entry.path)
        $outputPath=Assert-PlainNativePath (Join-Path $program $entry.path)
        Assert ($inputPath.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -and
            $outputPath.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase)) 'A payload path escaped its root'
        Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($inputPath) -and (Get-Item -LiteralPath $inputPath).Length -eq $entry.size -and
            (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'The staged payload bytes changed'
        $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath))
        if(!(Test-Path -LiteralPath $outputPath)){[IO.File]::Copy($inputPath,$outputPath,$false)}
        Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($outputPath) -and (Get-Item -LiteralPath $outputPath).Length -eq $entry.size -and
            (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'The revised runtime verification failed'
    }
}
Assert (@(Get-ChildItem -LiteralPath $program -Recurse -File -Force).Count -eq $all.Count) 'Unlisted files remain in the revised runtime'

# Only these fixed legacy engine paths are deleted. Preflight every descendant
# without following reparse points before using a recursive filesystem operation.
function Remove-OwnedLegacy([string]$Root,[string]$Relative){
    $target=Assert-PlainNativePath (Join-Path $Root $Relative)
    Assert ($target.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)) 'A removal target escaped its explicit owned root'
    if(!(Test-Path -LiteralPath $target)){return}
    function Check([string]$Path){
        $checked=Assert-PlainNativePath $Path
        Assert ($checked -ieq $target -or $checked.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) 'A legacy descendant escaped the verified target'
        $item=Get-Item -LiteralPath $checked -Force
        Assert (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Legacy cleanup refuses reparse points'
        if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $checked -Force){Check $child.FullName}}
        else{Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($checked)) 'Legacy cleanup refuses hardlinks or nonregular files'}
    }
    Check $target
    Remove-Item -LiteralPath $target -Recurse -Force
}
$old=Assert-PlainNativePath (Join-Path $product 'versions\0.1.78-native.1')
if(Test-Path -LiteralPath $old){
    foreach($relative in @('clamav','services\JosiDefinitions','app\services\scanner\windows_scanner.py')){Remove-OwnedLegacy $old $relative}
}
foreach($relative in @('clamav','config\freshclam.conf','logs\JosiDefinitions','profiles\definitions','temp\definitions')){Remove-OwnedLegacy $data $relative}
$policy=Get-NativeDataPolicy
foreach($entry in $policy.Directories.Values){
    $path=if($entry.Path){Assert-PlainNativePath (Join-Path $data $entry.Path)}else{$data}
    Assert ($path -ieq $data -or $path.StartsWith($data+'\',[StringComparison]::OrdinalIgnoreCase)) 'A directory policy escaped the owned data folder'
    if(!(Test-Path -LiteralPath $path)){$null=[IO.Directory]::CreateDirectory($path)}
    Assert ((Get-Item -LiteralPath $path -Force).PSIsContainer) 'An installer-managed directory was replaced with a file'
    $security=[Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm((Get-NativeDirectoryDescriptor $entry))
    [IO.Directory]::SetAccessControl($path,$security)
}

# Withdraw the old version from installed product paths. Retain unrelated old
# binary/source evidence in a protected workspace folder, with no engine bytes.
if(Test-Path -LiteralPath $old){
    $retired=Assert-PlainNativePath (Join-Path $base ('test-installations\retired-standard-'+$InstallationId))
    Assert ($old -ieq (Join-Path $product 'versions\0.1.78-native.1') -and
        $retired.StartsWith($base+'\test-installations\',[StringComparison]::OrdinalIgnoreCase)) 'The retirement paths are outside the named roots'
    Assert (!(Test-Path -LiteralPath $retired)) 'Existing retired evidence must be preserved'
    # GetChildItem recursion is allowed only after a complete no-link preflight.
    function Check-Old([string]$Path){
        $checked=Assert-PlainNativePath $Path
        Assert ($checked -ieq $old -or $checked.StartsWith($old+'\',[StringComparison]::OrdinalIgnoreCase)) 'A retirement descendant escaped its version root'
        $item=Get-Item -LiteralPath $checked -Force
        Assert (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Retirement refuses reparse points'
        if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $checked -Force){Check-Old $child.FullName}}
        else{Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($checked)) 'Retirement refuses linked files'}
    }
    Check-Old $old
    [IO.Directory]::Move($old,$retired)
}
$configuration=Assert-PlainNativePath (Join-Path $data 'config\runtime.json')
Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($configuration)) 'Runtime configuration must be a single regular protected file'
$settings=Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json
Assert ($settings.version -cin @('0.1.78-native.1','0.1.78-native.2')) 'This is not the synthetic configuration being revised'
$settings.version=$app.version
$bytes=[Text.Encoding]::UTF8.GetBytes(($settings | ConvertTo-Json -Compress))
$pending=Assert-PlainNativePath ($configuration+'.native2.pending')
Assert ($pending.StartsWith($data+'\config\',[StringComparison]::OrdinalIgnoreCase)) 'The configuration checkpoint escaped its owned directory'
if(!(Test-Path -LiteralPath $pending)){
    $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($pending) -and
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($pending)) -ceq [Convert]::ToBase64String($bytes)) 'An interrupted configuration checkpoint needs inspection'
[IO.File]::SetAccessControl($pending,[IO.File]::GetAccessControl($configuration))
[Josi.NativeSetup.DurableFile]::Replace($pending,$configuration)
if([Diagnostics.EventLog]::SourceExists('JosiDefinitions')){
    Assert ([Diagnostics.EventLog]::LogNameFromSourceName('JosiDefinitions','.') -ceq 'Application') 'An unexpected event-log registration must be preserved'
    [Diagnostics.EventLog]::DeleteEventSource('JosiDefinitions')
}
Assert (!@(Get-ChildItem -LiteralPath $product -Recurse -Force | Where-Object {$_.Name -match 'clamav|clamscan|freshclam|libclam|clamd|JosiDefinitions|windows_scanner|\.cv[dl]$|\.cld$'}).Count) 'A retired engine component remains in the installed program'
$report=[ordered]@{passed=$true;installationId=$InstallationId;version=$app.version;engineRemoved=$true;definitionsRemoved=$true;retiredIdentityGrantsRemoved=$true;
    retiredServiceAbsent=$true;databasePreserved=$true;secretsPreserved=$true;artifactsPreserved=$true;userDataReset=$false;time=[DateTime]::UtcNow.ToString('o')}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\native-test-revision.json') -Encoding UTF8
