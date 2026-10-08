# UAC entry point: revise only the owned synthetic installation, then exercise
# the six fixed least-privilege services. No interactive-user data is reset.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OriginalUserSid)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$result=Join-Path $repo 'artifacts\windows-native\evidence\native-acceptance-revision.json'
$report=[ordered]@{passed=$false;stage='cleanup-and-revision';version='0.1.78-native.2';time=[DateTime]::UtcNow.ToString('o')}
try{
    $report | ConvertTo-Json | Set-Content -LiteralPath $result -Encoding UTF8
    & (Join-Path $PSScriptRoot 'Prepare-NativeTestRevision.ps1') -InstallationId 'b5a3b94c72624209908a5a965bf6867d'
    if(!$?){throw 'Test revision failed'}
    $report.stage='six-service-acceptance'
    $report | ConvertTo-Json | Set-Content -LiteralPath $result -Encoding UTF8
    & (Join-Path $PSScriptRoot 'Test-NativeServices.ps1') -OriginalUserSid $OriginalUserSid -ReuseInstallationId 'b5a3b94c72624209908a5a965bf6867d' -RestartFailedInitialization
    if($LASTEXITCODE -ne 0){throw 'Physical service acceptance failed'}
    $report.passed=$true;$report.stage='complete'
}catch{
    # Never copy exception parameter values or raw credential-bearing output.
    $report.failureFile=$_.InvocationInfo.ScriptName
    $report.failureLine=$_.InvocationInfo.ScriptLineNumber
    $report.failureCode=$_.Exception.HResult
    $report.failureStack=$_.ScriptStackTrace
}finally{
    $report.time=[DateTime]::UtcNow.ToString('o')
    $report | ConvertTo-Json | Set-Content -LiteralPath $result -Encoding UTF8
}
if(!$report.passed){exit 1}
