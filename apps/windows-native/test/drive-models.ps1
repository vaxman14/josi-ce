# Drives the Models page and model setup window against test/mock-server.mjs.
#   powershell -ExecutionPolicy Bypass -File test\drive-models.ps1 -Shots <folder>
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8788)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class DriveWin { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
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
    $found = $A::RootElement.FindFirst($T::Children, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $title)))
    if ($found) { return $found }; Start-Sleep -Milliseconds 250
  }
  throw "Window not found: $title"
}

$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
try {
  Start-Sleep -Seconds 1
  $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_SERVER_DATA = ''
  $app = Start-Process (Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe') -PassThru
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

  Click $main 'Add a Fallback…'
  $wizard = Window 'Fallback Model'
  Capture $wizard 'm04-choose'
  Click $wizard 'Claude subscription'; Click $wizard 'Continue'
  Start-Sleep -Seconds 2
  Capture $wizard 'm05-claude-connect'
  Click $wizard '1  Choose'
  Click $wizard 'Anthropic API'; Click $wizard 'Continue'
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
