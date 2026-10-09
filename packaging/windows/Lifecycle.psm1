# Repair/uninstall operate on an ownership-checked context and a trusted exact
# runtime inventory. They never initialize, dump, restore or delete a database.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Payloads.psm1')
Import-Module (Join-Path $PSScriptRoot 'Services.psm1')
Import-Module (Join-Path $PSScriptRoot 'Transactions.psm1')

function Get-NativeLifecycleContext([string]$Product,[string]$Data,[string]$Version,[string]$InstallationId,[switch]$Disposable) {
    if($InstallationId -cnotmatch '^[a-f0-9]{32}$' -or $Version -cnotmatch '^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$'){throw 'Invalid lifecycle identity'}
    $product=Assert-PlainNativePath $Product;$data=Assert-PlainNativePath $Data
    $suffix=if($Disposable){'Josi CE Lifecycle Tests\'+$InstallationId}else{'Josi CE Server'}
    if($product -ine (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $suffix) -or
        $data -ine (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) $suffix)){throw 'Lifecycle roots are not the fixed owned installation'}
    foreach($root in @($product,$data)) {
        $marker=Join-Path $root 'installation.json'
        if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($marker) -or (Get-Item -LiteralPath $marker).Length -gt 4096){throw 'Unsafe lifecycle marker'}
        $value=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        if($value.installationId -cne $InstallationId -or ($Disposable -and $value.purpose -cne 'disposable-lifecycle-acceptance')){throw 'Lifecycle refuses an unrelated installation'}
    }
    $program=Assert-PlainNativePath (Join-Path $product ('versions\'+$Version))
    $plan=if($Disposable){@([pscustomobject]@{Name=('JosiAcceptance_'+$InstallationId);Binary=(ConvertTo-NativeArgument (Join-Path $program 'test-service.exe'))})}else{
        @(Get-NativeServicePlan $program $data | ForEach-Object {
            $binary=if($_.Kind -ceq 'PostgreSQL'){(ConvertTo-NativeArgument $_.Executable)+' '+(($_.Arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' ')}else{ConvertTo-NativeArgument (Join-Path $program ('services\'+$_.Name+'\'+$_.Name+'.exe'))}
            [pscustomobject]@{Name=$_.Name;Binary=$binary}
        })
    }
    return [pscustomobject]@{Product=$product;Program=$program;Data=$data;Version=$Version;InstallationId=$InstallationId;Disposable=[bool]$Disposable;Plan=$plan}
}

function Read-NativeLifecycleInventory([string]$Path,[string]$ExpectedHash){
    $path=Assert-PlainNativePath $Path
    if($ExpectedHash -cnotmatch '^[a-f0-9]{64}$' -or ![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path) -or
        (Get-Item -LiteralPath $path).Length -gt 16777216 -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedHash){throw 'Trusted repair inventory changed'}
    $decoded=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $entries=@($decoded);$seen=@{}
    if(!$entries.Count -or $entries.Count -gt 100000){throw 'Invalid lifecycle inventory bound'}
    foreach($entry in $entries){
        if(@($entry.PSObject.Properties).Count -ne 3 -or $entry.path -cnotmatch '^[^<>:"\\|?*\x00-\x1f]+$' -or $entry.path.StartsWith('/') -or $entry.path.EndsWith('/') -or
            $entry.path -match '(^|/)\.{1,2}(/|$)|(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|/|$)' -or
            $entry.path -match '(^|/)[^/]+[. ](?:/|$)|//' -or $seen.ContainsKey($entry.path) -or
            $entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $entry.size -lt 0 -or $entry.size -gt 21474836480){throw 'Unsafe runtime inventory'}
        $seen[$entry.path]=$true
    }
    return $entries
}

function Assert-LifecycleServices($Context,[switch]$AllowMissing){
    foreach($entry in $Context.Plan){
        $service=Get-CimInstance Win32_Service -Filter ("Name='"+$entry.Name+"'")
        if(!$service){if($AllowMissing){continue};throw 'An owned service is missing; use installation recovery'}
        if($service.PathName -cne $entry.Binary -or $service.StartName -ine ('NT SERVICE\'+$entry.Name)){throw 'Lifecycle refuses an unrelated service'}
    }
}
function Stop-LifecycleServices($Context){
    # Stop control before speech, all writers before PostgreSQL.
    $order=if($Context.Disposable){@($Context.Plan.Name)}else{@('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb','JosiDatabase')}
    foreach($name in $order){
        $service=[ServiceProcess.ServiceController]::new($name)
        try{$service.Refresh();if($service.Status -ne 'Stopped'){$service.Stop();$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60))}}finally{$service.Dispose()}
    }
}
function Start-LifecycleServices($Context,[string[]]$Running){
    $order=if($Context.Disposable){@($Context.Plan.Name)}else{@('JosiDatabase','JosiWeb','JosiWorker','JosiProxy','JosiVoiceControl','JosiVoice')}
    foreach($name in $order){if($Running -contains $name){
        $service=[ServiceProcess.ServiceController]::new($name)
        try{$service.Refresh();if($service.Status -ne 'Running'){$service.Start();$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(60))}}finally{$service.Dispose()}
    }}
}
function Assert-RuntimeTree([string]$Root,$Entries,[switch]$Exact){
    $root=Assert-PlainNativePath $Root;$known=@{};foreach($entry in $Entries){$known[$entry.path]=$entry}
    $files=[Collections.Generic.List[object]]::new()
    function Visit([string]$Path){
        $path=Assert-PlainNativePath $Path;$item=Get-Item -LiteralPath $path -Force
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime contains a reparse point'}
        if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $path -Force){Visit $child.FullName}}
        else{
            if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path)){throw 'Runtime contains a linked file'}
            $name=$path.Substring($root.Length+1).Replace('\','/')
            if(!$known.ContainsKey($name)){throw 'Unlisted runtime file must be preserved and reviewed'}
            if($Exact -and ($item.Length -ne $known[$name].size -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $known[$name].sha256)){throw 'Verified repair source changed'}
            $files.Add($item)
        }
    }
    Visit $root
    if($Exact -and $files.Count -ne $Entries.Count){throw 'Repair source is incomplete'}
    return $files.ToArray()
}
function Invoke-NativeRepair($Context,[string]$Source,[string]$InventoryPath,[string]$InventoryHash,[scriptblock]$Health){
    Assert-NativeLifecycleAdministrator
    $context=Get-NativeLifecycleContext $Context.Product $Context.Data $Context.Version $Context.InstallationId -Disposable:$Context.Disposable
    $entries=@(Read-NativeLifecycleInventory $InventoryPath $InventoryHash)
    $source=Assert-PlainNativePath $Source
    if($source -ieq $context.Program -or $source.StartsWith($context.Data+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Repair requires a separate trusted non-data source'}
    $null=Assert-RuntimeTree $source $entries -Exact
    $null=Assert-RuntimeTree $context.Program $entries
    Assert-LifecycleServices $context
    if(!$Health){throw 'A readiness verifier is required before repair activation'}
    $running=@($context.Plan | Where-Object {(Get-Service -Name $_.Name).Status -eq 'Running'} | ForEach-Object {$_.Name})
    $lock=Open-NativeTransactionLock (Join-Path $context.Data 'transactions')
    $directory=$null
    try{
        $journal=New-NativeTransaction $lock $context.InstallationId 'repair' $context.Version $context.Version $InventoryHash
        $directory=$journal.Directory
        $null=Set-NativeTransactionPhase $lock $directory 'verified'
        Stop-LifecycleServices $context
        $null=Set-NativeTransactionPhase $lock $directory 'quiesced'
        $replaced=0
        foreach($entry in $entries){
            $target=Assert-PlainNativePath (Join-Path $context.Program $entry.path)
            $needs=!(Test-Path -LiteralPath $target) -or (Get-Item -LiteralPath $target).Length -ne $entry.size -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256
            if(!$needs){continue}
            $parent=Split-Path $target -Parent;$null=[IO.Directory]::CreateDirectory($parent)
            $pending=$target+'.repair-'+[Guid]::NewGuid().ToString('N')
            [IO.File]::Copy((Join-Path $source $entry.path),$pending,$false)
            if(Test-Path -LiteralPath $target){
                $original=Assert-PlainNativePath (Join-Path $directory ('repair-originals\'+$entry.path));$null=[IO.Directory]::CreateDirectory((Split-Path $original -Parent))
                [IO.File]::Copy($target,$original,$false)
                [Josi.NativeSetup.DurableFile]::Replace($pending,$target)
            }else{[Josi.NativeSetup.DurableFile]::Publish($pending,$target)}
            $replaced++
        }
        $null=Assert-RuntimeTree $context.Program $entries -Exact
        $null=Set-NativeTransactionPhase $lock $directory 'repaired'
        Start-LifecycleServices $context $running
        $null=Set-NativeTransactionPhase $lock $directory 'activated'
        & $Health $context
        $null=Set-NativeTransactionPhase $lock $directory 'healthy'
        $null=Set-NativeTransactionPhase $lock $directory 'committed'
        return [pscustomobject]@{passed=$true;operation='repair';filesReplaced=$replaced;dataModified=$false;originalsRetained=$true;transaction=$directory}
    }catch{
        if($directory){try{$null=Set-NativeTransactionPhase $lock $directory 'recovery-required' 'unknown'}catch{}}
        throw
    }finally{$lock.Handle.Dispose()}
}
function Invoke-NativeUninstall($Context,[string]$InventoryPath,[string]$InventoryHash){
    Assert-NativeLifecycleAdministrator
    $context=Get-NativeLifecycleContext $Context.Product $Context.Data $Context.Version $Context.InstallationId -Disposable:$Context.Disposable
    $entries=@(Read-NativeLifecycleInventory $InventoryPath $InventoryHash)
    # Complete path/link/extra-file and service ownership checks before stopping
    # anything. Data, older versions and rollback material stay in place.
    $files=@(Assert-RuntimeTree $context.Program $entries)
    Assert-LifecycleServices $context
    $lock=Open-NativeTransactionLock (Join-Path $context.Data 'transactions')
    $directory=$null
    try{
        $journal=New-NativeTransaction $lock $context.InstallationId 'uninstall' $context.Version 'none' $InventoryHash;$directory=$journal.Directory
        Stop-LifecycleServices $context
        $null=Set-NativeTransactionPhase $lock $directory 'quiesced'
        foreach($entry in $context.Plan){
            & (Join-Path $env:SystemRoot 'System32\sc.exe') delete $entry.Name | Out-Null
            if($LASTEXITCODE){throw 'Service removal needs recovery'}
            if([Diagnostics.EventLog]::SourceExists($entry.Name)){
                if([Diagnostics.EventLog]::LogNameFromSourceName($entry.Name,'.') -cne 'Application'){throw 'Unexpected event registration must be retained'}
                [Diagnostics.EventLog]::DeleteEventSource($entry.Name)
            }
        }
        foreach($file in $files){[IO.File]::Delete((Assert-PlainNativePath $file.FullName))}
        # Remove only empty owned runtime folders, never recursively delete data.
        function RemoveEmpty([string]$Path){foreach($child in Get-ChildItem -LiteralPath $Path -Directory -Force){RemoveEmpty (Assert-PlainNativePath $child.FullName)};[IO.Directory]::Delete($Path,$false)}
        RemoveEmpty $context.Program
        $null=Set-NativeTransactionPhase $lock $directory 'runtime-removed'
        $null=Set-NativeTransactionPhase $lock $directory 'committed'
        return [pscustomobject]@{passed=$true;operation='uninstall';activeRuntimeRemoved=$true;dataRetained=$true;olderVersionsRetained=$true;transaction=$directory}
    }catch{if($directory){try{$null=Set-NativeTransactionPhase $lock $directory 'recovery-required' 'unknown'}catch{}};throw}
    finally{$lock.Handle.Dispose()}
}
function Assert-NativeLifecycleAdministrator {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Windows administrator approval required'}
}
Export-ModuleMember -Function Get-NativeLifecycleContext, Read-NativeLifecycleInventory, Invoke-NativeRepair, Invoke-NativeUninstall
