# Only the disposable identity is mutable. The accepted Josi installation is
# observed before/after; none of its services, files or data are test targets.
param([Parameter(Mandatory=$true)][string]$OriginalUserSid)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent;$base=Join-Path $repo 'artifacts\windows-native'
$helper=Get-Content -LiteralPath (Join-Path $base 'evidence\native-setup-helper.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $helper.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne '834f9e97ac5a048d2a9e6fc0a1fad13f88e181b3724f223f9c781c3e53d2c97b'){throw 'Bridge changed'}
Add-Type -Path $helper.binary
Import-Module (Join-Path $repo 'packaging\windows\Lifecycle.psm1')
Import-Module (Join-Path $repo 'packaging\windows\Services.psm1')
if($OriginalUserSid -cnotmatch '^S-1-5-21-(?:\d+-){3}\d+$'){throw 'Invalid report reader'}
$id=[Guid]::NewGuid().ToString('N');$name='JosiAcceptance_'+$id
$run=Join-Path $base ('test-installations\lifecycle-'+$id)
[Josi.NativeSetup.PrivateDirectory]::Create($run,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;'+$OriginalUserSid+')'))
$product=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('Josi CE Lifecycle Tests\'+$id)
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('Josi CE Lifecycle Tests\'+$id)
$version='0.1.78-native.5';$program=Join-Path $product ('versions\'+$version)
$report=[ordered]@{passed=$false;root=$run;disposableProduct=$product;disposableData=$data;service=$name;liveInstallationModified=$false;scope='isolated real SCM service; binary repair and data-retaining uninstall';recordedAt=[DateTime]::UtcNow.ToString('o')}
function Assert([bool]$value,[string]$message){if(!$value){throw $message}}
function Live-State {
 @('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy') | ForEach-Object {
  Get-CimInstance Win32_Service -Filter ("Name='"+$_+"'") | Select-Object Name,State,StartName,PathName,StartMode
 } | ConvertTo-Json -Compress
}
$before=Live-State
$sc=Join-Path $env:SystemRoot 'System32\sc.exe'
try{
 Assert (!(Test-Path -LiteralPath $product) -and !(Test-Path -LiteralPath $data) -and !(Get-Service -Name $name -ErrorAction SilentlyContinue)) 'Disposable identity collided'
 foreach($parent in @((Split-Path $product -Parent),(Split-Path $data -Parent))){$null=[IO.Directory]::CreateDirectory($parent)}
 $sid=[regex]::Match((& $sc showsid $name | Out-String),'S-1-5-80-(?:\d+-){4}\d+').Value;Assert (!!$sid) 'Missing disposable service SID'
 $descriptor='O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$sid+')'
 foreach($path in @($product,$data)){[Josi.NativeSetup.PrivateDirectory]::Create($path,$descriptor);[IO.File]::WriteAllText((Join-Path $path 'installation.json'),(@{installationId=$id;purpose='disposable-lifecycle-acceptance';product='Josi CE Server';schemaVersion=1} | ConvertTo-Json))}
 foreach($relative in @('transactions','database','secrets','snapshots','roots','logs')){$null=[IO.Directory]::CreateDirectory((Join-Path $data $relative))}
 $logSecurity=[Security.AccessControl.DirectorySecurity]::new();$logSecurity.SetSecurityDescriptorSddlForm($descriptor.Replace('0x1200a9','0x1301bf'));[IO.Directory]::SetAccessControl((Join-Path $data 'logs'),$logSecurity)
 foreach($relative in @('database\sentinel','secrets\sentinel','snapshots\sentinel','roots\sentinel')){[IO.File]::WriteAllText((Join-Path $data $relative),('preserve-'+$id))}
 $dataBefore=@(Get-ChildItem -LiteralPath $data -File -Recurse | ForEach-Object {@{path=$_.FullName;hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash;sddl=(Get-Acl -LiteralPath $_.FullName).Sddl}})
 $null=[IO.Directory]::CreateDirectory($program);$source=Join-Path $run 'verified-source';$null=[IO.Directory]::CreateDirectory($source)
 $hostPath=Join-Path $base 'cache\WinSW.Josi-2.12.0-windows1.exe'
 Assert-NativeServiceHost $hostPath
 [IO.File]::Copy($hostPath,(Join-Path $source 'test-service.exe'),$false)
 $xml='<service><id>'+ $name +'</id><name>Josi CE Disposable Lifecycle</name><executable>'+ $env:SystemRoot +'\System32\ping.exe</executable><arguments>-t 127.0.0.1</arguments><workingdirectory>'+ $program +'</workingdirectory><logpath>'+ (Join-Path $data 'logs') +'</logpath><log mode="none"/><stoptimeout>10 sec</stoptimeout><stopparentprocessfirst>true</stopparentprocessfirst></service>'
 [IO.File]::WriteAllText((Join-Path $source 'test-service.xml'),$xml)
 [IO.File]::Copy((Join-Path $base 'tools\node-v24.21.0-win-x64\node.exe'),(Join-Path $source 'runtime.exe'),$false)
 $entries=@(Get-ChildItem -LiteralPath $source -File | ForEach-Object {@{path=$_.Name;size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
 $inventory=Join-Path $run 'runtime-inventory.json';[IO.File]::WriteAllText($inventory,($entries | ConvertTo-Json));$hash=(Get-FileHash -LiteralPath $inventory -Algorithm SHA256).Hash.ToLowerInvariant()
 foreach($file in Get-ChildItem -LiteralPath $source -File){[IO.File]::Copy($file.FullName,(Join-Path $program $file.Name),$false)}
 $binary='"'+(Join-Path $program 'test-service.exe')+'"'
 & $sc create $name ('binPath=') $binary 'start=' 'demand' 'obj=' ('NT SERVICE\'+$name) | Out-Null;Assert ($LASTEXITCODE -eq 0) 'Disposable service registration failed'
 # Windows PowerShell 5.1 strips embedded quotes for native CLI arguments.
 # Use the structured SCM/WMI method to retain the exact quoted path.
 $created=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
 Assert ($created.StartName -ieq ('NT SERVICE\'+$name) -and $created.PathName -ceq (Join-Path $program 'test-service.exe')) 'Unexpected disposable registration'
 $change=Invoke-CimMethod -InputObject $created -MethodName Change -Arguments @{PathName=$binary}
 Assert ($change.ReturnValue -eq 0) 'Disposable quoted path update failed'
 & $sc sidtype $name unrestricted | Out-Null;Assert ($LASTEXITCODE -eq 0) 'Disposable identity configuration failed'
 [Diagnostics.EventLog]::CreateEventSource($name,'Application')
 $service=[ServiceProcess.ServiceController]::new($name);try{$service.Start();$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(30))}finally{$service.Dispose()}
 $context=Get-NativeLifecycleContext $product $data $version $id -Disposable
 # A corrupt trusted input must fail before stopping the running service.
 $bad=$false;try{Invoke-NativeRepair $context $source $inventory ('0'*64) {} | Out-Null}catch{$bad=$true}
 Assert ($bad -and (Get-Service -Name $name).Status -eq 'Running') 'Untrusted inventory changed a service'
 $report.untrustedInventoryRefusedBeforeStop=$true
 [IO.File]::WriteAllText((Join-Path $program 'runtime.exe'),'damaged owned fixture binary')
 $health={param($ctx) Assert ((Get-Service -Name $ctx.Plan[0].Name).Status -eq 'Running') 'Repaired service is not running'}
 $repair=Invoke-NativeRepair $context $source $inventory $hash $health
 Assert ($repair.passed -and $repair.filesReplaced -eq 1 -and $repair.originalsRetained) 'Damaged file repair failed';$report.repair=$repair
 # Unknown files must prevent removal before any SCM stop/delete.
 $extra=Join-Path $program 'unrelated.txt';[IO.File]::WriteAllText($extra,'preserve')
 $bad=$false;try{Invoke-NativeUninstall $context $inventory $hash | Out-Null}catch{$bad=$true}
 Assert ($bad -and (Get-Service -Name $name).Status -eq 'Running' -and (Test-Path -LiteralPath $extra)) 'Unknown file was not protected'
 [IO.File]::Delete($extra);$report.unlistedFileUninstallRefusedBeforeStop=$true
 $report.uninstall=Invoke-NativeUninstall $context $inventory $hash
 Assert (!(Get-Service -Name $name -ErrorAction SilentlyContinue) -and !(Test-Path -LiteralPath $program)) 'Uninstall left an active runtime'
 foreach($entry in $dataBefore){Assert ((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -ceq $entry.hash -and (Get-Acl -LiteralPath $entry.path).Sddl -ceq $entry.sddl) 'Disposable retained data changed'}
 Assert ((Live-State) -ceq $before) 'Accepted live service state changed'
 $report.dataAndPermissionsPreserved=$true;$report.acceptedLiveServicesUnchanged=$true;$report.passed=$true
}catch{$report.failureType=$_.Exception.GetType().FullName;$report.failureLine=$_.InvocationInfo.ScriptLineNumber;$report.failureMessage=$_.Exception.Message}
finally{[IO.File]::WriteAllText((Join-Path $run 'result.json'),($report | ConvertTo-Json -Depth 8));[IO.File]::WriteAllText((Join-Path $base 'evidence\native-lifecycle.json'),($report | ConvertTo-Json -Depth 8))}
