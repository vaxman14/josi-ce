[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
trap { [Console]::Error.WriteLine($_.ScriptStackTrace); break }
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$env:TEMP=Join-Path $base 'test-installations'; $env:TMP=$env:TEMP
Import-Module (Join-Path $repo 'packaging\windows\Services.psm1') -Force
Import-Module (Join-Path $repo 'packaging\windows\DataLayout.psm1') -Force
$root=Join-Path $base ('test-installations\service-definitions-'+[guid]::NewGuid().ToString('N'))
$program=Join-Path $root 'Program Files & test'; $data=Join-Path $root 'ProgramData & test'
$null=[IO.Directory]::CreateDirectory($program); $null=[IO.Directory]::CreateDirectory($data)
function Assert([bool]$Okay,[string]$Message){if(!$Okay){throw $Message}}
$plan=Write-NativeServiceFiles $program $data (Join-Path $base 'cache\WinSW.Josi-2.12.0-windows1.exe')
Assert ($plan.Count -eq 6) 'The fixed service inventory changed'
$evidence=@()
$policy=Get-NativeDataPolicy
foreach($entry in $policy.Directories.Values){
    $acl=[Security.AccessControl.RawSecurityDescriptor]::new((Get-NativeDirectoryDescriptor $entry))
    Assert ($acl.Owner.Value -eq 'S-1-5-32-544') 'Services must not own protected data folders'
    Assert (($acl.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) 'Data DACL must reject broad inherited permissions'
    foreach($ace in $acl.DiscretionaryAcl){
        if($ace.SecurityIdentifier.Value -in @('S-1-5-18','S-1-5-32-544')){continue}
        Assert ($ace.SecurityIdentifier.Value -match '^S-1-5-80-') 'An interactive identity received data access'
        Assert (($ace.AccessMask -band 0xc0000) -eq 0) 'A service can change permissions or ownership'
        if(!$entry.Inherit){Assert (([int]$ace.AceFlags -band 3) -eq 0) 'Parent traversal rights must not leak into secret files'}
    }
}
Assert ($policy.Directories['cache'].Read.Count -eq 0 -and $policy.Directories['cache'].Modify.Count -eq 0) 'A service may not modify installer payloads'
Assert (($policy.Directories['database'].Modify -join ',') -ceq 'JosiDatabase') 'Only the database identity may modify its cluster'
Assert (($policy.Files['secrets\master-key'] -join ',') -ceq 'JosiWeb,JosiWorker') 'Master key authority widened'
foreach($service in $plan){
    $sid=Get-NativeServiceSid $service.Name
    Assert ($sid -match '^S-1-5-80-(\d+-){4}\d+$') 'Not a virtual service identity'
    $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new((Get-NativeServiceSecurity $service.Name))
    $controlSid=Get-NativeServiceSid 'JosiVoiceControl'
    $controlAces=@($descriptor.DiscretionaryAcl | Where-Object {$_.SecurityIdentifier.Value -eq $controlSid})
    if($service.Name -eq 'JosiVoice'){
        Assert ($controlAces.Count -eq 1 -and $controlAces[0].AccessMask -eq 52) 'Speech helper has excessive service authority'
    }else{Assert ($controlAces.Count -eq 0) 'Speech helper may not control another service'}
    if($service.Kind -eq 'WinSW'){
        $path=Join-Path $program ('services\'+$service.Name+'\'+$service.Name+'.xml')
        $xml=[xml][IO.File]::ReadAllText($path)
        Assert ($xml.service.serviceaccount.domain -ceq 'NT SERVICE' -and $xml.service.serviceaccount.user -ceq $service.Name) 'Service identity is not explicit'
        Assert ($null -eq $xml.SelectSingleNode('/service/serviceaccount/password')) 'Service file must not contain a password'
        Assert ($null -eq $xml.SelectSingleNode('/service/download')) 'Services must never download code at startup'
        Assert ($xml.service.executable -ceq $service.Executable) 'Executable changed during XML escaping'
        Assert ($xml.service.onfailure.Count -eq 3 -and $xml.service.onfailure[2].action -ceq 'none') 'Recovery may not restart forever'
        Assert ($xml.service.logpath.StartsWith($data)) 'Logs escaped the private data root'
        Assert ($xml.service.arguments.Contains('&')) 'The path-escaping fixture did not exercise XML characters'
    }
    $evidence+=[pscustomobject]@{name=$service.Name;identity=('NT SERVICE\'+$service.Name);sid=$sid;start=$service.Start}
}
foreach($bad in @((Join-Path $root 'bad%PATH%'),(Join-Path $root 'bad"name'))){
    $rejected=$false
    try{$null=Get-NativeServicePlan $bad $data}catch{$rejected=$true}
    Assert $rejected 'A service path allowed command/environment ambiguity'
}
foreach($stopCase in @(@('UnrelatedService',60),@('JosiWorker',0),@('JosiWorker',181))){
    $rejected=$false
    try{Stop-NativeService $stopCase[0] $stopCase[1]}catch{$rejected=$true}
    Assert $rejected 'Service stop allowed an unrelated name or unbounded wait'
}
$report=[ordered]@{passed=$true;virtualSidsComputedByWindows=$true;voiceAuthorityMask=52;xmlEscapingVerified=$true;filesystemPoliciesVerified=$true;
    boundedCrashRecovery=$true;servicesInstalled=$false;scmLifecycleTested=$false;services=$evidence}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $base 'evidence\service-definitions.json') -Encoding UTF8
Write-Output 'Fixed service identities, XML paths, crash policy and speech control permissions passed. No services installed.'
