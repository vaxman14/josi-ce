# Immutable, hash-chained recovery checkpoints. This records installer intent
# and verified completion; it does not infer success from a launched process.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Payloads.psm1')
$script:Phases=@{
    install=@('prepared','verified','data-created','services-created','database-ready','migrated','activated','healthy','committed');
    upgrade=@('prepared','verified','quiesced','backup-verified','migrated','activated','healthy','committed');
    repair=@('prepared','verified','quiesced','repaired','activated','healthy','committed');
    uninstall=@('prepared','quiesced','runtime-removed','committed')
}
$script:Categories=@('none','cancelled','interrupted','download','integrity','disk','permissions','service','database','migration','health','backup','unknown')

function Get-RecordHash([byte[]]$Bytes){
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose()}
}

function Assert-JournalRecord($Value){
    $fields=@('schemaVersion','installationId','transactionId','operation','fromVersion','toVersion','manifestSha256','sequence','phase','category','previousSha256','recordedAt')
    if(@($Value.PSObject.Properties).Count -ne $fields.Count){throw 'Recovery record has unexpected fields'}
    foreach($name in $fields){if(!$Value.PSObject.Properties[$name]){throw 'Recovery record is incomplete'}}
    if($Value.schemaVersion -ne 1 -or $Value.installationId -cnotmatch '^[a-f0-9]{32}$' -or
        $Value.transactionId -cnotmatch '^[a-f0-9]{32}$' -or !$script:Phases.ContainsKey($Value.operation) -or
        $Value.fromVersion -cnotmatch '^(none|\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)$' -or
        $Value.toVersion -cnotmatch '^(none|\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)$' -or
        $Value.manifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or $Value.previousSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $Value.sequence -isnot [int] -or $Value.sequence -lt 1 -or $Value.sequence -gt 1000 -or
        $Value.category -cnotin $script:Categories -or
        $Value.phase -cnotin @($script:Phases[$Value.operation]+@('recovery-required','rolling-back','rolled-back')) -or
        $Value.recordedAt -cnotmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$'){
        throw 'Recovery record identity is invalid'
    }
    if(($Value.operation -eq 'install' -and $Value.fromVersion -ne 'none') -or
        ($Value.operation -eq 'uninstall' -and $Value.toVersion -ne 'none') -or
        ($Value.operation -ne 'install' -and $Value.fromVersion -eq 'none') -or
        ($Value.operation -ne 'uninstall' -and $Value.toVersion -eq 'none')){throw 'Recovery operation versions are invalid'}
}

function Assert-JournalTransition($Prior,[string]$Phase,[string]$Category){
    if($Prior.phase -in @('committed','rolled-back')){throw 'The transaction has already ended'}
    if($Phase -eq 'recovery-required'){
        if($Category -eq 'none'){throw 'Recovery requires a fixed failure category'}
        return
    }
    if($Phase -eq 'rolling-back' -and $Prior.phase -eq 'recovery-required' -and $Category -eq 'none'){return}
    if($Phase -eq 'rolled-back' -and $Prior.phase -eq 'rolling-back' -and $Category -eq 'none'){return}
    $order=$script:Phases[$Prior.operation]
    $index=[Array]::IndexOf($order,$Prior.phase)
    if($index -lt 0 -or $index+1 -ge $order.Count -or $order[$index+1] -cne $Phase -or $Category -ne 'none'){
        throw 'Recovery checkpoint is out of order'
    }
}

function Read-NativeTransaction([string]$Directory){
    $directory=Assert-PlainNativePath $Directory
    # Supplemental redacted diagnostics are not journal checkpoints. Checkpoint
    # sequence/hash validation remains strict and still catches missing records.
    $records=@(Get-ChildItem -LiteralPath $directory -File -Filter '*.json' | Where-Object {$_.Name -cne 'failure-summary.json'} | Sort-Object Name)
    if(!$records.Count){throw 'Recovery journal contains no published checkpoint'}
    $previous=$null; $hash='0'*64; $sequence=1
    foreach($file in $records){
        if($file.Name -cne ('{0:d4}.json' -f $sequence) -or $file.Length -gt 8192 -or $file.Length -eq 0){throw 'Recovery journal is truncated or out of sequence'}
        $null=Assert-PlainNativePath $file.FullName
        $bytes=[IO.File]::ReadAllBytes($file.FullName)
        $record=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        Assert-JournalRecord $record
        if($record.sequence -ne $sequence -or $record.previousSha256 -cne $hash){throw 'Recovery checkpoint hash chain is invalid'}
        if($previous){
            foreach($field in @('installationId','transactionId','operation','fromVersion','toVersion','manifestSha256')){
                if($record.$field -cne $previous.$field){throw 'Recovery transaction identity changed'}
            }
            Assert-JournalTransition $previous $record.phase $record.category
        }elseif($record.phase -ne 'prepared' -or $record.category -ne 'none'){throw 'Recovery journal must begin before mutation'}
        $hash=Get-RecordHash $bytes; $previous=$record; $sequence++
    }
    return [pscustomobject]@{Record=$previous;Sha256=$hash;Directory=$directory}
}

function Open-NativeTransactionLock([string]$Root){
    $root=Assert-PlainNativePath $Root
    if(!(Test-Path -LiteralPath $root -PathType Container)){throw 'The protected transaction folder is missing'}
    $path=Assert-PlainNativePath (Join-Path $root 'lifecycle.lock')
    try{$handle=[IO.FileStream]::new($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch{throw 'Another Josi installation or recovery operation is already running'}
    return [pscustomobject]@{Root=$root;Handle=$handle}
}

function Assert-JournalLock($Lock,[string]$Directory){
    if(!$Lock.Handle.CanWrite -or [IO.Path]::GetDirectoryName($Directory) -cne $Lock.Root){throw 'An exclusive lifecycle lock is required'}
}

function Publish-JournalRecord($Lock,[string]$Directory,$Record){
    Assert-JournalLock $Lock $Directory
    Assert-JournalRecord $Record
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Record | ConvertTo-Json -Compress)+"`n")
    $name='{0:d4}.json' -f $Record.sequence
    $destination=Join-Path $Directory $name
    $pending=Join-Path $Directory ($name+'.'+[Guid]::NewGuid().ToString('N')+'.pending')
    $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    [Josi.NativeSetup.DurableFile]::Publish($pending,$destination)
    return Read-NativeTransaction $Directory
}

function New-NativeTransaction($Lock,[string]$InstallationId,[string]$Operation,[string]$FromVersion,[string]$ToVersion,[string]$ManifestHash){
    # Never start a second mutation while an earlier transaction is incomplete.
    foreach($folder in Get-ChildItem -LiteralPath $Lock.Root -Directory){
        if($folder.Name -cnotmatch '^[a-f0-9]{32}$'){throw 'Unexpected content in the protected transaction folder'}
        $path=Assert-PlainNativePath $folder.FullName
        Assert-JournalLock $Lock $path
        $children=@(Get-ChildItem -LiteralPath $path -Force)
        if(!@($children | Where-Object {$_.Name -like '*.json'}).Count){
            # Nothing may mutate the installation before prepared is durable.
            # A crash during first publication can leave only these temporary
            # files, or an empty folder. Validate the entire set before deleting
            # any item; never recurse or treat unknown content as ours.
            foreach($child in $children){
                if($child.PSIsContainer -or $child.Name -cnotmatch '^0001\.json\.[a-f0-9]{32}\.pending$'){
                    throw 'An unpublished transaction contains unexpected files'
                }
                $null=Assert-PlainNativePath $child.FullName
            }
            foreach($child in $children){[IO.File]::Delete($child.FullName)}
            [IO.Directory]::Delete($path,$false)
            continue
        }
        $prior=Read-NativeTransaction $folder.FullName
        if($prior.Record.phase -notin @('committed','rolled-back')){throw 'An interrupted Josi transaction requires recovery before another operation'}
    }
    $id=[Guid]::NewGuid().ToString('N')
    $directory=Join-Path $Lock.Root $id
    $record=[pscustomobject][ordered]@{schemaVersion=1;installationId=$InstallationId;transactionId=$id;operation=$Operation;
        fromVersion=$FromVersion;toVersion=$ToVersion;manifestSha256=$ManifestHash;sequence=1;phase='prepared';category='none';
        previousSha256=('0'*64);recordedAt=[DateTime]::UtcNow.ToString('o')}
    Assert-JournalRecord $record
    Assert-JournalLock $Lock $directory
    $null=[IO.Directory]::CreateDirectory($directory)
    return Publish-JournalRecord $Lock $directory $record
}

function Set-NativeTransactionPhase($Lock,[string]$Directory,[string]$Phase,[string]$Category='none'){
    Assert-JournalLock $Lock $Directory
    $prior=Read-NativeTransaction $Directory
    Assert-JournalTransition $prior.Record $Phase $Category
    $record=$prior.Record
    $record.sequence++; $record.phase=$Phase; $record.category=$Category
    $record.previousSha256=$prior.Sha256; $record.recordedAt=[DateTime]::UtcNow.ToString('o')
    return Publish-JournalRecord $Lock $Directory $record
}

Export-ModuleMember -Function Open-NativeTransactionLock, New-NativeTransaction, Read-NativeTransaction, Set-NativeTransactionPhase
