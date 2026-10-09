# Supplemental boot history only. Missing informational SCM events are an
# evidence gap; access/provider/query failures remain errors. Never enable logs
# or change the machine's service/audit configuration to manufacture evidence.
Set-StrictMode -Version Latest
function Get-NativeStartupEvidence([DateTime]$BootUtc, [scriptblock]$Reader) {
    if (!$Reader) {
        $Reader = { param($Start)
            Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager';Id=7036;StartTime=$Start.ToLocalTime()} -ErrorAction Stop
        }
    }
    try { $events = @(& $Reader $BootUtc) }
    catch {
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound,*') { throw }
        $events = @()
    }
    $josi = @($events | Where-Object { $_.Properties.Count -ge 2 -and ($_.Properties[0].Value -as [string]) -like 'Josi CE*' } |
        Sort-Object TimeCreated | ForEach-Object {
            [ordered]@{timeUtc=$_.TimeCreated.ToUniversalTime().ToString('o');service=$_.Properties[0].Value;state=$_.Properties[1].Value}
        })
    return [pscustomobject]@{querySucceeded=$true;historicalOrderingConfirmed=$false;
        status=$(if($josi.Count){'events-retained-for-review'}else{'unavailable'});
        gap=$(if($josi.Count){'Ordering requires explicit review of retained events'}else{'No matching SCM 7036 transition events since boot; no logging policy was changed'});
        events=$josi}
}
Export-ModuleMember -Function Get-NativeStartupEvidence
