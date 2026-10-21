# Stops the development server's API, worker and PostgreSQL. Data is kept.
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-dev')
$ErrorActionPreference = 'Stop'
$data = Join-Path $Root 'data'
foreach ($role in 'web', 'worker') {
    $file = Join-Path $data "state\$role.pid"
    if (!(Test-Path $file)) { continue }
    $id = [int](Get-Content $file)
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -in 'cmd', 'node') {
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $id /T /F | Out-Null
        Write-Host "$role stopped"
    }
    Remove-Item $file
}
& (Join-Path $Root 'pgsql\bin\pg_ctl.exe') -D (Join-Path $data 'database') -m fast -w stop | Out-Null
Write-Host 'Database stopped'
