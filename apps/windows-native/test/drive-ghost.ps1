# Signs in to test/mock-server.mjs, sends a message, and prints which ghost clip
# is on as it changes, with screenshots along the way.
#   powershell -ExecutionPolicy Bypass -File test\drive-ghost.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8796, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class GhostDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
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
    Start-Sleep -Milliseconds 200
  }
  throw "Element not found: $name"
}
function Click($root, [string]$name) {
  $button = Find $root $name $C::Button
  $deadline = (Get-Date).AddSeconds(10)
  while (!$button.Current.IsEnabled -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (!$button.Current.IsEnabled) { throw "$name stayed disabled for 10 seconds" }
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function Capture($h, [string]$name) {
  $r = New-Object GhostDrive+R; [GhostDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [GhostDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose()
}
$script:lastClip = ''; $script:started = Get-Date
function Clip($root) {
  $condition = New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'josi.ghost')
  $all = $root.FindAll($T::Descendants, $condition)
  foreach ($view in $all) { $status = $view.Current.ItemStatus; if ($status) { return $status } }
  return ''
}
function Watch($root, [double]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    $clip = Clip $root
    if ($clip -and $clip -ne $script:lastClip) { $script:lastClip = $clip; Write-Host ('{0,6:n1}s  {1}' -f ((Get-Date) - $script:started).TotalSeconds, $clip) }
    Start-Sleep -Milliseconds 500
  }
}
if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$server = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
$data = & (Join-Path $PSScriptRoot 'mock-local.ps1') -Port $Port; $env:JOSI_SERVER_DATA = $data; $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_TEST_INSTANCE = [Guid]::NewGuid().ToString('N')
try {
  Start-Sleep -Seconds 1
  $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $h = $app.MainWindowHandle; $main = $A::FromHandle($h)
  Start-Sleep -Seconds 2; Capture $h 'g1-welcome'
  Click $main 'Open Josi'
  (Find $main 'Username or email' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('roman')
  Start-Sleep -Seconds 1; Capture $h 'g2-sign-in'
  (Find $main 'Password' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('correct horse battery'); Click $main 'Sign In'
  Find $main 'Menu' $C::Button | Out-Null
  Watch $main 3; Capture $h 'g3-greeting'
  Write-Host '-- typing'
  (Find $main 'Message Josi' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('Please draft the first description.')
  Watch $main 8
  Write-Host '-- sending'
  Click $main 'Send message'
  Watch $main 3; Capture $h 'g4-thinking'
  Watch $main 18; Capture $h 'g5-reply'
  Write-Host '-- settled'
  Watch $main 8
  function Say([string]$text, [string]$label, [double]$wait) {
    Write-Host "-- $label"
    (Find $main 'Message Josi' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($text)
    Click $main 'Send message'
    Watch $main $wait
  }
  Say 'Give me a list please' 'a list' 16
  Capture $h 'g5b-list'
  Say 'this one should fail' 'a failed turn' 14
  Capture $h 'g5c-failed'
  Click $main 'Menu'; Start-Sleep -Milliseconds 600; Click $main 'Garage sale photo descriptions'; Start-Sleep -Seconds 3
  Say 'finish the task' 'a finished task' 16
  Capture $h 'g5d-finished'
  Click $main 'Menu'; Start-Sleep -Milliseconds 600; Click $main 'Tasks'; Start-Sleep -Seconds 2; Capture $h 'g6-tasks'
  Click $main 'Menu'; Start-Sleep -Milliseconds 600; Click $main 'Settings'; Start-Sleep -Seconds 2; Capture $h 'g7-settings'
  Click $main 'Menu'; Start-Sleep -Milliseconds 600; Click $main 'Overview'; Start-Sleep -Seconds 2; Capture $h 'g8-overview'
  $app.Refresh(); $cpu = $app.TotalProcessorTime
  Click $main 'Menu'; Start-Sleep -Milliseconds 600; Click $main 'Chat'; Start-Sleep -Seconds 12
  $app.Refresh(); $before = $app.TotalProcessorTime; Start-Sleep -Seconds 15; $app.Refresh()
  Write-Host ('idle on stage, CPU % of one core: ' + [math]::Round((($app.TotalProcessorTime - $before).TotalSeconds / 15) * 100, 1))
  Write-Host ('private MB: ' + [math]::Round($app.PrivateMemorySize64 / 1MB))
  Write-Host ('memory MB: ' + [math]::Round($app.WorkingSet64 / 1MB) + '  still running: ' + !$app.HasExited)
  Write-Host '-- reply time (the mock answers after 4s, and the app polls every 3s)'
  Click $main 'Menu'; Start-Sleep -Milliseconds 600; Click $main 'Chat'; Start-Sleep -Seconds 2
  $stageId = New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'josi.chat.stage.text')
  foreach ($round in 1..4) {
    (Find $main 'Message Josi' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue("timing check $round")
    Click $main 'Send message'
    $started = Get-Date; Start-Sleep -Seconds 1
    do {
      Start-Sleep -Milliseconds 700
      $line = $main.FindFirst($T::Descendants, $stageId)
      $text = if ($line) { $line.Current.Name } else { '' }
    } while ($text -notmatch 'easy' -and ((Get-Date) - $started).TotalSeconds -lt 25)
    Write-Host ('reply ' + $round + ': ' + [math]::Round(((Get-Date) - $started).TotalSeconds, 1) + 's')
    Start-Sleep -Seconds 7
  }
  Write-Host 'Ghost drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($server -and !$server.HasExited) { $server.Kill() }
}
