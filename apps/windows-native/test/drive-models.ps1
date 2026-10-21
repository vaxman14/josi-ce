# Drives the Models page and model setup window against test/mock-server.mjs.
#   powershell -ExecutionPolicy Bypass -File test\drive-models.ps1 -Shots <folder>
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8788, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class DriveWin { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); }
'@
New-Item -ItemType Directory -Force $Shots | Out-Null
$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]; $C = [System.Windows.Automation.ControlType]
function Capture($element, [string]$name) {
  Start-Sleep -Milliseconds 900
  $h = [IntPtr]$element.Current.NativeWindowHandle
  $r = New-Object DriveWin+R; [DriveWin]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [DriveWin]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose(); Write-Host "shot $name"
}
function Find($root, [string]$name, $type, [int]$timeout = 12) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)
    if ($type) { $condition = New-Object System.Windows.Automation.AndCondition($condition, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type))) }
    $found = $root.FindFirst($T::Descendants, $condition); if ($found) { return $found }
    Start-Sleep -Milliseconds 250
  }
  throw "Element not found: $name"
}
function Click($root, [string]$name) { (Find $root $name $C::Button).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function TypeInto($root, [string]$name, [string]$text) { (Find $root $name $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($text) }
function Window([string]$title) {
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    # The modal window owns keyboard focus once it opens; walk up to its window.
    $element = $A::FocusedElement
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    while ($element -and $element.Current.ControlType -ne $C::Window) { $element = $walker.GetParent($element) }
    if ($element -and $element.Current.Name -eq $title) { return $element }
    Start-Sleep -Milliseconds 250
  }
  throw "Window not found: $title"
}

$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
try {
  Start-Sleep -Seconds 1
  $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_SERVER_DATA = ''
  if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }; $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $main = $A::FromHandle($app.MainWindowHandle)
  TypeInto $main 'https://josi.example.com' "http://localhost:$Port"
  Click $main 'Connect'
  TypeInto $main 'Username or email' 'roman'
  (Find $main 'Password' $C::Edit).SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('correct horse battery{ENTER}')
  Click $main 'Models'
  Start-Sleep -Seconds 3
  Capture $main 'm01-models-page'

  Click $main 'Sign In with ChatGPT'
  Start-Sleep -Seconds 3
  Capture $main 'm02-chatgpt-code'
  Start-Sleep -Seconds 9
  Capture $main 'm03-chatgpt-connected'

  $add = Find $main 'Add a Fallback…' $C::Button
  Write-Host ("add button: enabled=" + $add.Current.IsEnabled + " offscreen=" + $add.Current.IsOffscreen + " rect=" + $add.Current.BoundingRectangle)
  Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);' -Name Mouse -Namespace Drive
  [DriveWin]::SetForegroundWindow($app.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 400
  $r = $add.Current.BoundingRectangle
  [Drive.Mouse]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)); Start-Sleep -Milliseconds 200
  [Drive.Mouse]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); [Drive.Mouse]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
  $wizard = Window 'Fallback Model'
  Capture $wizard 'm04-choose'
  Click $wizard 'More providers (14)'
  Capture $wizard 'm04b-more'
  Click $wizard 'Claude subscription'
  Start-Sleep -Seconds 2
  Capture $wizard 'm05-claude-connect'
  Click $wizard '1  Choose'
  Click $wizard 'Anthropic API'
  (Find $wizard 'API key' $C::Edit).SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('sk-ant-test-key')
  Capture $wizard 'm06-api-connect'
  Click $wizard 'Continue'
  Start-Sleep -Seconds 2
  Capture $wizard 'm07-models'
  Click $wizard 'Claude Sonnet 5.5'; Click $wizard 'Continue'
  Capture $wizard 'm08-review'
  $consent = $wizard.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $C::CheckBox)))
  $consent.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
  Click $wizard 'Save and Run Capability Check'
  Start-Sleep -Seconds 3
  Capture $wizard 'm09-result'
  Click $wizard 'Done'
  Start-Sleep -Seconds 3
  Capture $main 'm10-models-after'
  if ($app.HasExited) { throw 'Josi exited during the run' }
  Write-Host 'Models drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
}
