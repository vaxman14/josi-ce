# Windows PowerShell 5.1. SCM and WinSW remain the service manager/host; this
# module only renders the fixed product definitions and their permissions.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A fresh PowerShell 5.1 upgrade does not call Get-Service before quiescence.
# Its ServiceController dependency must be loaded explicitly; relying on a
# previous cmdlet to load it makes the first JosiProxy stop fail TypeNotFound.
Add-Type -AssemblyName System.ServiceProcess
Import-Module (Join-Path $PSScriptRoot 'Payloads.psm1')
$script:ServiceNames = @('JosiDatabase', 'JosiWeb', 'JosiWorker', 'JosiVoice', 'JosiVoiceControl', 'JosiProxy')
$script:ServiceSids = @{}

function Get-NativeServiceSid([string]$Name) {
    if ($Name -cnotin $script:ServiceNames) { throw 'Unknown Josi service' }
    if ($script:ServiceSids.ContainsKey($Name)) { return $script:ServiceSids[$Name] }
    try {
        # After registration, resolve the virtual account via LSA. sc showsid
        # queries installed service configuration, which this policy correctly
        # denies to ordinary authenticated users; do not widen its service DACL.
        $account=[Security.Principal.NTAccount]::new('NT SERVICE',$Name)
        $resolved=$account.Translate([Security.Principal.SecurityIdentifier]).Value
        if($resolved -cmatch '^S-1-5-80-(?:\d+-){4}\d+$'){
            $script:ServiceSids[$Name]=$resolved
            return $resolved
        }
    }catch [Security.Principal.IdentityNotMappedException]{}
    # Before installation LookupAccountName cannot resolve the virtual account.
    # Ask Windows for the service SID; do not duplicate its SID hashing algorithm.
    $result = & (Join-Path $env:SystemRoot 'System32\sc.exe') showsid $Name
    if ($LASTEXITCODE) { throw 'Windows could not determine the service identity' }
    $sid = [regex]::Match(($result -join ' '), 'S-1-5-80-(?:\d+-){4}\d+').Value
    if (!$sid) { throw 'Windows returned an invalid service identity' }
    $script:ServiceSids[$Name]=([Security.Principal.SecurityIdentifier]::new($sid)).Value
    return $script:ServiceSids[$Name]
}

function ConvertTo-NativeArgument([string]$Value) {
    # These are installer-selected local paths/words, never arbitrary command
    # text. Percent is excluded because WinSW expands environment references.
    if ($Value -match '["%\x00-\x1f]' -or $Value.EndsWith('\')) { throw 'Unsafe service argument' }
    return '"' + $Value + '"'
}

function Get-NativeServicePlan([string]$ProgramRoot, [string]$DataRoot) {
    $program = Assert-PlainNativePath $ProgramRoot
    $data = Assert-PlainNativePath $DataRoot
    $configuration = Join-Path $data 'config\runtime.json'
    $node = Join-Path $program 'node\JosiRuntime.exe'
    $python = Join-Path $program 'python\python.exe'
    $runtime = Join-Path $program 'app\native\Runtime.mjs'
    $pythonRuntime = Join-Path $program 'app\native\PythonRuntime.py'
    # Validate before producing definitions. No unquoted executable paths.
    foreach ($path in @($program, $data, $configuration, $node, $python)) { $null = ConvertTo-NativeArgument $path }
    return @(
        [pscustomobject]@{ Name='JosiDatabase'; DisplayName='Josi CE Database'; Kind='PostgreSQL';
            Executable=(Join-Path $program 'postgresql\bin\pg_ctl.exe');
            Arguments=@('runservice','-N','JosiDatabase','-D',(Join-Path $data 'database'),'-w','-t','60','-e','JosiDatabase');
            Depends=@(); Start='Automatic'; Environment=@{} },
        [pscustomobject]@{ Name='JosiWeb'; DisplayName='Josi CE'; Kind='WinSW'; Executable=$node;
            Arguments=@('--max-old-space-size=2048',$runtime,'web',$configuration); Depends=@('JosiDatabase'); Start='Automatic'; Environment=@{} },
        [pscustomobject]@{ Name='JosiWorker'; DisplayName='Josi CE Background Work'; Kind='WinSW'; Executable=$node;
            Arguments=@('--max-old-space-size=2048',$runtime,'worker',$configuration); Depends=@('JosiDatabase'); Start='Automatic'; Environment=@{} },
        [pscustomobject]@{ Name='JosiVoice'; DisplayName='Josi CE Speech'; Kind='WinSW'; Executable=$python;
            Arguments=@('-I','-B',$pythonRuntime,'voice',$configuration); Depends=@(); Start='Manual'; Environment=@{} },
        [pscustomobject]@{ Name='JosiVoiceControl'; DisplayName='Josi CE Speech Control'; Kind='WinSW'; Executable=$python;
            Arguments=@('-I','-B',$pythonRuntime,'voice-control',$configuration); Depends=@(); Start='Automatic'; Environment=@{} },
        [pscustomobject]@{ Name='JosiProxy'; DisplayName='Josi CE Web Access'; Kind='WinSW'; Executable=(Join-Path $program 'caddy\caddy.exe');
            Arguments=@('run','--config',(Join-Path $data 'config\Caddyfile'),'--adapter','caddyfile'); Depends=@('JosiWeb'); Start='Automatic';
            Environment=@{ APPDATA=(Join-Path $data 'proxy'); LOCALAPPDATA=(Join-Path $data 'proxy');
                HOME=(Join-Path $data 'proxy'); USERPROFILE=(Join-Path $data 'proxy');
                TEMP=(Join-Path $data 'temp\proxy'); TMP=(Join-Path $data 'temp\proxy') } }
    )
}

function Get-NativeServiceSecurity([string]$Name) {
    if ($Name -cnotin $script:ServiceNames) { throw 'Unknown Josi service' }
    $descriptor = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;LC;;;AU)'
    if ($Name -ceq 'JosiVoice') {
        # QUERY_STATUS, START, STOP only. No configuration, DACL, arbitrary
        # service selection, pause, or user-defined command authority.
        $descriptor += '(A;;LCRPWP;;;' + (Get-NativeServiceSid 'JosiVoiceControl') + ')'
    }
    return $descriptor
}

function Write-NativeServiceFiles([string]$ProgramRoot, [string]$DataRoot, [string]$Wrapper) {
    Assert-NativeServiceHost $Wrapper
    $plan = Get-NativeServicePlan $ProgramRoot $DataRoot
    foreach ($service in $plan) {
        if ($service.Kind -ne 'WinSW') { continue }
        $folder = Join-Path $ProgramRoot ('services\' + $service.Name)
        $null = Assert-PlainNativePath $folder
        $null = [IO.Directory]::CreateDirectory($folder)
        $executable = Join-Path $folder ($service.Name + '.exe')
        Copy-Item -LiteralPath $Wrapper -Destination $executable
        $document = [Xml.XmlDocument]::new()
        $root = $document.CreateElement('service'); $null = $document.AppendChild($root)
        $values = [ordered]@{ id=$service.Name; name=$service.DisplayName; description=($service.DisplayName + ' for the native Josi CE installation.');
            executable=$service.Executable; arguments=(($service.Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ');
            workingdirectory=$ProgramRoot; startmode=$service.Start; stoptimeout='45 sec'; stopparentprocessfirst='true';
            logpath=(Join-Path $DataRoot ('logs\' + $service.Name)); resetfailure='1 day'; securityDescriptor=(Get-NativeServiceSecurity $service.Name) }
        foreach ($key in $values.Keys) { $element=$document.CreateElement($key); $element.InnerText=$values[$key]; $null=$root.AppendChild($element) }
        $account=$document.CreateElement('serviceaccount')
        foreach ($pair in @(@('domain','NT SERVICE'), @('user',$service.Name))) {
            $element=$document.CreateElement($pair[0]); $element.InnerText=$pair[1]; $null=$account.AppendChild($element)
        }
        $null=$root.AppendChild($account)
        foreach ($dependency in $service.Depends) { $element=$document.CreateElement('depend'); $element.InnerText=$dependency; $null=$root.AppendChild($element) }
        foreach ($entry in $service.Environment.GetEnumerator()) {
            $element=$document.CreateElement('env'); $element.SetAttribute('name',$entry.Key); $element.SetAttribute('value',$entry.Value); $null=$root.AppendChild($element)
        }
        foreach ($seconds in @(10,30,0)) {
            $element=$document.CreateElement('onfailure'); $element.SetAttribute('action',$(if($seconds){'restart'}else{'none'}))
            if($seconds){$element.SetAttribute('delay',"$seconds sec")}; $null=$root.AppendChild($element)
        }
        $log=$document.CreateElement('log'); $log.SetAttribute('mode','roll-by-size')
        foreach ($pair in @(@('sizeThreshold','1024'),@('keepFiles','5'))) {
            $element=$document.CreateElement($pair[0]); $element.InnerText=$pair[1]; $null=$log.AppendChild($element)
        }
        $null=$root.AppendChild($log)
        $settings=[Xml.XmlWriterSettings]::new(); $settings.Indent=$true; $settings.Encoding=[Text.UTF8Encoding]::new($false)
        $writer=[Xml.XmlWriter]::Create((Join-Path $folder ($service.Name + '.xml')),$settings)
        try { $document.WriteTo($writer) } finally { $writer.Dispose() }
    }
    return $plan
}

function Assert-NativeServiceHost([string]$Path){
    $null=Assert-PlainNativePath $Path
    $pin=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'service-host.lock.json')) | ConvertFrom-Json
    if($pin.schemaVersion -ne 1 -or !$pin.scmCompletionRequestsConnectOnly -or $pin.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-Item -LiteralPath $Path).Length -ne $pin.size -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'Service host verification failed'}
}

function Assert-NativeAdministrator {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Windows administrator approval is required to change Josi services'
    }
}

function Register-NativeServices([string]$ProgramRoot, [string]$DataRoot) {
    Assert-NativeAdministrator
    $plan=Get-NativeServicePlan $ProgramRoot $DataRoot
    # Preflight the entire set before creating any service. Never adopt, modify,
    # stop or delete a pre-existing service without lifecycle ownership evidence.
    foreach($service in $plan) {
        if(Get-Service -Name $service.Name -ErrorAction SilentlyContinue){throw 'A Josi service already exists; use the verified upgrade or repair transaction'}
        if(!(Test-Path -LiteralPath $service.Executable -PathType Leaf)){throw 'A verified service component is missing'}
        if($service.Kind -eq 'WinSW' -and !(Test-Path -LiteralPath (Join-Path $ProgramRoot ('services\'+$service.Name+'\'+$service.Name+'.xml')))){throw 'A service definition is missing'}
    }
    $created=[Collections.Generic.List[string]]::new()
    $step='prepare';$serviceName='JosiDatabase'
    try {
        foreach($service in $plan) {
            $serviceName=$service.Name;$step='create'
            $binary=if($service.Kind -eq 'PostgreSQL') {
                (ConvertTo-NativeArgument $service.Executable)+' '+(($service.Arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' ')
            } else {ConvertTo-NativeArgument (Join-Path $ProgramRoot ('services\'+$service.Name+'\'+$service.Name+'.exe'))}
            [Josi.NativeSetup.ServiceRegistration]::Create($service.Name,$service.DisplayName,$binary,[string[]]$service.Depends)
            $created.Add($service.Name)
            # ServiceBase must never try to create a source from its restricted
            # runtime account. Source creation is a fixed installer operation.
            if(![Diagnostics.EventLog]::SourceExists($service.Name)){
                [Diagnostics.EventLog]::CreateEventSource([Diagnostics.EventSourceCreationData]::new($service.Name,'Application'))
            }elseif([Diagnostics.EventLog]::LogNameFromSourceName($service.Name,'.') -ne 'Application'){
                throw 'A conflicting event source requires installation recovery'
            }
            $step='identity'
            $sc=Join-Path $env:SystemRoot 'System32\sc.exe'
            & $sc sidtype $service.Name unrestricted | Out-Null
            if($LASTEXITCODE){throw 'Service identity configuration failed'}
            $step='permissions'
            & $sc sdset $service.Name (Get-NativeServiceSecurity $service.Name) | Out-Null
            if($LASTEXITCODE){throw 'Service permission configuration failed'}
            $step='recovery'
            & $sc failure $service.Name 'reset=' '86400' 'actions=' 'restart/10000/restart/30000/none/0' | Out-Null
            if($LASTEXITCODE){throw 'Service recovery configuration failed'}
            # Remain demand-start until the transaction has provisioned data,
            # migrated and passed health checks. Activation sets automatic mode.
        }
        return $plan
    } catch {
        $failureCode=$_.Exception.HResult
        $nativeCode=0;$cause=$_.Exception
        while($cause){if($cause -is [ComponentModel.Win32Exception]){$nativeCode=$cause.NativeErrorCode};$cause=$cause.InnerException}
        $failureId=$_.FullyQualifiedErrorId -replace '[^A-Za-z0-9.,_-]',''
        $remaining=[Collections.Generic.List[string]]::new()
        for($index=$created.Count-1;$index -ge 0;$index--){
            & (Join-Path $env:SystemRoot 'System32\sc.exe') delete $created[$index] | Out-Null
            if($LASTEXITCODE){$remaining.Add($created[$index])}
        }
        if($remaining.Count){throw ('Service registration needs recovery; these new services could not be removed: '+($remaining -join ', '))}
        throw ('Josi service registration failed for '+$serviceName+' during '+$step+' (0x'+$failureCode.ToString('X8')+', native '+$nativeCode+', '+$failureId+'); only services created by this operation were removed')
    }
}

function Stop-NativeService([string]$Name,[int]$TimeoutSeconds=60){
    if($Name -cnotin $script:ServiceNames -or $TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 180){throw 'Invalid bounded product-service stop'}
    $service=[ServiceProcess.ServiceController]::new($Name)
    try{
        $service.Refresh()
        if($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped){
            # Stop-Service waits internally without this operation's deadline.
            # Issue the SCM request directly, then bound the status wait.
            if($service.Status -ne [ServiceProcess.ServiceControllerStatus]::StopPending){$service.Stop()}
            $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds($TimeoutSeconds))
        }
    }finally{$service.Dispose()}
}

function Set-NativeServiceStartup([string]$ProgramRoot,[string]$DataRoot){
    Assert-NativeAdministrator
    $plan=Get-NativeServicePlan $ProgramRoot $DataRoot
    # Registration deliberately leaves every service demand-start. Only the
    # healthy activation transaction may enable the intended startup policy.
    foreach($entry in $plan){
        $service=Get-CimInstance Win32_Service -Filter ("Name='"+$entry.Name+"'")
        $expected=if($entry.Kind -eq 'PostgreSQL'){
            (ConvertTo-NativeArgument $entry.Executable)+' '+(($entry.Arguments | ForEach-Object {ConvertTo-NativeArgument $_}) -join ' ')
        }else{ConvertTo-NativeArgument (Join-Path $ProgramRoot ('services\'+$entry.Name+'\'+$entry.Name+'.exe'))}
        if(!$service -or $service.StartName -ine ('NT SERVICE\'+$entry.Name) -or $service.PathName -cne $expected){throw 'Startup activation refuses an unrelated service'}
    }
    foreach($entry in $plan){
        $mode=if($entry.Start -ceq 'Automatic'){'auto'}else{'demand'}
        & (Join-Path $env:SystemRoot 'System32\sc.exe') config $entry.Name 'start=' $mode | Out-Null
        if($LASTEXITCODE){throw 'Service startup activation requires recovery'}
    }
}

Export-ModuleMember -Function Get-NativeServicePlan, Get-NativeServiceSid, Get-NativeServiceSecurity, Write-NativeServiceFiles, Register-NativeServices, Assert-NativeServiceHost, Stop-NativeService, ConvertTo-NativeArgument, Set-NativeServiceStartup
