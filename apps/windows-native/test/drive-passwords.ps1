# Checks the sign-in page's show-password button and the Forgot password /
# reset dialogs against test/mock-server.mjs. Nothing is submitted.
#   powershell -ExecutionPolicy Bypass -File test\drive-passwords.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8790, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class PassDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
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
function Click($root, [string]$name) { (Find $root $name $C::Button).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Capture($element, [string]$name) {
  Start-Sleep -Milliseconds 800
  $h = [IntPtr]$element.Current.NativeWindowHandle
  $r = New-Object PassDrive+R; [PassDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [PassDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose(); Write-Host "shot $name"
}
function FocusedWindow([string]$title) {
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $element = $A::FocusedElement; $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    while ($element -and $element.Current.ControlType -ne $C::Window) { $element = $walker.GetParent($element) }
    if ($element -and $element.Current.Name -eq $title) { return $element }
    Start-Sleep -Milliseconds 250
  }
  throw "Window not found: $title"
}
if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
try {
  Start-Sleep -Seconds 1
  $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_SERVER_DATA = ''
  $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $main = $A::FromHandle($app.MainWindowHandle)
  (Find $main 'https://josi.example.com' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue("http://localhost:$Port")
  Click $main 'Connect'
  (Find $main 'Username or email' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('roman')
  (Find $main 'Password' $C::Edit).SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('hunter2-secret')
  Click $main 'Show password'
  $shown = Find $main 'Password' $C::Edit
  Write-Host ("shown value matches typed: " + ($shown.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -eq 'hunter2-secret'))
  Capture $main 'p01-login-shown'
  Click $main 'Hide password'
  Click $main 'Forgot password?'
  $forgot = FocusedWindow 'Forgot your password?'
  Write-Host ("forgot dialog prefilled: " + ((Find $forgot 'Username or email' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -eq 'roman'))
  Capture $forgot 'p02-forgot'
  Click $forgot 'I already have a reset link'
  $reset = FocusedWindow 'Invitation or password reset'
  Capture $reset 'p03-reset-link'
  Click $reset 'Close'
  if ($app.HasExited) { throw 'Josi exited during the run' }
  Write-Host 'Password drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
}
