using System;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Threading.Tasks;

namespace Josi.Native {
  /// Finds a newer signed installer among the published GitHub releases. Josi never
  /// installs anything by itself: the person runs the installer, which updates in
  /// place and keeps their data.
  static class Updates {
    const string Feed = "https://api.github.com/repos/vaxman14/josi-ce/releases/latest";
    public sealed class Release { public string Version, Name; public Uri Url; }

    public static string Current {
      get {
        var version = typeof(Updates).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>();
        return version == null ? "" : version.InformationalVersion;
      }
    }

    /// The newest published installer for this app, or null when none is newer.
    public static async Task<Release> Newer() {
      using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) }) {
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Josi-Windows");
        var feed = Wires.Parse(await client.GetStringAsync(Feed));
        var version = feed["tag_name"].Text.TrimStart('v');
        var prefix = Flags.ServerApp ? "Josi-CE-" : "Josi-Client-";
        var asset = feed["assets"].List.FirstOrDefault(a => a["name"].Text.StartsWith(prefix, StringComparison.Ordinal) && a["name"].Text.EndsWith("-Windows-x64.exe", StringComparison.Ordinal));
        Uri url;
        if (asset == null || !IsNewer(version, Current) || !Uri.TryCreate(asset["browser_download_url"].Text, UriKind.Absolute, out url)) return null;
        // Only ever send someone to GitHub for an installer.
        if (url.Scheme != "https" || !url.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)) return null;
        return new Release { Version = version, Name = asset["name"].Text, Url = url };
      }
    }

    public static bool IsNewer(string candidate, string current) {
      Version a, b;
      return System.Version.TryParse((candidate ?? "").Split('-')[0], out a) && System.Version.TryParse((current ?? "").Split('-')[0], out b) && a > b;
    }

    /// Once per launch, quietly. A failed check says nothing.
    public static async void NotifyIfNewer() {
      if (AppLinks.Testing) return;
      try {
        var release = await Newer();
        if (release != null) Notifications.Show("Josi " + release.Version + " is available", "Open Settings to download the update.");
      } catch (Exception) { }
    }
  }
}
