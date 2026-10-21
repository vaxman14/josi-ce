# Test helper: opens Josi against the development server, optionally clicks
# buttons by accessible name, and saves a screenshot. No text is typed.
#   powershell -File test\snap.ps1 -Out shot.png -Click 'Open Josi','Continue'
param([Parameter(Mandatory)][string]$Out, [string[]]$Click = @(), [int]$Wait = 3, [switch]$Keep)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SnapWin { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); }
'@
$A = [System.Windows.Automation.AutomationElement]
$env:JOSI_SERVER_DATA = 'C:\Dev\josi-dev\data'
$exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe'
$app = Start-Process $exe -PassThru
do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
$h = $app.MainWindowHandle; $window = $A::FromHandle($h)
foreach ($name in $Click) {
  $deadline = (Get-Date).AddSeconds(15); $found = $null
  while (!$found -and (Get-Date) -lt $deadline) {
    $condition = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)),
      (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
    $found = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if (!$found) { Start-Sleep -Milliseconds 300 }
  }
  if (!$found) { Write-Host "not found: $name"; break }
  $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Seconds $Wait
}
Start-Sleep -Milliseconds 800
$r = New-Object SnapWin+R; [SnapWin]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [SnapWin]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
$bmp.Save($Out); $bmp.Dispose()
if (!$Keep) { $app.CloseMainWindow() | Out-Null; Start-Sleep 1; if (!$app.HasExited) { $app.Kill() } }
Write-Host "saved $Out"
