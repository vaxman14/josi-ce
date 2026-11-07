# Drives the popup that approves a settings change Josi proposed: a sensitive one
# needs the password and stays open on a wrong one; a plain one needs none.
#   powershell -ExecutionPolicy Bypass -File test\drive-settings.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8802, [string]$Exe = '', [switch]$Client)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SettingsDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); }
'@
New-Item -ItemType Directory -Force $Shots | Out-Null
$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]; $C = [System.Windows.Automation.ControlType]
$Value = [System.Windows.Automation.ValuePattern]::Pattern; $Invoke = [System.Windows.Automation.InvokePattern]::Pattern
function ById($root, [string]$id) { $root.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id))) }
function Find($root, [string]$name, $type, [int]$timeout = 15) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) {
    $condition = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)),
      (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type)))
    $found = $root.FindFirst($T::Descendants, $condition); if ($found) { return $found }
    Start-Sleep -Milliseconds 250
  }
  throw "Element not found: $name"
}
function Click($root, [string]$name) { (Find $root $name $C::Button).GetCurrentPattern($Invoke).Invoke() }
function Capture([IntPtr]$h, [string]$name) {
  $r = New-Object SettingsDrive+R; [SettingsDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [SettingsDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose()
}
# A popup sits under the window that owns it, so it is found by its own id.
function Popup([int]$timeout = 45) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) {
    $sheet = ById $main 'josi.sheet.settings-change'
    if ($sheet -and (ById $sheet 'josi.settings-change.approve')) { return $sheet }
    Start-Sleep -Milliseconds 500
  }
  throw 'The approval popup did not appear'
}
function Ask([string]$text) {
  (Find $main 'Message Josi' $C::Edit).GetCurrentPattern($Value).SetValue($text)
  Click $main 'Send message'
}
function Approve($popup) { (ById $popup 'josi.settings-change.approve').GetCurrentPattern($Invoke).Invoke(); Start-Sleep -Seconds 1 }
function Open($popup) { [bool](ById $main 'josi.sheet.settings-change') }
function ErrorText($popup) { $e = ById $popup 'josi.settings-change.error'; if ($e) { $e.Current.Name } else { '' } }

if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$server = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
$data = & (Join-Path $PSScriptRoot 'mock-local.ps1') -Port $Port; $env:JOSI_SERVER_DATA = $data; $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_TEST_INSTANCE = [Guid]::NewGuid().ToString('N')
try {
  Start-Sleep -Seconds 1
  $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $main = $A::FromHandle($app.MainWindowHandle)
  if ($Client) {
    (ById $main 'josi.welcome.address').GetCurrentPattern($Value).SetValue("http://127.0.0.1:$Port")
    (ById $main 'josi.welcome.connect').GetCurrentPattern($Invoke).Invoke()
  } else { Click $main 'Open Josi' }
  (Find $main 'Username or email' $C::Edit).GetCurrentPattern($Value).SetValue('roman')
  (Find $main 'Password' $C::Edit).GetCurrentPattern($Value).SetValue('correct horse battery')
  Click $main 'Sign In'
  Find $main 'Menu' $C::Button | Out-Null

  Ask 'please change a setting'
  $popup = Popup
  $handle = [IntPtr]$popup.Current.NativeWindowHandle
  Start-Sleep -Seconds 1
  Write-Host ('sensitive: password box shown: ' + [bool](ById $popup 'josi.settings-change.password'))
  Capture $handle 'p1-sensitive'
  Approve $popup
  Write-Host ('no password: still open: ' + (Open $popup) + ', says: ' + (ErrorText $popup))
  (ById $popup 'josi.settings-change.password').GetCurrentPattern($Value).SetValue('not the password')
  Approve $popup
  Write-Host ('wrong password: still open: ' + (Open $popup) + ', says: ' + (ErrorText $popup))
  Capture $handle 'p2-wrong-password'
  (ById $popup 'josi.settings-change.password').GetCurrentPattern($Value).SetValue('correct horse battery')
  (ById $popup 'josi.settings-change.approve').GetCurrentPattern($Invoke).Invoke()
  Start-Sleep -Seconds 2
  Write-Host ('right password: popup closed: ' + !(ById $main 'josi.sheet.settings-change') + ', says: ' + (ErrorText $main))

  Start-Sleep -Seconds 6
  Ask 'please change a setting, the plain one'
  $plain = Popup
  Start-Sleep -Seconds 1
  Write-Host ('plain: password box shown: ' + [bool](ById $plain 'josi.settings-change.password'))
  Capture ([IntPtr]$plain.Current.NativeWindowHandle) 'p3-plain'
  (ById $plain 'josi.settings-change.approve').GetCurrentPattern($Invoke).Invoke()
  Start-Sleep -Seconds 2
  $app.Refresh()
  Write-Host ('still running: ' + !$app.HasExited)
  Write-Host 'Settings drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($server -and !$server.HasExited) { $server.Kill() }
  if ($data) { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
}
