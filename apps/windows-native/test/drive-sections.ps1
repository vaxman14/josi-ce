# Smoke check: signs in to test/mock-server.mjs and opens every sidebar
# section, confirming Josi stays open and each section draws. The mock does
# not implement every route, so a section may show an error banner; what this
# catches is a crash or a section that cannot draw.
#   powershell -ExecutionPolicy Bypass -File test\drive-sections.ps1 -Shots <folder> [-Exe <Josi.exe>]
param([string]$Shots = (Join-Path $PSScriptRoot 'shots'), [int]$Port = 8793, [string]$Exe = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SectionDrive { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
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
function Capture($h, [string]$name) {
  $r = New-Object SectionDrive+R; [SectionDrive]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [SectionDrive]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $Shots "$name.png")); $bmp.Dispose()
}
if (!$Exe) { $Exe = Join-Path (Split-Path $PSScriptRoot) 'bin\Release\net8.0-windows10.0.19041.0\Josi.exe' }
$mock = Start-Process node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.mjs')`" $Port" -PassThru -WindowStyle Hidden
$app = $null
$data = & (Join-Path $PSScriptRoot 'mock-local.ps1') -Port $Port; $env:JOSI_SERVER_DATA = $data; $env:JOSI_TEST_NO_BROWSER = '1'; $env:JOSI_TEST_INSTANCE = [Guid]::NewGuid().ToString('N')
$sections = 'Approvals','Calendar','Contacts','Files','Reminders','Memory','Personalization','Email Templates','Workflows','Automation','Migrate',
  'Connections','Vault','Messaging Apps','Usage','Your Settings','Family','Companion Apps','Overview','Getting Started','Models','People','Connectors',
  'Integrations','Custom APIs','Workflow Providers','Approval Policy','Parental Controls','Storage','Email Delivery','Backups','Voice Box','PC Control','Workspace','Network',
  'Maintenance','Audit Log','Server','Task Manager','Conversations'
try {
  Start-Sleep -Seconds 1
  $app = Start-Process $Exe -PassThru
  do { Start-Sleep -Milliseconds 300; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and !$app.HasExited)
  $h = $app.MainWindowHandle; $main = $A::FromHandle($h)
  Click $main 'Open Josi'
  (Find $main 'Username or email' $C::Edit).GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('roman')
  (Find $main 'Password' $C::Edit).SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('correct horse battery{ENTER}')
  Find $main 'Sign out' $C::Button | Out-Null
  $failed = @()
  foreach ($name in $sections) {
    try { Click $main $name } catch { $failed += "$name (not in sidebar)"; continue }
    Start-Sleep -Milliseconds 1500
    if ($app.HasExited) { $failed += "$name (Josi exited)"; break }
    Capture $h ('s-' + ($name -replace '\W', ''))
  }
  Write-Host ("sections opened: " + ($sections.Count - $failed.Count) + " of " + $sections.Count)
  if ($failed.Count) { Write-Host ("problems: " + ($failed -join '; ')) }
  if ($app.HasExited) { throw 'Josi exited during the run' }
  Write-Host 'Sections drive completed'
} finally {
  if ($app -and !$app.HasExited) { $app.Kill() }
  if ($mock -and !$mock.HasExited) { $mock.Kill() }
  if ($data) { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
  if ($env:JOSI_TEST_INSTANCE) { cmdkey "/delete:Josi/session/http://localhost:$Port/test/$($env:JOSI_TEST_INSTANCE)" | Out-Null }
}
