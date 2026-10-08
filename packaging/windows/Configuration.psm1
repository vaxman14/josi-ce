# Fixed configuration for the initial browser-first local installation.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'DataLayout.psm1')
Import-Module (Join-Path $PSScriptRoot 'Payloads.psm1')

function Get-NativeConfiguration([string]$ProgramRoot,[string]$DataRoot,[string]$Version,[string]$SetupTokenHash,
    [int]$DatabasePort=15432,[int]$ApiPort=18080,[int]$PublicPort=8080){
    $program=Assert-PlainNativePath $ProgramRoot
    $data=Assert-PlainNativePath $DataRoot
    if($Version -cnotmatch '^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$' -or $SetupTokenHash -cnotmatch '^[a-f0-9]{64}$'){
        throw 'Invalid installed configuration identity'
    }
    # Config formats below use quoted local paths. Reject syntax/control bytes;
    # no browser-provided URLs or command text enter proxy configuration.
    if($program -match '["\r\n%]' -or $data -match '["\r\n%]'){throw 'Unsafe configuration path'}
    $ports=@($DatabasePort,$ApiPort,$PublicPort,18081,18082)
    if(@($ports | Select-Object -Unique).Count -ne $ports.Count -or @($ports | Where-Object {$_ -lt 1024 -or $_ -gt 65535}).Count){
        throw 'Private and public listener ports must be distinct and unprivileged'
    }
    $runtime=[ordered]@{schemaVersion=1;version=$Version;databasePort=$DatabasePort;apiPort=$ApiPort;
        publicUrl="http://localhost:$PublicPort";setupTokenSha256=$SetupTokenHash}
    # Localhost is a browser secure context for microphone use. A later, explicit
    # LAN configuration needs its own HTTPS/certificate/firewall transaction.
    $caddy=@('{',"`tadmin off","`tauto_https off",'}','',"http://localhost:$PublicPort {",
        "`tbind 127.0.0.1","`treverse_proxy 127.0.0.1:$ApiPort",'}') -join "`n"
    return [pscustomobject]@{Runtime=($runtime | ConvertTo-Json -Compress);Caddy=($caddy+"`n")}
}

function New-NativeInitialConfiguration([string]$ProgramRoot,[string]$DataRoot,[string]$Version,[string]$OriginalUserSid){
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
        throw 'Windows administrator approval is required for initial configuration'
    }
    # The bootstrapper supplies the original interactive token's SID. Service
    # and built-in broad group identities cannot receive the setup document.
    if($OriginalUserSid -cnotmatch '^S-1-5-21-(?:\d+-){3}\d+$'){throw 'An original interactive Windows user is required'}
    $random=[Security.Cryptography.RandomNumberGenerator]::Create()
    function New-Token { $bytes=New-Object byte[] 32; $random.GetBytes($bytes); return [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant() }
    try{
        $setupToken=New-Token
        $algorithm=[Security.Cryptography.SHA256]::Create()
        try{$setupHash=[BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::ASCII.GetBytes($setupToken))).Replace('-','').ToLowerInvariant()}
        finally{$algorithm.Dispose()}
        $configuration=Get-NativeConfiguration $ProgramRoot $DataRoot $Version $setupHash
        foreach($path in @('secrets\master-key','secrets\database-password','secrets\init-password','secrets\voice-control-token')){
            Write-NativeProtectedFile $DataRoot $path ([Text.Encoding]::ASCII.GetBytes((New-Token)))
        }
        foreach($pair in @(@('config\runtime.json',$configuration.Runtime),@('config\Caddyfile',$configuration.Caddy))){
            Write-NativeProtectedFile $DataRoot $pair[0] ([Text.Encoding]::UTF8.GetBytes($pair[1]))
        }
        $voice=[ordered]@{model='base.en';voice='af_heart';threshold=0.5;silenceMs=700;speed=1.0;device='cpu'}
        foreach($pair in @(@('token',(New-Token)),@('settings.json',($voice | ConvertTo-Json -Compress)))){
            # The pre-created parent grants VoiceControl modification and Voice
            # reading; the web service has no access to this separate token.
            $voicePath=Assert-PlainNativePath (Join-Path $DataRoot ('voice\gateway\'+$pair[0]))
            $stream=[IO.FileStream]::new($voicePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
            try{$bytes=[Text.Encoding]::UTF8.GetBytes($pair[1]);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        }
        # Never put the setup bearer token in a browser command line. The
        # original user opens this ACL-protected file, which navigates in-page.
        $folder=Join-Path $DataRoot 'first-run'
        [Josi.NativeSetup.PrivateDirectory]::Create($folder,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;'+$OriginalUserSid+')'))
        $path=Join-Path $folder 'Open Josi.html'
        $address="http://localhost:8080/setup#setup=$setupToken"
        $document='<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open Josi</title><p>Opening Josi...</p><script>location.replace('+($address | ConvertTo-Json -Compress)+')</script>'
        $stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        try{$bytes=[Text.Encoding]::UTF8.GetBytes($document);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        return [pscustomobject]@{BrowserDocument=$path;Version=$Version}
    }finally{$setupToken=$null;$random.Dispose()}
}

Export-ModuleMember -Function Get-NativeConfiguration, New-NativeInitialConfiguration
