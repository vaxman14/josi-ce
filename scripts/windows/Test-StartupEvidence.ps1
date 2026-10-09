$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '..\..\packaging\windows\StartupEvidence.psm1')
$boot=[DateTime]::UtcNow.AddHours(-1)
$empty=Get-NativeStartupEvidence $boot {param($Start) @()}
if($empty.status -cne 'unavailable' -or $empty.historicalOrderingConfirmed){throw 'Empty history falsely passed ordering'}
$none=Get-NativeStartupEvidence $boot {param($Start)
    $record=[Management.Automation.ErrorRecord]::new([Exception]::new('No events'),'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand',[Management.Automation.ErrorCategory]::ObjectNotFound,$null)
    throw $record
}
if($none.status -cne 'unavailable'){throw 'Missing-event evidence was misclassified'}
$refused=$false
try{Get-NativeStartupEvidence $boot {param($Start) throw [UnauthorizedAccessException]::new('denied')} | Out-Null}catch{$refused=$true}
if(!$refused){throw 'Access failure silently became an evidence gap'}
$event=[pscustomobject]@{TimeCreated=$boot.AddSeconds(10);Properties=@([pscustomobject]@{Value='Josi CE Speech Control'},[pscustomobject]@{Value='running'})}
$found=Get-NativeStartupEvidence $boot {$event}
if($found.status -cne 'events-retained-for-review' -or $found.events.Count -ne 1 -or $found.historicalOrderingConfirmed){throw 'Unreviewed event falsely confirmed ordering'}
$real=Get-NativeStartupEvidence $boot
$report=[ordered]@{passed=$true;tests=4;emptyHistoryNotAcceptedAsOrdering=$true;noMatchingEventsClassified=$true;accessFailurePropagates=$true;eventsRetainedWithoutInventedOrdering=$true;observed=$real;recordedAt=[DateTime]::UtcNow.ToString('o')}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\artifacts\windows-native\evidence\startup-event-check.json') -Encoding UTF8
'Four startup evidence boundary checks passed.'
