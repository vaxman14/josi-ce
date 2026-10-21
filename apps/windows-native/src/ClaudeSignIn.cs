using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  /// Anthropic's official Claude Code CLI on this PC, pinned to the exact
  /// binary the server's Vault runtime accepts (packaging/windows/subscription-cli.lock.json).
  public static class ClaudeCli {
    public const string Version = "2.1.258";
    const string Sha256 = "22f5f3a44093e14c75a4d1c8ce25c730b21dd634318fbe3268e9057d12b17c41";
    const long Size = 218507936;

    /// Candidate locations: an explicit override, the CLI next to a
    /// development server on this PC, then the CLI bundled with the app.
    public static IEnumerable<string> Candidates() {
      var explicitPath = Environment.GetEnvironmentVariable("JOSI_CLAUDE_EXE");
      if (!string.IsNullOrEmpty(explicitPath)) yield return explicitPath;
      var data = Environment.GetEnvironmentVariable("JOSI_SERVER_DATA");
      if (!string.IsNullOrEmpty(data) && Path.IsPathRooted(data)) {
        var root = Path.GetDirectoryName(Path.GetFullPath(data).TrimEnd('\\'));
        if (root != null) yield return Path.Combine(root, @"cli\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe");
      }
      yield return Path.Combine(AppContext.BaseDirectory, @"cli\claude.exe");
    }

    /// Returns the verified binary path, or null when none is present. A file
    /// that exists but is not Anthropic's signed pinned binary is an error.
    public static string Locate() {
      foreach (var candidate in Candidates()) {
        FileInfo file;
        try { file = new FileInfo(candidate); } catch (ArgumentException) { continue; }
        if (!file.Exists) continue;
        if ((file.Attributes & FileAttributes.ReparsePoint) != 0 || file.Length != Size) {
          throw new JosiException("The Claude Code program at " + file.FullName + " is not the version Josi supports (" + Version + ").");
        }
        string hash;
        using (var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan))
          hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (hash != Sha256) throw new JosiException("The Claude Code program at " + file.FullName + " does not match the version Josi supports (" + Version + ").");
        if (!SignedByAnthropic(file.FullName)) throw new JosiException("The Claude Code program at " + file.FullName + " is not validly signed by Anthropic.");
        return file.FullName;
      }
      return null;
    }

    static bool SignedByAnthropic(string path) {
      if (WinVerify(path) != 0) return false;
#pragma warning disable SYSLIB0057
      using (var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))
#pragma warning restore SYSLIB0057
        return certificate.Subject.Contains("O=\"Anthropic, PBC\"") || certificate.Subject.Contains("O=Anthropic, PBC");
    }

    // WinVerifyTrust with the standard Authenticode policy, no UI, revocation of the whole chain.
    static int WinVerify(string path) {
      var file = new TrustFile { Size = Marshal.SizeOf<TrustFile>(), Path = path };
      var filePointer = Marshal.AllocHGlobal(Marshal.SizeOf<TrustFile>());
      Marshal.StructureToPtr(file, filePointer, false);
      var data = new TrustData { Size = Marshal.SizeOf<TrustData>(), UiChoice = 2, RevocationChecks = 0, UnionChoice = 1, File = filePointer,
        StateAction = 1, ProviderFlags = 0x80 /* WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT */ };
      var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
      try {
        var result = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
        data.StateAction = 2; // close
        WinVerifyTrust(IntPtr.Zero, ref action, ref data);
        return result;
      } finally {
        Marshal.DestroyStructure<TrustFile>(filePointer);
        Marshal.FreeHGlobal(filePointer);
      }
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TrustFile { public int Size; [MarshalAs(UnmanagedType.LPWStr)] public string Path; public IntPtr Handle; public IntPtr KnownSubject; }
    [StructLayout(LayoutKind.Sequential)]
    struct TrustData {
      public int Size; public IntPtr PolicyCallbackData, SipClientData; public int UiChoice, RevocationChecks, UnionChoice;
      public IntPtr File; public int StateAction; public IntPtr StateData; public IntPtr UrlReference; public int ProviderFlags, UiContext;
      public IntPtr SignatureSettings;
    }
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
    static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
  }

  /// One `claude setup-token` sign-in, run privately in a pseudo-console with a
  /// throwaway profile. The app opens Anthropic's sign-in page itself, passes
  /// back the code the person copies from it, and receives the long-lived
  /// subscription token, which goes only to the server's Vault.
  public sealed class ClaudeSetupToken : IDisposable {
    static readonly Regex Hyperlink = new Regex(@"\x1b\]8;[^;\x07\x1b]*;(https://[^\x07\x1b\s]+)(?:\x07|\x1b\\)");
    static readonly Regex Ansi = new Regex(@"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]");
    static readonly Regex Token = new Regex(@"sk-ant-oat01-[A-Za-z0-9_\-]{40,}");
    readonly PseudoConsole console;
    readonly string profile;
    readonly StringBuilder output = new StringBuilder();
    readonly TaskCompletionSource<Uri> link = new TaskCompletionSource<Uri>(TaskCreationOptions.RunContinuationsAsynchronously);
    readonly TaskCompletionSource<string> token = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    int disposed;

    public Task<Uri> SignInPage { get { return link.Task; } }
    /// Completes with the token, or faults with the CLI's own reason.
    public Task<string> Result { get { return token.Task; } }

    ClaudeSetupToken(string executable) {
      profile = PrivateFolder();
      var root = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
      // A throwaway profile: no personal Claude settings, logins or history are
      // read or written. BROWSER=none: Josi opens the validated page itself.
      var environment = new Dictionary<string, string> {
        ["SystemRoot"] = root, ["windir"] = root, ["PATH"] = Path.Combine(root, "System32"),
        ["USERPROFILE"] = profile, ["APPDATA"] = profile, ["LOCALAPPDATA"] = profile, ["CLAUDE_CONFIG_DIR"] = profile,
        ["TEMP"] = profile, ["TMP"] = profile, ["TERM"] = "xterm-256color", ["BROWSER"] = "none",
        ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1",
      };
      console = PseudoConsole.Start(executable, "setup-token", environment, profile, 400, 60);
      console.Output += Receive;
      console.Exited.ContinueWith(task => {
        string reason;
        lock (output) reason = LastLines(Ansi.Replace(output.ToString(), ""));
        token.TrySetException(new JosiException(string.IsNullOrWhiteSpace(reason)
          ? "Claude Code stopped before it issued a token. Start the sign-in again."
          : "Claude Code stopped before it issued a token: " + reason));
        link.TrySetException(new JosiException("Claude Code stopped before it showed a sign-in page."));
      }, TaskScheduler.Default);
    }

    public static Task<ClaudeSetupToken> Start(string executable) {
      return Task.Run(() => new ClaudeSetupToken(executable));
    }

    void Receive(string text) {
      string all;
      lock (output) { output.Append(text); if (output.Length > 256 * 1024) output.Remove(0, output.Length - 128 * 1024); all = output.ToString(); }
      if (!link.Task.IsCompleted) {
        foreach (Match match in Hyperlink.Matches(all)) {
          Uri uri;
          if (Uri.TryCreate(match.Groups[1].Value, UriKind.Absolute, out uri) && AnthropicPage(uri)) { link.TrySetResult(uri); break; }
        }
      }
      var plain = Ansi.Replace(all, "");
      var found = Token.Match(plain);
      // The token is complete once something follows it on the screen.
      if (found.Success && plain.Length > found.Index + found.Length) {
        token.TrySetResult(found.Value);
        lock (output) output.Clear();
        Dispose();
      }
    }

    static bool AnthropicPage(Uri uri) {
      if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length > 0) return false;
      var host = uri.Host.ToLowerInvariant();
      foreach (var domain in new[] { "claude.com", "claude.ai", "anthropic.com" })
        if (host == domain || host.EndsWith("." + domain)) return true;
      return false;
    }

    static string LastLines(string text) {
      var lines = text.Replace("\r", "\n").Split('\n');
      var kept = new List<string>();
      for (var index = lines.Length - 1; index >= 0 && kept.Count < 3; index--) {
        var line = lines[index].Trim();
        if (line.Length > 0 && !Token.IsMatch(line)) kept.Insert(0, line.Length > 200 ? line.Substring(0, 200) : line);
      }
      return string.Join(" ", kept);
    }

    /// Sends the code from Anthropic's page, as typed by the person.
    public void SubmitCode(string code) {
      var value = (code ?? "").Trim();
      if (value.Length == 0 || value.Length > 2048 || Regex.IsMatch(value, @"[\x00-\x1f]")) throw new JosiException("Paste the code shown on Claude's page.");
      console.Write(value);
      console.Write("\r");
    }

    static string PrivateFolder() {
      var path = Path.Combine(Path.GetTempPath(), "josi-claude-signin-" + Guid.NewGuid().ToString("N"));
      var security = new DirectorySecurity();
      security.SetAccessRuleProtection(true, false);
      var me = WindowsIdentity.GetCurrent().User;
      security.SetOwner(me);
      foreach (var sid in new[] { me, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
          InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      new DirectoryInfo(path).Create(security);
      return path;
    }

    public void Dispose() {
      if (Interlocked.Exchange(ref disposed, 1) != 0) return;
      console.Dispose();
      token.TrySetException(new OperationCanceledException());
      link.TrySetException(new OperationCanceledException());
      // The CLI may hold files briefly after termination; retry removal.
      Task.Run(async () => {
        for (var attempt = 0; attempt < 20; attempt++) {
          try { if (Directory.Exists(profile)) Directory.Delete(profile, true); return; }
          catch (IOException) { } catch (UnauthorizedAccessException) { }
          await Task.Delay(250);
        }
      });
    }
  }
}
