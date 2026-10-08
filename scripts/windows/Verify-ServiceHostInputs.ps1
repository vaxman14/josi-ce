# Build-time only: use the SDK's NuGet implementation for signed-package hashes.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$sdk=Join-Path $env:ProgramFiles 'dotnet\sdk\10.0.202'
foreach($name in @('NuGet.Common.dll','NuGet.Versioning.dll','NuGet.Frameworks.dll','NuGet.Packaging.dll')){
    Add-Type -Path (Join-Path $sdk $name)
}
$seen=@{};$rows=@()
foreach($lock in Get-ChildItem -LiteralPath (Join-Path $repo 'packaging\windows\service-host-dependencies') -Filter '*.lock.json'){
    $data=Get-Content -LiteralPath $lock.FullName -Raw | ConvertFrom-Json
    foreach($framework in $data.dependencies.PSObject.Properties){
        if($framework.Name -cne '.NETFramework,Version=v4.6.2' -and @($framework.Value.PSObject.Properties).Count){throw 'Unexpected nonempty target framework'}
        foreach($package in $framework.Value.PSObject.Properties){
            $entry=$package.Value
            if($entry.type -ceq 'Project'){continue}
            $key=$package.Name.ToLowerInvariant()+'/'+$entry.resolved
            if($seen.ContainsKey($key)){
                if($seen[$key] -cne $entry.contentHash){throw 'Conflicting dependency locks'}
                continue
            }
            $name=$package.Name.ToLowerInvariant();$version=$entry.resolved
            if($name -cnotmatch '^[a-z0-9.]+$' -or $version -cnotmatch '^[a-z0-9.-]+$'){throw 'Invalid build dependency identity'}
            $path=Join-Path $base ('cache\nuget\'+$name+'\'+$version+'\'+$name+'.'+$version+'.nupkg')
            $reader=[NuGet.Packaging.PackageArchiveReader]::new($path)
            try{$hash=$reader.GetContentHash([Threading.CancellationToken]::None,$null)}finally{$reader.Dispose()}
            if($hash -cne $entry.contentHash){throw 'Locked NuGet content integrity failed'}
            & (Join-Path $env:ProgramFiles 'dotnet\dotnet.exe') nuget verify $path --all
            if($LASTEXITCODE){throw 'NuGet upstream signature verification failed'}
            $seen[$key]=$hash
            $rows += [ordered]@{name=$package.Name;version=$version;contentHash=$hash;
                sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();
                upstreamSignatureVerified=$true;runtimeMerged=($name -cin @('log4net','yamldotnet'))}
        }
    }
}
[ordered]@{schemaVersion=1;sdk='10.0.202';packages=$rows;passed=$true} | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath (Join-Path $base 'evidence\service-host-build-inputs.json') -Encoding utf8
