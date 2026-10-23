# Stops the development server's API, worker and PostgreSQL. Data is kept.
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-dev')
$ErrorActionPreference = 'Stop'
$data = Join-Path $Root 'data'
foreach ($role in 'web', 'worker', 'voice') {
    $file = Join-Path $data "state\$role.pid"
    if (!(Test-Path $file)) { continue }
    $id = [int](Get-Content $file)
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    # The worker drains first: a stop file asks it to finish the pass in flight
    # (a model call holds the subscription login; killed mid-call, that login
    # stays leased and every later call refuses). Up to 3.5 minutes, then force.
    if ($role -eq 'worker' -and $process) {
        $stop = Join-Path $data 'state\worker.stop'
        Set-Content -Path $stop -Value (Get-Date).ToString('o') -Encoding ascii
        $deadline = (Get-Date).AddSeconds(210)
        while ((Get-Date) -lt $deadline) {
            $node = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").ParentProcessId -eq $id }
            if (!(Get-Process -Id $id -ErrorAction SilentlyContinue) -or !$node) { break }
            Start-Sleep -Milliseconds 500
        }
        Remove-Item $stop -ErrorAction SilentlyContinue
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    }
    # Voice: the control helper and the speech gateway it started (/T).
    if ($process -and $process.ProcessName -in 'cmd', 'node', 'python') {
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $id /T /F | Out-Null
        Write-Host "$role stopped"
    }
    Remove-Item $file
}
& (Join-Path $Root 'pgsql\bin\pg_ctl.exe') -D (Join-Path $data 'database') -m fast -w stop | Out-Null
Write-Host 'Database stopped'
