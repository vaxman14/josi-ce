# Physical recovery acceptance against the existing initialized synthetic test.
# Never initialize or bootstrap a database here. Requires Windows UAC.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OriginalUserSid)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
foreach($name in @('Payloads','Services','DataLayout','Transactions','Maintenance')){Import-Module (Join-Path $repo ('packaging\windows\'+$name+'.psm1'))}
$installationId='b5a3b94c72624209908a5a965bf6867d'
$baseline='0.1.78-native.2'
$context=Get-NativeMaintenanceContext $installationId $baseline
if($OriginalUserSid -cnotmatch '^S-1-5-21-(?:\d+-){3}\d+$'){throw 'Invalid test report reader'}
$id=[Guid]::NewGuid().ToString('N')
$run=Join-Path $base ('test-installations\maintenance-'+$id)
[Josi.NativeSetup.PrivateDirectory]::Create($run,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;'+$OriginalUserSid+')'))
$log=Join-Path $run 'acceptance.log'
$report=[ordered]@{passed=$false;installationId=$installationId;root=$run;baseline=$baseline;
    candidate='0.1.78-native.5';payloadVerified=$false;liveWriterRefused=$false;verifiedBackup=$false;priorInterruptionRecovered=$false;
    restrictedDatabaseRestore=$false;artifactPermissionsRestored=$false;servicesRestartedAfterRestore=$false;
    rolledBack=$false;upgradeCommitted=$false;secretsPreserved=$false;servicesRemoved=$false;dataPreserved=$true;
    time=[DateTime]::UtcNow.ToString('o')}
$registered=$false;$lock=$null;$transaction=$null;$fixtureReady=$false;$fixtureClean=$false
function Assert([bool]$Value,[string]$Message){if(!$Value){throw $Message}}
function Step([string]$Message){[IO.File]::AppendAllText($log,([DateTime]::UtcNow.ToString('o')+' '+$Message+"`r`n"))}
function Run-Node([string]$Program,[string]$Entry,[string[]]$Arguments){
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=Join-Path $Program 'node\JosiRuntime.exe'
    $info.Arguments=(@($Entry)+$Arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' '
    $info.WorkingDirectory=Join-Path $Program 'app'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear()
    foreach($pair in @(@('SystemRoot',$env:SystemRoot),@('WINDIR',$env:SystemRoot),@('PATH',(Join-Path $env:SystemRoot 'System32')),
        @('TEMP',(Join-Path $context.Data 'temp\migrate')),@('TMP',(Join-Path $context.Data 'temp\migrate')))){$info.EnvironmentVariables[$pair[0]]=$pair[1]}
    $process=[Diagnostics.Process]::Start($info)
    try{
        $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
        if(!$process.WaitForExit(180000)){$process.Kill();throw 'Fixed acceptance operation timed out'}
        Assert ($process.ExitCode -eq 0) 'Fixed acceptance operation failed'
    }finally{$process.Dispose()}
}
function Fixture([string]$Operation){Run-Node $tools.Program (Join-Path $run 'maintenance_fixture.mjs') @($Operation,$tools.Program,$context.Data,$id)}
function Stop-Writers {foreach($name in @('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb')){Stop-NativeService $name}}
function Ready {
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    do{try{if((Invoke-WebRequest 'http://localhost:8080/ready' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200){return}}catch{};Start-Sleep -Milliseconds 400}while([DateTime]::UtcNow -lt $deadline)
    throw 'Service readiness failed after recovery'
}
function Start-Writers {foreach($name in @('JosiWeb','JosiWorker','JosiProxy')){Start-Service $name};Ready}
function Secret-Hashes {
    $values=@{}
    foreach($relative in @('secrets\master-key','secrets\database-password','secrets\voice-control-token','voice\gateway\token')){
        $path=Assert-PlainNativePath (Join-Path $context.Data $relative)
        Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path)) 'An existing secret is unsafe'
        $values[$relative]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    return $values
}
function Verify-Payload([string]$Program,$App,$Runtimes,[bool]$Copy){
    $all=@{}
    foreach($pair in @(@($App.payload,(Join-Path $App.build 'reports\payload-inventory.json')),@($Runtimes.payload,(Join-Path $Runtimes.reports 'file-inventory.json')))){
        $source=Assert-PlainNativePath $pair[0]
        Assert ($source.StartsWith($base+'\staging\',[StringComparison]::OrdinalIgnoreCase)) 'Unrelated staged payload refused'
        foreach($entry in (Get-Content -LiteralPath $pair[1] -Raw | ConvertFrom-Json)){
            Assert ($entry.path -is [string] -and $entry.path -cnotmatch '(^/|\\|:|(^|/)\.\.(/|$)|[\x00-\x1f])' -and
                $entry.path -notmatch 'clamav|clamscan|freshclam|libclam|clamd|JosiDefinitions|windows_scanner|\.cv[dl]$|\.cld$|Dockerfile|compose\.ya?ml$') 'Unsafe or retired payload name'
            Assert (!$all.ContainsKey($entry.path.ToLowerInvariant())) 'Overlapping payload inventory'
            $all[$entry.path.ToLowerInvariant()]=$true
            $input=Assert-PlainNativePath (Join-Path $source $entry.path)
            $output=Assert-PlainNativePath (Join-Path $Program $entry.path)
            Assert ($input.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -and $output.StartsWith($Program+'\',[StringComparison]::OrdinalIgnoreCase)) 'Payload escaped its named root'
            if($Copy -and !(Test-Path -LiteralPath $output)){
                Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($input) -and (Get-Item -LiteralPath $input).Length -eq $entry.size -and
                    (Get-FileHash -LiteralPath $input -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Staged bytes changed'
                $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))
                [IO.File]::Copy($input,$output,$false)
            }
            Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($output) -and (Get-Item -LiteralPath $output).Length -eq $entry.size -and
                (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Installed payload bytes changed'
        }
    }
    # Definitions are generated from fixed installer policy after verification.
    $files=@(Get-ChildItem -LiteralPath $Program -Recurse -File -Force | Where-Object {$_.FullName -notlike ($Program+'\services\*')})
    Assert ($files.Count -eq $all.Count) 'Unlisted installed payload file'
}
function Remove-TestServices([string[]]$Programs){
    foreach($name in @('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb','JosiDatabase')){
        $service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
        if(!$service){continue}
        Assert ($service.StartName -ieq ('NT SERVICE\'+$name) -and @($Programs | Where-Object {$service.PathName.Contains($_+'\')}).Count -eq 1) 'Unrelated service preserved'
        Stop-NativeService $name
        & (Join-Path $env:SystemRoot 'System32\sc.exe') delete $name | Out-Null
        Assert ($LASTEXITCODE -eq 0) 'Owned service removal failed'
    }
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do{if(!@(Get-Service -Name $names -ErrorAction SilentlyContinue).Count){return};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $deadline)
    throw 'Owned service deletion has not completed'
}
$names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
try{
    Step 'Verify owned initialized installation and stage the recovery candidate.'
    Assert (!@(Get-Service -Name $names -ErrorAction SilentlyContinue).Count) 'Existing registrations must be preserved'
    Assert (Test-Path -LiteralPath (Join-Path $context.Data 'database\PG_VERSION')) 'This test requires the existing initialized database'
    Assert (!(Test-Path -LiteralPath (Join-Path $context.Data 'secrets\init-password'))) 'This test refuses unprovisioned initialization'
    $marker=Get-Content -LiteralPath (Join-Path (Split-Path (Split-Path $context.Program -Parent) -Parent) 'installation.json') -Raw | ConvertFrom-Json
    Assert ($marker.purpose -ceq 'native-service-acceptance') 'This is not the synthetic test'
    $config=Get-Content -LiteralPath (Join-Path $context.Data 'config\runtime.json') -Raw | ConvertFrom-Json
    Assert ($config.version -ceq $baseline) 'Baseline activation has changed'
    $secrets=Secret-Hashes
    $app=Get-Content -LiteralPath (Join-Path $base 'evidence\application-build.json') -Raw | ConvertFrom-Json
    $runtimes=Get-Content -LiteralPath (Join-Path $base 'evidence\runtime-build.json') -Raw | ConvertFrom-Json
    $accepted=Get-Content -LiteralPath (Join-Path $base 'evidence\application-runtime.json') -Raw | ConvertFrom-Json
    Assert ($app.version -ceq $report.candidate -and $accepted.passed -and $accepted.version -ceq $app.version -and
        $accepted.applicationSourceHash -ceq $app.sourceInventorySha256 -and $accepted.migrationsBeforeActivation -and $accepted.unactivatedWritersRefused) 'Candidate is not the tested recovery build'
    $candidate=Assert-PlainNativePath (Join-Path (Split-Path $context.Program -Parent) $app.version)
    Assert ($candidate -ieq (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('Josi CE Server\versions\'+$app.version))) 'Candidate version path is invalid'
    $null=[IO.Directory]::CreateDirectory($candidate)
    Verify-Payload $candidate $app $runtimes $true
    $report.payloadVerified=$true
    $tools=Get-NativeMaintenanceContext $installationId $baseline $app.version
    [IO.File]::Copy((Join-Path $PSScriptRoot 'maintenance_fixture.mjs'),(Join-Path $run 'maintenance_fixture.mjs'),$false)
    $wrapper=Join-Path $base 'cache\WinSW.Josi-2.12.0-windows1.exe'
    $null=Write-NativeServiceFiles $candidate $context.Data $wrapper
    $null=Write-NativeServiceFiles $context.Program $context.Data $wrapper
    $null=Register-NativeServices $context.Program $context.Data
    $registered=$true
    Start-Service JosiDatabase
    Start-Writers
    $lock=Open-NativeTransactionLock (Join-Path $context.Data 'transactions')
    foreach($directory in Get-ChildItem -LiteralPath $lock.Root -Directory){
        $prior=Read-NativeTransaction $directory.FullName
        if($prior.Record.phase -cin @('committed','rolled-back')){continue}
        # Recover only the exact earlier failed synthetic upgrade. Do not adopt
        # another transaction or infer health from an interrupted subprocess.
        $failure=Get-Content -LiteralPath (Join-Path $base 'evidence\native-maintenance.json') -Raw | ConvertFrom-Json
        Assert (!$failure.passed -and $failure.rolledBack -and $failure.fixtureRemoved -and $failure.servicesRemoved -and
            $failure.installationId -ceq $installationId -and $prior.Record.installationId -ceq $installationId -and
            $prior.Record.operation -ceq 'upgrade' -and $prior.Record.fromVersion -ceq $baseline -and
            $prior.Record.toVersion -ceq '0.1.78-native.4' -and $prior.Record.phase -ceq 'backup-verified') 'An unrelated interrupted transaction requires separate recovery'
        $old=Get-Content -LiteralPath (Join-Path $base 'evidence\application-build.native4.json') -Raw | ConvertFrom-Json
        $oldTools=Get-NativeMaintenanceContext $installationId $baseline $old.version
        Verify-Payload $oldTools.Program $old $runtimes $false
        Stop-Writers
        $null=Set-NativeTransactionPhase $lock $directory.FullName 'recovery-required' 'interrupted'
        $null=Set-NativeTransactionPhase $lock $directory.FullName 'rolling-back'
        $null=Restore-NativeMaintenanceSnapshot $oldTools $lock $directory.FullName
        Start-Writers
        $null=Set-NativeTransactionPhase $lock $directory.FullName 'rolled-back'
        $report.priorInterruptionRecovered=$true
        Step 'Recovered the earlier interrupted upgrade using its retained verified snapshot and receipt.'
    }
    Fixture 'prepare';$fixtureReady=$true
    foreach($root in @('chat-attachments','roots','versions')){
        $path=Assert-PlainNativePath (Join-Path $context.Data ($root+'\native-maintenance-'+$id+'.txt'))
        [IO.File]::WriteAllText($path,'original')
    }
    $null=Restore-NativeArtifactPermissions $context.Data
    $transaction=New-NativeTransaction $lock $installationId 'upgrade' $baseline $app.version $app.sourceInventorySha256
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'verified'
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'quiesced'
    $rejected=$false
    try{$null=New-NativeMaintenanceSnapshot $tools $lock $transaction.Directory}catch{$rejected=$true}
    Assert $rejected 'Backup accepted live application writers'
    $report.liveWriterRefused=$true
    Step 'Stop writers, verify the offline snapshot, and simulate a failed migration.'
    Stop-Writers
    $receipt=New-NativeMaintenanceSnapshot $tools $lock $transaction.Directory
    Assert ((Read-NativeTransaction $transaction.Directory).Record.phase -ceq 'backup-verified') 'Backup checkpoint was not durable'
    $report.verifiedBackup=$true
    Fixture 'mutate'
    foreach($root in @('chat-attachments','roots','versions')){[IO.File]::WriteAllText((Join-Path $context.Data ($root+'\native-maintenance-'+$id+'.txt')),'changed')}
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'recovery-required' 'migration'
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'rolling-back'
    $result=Restore-NativeMaintenanceSnapshot $tools $lock $transaction.Directory
    Assert ($result.restored -and $result.permissionsRestored) 'Restore did not finish permissions'
    Fixture 'verify'
    $report.restrictedDatabaseRestore=$true
    $expected=@('S-1-5-18','S-1-5-32-544',(Get-NativeServiceSid 'JosiWeb'),(Get-NativeServiceSid 'JosiWorker')) | Sort-Object
    foreach($root in @('chat-attachments','roots','versions')){
        $path=Join-Path $context.Data ($root+'\native-maintenance-'+$id+'.txt')
        Assert ([IO.File]::ReadAllText($path) -ceq 'original') 'Artifact bytes were not restored'
        foreach($item in @((Join-Path $context.Data $root),$path)){
            $acl=Get-Acl -LiteralPath $item
            $actual=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value}) | Sort-Object
            Assert ($acl.AreAccessRulesProtected -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544' -and
                ($actual -join ',') -ceq ($expected -join ',')) 'Restored artifact permissions include unintended authority'
        }
    }
    $report.artifactPermissionsRestored=$true
    Start-Writers
    $report.servicesRestartedAfterRestore=$true
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'rolled-back'
    $report.rolledBack=$true
    Fixture 'cleanup';$fixtureClean=$true
    foreach($root in @('chat-attachments','roots','versions')){[IO.File]::Delete((Join-Path $context.Data ($root+'\native-maintenance-'+$id+'.txt')))}
    Step 'Perform a successful verified upgrade and require real service readiness.'
    $transaction=New-NativeTransaction $lock $installationId 'upgrade' $baseline $app.version $app.sourceInventorySha256
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'verified'
    Stop-Writers
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'quiesced'
    $null=New-NativeMaintenanceSnapshot $tools $lock $transaction.Directory
    Run-Node $candidate (Join-Path $candidate 'app\native\Runtime.mjs') @('migrate',(Join-Path $context.Data 'config\runtime.json'))
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'migrated'
    Remove-TestServices @($context.Program)
    $registered=$false
    $path=Join-Path $context.Data 'config\runtime.json'
    $config.version=$app.version
    $pending=$path+'.'+$id+'.pending'
    $bytes=[Text.Encoding]::UTF8.GetBytes(($config | ConvertTo-Json -Compress))
    $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    [IO.File]::SetAccessControl($pending,[IO.File]::GetAccessControl($path))
    [Josi.NativeSetup.DurableFile]::Replace($pending,$path)
    $null=Register-NativeServices $candidate $context.Data
    $registered=$true
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'activated'
    Start-Service JosiDatabase
    Start-Writers
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'healthy'
    $null=Set-NativeTransactionPhase $lock $transaction.Directory 'committed'
    $report.upgradeCommitted=$true
    $after=Secret-Hashes
    foreach($key in $secrets.Keys){Assert ($secrets[$key] -ceq $after[$key]) 'An existing secret was changed during recovery'}
    $report.secretsPreserved=$true
    $report.passed=$true
    Step 'Physical rollback and upgrade acceptance passed; retain data and recovery material.'
}catch{
    Step ('Failure at '+$_.InvocationInfo.ScriptName+':'+$_.InvocationInfo.ScriptLineNumber+'. Stack: '+$_.ScriptStackTrace)
    $report.failureFile=$_.InvocationInfo.ScriptName;$report.failureLine=$_.InvocationInfo.ScriptLineNumber;$report.failureCode=$_.Exception.HResult
}finally{
    # A failed transaction remains uncommitted, with its receipt and snapshot.
    # Never mark recovered or discard data in this cleanup path.
    if($lock){$lock.Handle.Dispose()}
    if($registered){try{Remove-TestServices @($context.Program,$candidate)}catch{Step 'Owned service cleanup requires retry.'}}
    $report.servicesRemoved=!@(Get-Service -Name $names -ErrorAction SilentlyContinue).Count
    $report.fixtureRemoved=(!$fixtureReady -or $fixtureClean)
    $report.time=[DateTime]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $run 'result.json') -Encoding UTF8
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $base 'evidence\native-maintenance.json') -Encoding UTF8
}
if(!$report.passed -or !$report.servicesRemoved){exit 1}
