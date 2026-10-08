# Short-lived native dependency test; this is not an installed database service.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$pg = Join-Path $base 'tools\postgresql-16.15\pgsql\bin'
$node = Join-Path $base 'tools\node-v24.21.0-win-x64\node.exe'
$root = Join-Path $base ('test-installations\postgres-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
# Lock the parent before creating credentials or database files.
$acl = Get-Acl -LiteralPath $root
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $root -AclObject $acl
$passwordFile = Join-Path $root 'password'
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
[IO.File]::WriteAllText($passwordFile, $password)
$data = Join-Path $root 'database'
$port = 15439
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
try { $probe.Start() } finally { $probe.Stop() }
& (Join-Path $pg 'initdb.exe') -D $data -U josi "--pwfile=$passwordFile" --auth-host=scram-sha-256 --auth-local=scram-sha-256 --encoding=UTF8 --locale=C > (Join-Path $root 'initdb.log')
if ($LASTEXITCODE) { throw 'Native database initialization failed' }
@("listen_addresses = '127.0.0.1'", "port = $port", "password_encryption = 'scram-sha-256'",
  "logging_collector = off", "log_statement = 'none'", "log_min_error_statement = 'panic'") |
    Add-Content -LiteralPath (Join-Path $data 'postgresql.conf')
$env:PGPASSFILE = Join-Path $root 'pgpass.conf'
[IO.File]::WriteAllText($env:PGPASSFILE, "127.0.0.1:${port}:*:josi:$password")
$password = $null
$env:PGHOST = '127.0.0.1'
$env:PGPORT = "$port"
$env:PGUSER = 'josi'
$env:PGCONNECT_TIMEOUT = '10'
$env:PGPASSWORD_FILE = $passwordFile
$env:DATABASE_URL = "postgresql://josi@127.0.0.1:${port}/josi"
$env:JOSI_TEST_PG_BIN = $pg
$env:JOSI_TEST_PG_ROOT = $root
function Invoke-TestPgControl([string]$Action) {
    $arguments = @($Action, '-D', ('"' + $data + '"'), '-w', '-t', '30')
    if ($Action -eq 'start') { $arguments += @('-l', ('"' + (Join-Path $root 'postgres.log') + '"')) }
    else { $arguments += @('-m', 'fast') }
    # Direct native invocation makes PowerShell wait on inherited server pipes.
    # Wait for pg_ctl itself, with output redirected to task-owned files.
    $process = Start-Process -FilePath (Join-Path $pg 'pg_ctl.exe') -ArgumentList $arguments `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root "$Action.out") `
        -RedirectStandardError (Join-Path $root "$Action.err")
    if (!$process.WaitForExit(45000)) { throw 'Native database control timed out' }
    if ($process.ExitCode) { throw "Native database $Action failed" }
}
try {
    Invoke-TestPgControl 'start'
    & (Join-Path $pg 'createdb.exe') --no-password josi
    if ($LASTEXITCODE) { throw 'Native test database creation failed' }
    & $node (Join-Path $repo 'packages\db\migrate.mjs') > (Join-Path $root 'migrations.log')
    if ($LASTEXITCODE) { throw 'Native migrations failed' }
    & $node (Join-Path $PSScriptRoot 'test-postgres.mjs')
    if ($LASTEXITCODE) { throw 'Native database backup/restore test failed' }
} finally {
    try { Invoke-TestPgControl 'stop' }
    finally {
        Remove-Item -LiteralPath $passwordFile, $env:PGPASSFILE -ErrorAction SilentlyContinue
        $env:PGPASSFILE = $null
        $env:PGPASSWORD_FILE = $null
    }
}
