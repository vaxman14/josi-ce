# First-run setup's Language model step against test/mock-server.mjs in setup
# mode, where the server's model check fails: connects the Claude subscription
# (paste-a-token path), saves, and checks that the reason is shown with a way
# back instead of returning silently to the same step. Nothing real is used.
#   powershell -ExecutionPolicy Bypass -File test\drive-setup-model.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8791, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SetupDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); }
'@
New-Item -ItemType Directory -Force $Shots | Out-Null
$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]; $C = [System.Windows.Automation.ControlType]
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
function Click($root, [string]$name) {
  $button = Find $root $name $C::Button
  $deadline = (Get-Date).AddSeconds(10)
  while (!$button.Current.IsEnabled -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (!$button.Current.IsEnabled) { Capture $root ("disabled-" + ($name -replace '\W', '')); throw "Button stayed disabled: $name" }
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function Capture($element, [string]$name) {
  Start-Sleep -Milliseconds 800
  $h = [IntPtr]$element.Current.NativeWindowHandle
  $r = New-Object SetupDrive+R; [SetupDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [SetupDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose(); Write-Host "shot $name"
}
if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
# A throwaway development-server folder that points the app at the mock.
$data = Join-Path ([IO.Path]::GetTempPath()) ('josi-setup-drive-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force (Join-Path $data 'config'), (Join-Path $data 'first-run') | Out-Null
Set-Content (Join-Path $data 'config\runtime.json') ('{"schemaVersion":1,"version":"test","publicUrl":"http://localhost:' + $Port + '"}')
Set-Content (Join-Path $data 'first-run\bootstrap.json') ('{"schemaVersion":1,"port":' + $Port + ',"token":"' + ('a' * 64) + '"}')
$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port setup" -PassThru -WindowStyle Hidden
$app = $null
try {
  Start-Sleep -Seconds 1
  $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_SERVER_DATA = $data
  $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $main = $A::FromHandle($app.MainWindowHandle)
  Click $main 'Open Josi'
  Click $main 'Claude subscription'
  Click $main 'Sign In with Claude'
  (Find $main 'Claude subscription token' $C::Edit).SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('sk-ant-oat01-mock-token-for-the-test-only')
  Click $main 'Save Token in Vault'
  Start-Sleep -Seconds 2
  Click $main 'Continue'
  Click $main 'Claude Haiku'
  Click $main 'Continue'
  $consent = $main.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $C::CheckBox)))
  $consent.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
  Click $main 'Save and Check Model'
  $reason = $null
  try { $reason = Find $main 'Change Settings' $C::Button 10 } catch { }
  Write-Host ("check failure shown: " + [bool]$reason)
  Capture $main 's01-check-failed'
  if ($reason) {
    Click $main 'Change Settings'
    Write-Host ("back at sign-in: " + [bool](Find $main 'Replace with a New Sign-In' $C::Button))
    Capture $main 's02-change-settings'
  }
  if ($app.HasExited) { throw 'Josi exited during the run' }
  Write-Host 'Setup model drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
  Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
}
