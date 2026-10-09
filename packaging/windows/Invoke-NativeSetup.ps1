# Entry embedded in the signed thin EXE. No arbitrary paths/commands are accepted.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$KitRoot,[Parameter(Mandatory=$true)][string]$KitHash,
    [Parameter(Mandatory=$true)][string]$ManifestHash,[Parameter(Mandatory=$true)][string]$Version,
    [ValidateSet('install','upgrade','repair','diagnostics','uninstall','verify-only','install-or-upgrade')][string]$Operation='install',
    [string]$LocalAcceptancePayloads)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$verified=& (Join-Path $KitRoot 'Initialize-NativeSetup.ps1') -Root $KitRoot -ExpectedKitHash $KitHash
if(!$verified.verified){throw 'Private installer integrity failed'}
# release-manifest.json and its catalog are outside the kit inventory, separately
# pinned by the EXE. The builder places them next to the kit, not inside it.
$manifestPath=Join-Path (Split-Path $KitRoot -Parent) 'release-manifest.json'
$catalogPath=Join-Path (Split-Path $KitRoot -Parent) 'release-manifest.cat'
$manifest=Read-NativeManifest $manifestPath $ManifestHash $Version
foreach($field in @('installable','licenseGatePassed','unsignedAcceptancePassed')){if($manifest.$field -isnot [bool]){throw 'Release gate record is missing or invalid'}}
if($Operation -ceq 'verify-only'){
    $result=[pscustomobject]@{passed=$true;operation=$Operation;version=$Version;kitVerified=$true;manifestVerified=$true;installationModified=$false;installable=[bool]$manifest.installable}
    $path=Join-Path (Split-Path $KitRoot -Parent) 'verification-result.json'
    $bytes=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Compress))
    $stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    $result|ConvertTo-Json;exit 0
}
if($LocalAcceptancePayloads){
    # Explicit, private, offline acceptance build. It is hash-bound to this EXE,
    # never fetches unsigned remote code and never claims publication approval.
    if(!$manifest.installable -or !$manifest.localUnsignedAcceptance -or $manifest.published -or
        $Operation -cnotin @('install','upgrade','install-or-upgrade')){throw 'Invalid private acceptance operation'}
    $LocalAcceptancePayloads=Assert-PlainNativePath $LocalAcceptancePayloads
}else{
    if(!$manifest.installable -or !$manifest.licenseGatePassed -or !$manifest.unsignedAcceptancePassed){throw 'This engineering candidate has unfinished release gates; installation is blocked'}
    $null=Read-SignedNativeManifest $manifestPath $catalogPath $ManifestHash $Version
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Windows administrator approval required'}
$product=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Josi CE Server')
$data=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server')
if($Operation -ceq 'install-or-upgrade'){
    $Operation=if((Test-Path -LiteralPath $product) -or (Test-Path -LiteralPath $data)){'upgrade'}else{'install'}
}
$context=$null;$lock=$null;$directory=$null
function Run-Private([string]$Program,[string[]]$Arguments){
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=Join-Path $Program 'node\JosiRuntime.exe'
    $info.Arguments=($Arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' '
    $info.WorkingDirectory=Join-Path $Program 'app';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.EnvironmentVariables.Clear()
    foreach($pair in @(@('SystemRoot',$env:SystemRoot),@('WINDIR',$env:SystemRoot),@('PATH',(Join-Path $env:SystemRoot 'System32')),@('TEMP',(Join-Path $data 'temp\migrate')),@('TMP',(Join-Path $data 'temp\migrate')))){$info.EnvironmentVariables[$pair[0]]=$pair[1]}
    $process=[Diagnostics.Process]::Start($info)
    try{$out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync();if(!$process.WaitForExit(180000)){$process.Kill();throw 'Private maintenance timed out'};if($process.ExitCode -ne 0){throw 'Private maintenance failed; retained transaction needs review'}}finally{$process.Dispose()}
}
function Ready($Context){
    $deadline=[DateTime]::UtcNow.AddSeconds(180)
    do{
        try{
            if((Invoke-WebRequest 'http://localhost:8080/ready' -UseBasicParsing -TimeoutSec 5).StatusCode -ne 200){throw 'Not ready'}
            $token=[IO.File]::ReadAllText((Join-Path $data 'secrets\voice-control-token'))
            try{$speech=Invoke-RestMethod 'http://127.0.0.1:18082/status' -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 5}finally{$token=$null}
            if(!$speech.healthy -or $speech.settings.device -cne 'cpu'){throw 'CPU speech not ready'}
            $names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
            $services=@(Get-CimInstance Win32_Service | Where-Object {$names -contains $_.Name})
            if($services.Count -ne 6 -or @($services | Where-Object {$_.State -cne 'Running' -or $_.StartName -ine ('NT SERVICE\'+$_.Name) -or !$_.PathName.Contains($Context.Program+'\')}).Count){throw 'Service readiness failed'}
            $listeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in @(15432,18080,18081,18082,8080)})
            if($listeners.Count -ne 5 -or @($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count){throw 'Listener validation failed'}
            $diagnostics=Get-NativeDiagnostics
            if($diagnostics.antivirus.status -cne 'available'){[Console]::Error.WriteLine('Malware scanning is '+$diagnostics.antivirus.status+'. It was not treated as a clean scan.')}
            return
        }catch{}
        Start-Sleep -Milliseconds 500
    }while([DateTime]::UtcNow -lt $deadline)
    throw 'Josi did not pass readiness; use retained transaction diagnostics before recovery'
}
function Extract-VerifiedArchive($Component,[string]$Archive,[string]$Destination){
    if(!(Test-NativePayload $Component $Archive)){throw 'Archive hash or length changed'}
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archiveStream=[IO.Compression.ZipFile]::OpenRead($Archive)
    try{
        $seen=@{};$total=0L
        # Preflight the complete archive before creating a single extracted file.
        foreach($entry in $archiveStream.Entries){
            if($entry.FullName -cnotmatch '^[^<>:"\\|?*\x00-\x1f]+$' -or $entry.FullName.StartsWith('/') -or $entry.FullName -match '(^|/)\.{1,2}(/|$)|//|(^|/)[^/]+[. ](?:/|$)|(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|/|$)' -or $entry.FullName.EndsWith('/') -or
                $seen.ContainsKey($entry.FullName) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw 'Unsafe or linked archive member'}
            $namespace=if($Component.id -ceq 'josi'){'(?:app|licenses)'}else{[regex]::Escape($Component.id)}
            if($entry.FullName -cnotmatch ('^(?:'+$namespace+'/|LICENSE$|NOTICE$|TRADEMARK\.md$|inventories/'+[regex]::Escape($Component.id)+'\.json$)')){throw 'Archive contains a component outside its assigned namespace'}
            $seen[$entry.FullName]=$true;$total+=$entry.Length
            if($seen.Count -gt 100000 -or $total -gt 20GB){throw 'Expanded archive exceeds bounds'}
        }
        foreach($entry in $archiveStream.Entries){
            $path=Assert-PlainNativePath (Join-Path $Destination $entry.FullName)
            if(!$path.StartsWith($Destination+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Archive traversal refused'}
            $null=[IO.Directory]::CreateDirectory((Split-Path $path -Parent))
            $input=$entry.Open();$output=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose();$input.Dispose()}
        }
    }finally{$archiveStream.Dispose()}
}
try{
    $os=Get-CimInstance Win32_OperatingSystem
    if(![Environment]::Is64BitProcess -or [int]$os.BuildNumber -lt 22000 -or $os.TotalVisibleMemorySize -lt 4MB){throw 'Josi requires 64-bit Windows 11 and at least 4 GB RAM'}
    foreach($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending','HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')){if(Test-Path -LiteralPath $key){throw 'Windows has a pending restart; no restart was requested'}}
    $prior=$null
    if($Operation -ceq 'install'){
        if((Test-Path -LiteralPath $product) -or (Test-Path -LiteralPath $data)){throw 'Existing Josi folders must be preserved; select the verified maintenance operation'}
        foreach($name in @('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')){if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'An existing service must be preserved'}}
        foreach($port in @(15432,18080,18081,18082,8080)){$probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port);try{$probe.Start()}finally{$probe.Stop()}}
    }else{
        $prior=Get-Content -LiteralPath (Join-Path $data 'config\runtime.json') -Raw | ConvertFrom-Json
        $marker=Get-Content -LiteralPath (Join-Path $data 'installation.json') -Raw | ConvertFrom-Json
        $context=Get-NativeLifecycleContext $product $data $prior.version $marker.installationId
        foreach($entry in $context.Plan){
            $service=Get-CimInstance Win32_Service -Filter ("Name='"+$entry.Name+"'")
            if(!$service -or $service.PathName -cne $entry.Binary -or $service.StartName -ine ('NT SERVICE\'+$entry.Name)){throw 'Setup refuses unrelated or incomplete service state'}
        }
        if($Operation -ceq 'diagnostics'){
            $export=Join-Path ([Environment]::GetFolderPath('CommonDocuments')) ('Josi diagnostics '+[Guid]::NewGuid().ToString('N')+'.json')
            Export-NativeDiagnostics $export | Out-Null;exit 0
        }
        if($Operation -ceq 'uninstall'){
            $inventory=Join-Path $product ('installer\'+$prior.version+'\installed-inventory.json')
            $receipt=Get-Content -LiteralPath (Join-Path $product ('installer\'+$prior.version+'\installed-receipt.json')) -Raw | ConvertFrom-Json
            Invoke-NativeUninstall $context $inventory $receipt.inventorySha256 | Out-Null;exit 0
        }
        if(($Operation -ceq 'repair' -and $prior.version -cne $Version) -or ($Operation -ceq 'upgrade' -and $prior.version -ceq $Version)){throw 'Selected maintenance operation does not match the installed version'}
    }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($product));$required=3GB
    foreach($component in $manifest.components){$required+=3*$component.size}
    if($drive.AvailableFreeSpace -lt $required){throw 'Insufficient disk space; no installed files were changed'}
    $cacheParent=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Installer Cache')
    if(!(Test-Path -LiteralPath $cacheParent)){[Josi.NativeSetup.PrivateDirectory]::Create($cacheParent,'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')}
    $cache=Assert-PlainNativePath (Join-Path $cacheParent $ManifestHash)
    if(!(Test-Path -LiteralPath $cache)){[Josi.NativeSetup.PrivateDirectory]::Create($cache,'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')}
    foreach($protected in @($cacheParent,$cache)){
        $acl=Get-Acl -LiteralPath $protected
        $owner=([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
        if(!$acl.AreAccessRulesProtected -or $owner -cnotin @('S-1-5-18','S-1-5-32-544')){throw 'Installer cache ownership must be reviewed'}
        foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($rule.AccessControlType -ne 'Allow' -or $sid -cnotin @('S-1-5-18','S-1-5-32-544')){throw 'Installer cache grants unexpected access'}}
    }
    $source=Assert-PlainNativePath (Join-Path $cache ('expanded-'+[Guid]::NewGuid().ToString('N')));$null=[IO.Directory]::CreateDirectory($source)
    foreach($component in $manifest.components){
        $archive=if($LocalAcceptancePayloads){Get-NativeLocalPayload $component $LocalAcceptancePayloads $cache}else{Get-NativePayload $component $ManifestHash $cache (Join-Path $cache 'cancel')}
        Extract-VerifiedArchive $component $archive $source
    }
    $entries=[Collections.Generic.List[object]]::new()
    foreach($component in $manifest.components){
        $path=Join-Path $source ('inventories\'+$component.id+'.json')
        $decoded=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        foreach($entry in @($decoded)){$entries.Add($entry)}
    }
    $inventory=Join-Path $cache ('runtime-inventory-'+[Guid]::NewGuid().ToString('N')+'.json')
    [IO.File]::WriteAllText($inventory,($entries.ToArray() | ConvertTo-Json -Depth 4));$hash=(Get-FileHash -LiteralPath $inventory -Algorithm SHA256).Hash.ToLowerInvariant()
    $null=Read-NativeLifecycleInventory $inventory $hash
    if(@(Get-ChildItem -LiteralPath $source -File -Recurse).Count -ne $entries.Count+$manifest.components.Count){throw 'Expanded payload contains unlisted files'}
    foreach($entry in $entries){$path=Assert-PlainNativePath (Join-Path $source $entry.path);if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($path) -or (Get-Item -LiteralPath $path).Length -ne $entry.size -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'Expanded payload failed verification'}}
    foreach($component in $manifest.components){[IO.File]::Delete((Join-Path $source ('inventories\'+$component.id+'.json')))}
    [IO.Directory]::Delete((Join-Path $source 'inventories'),$false)
    $launcher=Join-Path $source 'JosiLauncher.exe'
    [IO.File]::Copy((Join-Path $KitRoot 'JosiLauncher.exe'),$launcher,$false)
    $entries.Add([ordered]@{path='JosiLauncher.exe';size=(Get-Item $launcher).Length;sha256=(Get-FileHash $launcher -Algorithm SHA256).Hash.ToLowerInvariant()})
    $program=Assert-PlainNativePath (Join-Path $product ('versions\'+$Version))
    $wrapper=Join-Path $KitRoot 'WinSW.Josi.exe'
    $null=Write-NativeServiceFiles $source $data $wrapper
    # Definitions must reference final immutable paths, even in the verified
    # repair source. Regenerate using final paths and retain only fixed outputs.
    foreach($file in Get-ChildItem -LiteralPath (Join-Path $source 'services') -File -Recurse -Filter '*.xml'){
        $xml=[IO.File]::ReadAllText($file.FullName).Replace([Security.SecurityElement]::Escape($source),[Security.SecurityElement]::Escape($program));[IO.File]::WriteAllText($file.FullName,$xml)
    }
    foreach($file in Get-ChildItem -LiteralPath (Join-Path $source 'services') -File -Recurse){$entries.Add([ordered]@{path=$file.FullName.Substring($source.Length+1).Replace('\','/');size=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()})}
    [IO.File]::WriteAllText($inventory,($entries.ToArray() | ConvertTo-Json -Depth 4));$hash=(Get-FileHash -LiteralPath $inventory -Algorithm SHA256).Hash.ToLowerInvariant()
    if($Operation -ceq 'repair'){Invoke-NativeRepair $context $source $inventory $hash ${function:Ready} | Out-Null;exit 0}
    $installationId=if($context){$context.InstallationId}else{[Guid]::NewGuid().ToString('N')}
    if(!$context){
        [Josi.NativeSetup.PrivateDirectory]::Create($product,'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)')
        [IO.File]::WriteAllText((Join-Path $product 'installation.json'),(@{installationId=$installationId;purpose='native-installed-product'} | ConvertTo-Json))
        New-NativeDataLayout $data $installationId
    }
    if(Test-Path -LiteralPath $program){throw 'Existing version folder must be preserved and reviewed'}
    $lock=Open-NativeTransactionLock (Join-Path $data 'transactions')
    $journal=New-NativeTransaction $lock $installationId $Operation $(if($prior){$prior.version}else{'none'}) $Version $ManifestHash;$directory=$journal.Directory
    $null=[IO.Directory]::CreateDirectory($program)
    foreach($entry in $entries){$target=Assert-PlainNativePath (Join-Path $program $entry.path);$null=[IO.Directory]::CreateDirectory((Split-Path $target -Parent));[IO.File]::Copy((Join-Path $source $entry.path),$target,$false)}
    $null=Set-NativeTransactionPhase $lock $directory 'verified'
    if($Operation -ceq 'install'){
        $user=(Get-CimInstance Win32_ComputerSystem).UserName
        if(!$user){throw 'Original interactive Windows user could not be identified'}
        $sid=([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value
        $null=New-NativeInitialConfiguration $program $data $Version $sid
        $null=Set-NativeTransactionPhase $lock $directory 'data-created'
        $null=Register-NativeServices $program $data
        $null=Set-NativeTransactionPhase $lock $directory 'services-created'
        Invoke-NativeDatabaseInitialization $program $data $wrapper
        # Retain initializer files in the transaction rather than leaving
        # unlisted files in the immutable version used by repair/uninstall.
        $init=Assert-PlainNativePath (Join-Path $program 'services\database-init')
        $keep=Assert-PlainNativePath (Join-Path $directory 'database-initializer');$null=[IO.Directory]::CreateDirectory($keep)
        foreach($name in @('JosiDatabase.exe','JosiDatabase.xml')){[IO.File]::Move((Join-Path $init $name),(Join-Path $keep $name))}
        [IO.Directory]::Delete($init,$false)
        Start-Service JosiDatabase
        Run-Private $program @((Join-Path $program 'app\native\DatabaseBootstrap.mjs'),(Join-Path $data 'config\runtime.json'))
        $null=Set-NativeTransactionPhase $lock $directory 'database-ready'
    }else{
        foreach($name in @('JosiProxy','JosiVoiceControl','JosiVoice','JosiWorker','JosiWeb')){Stop-NativeService $name}
        $null=Set-NativeTransactionPhase $lock $directory 'quiesced'
        $backupContext=Get-NativeMaintenanceContext $installationId $prior.version $Version
        $null=New-NativeMaintenanceSnapshot $backupContext $lock $directory
    }
    Run-Private $program @((Join-Path $program 'app\native\Runtime.mjs'),'migrate',(Join-Path $data 'config\runtime.json'))
    $null=Set-NativeTransactionPhase $lock $directory 'migrated'
    if($Operation -ceq 'upgrade'){
        Stop-NativeService 'JosiDatabase'
        foreach($entry in Get-NativeServicePlan $context.Program $data){
            $service=Get-CimInstance Win32_Service -Filter ("Name='"+$entry.Name+"'")
            if($service.StartName -ine ('NT SERVICE\'+$entry.Name) -or !$service.PathName.Contains($context.Program+'\')){throw 'Upgrade refuses an unrelated service'}
            & (Join-Path $env:SystemRoot 'System32\sc.exe') delete $entry.Name | Out-Null;if($LASTEXITCODE){throw 'Upgrade registration switch needs recovery'}
        }
        $configPath=Join-Path $data 'config\runtime.json';$prior.version=$Version;$pending=$configPath+'.'+[Guid]::NewGuid().ToString('N')+'.pending'
        [IO.File]::WriteAllText($pending,($prior | ConvertTo-Json -Compress));[IO.File]::SetAccessControl($pending,[IO.File]::GetAccessControl($configPath));[Josi.NativeSetup.DurableFile]::Replace($pending,$configPath)
        $null=Register-NativeServices $program $data;Start-Service JosiDatabase
    }
    $null=Set-NativeTransactionPhase $lock $directory 'activated'
    foreach($name in @('JosiWeb','JosiWorker','JosiProxy','JosiVoiceControl')){Start-Service $name}
    $context=Get-NativeLifecycleContext $product $data $Version $installationId
    Ready $context
    $null=Set-NativeTransactionPhase $lock $directory 'healthy'
    Set-NativeServiceStartup $program $data
    $receiptRoot=Assert-PlainNativePath (Join-Path $product ('installer\'+$Version));$null=[IO.Directory]::CreateDirectory($receiptRoot)
    [IO.File]::Copy($inventory,(Join-Path $receiptRoot 'installed-inventory.json'),$false)
    [IO.File]::WriteAllText((Join-Path $receiptRoot 'installed-receipt.json'),(@{installationId=$installationId;version=$Version;inventorySha256=$hash;manifestSha256=$ManifestHash} | ConvertTo-Json))
    $null=Set-NativeTransactionPhase $lock $directory 'committed'
}catch{
    if($lock -and $directory){try{$null=Set-NativeTransactionPhase $lock $directory 'recovery-required' 'unknown'}catch{}}
    # Keep snapshots, originals, secrets and cluster untouched. Never silently
    # restore SQL; report the preserved transaction before any recovery action.
    [Console]::Error.WriteLine('Josi setup did not complete. Existing data and recovery material are retained. Review the installation diagnostics before recovery.')
    exit 1
}finally{if($lock){$lock.Handle.Dispose()}}
