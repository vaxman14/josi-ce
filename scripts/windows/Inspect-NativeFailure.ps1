# One-shot, read-only inspection. Never open a transaction lock, start/stop a
# service, connect a SQL client, restore, repair, delete, or change configuration.
param([Parameter(Mandatory=$true)][string]$OutputDirectory,
      [Parameter(Mandatory=$true)][string]$ExpectedScriptHash)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
if((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedScriptHash){throw 'Inspection script changed'}
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$allowed=Join-Path $repo 'artifacts\windows-native\test-installations'
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(!$output.StartsWith($allowed+'\',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $output -PathType Container) -or (Test-Path -LiteralPath (Join-Path $output 'result.json'))){throw 'Choose a new workspace evidence directory'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Read-only inspection requires Windows administrator consent'}
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server'
$product=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Josi CE Server'
$names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
$report=[ordered]@{readOnly=$true;installationStateModified=$false;sqlClientUsed=$false;servicesChanged=$false;recordedAt=[DateTime]::UtcNow.ToString('o');stage='configuration';checks=@();transactions=@();logs=@();preservedFiles=@()}
function Check([string]$Name,[scriptblock]$Read){
    try{$value=& $Read;$report.checks+=@([ordered]@{name=$Name;ok=$true;value=$value})}
    catch{$report.checks+=@([ordered]@{name=$Name;ok=$false;errorType=$_.Exception.GetType().Name;hresult=$_.Exception.HResult;command=$_.InvocationInfo.MyCommand.Name;line=$_.InvocationInfo.ScriptLineNumber})}
}
function Hash-Private([string]$Path,[string]$Label){
    if(Test-Path -LiteralPath $Path -PathType Leaf){$item=Get-Item -LiteralPath $Path -Force;$report.preservedFiles+=@([ordered]@{path=$Label;size=$item.Length;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()})}
}
try{
    $config=Get-Content -LiteralPath (Join-Path $data 'config\runtime.json') -Raw|ConvertFrom-Json
    $report.configuration=[ordered]@{version=$config.version;databasePort=$config.databasePort;apiPort=$config.apiPort;publicUrl=$config.publicUrl}
    $program=Join-Path $product ('versions\'+$config.version)
    foreach($relative in @('config\runtime.json','secrets\master-key','secrets\database-password','secrets\voice-control-token','Open Josi.html')){Hash-Private (Join-Path $data $relative) $relative}
    $report.stage='services'
    $services=@(Get-CimInstance Win32_Service | Where-Object {$names -contains $_.Name})
    $report.services=@($services|ForEach-Object{[ordered]@{name=$_.Name;state=$_.State;startMode=$_.StartMode;restrictedIdentity=($_.StartName -ieq ('NT SERVICE\'+$_.Name));expectedVersionPath=([bool]$_.PathName -and $_.PathName.Contains($program+'\'));exitCode=$_.ExitCode;serviceExitCode=$_.ServiceSpecificExitCode}})
    Check 'six-services-ready' {if($services.Count -ne 6 -or @($services|Where-Object{$_.State -cne 'Running' -or $_.StartName -ine ('NT SERVICE\'+$_.Name) -or !$_.PathName.Contains($program+'\')}).Count){throw 'Service validation failed'};return $true}
    $report.stage='readiness'
    Check 'proxy-application-ready' { $r=Invoke-WebRequest 'http://localhost:8080/ready' -UseBasicParsing -TimeoutSec 5;return @{status=$r.StatusCode;ready=($r.StatusCode -eq 200)} }
    Check 'direct-application-ready' { $r=Invoke-WebRequest 'http://127.0.0.1:18080/ready' -UseBasicParsing -TimeoutSec 5;return @{status=$r.StatusCode;ready=($r.StatusCode -eq 200)} }
    Check 'voice-control-token-readable' {$token=[IO.File]::ReadAllText((Join-Path $data 'secrets\voice-control-token'));try{if(!$token){throw 'Empty token'};return $true}finally{$token=$null}}
    Check 'speech-control-ready' {
        $token=[IO.File]::ReadAllText((Join-Path $data 'secrets\voice-control-token'))
        try{$speech=Invoke-RestMethod 'http://127.0.0.1:18082/status' -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 5}finally{$token=$null}
        return @{healthy=[bool]$speech.healthy;cpu=($speech.settings.device -ceq 'cpu');enabled=[bool]$speech.enabled;apiReady=[bool]$speech.apiReady;modelsReady=[bool]$speech.modelsReady}
    }
    Check 'local-only-listeners' {
        $listeners=@(Get-NetTCPConnection -State Listen|Where-Object{$_.LocalPort -in @(15432,18080,18081,18082,8080)})
        return @{passed=($listeners.Count -eq 5 -and !@($listeners|Where-Object LocalAddress -ne '127.0.0.1').Count);count=$listeners.Count;listeners=@($listeners|Select-Object LocalAddress,LocalPort)}
    }
    $report.stage='transactions'
    foreach($directory in Get-ChildItem -LiteralPath (Join-Path $data 'transactions') -Directory){
        $records=@();$files=@()
        foreach($file in Get-ChildItem -LiteralPath $directory.FullName -File -Filter '*.json'|Where-Object Name -Match '^\d{4}\.json$'|Sort-Object Name){
            $record=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
            $records+=@($record|Select-Object sequence,operation,fromVersion,toVersion,phase,category,recordedAt)
            $files+=@{name=$file.Name;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
        $report.transactions+=@([ordered]@{id=$directory.Name;records=$records;journalHashes=$files;retainedEntries=@(Get-ChildItem -LiteralPath $directory.FullName -Force|Select-Object Name,Length,PSIsContainer)})
    }
    $report.stage='logs'
    # Scan fixed service logs only. Export known error codes, not raw lines,
    # process arguments, request content, credentials or SQL.
    foreach($root in @((Join-Path $data 'logs'),(Join-Path $program 'services'))){
        if(!(Test-Path -LiteralPath $root -PathType Container)){continue}
        foreach($file in Get-ChildItem -LiteralPath $root -Recurse -File|Where-Object {$_.Name -match '\.(log|txt)$'}){
            $tail=(Get-Content -LiteralPath $file.FullName -Tail 100 -ErrorAction SilentlyContinue)-join "`n"
            $codes=@([regex]::Matches($tail,'\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|EACCES|ENOENT|ECONNREFUSED|SyntaxError|TypeError|ReferenceError|PermissionError|FileNotFoundError|TimeoutError|ImportError)\b')|ForEach-Object Value|Sort-Object -Unique)
            $report.logs+=@{relative=$file.FullName.Substring($root.Length+1);root=$(if($root -eq (Join-Path $data 'logs')){'data-logs'}else{'version-services'});size=$file.Length;modifiedUtc=$file.LastWriteTimeUtc.ToString('o');errorCodes=$codes}
        }
    }
    $report.stage='complete';$report.inspectionCompleted=$true
}catch{
    $report.inspectionCompleted=$false;$report.failure=[ordered]@{errorType=$_.Exception.GetType().Name;hresult=$_.Exception.HResult;line=$_.InvocationInfo.ScriptLineNumber;command=$_.InvocationInfo.MyCommand.Name}
}finally{
    # Write ONLY the redacted report in the designated workspace directory.
    $bytes=[Text.Encoding]::UTF8.GetBytes(($report|ConvertTo-Json -Depth 10))
    $stream=[IO.FileStream]::new((Join-Path $output 'result.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
