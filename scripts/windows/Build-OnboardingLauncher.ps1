param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$stage=Join-Path $base ('staging\onboarding-launcher-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($stage)
foreach($name in @('JosiLauncher.csproj','JosiLauncher.cs','LauncherTests.cs')){Copy-Item -LiteralPath (Join-Path $repo ('packaging\windows\launcher\'+$name)) -Destination $stage}
Copy-Item -LiteralPath (Join-Path $repo 'packaging\windows\launcher\packages.lock.json') -Destination $stage
$env:DOTNET_CLI_HOME=Join-Path $base 'cache\dotnet-home';$env:NUGET_PACKAGES=(Join-Path $base 'cache\nuget')+'\'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1';$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1';$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
$env:TEMP=Join-Path $base 'cache';$env:TMP=$env:TEMP
$sdk=Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
& $sdk build (Join-Path $stage 'JosiLauncher.csproj') -c Release '-p:RestoreLockedMode=true'
if($LASTEXITCODE){throw 'Onboarding launcher build failed'}
$binary=Join-Path $stage 'bin\Release\net462\JosiLauncher.exe'
$tests=[IO.File]::ReadAllText((Join-Path $stage 'JosiLauncher.csproj')).Replace('<OutputType>WinExe</OutputType>','<OutputType>Exe</OutputType><StartupObject>LauncherTests</StartupObject>').Replace('<AssemblyName>JosiLauncher</AssemblyName>','<AssemblyName>LauncherTests</AssemblyName>').Replace('<Compile Include="JosiLauncher.cs" />','<Compile Include="JosiLauncher.cs" /><Compile Include="LauncherTests.cs" />')
[IO.File]::WriteAllText((Join-Path $stage 'LauncherTests.csproj'),$tests)
& $sdk build (Join-Path $stage 'LauncherTests.csproj') -c Release '-p:RestoreLockedMode=true'
if($LASTEXITCODE){throw 'Onboarding launcher tests did not build'}
& (Join-Path $stage 'bin\Release\net462\LauncherTests.exe')
if($LASTEXITCODE){throw 'Onboarding launcher tests failed'}
$report=[ordered]@{passed=$true;binary=$binary;size=(Get-Item $binary).Length;sha256=(Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant();
 sourceSha256=(Get-FileHash (Join-Path $repo 'packaging\windows\launcher\JosiLauncher.cs') -Algorithm SHA256).Hash.ToLowerInvariant();
 framework='net462';architecture='x64';consoleWindow=$false;testsPassed=$true;installed=$false;browserAssociationPhysicalTested=$false}
$report|ConvertTo-Json|Set-Content (Join-Path $base 'evidence\onboarding-launcher.json') -Encoding UTF8
