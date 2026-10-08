$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Import-Module (Join-Path $repo 'packaging\windows\Configuration.psm1')
$base=Join-Path $repo 'artifacts\windows-native'
$root=Join-Path $base ('test-installations\configuration-'+[Guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($root)
$config=Get-NativeConfiguration 'C:\Program Files\Josi CE Server\versions\0.1.78-native.1' 'C:\ProgramData\Josi CE Server' '0.1.78-native.1' ('a'*64)
$runtime=$config.Runtime | ConvertFrom-Json
if($runtime.publicUrl -ne 'http://localhost:8080' -or $runtime.databasePort -ne 15432 -or $runtime.apiPort -ne 18080){throw 'Unexpected initial listener configuration'}
foreach($bad in @('%PATH%','x"y',"x`ny")){
    $rejected=$false
    try{$null=Get-NativeConfiguration ('C:\'+$bad) 'C:\ProgramData\Josi CE Server' '0.1.0' ('a'*64)}catch{$rejected=$true}
    if(!$rejected){throw 'Unsafe config syntax was accepted'}
}
$rejected=$false
try{$null=Get-NativeConfiguration 'C:\Josi' 'C:\JosiData' '0.1.0' ('a'*64) 18081}catch{$rejected=$true}
if(!$rejected){throw 'A private voice port collision was accepted'}
$caddy=Join-Path $root 'Caddyfile'
[IO.File]::WriteAllText($caddy,$config.Caddy,[Text.UTF8Encoding]::new($false))
$process=Start-Process -FilePath (Join-Path $base 'tools\caddy-2.11.7\caddy.exe') -ArgumentList @('adapt','--config',('"'+$caddy+'"'),'--adapter','caddyfile') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'caddy.json') -RedirectStandardError (Join-Path $root 'caddy.log')
if(!$process.WaitForExit(30000)){$process.Kill();throw 'Caddy configuration validation timed out'}
if($process.ExitCode){throw 'Actual Caddy rejected the generated configuration'}
$json=Get-Content -LiteralPath (Join-Path $root 'caddy.json') -Raw | ConvertFrom-Json
if($json.admin.disabled -ne $true -or $json.apps.http.servers.srv0.listen[0] -ne '127.0.0.1:8080'){
    throw 'Caddy did not bind exclusively to the requested private endpoint'
}
if(@($config.PSObject.Properties).Count -ne 2){throw 'Native configuration contains an unexpected runtime component'}
[pscustomobject]@{passed=$true;closedConfiguration=$true;portsDistinct=$true;actualCaddyAdaptation=$true;
    loopbackEntry=$true;firstRunDocumentAccessTested=$false;root=$root} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $base 'evidence\initial-configuration.json') -Encoding UTF8
Write-Output 'Initial configuration and actual Caddy adaptation passed.'
