# Close the single already-tested physical upgrade after offline classification
# of scheduler differences. Never rerun migrations, features or a SQL restore.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$run=Join-Path $base 'test-installations\lossless-upgrade-2b856e914b2f4fe38460d394744c0a2f'
$helper=Get-Content -LiteralPath (Join-Path $base 'evidence\native-setup-helper.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $helper.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne '834f9e97ac5a048d2a9e6fc0a1fad13f88e181b3724f223f9c781c3e53d2c97b'){throw 'Inspection bridge changed'}
Add-Type -Path $helper.binary
foreach($name in @('Payloads','Services','Transactions','Maintenance')){Import-Module (Join-Path $repo ('packaging\windows\'+$name+'.psm1'))}
$context=Get-NativeMaintenanceContext 'b5a3b94c72624209908a5a965bf6867d' '0.1.78-native.5'
$lock=$null;$report=Get-Content -LiteralPath (Join-Path $run 'result.json') -Raw | ConvertFrom-Json
function Assert([bool]$Value,[string]$Message){if(!$Value){throw $Message}}
try{
    Assert (!$report.passed -and $report.priorInterruptionRecovered -and $report.migrationsBeforeActivation -and $report.sixServicesVerified -and $report.amsiAndOcr -and $report.cpuVoiceInference -and $report.servicesStopped -and $report.transactionId -ceq '2ba88cc3136743789d7393f525c8ea9f') 'This is not the stopped tested upgrade'
    & (Join-Path $context.Program 'node\JosiRuntime.exe') (Join-Path $PSScriptRoot 'finalize-upgrade-proof.mjs') $run
    Assert ($LASTEXITCODE -eq 0) 'Offline final preservation proof failed'
    $proof=Get-Content -LiteralPath (Join-Path $run 'final-preservation-proof.json') -Raw | ConvertFrom-Json
    Assert ($proof.passed -and $proof.permissionsUnchanged -and $proof.originalUserRowsPreserved -and $proof.newHousekeepingJobs -eq 4 -and $proof.schedulesAdvanced -eq 4 -and $proof.queueSequenceBefore -ceq '4' -and $proof.queueSequenceAfter -ceq '8') 'Recorded preservation comparison did not pass'
    Assert ((Get-FileHash -LiteralPath (Join-Path $run 'retained-logical.sql') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $proof.retainedLogicalSha256 -and (Get-FileHash -LiteralPath (Join-Path $run 'after-services-logical.sql') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $proof.liveLogicalSha256) 'Logical evidence changed'
    $originalProofRoot=Join-Path $base 'test-installations\logical-comparison-aaf5c4a3600545689b799d4140e9b235\attempt-d66b9967-88cf-41fb-8d87-407ad7bc8a3a'
    $originalProof=Get-Content -LiteralPath (Join-Path $originalProofRoot 'semantic-comparison.json') -Raw | ConvertFrom-Json
    Assert ((Get-FileHash -LiteralPath (Join-Path $originalProofRoot 'retained-logical.sql') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $originalProof.retainedLogicalDumpSha256 -and (Get-FileHash -LiteralPath (Join-Path $originalProofRoot 'live-logical.sql') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $originalProof.copiedLiveLogicalDumpSha256) 'Original logical dumps changed'
    Assert ((Get-Content -LiteralPath (Join-Path $context.Data 'config\runtime.json') -Raw | ConvertFrom-Json).version -ceq '0.1.78-native.5') 'Activation changed'
    foreach($name in @('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')){
        $service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
        Assert ($service -and $service.State -ceq 'Stopped' -and $service.StartName -ieq ('NT SERVICE\'+$name) -and $service.PathName.Contains($context.Program+'\')) 'Tested service state changed'
    }
    Assert (!(Test-Path -LiteralPath (Join-Path $context.Data 'database\postmaster.pid'))) 'Database did not stop'
    $control=& (Join-Path $context.Program 'postgresql\bin\pg_controldata.exe') (Join-Path $context.Data 'database')
    Assert ($LASTEXITCODE -eq 0 -and ($control -join "`n") -match 'Database cluster state:\s+shut down\s') 'Database shutdown not verified'
    $preserved=Get-Content -LiteralPath (Join-Path $run 'preserved-before.json') -Raw | ConvertFrom-Json
    foreach($entry in $preserved){
        $path=Assert-PlainNativePath $entry.path;$item=Get-Item -LiteralPath $path -Force
        Assert ($item.PSIsContainer -eq $entry.directory -and (Get-Acl -LiteralPath $path).Sddl -ceq $entry.sddl) 'Preserved data ownership or permission changed'
        if(!$item.PSIsContainer){Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path) -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ceq $entry.hash) 'Existing secret, artifact or snapshot changed'}
    }
    $lock=Open-NativeTransactionLock (Join-Path $context.Data 'transactions')
    $directory=Join-Path $lock.Root $report.transactionId
    $journal=Read-NativeTransaction $directory
    Assert ($journal.Record.phase -ceq 'activated' -and $journal.Record.fromVersion -ceq '0.1.78-native.2' -and $journal.Record.toVersion -ceq '0.1.78-native.5') 'Upgrade checkpoint changed'
    Assert ((Read-NativeTransaction (Join-Path $lock.Root '39035c991bb740d4aeb111dcfc9d7756')).Record.phase -ceq 'rolled-back') 'Prior lossless repair did not complete'
    $receipt=Get-Content -LiteralPath (Join-Path $directory 'snapshot.receipt') -Raw | ConvertFrom-Json
    Assert ((Get-FileHash -LiteralPath (Join-Path $context.Data ('snapshots\'+$report.transactionId+'\manifest.json')) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.manifestSha256) 'Fresh rollback manifest changed'
    $null=Set-NativeTransactionPhase $lock $directory 'healthy'
    Set-NativeServiceStartup $context.Program $context.Data
    $startup=@(Get-CimInstance Win32_Service | Where-Object {$_.Name -cin @('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')} | Select-Object Name,StartMode)
    Assert ($startup.Count -eq 6 -and !@($startup | Where-Object {($_.Name -ceq 'JosiVoice' -and $_.StartMode -cne 'Manual') -or ($_.Name -cne 'JosiVoice' -and $_.StartMode -cne 'Auto')}).Count) 'Startup activation failed'
    [IO.File]::WriteAllText((Join-Path $run 'startup.json'),($startup | ConvertTo-Json))
    $null=Set-NativeTransactionPhase $lock $directory 'committed'
    $report.upgradeCommitted=$true;$report.candidateAccepted=$true;$report.passed=$true
    foreach($name in @('secretsArtifactsSnapshotsPreserved','databasePermissionsPreserved','existingDataVerified','startupPolicyVerified','physicalUpgradeExecutedOnce','losslessRollbackVerified')){Add-Member -InputObject $report -NotePropertyName $name -NotePropertyValue $true}
    Add-Member -InputObject $report -NotePropertyName 'acceptanceScope' -NotePropertyValue 'unsigned physical .5 engineering candidate; not release approval'
    Add-Member -InputObject $report -NotePropertyName 'operationalChanges' -NotePropertyValue @('deployment readiness timestamp','four new housekeeping jobs','four advanced schedule times','job queue sequence 4 to 8')
    $report.recordedAt=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $run 'accepted-result.json'),($report | ConvertTo-Json -Depth 5))
    [IO.File]::WriteAllText((Join-Path $base 'evidence\native-lossless-upgrade.json'),($report | ConvertTo-Json -Depth 5))
}finally{if($lock){$lock.Handle.Dispose()}}
