# Signs Windows release files (Josi.exe, JosiLauncher.exe, the installer EXE)
# with Azure Trusted Signing through signtool. Nothing is signed until the
# account owner has signed in to Azure on this PC (az login) or provides
# DefaultAzureCredential environment variables; the script never stores a
# credential.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\Sign-WindowsArtifacts.ps1 `
#     -Endpoint https://eus.codesigning.azure.net -Account <signing account> -Profile <certificate profile> -Files <exe>...
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Endpoint,
  [Parameter(Mandatory)][string]$Account,
  [Parameter(Mandatory)][string]$Profile,
  [Parameter(Mandatory)][string[]]$Files,
  [string]$Dlib = '',
  [string]$SignTool = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Endpoint -notmatch '^https://[a-z0-9-]+\.codesigning\.azure\.net/?$') { throw 'Use the Trusted Signing endpoint for your account region, for example https://eus.codesigning.azure.net' }

# signtool from the Windows SDK, and the Trusted Signing client (dlib) from
# the Microsoft.Trusted.Signing.Client package.
if (!$SignTool) {
  $SignTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (!$SignTool -or !(Test-Path -LiteralPath $SignTool)) { throw 'signtool.exe was not found. Install the Windows SDK signing tools.' }
if (!$Dlib) {
  $Dlib = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\MicrosoftTrustedSigningClientTools\*\Azure.CodeSigning.Dlib.dll", "$env:USERPROFILE\.nuget\packages\microsoft.trusted.signing.client\*\bin\x64\Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (!$Dlib -or !(Test-Path -LiteralPath $Dlib)) { throw 'Azure.CodeSigning.Dlib.dll was not found. Install the Trusted Signing client tools (winget install Microsoft.Azure.TrustedSigningClientTools).' }

$metadata = Join-Path ([IO.Path]::GetTempPath()) ('josi-signing-' + [Guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($metadata, (@{ Endpoint = $Endpoint.TrimEnd('/'); CodeSigningAccountName = $Account; CertificateProfileName = $Profile } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
try {
  foreach ($file in $Files) {
    $path = (Resolve-Path -LiteralPath $file).Path
    & $SignTool sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib $Dlib /dmdf $metadata $path
    if ($LASTEXITCODE) { throw "Signing failed: $path" }
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid') { throw "The signature on $path did not verify: $($signature.StatusMessage)" }
    "Signed and verified: $path ($($signature.SignerCertificate.Subject))"
  }
} finally { Remove-Item -LiteralPath $metadata -ErrorAction SilentlyContinue }
