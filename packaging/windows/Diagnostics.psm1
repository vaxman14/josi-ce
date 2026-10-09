# Structured allowlist export. Never include SQL, file contents, credentials,
# raw logs, command lines, environment, hostname or user profile paths.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'StartupEvidence.psm1')
function Get-NativeDiagnostics {
    $names=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
    $data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server'
    $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
    $services=@(Get-CimInstance Win32_Service | Where-Object {$names -contains $_.Name} | ForEach-Object {
        [ordered]@{name=$_.Name;state=$_.State;startMode=$_.StartMode;restrictedIdentity=($_.StartName -ieq ('NT SERVICE\'+$_.Name))}
    })
    $listeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in @(15432,18080,18081,18082,8080)} | ForEach-Object {
        [ordered]@{address=$_.LocalAddress;port=$_.LocalPort;localOnly=$_.LocalAddress -ceq '127.0.0.1'}
    })
    $ready=$false
    try{$ready=(Invoke-WebRequest 'http://localhost:8080/ready' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200}catch{}
    $speech=[ordered]@{status='unavailable';healthy=$false;cpu=$null}
    try{
        $token=[IO.File]::ReadAllText((Join-Path $data 'secrets\voice-control-token'))
        try{$value=Invoke-RestMethod 'http://127.0.0.1:18082/status' -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 5}finally{$token=$null}
        $speech=[ordered]@{status=$(if($value.healthy){'healthy'}else{'error'});healthy=[bool]$value.healthy;cpu=$value.settings.device -ceq 'cpu'}
    }catch{}
    $antivirus=[ordered]@{provider='windows-amsi';status='unavailable';fresh=$false}
    try{
        $value=Get-Content -LiteralPath (Join-Path $data 'state\antivirus.json') -Raw | ConvertFrom-Json
        if($value.provider -ceq 'windows-amsi' -and $value.status -cin @('available','error','unavailable')){
            $antivirus.status=$value.status;$antivirus.fresh=[DateTime]::Parse($value.checkedAt).ToUniversalTime() -ge $boot
            if(!$antivirus.fresh){$antivirus.status='unavailable'}
        }
    }catch{}
    $startup=$null
    try{$startup=Get-NativeStartupEvidence $boot}catch{$startup=[ordered]@{status='error';historicalOrderingConfirmed=$false;errorType=$_.Exception.GetType().Name}}
    return [pscustomobject][ordered]@{schemaVersion=1;product='Josi CE Server';recordedAt=[DateTime]::UtcNow.ToString('o');bootUtc=$boot.ToString('o');services=$services;listeners=$listeners;applicationDatabaseReady=$ready;speech=$speech;antivirus=$antivirus;startupEvidence=$startup;redaction='structured allowlist; no SQL, secrets, raw logs, command lines, environment, hostname or profile paths';installationStateModified=$false}
}
function Export-NativeDiagnostics([string]$Destination){
    $full=[IO.Path]::GetFullPath($Destination)
    foreach($root in @((Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server'),(Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Josi CE Server'))){
        if($full -ieq $root -or $full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Diagnostics cannot overwrite installation or preserved data'}
    }
    if(Test-Path -LiteralPath $full){throw 'Diagnostics destination already exists; preserve prior evidence'}
    $report=Get-NativeDiagnostics
    $bytes=[Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 8))
    $stream=[IO.FileStream]::new($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    return $report
}
Export-ModuleMember -Function Get-NativeDiagnostics, Export-NativeDiagnostics
