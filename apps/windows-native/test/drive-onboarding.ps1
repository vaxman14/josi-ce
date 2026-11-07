# Walks first-run onboarding on a server with nobody on it yet: the account step,
# then where Josi lives, checking what the server is actually sent.
#   powershell -ExecutionPolicy Bypass -File test\drive-onboarding.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8804, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class OnboardDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); }
'@
New-Item -ItemType Directory -Force $Shots | Out-Null
$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]; $C = [System.Windows.Automation.ControlType]
$Value = [System.Windows.Automation.ValuePattern]::Pattern; $Invoke = [System.Windows.Automation.InvokePattern]::Pattern
function ById($id, [int]$timeout = 10) {
  $deadline = (Get-Date).AddSeconds($timeout)
  do {
    $found = $main.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id)))
    if ($found) { return $found }; Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Not found: $id"
}
function Named([string]$name, $type, [int]$timeout = 10) {
  $deadline = (Get-Date).AddSeconds($timeout)
  do {
    $condition = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)),
      (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type)))
    $found = $main.FindFirst($T::Descendants, $condition); if ($found) { return $found }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Not found: $name"
}
function Fill([string]$id, [string]$text) { (ById $id).GetCurrentPattern($Value).SetValue($text) }
function Press([string]$id) { (ById $id).GetCurrentPattern($Invoke).Invoke() }
function Capture([string]$name) {
  $h = $app.MainWindowHandle
  $r = New-Object OnboardDrive+R; [OnboardDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [OnboardDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose()
}
function Pick([string]$label) {
  (Named $label $C::Button 3).GetCurrentPattern($Invoke).Invoke(); Start-Sleep -Milliseconds 700
}

if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$data = Join-Path ([IO.Path]::GetTempPath()) ('josi-onboard-drive-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force (Join-Path $data 'config'), (Join-Path $data 'first-run') | Out-Null
Set-Content (Join-Path $data 'config\runtime.json') ('{"schemaVersion":1,"version":"test","publicUrl":"http://localhost:' + $Port + '"}')
Set-Content (Join-Path $data 'first-run\bootstrap.json') ('{"schemaVersion":1,"port":' + $Port + ',"token":"' + ('a' * 64) + '"}')
$server = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port fresh" -PassThru -WindowStyle Hidden
$app = $null
$env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_SERVER_DATA = $data; $env:JOSI_TEST_INSTANCE = [Guid]::NewGuid().ToString('N')
try {
  Start-Sleep -Seconds 1
  $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $main = $A::FromHandle($app.MainWindowHandle)
  (Named 'Open Josi' $C::Button).GetCurrentPattern($Invoke).Invoke()
  Start-Sleep -Seconds 2
  $page = ById 'josi.setup' 15
  Start-Sleep -Seconds 1
  $text = $main.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'josi.setup.continue')))
  if ($text) { $text.GetCurrentPattern($Invoke).Invoke(); Start-Sleep -Seconds 2 }

  Capture 'o1-account-empty'
  $create = ById 'josi.setup.create-account'
  Write-Host ('empty form: Create is off: ' + !$create.Current.IsEnabled)
  Fill 'josi.setup.displayName' 'Roman Vaxman'
  Fill 'josi.setup.username' 'roman'
  Fill 'josi.setup.email' 'not-an-email'
  (Named 'Password' $C::Edit).GetCurrentPattern($Value).SetValue('a-long-enough-password')
  (Named 'Confirm password' $C::Edit).GetCurrentPattern($Value).SetValue('a-long-enough-password')
  Start-Sleep -Milliseconds 500
  Write-Host ('bad email: Create is off: ' + !(ById 'josi.setup.create-account').Current.IsEnabled)
  Fill 'josi.setup.email' 'roman@example.com'
  Start-Sleep -Milliseconds 500
  Write-Host ('all good: Create is on: ' + (ById 'josi.setup.create-account').Current.IsEnabled)
  Capture 'o2-account-filled'
  Press 'josi.setup.create-account'
  Start-Sleep -Seconds 2

  ById 'josi.setup.continue' | Out-Null
  Capture 'o3-where-pc'
  Pick 'Home or office network'
  Capture 'o4-where-network'
  Write-Host ('network address suggested: ' + (ById 'josi.setup.lanAddress').GetCurrentPattern($Value).Current.Value)
  Pick 'My own domain'
  Capture 'o5-where-domain'
  Write-Host ('certificate email filled in: ' + (ById 'josi.setup.acmeEmail').GetCurrentPattern($Value).Current.Value)
  Fill 'josi.setup.publicDomain' '1.2.3.4'
  Press 'josi.setup.continue'; Start-Sleep -Seconds 1
  Write-Host ('a bare IP is refused as a domain: still here: ' + [bool](ById 'josi.setup.publicDomain' 2))
  Fill 'josi.setup.publicDomain' 'HTTPS://Josi.Example.com/app'
  Press 'josi.setup.continue'; Start-Sleep -Seconds 2
  Capture 'o6-next-step'
  $log = Invoke-RestMethod "http://127.0.0.1:$Port/api/mock/setup-log"
  Write-Host ('server got owner: ' + ($log.owner | ConvertTo-Json -Compress))
  Write-Host ('server got domain: ' + ($log.domain | ConvertTo-Json -Compress))
  $app.Refresh(); Write-Host ('still running: ' + !$app.HasExited)
  Write-Host 'Onboarding drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($server -and !$server.HasExited) { $server.Kill() }
  Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
}
