# Provision with the SAME restricted service identity that owns the cluster.
# WinSW hosts initdb only for this bounded one-shot; pg_ctl then owns normal SCM.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Services.psm1')
Import-Module (Join-Path $PSScriptRoot 'Payloads.psm1')

function Invoke-NativeDatabaseInitialization([string]$ProgramRoot,[string]$DataRoot,[string]$Wrapper) {
    $program=Assert-PlainNativePath $ProgramRoot
    $data=Assert-PlainNativePath $DataRoot
    $definition=@(Get-NativeServicePlan $program $data | Where-Object Name -eq 'JosiDatabase')[0]
    $normal='"'+$definition.Executable+'" '+(($definition.Arguments | ForEach-Object {'"'+$_+'"'}) -join ' ')
    $service=Get-CimInstance Win32_Service -Filter "Name='JosiDatabase'"
    if(!$service -or $service.PathName -cne $normal -or $service.StartName -ine 'NT SERVICE\JosiDatabase' -or $service.State -ne 'Stopped'){
        throw 'Database initialization requires the newly registered, stopped private service'
    }
    $cluster=Join-Path $data 'database'
    if(@(Get-ChildItem -LiteralPath $cluster -Force).Count){throw 'Database initialization refuses existing data'}
    Assert-NativeServiceHost $Wrapper
    $folder=Join-Path $program 'services\database-init'
    $null=[IO.Directory]::CreateDirectory($folder)
    $hostFile=Join-Path $folder 'JosiDatabase.exe'
    Copy-Item -LiteralPath $Wrapper -Destination $hostFile
    $xml=[Xml.XmlDocument]::new();$root=$xml.CreateElement('service');$null=$xml.AppendChild($root)
    $arguments=@('-D',$cluster,'-U','bootstrap_admin',('--pwfile='+(Join-Path $data 'secrets\init-password')),
        '--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C')
    $values=[ordered]@{id='JosiDatabase';name='Josi CE Database Initialization';
        executable=(Join-Path $program 'postgresql\bin\initdb.exe');arguments=(($arguments | ForEach-Object {'"'+$_+'"'}) -join ' ');
        workingdirectory=$program;stoptimeout='30 sec';logpath=(Join-Path $data 'logs\JosiDatabase')}
    foreach($key in $values.Keys){$element=$xml.CreateElement($key);$element.InnerText=$values[$key];$null=$root.AppendChild($element)}
    $environment=@{PATH=((Join-Path $program 'postgresql\bin')+';'+(Join-Path $env:SystemRoot 'System32'));
        TEMP=(Join-Path $data 'temp\database');TMP=(Join-Path $data 'temp\database');
        COMSPEC=(Join-Path $env:SystemRoot 'System32\cmd.exe'); PGOPTIONS='';PGSERVICE='';PGSERVICEFILE=''}
    foreach($entry in $environment.GetEnumerator()){$element=$xml.CreateElement('env');$element.SetAttribute('name',$entry.Key);$element.SetAttribute('value',$entry.Value);$null=$root.AppendChild($element)}
    $log=$xml.CreateElement('log');$log.SetAttribute('mode','reset');$null=$root.AppendChild($log)
    $xml.Save((Join-Path $folder 'JosiDatabase.xml'))
    $sc=Join-Path $env:SystemRoot 'System32\sc.exe'
    & $sc failure JosiDatabase 'reset=' '86400' 'actions=' 'none/0' | Out-Null
    if($LASTEXITCODE){throw 'Database initializer recovery configuration failed'}
    try {
        [Josi.NativeSetup.ServiceRegistration]::SetDatabaseBinary(('"'+$hostFile+'"'))
        Start-Service JosiDatabase
        $deadline=[DateTime]::UtcNow.AddMinutes(3)
        do {
            $current=Get-Service JosiDatabase
            if($current.Status -eq 'Stopped'){break}
            if([DateTime]::UtcNow -gt $deadline){Stop-NativeService 'JosiDatabase' 30;throw 'Database initialization timed out'}
            Start-Sleep -Milliseconds 250
        } while($true)
        if(!(Test-Path -LiteralPath (Join-Path $cluster 'PG_VERSION')) -or
            [IO.File]::ReadAllText((Join-Path $cluster 'PG_VERSION')).Trim() -ne '16' -or
            !(Test-Path -LiteralPath (Join-Path $cluster 'global\pg_control'))){throw 'Database initialization did not complete'}
        $settings=[IO.File]::ReadAllText((Join-Path $data 'config\runtime.json')) | ConvertFrom-Json
        if($settings.databasePort -isnot [int] -or $settings.databasePort -lt 1024 -or $settings.databasePort -gt 65535){throw 'Private database port is invalid'}
        $configuration=@("listen_addresses='127.0.0.1'",('port='+$settings.databasePort),"password_encryption='scram-sha-256'",
            "log_statement='none'","log_min_error_statement='panic'",'log_parameter_max_length=0','log_parameter_max_length_on_error=0',
            'logging_collector=off',"event_source='JosiDatabase'") -join "`n"
        [IO.File]::WriteAllText((Join-Path $cluster 'postgresql.auto.conf'),($configuration+"`n"),[Text.UTF8Encoding]::new($false))
    } finally {
        [Josi.NativeSetup.ServiceRegistration]::SetDatabaseBinary($normal)
        & $sc failure JosiDatabase 'reset=' '86400' 'actions=' 'restart/10000/restart/30000/none/0' | Out-Null
        if($LASTEXITCODE){throw 'The private database recovery policy requires repair'}
    }
}

Export-ModuleMember -Function Invoke-NativeDatabaseInitialization
