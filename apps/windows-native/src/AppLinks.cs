using System;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Josi.Native {
  /// josi:// links. Google sign-in returns through josi://auth/callback: the
  /// scheme is registered for this Windows account only (no administrator
  /// change), and the copy of Josi the browser starts hands the link to the
  /// running one over a pipe only this Windows account can open, then exits.
  static class AppLinks {
    public const string GoogleReturn = "josi://auth/callback";
    /// Sent by a newer copy that is starting; the running copy quits.
    public const string QuitLink = "josi://quit";
    const int MaxLink = 4096, MaxMessage = 32768;
    /// Files from File Explorer's Send to menu travel as "share:" + paths.
    public const string SharePrefix = "share:";

    /// Separates automated UI tests from a person's open copy: "" normally.
    public static readonly string Instance = InstanceSuffix();
    static string InstanceSuffix() {
      var test = Environment.GetEnvironmentVariable("JOSI_TEST_INSTANCE");
      if (!string.IsNullOrEmpty(test)) return ".Test." + test;
      return Environment.GetEnvironmentVariable("JOSI_TEST_NO_BROWSER") == "1" ? ".Test." + Guid.NewGuid().ToString("N") : "";
    }
    public static bool Testing { get { return Instance.Length > 0; } }
    // Demo acceptance keeps files beside its fixture, never in the owner's profile.
    public static string StateDirectory => Automation.Demo ? Path.Combine(Automation.DemoRoot, "state", "native")
      : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Josi");
    static string PipeName { get { return "Josi.Native.Windows.Links" + Instance + "." + WindowsIdentity.GetCurrent().User.Value; } }

    public static bool IsMessage(string value) {
      return IsLink(value) || (value != null && value.Length <= MaxMessage && value.StartsWith(SharePrefix, StringComparison.Ordinal));
    }
    public static bool IsLink(string value) {
      return value != null && value.Length <= MaxLink && value.StartsWith("josi:", StringComparison.OrdinalIgnoreCase);
    }

    /// Points josi:// at this copy of Josi for the current Windows account.
    /// Test runs never change it.
    public static void Register() {
      if (Testing) return;
      var exe = Environment.ProcessPath;
      if (string.IsNullOrEmpty(exe)) return;
      var wanted = "\"" + exe + "\" \"%1\"";
      using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\josi")) {
        key.SetValue("", "URL:Josi");
        key.SetValue("URL Protocol", "");
        using (var icon = key.CreateSubKey("DefaultIcon")) icon.SetValue("", "\"" + exe + "\",0");
        using (var command = key.CreateSubKey(@"shell\open\command")) command.SetValue("", wanted);
      }
      // A browser that is already open keeps the copy of Josi it learned for
      // josi:// until Windows announces the change; without this it kept
      // starting a version from days ago, which then replaced the running one.
      try { SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); } catch (Exception) { }
    }
    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    /// From a second copy: give the link to the running Josi.
    public static void Forward(string link) {
      try {
        using (var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly)) {
          pipe.Connect(3000);
          var bytes = Encoding.UTF8.GetBytes(link);
          pipe.Write(bytes, 0, bytes.Length);
          pipe.Flush();
        }
      } catch (Exception e) when (e is IOException || e is TimeoutException || e is UnauthorizedAccessException) { }
    }

    /// In the running Josi: receives links from later copies.
    public static void Listen(Action<string> received) {
      var thread = new Thread(() => {
        while (true) {
          try {
            using (var pipe = new NamedPipeServerStream(PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly)) {
              pipe.WaitForConnection();
              var buffer = new byte[MaxMessage + 1]; var total = 0; int read;
              while (total < buffer.Length && (read = pipe.Read(buffer, total, buffer.Length - total)) > 0) total += read;
              if (total > 0 && total <= MaxMessage) {
                var link = Encoding.UTF8.GetString(buffer, 0, total);
                if (IsMessage(link)) received(link);
              }
            }
          } catch (IOException) { Thread.Sleep(200); }
          catch (UnauthorizedAccessException) { return; }
        }
      }) { IsBackground = true, Name = "josi links" };
      thread.Start();
    }
  }
}
