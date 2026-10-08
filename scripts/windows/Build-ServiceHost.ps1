# Locally build maintained WinSW with the demonstrated least-privilege fix.
# No service registration, execution-policy change, or global SDK install.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$archive=Join-Path $base 'sources\winsw\winsw-eef5bade59fca0254e387ac73ed7625ba6aa7147.zip'
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne '15581a065018d6828041dfd764876b1bf9087a8fe0cc26506e1e9f5a81951c43'){
    throw 'Upstream service-host source integrity failed'
}
$stage=Join-Path $base ('staging\winsw-native-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($stage)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($archive,$stage)
$source=Join-Path $stage 'winsw-eef5bade59fca0254e387ac73ed7625ba6aa7147'
$path=Join-Path $source 'src\WinSW\WrapperService.cs'
$text=[IO.File]::ReadAllText($path)
$needle='using var scm = ServiceManager.Open();'
if(([regex]::Matches($text,[regex]::Escape($needle))).Count -ne 1){throw 'Upstream service-host patch no longer matches'}
[IO.File]::WriteAllText($path,$text.Replace($needle,'using var scm = ServiceManager.Open(ServiceApis.ServiceManagerAccess.Connect);'),[Text.UTF8Encoding]::new($false))
# The maintained logging dependency requires net462. Windows 11's existing
# Framework 4.8 supports it; no separate CLR is downloaded into the runtime.
foreach($relative in @('src\WinSW\WinSW.csproj','src\WinSW.Core\WinSW.Core.csproj','src\WinSW.Plugins\WinSW.Plugins.csproj','Directory.Build.targets')){
    $path=Join-Path $source $relative;$text=[IO.File]::ReadAllText($path)
    $text=$text.Replace('net461','net462').Replace('Version="2.0.12"','Version="3.5.0"').Replace('Version="1.0.0"','Version="1.0.3"').Replace('Version="1.2.0-beta.*"','Version="1.2.0-beta.556"')
    [IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false))
}
$env:DOTNET_CLI_HOME=Join-Path $base 'cache\dotnet-home'
$env:NUGET_PACKAGES=(Join-Path $base 'cache\nuget')+'\'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
$env:TEMP=Join-Path $base 'cache';$env:TMP=$env:TEMP
foreach($project in @('WinSW','WinSW.Core','WinSW.Plugins')){
    Copy-Item -LiteralPath (Join-Path $repo ('packaging\windows\service-host-dependencies\'+$project+'.lock.json')) `
        -Destination (Join-Path $source ('src\'+$project+'\packages.lock.json'))
}
& (Join-Path $env:ProgramFiles 'dotnet\dotnet.exe') build (Join-Path $source 'src\WinSW\WinSW.csproj') -c Release -f net462 `
    '-p:TargetFrameworks=net462' '-p:PublishTrimmed=false' '-p:RestorePackagesWithLockFile=true' `
    '-p:RunAnalyzers=false' '-p:TreatWarningsAsErrors=false' '-p:ContinuousIntegrationBuild=true' '-p:RestoreLockedMode=true'
if($LASTEXITCODE){throw 'Native service-host build failed'}
$binary=Join-Path $source 'artifacts\publish\WinSW.NET461.exe'
if(!(Test-Path -LiteralPath $binary)){throw 'Merged service host is missing'}
$hash=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
$evidence=[ordered]@{schemaVersion=1;upstreamVersion='2.12.0';variant='2.12.0+josi.windows1';
    upstreamCommit='eef5bade59fca0254e387ac73ed7625ba6aa7147';sourceArchiveSha256='15581a065018d6828041dfd764876b1bf9087a8fe0cc26506e1e9f5a81951c43';
    binary=$binary;sha256=$hash;size=(Get-Item -LiteralPath $binary).Length;framework='net462';
    log4net='3.5.0';yamlDotNet='8.1.2';scmCompletionRequestsConnectOnly=$true;source=$source;
    patchSha256=(Get-FileHash -LiteralPath (Join-Path $repo 'packaging\windows\winsw-least-privilege.patch') -Algorithm SHA256).Hash.ToLowerInvariant();
    scmAcceptancePassed=$false;signed=$false}
$evidence | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\service-host-build.json') -Encoding UTF8
$evidence | ConvertTo-Json
