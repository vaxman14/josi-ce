[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$lock=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'msvc-supplement.lock.json') -Raw | ConvertFrom-Json
$cache=Join-Path $base 'cache\msvc-supplement'
$output=Join-Path $base 'tools\msvc-supplement'
$null=[IO.Directory]::CreateDirectory($cache); $null=[IO.Directory]::CreateDirectory($output)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$verified=@()
foreach($package in $lock.packages){
    if($package.url -notmatch '^https://download\.visualstudio\.microsoft\.com/download/pr/' -or
        $package.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid compiler supplement pin'}
    $file=Join-Path $cache ($package.id+'.vsix')
    if(!(Test-Path -LiteralPath $file)){
        Invoke-WebRequest -Uri $package.url -OutFile ($file+'.partial')
        Move-Item -LiteralPath ($file+'.partial') -Destination $file
    }
    if((Get-Item -LiteralPath $file).Length -ne $package.size -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $package.sha256){throw 'Compiler supplement integrity failed'}
    $destination=Join-Path $output $package.id
    if(!(Test-Path -LiteralPath $destination)){
        # ZipFile extraction refuses path traversal. No installer, script or
        # registry mutation runs; these are build inputs in the workspace only.
        [IO.Compression.ZipFile]::ExtractToDirectory($file,$destination)
    }
    # An extracted cache is mutable build input. Hash every retained byte
    # against the already-pinned VSIX, including on reuse; a marker or a
    # previously successful extraction cannot authorize altered headers/libs.
    $expected=@{};$archive=[IO.Compression.ZipFile]::OpenRead($file)
    try{
        foreach($entry in $archive.Entries){
            if(!$entry.Name){continue}
            $path=[IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
            if(!$path.StartsWith($destination+'\',[StringComparison]::OrdinalIgnoreCase) -or $expected.ContainsKey($path)){
                throw 'Compiler supplement archive paths are invalid'
            }
            $expected[$path]=$true
            $item=Get-Item -LiteralPath $path -Force
            if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $entry.Length){
                throw 'Extracted compiler supplement changed'
            }
            $stream=$entry.Open();$algorithm=[Security.Cryptography.SHA256]::Create()
            try{$hash=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
            finally{$stream.Dispose();$algorithm.Dispose()}
            if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash){
                throw 'Extracted compiler supplement integrity failed'
            }
        }
        foreach($item in Get-ChildItem -LiteralPath $destination -Recurse -Force){
            if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (!$item.PSIsContainer -and !$expected.ContainsKey($item.FullName))){
                throw 'Unexpected extracted compiler supplement content'
            }
        }
    }finally{$archive.Dispose()}
    $verified+=[pscustomobject]@{id=$package.id;version=$package.version;archiveSha256=$package.sha256;files=$expected.Count;extractedBytesVerified=$true}
    Write-Output ('Verified '+$package.id+' '+$package.version)
}
$verified | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\compiler-input-verification.json') -Encoding UTF8
