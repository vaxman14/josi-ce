[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
$target=[IO.Path]::GetFullPath($Destination)
if(!$target.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $target -PathType Container)){
    throw 'The runtime destination must be an existing native build directory'
}
$redist=Join-Path $base 'tools\msvc-supplement\Microsoft.VC.14.50.18.0.CRT.Redist.X64.base\Contents\VC\Redist\MSVC\14.50.35710\x64'
# Only the release redistributable files used by the private runtimes. Never
# copy compiler tools, headers, import libraries or debug_nonredist binaries.
$files=@(
    @('Microsoft.VC145.CRT\vcruntime140.dll','184146852727a9db4eea06178716bec3cdbb1015c911f6b0f915b184ad7775b2'),
    @('Microsoft.VC145.CRT\vcruntime140_1.dll','e6bfb3662ab4b1969a73441dbe35c96d51441b6bff8cf1fe7430bd5b246ca605'),
    @('Microsoft.VC145.CRT\msvcp140.dll','def46aa6a8f72f27bafac0c43334419486a4d1dcdb6c479a8ef7034b3e1fa4cb'),
    @('Microsoft.VC145.OpenMP\vcomp140.dll','31af29c03643f8396a6f26bcd601c6369d26493d7d78b714827ab2801bd284c7')
)
foreach($pin in $files){
    $source=Join-Path $redist $pin[0]
    if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin[1]){throw 'Microsoft runtime hash mismatch'}
    $signature=Get-AuthenticodeSignature -LiteralPath $source
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'Microsoft runtime publisher signature invalid'}
    Copy-Item -LiteralPath $source -Destination (Join-Path $target (Split-Path $source -Leaf)) -Force
}
