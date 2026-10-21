# Creates a private development Josi CE server for the current Windows user.
# Mirrors the native installer's layout, secrets and database bootstrap, but
# runs under this account: no Windows services, no elevation, localhost only.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\dev\New-DevServer.ps1
[CmdletBinding()]
param(
    [string]$Root = 'C:\Dev\josi-dev',
    [int]$DatabasePort = 15432
)
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
if (!(Test-Path (Join-Path $pg 'postgres.exe'))) { throw "PostgreSQL 16 binaries not found in $pg" }
if (Test-Path (Join-Path $data 'database\PG_VERSION')) { throw "A development database already exists in $data; refusing to overwrite it" }

foreach ($folder in 'config', 'secrets', 'database', 'roots', 'chat-attachments', 'state', 'codex', 'logs',
    'temp\web', 'temp\worker', 'temp\migrate', 'temp\database', 'temp\scanner',
    'profiles\web', 'profiles\worker', 'profiles\migrate') {
    $null = New-Item -ItemType Directory -Force (Join-Path $data $folder)
}

# Secret files: owned by this user; only this user, SYSTEM and Administrators
# have access; inheritance removed. This is the development identity case that
# readWindowsSecret explicitly accepts.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
$admins = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
function New-Token {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}
function Write-Private([string]$Path, [string]$Text) {
    if (Test-Path $Path) { throw "$Path already exists" }
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetOwner($me)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in $me, $system, $admins) {
        $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $ascii = [Text.Encoding]::ASCII.GetBytes($Text); $stream.Write($ascii, 0, $ascii.Length) } finally { $stream.Dispose() }
    Set-Acl -LiteralPath $Path -AclObject $security
}
foreach ($name in 'master-key', 'database-password', 'init-password', 'voice-control-token') {
    Write-Private (Join-Path $data "secrets\$name") (New-Token)
}
# First-run handoff for the Windows app: {port, token}, readable only by the
# person who created the server. Only the token's SHA-256 reaches the server.
$setupToken = New-Token
$null = New-Item -ItemType Directory -Force (Join-Path $data 'first-run')
Write-Private (Join-Path $data 'first-run\bootstrap.json') ((@{ schemaVersion = 1; port = 8080; token = $setupToken } | ConvertTo-Json -Compress))
$sha = [Security.Cryptography.SHA256]::Create()
$setupHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($setupToken))) -replace '-', '').ToLowerInvariant()
$setupToken = $null

$runtime = [ordered]@{ schemaVersion = 1; version = '0.7.0-dev'; databasePort = $DatabasePort; apiPort = 8080
    publicUrl = 'http://localhost:8080'; setupTokenSha256 = $setupHash }
[IO.File]::WriteAllText((Join-Path $data 'config\runtime.json'), ($runtime | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))

# Same initdb arguments as packaging/windows/Database.psm1.
$cluster = Join-Path $data 'database'
& (Join-Path $pg 'initdb.exe') -D $cluster -U bootstrap_admin "--pwfile=$(Join-Path $data 'secrets\init-password')" `
    --auth-host=scram-sha-256 --auth-local=scram-sha-256 --encoding=UTF8 --locale=C | Out-Null
if ($LASTEXITCODE) { throw 'initdb failed' }
$configuration = @("listen_addresses='127.0.0.1'", "port=$DatabasePort", "password_encryption='scram-sha-256'",
    "log_statement='none'", "log_min_error_statement='panic'", 'log_parameter_max_length=0',
    'log_parameter_max_length_on_error=0', 'logging_collector=off') -join "`n"
[IO.File]::WriteAllText((Join-Path $cluster 'postgresql.auto.conf'), ($configuration + "`n"), [Text.UTF8Encoding]::new($false))
Start-Database $pg $cluster (Join-Path $data 'logs\database.log')

# Same role/database bootstrap as packaging/windows/DatabaseBootstrap.mjs.
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$env:JOSI_DEV_DATA = $data
Push-Location $repo
try { & node (Join-Path $PSScriptRoot 'dev-bootstrap.mjs') $data; if ($LASTEXITCODE) { throw 'Database provisioning failed' } }
finally { Pop-Location }
Write-Host "Development server data created in $data. Start it with Start-DevServer.ps1."
