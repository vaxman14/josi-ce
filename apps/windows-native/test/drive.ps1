# Drives Josi.exe through Windows UI Automation against test/mock-server.mjs
# and saves a screenshot after each step. Test fixture only.
#   powershell -ExecutionPolicy Bypass -File test\drive.ps1 -Shots <folder>
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8787, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Shot {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
New-Item -ItemType Directory -Force $Shots | Out-Null
$root = Split-Path $PSScriptRoot
$exe = if ($Exe) { $Exe } else { Join-Path $root 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]

function Capture([IntPtr]$h, [string]$name) {
  Start-Sleep -Milliseconds 700
  $r = New-Object Shot+R; [Shot]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1, $r.Ri - $r.L)), ([Math]::Max(1, $r.B - $r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  [Shot]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $file = Join-Path $Shots "$name.png"; $bmp.Save($file); $bmp.Dispose()
  Write-Host "shot $file"
}
function Find($window, [string]$name, $type = $null, [int]$timeout = 10) {
  $deadline = (Get-Date).AddSeconds($timeout)
  while ((Get-Date) -lt $deadline) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)
    if ($type) { $condition = New-Object System.Windows.Automation.AndCondition($condition, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type))) }
    $found = $window.FindFirst($T::Descendants, $condition)
    if ($found) { return $found }
    Start-Sleep -Milliseconds 250
  }
  throw "Element not found: $name"
}
function Click($window, [string]$name) {
  $element = Find $window $name ([System.Windows.Automation.ControlType]::Button)
  $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function TypeInto($window, [string]$name, [string]$text) {
  $element = Find $window $name ([System.Windows.Automation.ControlType]::Edit)
  $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($text)
}

$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
try {
  Start-Sleep -Seconds 1
  $app = Start-Process $exe -PassThru
  $deadline = (Get-Date).AddSeconds(20)
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited -and (Get-Date) -lt $deadline)
  if ($app.HasExited) { throw "Josi exited during startup ($($app.ExitCode))" }
  $h = $app.MainWindowHandle
  [Shot]::SetForegroundWindow($h) | Out-Null
  $window = $A::FromHandle($h)
  Capture $h '01-welcome'

  TypeInto $window 'https://josi.example.com' "http://localhost:$Port"
  Click $window 'Connect'
  Find $window 'Sign In' | Out-Null
  Capture $h '02-sign-in'

  TypeInto $window 'Username or email' 'roman'
  # PasswordBox has no ValuePattern; focus it and type.
  Add-Type -AssemblyName System.Windows.Forms
  $password = Find $window 'Password' ([System.Windows.Automation.ControlType]::Edit)
  $password.SetFocus()
  [System.Windows.Forms.SendKeys]::SendWait('wrong password{ENTER}')
  Start-Sleep -Seconds 1.5
  Capture $h '03-sign-in-error'
  $password = Find $window 'Password' ([System.Windows.Automation.ControlType]::Edit)
  $password.SetFocus()
  [System.Windows.Forms.SendKeys]::SendWait('correct horse battery{ENTER}')
  Find $window 'Task Manager' | Out-Null
  Start-Sleep -Seconds 1
  Capture $h '04-workspace-empty'

  Click $window 'Garage sale photo descriptions'
  Start-Sleep -Seconds 2
  Capture $h '05-conversation'

  TypeInto $window 'Message Josi' 'Please draft the first description.'
  Click $window 'Send message'
  Start-Sleep -Seconds 1.5
  Capture $h '06-thinking'
  Start-Sleep -Seconds 6
  Capture $h '07-reply'

  Click $window 'Task Manager'
  Start-Sleep -Seconds 2
  Capture $h '08-task-manager'

  foreach ($section in 'Memory', 'Automation', 'Vault', 'Your Settings', 'Models', 'Server') {
    Click $window $section
    Start-Sleep -Seconds 2
    Capture $h ('09-' + ($section -replace ' ', '-').ToLower())
  }
  if ($app.HasExited) { throw 'Josi exited during the run' }
  Write-Host 'Drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 1; if (!$app.HasExited) { $app.Kill() } }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
}
