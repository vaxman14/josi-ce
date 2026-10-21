using System;
using System.Collections.Generic;
using System.Linq;

namespace Josi.Native {
  /// The server stores IANA zone names (America/Los_Angeles); Windows uses its
  /// own IDs (Pacific Standard Time). .NET maps between them with ICU.
  static class TimeZones {
    /// This PC's zone as an IANA name, or UTC if Windows' zone has no mapping.
    public static string Local() { return Iana(TimeZoneInfo.Local); }
    public static string Iana(TimeZoneInfo zone) {
      string iana;
      if (zone.HasIanaId) return zone.Id;
      return TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out iana) ? iana : "UTC";
    }
    /// Every Windows zone that maps to an IANA name, as (IANA, display) pairs.
    public static List<KeyValuePair<string, string>> All() {
      return TimeZoneInfo.GetSystemTimeZones()
        .Select(z => new KeyValuePair<string, string>(Iana(z), z.DisplayName))
        .Where(p => p.Key != "UTC" || p.Value.Contains("UTC"))
        .GroupBy(p => p.Key).Select(g => g.First()).ToList();
    }
    public static TimeZoneInfo Find(string iana) {
      TimeZoneInfo zone;
      try { return TimeZoneInfo.FindSystemTimeZoneById(iana); } catch (Exception) { }
      string windows;
      if (TimeZoneInfo.TryConvertIanaIdToWindowsId(iana ?? "", out windows)) {
        try { zone = TimeZoneInfo.FindSystemTimeZoneById(windows); return zone; } catch (Exception) { }
      }
      return TimeZoneInfo.Local;
    }
  }
}
