using System;
using System.IO;
using Microsoft.Win32;

namespace Josi.Native {
  /// Choices that belong to this app on this PC, not to the account: kept for
  /// this Windows user in the registry, so they hold before anyone signs in.
  static class AppPrefs {
    static string Key { get { return @"Software\Josi\Preferences\" + Flags.AppName + AppLinks.Instance; } }
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    /// The launch argument Windows starts Josi with: tray only, no window.
    public const string Background = "--background";

    static string Text(string name) {
      try { using (var key = Registry.CurrentUser.OpenSubKey(Key)) return key == null ? "" : key.GetValue(name) as string ?? ""; }
      catch (Exception) { return ""; }
    }
    static void Set(string name, string value) {
      try { using (var key = Registry.CurrentUser.CreateSubKey(Key)) key.SetValue(name, value); } catch (Exception) { }
    }
    /// Closing the window leaves Josi in the tray. On unless switched off.
    public static bool KeepRunning { get { return Text("KeepRunning") != "0"; } set { Set("KeepRunning", value ? "1" : "0"); } }
    /// Josi starts with Windows, in the tray. On unless switched off.
    public static bool StartAtSignIn { get { return Text("StartAtSignIn") != "0"; } set { Set("StartAtSignIn", value ? "1" : "0"); ApplyStartup(); } }
    /// The server (by its own address) this PC was last signed in to; opened again at launch.
    public static string LastServer { get { return Text("LastServer"); } set { Set("LastServer", value ?? ""); } }

    /// An installed copy only: a development build never registers itself to start with Windows.
    static bool Installed {
      get {
        try {
          var path = Environment.ProcessPath ?? "";
          // Josi Client has its uninstaller beside it; Josi lives in a versioned folder of the server's install.
          return File.Exists(Path.Combine(Path.GetDirectoryName(path) ?? "", "unins000.exe")) || path.IndexOf(@"\Josi CE Server\versions\", StringComparison.OrdinalIgnoreCase) >= 0;
        } catch (Exception) { return false; }
      }
    }
    /// Makes Windows agree with the setting. Called at launch and when it changes.
    public static void ApplyStartup() {
      if (Automation.Demo || AppLinks.Testing || !Installed) return;
      try {
        using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) {
          if (StartAtSignIn) key.SetValue(Flags.AppName, "\"" + Environment.ProcessPath + "\" " + Background);
          else key.DeleteValue(Flags.AppName, false);
        }
      } catch (Exception) { }
    }
  }
}
