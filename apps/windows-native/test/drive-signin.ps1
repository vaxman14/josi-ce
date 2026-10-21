# Remembered sign-in and Sign in with Google against test/mock-server.mjs.
#  1. Password sign-in; closing and reopening Josi opens signed in.
#  2. Sign out forgets it; reopening shows the welcome screen.
#  3. Sign in with Google: the return link (josi://auth/callback) is handed to
#     the running copy by a second copy, as the browser would; a link with the
#     wrong state is refused. No browser opens and nothing is registered.
#   powershell -ExecutionPolicy Bypass -File test\drive-signin.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8792, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SignInDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
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
function Has($root, [string]$name, $type, [int]$timeout = 8) { try { Find $root $name $type $timeout | Out-Null; return $true } catch { return $false } }
function HasText($root, [string]$text, [int]$timeout = 8) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) {
    foreach ($e in $root.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      $value = $null; try { $value = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
      if ($e.Current.Name -eq $text -or $value -eq $text) { return $true }
    }
    Start-Sleep -Milliseconds 300
  }
  return $false
}
function Click($root, [string]$name) { (Find $root $name $C::Button).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Capture($element, [string]$name) {
  Start-Sleep -Milliseconds 800
  $h = [IntPtr]$element.Current.NativeWindowHandle
  $r = New-Object SignInDrive+R; [SignInDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [SignInDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose(); Write-Host "shot $name"
}
function Launch([string[]]$arguments = @()) {
  $p = if ($arguments.Count) { Start-Process $Exe -ArgumentList $arguments -PassThru } else { Start-Process $Exe -PassThru }
  if ($arguments.Count) { $p.WaitForExit(10000) | Out-Null; return $null }
  do { Start-Sleep -Milliseconds 300; $p.Refresh() } while ($p.MainWindowHandle -eq 0 -and !$p.HasExited)
  $script:app = $p
  return $A::FromHandle($p.MainWindowHandle)
}
function Close { $app.CloseMainWindow() | Out-Null; if (!$app.WaitForExit(5000)) { $app.Kill() } }

if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
$data = & (Join-Path $PSScriptRoot 'mock-local.ps1') -Port $Port; $env:JOSI_SERVER_DATA = $data; $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_TEST_INSTANCE = [Guid]::NewGuid().ToString('N')
try {
  Start-Sleep -Seconds 1
  # 1. Password sign-in, then reopen.
  $main = Launch
  Write-Host ("welcome has no remote option: " + !(Has $main 'Connect' $C::Button 2))
  Click $main 'Open Josi'
  (Find $main 'Username or email' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('roman')
  (Find $main 'Password' $C::Edit).SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('correct horse battery{ENTER}')
  Write-Host ("signed in: " + (Has $main 'Sign out' $C::Button))
  Close
  $main = Launch
  $remembered = Has $main 'Sign out' $C::Button 15
  Write-Host ("reopened signed in without a password: " + $remembered)
  Capture $main 'g01-reopened-signed-in'

  # 2. Sign out forgets it.
  Click $main 'Sign out'
  Start-Sleep -Seconds 2
  Close
  $main = Launch
  Write-Host ("after sign-out, reopens at welcome: " + ((Has $main 'Open Josi' $C::Button) -and !(Has $main 'Sign out' $C::Button 3)))

  # 3. Sign in with Google.
  Click $main 'Open Josi'
  Click $main 'Sign in with Google'
  Write-Host ("waiting for Google: " + (Has $main 'Cancel' $C::Button))
  Capture $main 'g02-google-waiting'
  Launch @('josi://auth/callback?code=mock-google-code-0123456789abcdefghijklmnopq&state=wrong-state-0123456789abcdefghijklmnop') | Out-Null
  Start-Sleep -Seconds 2
  $refused = HasText $main 'That Google sign-in was not started here. Start it again.' 5
  Write-Host ("wrong state refused: " + $refused + ", still on sign-in: " + !(Has $main 'Sign out' $C::Button 2))
  # A stray link leaves the real sign-in waiting.
  Write-Host ("still waiting for Google: " + (Has $main 'Cancel' $C::Button 3))
  Launch @('josi://auth/callback?code=mock-google-code-0123456789abcdefghijklmnopq&state=mock-google-state-0123456789abcdefghijklmnop') | Out-Null
  Write-Host ("signed in with Google: " + (Has $main 'Sign out' $C::Button 15))
  Capture $main 'g03-google-signed-in'
  Close
  $main = Launch
  Write-Host ("Google sign-in remembered: " + (Has $main 'Sign out' $C::Button 15))
  Click $main 'Sign out'
  Start-Sleep -Seconds 2
  Write-Host 'Sign-in drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
  if ($data) { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
  if ($env:JOSI_TEST_INSTANCE) { cmdkey "/delete:Josi/session/http://localhost:$Port/test/$($env:JOSI_TEST_INSTANCE)" | Out-Null }
}
