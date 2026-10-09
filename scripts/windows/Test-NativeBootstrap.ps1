# Bounded read-only bootstrap acceptance; never invoke an enabled installation.
param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent;$base=Join-Path $repo 'artifacts\windows-native'
$kit=Get-Content (Join-Path $base 'evidence\installer-kit.json') -Raw|ConvertFrom-Json
$assets=Get-Content (Join-Path $base 'evidence\release-assets.json') -Raw|ConvertFrom-Json
$exe=Get-Content (Join-Path $base 'evidence\thin-engineering-exe.json') -Raw|ConvertFrom-Json
$null=& (Join-Path $kit.root 'Initialize-NativeSetup.ps1') -Root $kit.root -ExpectedKitHash $kit.kitSha256
if($assets.installable -or $exe.installable -or !$assets.archivesVerified){throw 'Only the read-only, release-blocked preview may be tested'}
$root=Assert-PlainNativePath (Join-Path $base ('test-installations\bootstrap-'+[Guid]::NewGuid().ToString('N')))
$null=[IO.Directory]::CreateDirectory($root)
$copy=Join-Path $root 'kit';$null=[IO.Directory]::CreateDirectory($copy)
foreach($file in Get-ChildItem $kit.root -File){[IO.File]::Copy($file.FullName,(Join-Path $copy $file.Name),$false)}
$manifest=Join-Path $root 'release-manifest.json';[IO.File]::Copy((Join-Path $assets.output 'release-manifest.json'),$manifest,$false)
$original=[IO.File]::ReadAllBytes($manifest)
function Probe([string]$Operation,[string]$Hash,[bool]$Success){
    $log=Join-Path $root ('probe-'+[Guid]::NewGuid().ToString('N')+'.log')
    $err=$log+'.err'
    $args=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(ConvertTo-NativeArgument (Join-Path $copy 'Invoke-NativeSetup.ps1')),
        '-KitRoot',(ConvertTo-NativeArgument $copy),'-KitHash',$kit.kitSha256,'-ManifestHash',$Hash,'-Version',$assets.candidate,'-Operation',$Operation)
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments=$args -join ' ';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $process=[Diagnostics.Process]::Start($info);$out=$process.StandardOutput.ReadToEndAsync();$errorText=$process.StandardError.ReadToEndAsync()
    if(!$process.WaitForExit(30000)){$process.Kill();throw 'Bootstrap probe timed out'}
    [IO.File]::WriteAllText($log,$out.Result);[IO.File]::WriteAllText($err,$errorText.Result)
    if(($process.ExitCode -eq 0) -ne $Success){throw 'Bootstrap integrity or release gate failed'}
    $process.Dispose()
    return $err
}
$null=Probe 'verify-only' $assets.manifestSha256 $true
$result=Get-Content (Join-Path $root 'verification-result.json') -Raw|ConvertFrom-Json
if(!$result.passed -or $result.installationModified -or $result.installable){throw 'Verification changed installation scope'}
[IO.File]::AppendAllText($manifest,' ');$null=Probe 'verify-only' $assets.manifestSha256 $false;[IO.File]::WriteAllBytes($manifest,$original)
foreach($operation in @('install','upgrade','repair','uninstall')){
    $err=Probe $operation $assets.manifestSha256 $false
    if((Get-Content $err -Raw) -notmatch 'unfinished release gates'){throw 'Mutation did not stop at the release gate'}
}
$rejected=$false
try{$null=Read-SignedNativeManifest $manifest (Join-Path $assets.output 'release-manifest.cat') $assets.manifestSha256 $assets.candidate}catch{$rejected=$true}
if(!$rejected){throw 'Unsigned manifest catalog was trusted'}
# Exercise the actual archive extractor as a standalone trusted function; this
# imports no host entry point and grants no elevation or database/service access.
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $copy 'Invoke-NativeSetup.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Bootstrap syntax failed'}
$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Extract-VerifiedArchive'},$true)
. ([scriptblock]::Create($function.Extent.Text))
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function ArchiveProbe([string[]]$Names,[bool]$Success){
    $id=[Guid]::NewGuid().ToString('N');$zip=Join-Path $root ($id+'.zip');$dest=Join-Path $root $id;$null=[IO.Directory]::CreateDirectory($dest)
    $archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
    try{foreach($name in $Names){$entry=$archive.CreateEntry($name);$stream=$entry.Open();try{$bytes=[Text.Encoding]::UTF8.GetBytes('fixture');$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}}finally{$archive.Dispose()}
    $component=[pscustomobject]@{id='josi';size=(Get-Item $zip).Length;sha256=(Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()}
    $accepted=$false;try{Extract-VerifiedArchive $component $zip $dest;$accepted=$true}catch{}
    if($accepted -ne $Success){throw 'Archive trust boundary failed'}
    if(!$Success -and @(Get-ChildItem $dest -File -Recurse).Count){throw 'Unsafe archive created files before complete preflight'}
}
ArchiveProbe @('app/fixture.txt','licenses/NOTICE','inventories/josi.json') $true
foreach($bad in @('../outside','app/../outside','app/CON.txt','app/name.','node/unassigned','app/Case','app/name:stream')){ArchiveProbe @('app/fixture.txt',$bad,$bad.ToLowerInvariant()) $false}
$before=@(Get-CimInstance Win32_Service |Where-Object Name -in @('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')|Select-Object Name,State,StartMode,StartName,PathName|Sort-Object Name)|ConvertTo-Json -Compress
if((Get-FileHash $exe.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $exe.sha256){throw 'EXE bytes changed'}
$verifyLog=Join-Path $root 'exe-verify.log'
$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$exe.path;$info.Arguments='/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /VERIFYONLY /LOG="'+$verifyLog+'"';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$process=[Diagnostics.Process]::Start($info)
if(!$process.WaitForExit(30000)){$process.Kill();throw 'Thin EXE verification timed out'}
if($process.ExitCode -ne 0 -or (Get-Content $verifyLog -Raw) -notmatch 'Josi verification result: .*"passed":true'){throw 'Thin EXE did not verify its embedded content'}
$process.Dispose()
$blockedLog=Join-Path $root 'exe-blocked.log'
$info.Arguments='/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="'+$blockedLog+'"';$process=[Diagnostics.Process]::Start($info)
if(!$process.WaitForExit(15000)){$process.Kill();throw 'Release gate did not stop the EXE'}
if($process.ExitCode -eq 0 -or (Get-Content $blockedLog -Raw) -notmatch 'installation blocked before elevation'){throw 'Engineering EXE unexpectedly allowed installation'}
$process.Dispose()
$after=@(Get-CimInstance Win32_Service |Where-Object Name -in @('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')|Select-Object Name,State,StartMode,StartName,PathName|Sort-Object Name)|ConvertTo-Json -Compress
if($before -cne $after){throw 'Accepted service state changed during read-only bootstrap checks'}
$report=[ordered]@{passed=$true;root=$root;candidate=$assets.candidate;exeSha256=$exe.sha256;embeddedKitAndManifestVerified=$true;
    changedManifestRefused=$true;unsignedCatalogRefused=$true;allFourMutationOperationsReleaseBlocked=$true;archiveNamespaceAccepted=$true;
    archiveBoundaryCasesRefused=7;unsafeArchivesCreatedNoFiles=$true;exeReadOnlyProbePassed=$true;exeInstallationBlocked=$true;acceptedServiceStateUnchanged=$true;
    productionInstallationAccepted=$false;uacPolicyChanged=$false;recordedAt=[DateTime]::UtcNow.ToString('o')}
$report|ConvertTo-Json|Set-Content (Join-Path $base 'evidence\native-bootstrap-tests.json') -Encoding UTF8
$report|ConvertTo-Json
