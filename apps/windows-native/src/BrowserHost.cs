using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Josi.Native {
  /// The Josi browser extension's native messaging host. Chrome starts
  /// Josi.exe with the extension's origin as its argument; that copy relays
  /// each message to the running Josi over a pipe only this Windows account
  /// can open, and answers "unavailable" when Josi is not open. It never
  /// starts Josi, chooses a server or grants anything itself.
  static class BrowserHost {
    public const string Name = "com.heyjosi.browser";
    public const string ExtensionId = "peopadjeldgefmbfllgjgdndhabbagpl";
    /// Item 37: the Firefox add-on ID (fixed in development-identity.json; Mozilla ties the listing to it).
    public const string FirefoxExtensionId = "josi-browser@heyjosi.com";
    /// The store-assigned Chromium IDs, once published, go here beside the development one.
    public static readonly string[] ChromiumExtensionIds = { ExtensionId };
    public const int MaxFrame = 200 * 1024;
    static string Origin { get { return "chrome-extension://" + ExtensionId + "/"; } }
    public static string PipeName { get { return "Josi.Native.Windows.Browser" + AppLinks.Instance + "." + WindowsIdentity.GetCurrent().User.Value; } }

    public static bool IsLaunch(string[] args) {
      if (args.Length >= 1 && args[0] == Origin) return true;
      // Firefox starts the host with the manifest path and the add-on ID.
      return args.Length >= 2 && args[1] == FirefoxExtensionId && args[0].EndsWith(Name + ".firefox.json", StringComparison.OrdinalIgnoreCase);
    }

    /// Points Chrome, Brave and Edge at this copy of Josi for the current
    /// Windows account (no administrator change). Test runs never change it.
    public static void Register() {
      if (AppLinks.Testing) return;
      try {
        var exe = Environment.ProcessPath; if (string.IsNullOrEmpty(exe)) return;
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Josi", "BrowserHost");
        Directory.CreateDirectory(folder);
        var manifest = Path.Combine(folder, Name + ".json");
        var json = Wires.Serialize(Wires.O("name", Name, "description", "Josi browser control", "path", exe, "type", "stdio",
          "allowed_origins", new List<object> { Origin }));
        if (!File.Exists(manifest) || File.ReadAllText(manifest) != json) File.WriteAllText(manifest, json);
        foreach (var browser in new[] { @"Software\Google\Chrome", @"Software\BraveSoftware\Brave-Browser", @"Software\Microsoft\Edge" })
          using (var key = Registry.CurrentUser.CreateSubKey(browser + @"\NativeMessagingHosts\" + Name)) key.SetValue("", manifest);
        // Firefox (item 37): its own manifest names the add-on instead of an origin.
        var firefoxManifest = Path.Combine(folder, Name + ".firefox.json");
        var firefoxJson = Wires.Serialize(Wires.O("name", Name, "description", "Josi browser control", "path", exe, "type", "stdio",
          "allowed_extensions", new List<object> { FirefoxExtensionId }));
        if (!File.Exists(firefoxManifest) || File.ReadAllText(firefoxManifest) != firefoxJson) File.WriteAllText(firefoxManifest, firefoxJson);
        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Mozilla\NativeMessagingHosts\" + Name)) key.SetValue("", firefoxManifest);
      } catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is System.Security.SecurityException) { }
    }

    // ------------------------------------------------ the copy Chrome starts
    public static int Run() {
      var input = Console.OpenStandardInput(); var output = Console.OpenStandardOutput();
      NamedPipeClientStream pipe = null;
      var peer = Peer();
      if (peer != null) {
        try {
          pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.CurrentUserOnly);
          pipe.Connect(1500);
          Frames.Write(pipe, Encoding.UTF8.GetBytes(Wires.Serialize(peer)));
        } catch (Exception e) when (e is IOException || e is TimeoutException || e is UnauthorizedAccessException) { pipe?.Dispose(); pipe = null; }
      }
      try {
        while (true) {
          var request = Frames.Read(input, MaxFrame); if (request == null) return 0;
          byte[] reply = null;
          if (pipe != null) {
            try { Frames.Write(pipe, request); reply = Frames.Read(pipe, MaxFrame); }
            catch (IOException) { reply = null; }
            if (reply == null) { pipe.Dispose(); pipe = null; }
          }
          reply = reply ?? Refusal(request);
          if (reply == null) return 1;
          Frames.Write(output, reply);
        }
      } catch (IOException) { return 0; }
      finally { pipe?.Dispose(); }
    }
    static byte[] Refusal(byte[] request) {
      try {
        var id = Wires.Parse(Encoding.UTF8.GetString(request))["requestId"].Text;
        if (!Wires.IsUuid(id)) return null;
        return Encoding.UTF8.GetBytes(Wires.Serialize(Wires.O("version", 1, "requestId", id, "ok", false, "payload", Wires.O())));
      } catch (Exception) { return null; }
    }

    /// The browser that started this copy: Chrome runs native hosts through
    /// cmd.exe, so look a few parents up for a known browser executable.
    static Dictionary<string, object> Peer() {
      var processes = Snapshot(); var pid = (uint)Environment.ProcessId;
      for (var depth = 0; depth < 4; depth++) {
        Tuple<uint, string> entry;
        if (!processes.TryGetValue(pid, out entry)) return null;
        pid = entry.Item1;
        if (!processes.TryGetValue(pid, out entry)) return null;
        var family = entry.Item2.ToLowerInvariant() == "chrome.exe" ? "chrome" : entry.Item2.ToLowerInvariant() == "brave.exe" ? "brave"
          : entry.Item2.ToLowerInvariant() == "msedge.exe" ? "edge" : entry.Item2.ToLowerInvariant() == "firefox.exe" ? "firefox" : null;
        if (family == null) continue;
        var path = ImagePath(pid); if (path == null) return null;
        return Wires.O("kind", "peer", "family", family, "application", path, "processId", (long)pid);
      }
      return null;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
      public uint Size, Usage, ProcessId; public IntPtr HeapId; public uint ModuleId, Threads, ParentId; public int Priority; public uint Flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    static Dictionary<uint, Tuple<uint, string>> Snapshot() {
      var result = new Dictionary<uint, Tuple<uint, string>>();
      var snapshot = CreateToolhelp32Snapshot(2, 0);
      if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return result;
      try {
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
        if (Process32FirstW(snapshot, ref entry))
          do { result[entry.ProcessId] = Tuple.Create(entry.ParentId, entry.ExeFile ?? ""); } while (Process32NextW(snapshot, ref entry));
      } finally { CloseHandle(snapshot); }
      return result;
    }
    static string ImagePath(uint pid) {
      var process = OpenProcess(0x1000, false, pid); if (process == IntPtr.Zero) return null;
      try { var name = new StringBuilder(1024); uint size = 1024; return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString() : null; }
      finally { CloseHandle(process); }
    }
  }

  /// Chrome's native messaging framing, used on the pipe too: a 4-byte
  /// little-endian length, then UTF-8 JSON.
  static class Frames {
    public static byte[] Read(Stream stream, int max) {
      var header = Exactly(stream, 4); if (header == null) return null;
      var length = BitConverter.ToInt32(header, 0);
      if (length <= 0 || length > max) throw new IOException("Frame too large.");
      return Exactly(stream, length) ?? throw new IOException("Frame cut short.");
    }
    static byte[] Exactly(Stream stream, int length) {
      var buffer = new byte[length]; var total = 0;
      while (total < length) { var read = stream.Read(buffer, total, length - total); if (read <= 0) return total == 0 ? null : throw new IOException("Frame cut short."); total += read; }
      return buffer;
    }
    public static void Write(Stream stream, byte[] body) {
      var frame = new byte[body.Length + 4];
      BitConverter.GetBytes(body.Length).CopyTo(frame, 0); body.CopyTo(frame, 4);
      stream.Write(frame, 0, frame.Length); stream.Flush();
    }
  }
}
