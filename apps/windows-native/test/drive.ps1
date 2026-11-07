# Drives Josi.exe through Windows UI Automation against test/mock-server.mjs
# and saves a screenshot after each step. Test fixture only.
#   powershell -ExecutionPolicy Bypass -File test\drive.ps1 -Shots <folder>
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8787, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Post {
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static void Key(IntPtr h, int key) { PostMessage(h, 0x100, (IntPtr)key, (IntPtr)1); PostMessage(h, 0x101, (IntPtr)key, (IntPtr)1); }
  public static void Click(IntPtr h, int x, int y) { var at = (IntPtr)((y << 16) | x); PostMessage(h, 0x201, (IntPtr)1, at); PostMessage(h, 0x202, IntPtr.Zero, at); }
}
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
  $data = & (Join-Path $PSScriptRoot 'mock-local.ps1') -Port $Port; $env:JOSI_SERVER_DATA = $data; $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_TEST_INSTANCE = [Guid]::NewGuid().ToString('N')
  $app = Start-Process $exe -PassThru
  $deadline = (Get-Date).AddSeconds(20)
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited -and (Get-Date) -lt $deadline)
  if ($app.HasExited) { throw "Josi exited during startup ($($app.ExitCode))" }
  $h = $app.MainWindowHandle
  [Shot]::SetForegroundWindow($h) | Out-Null
  $window = $A::FromHandle($h)
  Capture $h '01-welcome'

  Click $window 'Open Josi'
  Find $window 'Sign In' | Out-Null
  Capture $h '02-sign-in'

  TypeInto $window 'Username or email' 'roman'
  # Everything goes to Josi's own controls. Never SendKeys: it types into
  # whatever window has focus, which may not be this one.
  TypeInto $window 'Password' 'wrong password'
  Click $window 'Sign In'
  Start-Sleep -Seconds 1.5
  Capture $h '03-sign-in-error'
  TypeInto $window 'Password' 'correct horse battery'
  Click $window 'Sign In'
  Find $window 'Menu' | Out-Null
  Start-Sleep -Seconds 1
  Capture $h '04-workspace-empty'

  Click $window 'Menu'; Start-Sleep -Milliseconds 600; Click $window 'Garage sale photo descriptions'
  Start-Sleep -Seconds 2
  Capture $h '05-conversation'

  TypeInto $window 'Message Josi' 'Please draft the first description.'
  Click $window 'Send message'
  Start-Sleep -Seconds 1.5
  Capture $h '06-thinking'
  Start-Sleep -Seconds 6
  Capture $h '07-stage'

  Click $window 'Menu'
  Start-Sleep -Seconds 1
  Capture $h '07-menu'
  # Posted to Josi's window, so this can't reach anything else.
  [Shot]::SetForegroundWindow($h) | Out-Null; $window.SetFocus(); Start-Sleep -Milliseconds 300
  [Post]::Key($h, 0x1B); Start-Sleep -Seconds 1
  Write-Host ('Esc closes the menu: ' + !$window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Close menu'))))
  $still = $window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Close menu')))
  if ($still) { Click $window 'Close menu'; Start-Sleep -Seconds 1 }
  Click $window 'History'
  Start-Sleep -Seconds 1
  Capture $h '07-history'
  [Shot]::SetForegroundWindow($h) | Out-Null; $window.SetFocus(); Start-Sleep -Milliseconds 300
  [Post]::Key($h, 0x1B); Start-Sleep -Seconds 1
  Write-Host ('Esc closes history: ' + !$window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Close chat history'))))
  $close = $window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Close chat history')))
  if ($close) { Click $window 'Close chat history'; Start-Sleep -Seconds 1 }

  TypeInto $window 'Message Josi' 'Show me the link please'
  Click $window 'Send message'
  Start-Sleep -Seconds 1.5
  $named = { param($n) [bool]$window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $n))) }
  $header = { $window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'josi.status.line'))).Current.Name }
  Write-Host ('while thinking, header: ' + (& $header) + ', chip shown: ' + (& $named 'Josi is thinking'))
  Capture $h '10-thinking'
  $deadline = (Get-Date).AddSeconds(20)
  while (!(& $named 'the uploads page') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 2.5
  Write-Host ('after the reply, chip hidden: ' + !(& $named 'Josi is thinking') + ', header: ' + (& $header))
  Capture $h '11-link-reply'
  $raw = $window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'josi.chat.stage.text')))
  Write-Host ('stage text: ' + $raw.Current.Name)
  $hyper = $window.FindFirst($T::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)))
  Write-Host ('stage link found: ' + [bool]$hyper + ' (' + $(if ($hyper) { $hyper.Current.Name }) + ')')
  if ($hyper) { $hyper.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 500 }
  Write-Host ('history stayed closed after the link: ' + !(& $named 'Close chat history'))
  Click $window 'History'; Start-Sleep -Seconds 1
  Capture $h '12-link-history'
  Click $window 'Close chat history'; Start-Sleep -Seconds 1

  Click $window 'Menu'; Start-Sleep -Milliseconds 600; Click $window 'Tasks'
  Start-Sleep -Seconds 2
  Capture $h '08-task-manager'

  foreach ($section in 'Vault', 'Settings', 'Model', 'Server') {
    Click $window 'Menu'; Start-Sleep -Milliseconds 600; Click $window $section
    Start-Sleep -Seconds 2
    Capture $h ('09-' + ($section -replace ' ', '-').ToLower())
  }
  if ($app.HasExited) { throw 'Josi exited during the run' }
  Write-Host 'Drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 1; if (!$app.HasExited) { $app.Kill() } }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
  if ($data) { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
  if ($env:JOSI_TEST_INSTANCE) { cmdkey "/delete:Josi/session/http://localhost:$Port/test/$($env:JOSI_TEST_INSTANCE)" | Out-Null }
}
