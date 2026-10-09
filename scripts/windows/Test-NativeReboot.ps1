# Post-reboot acceptance only. Read installation/service state; never start,
# stop, recreate, repair, restore or reconfigure anything from this entry.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$baseline=Get-Content -LiteralPath (Join-Path $base 'evidence\reboot-baseline.json') -Raw | ConvertFrom-Json
$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
if($boot -le [DateTime]::Parse($baseline.lastBootUtc).ToUniversalTime()){throw 'An actual Windows reboot is required before this check'}
$helper=Get-Content -LiteralPath (Join-Path $base 'evidence\native-setup-helper.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $helper.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne '834f9e97ac5a048d2a9e6fc0a1fad13f88e181b3724f223f9c781c3e53d2c97b'){throw 'Inspection bridge changed'}
Add-Type -Path $helper.binary
Import-Module (Join-Path $repo 'packaging\windows\Maintenance.psm1')
$context=Get-NativeMaintenanceContext $baseline.installationId $baseline.candidate
$configPath=Join-Path $context.Data 'config\runtime.json'
$configuration=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if($configuration.version -cne $baseline.candidate -or $configuration.databasePort -ne 15432 -or $configuration.apiPort -ne 18080 -or $configuration.publicUrl -cne 'http://localhost:8080'){throw 'Installed configuration differs from the accepted local candidate'}
$names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
$deadline=[DateTime]::UtcNow.AddSeconds(120)
do{
    $services=@(Get-CimInstance Win32_Service | Where-Object {$names -contains $_.Name} | Select-Object Name,State,StartMode,StartName,PathName)
    if($services.Count -eq 6 -and !@($services | Where-Object State -ne 'Running').Count){break}
    Start-Sleep -Milliseconds 500
}while([DateTime]::UtcNow -lt $deadline)
if($services.Count -ne 6 -or @($services | Where-Object {$_.State -ne 'Running' -or $_.StartName -ine ('NT SERVICE\'+$_.Name) -or !$_.PathName.Contains($context.Program+'\') -or ($_.Name -ceq 'JosiVoice' -and $_.StartMode -cne 'Manual') -or ($_.Name -cne 'JosiVoice' -and $_.StartMode -cne 'Auto')}).Count){throw 'Post-reboot service startup requires review; no state was changed'}
if((Invoke-WebRequest 'http://localhost:8080/ready' -UseBasicParsing -TimeoutSec 5).StatusCode -ne 200){throw 'Post-reboot application/database readiness failed'}
$listeners=@(Get-NetTCPConnection -State Listen | Where-Object {@(15432,18080,18081,18082,8080) -contains $_.LocalPort})
if($listeners.Count -ne 5 -or @($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count){throw 'Post-reboot private listener validation failed'}
$antivirus=Get-Content -LiteralPath (Join-Path $context.Data 'state\antivirus.json') -Raw | ConvertFrom-Json
if($antivirus.provider -cne 'windows-amsi' -or $antivirus.status -cne 'available' -or [DateTime]::Parse($antivirus.checkedAt).ToUniversalTime() -lt $boot){throw 'Post-reboot explicit worker AMSI availability was not verified'}
$token=[IO.File]::ReadAllText((Join-Path $context.Data 'voice\gateway\token'))
try{
    $voice=Invoke-RestMethod 'http://127.0.0.1:18081/ready' -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 5
    if(!$voice.modelsReady){throw 'Post-reboot CPU speech readiness failed'}
}finally{$token=$null}
$report=[ordered]@{passed=$true;installationId=$baseline.installationId;candidate=$baseline.candidate;actualReboot=$true;bootUtc=$boot.ToString('o');sixRestrictedServicesRunning=$true;applicationDatabaseReady=$true;listenersLocalOnly=$true;freshExplicitWorkerAmsi=$true;cpuSpeechReady=$true;installationStateModified=$false;recordedAt=[DateTime]::UtcNow.ToString('o')}
Import-Module (Join-Path $repo 'packaging\windows\StartupEvidence.psm1')
$report.startupEvidence=Get-NativeStartupEvidence $boot
$destination=Join-Path $base ('evidence\native-reboot-'+[Guid]::NewGuid().ToString('N')+'.json')
[IO.File]::WriteAllText($destination,($report | ConvertTo-Json -Depth 6))
$report | ConvertTo-Json -Depth 6
