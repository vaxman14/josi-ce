param([string]$Destination='C:\Users\Roman\OneDrive\Desktop\Josi-Windows-Acceptance')
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent;$base=Join-Path $repo 'artifacts\windows-native'
$exe=Get-Content (Join-Path $base 'evidence\onboarding-installer.json') -Raw|ConvertFrom-Json
$tests=Get-Content (Join-Path $base 'evidence\onboarding-installer-tests.json') -Raw|ConvertFrom-Json
$malware=Get-Content (Join-Path $base 'evidence\onboarding-malware.json') -Raw|ConvertFrom-Json
$runtime=Get-Content (Join-Path $base 'evidence\onboarding-runtime.json') -Raw|ConvertFrom-Json
$assets=Get-Content (Join-Path $base 'evidence\release-assets.json') -Raw|ConvertFrom-Json
$metadata=Get-Content (Join-Path $base 'evidence\release-metadata.json') -Raw|ConvertFrom-Json
$sbom=Get-Content (Join-Path $base 'evidence\release-sbom-validation.json') -Raw|ConvertFrom-Json
if(!$tests.passed -or !$malware.passed -or !$runtime.passed -or !$sbom.passed -or !$assets.archivesVerified -or
 $tests.exeSha256 -cne $exe.sha256 -or @($malware.results|Where-Object sha256 -eq $exe.sha256).Count -ne 1 -or
 $exe.signed -or $exe.published -or $exe.candidate -cne $runtime.candidate -or $exe.candidate -cne $metadata.candidate){throw 'Final candidate verification is incomplete'}
foreach($record in (Get-Content (Join-Path $base 'evidence\onboarding-preserved-inputs.json') -Raw|ConvertFrom-Json).files){
 if((Get-Item -LiteralPath $record.path).Length -ne $record.size -or (Get-FileHash -LiteralPath $record.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256){throw 'Preserved original material changed; stop before delivery'}
}
$destination=[IO.Path]::GetFullPath($Destination)
$acceptanceRoot='C:\Users\Roman\OneDrive\Desktop\Josi-Windows-Acceptance'
if($destination -ine $acceptanceRoot -and !$destination.StartsWith($acceptanceRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Delivery must stay in the authorized acceptance folder'}
$null=[IO.Directory]::CreateDirectory($destination);$payloads=Join-Path $destination 'payloads';$null=[IO.Directory]::CreateDirectory($payloads)
function Copy-Verified([string]$Source,[string]$Target,[string]$Hash){
 if((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'Delivery source changed'}
 if(Test-Path -LiteralPath $Target){if((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'Preserve the different existing acceptance file before choosing a new candidate'}}
 else{[IO.File]::Copy($Source,$Target,$false)}
 if((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'Delivery copy failed verification'}
}
$manifest=Get-Content (Join-Path $assets.output 'release-manifest.json') -Raw|ConvertFrom-Json
$deliveredExe=Join-Path $destination ([IO.Path]::GetFileName($exe.path));Copy-Verified $exe.path $deliveredExe $exe.sha256
$checksums=[Collections.Generic.List[string]]::new();$checksums.Add($exe.sha256+'  '+[IO.Path]::GetFileName($deliveredExe))
foreach($component in $manifest.components){
 Copy-Verified (Join-Path $assets.output $component.asset) (Join-Path $payloads $component.asset) $component.sha256
 $checksums.Add($component.sha256+'  payloads/'+$component.asset)
}
foreach($pair in @(@('windows.cdx.json',('Josi-CE-'+$exe.candidate+'-Windows-x64.sbom.cdx.json')),@('release-license-gaps.json','release-license-gaps.json'))){
 $source=Join-Path $metadata.output $pair[0];Copy-Verified $source (Join-Path $destination $pair[1]) (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
}
$instructions=Join-Path $repo 'packaging\windows\TEST-ME.txt'
Copy-Verified $instructions (Join-Path $destination 'TEST-ME.txt') (Get-FileHash $instructions -Algorithm SHA256).Hash.ToLowerInvariant()
foreach($pair in @(@(([IO.Path]::GetFileName($deliveredExe)+'.sha256'),($checksums[0]+"`n")),@('SHA256SUMS.txt',(($checksums -join "`n")+"`n")))){
 $target=Join-Path $destination $pair[0];$bytes=[Text.Encoding]::UTF8.GetBytes($pair[1])
 if(Test-Path -LiteralPath $target){if([IO.File]::ReadAllText($target) -cne $pair[1]){throw 'Existing checksum differs; preserve it before proceeding'}}
 else{$stream=[IO.FileStream]::new($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}
}
$report=[ordered]@{passed=$true;candidate=$exe.candidate;exe=$deliveredExe;sha256=$exe.sha256;size=$exe.size;checksum=$deliveredExe+'.sha256';
 instructions=(Join-Path $destination 'TEST-ME.txt');offlinePayloadArchives=6;allCopiesHashVerified=$true;originalMaterialHashesUnchanged=$true;
 signed=$false;installed=$false;uninstalled=$false;published=$false;releaseApproved=$false;uacWillAppearOnNormalInstallation=$true}
$report|ConvertTo-Json|Set-Content (Join-Path $base 'evidence\onboarding-delivery.json') -Encoding UTF8
$report|ConvertTo-Json
