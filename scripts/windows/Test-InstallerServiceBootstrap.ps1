# Regression: OS PowerShell 5.1 fresh-process type loading, without Get-Service,
# SCM calls, real service names or any installation changes.
param([Parameter(Mandatory=$true)][string]$RetainedServicesModule)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$assembly=Join-Path (Split-Path $RetainedServicesModule -Parent) 'Josi.NativeSetup.dll'
if((Get-FileHash $assembly -Algorithm SHA256).Hash.ToLowerInvariant() -cne '834f9e97ac5a048d2a9e6fc0a1fad13f88e181b3724f223f9c781c3e53d2c97b'){throw 'Retained inspection bridge changed'}
function Probe([string]$Module,[bool]$Expected){
    $quoted="'"+$Module.Replace("'","''")+"'"
    $bridge="'"+$assembly.Replace("'","''")+"'"
    $code='$ErrorActionPreference="Stop";$env:PSModulePath="";Add-Type -Path '+$bridge+';if("ServiceProcess.ServiceController" -as [type]){exit 3};Import-Module '+$quoted+';try{$controller=[ServiceProcess.ServiceController]::new("JosiReadOnlyAssemblyProbe");$controller.Dispose();exit 0}catch{if($_.FullyQualifiedErrorId -ceq "TypeNotFound"){exit 2};exit 4}'
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $process=[Diagnostics.Process]::Start($info)
    try{
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(!$process.WaitForExit(15000)){$process.Kill();throw 'Bootstrap regression timed out'}
        $expectedCode=if($Expected){0}else{2}
        if($process.ExitCode -ne $expectedCode){throw ('Bootstrap regression returned unexpected code '+$process.ExitCode)}
    }finally{$process.Dispose()}
}
Probe $RetainedServicesModule $false
Probe (Join-Path $repo 'packaging\windows\Services.psm1') $true
[ordered]@{passed=$true;osPowerShell='5.1';freshProcess=$true;retained6TypeNotFoundReproduced=$true;fixedModuleLoadsDependency=$true;
 noGetServiceWarmup=$true;scmQueried=$false;servicesModified=$false;installed=$false;testsPassed=2}|ConvertTo-Json|
 Set-Content (Join-Path $repo 'artifacts\windows-native\evidence\native7-service-bootstrap-regression.json') -Encoding UTF8
