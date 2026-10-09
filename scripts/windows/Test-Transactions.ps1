# Execute with OS Windows PowerShell 5.1. No SCM or ProgramData mutations.
param([string]$NativeAssembly='')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if($NativeAssembly){Add-Type -Path $NativeAssembly}
Import-Module (Join-Path $repo 'packaging\windows\Transactions.psm1')
$base=Join-Path $repo 'artifacts\windows-native'
$root=Join-Path $base ('test-installations\transactions-'+[Guid]::NewGuid().ToString('N'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[Josi.NativeSetup.PrivateDirectory]::Create($root,('O:'+$sid+'G:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'))
$script:checks=0
function Reject([scriptblock]$Action){
    $rejected=$false
    try{& $Action | Out-Null}catch{$rejected=$true}
    if(!$rejected){throw 'An invalid recovery operation was accepted'}
    $script:checks++
}
$lock=Open-NativeTransactionLock $root
try{
    $existing=Join-Path $root 'replace-existing'
    $pending=Join-Path $root 'replace-pending'
    [IO.File]::WriteAllText($existing,'old')
    [IO.File]::WriteAllText($pending,'new')
    [Josi.NativeSetup.DurableFile]::Replace($pending,$existing)
    if([IO.File]::ReadAllText($existing) -cne 'new' -or (Test-Path -LiteralPath $pending)){throw 'Atomic configuration replacement failed in OS PowerShell'}
    [IO.File]::Delete($existing)
    Reject {Open-NativeTransactionLock $root}
    Reject {New-NativeTransaction $lock ('1'*32) 'unknown' 'none' '0.1.0' ('a'*64)}
    $empty=Join-Path $root ('8'*32)
    $partial=Join-Path $root ('9'*32)
    $null=[IO.Directory]::CreateDirectory($empty)
    $null=[IO.Directory]::CreateDirectory($partial)
    [IO.File]::WriteAllText((Join-Path $partial ('0001.json.'+('a'*32)+'.pending')),'{"schemaVersion":')
    $install=New-NativeTransaction $lock ('1'*32) 'install' 'none' '0.1.0' ('a'*64)
    if((Test-Path -LiteralPath $empty) -or (Test-Path -LiteralPath $partial)){throw 'An interrupted first checkpoint was not recovered'}
    Reject {Set-NativeTransactionPhase $lock $install.Directory 'activated'}
    Reject {Set-NativeTransactionPhase $lock $install.Directory 'verified' 'a-secret-must-never-be-written'}
    Reject {New-NativeTransaction $lock ('1'*32) 'install' 'none' '0.1.1' ('b'*64)}
    foreach($phase in @('verified','data-created','services-created','database-ready','migrated','activated','healthy','committed')){
        $install=Set-NativeTransactionPhase $lock $install.Directory $phase
    }
    if($install.Record.sequence -ne 9){throw 'Missing install checkpoints'}
    Reject {Set-NativeTransactionPhase $lock $install.Directory 'recovery-required' 'unknown'}
    $upgrade=New-NativeTransaction $lock ('1'*32) 'upgrade' '0.1.0' '0.1.1' ('b'*64)
    foreach($phase in @('verified','quiesced','backup-verified')){
        $upgrade=Set-NativeTransactionPhase $lock $upgrade.Directory $phase
    }
    # A write interrupted before publication cannot promote the durable phase.
    [IO.File]::WriteAllText((Join-Path $upgrade.Directory '0005.json.interrupted.pending'),'{"phase":"migrated"')
    $lock.Handle.Dispose()
    $lock=Open-NativeTransactionLock $root
    $resumed=Read-NativeTransaction $upgrade.Directory
    if($resumed.Record.phase -ne 'backup-verified'){throw 'An incomplete checkpoint was adopted'}
    [IO.File]::WriteAllText((Join-Path $upgrade.Directory 'failure-summary.json'),'{"stage":"service-quiesce","service":"JosiProxy","errorId":"TypeNotFound"}')
    $withSummary=Read-NativeTransaction $upgrade.Directory
    if($withSummary.Sha256 -cne $resumed.Sha256 -or $withSummary.Record.sequence -ne $resumed.Record.sequence){throw 'Supplemental failure evidence changed the journal'}
    $unknown=Join-Path $upgrade.Directory 'unexpected.json';[IO.File]::WriteAllText($unknown,'{}')
    Reject {Read-NativeTransaction $upgrade.Directory}
    [IO.File]::Delete($unknown)
    Reject {New-NativeTransaction $lock ('1'*32) 'repair' '0.1.0' '0.1.0' ('a'*64)}
    foreach($phase in @('recovery-required','rolling-back','rolled-back')){
        $category=if($phase -eq 'recovery-required'){'interrupted'}else{'none'}
        $upgrade=Set-NativeTransactionPhase $lock $upgrade.Directory $phase $category
    }
    # Tampering with one completed record invalidates the subsequent chain.
    $file=Join-Path $install.Directory '0002.json'
    $original=[IO.File]::ReadAllBytes($file)
    [IO.File]::WriteAllText($file,([Text.Encoding]::UTF8.GetString($original).Replace('"phase":"verified"','"phase":"activated"')))
    Reject {Read-NativeTransaction $install.Directory}
    [IO.File]::WriteAllBytes($file,$original)
    $repair=New-NativeTransaction $lock ('1'*32) 'repair' '0.1.0' '0.1.0' ('a'*64)
    foreach($phase in @('verified','quiesced','repaired','activated','healthy','committed')){
        $repair=Set-NativeTransactionPhase $lock $repair.Directory $phase
    }
    $uninstall=New-NativeTransaction $lock ('1'*32) 'uninstall' '0.1.0' 'none' ('a'*64)
    foreach($phase in @('quiesced','runtime-removed','committed')){
        $uninstall=Set-NativeTransactionPhase $lock $uninstall.Directory $phase
    }
    [pscustomobject]@{passed=$true;rejectedInvalidOperations=$script:checks;reopenAfterInterruption=$true;
        partialPublicationIgnored=$true;hashChainTamperingRejected=$true;allOperationSequences=$true;
        interruptedInitialPublicationRecovered=$true;
        redactedFailureSummaryDoesNotChangeJournal=$true;unknownJsonStillRefused=$true;
        actualInstallerRollbackTested=$false;root=$root;time=[DateTime]::UtcNow.ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\transaction-journal.json') -Encoding UTF8
    Write-Output 'Native recovery journal tests passed.'
}finally{$lock.Handle.Dispose()}
