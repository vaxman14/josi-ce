# Integrity tests for the private precompiled kit; never change the installation.
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$build=Get-Content -LiteralPath (Join-Path $base 'evidence\installer-kit.json') -Raw | ConvertFrom-Json
if(!$build.passed){throw 'Build the verified installer kit first'}
$root=Join-Path $base ('test-installations\installer-kit-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($root)
foreach($file in Get-ChildItem -LiteralPath $build.root -File){[IO.File]::Copy($file.FullName,(Join-Path $root $file.Name),$false)}
$env:PSModulePath=''
function Probe([string]$Hash,[bool]$Expected){
    $command='$ErrorActionPreference="Stop";try{& '+("'"+(Join-Path $root 'Initialize-NativeSetup.ps1').Replace("'","''")+"'")+' -Root '+("'"+$root.Replace("'","''")+"'")+' -ExpectedKitHash '+("'"+$Hash+"'")+' | Out-Null;exit 0}catch{exit 1}'
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand '+$encoded
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $process=[Diagnostics.Process]::Start($info)
    try{
        $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
        if(!$process.WaitForExit(15000)){$process.Kill();throw 'Installer kit check timed out'}
        if(($process.ExitCode -eq 0) -ne $Expected){throw 'Installer kit integrity boundary failed'}
    }finally{$process.Dispose()}
}
Probe $build.kitSha256 $true
Probe ('0'*64) $false
$module=Join-Path $root 'Services.psm1'
$bytes=[IO.File]::ReadAllBytes($module)
[IO.File]::AppendAllText($module,"`n# changed test input")
Probe $build.kitSha256 $false
[IO.File]::WriteAllBytes($module,$bytes)
$extra=Join-Path $root 'unlisted.txt'
[IO.File]::WriteAllText($extra,'exclusive test fixture')
Probe $build.kitSha256 $false
[IO.File]::Delete($extra)
$assembly=Join-Path $root 'Josi.NativeSetup.dll'
$bytes=[IO.File]::ReadAllBytes($assembly)
$changed=[byte[]]$bytes.Clone();$changed[0]=$changed[0] -bxor 1
[IO.File]::WriteAllBytes($assembly,$changed)
Probe $build.kitSha256 $false
[IO.File]::WriteAllBytes($assembly,$bytes)
Probe $build.kitSha256 $true
[ordered]@{passed=$true;kitSha256=$build.kitSha256;wrongInventoryHashRefused=$true;changedModuleRefused=$true;
    extraFileRefused=$true;changedAssemblyRefused=$true;precompiledOsRuntimePassed=$true;root=$root} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\installer-kit-tests.json') -Encoding UTF8
'Installer kit loading and four integrity rejection tests passed.'
