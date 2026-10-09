param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent;$base=Join-Path $repo 'artifacts\windows-native'
$kit=Get-Content (Join-Path $base 'evidence\installer-kit.json') -Raw|ConvertFrom-Json
$assets=Get-Content (Join-Path $base 'evidence\release-assets.json') -Raw|ConvertFrom-Json
$exe=Get-Content (Join-Path $base 'evidence\onboarding-installer.json') -Raw|ConvertFrom-Json
$null=& (Join-Path $kit.root 'Initialize-NativeSetup.ps1') -Root $kit.root -ExpectedKitHash $kit.kitSha256
$root=Assert-PlainNativePath (Join-Path $base ('test-installations\onboarding-installer-'+[Guid]::NewGuid().ToString('N')))
$null=[IO.Directory]::CreateDirectory($root)
$data=Join-Path $root 'retained-data';$null=[IO.Directory]::CreateDirectory($data)
$sentinel=Join-Path $data 'existing-user-data';[IO.File]::WriteAllText($sentinel,'Preserved disposable data')
$beforeHash=(Get-FileHash $sentinel -Algorithm SHA256).Hash;$beforeAcl=(Get-Acl $data).Sddl
$source=Join-Path $root 'source';$cache=Join-Path $root 'cache'
foreach($folder in @($source,$cache)){$null=[IO.Directory]::CreateDirectory($folder)}
$input=Join-Path $source 'fixture.zip';[IO.File]::WriteAllText($input,'Verified fixture bytes')
$component=[pscustomobject]@{asset='fixture.zip';size=(Get-Item $input).Length;sha256=(Get-FileHash $input -Algorithm SHA256).Hash.ToLowerInvariant()}
$cached=Get-NativeLocalPayload $component $source $cache
if(!(Test-NativePayload $component $cached)){throw 'Private local cache failed'}
if((Get-NativeLocalPayload $component $source $cache) -cne $cached){throw 'Verified local cache was not reused'}
[IO.File]::AppendAllText($input,' changed');$refused=$false
try{$null=Get-NativeLocalPayload $component $source $cache}catch{$refused=$true}
if(!$refused -or !(Test-NativePayload $component $cached)){throw 'Changed local source was accepted or overwrote retained cache'}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $kit.root 'Invoke-NativeSetup.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Host syntax failed'}
$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Extract-VerifiedArchive'},$true)
. ([scriptblock]::Create($function.Extent.Text))
Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem
function ArchiveProbe([string[]]$Names,[bool]$Expected){
    $id=[Guid]::NewGuid().ToString('N');$path=Join-Path $root ($id+'.zip');$destination=Join-Path $root $id;$null=[IO.Directory]::CreateDirectory($destination)
    $archive=[IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create)
    try{foreach($name in $Names){$entry=$archive.CreateEntry($name);$stream=$entry.Open();try{$bytes=[Text.Encoding]::UTF8.GetBytes('Fixture');$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}}finally{$archive.Dispose()}
    $entry=[pscustomobject]@{id='josi';size=(Get-Item $path).Length;sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()}
    $passed=$false;try{Extract-VerifiedArchive $entry $path $destination;$passed=$true}catch{}
    if($passed -ne $Expected){throw 'Archive preflight boundary failed'}
    if(!$Expected -and @(Get-ChildItem $destination -Recurse -File).Count){throw 'Rejected archive created files'}
}
ArchiveProbe @('app/fixture.txt','licenses/NOTICE','inventories/josi.json') $true
foreach($bad in @('../outside','app/../outside','app/CON.txt','app/name.','node/unassigned','app/Case','app/name:stream')){ArchiveProbe @('app/fixture.txt',$bad,$bad.ToLowerInvariant()) $false}
$names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
$before=@(Get-CimInstance Win32_Service|Where-Object Name -in $names|Select-Object Name,State,StartMode,StartName,PathName|Sort-Object Name)|ConvertTo-Json -Compress
if((Get-FileHash $exe.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $exe.sha256){throw 'Final EXE bytes changed'}
$log=Join-Path $root 'read-only-exe.log'
$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$exe.path
$info.Arguments='/CURRENTUSER /VERIFYONLY /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="'+$log+'"'
$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$process=[Diagnostics.Process]::Start($info)
try{if(!$process.WaitForExit(30000)){$process.Kill();throw 'Read-only EXE check timed out'};if($process.ExitCode -ne 0){throw 'Read-only EXE failed'}}finally{$process.Dispose()}
if((Get-Content $log -Raw) -notmatch 'Read-only verification did not modify the installation'){throw 'EXE integrity result missing'}
$after=@(Get-CimInstance Win32_Service|Where-Object Name -in $names|Select-Object Name,State,StartMode,StartName,PathName|Sort-Object Name)|ConvertTo-Json -Compress
if($before -cne $after -or (Get-FileHash $sentinel -Algorithm SHA256).Hash -cne $beforeHash -or (Get-Acl $data).Sddl -cne $beforeAcl){throw 'Retained state changed during read-only verification'}
$signature=Get-AuthenticodeSignature $exe.path
if($signature.Status -ne 'NotSigned'){throw 'Unexpected signature status; review before delivery'}
$version=(Get-Item $exe.path).VersionInfo
if($version.FileVersion.Trim() -cne ($assets.candidate -replace '-native\.','.') -or $version.FileDescription -notmatch 'unsigned acceptance'){throw 'Final EXE metadata identity failed'}
$report=[ordered]@{passed=$true;candidate=$assets.candidate;root=$root;exeSha256=$exe.sha256;embeddedKitAndManifestVerified=$true;
 localPayloadCopiedAndReused=$true;changedLocalPayloadRejected=$true;retainedCacheNotOverwritten=$true;archiveBoundariesRefused=7;unsafeArchivesCreatedNoFiles=$true;
 installedServiceStateUnchanged=$true;fixtureDataAndAclUnchanged=$true;exeReadOnlyProbe=$true;installed=$false;uninstalled=$false;uacRequested=$false;
 signatureStatus=[string]$signature.Status;fileVersion=$version.FileVersion;description=$version.FileDescription;releaseApproved=$false}
$report|ConvertTo-Json|Set-Content (Join-Path $base 'evidence\onboarding-installer-tests.json') -Encoding UTF8
$report|ConvertTo-Json
