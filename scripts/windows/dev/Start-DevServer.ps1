# Starts the development Josi CE server created by New-DevServer.ps1:
# PostgreSQL, migrations, then the API (web) and worker as this user's
# processes, with the same environment packaging/windows/Runtime.mjs gives
# the installed services. Listens on 127.0.0.1 only.
#
# Long-running processes are created through WMI (Win32_Process.Create), not
# as children of this script. Children of an editor, terminal or tool session
# can share its Job Object and be ended together with it; these must keep
# running until Stop-DevServer.ps1 stops them.
[CmdletBinding()]
param([string]$Root = 'C:\Dev\josi-dev')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$data = Join-Path $Root 'data'
$pg = Join-Path $Root 'pgsql\bin'
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$settings = Get-Content -Raw (Join-Path $data 'config\runtime.json') | ConvertFrom-Json
$cluster = Join-Path $data 'database'
$cli = Join-Path $Root 'cli'
$node = (Get-Command node).Source
if (!(Test-Path (Join-Path $Root 'python\python.exe'))) {
    Write-Warning "Upload scanning needs the pinned Python in $(Join-Path $Root 'python'); uploads that require a scan will be refused."
}

function Start-Independent([string]$CommandLine, [string]$Directory) {
    # Hidden console (SW_HIDE): there is no window to close, and so no console
    # close/Ctrl+C event that would shut PostgreSQL or Node down.
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $CommandLine; CurrentDirectory = $Directory; ProcessStartupInformation = $startup }
    if ($result.ReturnValue -ne 0) { throw "Windows could not start: $CommandLine (code $($result.ReturnValue))" }
    return $result.ProcessId
}
function Test-Database { & (Join-Path $pg 'pg_ctl.exe') -D $cluster status 2>$null | Out-Null; return $LASTEXITCODE -eq 0 }
# "Running" is not "accepting connections"; recovery after an unclean stop can take a moment.
function Test-Accepting { & (Join-Path $pg 'pg_isready.exe') -h 127.0.0.1 -p $settings.databasePort -q 2>$null; return $LASTEXITCODE -eq 0 }

if (!(Test-Database)) {
    $log = Join-Path $data 'logs\database.log'
    $null = Start-Independent ('"' + (Join-Path $pg 'pg_ctl.exe') + '" -D "' + $cluster + '" -l "' + $log + '" start') $Root
}
$deadline = (Get-Date).AddSeconds(60)
while (!(Test-Accepting)) {
    if ((Get-Date) -gt $deadline) { throw "PostgreSQL is not accepting connections; see $(Join-Path $data 'logs\database.log')" }
    Start-Sleep -Milliseconds 500
}

function Get-RoleEnvironment([string]$Role) {
    $url = [Uri]$settings.publicUrl
    $profile = Join-Path $data "profiles\$Role"
    return [ordered]@{
        SystemRoot = $env:SystemRoot; WINDIR = $env:SystemRoot; COMSPEC = (Join-Path $env:SystemRoot 'System32\cmd.exe')
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
        # Upload scanning through Windows AMSI (the registered antivirus), as
        # in the installed services: pinned private Python plus the adapter.
        JOSI_PYTHON_EXE = (Join-Path $Root 'python\python.exe')
        # Josi's tool server for the Claude Code and Codex harnesses.
        JOSI_MCP_SERVER = (Join-Path $repo 'packages\agent\dist\mcp\server.js')
        JOSI_SCANNER_ADAPTER = (Join-Path $repo 'services\scanner\windows_amsi.py')
        JOSI_SCANNER_TEMP = (Join-Path $data 'temp\scanner')
        # Pinned ffmpeg (Get-Ffmpeg.ps1): video frames and soundtracks for attachments.
        JOSI_FFMPEG_EXE = (Join-Path $Root 'ffmpeg\ffmpeg.exe'); JOSI_FFPROBE_EXE = (Join-Path $Root 'ffmpeg\ffprobe.exe')
        # Same private profile layout as the installed services.
        USERPROFILE = $profile; HOME = $profile
        APPDATA = (Join-Path $profile 'AppData\Roaming'); LOCALAPPDATA = (Join-Path $profile 'AppData\Local')
        # Service PATH: pinned subscription CLIs (vendor-signed native .exe
        # files), Codex's bundled ripgrep, Node, and System32. Nothing from the
        # developer's own PATH, profile or provider credentials.
        PATH = (@((Join-Path $cli 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin'),
            (Join-Path $cli 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex-path'),
            (Join-Path $cli 'node_modules\@anthropic-ai\claude-code-win32-x64'),
            (Split-Path $node), (Join-Path $env:SystemRoot 'System32')) -join ';')
    }
}

Push-Location $repo
try {
    # Migrations finish before anything starts, so they run here directly.
    $saved = @{}
    foreach ($pair in (Get-RoleEnvironment 'migrate').GetEnumerator()) {
        $saved[$pair.Key] = [Environment]::GetEnvironmentVariable($pair.Key)
        Set-Item -Path "Env:$($pair.Key)" -Value $pair.Value
    }
    try {
        & $node packages\db\migrate.mjs
        if ($LASTEXITCODE) { throw 'Database migrations failed' }
    } finally {
        foreach ($pair in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value) }
    }

    foreach ($role in 'web', 'worker') {
        $pidFile = Join-Path $data "state\$role.pid"
        if (Test-Path $pidFile) {
            $existing = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
            if ($existing) { Write-Host "$role already running (pid $($existing.Id))"; continue }
        }
        foreach ($folder in "profiles\$role\AppData\Roaming", "profiles\$role\AppData\Local", "temp\$role") {
            $null = New-Item -ItemType Directory -Force (Join-Path $data $folder)
        }
        $entry = if ($role -eq 'web') { 'apps\api\dist\server.js' } else { 'apps\worker\dist\main.js' }
        # A launcher file carries the exact environment; it holds paths only,
        # never secret values (those stay in the protected secret files).
        $launcher = Join-Path $data "state\run-$role.cmd"
        $lines = @('@echo off')
        foreach ($pair in (Get-RoleEnvironment $role).GetEnumerator()) { $lines += 'set "' + $pair.Key + '=' + $pair.Value + '"' }
        $lines += 'cd /d "' + $repo + '"'
        $lines += '"' + $node + '" ' + $entry + ' 1>>"' + (Join-Path $data "logs\$role.log") + '" 2>>"' + (Join-Path $data "logs\$role.err.log") + '"'
        [IO.File]::WriteAllLines($launcher, $lines, [Text.Encoding]::ASCII)
        $id = Start-Independent ('"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') + '" /d /c "' + $launcher + '"') $repo
        Set-Content -Path $pidFile -Value $id
        Write-Host "$role started (pid $id); log: $(Join-Path $data "logs\$role.log")"
    }
} finally { Pop-Location }

# Voice Box, when its pinned runtime and verified models are present (see
# docs/WINDOWS_DEV_VOICE.md). The control helper runs as this user with the
# installed services' environment; JOSI_VOICE_DEVELOPMENT=1 makes it start the
# speech gateway as its own hidden process instead of a Windows service.
$voicePython = Join-Path $Root 'voice-python\python.exe'
$voiceModels = Join-Path $Root 'voice-models'
if ((Test-Path $voicePython) -and (Test-Path (Join-Path $voiceModels 'base.en\model.bin'))) {
    $pidFile = Join-Path $data 'state\voice.pid'
    $running = (Test-Path $pidFile) -and (Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue)
    if (!$running) {
        foreach ($folder in 'voice\gateway', 'voice\control', 'temp\voice', 'profiles\voice') { $null = New-Item -ItemType Directory -Force (Join-Path $data $folder) }
        $gateway = Join-Path $data 'voice\gateway'
        if (!(Test-Path (Join-Path $gateway 'token'))) {
            $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
            [IO.File]::WriteAllText((Join-Path $gateway 'token'), (([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()), [Text.Encoding]::ASCII)
        }
        if (!(Test-Path (Join-Path $gateway 'settings.json'))) {
            [IO.File]::WriteAllText((Join-Path $gateway 'settings.json'), '{"model":"base.en","voice":"af_heart","threshold":0.5,"silenceMs":700,"speed":1.0,"device":"cpu"}', [Text.UTF8Encoding]::new($false))
        }
        $service = Join-Path $repo 'services\voice-box'
        $voiceEnv = [ordered]@{
            SystemRoot = $env:SystemRoot; WINDIR = $env:SystemRoot; PATH = ((Split-Path $voicePython) + ';' + (Join-Path $env:SystemRoot 'System32'))
            TEMP = (Join-Path $data 'temp\voice'); TMP = (Join-Path $data 'temp\voice')
            USERPROFILE = (Join-Path $data 'profiles\voice'); HOME = (Join-Path $data 'profiles\voice')
            JOSI_VERSION = $settings.version; JOSI_VOICE_PORT = '18081'; JOSI_VOICE_HELPER_PORT = '18082'
            JOSI_VOICE_STATE_DIR = $gateway; JOSI_VOICE_HELPER_STATE_DIR = (Join-Path $data 'voice\control')
            JOSI_VOICE_MODELS_DIR = $voiceModels; JOSI_VOICE_HELPER_TOKEN_FILE = (Join-Path $data 'secrets\voice-control-token')
            JOSI_VOICE_DEVELOPMENT = '1'
        }
        $lines = @('@echo off')
        foreach ($pair in $voiceEnv.GetEnumerator()) { $lines += 'set "' + $pair.Key + '=' + $pair.Value + '"' }
        $lines += 'cd /d "' + $service + '"'
        $launch = "import runpy,sys;sys.path.insert(0,r'$service');runpy.run_path(r'$(Join-Path $service 'windows_helper.py')',run_name='__main__')"
        $lines += '"' + $voicePython + '" -I -B -c "' + $launch + '" 1>>"' + (Join-Path $data 'logs\voice.log') + '" 2>>"' + (Join-Path $data 'logs\voice.err.log') + '"'
        $launcher = Join-Path $data 'state\run-voice.cmd'
        [IO.File]::WriteAllLines($launcher, $lines, [Text.Encoding]::ASCII)
        $id = Start-Independent ('"' + (Join-Path $env:SystemRoot 'System32\cmd.exe') + '" /d /c "' + $launcher + '"') $service
        Set-Content -Path $pidFile -Value $id
        Write-Host "voice started (pid $id); log: $(Join-Path $data 'logs\voice.err.log')"
    }
} else { Write-Warning 'Voice Box runtime or models are missing; audio and video transcripts are unavailable.' }

# 127.0.0.1, not localhost: the API listens on IPv4 only, and Windows tries
# ::1 first, which used up the whole per-attempt timeout.
$deadline = (Get-Date).AddSeconds(180)
while ($true) {
    try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$($settings.apiPort)/api/onboarding/state"; break }
    catch { if ((Get-Date) -gt $deadline) { throw "The API did not answer; see $(Join-Path $data 'logs\web.err.log')" }; Start-Sleep -Milliseconds 500 }
}
Write-Host "Josi development server: $($settings.publicUrl)"
