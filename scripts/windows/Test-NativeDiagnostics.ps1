$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Import-Module (Join-Path $repo 'packaging\windows\Diagnostics.psm1')
$path=Join-Path $repo ('artifacts\windows-native\evidence\diagnostics-'+[Guid]::NewGuid().ToString('N')+'.json')
$report=Export-NativeDiagnostics $path
if($report.services.Count -ne 6 -or @($report.services | Where-Object {$_.state -cne 'Running' -or !$_.restrictedIdentity}).Count -or
    $report.listeners.Count -ne 5 -or @($report.listeners | Where-Object {!$_.localOnly}).Count -or
    !$report.applicationDatabaseReady -or !$report.speech.healthy -or !$report.speech.cpu -or $report.antivirus.status -cne 'available' -or !$report.antivirus.fresh){throw 'Live diagnostics did not reflect accepted readiness'}
$text=Get-Content -LiteralPath $path -Raw
foreach($relative in @('secrets\database-password','secrets\master-key','secrets\voice-control-token','voice\gateway\token')){
    $secret=[IO.File]::ReadAllText((Join-Path 'C:\ProgramData\Josi CE Server' $relative))
    try{if($secret.Length -lt 32 -or $text.Contains($secret)){throw 'Diagnostic export exposed a secret'}}finally{$secret=$null}
}
$rejected=$false;try{Export-NativeDiagnostics $path | Out-Null}catch{$rejected=$true};if(!$rejected){throw 'Existing evidence was overwritten'}
$rejected=$false;try{Export-NativeDiagnostics 'C:\ProgramData\Josi CE Server\secrets\master-key' | Out-Null}catch{$rejected=$true};if(!$rejected){throw 'Installation write boundary failed'}
[ordered]@{passed=$true;export=$path;sixServices=$true;readiness=$true;secretValuesAbsent=$true;installationWriteRefused=$true;priorExportPreserved=$true;installationStateModified=$false;recordedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'artifacts\windows-native\evidence\native-diagnostics.json') -Encoding UTF8
