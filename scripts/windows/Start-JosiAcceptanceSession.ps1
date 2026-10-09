# One temporary elevation for the already-authorized Josi acceptance scope.
# Requests select fixed actions, never commands, script paths or live mutations.
param([Parameter(Mandatory=$true)][string]$SessionId,[Parameter(Mandatory=$true)][string]$OriginalUserSid)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$env:PSModulePath=''
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base=Join-Path $repo 'artifacts\windows-native'
function Assert-AdminOnlyAcceptanceParent([string]$Path){
    $parentAcl=Get-Acl -LiteralPath $Path
    if(!$parentAcl.AreAccessRulesProtected -or $parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin @('S-1-5-18','S-1-5-32-544')){throw 'Frozen-source parent is not protected and administrator-owned'}
    foreach($rule in $parentAcl.Access){
        $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($rule.AccessControlType -ne 'Allow' -or $sid -cnotin @('S-1-5-18','S-1-5-32-544')){throw 'Frozen-source parent grants unexpected access'}
    }
}
if($SessionId -cnotmatch '^[a-f0-9]{32}$' -or $OriginalUserSid -cnotmatch '^S-1-5-21-(?:\d+-){3}\d+$'){throw 'Invalid acceptance session identity'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Temporary Windows approval required'}
$helper=Get-Content -LiteralPath (Join-Path $base 'evidence\native-setup-helper.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $helper.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne '834f9e97ac5a048d2a9e6fc0a1fad13f88e181b3724f223f9c781c3e53d2c97b'){throw 'Inspection bridge changed'}
Add-Type -Path $helper.binary
Import-Module (Join-Path $repo 'packaging\windows\Payloads.psm1')
$session=Assert-PlainNativePath (Join-Path $base ('test-installations\admin-session-'+$SessionId))
$requests=Assert-PlainNativePath (Join-Path $base ('staging\admin-requests-'+$SessionId))
[Josi.NativeSetup.PrivateDirectory]::Create($session,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;'+$OriginalUserSid+')'))
[Josi.NativeSetup.PrivateDirectory]::Create($requests,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;'+$OriginalUserSid+')'))
$frozenParent=Assert-PlainNativePath (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Josi CE Acceptance Sessions')
if(!(Test-Path -LiteralPath $frozenParent)){[Josi.NativeSetup.PrivateDirectory]::Create($frozenParent,'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')}
Assert-AdminOnlyAcceptanceParent $frozenParent
$snapshot=Assert-PlainNativePath (Join-Path $frozenParent $SessionId)
[Josi.NativeSetup.PrivateDirectory]::Create($snapshot,('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;'+$OriginalUserSid+')'))
foreach($relative in @('scripts\windows','packaging\windows','artifacts\windows-native\evidence','artifacts\windows-native\test-installations','artifacts\windows-native\cache','artifacts\windows-native\tools\node-v24.21.0-win-x64')){$null=[IO.Directory]::CreateDirectory((Join-Path $snapshot $relative))}
# Freeze reviewed actions/modules. Later workspace edits cannot become elevated
# code in this session. Source refresh requires a new UAC approval.
foreach($name in @('Test-NativeLifecycle.ps1','Test-NativeDiagnostics.ps1','Test-StartupEvidence.ps1')){[IO.File]::Copy((Join-Path $PSScriptRoot $name),(Join-Path $snapshot ('scripts\windows\'+$name)),$false)}
foreach($file in Get-ChildItem -LiteralPath (Join-Path $repo 'packaging\windows') -File){
    if($file.Extension -cin @('.psm1','.json')){[IO.File]::Copy($file.FullName,(Join-Path $snapshot ('packaging\windows\'+$file.Name)),$false)}
}
[IO.File]::Copy($helper.binary,(Join-Path $snapshot 'Josi.NativeSetup.dll'),$false)
$helper.binary=Join-Path $snapshot 'Josi.NativeSetup.dll'
[IO.File]::WriteAllText((Join-Path $snapshot 'artifacts\windows-native\evidence\native-setup-helper.json'),($helper | ConvertTo-Json))
foreach($pair in @(@('cache\WinSW.Josi-2.12.0-windows1.exe','cache\WinSW.Josi-2.12.0-windows1.exe'),@('tools\node-v24.21.0-win-x64\node.exe','tools\node-v24.21.0-win-x64\node.exe'))){
    $source=Assert-PlainNativePath (Join-Path $base $pair[0]);if(![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($source)){throw 'Linked test tool refused'}
    [IO.File]::Copy($source,(Join-Path $snapshot ('artifacts\windows-native\'+$pair[1])),$false)
}
$inventory=@(Get-ChildItem -LiteralPath $snapshot -File -Recurse | ForEach-Object {[ordered]@{path=$_.FullName.Substring($snapshot.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
[IO.File]::WriteAllText((Join-Path $session 'approved-source-inventory.json'),($inventory | ConvertTo-Json -Depth 4))
$deadline=[DateTime]::UtcNow.AddHours(8)
$state=[ordered]@{schemaVersion=1;sessionId=$SessionId;processId=$PID;status='ready';expiresUtc=$deadline.ToString('o');allowedActions=@('lifecycle','diagnostics','startup-events','finish');requestRoot=$requests;resultRoot=$session;sourceRoot=$snapshot;sourceFrozen=$true;liveMutationAllowed=$false;uacPolicyChanged=$false}
[IO.File]::WriteAllText((Join-Path $session 'session.json'),($state | ConvertTo-Json))
$seen=@{}
try{
    while([DateTime]::UtcNow -lt $deadline){
        foreach($file in Get-ChildItem -LiteralPath $requests -File -Filter '*.json'){
            if($seen.ContainsKey($file.Name)){continue}
            $seen[$file.Name]=$true;$response=[ordered]@{passed=$false;action='invalid';recordedAt=[DateTime]::UtcNow.ToString('o')}
            try{
                if($file.Name -cnotmatch '^[a-f0-9]{32}\.json$' -or $file.Length -gt 1024 -or ![Josi.NativeSetup.FileAttributes]::IsSingleRegularFile($file.FullName)){throw 'Unsafe request file'}
                $request=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
                if(@($request.PSObject.Properties).Count -ne 4 -or $request.schemaVersion -ne 1 -or $request.sessionId -cne $SessionId -or $request.id+'.json' -cne $file.Name -or $request.action -cnotin $state.allowedActions){throw 'Request outside approved scope'}
                $response.action=$request.action
                switch($request.action){
                    'lifecycle' {
                        Import-Module (Join-Path $snapshot 'packaging\windows\Lifecycle.psm1')
                        $oldId='4c44ad663b3545eca093876a2acd3d30';$oldName='JosiAcceptance_'+$oldId
                        $oldReport=Join-Path $base ('test-installations\lifecycle-'+$oldId+'\result.json')
                        if(Get-Service -Name $oldName -ErrorAction SilentlyContinue){
                            $prior=Get-Content -LiteralPath $oldReport -Raw | ConvertFrom-Json
                            $context=Get-NativeLifecycleContext $prior.disposableProduct $prior.disposableData '0.1.78-native.5' $oldId -Disposable
                            $svc=Get-CimInstance Win32_Service -Filter ("Name='"+$oldName+"'")
                            $unquoted=Join-Path $context.Program 'test-service.exe'
                            if($svc.StartName -ine ('NT SERVICE\'+$oldName) -or $svc.PathName -cnotin @($unquoted,$context.Plan.Binary)){throw 'Unrelated fixture must be preserved'}
                            if($svc.PathName -ceq $unquoted){$changed=Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments @{PathName=$context.Plan.Binary};if($changed.ReturnValue -ne 0){throw 'Disposable path correction failed'}}
                            $oldInventory=Join-Path $prior.root 'runtime-inventory.json'
                            $cleanup=Invoke-NativeUninstall $context $oldInventory (Get-FileHash -LiteralPath $oldInventory -Algorithm SHA256).Hash.ToLowerInvariant()
                            [IO.File]::WriteAllText((Join-Path $session 'prior-disposable-cleanup.json'),($cleanup | ConvertTo-Json))
                        }
                        & (Join-Path $snapshot 'scripts\windows\Test-NativeLifecycle.ps1') -OriginalUserSid $OriginalUserSid
                        $response.result=Get-Content -LiteralPath (Join-Path $snapshot 'artifacts\windows-native\evidence\native-lifecycle.json') -Raw | ConvertFrom-Json
                        $response.passed=$response.result.passed
                    }
                    'diagnostics' {
                        & (Join-Path $snapshot 'scripts\windows\Test-NativeDiagnostics.ps1')
                        $response.result=Get-Content -LiteralPath (Join-Path $snapshot 'artifacts\windows-native\evidence\native-diagnostics.json') -Raw | ConvertFrom-Json
                        $response.passed=$response.result.passed
                    }
                    'startup-events' {& (Join-Path $snapshot 'scripts\windows\Test-StartupEvidence.ps1');$response.passed=$true}
                    'finish' {$response.passed=$true;$deadline=[DateTime]::UtcNow}
                }
            }catch{$response.errorType=$_.Exception.GetType().FullName;$response.errorLine=$_.InvocationInfo.ScriptLineNumber;$response.errorMessage=$_.Exception.Message}
            [IO.File]::WriteAllText((Join-Path $session $file.Name),($response | ConvertTo-Json -Depth 10))
        }
        if([DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 500}
    }
}finally{$state.status='closed';[IO.File]::WriteAllText((Join-Path $session 'session.json'),($state | ConvertTo-Json))}
