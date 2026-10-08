# Physical SCM acceptance. Launch with OS PowerShell 5.1 and UAC.
# This is an unsigned local engineering test, not a release installer.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OriginalUserSid,[string]$ReuseInstallationId='', [switch]$RestartFailedInitialization)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$module=Join-Path $repo 'packaging\windows'
Import-Module (Join-Path $module 'Services.psm1')
Import-Module (Join-Path $module 'DataLayout.psm1')
Import-Module (Join-Path $module 'Configuration.psm1')
Import-Module (Join-Path $module 'Database.psm1')
Import-Module (Join-Path $module 'Payloads.psm1')
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Approve Windows administrator access to run service acceptance'}
if($OriginalUserSid -cnotmatch '^S-1-5-21-(?:\d+-){3}\d+$'){throw 'Original Windows user identity is invalid'}
$build=Get-Content -LiteralPath (Join-Path $base 'evidence\application-build.json') -Raw | ConvertFrom-Json
$runtimes=Get-Content -LiteralPath (Join-Path $base 'evidence\runtime-build.json') -Raw | ConvertFrom-Json
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server'
$product=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Josi CE Server'
$program=Join-Path $product ('versions\'+$build.version)
$installationId=[Guid]::NewGuid().ToString('N')
$run=Join-Path $base ('test-installations\scm-'+$installationId)
[Josi.NativeSetup.PrivateDirectory]::Create($run,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;'+$OriginalUserSid+')'))
$log=Join-Path $run 'acceptance.log'
$report=[ordered]@{schemaVersion=1;passed=$false;installationId=$installationId;version=$build.version;root=$run;
    servicesInstalled=$false;databaseInitializedAsService=$false;restrictedDatabaseRole=$false;scmLifecycleTested=$false;
    actualVoiceScmControl=$false;allListenersLoopback=$false;servicesRemoved=$false;dataPreserved=$true;
    explicitWorkerAntivirusProbe=$false;workerAntivirusStatus='not-tested';
    browserSetupCompleted=$false;physicalMicrophoneTested=$false;rebootTested=$false;time=[DateTime]::UtcNow.ToString('o')}
$registered=$false;$layout=$false
function Step([string]$Text){[IO.File]::AppendAllText($log,([DateTime]::UtcNow.ToString('o')+' '+$Text+"`r`n"))}
function Assert([bool]$Condition,[string]$Text){if(!$Condition){throw $Text}}
function Copy-VerifiedTree([string]$Source,[string]$Inventory){
    $source=Assert-PlainNativePath $Source
    $entries=Get-Content -LiteralPath $Inventory -Raw | ConvertFrom-Json
    $seen=@{}
    foreach($entry in $entries){
        Assert ($entry.path -is [string] -and $entry.path -cnotmatch '(^/|\\|:|(^|/)\.\.(/|$)|[\x00-\x1f])') 'Payload file name is invalid'
        Assert (!$seen.ContainsKey($entry.path.ToLowerInvariant())) 'Duplicate payload file'
        $seen[$entry.path.ToLowerInvariant()]=$true
        $inputPath=Assert-PlainNativePath (Join-Path $source $entry.path)
        $outputPath=Assert-PlainNativePath (Join-Path $program $entry.path)
        Assert ($outputPath.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase)) 'Payload escaped the private program folder'
        Assert ((Get-Item -LiteralPath $inputPath).Length -eq $entry.size -and
            (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Source payload verification failed'
        $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath))
        Assert (!(Test-Path -LiteralPath $outputPath)) 'Independent payloads overlap'
        [IO.File]::Copy($inputPath,$outputPath,$false)
        Assert ((Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Copied payload verification failed'
    }
}
function Verify-InstalledTree([string]$Inventory){
    $entries=Get-Content -LiteralPath $Inventory -Raw | ConvertFrom-Json
    foreach($entry in $entries){
        Assert ($entry.path -is [string] -and $entry.path -cnotmatch '(^/|\\|:|(^|/)\.\.(/|$)|[\x00-\x1f])') 'Payload inventory name is invalid'
        $path=[IO.Path]::GetFullPath((Join-Path $program $entry.path))
        Assert ($path.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase)) 'Payload inventory escaped the installation'
        $item=Get-Item -LiteralPath $path -Force
        Assert (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Length -eq $entry.size -and
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Preserved runtime verification failed'
    }
}
function Run-PrivateNode([string]$Entry,[string[]]$Arguments,[string]$Label){
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=Join-Path $program 'node\JosiRuntime.exe'
    $info.Arguments=(@($Entry)+$Arguments | ForEach-Object {'"'+$_+'"'}) -join ' '
    $info.WorkingDirectory=Join-Path $program 'app'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear()
    foreach($pair in @(@('SystemRoot',$env:SystemRoot),@('WINDIR',$env:SystemRoot),@('PATH',(Join-Path $env:SystemRoot 'System32')),
        @('TEMP',(Join-Path $data 'temp\migrate')),@('TMP',(Join-Path $data 'temp\migrate')))){$info.EnvironmentVariables[$pair[0]]=$pair[1]}
    $process=[Diagnostics.Process]::Start($info)
    $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
    if(!$process.WaitForExit(180000)){$process.Kill();throw 'Private maintenance operation timed out'}
    # Fixed entries emit redacted status. Raw SQL/credentials never enter logs.
    [IO.File]::WriteAllText((Join-Path $run ($Label+'.out')),$out.Result)
    [IO.File]::WriteAllText((Join-Path $run ($Label+'.err')),$err.Result)
    Assert ($process.ExitCode -eq 0) 'Private maintenance operation failed'
    $process.Dispose()
}
function Wait-Http([string]$Url,[int]$Expected=200,[int]$Seconds=180){
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        try{$response=Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5;if($response.StatusCode -eq $Expected){return}}catch{}
        Start-Sleep -Milliseconds 500
    }while([DateTime]::UtcNow -lt $deadline)
    throw 'Private service readiness timed out'
}
try {
    Step 'Preflight standard folders, fixed service names and private ports.'
    $plan=Get-NativeServicePlan $program $data
    foreach($service in $plan){Assert (!(Get-Service -Name $service.Name -ErrorAction SilentlyContinue)) 'A pre-existing service must be preserved'}
    $priorProcesses=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase)})
    Assert (!$priorProcesses.Count) 'An earlier private runtime process must be stopped before test recovery'
    if($ReuseInstallationId){
        Assert ($ReuseInstallationId -cmatch '^[a-f0-9]{32}$') 'Prior test identity is invalid'
        $programMarker=Get-Content -LiteralPath (Join-Path $product 'installation.json') -Raw | ConvertFrom-Json
        $dataMarker=Get-Content -LiteralPath (Join-Path $data 'installation.json') -Raw | ConvertFrom-Json
        Assert ($programMarker.installationId -ceq $ReuseInstallationId -and $programMarker.purpose -ceq 'native-service-acceptance' -and
            $dataMarker.installationId -ceq $ReuseInstallationId -and $dataMarker.product -ceq 'Josi CE Server') 'Preserved folders do not belong to that test'
        if($RestartFailedInitialization){
            $prior=Get-Content -LiteralPath (Join-Path $base 'evidence\native-services.json') -Raw | ConvertFrom-Json
            Assert ($prior.installationId -ceq $ReuseInstallationId -and !$prior.passed -and $prior.servicesRemoved -and
                !$prior.databaseInitializedAsService -and !$prior.restrictedDatabaseRole) 'Only a failed, unprovisioned synthetic test may be retried'
            Assert (Test-Path -LiteralPath (Join-Path $data 'secrets\init-password')) 'An application database must not be reinitialized'
            foreach($name in @('JosiDatabase.out.log','JosiDatabase.err.log','JosiDatabase.wrapper.log')){
                $path=Join-Path $data ('logs\JosiDatabase\'+$name)
                if(Test-Path -LiteralPath $path){
                    Assert ((Get-Item -LiteralPath $path).Length -le 8MB -and [Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path)) 'Initializer log is invalid'
                    [IO.File]::Copy($path,(Join-Path $run ('prior-'+$name)),$false)
                }
            }
            $cluster=Assert-PlainNativePath (Join-Path $data 'database')
            if(@(Get-ChildItem -LiteralPath $cluster -Force).Count){
                $retained=Assert-PlainNativePath (Join-Path $data ('snapshots\failed-init-'+$installationId))
                Assert ($cluster -ieq (Join-Path $data 'database') -and $retained.StartsWith($data+'\snapshots\',[StringComparison]::OrdinalIgnoreCase)) 'Synthetic cluster recovery paths are invalid'
                [IO.Directory]::Move($cluster,$retained)
                $policy=Get-NativeDataPolicy
                [Josi.NativeSetup.PrivateDirectory]::Create($cluster,(Get-NativeDirectoryDescriptor $policy.Directories['database']))
                Step 'Retained the failed synthetic initialization under protected snapshots; created an empty test cluster folder.'
            }
        }
        Assert (!@(Get-ChildItem -LiteralPath (Join-Path $data 'database') -Force).Count) 'This retry refuses an initialized database'
        Verify-InstalledTree (Join-Path $build.build 'reports\payload-inventory.json')
        Verify-InstalledTree (Join-Path $runtimes.reports 'file-inventory.json')
        $report.installationId=$ReuseInstallationId
    }else{Assert (!(Test-Path -LiteralPath $data) -and !(Test-Path -LiteralPath $product)) 'Existing native installation must be preserved'}
    foreach($port in @(15432,18080,18081,18082,8080)){
        $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
        try{$probe.Start()}finally{$probe.Stop()}
    }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($product))
    Assert ($drive.AvailableFreeSpace -gt 10GB) 'Insufficient disk space for service acceptance'
    if(!$ReuseInstallationId){
    Step 'Create protected program folder; copy and rehash private payloads.'
    [Josi.NativeSetup.PrivateDirectory]::Create($product,'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)')
    $null=[IO.Directory]::CreateDirectory($program)
    [IO.File]::WriteAllText((Join-Path $product 'installation.json'),('{"installationId":"'+$installationId+'","purpose":"native-service-acceptance"}'))
    Copy-VerifiedTree $build.payload (Join-Path $build.build 'reports\payload-inventory.json')
    Copy-VerifiedTree $runtimes.payload (Join-Path $runtimes.reports 'file-inventory.json')
    New-NativeDataLayout $data $installationId
    $layout=$true
    $null=New-NativeInitialConfiguration $program $data $build.version $OriginalUserSid
    }
    $wrapper=Join-Path $base 'cache\WinSW.Josi-2.12.0-windows1.exe'
    $null=Write-NativeServiceFiles $program $data $wrapper
    $null=Register-NativeServices $program $data
    $registered=$true;$report.servicesInstalled=$true
    Step 'Initialize the database as NT SERVICE\JosiDatabase.'
    Invoke-NativeDatabaseInitialization $program $data $wrapper
    $report.databaseInitializedAsService=$true
    Start-Service JosiDatabase
    Run-PrivateNode (Join-Path $program 'app\native\DatabaseBootstrap.mjs') @((Join-Path $data 'config\runtime.json')) 'database-bootstrap'
    $report.restrictedDatabaseRole=$true
    Run-PrivateNode (Join-Path $program 'app\native\Runtime.mjs') @('migrate',(Join-Path $data 'config\runtime.json')) 'migrations'
    Step 'Start the private API, worker, proxy and speech control services.'
    foreach($name in @('JosiWeb','JosiWorker','JosiProxy','JosiVoiceControl')){Start-Service $name}
    $workerStarted=[DateTime]::UtcNow
    Wait-Http 'http://127.0.0.1:18080/ready'
    Wait-Http 'http://localhost:8080/ready'
    $antivirusPath=Assert-PlainNativePath (Join-Path $data 'state\antivirus.json')
    $probeDeadline=[DateTime]::UtcNow.AddMinutes(1)
    $antivirus=$null
    do {
        if(Test-Path -LiteralPath $antivirusPath){
            Assert ([Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($antivirusPath) -and (Get-Item -LiteralPath $antivirusPath).Length -le 4096) 'The worker antivirus probe is unsafe'
            $candidate=Get-Content -LiteralPath $antivirusPath -Raw | ConvertFrom-Json
            if([DateTime]::Parse($candidate.checkedAt).ToUniversalTime() -ge $workerStarted.AddSeconds(-5)){$antivirus=$candidate;break}
        }
        Start-Sleep -Milliseconds 250
    }while([DateTime]::UtcNow -lt $probeDeadline)
    Assert ($antivirus -and $antivirus.provider -ceq 'windows-amsi' -and $antivirus.status -cin @('available','error','unavailable')) 'The worker did not publish an explicit antivirus request result'
    $report.explicitWorkerAntivirusProbe=$true
    $report.workerAntivirusStatus=$antivirus.status
    $controlToken=[IO.File]::ReadAllText((Join-Path $data 'secrets\voice-control-token'))
    $headers=@{Authorization=('Bearer '+$controlToken)}
    $status=$null
    $deadline=[DateTime]::UtcNow.AddMinutes(3)
    do {
        try{$status=Invoke-RestMethod -Uri 'http://127.0.0.1:18082/status' -Headers $headers -TimeoutSec 5;if($status.healthy){break}}catch{}
        Start-Sleep -Milliseconds 500
    }while([DateTime]::UtcNow -lt $deadline)
    Assert ($status.healthy -eq $true -and (Get-Service JosiVoice).Status -eq 'Running') 'Speech control did not start its restricted SCM service'
    $report.actualVoiceScmControl=$true
    Step 'Restart services through Windows and verify readiness again.'
    foreach($name in @('JosiWorker','JosiWeb','JosiProxy')){
        Stop-NativeService $name
        Start-Service $name
    }
    Wait-Http 'http://localhost:8080/ready'
    $report.scmLifecycleTested=$true
    $ports=@(15432,18080,18081,18082,8080)
    $listeners=@(Get-NetTCPConnection -State Listen | Where-Object {$ports -contains $_.LocalPort} | Select-Object LocalAddress,LocalPort,OwningProcess)
    Assert ($listeners.Count -eq 5 -and !@($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count) 'An internal listener escaped loopback'
    $report.allListenersLoopback=$true
    $listeners | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'listeners.json') -Encoding UTF8
    $services=@(Get-CimInstance Win32_Service | Where-Object {$plan.Name -contains $_.Name} | Select-Object Name,State,StartMode,StartName,PathName,ProcessId)
    foreach($service in $services){Assert ($service.StartName -ieq ('NT SERVICE\'+$service.Name)) 'A service ran as an administrator or interactive user'}
    $services | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'services.json') -Encoding UTF8
    $processes=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase)} | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)
    $processes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'processes.json') -Encoding UTF8
    $modules=@(Get-Process -Id $processes.ProcessId | ForEach-Object {$processId=$_.Id;$_.Modules | ForEach-Object {[pscustomobject]@{processId=$processId;name=$_.ModuleName;path=$_.FileName}}})
    foreach($item in $modules){
        $allowed=$item.path.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase) -or $item.path.StartsWith($env:SystemRoot+'\',[StringComparison]::OrdinalIgnoreCase)
        if(!$allowed -and $item.name -match '^(MpOAV|MpClient)\.dll$' -and $item.path.StartsWith((Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform')+'\',[StringComparison]::OrdinalIgnoreCase)){
            $signature=Get-AuthenticodeSignature -LiteralPath $item.path
            $allowed=$signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'Microsoft'
        }
        Assert $allowed 'A service loaded a non-private runtime library'
        if($item.name -match '^(vcruntime140(?:_1)?|msvcp140|vcomp140)\.dll$'){Assert ($item.path.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase)) 'A global C++ runtime was required'}
    }
    $modules | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'modules.json') -Encoding UTF8
    $report.passed=$true
    Step 'Service acceptance passed. Stop and revoke only this test registration; retain data for recovery.'
} catch {
    # No raw exception text or parameter values. Exact source line is sufficient
    # to investigate using the protected service logs without leaking secrets.
    Step ('Service acceptance failed at '+$_.InvocationInfo.ScriptName+':'+$_.InvocationInfo.ScriptLineNumber+'. Stack: '+$_.ScriptStackTrace)
    if($_.Exception.Message -like 'Josi service registration failed for *'){Step $_.Exception.Message}
    $report.failureLine=$_.InvocationInfo.ScriptLineNumber
} finally {
    $controlToken=$null;$headers=$null
    if($registered){
        foreach($name in @('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb','JosiDatabase')){
            $service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
            if($service -and $service.StartName -ieq ('NT SERVICE\'+$name) -and $service.PathName.Contains($program)){
                try{Stop-NativeService $name}catch{}
                & (Join-Path $env:SystemRoot 'System32\sc.exe') delete $name | Out-Null
            }
        }
        $report.servicesRemoved=!@(Get-Service -Name $plan.Name -ErrorAction SilentlyContinue).Count
    }
    $report.time=[DateTime]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $run 'result.json') -Encoding UTF8
    # Public summary contains paths/results only. Secret-containing files remain
    # protected under ProgramData and are never copied into diagnostic output.
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $base 'evidence\native-services.json') -Encoding UTF8
}
if(!$report.passed -or !$report.servicesRemoved){exit 1}
