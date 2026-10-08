# Build-time SDK only. The installer will load this bridge with Windows' CLR,
# avoiding source compilation on the end user's machine.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$stage=Join-Path $base ('staging\native-setup-helper-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($stage)
foreach($file in @('Josi.NativeSetup.csproj','packages.lock.json')){
    Copy-Item -LiteralPath (Join-Path $repo ('packaging\windows\native-helper-build\'+$file)) -Destination (Join-Path $stage $file)
}
Copy-Item -LiteralPath (Join-Path $repo 'packaging\windows\NativeFileAttributes.cs') -Destination (Join-Path $stage 'NativeFileAttributes.cs')
[IO.File]::WriteAllText((Join-Path $stage 'NuGet.Config'),'<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>')
$env:DOTNET_CLI_HOME=Join-Path $base 'cache\dotnet-home'
$env:NUGET_PACKAGES=(Join-Path $base 'cache\nuget')+'\'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1';$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1';$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
$env:TEMP=Join-Path $base 'cache';$env:TMP=$env:TEMP
& (Join-Path $env:ProgramFiles 'dotnet\dotnet.exe') build (Join-Path $stage 'Josi.NativeSetup.csproj') -c Release '-p:RestoreLockedMode=true'
if($LASTEXITCODE){throw 'The precompiled Windows setup bridge did not build'}
$binary=Join-Path $stage 'bin\Release\net462\Josi.NativeSetup.dll'
$report=[ordered]@{passed=$true;binary=$binary;size=(Get-Item -LiteralPath $binary).Length;
    sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();
    sourceSha256=(Get-FileHash -LiteralPath (Join-Path $stage 'NativeFileAttributes.cs') -Algorithm SHA256).Hash.ToLowerInvariant();
    framework='net462';architecture='x64';sdkRequiredAtBuildOnly=$true;testedInOsPowerShell=$false;signed=$false;releaseApproved=$false}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\native-setup-helper.json') -Encoding UTF8
