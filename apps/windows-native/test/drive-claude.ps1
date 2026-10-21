# Starts the in-app Claude sign-in against test/mock-server.mjs with the real
# pinned claude.exe, stops at the code box, and checks it can take input.
# No sign-in happens and no browser opens (JOSI_TEST_NO_BROWSER).
#   powershell -ExecutionPolicy Bypass -File test\drive-claude.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8789, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class ClaudeDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
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
function Capture($h, [string]$name) {
  $r = New-Object ClaudeDrive+R; [ClaudeDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [ClaudeDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose(); Write-Host "shot $name"
}
if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
try {
  Start-Sleep -Seconds 1
  $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_SERVER_DATA = ''
  $env:JOSI_CLAUDE_EXE = 'C:\Dev\josi-dev\cli\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe'
  $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $main = $A::FromHandle($app.MainWindowHandle)
  (Find $main 'https://josi.example.com' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue("http://localhost:$Port")
  (Find $main 'Connect' $C::Button).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  (Find $main 'Username or email' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('roman')
  (Find $main 'Password' $C::Edit).SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('correct horse battery{ENTER}')
  (Find $main 'Models' $C::Button).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Seconds 3
  (Find $main 'Sign In with Claude' $C::Button).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  $code = Find $main "Paste the code from Claude's page" $C::Edit 60
  Start-Sleep -Seconds 2
  Write-Host ("code box: enabled=" + $code.Current.IsEnabled + " focusable=" + $code.Current.IsKeyboardFocusable)
  $code.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('typed-ok')
  Write-Host ("code box accepts input: " + ($code.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -eq 'typed-ok'))
  $code.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('')
  $continue = Find $main 'Continue' $C::Button
  Write-Host ("continue button: enabled=" + $continue.Current.IsEnabled)
  $code.SetFocus(); Start-Sleep -Milliseconds 500
  # Scroll the code box into view before the screenshot.
  try { $code.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch { }
  Capture $app.MainWindowHandle 'claude-code-box'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
}
