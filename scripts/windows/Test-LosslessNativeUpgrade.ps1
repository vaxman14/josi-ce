# One bounded physical .4 transaction repair and .5 upgrade. No SQL restore,
# cluster replacement, initialization, credential rotation, or artifact restore.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OriginalUserSid,[Parameter(Mandatory=$true)][string]$RunRoot,[switch]$ResumeBaseline)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$proofRoot=Join-Path $base 'test-installations\logical-comparison-aaf5c4a3600545689b799d4140e9b235'
$proofAttempt=Join-Path $proofRoot 'attempt-d66b9967-88cf-41fb-8d87-407ad7bc8a3a'
$helper=Get-Content -LiteralPath (Join-Path $base 'evidence\native-setup-helper.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $helper.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne '834f9e97ac5a048d2a9e6fc0a1fad13f88e181b3724f223f9c781c3e53d2c97b'){throw 'Verified inspection bridge changed'}
Add-Type -Path $helper.binary
foreach($name in @('Payloads','Services','Transactions','Maintenance')){Import-Module (Join-Path $repo ('packaging\windows\'+$name+'.psm1'))}
$installationId='b5a3b94c72624209908a5a965bf6867d';$baseline='0.1.78-native.2';$target='0.1.78-native.5'
$context=Get-NativeMaintenanceContext $installationId $baseline
if($OriginalUserSid -cnotmatch '^S-1-5-21-(?:\d+-){3}\d+$'){throw 'Invalid evidence reader'}
$run=Assert-PlainNativePath $RunRoot
if($run -cnotmatch ('^'+[regex]::Escape($base)+'\\test-installations\\lossless-upgrade-[a-f0-9]{32}$')){throw 'Evidence folder must be task-owned'}
if($ResumeBaseline){
    if($run -cne (Join-Path $base 'test-installations\lossless-upgrade-2b856e914b2f4fe38460d394744c0a2f')){throw 'Only the known pre-upgrade baseline check may resume'}
    $previous=Get-Content -LiteralPath (Join-Path $run 'result.json') -Raw | ConvertFrom-Json
    if($previous.passed -or $previous.recoveryPerformed -or $previous.upgradeCommitted -or !$previous.servicesStopped -or !$previous.servicesRegistered -or $previous.installationId -cne $installationId){throw 'The prior acceptance is not a safe baseline resume'}
    $archiveSuffix='.previous-'+[Guid]::NewGuid().ToString('N')
    [IO.File]::Move((Join-Path $run 'result.json'),(Join-Path $run ('result.json'+$archiveSuffix)))
    foreach($name in @('baseline-logical.sql','baseline-ownership-acls.json','baseline-proof.json','baseline.out','baseline.err','after-repair-logical.sql','after-repair-ownership-acls.json','after-repair-proof.json','after-repair.out','after-repair.err')){if(Test-Path -LiteralPath (Join-Path $run $name)){[IO.File]::Move((Join-Path $run $name),(Join-Path $run ($name+$archiveSuffix)))}}
}else{
    if(Test-Path -LiteralPath $run){throw 'Evidence folder must be new'}
    [Josi.NativeSetup.PrivateDirectory]::Create($run,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;'+$OriginalUserSid+')'))
}
$log=Join-Path $run 'acceptance.log';$lock=$null;$registered=$false
$names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
$report=[ordered]@{passed=$false;installationId=$installationId;baseline=$baseline;candidate=$target;root=$run;recoveryPerformed=$false;sqlRestorePerformed=$false;databaseDirectoryReplaced=$false;priorInterruptionRecovered=$false;upgradeCommitted=$false;candidateAccepted=$false;rollbackMaterialRetained=$true;servicesRegistered=$false;servicesStopped=$false;releaseApproved=$false}
function Assert([bool]$Value,[string]$Message){if(!$Value){throw $Message}}
function Step([string]$Message){[IO.File]::AppendAllText($log,[DateTime]::UtcNow.ToString('o')+' '+$Message+"`r`n")}
function Run-Private([string]$Program,[string]$Executable,[string[]]$Arguments,[string]$Label){
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=Join-Path $Program $Executable
    $info.Arguments=($Arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' ';$info.WorkingDirectory=Join-Path $Program 'app'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.EnvironmentVariables.Clear()
    foreach($pair in @(@('SystemRoot',$env:SystemRoot),@('WINDIR',$env:SystemRoot),@('SystemDrive',$env:SystemRoot.Substring(0,2)),@('PATH',(Join-Path $env:SystemRoot 'System32')),@('TEMP',(Join-Path $context.Data 'temp\migrate')),@('TMP',(Join-Path $context.Data 'temp\migrate')))){$info.EnvironmentVariables[$pair[0]]=$pair[1]}
    $process=[Diagnostics.Process]::Start($info)
    try{
        $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
        if(!$process.WaitForExit(180000)){$process.Kill();throw 'Bounded acceptance operation timed out'}
        [IO.File]::WriteAllText((Join-Path $run ($Label+'.out')),$out.Result)
        [IO.File]::WriteAllText((Join-Path $run ($Label+'.err')),$err.Result)
        Assert ($process.ExitCode -eq 0) ('Acceptance failed during '+$Label+'; stop without data restore')
    }finally{$process.Dispose()}
}
function Database-Proof([string]$Program,[string]$Label){Run-Private $Program 'node\JosiRuntime.exe' @((Join-Path $run 'installed-database-proof.mjs'),$Program,$context.Data,$run,$Label) $Label}
function Ready {
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    do{try{if((Invoke-WebRequest 'http://localhost:8080/ready' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200){return}}catch{};Start-Sleep -Milliseconds 400}while([DateTime]::UtcNow -lt $deadline)
    throw 'Installed service readiness did not pass'
}
function Stop-Writers {foreach($name in @('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb')){Stop-NativeService $name}}
function Remove-OwnedServices([string]$Program){
    foreach($name in @('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb','JosiDatabase')){
        $service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
        Assert ($service -and $service.StartName -ieq ('NT SERVICE\'+$name) -and $service.PathName.Contains($Program+'\')) 'Unrelated service must be preserved'
        Stop-NativeService $name
        & (Join-Path $env:SystemRoot 'System32\sc.exe') delete $name | Out-Null
        Assert ($LASTEXITCODE -eq 0) 'Owned service registration removal failed'
    }
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do{if(!@(Get-Service -Name $names -ErrorAction SilentlyContinue).Count){return};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $deadline)
    throw 'Service re-registration requires recovery'
}
function Preserved-Inventory {
    $items=@()
    foreach($relative in @('secrets','chat-attachments','roots','versions','snapshots','voice\gateway\token')){
        $path=Assert-PlainNativePath (Join-Path $context.Data $relative)
        $entries=@(Get-Item -LiteralPath $path -Force)
        if($entries[0].PSIsContainer){$entries+=@(Get-ChildItem -LiteralPath $path -Recurse -Force)}
        foreach($item in $entries){
            Assert (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Preserved material contains a link'
            $hash='';if(!$item.PSIsContainer){Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($item.FullName)) 'Preserved material is nonregular';$hash=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash}
            $items+= [pscustomobject]@{path=$item.FullName;directory=$item.PSIsContainer;hash=$hash;sddl=(Get-Acl -LiteralPath $item.FullName).Sddl}
        }
    }
    return $items
}
function Verify-Payload([string]$Program,[string[]]$Inventories,[string[]]$Sources,[bool]$Copy){
    $all=@{}
    for($index=0;$index -lt $Inventories.Count;$index++){
        $source=Assert-PlainNativePath $Sources[$index]
        foreach($entry in (Get-Content -LiteralPath $Inventories[$index] -Raw | ConvertFrom-Json)){
            Assert ($entry.path -is [string] -and $entry.path -cnotmatch '(^/|\\|:|(^|/)\.\.(/|$)|[\x00-\x1f])' -and $entry.path -notmatch 'clamav|clamscan|freshclam|libclam|clamd|JosiDefinitions|windows_scanner|\.cv[dl]$|\.cld$|Dockerfile|compose\.ya?ml$') 'Unsafe or excluded native payload'
            Assert (!$all.ContainsKey($entry.path.ToLowerInvariant())) 'Duplicate payload inventory'
            $all[$entry.path.ToLowerInvariant()]=$true
            $output=Assert-PlainNativePath (Join-Path $Program $entry.path)
            Assert ($output.StartsWith($Program+'\',[StringComparison]::OrdinalIgnoreCase)) 'Payload escaped owned version root'
            if($Copy -and !(Test-Path -LiteralPath $output)){
                $input=Assert-PlainNativePath (Join-Path $source $entry.path)
                Assert ($input.StartsWith($base+'\staging\',[StringComparison]::OrdinalIgnoreCase) -and [Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($input) -and (Get-FileHash -LiteralPath $input -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Staged payload failed verification'
                $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output));[IO.File]::Copy($input,$output,$false)
            }
            Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($output) -and (Get-Item -LiteralPath $output).Length -eq $entry.size -and (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Installed payload failed verification'
        }
    }
    Assert (@(Get-ChildItem -LiteralPath $Program -Recurse -File -Force | Where-Object {$_.FullName -notlike ($Program+'\services\*')}).Count -eq $all.Count) 'Unlisted installed runtime file'
    return $all.Count
}
try{
    Step 'Verify retained logical proof, original offline bytes/ACLs, journal and preserved material.'
    $proof=Get-Content -LiteralPath (Join-Path $proofAttempt 'semantic-comparison.json') -Raw | ConvertFrom-Json
    $audit=Get-Content -LiteralPath (Join-Path $proofRoot 'source-audit.json') -Raw | ConvertFrom-Json
    Assert ($proof.comparisonComplete -and $proof.exactNormalizedMatch -and $proof.sourceUnchangedVerified -and $audit.originalUnchanged -and $audit.completed) 'Logical comparison did not pass'
    if($ResumeBaseline){
        foreach($name in $names){$service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'");Assert ($service -and $service.State -ceq 'Stopped' -and $service.StartName -ieq ('NT SERVICE\'+$name) -and $service.PathName.Contains($context.Program+'\')) 'Baseline service resume refused'}
        $registered=$true;$report.servicesRegistered=$true;$report.baselineFilesVerified=$previous.baselineFilesVerified
    }else{Assert (!@(Get-Service -Name ($names+'JosiDefinitions') -ErrorAction SilentlyContinue).Count) 'Existing service registrations must be preserved'}
    Assert (!(Test-Path -LiteralPath (Join-Path $context.Data 'database\postmaster.pid')) -and !(Test-Path -LiteralPath (Join-Path $context.Data 'secrets\init-password'))) 'Existing database must be stopped and already provisioned'
    $configPath=Join-Path $context.Data 'config\runtime.json';$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Assert ($config.version -ceq $baseline) 'Baseline activation changed'
    $lock=Open-NativeTransactionLock (Join-Path $context.Data 'transactions')
    $oldDirectory=Join-Path $lock.Root '39035c991bb740d4aeb111dcfc9d7756'
    $prior=Read-NativeTransaction $oldDirectory
    Assert ($prior.Record.installationId -ceq $installationId -and $prior.Record.operation -ceq 'upgrade' -and $prior.Record.fromVersion -ceq $baseline -and $prior.Record.toVersion -ceq '0.1.78-native.4' -and ($prior.Record.phase -ceq 'backup-verified' -or ($ResumeBaseline -and $prior.Record.phase -ceq 'rolling-back'))) 'Interrupted operation changed; stop without mutation'
    $recoveryContinuation=$prior.Record.phase -ceq 'rolling-back'
    Assert ((Get-FileHash -LiteralPath (Join-Path $context.Data 'snapshots\39035c991bb740d4aeb111dcfc9d7756\database.gz') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $audit.archiveSha256) 'Retained rollback snapshot changed'
    $inventory=Get-Content -LiteralPath (Join-Path $proofRoot 'original-inventory.json') -Raw | ConvertFrom-Json
    if(!$ResumeBaseline){foreach($entry in $inventory.files){
        $path=Assert-PlainNativePath (Join-Path $context.Data ('database\'+$entry.path));$item=Get-Item -LiteralPath $path -Force
        Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path) -and $item.Length -eq $entry.size -and $item.LastWriteTimeUtc.Ticks -eq $entry.lastWriteTicks -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256 -and (Get-Acl -LiteralPath $path).Sddl -ceq $entry.sddl) 'Original database changed since logical proof'
    }
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $context.Data 'database') -Recurse -File -Force).Count -eq $inventory.files.Count) 'Unlisted live database file'
    foreach($entry in $inventory.directories){Assert ((Get-Acl -LiteralPath (Join-Path $context.Data ('database\'+$entry.path))).Sddl -ceq $entry.sddl) 'Original database directory permissions changed'}}
    $preserved=Preserved-Inventory
    if(!$ResumeBaseline){[IO.File]::WriteAllText((Join-Path $run 'preserved-before.json'),($preserved | ConvertTo-Json -Depth 5))}
    else{
        $originalPreserved=Get-Content -LiteralPath (Join-Path $run 'preserved-before.json') -Raw | ConvertFrom-Json
        foreach($entry in $originalPreserved){$current=@($preserved | Where-Object path -CEQ $entry.path);Assert ($current.Count -eq 1 -and $current[0].hash -ceq $entry.hash -and $current[0].sddl -ceq $entry.sddl) 'Preserved material changed before baseline resume'}
    }
    foreach($name in @('installed-database-proof.mjs','logical-dump-compare.mjs','logical-timezone-normalize.mjs','logical-operational-compare.mjs','database-permissions.sql','installed-feature-probe.mjs','installed-voice-probe.py')){
        $destination=Join-Path $run $name
        if(Test-Path -LiteralPath $destination){[IO.File]::Move($destination,($destination+'.previous-'+[Guid]::NewGuid().ToString('N')))}
        [IO.File]::Copy((Join-Path $PSScriptRoot $name),$destination,$false)
    }
    if(!$ResumeBaseline){foreach($pair in @(@('retained-logical.sql','retained-logical.sql'),@('live-logical.sql','previous-live-logical.sql'),@('current-ownership-acls.json','prior-ownership-acls.json'))){[IO.File]::Copy((Join-Path $proofAttempt $pair[0]),(Join-Path $run $pair[1]),$false)}}
    Assert ((Get-FileHash -LiteralPath (Join-Path $run 'retained-logical.sql') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $proof.retainedLogicalDumpSha256 -and (Get-FileHash -LiteralPath (Join-Path $run 'previous-live-logical.sql') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $proof.copiedLiveLogicalDumpSha256) 'Preserved dump hashes changed'
    $runtimes=Get-Content -LiteralPath (Join-Path $base 'evidence\runtime-build.json') -Raw | ConvertFrom-Json
    $baselineBuild=Join-Path $base 'staging\application-0.1.78-native.2-d9639956-12a6-48a8-ba01-bba3e9b188cd'
    if(!$ResumeBaseline){$report.baselineFilesVerified=Verify-Payload $context.Program @((Join-Path $baselineBuild 'reports\payload-inventory.json'),(Join-Path $runtimes.reports 'file-inventory.json')) @((Join-Path $baselineBuild 'payload'),$runtimes.payload) $false}
    Step 'Recreate baseline service registrations, start only the existing database and prove connectivity/permissions/data.'
    $wrapper=Join-Path $base 'cache\WinSW.Josi-2.12.0-windows1.exe'
    if(!$ResumeBaseline){$null=Write-NativeServiceFiles $context.Program $context.Data $wrapper;$null=Register-NativeServices $context.Program $context.Data;$registered=$true;$report.servicesRegistered=$true}
    Start-Service JosiDatabase
    if(!$recoveryContinuation){
        Database-Proof $context.Program 'baseline'
        $null=Set-NativeTransactionPhase $lock $oldDirectory 'recovery-required' 'interrupted'
        $null=Set-NativeTransactionPhase $lock $oldDirectory 'rolling-back'
        foreach($name in @('JosiWeb','JosiProxy')){Start-Service $name};Ready
        Stop-NativeService JosiProxy;Stop-NativeService JosiWeb
    }
    Database-Proof $context.Program 'after-repair'
    $null=Set-NativeTransactionPhase $lock $oldDirectory 'rolled-back'
    $report.priorInterruptionRecovered=$true;$report.recoveryPerformed=$true
    Step 'Interrupted .4 operation repaired losslessly. Stage verified .5 without changing existing data.'
    $app=Get-Content -LiteralPath (Join-Path $base 'evidence\application-build.json') -Raw | ConvertFrom-Json
    $accepted=Get-Content -LiteralPath (Join-Path $base 'evidence\application-runtime.json') -Raw | ConvertFrom-Json
    Assert ($app.version -ceq $target -and $app.sourceInventorySha256 -ceq '5a82dd3f048dbfb67c72daddf093373ff100e64690522b9a7c28fd171842783b' -and $accepted.passed -and $accepted.version -ceq $target -and $accepted.migrationsBeforeActivation -and $accepted.unactivatedWritersRefused) 'Candidate is not the validated .5 payload'
    $candidate=Assert-PlainNativePath (Join-Path (Split-Path $context.Program -Parent) $target)
    $null=[IO.Directory]::CreateDirectory($candidate)
    $report.candidateFilesVerified=Verify-Payload $candidate @((Join-Path $app.build 'reports\payload-inventory.json'),(Join-Path $runtimes.reports 'file-inventory.json')) @($app.payload,$runtimes.payload) $true
    $null=Write-NativeServiceFiles $candidate $context.Data $wrapper
    $tools=Get-NativeMaintenanceContext $installationId $baseline $target
    $transaction=New-NativeTransaction $lock $installationId 'upgrade' $baseline $target $app.sourceInventorySha256
    $report.transactionId=$transaction.Record.transactionId
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'verified'
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'quiesced'
    $receipt=New-NativeMaintenanceSnapshot $tools $lock $transaction.Directory
    $report.backupVerified=$true
    Step 'Run candidate .5 migrations once against baseline configuration before activation.'
    Run-Private $candidate 'node\JosiRuntime.exe' @((Join-Path $candidate 'app\native\Runtime.mjs'),'migrate',$configPath) 'migrations'
    Database-Proof $candidate 'after-migrate'
    Assert ((Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).version -ceq $baseline) 'Migrations changed activation unexpectedly'
    $report.migrationsBeforeActivation=$true
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'migrated'
    Remove-OwnedServices $context.Program;$registered=$false
    $config.version=$target;$pending=$configPath+'.'+[Guid]::NewGuid().ToString('N')+'.pending'
    $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try{$bytes=[Text.Encoding]::UTF8.GetBytes(($config | ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    [IO.File]::SetAccessControl($pending,[IO.File]::GetAccessControl($configPath));[Josi.NativeSetup.DurableFile]::Replace($pending,$configPath)
    $null=Register-NativeServices $candidate $context.Data;$registered=$true
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'activated'
    Step 'Validate all six restricted services, AMSI, OCR and actual CPU speech inference.'
    Start-Service JosiDatabase
    foreach($name in @('JosiWeb','JosiWorker','JosiProxy','JosiVoiceControl')){Start-Service $name};Ready
    $started=[DateTime]::UtcNow;$antivirusPath=Join-Path $context.Data 'state\antivirus.json';$deadline=$started.AddSeconds(60)
    do{
        if(Test-Path -LiteralPath $antivirusPath){$av=Get-Content -LiteralPath $antivirusPath -Raw | ConvertFrom-Json;if([DateTime]::Parse($av.checkedAt).ToUniversalTime() -ge $started.AddSeconds(-10)){break}}
        Start-Sleep -Milliseconds 250
    }while([DateTime]::UtcNow -lt $deadline)
    Assert ($av.provider -ceq 'windows-amsi' -and $av.status -ceq 'available' -and [DateTime]::Parse($av.checkedAt).ToUniversalTime() -ge $started.AddSeconds(-10)) 'Worker explicit AMSI request did not pass'
    $report.explicitWorkerAmsi=$true
    Run-Private $candidate 'node\JosiRuntime.exe' @((Join-Path $run 'installed-feature-probe.mjs'),$candidate,$context.Data,(Join-Path $base 'evidence\ocr-fixture.png')) 'features'
    $report.amsiAndOcr=$true
    Run-Private $candidate 'python\python.exe' @('-I','-B',(Join-Path $run 'installed-voice-probe.py'),$candidate,$context.Data) 'cpu-voice'
    $report.cpuVoiceInference=$true
    $services=@(Get-CimInstance Win32_Service | Where-Object {$names -contains $_.Name} | Select-Object Name,State,StartMode,StartName,PathName,ProcessId)
    Assert ($services.Count -eq 6 -and !@($services | Where-Object {$_.State -ne 'Running' -or $_.StartName -ine ('NT SERVICE\'+$_.Name) -or !$_.PathName.Contains($candidate+'\')}).Count) 'Six owned restricted services did not pass'
    [IO.File]::WriteAllText((Join-Path $run 'services.json'),($services | ConvertTo-Json -Depth 4))
    $listeners=@(Get-NetTCPConnection -State Listen | Where-Object {@(15432,18080,18081,18082,8080) -contains $_.LocalPort} | Select-Object LocalAddress,LocalPort,OwningProcess)
    Assert ($listeners.Count -eq 5 -and !@($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count) 'Private listeners did not stay local'
    [IO.File]::WriteAllText((Join-Path $run 'listeners.json'),($listeners | ConvertTo-Json))
    $report.sixServicesVerified=$true;$report.listenersLocalOnly=$true
    Stop-Writers
    Database-Proof $candidate 'after-services'
    $after=Preserved-Inventory
    foreach($entry in $preserved){$current=@($after | Where-Object path -CEQ $entry.path);Assert ($current.Count -eq 1 -and $current[0].hash -ceq $entry.hash -and $current[0].sddl -ceq $entry.sddl) 'Existing secret, artifact, snapshot or permission changed'}
    $report.secretsArtifactsSnapshotsPreserved=$true;$report.databasePermissionsPreserved=$true;$report.existingDataVerified=$true
    $rollback=Get-Content -LiteralPath (Join-Path $base 'evidence\native-maintenance.json') -Raw | ConvertFrom-Json
    Assert ($rollback.rolledBack -and $rollback.restrictedDatabaseRestore -and $rollback.artifactPermissionsRestored -and $rollback.servicesRestartedAfterRestore) 'Prior rollback evidence missing'
    $report.rollbackEvidenceRetained=$true;$report.losslessRollbackVerified=$true
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'healthy'
    Set-NativeServiceStartup $candidate $context.Data
    $startup=@(Get-CimInstance Win32_Service | Where-Object {$names -contains $_.Name} | Select-Object Name,StartMode)
    Assert (!@($startup | Where-Object {($_.Name -ceq 'JosiVoice' -and $_.StartMode -cne 'Manual') -or ($_.Name -cne 'JosiVoice' -and $_.StartMode -cne 'Auto')}).Count) 'Activated startup modes did not pass'
    $report.startupPolicyVerified=$true
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'committed'
    $report.upgradeCommitted=$true;$report.candidateAccepted=$true;$report.acceptanceScope='unsigned physical .5 engineering candidate; not release approval';$report.passed=$true
    Step 'Bounded lossless repair and one physical .5 upgrade accepted. Preserve rollback material and stop services.'
}catch{
    $report.failureFile=$_.InvocationInfo.ScriptName;$report.failureLine=$_.InvocationInfo.ScriptLineNumber;$report.failureCode=$_.Exception.HResult
    Step ('Stopped at '+$report.failureFile+':'+$report.failureLine+'. No data restore or automatic retry.')
}finally{
    if($registered){foreach($name in @('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb','JosiDatabase')){try{Stop-NativeService $name}catch{Step ('Service stop requires review: '+$name)}}}
    $report.servicesStopped=!@(Get-Service -Name $names -ErrorAction SilentlyContinue | Where-Object Status -ne 'Stopped').Count
    if($lock){$lock.Handle.Dispose()}
    $report.recordedAt=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $run 'result.json'),($report | ConvertTo-Json -Depth 5))
}
if(!$report.passed -or !$report.servicesStopped){exit 1}
