# Starts the development Josi CE server created by New-DevServer.ps1:
# PostgreSQL, migrations, then the API (web) and worker as this user's
# processes, with the same environment packaging/windows/Runtime.mjs gives
# the installed services. Listens on 127.0.0.1 only.
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-dev')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$data = Join-Path $Root 'data'
# pg_ctl start leaves the database holding any handles it inherits; launch it
# through the shell (no handle inheritance) and wait for pg_ctl alone.
function Start-Database([string]$Bin, [string]$Cluster, [string]$Log) {
    $process = Start-Process (Join-Path $Bin 'pg_ctl.exe') -ArgumentList ('-D "' + $Cluster + '" -l "' + $Log + '" -w start') -WindowStyle Hidden -PassThru
    $process.WaitForExit()
    if ($process.ExitCode) { throw "PostgreSQL did not start; see $Log" }
}
$pg = Join-Path $Root 'pgsql\bin'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$settings = Get-Content -Raw (Join-Path $data 'config\runtime.json') | ConvertFrom-Json
$cluster = Join-Path $data 'database'

& (Join-Path $pg 'pg_ctl.exe') -D $cluster status | Out-Null
if ($LASTEXITCODE -ne 0) {
    Start-Database $pg $cluster (Join-Path $data 'logs\database.log')
}

function Set-RoleEnvironment([string]$Role) {
    $url = [Uri]$settings.publicUrl
    $values = [ordered]@{
        NODE_ENV = 'production'; JOSI_NATIVE_RUNTIME = '1'; JOSI_VERSION = $settings.version
        JOSI_DATA_DIR = $data; JOSI_STORAGE_ROOT_BASE = (Join-Path $data 'roots'); JOSI_UPLOAD_DIR = (Join-Path $data 'chat-attachments')
        MASTER_KEY_FILE = (Join-Path $data 'secrets\master-key')
        DATABASE_URL = "postgresql://josi@127.0.0.1:$($settings.databasePort)/josi"
        PGHOST = '127.0.0.1'; PGPORT = [string]$settings.databasePort; POSTGRES_DB = 'josi'; POSTGRES_USER = 'josi'
        PGPASSWORD_FILE = (Join-Path $data 'secrets\database-password'); JOSI_PG_BIN = $pg
        PORT = [string]$settings.apiPort; APP_URL = $url.GetLeftPart([UriPartial]::Authority)
        WEB_DIR = (Join-Path $repo 'apps\web\dist'); JOSI_SETUP_TOKEN_SHA256 = $settings.setupTokenSha256
        JOSI_WORKER_HEARTBEAT_FILE = (Join-Path $data 'state\worker-heartbeat'); CODEX_HOME = (Join-Path $data 'codex')
        JOSI_VOICE_HELPER_TOKEN_FILE = (Join-Path $data 'secrets\voice-control-token'); JOSI_VOICE_HELPER_PORT = '18082'
        TEMP = (Join-Path $data "temp\$Role"); TMP = (Join-Path $data "temp\$Role")
    }
    foreach ($pair in $values.GetEnumerator()) { Set-Item -Path "Env:$($pair.Key)" -Value $pair.Value }
    # Never pass this developer's provider credentials to the server.
    foreach ($name in 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MASTER_KEY', 'CREDENTIALS_KEY', 'PGPASSWORD') {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
}

Push-Location $repo
try {
    Set-RoleEnvironment 'migrate'
    & node packages\db\migrate.mjs
    if ($LASTEXITCODE) { throw 'Database migrations failed' }
    foreach ($role in 'web', 'worker') {
        Set-RoleEnvironment $role
        $entry = if ($role -eq 'web') { 'apps\api\dist\server.js' } else { 'apps\worker\dist\main.js' }
        $log = Join-Path $data "logs\$role.log"
        # Launched through the shell so no caller handle is inherited; the
        # process outlives this script and logs to files.
        $command = '/d /c node ' + $entry + ' 1>>"' + $log + '" 2>>"' + (Join-Path $data "logs\$role.err.log") + '"'
        $process = Start-Process cmd.exe -ArgumentList $command -WorkingDirectory $repo -WindowStyle Hidden -PassThru
        Set-Content -Path (Join-Path $data "state\$role.pid") -Value $process.Id
        Write-Host "$role started (pid $($process.Id)); log: $log"
    }
} finally { Pop-Location }
Write-Host "Josi development server: $($settings.publicUrl)"
