# Pure ACL validation for the hardened source parent; no elevation/session launch.
param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$source=Join-Path $PSScriptRoot 'Start-JosiAcceptanceSession.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Temporary acceptance session syntax failed'}
$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-AdminOnlyAcceptanceParent'},$true)
. ([scriptblock]::Create($function.Extent.Text))
function Get-Acl {param([string]$LiteralPath)return $script:fixture}
function Fixture([string]$Owner,[bool]$Protected,[string[]]$Allowed){
    $script:fixture=[Security.AccessControl.DirectorySecurity]::new()
    $script:fixture.SetOwner([Security.Principal.SecurityIdentifier]::new($Owner))
    $script:fixture.SetAccessRuleProtection($Protected,$false)
    foreach($sid in $Allowed){$script:fixture.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))}
}
function Check([bool]$Expected){$passed=$false;try{Assert-AdminOnlyAcceptanceParent 'fixture';$passed=$true}catch{};if($passed -ne $Expected){throw 'Frozen-source ACL trust boundary failed'}}
Fixture 'S-1-5-32-544' $true @('S-1-5-18','S-1-5-32-544');Check $true
Fixture 'S-1-5-18' $true @('S-1-5-18','S-1-5-32-544');Check $true
Fixture 'S-1-5-32-545' $true @('S-1-5-18','S-1-5-32-544');Check $false
Fixture 'S-1-5-32-544' $false @('S-1-5-18','S-1-5-32-544');Check $false
Fixture 'S-1-5-32-544' $true @('S-1-5-18','S-1-5-32-544','S-1-5-32-545');Check $false
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$report=[ordered]@{passed=$true;cases=5;adminAndSystemOwnersAccepted=$true;nonAdminOwnerRefused=$true;inheritedAccessRefused=$true;broadGroupAccessRefused=$true;
    scope='in-memory ACL predicate and syntax only; hardened ProgramData snapshot launch needs its next actual approved session';sessionLaunched=$false;uacPolicyChanged=$false}
$report|ConvertTo-Json|Set-Content (Join-Path $repo 'artifacts\windows-native\evidence\acceptance-session-source-boundary.json') -Encoding UTF8
$report|ConvertTo-Json
