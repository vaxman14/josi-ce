param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent;$base=Join-Path $repo 'artifacts\windows-native'
$kit=Get-Content (Join-Path $base 'evidence\installer-kit.json') -Raw|ConvertFrom-Json
$assets=Get-Content (Join-Path $base 'evidence\release-assets.json') -Raw|ConvertFrom-Json
if(!$kit.passed -or !$assets.archivesVerified -or !$assets.installable -or !$assets.localUnsignedAcceptance -or $assets.published -or $assets.releaseApproved){throw 'Verified private offline acceptance inputs required'}
$null=& (Join-Path $kit.root 'Initialize-NativeSetup.ps1') -Root $kit.root -ExpectedKitHash $kit.kitSha256
$manifest=Join-Path $assets.output 'release-manifest.json'
$decoded=Read-NativeManifest $manifest $assets.manifestSha256 $assets.candidate
foreach($component in $decoded.components){if(!(Test-NativePayload $component (Join-Path $assets.output $component.asset))){throw 'Private payload changed'}}
$compiler=Join-Path $base 'tools\inno-7.1.0\ISCC.exe'
if((Get-AuthenticodeSignature $compiler).Status -ne 'Valid' -or (Get-FileHash $compiler -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'd06ebd38f38e3cee60a3c50cc45bd449d77e0bc6a5cabc607ea9886808e4de1a'){throw 'Compiler trust failed'}
$output=Join-Path $base ('installers\onboarding-'+[Guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($output)
$numeric=$assets.candidate -replace '-native\.','.'
if($numeric -cnotmatch '^\d+\.\d+\.\d+\.\d+$'){throw 'Candidate must have an exact four-part Windows file version'}
& $compiler '/Q' ('/DKitRoot='+$kit.root) ('/DReleaseRoot='+$assets.output) ('/DKitHash='+$kit.kitSha256) ('/DManifestHash='+$assets.manifestSha256) ('/DCandidateVersion='+$assets.candidate) ('/DNumericVersion='+$numeric) ('/DOutputRoot='+$output) (Join-Path $repo 'packaging\windows\JosiWindows.iss')
if($LASTEXITCODE){throw 'Production onboarding installer compile failed'}
$exe=Join-Path $output ('Josi-CE-'+$assets.candidate+'-Windows-x64-acceptance.exe')
$report=[ordered]@{built=$true;path=$exe;size=(Get-Item $exe).Length;sha256=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant();candidate=$assets.candidate;
 kitSha256=$kit.kitSha256;manifestSha256=$assets.manifestSha256;sourcePayloads=$assets.output;signed=$false;installable=$true;localUnsignedAcceptance=$true;
 releaseApproved=$false;published=$false;installed=$false;physicalAcceptancePassed=$false}
$report|ConvertTo-Json|Set-Content (Join-Path $base 'evidence\onboarding-installer.json') -Encoding UTF8
$report|ConvertTo-Json
