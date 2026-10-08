# Explicit Windows filesystem authority. The installer creates protected folders
# before writing secrets; it never uses POSIX modes as a substitute for ACLs.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Services.psm1')
Import-Module (Join-Path $PSScriptRoot 'Payloads.psm1')

function Get-NativeDataPolicy {
    $web=@('JosiWeb','JosiWorker')
    $all=@('JosiDatabase','JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl','JosiProxy')
    $directories=[ordered]@{}
    function Add([string]$Path,[string[]]$Read=@(),[string[]]$Modify=@(),[bool]$Inherit=$true){
        $directories[$Path]=[pscustomobject]@{Path=$Path;Read=$Read;Modify=$Modify;Inherit=$Inherit}
    }
    Add '' $all @() $false
    Add 'config' $all @() $false
    Add 'secrets' @('JosiWeb','JosiWorker','JosiVoiceControl') @() $false
    Add 'database' @() @('JosiDatabase')
    Add 'chat-attachments' @() $web
    Add 'roots' @() $web
    Add 'versions' @() $web
    Add 'backups' @() $web
    Add 'diagnostics' @() @('JosiWeb')
    Add 'codex' @() $web
    Add 'state' @('JosiWeb') @('JosiWorker')
    Add 'proxy' @() @('JosiProxy')
    Add 'voice' @('JosiVoice','JosiVoiceControl') @() $false
    Add 'voice\gateway' @('JosiVoice') @('JosiVoiceControl')
    Add 'voice\control' @() @('JosiVoiceControl')
    Add 'logs' $all @() $false
    foreach($service in $all){Add ('logs\'+$service) @() @($service)}
    Add 'profiles' $all @() $false
    Add 'temp' $all @() $false
    foreach($pair in @(@('database','JosiDatabase'),@('web','JosiWeb'),@('worker','JosiWorker'),@('voice','JosiVoice'),@('voice-control','JosiVoiceControl'),@('proxy','JosiProxy'),@('scanner','JosiWorker'))){
        Add ('profiles\'+$pair[0]) @() @($pair[1])
        Add ('temp\'+$pair[0]) @() @($pair[1])
    }
    foreach($path in @('temp\migrate','profiles\migrate','cache','staging','transactions','snapshots')){Add $path}
    $files=[ordered]@{
        'config\runtime.json'=@('JosiWeb','JosiWorker','JosiVoice','JosiVoiceControl');
        'config\Caddyfile'=@('JosiProxy');
        'secrets\master-key'=$web; 'secrets\database-password'=$web;
        'secrets\init-password'=@('JosiDatabase');
        'secrets\voice-control-token'=@('JosiWeb','JosiVoiceControl')
    }
    return [pscustomobject]@{Directories=$directories;Files=$files}
}

function Get-NativeDirectoryDescriptor($Policy) {
    $sddl='O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
    $flags=if($Policy.Inherit){'OICI'}else{''}
    foreach($service in $Policy.Read){$sddl+='(A;'+$flags+';0x1200a9;;;'+(Get-NativeServiceSid $service)+')'}
    foreach($service in $Policy.Modify){$sddl+='(A;'+$flags+';0x1301bf;;;'+(Get-NativeServiceSid $service)+')'}
    return $sddl
}

function New-NativeDataLayout([string]$DataRoot,[string]$InstallationId) {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
        throw 'Windows administrator approval is required to create the installation data folders'
    }
    $expected=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server'
    $data=Assert-PlainNativePath $DataRoot
    if(![StringComparer]::OrdinalIgnoreCase.Equals($data,$expected)){throw 'The installation must use the standard Windows data folder'}
    if(Test-Path -LiteralPath $data){throw 'Existing Josi data must be handled by the verified lifecycle transaction'}
    if($InstallationId -cnotmatch '^[a-f0-9]{32}$'){throw 'A durable installation identity is required'}
    $policy=Get-NativeDataPolicy
    foreach($entry in $policy.Directories.Values){
        $path=if($entry.Path){Join-Path $data $entry.Path}else{$data}
        [Josi.NativeSetup.PrivateDirectory]::Create($path,(Get-NativeDirectoryDescriptor $entry))
        if(!$entry.Path){
            # Ownership exists before any subsequent folder/secret/service
            # mutation, including interruption during layout creation.
            $marker=[ordered]@{schemaVersion=1;product='Josi CE Server';installationId=$InstallationId}
            $bytes=[Text.Encoding]::UTF8.GetBytes(($marker | ConvertTo-Json -Compress))
            $stream=[IO.FileStream]::new((Join-Path $data 'installation.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
            try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        }
    }
}

function Write-NativeProtectedFile([string]$DataRoot,[string]$RelativePath,[byte[]]$Bytes) {
    $policy=Get-NativeDataPolicy
    if(!$policy.Files.Contains($RelativePath)){throw 'This is not an installer-managed protected file'}
    if($Bytes.Length -eq 0 -or $Bytes.Length -gt 65536){throw 'Protected file size is invalid'}
    $data=Assert-PlainNativePath $DataRoot
    $expected=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server'
    if(![StringComparer]::OrdinalIgnoreCase.Equals($data,$expected)){throw 'The installation must use the standard Windows data folder'}
    $path=Assert-PlainNativePath (Join-Path $data $RelativePath)
    $sddl='O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'
    foreach($service in $policy.Files[$RelativePath]){$sddl+='(A;;FR;;;'+(Get-NativeServiceSid $service)+')'}
    # config/secrets parents allow only administrators to create files. CreateNew
    # refuses replacement; initially inherited administrator-only access is safe.
    $stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    $security=[Security.AccessControl.FileSecurity]::new()
    $security.SetSecurityDescriptorSddlForm($sddl)
    [IO.File]::SetAccessControl($path,$security)
}

function Restore-NativeArtifactPermissions([string]$DataRoot){
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
        throw 'Windows administrator approval is required to restore artifact permissions'
    }
    $data=Assert-PlainNativePath $DataRoot
    $expected=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Server'
    if(![StringComparer]::OrdinalIgnoreCase.Equals($data,$expected)){throw 'Artifact permissions require the standard installed data folder'}
    $policy=Get-NativeDataPolicy
    $items=[Collections.Generic.List[object]]::new()
    function Visit([string]$Path){
        $null=Assert-PlainNativePath $Path
        $item=Get-Item -LiteralPath $Path -Force
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Restored artifacts must not contain reparse points'}
        if(!$item.PSIsContainer -and ![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($item.FullName)){
            throw 'Restored artifact permissions refuse linked or nonregular files'
        }
        if($items.Count -ge 100000){throw 'The restored artifact inventory exceeds its bound'}
        $items.Add($item)
        if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $Path -Force){Visit $child.FullName}}
    }
    # Preflight the complete tree before changing any security descriptor. The
    # caller holds the lifecycle lock and has stopped all application writers.
    foreach($root in @('chat-attachments','roots','versions')){Visit (Join-Path $data $root)}
    $descriptor=Get-NativeDirectoryDescriptor $policy.Directories['roots']
    foreach($item in $items){
        if($item.PSIsContainer){
            $security=[Security.AccessControl.DirectorySecurity]::new()
            $security.SetSecurityDescriptorSddlForm($descriptor)
            [IO.Directory]::SetAccessControl($item.FullName,$security)
        }else{
            $security=[Security.AccessControl.FileSecurity]::new()
            $security.SetSecurityDescriptorSddlForm($descriptor.Replace(';OICI;',';;'))
            [IO.File]::SetAccessControl($item.FullName,$security)
        }
    }
    return [pscustomobject]@{permissionsRestored=$true;entries=$items.Count}
}

Export-ModuleMember -Function Get-NativeDataPolicy, Get-NativeDirectoryDescriptor, New-NativeDataLayout, Write-NativeProtectedFile, Restore-NativeArtifactPermissions
