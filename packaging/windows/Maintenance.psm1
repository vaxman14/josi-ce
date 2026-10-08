# Fixed offline backup/restore operations for the lifecycle host. The host must
# verify payloads before creating a context; services stay stopped until restore
# and all per-service filesystem permissions have completed.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Payloads.psm1')
Import-Module (Join-Path $PSScriptRoot 'Services.psm1')
Import-Module (Join-Path $PSScriptRoot 'DataLayout.psm1')
Import-Module (Join-Path $PSScriptRoot 'Transactions.psm1')

function Get-NativeMaintenanceContext([string]$InstallationId,[string]$Version,[string]$ToolsVersion=''){
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator approval is required for installation recovery'}
    if($InstallationId -cnotmatch '^[a-f0-9]{32}$' -or $Version -cnotmatch '^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$'){throw 'Invalid maintenance identity'}
    if(!$ToolsVersion){$ToolsVersion=$Version}
    if($ToolsVersion -cnotmatch '^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$'){throw 'Invalid verified maintenance tool version'}
    $product=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Josi CE Server')
    $data=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server')
    foreach($path in @((Join-Path $product 'installation.json'),(Join-Path $data 'installation.json'))){
        if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path) -or (Get-Item -LiteralPath $path).Length -gt 4096){throw 'Unsafe installation ownership marker'}
        $marker=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if($marker.installationId -cne $InstallationId){throw 'Recovery refuses an unrelated installation'}
        if($path -ieq (Join-Path $data 'installation.json') -and ($marker.schemaVersion -ne 1 -or $marker.product -cne 'Josi CE Server')){throw 'Recovery data ownership is invalid'}
    }
    $program=Assert-PlainNativePath (Join-Path $product ('versions\'+$ToolsVersion))
    $metadataPath=Assert-PlainNativePath (Join-Path $program 'app\package.json')
    if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($metadataPath) -or (Get-Item -LiteralPath $metadataPath).Length -gt 4096){throw 'Maintenance runtime metadata is unsafe'}
    $metadata=Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if($metadata.name -cne 'josi-ce-native-runtime' -or $metadata.version -cne $ToolsVersion){throw 'Maintenance version does not match the private runtime'}
    return [pscustomobject]@{InstallationId=$InstallationId;Version=$Version;ToolsVersion=$ToolsVersion;Program=$program;Data=$data;
        DatabaseProgram=(Assert-PlainNativePath (Join-Path $product ('versions\'+$Version)))}
}

function Assert-NativeMaintenanceQuiesced($Context,$Lock,[string]$Directory,[string[]]$Phases){
    $context=Get-NativeMaintenanceContext $Context.InstallationId $Context.Version $Context.ToolsVersion
    if(!$Lock.Handle.CanWrite -or $Lock.Root -ine (Join-Path $context.Data 'transactions') -or
        [IO.Path]::GetDirectoryName((Assert-PlainNativePath $Directory)) -ine $Lock.Root){throw 'The protected lifecycle lock is required for recovery'}
    $journal=Read-NativeTransaction $Directory
    if($journal.Record.installationId -cne $context.InstallationId -or $journal.Record.fromVersion -cne $context.Version -or
        $journal.Record.operation -cne 'upgrade' -or $journal.Record.phase -cnotin $Phases){throw 'Maintenance does not match the current recovery checkpoint'}
    if($context.ToolsVersion -cne $context.Version -and $context.ToolsVersion -cne $journal.Record.toVersion){throw 'Maintenance tools are not the verified transaction target'}
    foreach($name in @('JosiWeb','JosiWorker','JosiProxy','JosiVoice','JosiVoiceControl')){
        $service=Get-Service -Name $name -ErrorAction SilentlyContinue
        if(!$service -or $service.Status -ne 'Stopped'){throw 'All application writers must be stopped before snapshot maintenance'}
    }
    $database=Get-CimInstance Win32_Service -Filter "Name='JosiDatabase'"
    if(!$database -or $database.State -ne 'Running' -or $database.StartName -ine 'NT SERVICE\JosiDatabase' -or
        !$database.PathName.Contains($context.DatabaseProgram+'\postgresql\bin\pg_ctl.exe')){throw 'The owned private database must be running for snapshot maintenance'}
    return [pscustomobject]@{Context=$context;Journal=$journal}
}

function Invoke-NativeSnapshotEntry($Context,[string]$Operation,[string]$SnapshotId,[string]$Hash='',[string]$Attempt=''){
    if($Operation -cnotin @('create','restore','verify') -or $SnapshotId -cnotmatch '^[a-f0-9]{32}$' -or
        ($Operation -cne 'create' -and $Hash -cnotmatch '^[a-f0-9]{64}$') -or
        ($Operation -ceq 'restore' -and $Attempt -cnotmatch '^[a-f0-9]{32}$')){throw 'Invalid fixed snapshot operation'}
    $arguments=@((Join-Path $Context.Program 'app\native\Snapshot.mjs'),$Operation,(Join-Path $Context.Data 'config\runtime.json'),$SnapshotId)
    if($Operation -ceq 'restore'){$arguments+=@($Hash,$Attempt)}
    elseif($Operation -ceq 'verify'){$arguments+=@($Hash)}
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=Join-Path $Context.Program 'node\JosiRuntime.exe'
    $info.Arguments=($arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' '
    $info.WorkingDirectory=Join-Path $Context.Program 'app'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.EnvironmentVariables.Clear()
    foreach($pair in @(@('SystemRoot',$env:SystemRoot),@('WINDIR',$env:SystemRoot),@('PATH',(Join-Path $env:SystemRoot 'System32')),
        @('TEMP',(Join-Path $Context.Data 'temp\migrate')),@('TMP',(Join-Path $Context.Data 'temp\migrate')))){$info.EnvironmentVariables[$pair[0]]=$pair[1]}
    $process=[Diagnostics.Process]::Start($info)
    try{
        $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
        if(!$process.WaitForExit(180000)){$process.Kill();throw 'Private snapshot maintenance timed out; retained recovery material requires retry'}
        if($process.ExitCode -ne 0 -or $out.Result.Length -gt 8192){throw 'Private snapshot maintenance failed; no recovery success is inferred'}
        return ($out.Result | ConvertFrom-Json)
    }finally{$process.Dispose()}
}

function New-NativeMaintenanceSnapshot($Context,$Lock,[string]$Directory){
    $verified=Assert-NativeMaintenanceQuiesced $Context $Lock $Directory @('quiesced')
    $id=$verified.Journal.Record.transactionId
    $creation=Assert-PlainNativePath (Join-Path $verified.Context.Data ('snapshots\'+$id+'\creation-result.json'))
    if(Test-Path -LiteralPath $creation){
        if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($creation) -or (Get-Item -LiteralPath $creation).Length -gt 4096){throw 'Interrupted snapshot creation record is unsafe'}
        $result=Get-Content -LiteralPath $creation -Raw | ConvertFrom-Json
    }else{$result=Invoke-NativeSnapshotEntry $verified.Context 'create' $id}
    if($result.id -cne $id -or $result.manifestSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Snapshot creation did not publish a verified identity'}
    $manifest=Assert-PlainNativePath (Join-Path $verified.Context.Data ('snapshots\'+$id+'\manifest.json'))
    if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($manifest) -or
        (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $result.manifestSha256){throw 'Snapshot manifest changed before checkpoint publication'}
    $check=Invoke-NativeSnapshotEntry $verified.Context 'verify' $id $result.manifestSha256
    if(!$check.verified -or $check.id -cne $id -or $check.manifestSha256 -cne $result.manifestSha256){throw 'The retained snapshot failed verification before lifecycle promotion'}
    $receipt=[ordered]@{schemaVersion=1;installationId=$verified.Context.InstallationId;transactionId=$id;
        fromVersion=$verified.Context.Version;snapshotId=$id;manifestSha256=$result.manifestSha256;restoreAttemptId=[Guid]::NewGuid().ToString('N')}
    $path=Join-Path $Directory 'snapshot.receipt'
    if(Test-Path -LiteralPath $path){
        if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path) -or (Get-Item -LiteralPath $path).Length -gt 4096){throw 'Interrupted snapshot receipt is unsafe'}
        $prior=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if(@($prior.PSObject.Properties).Count -ne 7 -or $prior.restoreAttemptId -cnotmatch '^[a-f0-9]{32}$'){throw 'Interrupted snapshot receipt is incomplete'}
        foreach($field in @('schemaVersion','installationId','transactionId','fromVersion','snapshotId','manifestSha256')){
            if($prior.$field -cne $receipt[$field]){throw 'Interrupted snapshot receipt changed identity'}
        }
        $receipt.restoreAttemptId=$prior.restoreAttemptId
    }else{
        $pending=$path+'.'+[Guid]::NewGuid().ToString('N')+'.pending'
        $bytes=[Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress))
        $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        [Josi.NativeSetup.DurableFile]::Publish($pending,$path)
    }
    $null=Set-NativeTransactionPhase $Lock $Directory 'backup-verified'
    return [pscustomobject]$receipt
}

function Restore-NativeMaintenanceSnapshot($Context,$Lock,[string]$Directory){
    $verified=Assert-NativeMaintenanceQuiesced $Context $Lock $Directory @('rolling-back')
    $path=Assert-PlainNativePath (Join-Path $Directory 'snapshot.receipt')
    if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path) -or (Get-Item -LiteralPath $path).Length -gt 4096){throw 'Snapshot receipt is missing or unsafe'}
    $receipt=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if(@($receipt.PSObject.Properties).Count -ne 7 -or $receipt.schemaVersion -ne 1 -or
        $receipt.installationId -cne $verified.Context.InstallationId -or $receipt.transactionId -cne $verified.Journal.Record.transactionId -or
        $receipt.snapshotId -cne $receipt.transactionId -or $receipt.fromVersion -cne $verified.Context.Version -or
        $receipt.manifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or $receipt.restoreAttemptId -cnotmatch '^[a-f0-9]{32}$'){throw 'Snapshot receipt does not match this recovery operation'}
    $result=Invoke-NativeSnapshotEntry $verified.Context 'restore' $receipt.snapshotId $receipt.manifestSha256 $receipt.restoreAttemptId
    if(!$result.permissionsPending){throw 'Snapshot restoration did not reach its permission checkpoint'}
    $permissions=Restore-NativeArtifactPermissions $verified.Context.Data
    if(!$permissions.permissionsRestored){throw 'Restored artifact permissions require recovery before service restart'}
    # Activation/configuration and real health remain the caller's responsibility.
    # Only then may it publish rolled-back; this function never restarts writers.
    return [pscustomobject]@{restored=$true;permissionsRestored=$true;snapshotId=$receipt.snapshotId}
}

Export-ModuleMember -Function Get-NativeMaintenanceContext, New-NativeMaintenanceSnapshot, Restore-NativeMaintenanceSnapshot
