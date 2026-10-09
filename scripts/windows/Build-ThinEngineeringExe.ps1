# Local unsigned bootstrap preview. No services, installed files or registry
# entries are changed, and no release is uploaded or declared installable.
param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$kit=Get-Content (Join-Path $base 'evidence\installer-kit.json') -Raw | ConvertFrom-Json
$assets=Get-Content (Join-Path $base 'evidence\release-assets.json') -Raw | ConvertFrom-Json
if(!$kit.passed -or !$assets.archivesVerified -or $assets.installable -or $assets.published -or $assets.releaseApproved){throw 'Only the retained, blocked local engineering candidate is supported'}
$null=& (Join-Path $kit.root 'Initialize-NativeSetup.ps1') -Root $kit.root -ExpectedKitHash $kit.kitSha256
$manifest=Join-Path $assets.output 'release-manifest.json'
if((Get-FileHash $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $assets.manifestSha256){throw 'Release manifest changed'}
$catalog=Join-Path $assets.output 'release-manifest.cat'
if(!(Test-Path -LiteralPath $catalog)){$null=New-FileCatalog -Path $manifest -CatalogFilePath $catalog -CatalogVersion 2.0}
if((Test-FileCatalog -Path $manifest -CatalogFilePath $catalog) -ne 'Valid'){throw 'Unsigned catalog does not bind the manifest'}
$compiler=Join-Path $base 'tools\inno-7.1.0\ISCC.exe'
if((Get-AuthenticodeSignature -LiteralPath $compiler).Status -ne 'Valid'){throw 'Inno Setup compiler trust failed'}
$output=Join-Path $base ('installers\thin-engineering-'+[Guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($output)
& $compiler '/Q' ('/DKitRoot='+$kit.root) ('/DReleaseRoot='+$assets.output) ('/DKitHash='+$kit.kitSha256) ('/DManifestHash='+$assets.manifestSha256) ('/DCandidateVersion='+$assets.candidate) ('/DOutputRoot='+$output) (Join-Path $repo 'packaging\windows\JosiEngineering.iss')
if($LASTEXITCODE){throw 'Thin engineering bootstrap did not compile'}
$exe=Join-Path $output ('Josi-CE-'+$assets.candidate+'-Windows-x64-engineering.exe')
$report=[ordered]@{built=$true;path=$exe;size=(Get-Item $exe).Length;sha256=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant();candidate=$assets.candidate;
    kitSha256=$kit.kitSha256;manifestSha256=$assets.manifestSha256;catalogSha256=(Get-FileHash $catalog -Algorithm SHA256).Hash.ToLowerInvariant();
    compilerSha256=(Get-FileHash $compiler -Algorithm SHA256).Hash.ToLowerInvariant();signed=$false;installable=$false;releaseApproved=$false;published=$false;
    purpose='read-only embedded integrity preview; production installer acceptance unfinished'}
$report|ConvertTo-Json|Set-Content (Join-Path $base 'evidence\thin-engineering-exe.json') -Encoding UTF8
$report|ConvertTo-Json
