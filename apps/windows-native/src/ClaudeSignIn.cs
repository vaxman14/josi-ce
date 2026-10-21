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
    static readonly Regex Token = new Regex(@"sk-ant-oat01-[A-Za-z0-9_\-]{40,}");
    readonly PseudoConsole console;
    readonly string profile;
    const short Columns = 400, Rows = 60;
    readonly StringBuilder output = new StringBuilder();
    readonly ConsoleScreen screen = new ConsoleScreen(Columns, Rows);
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
      console = PseudoConsole.Start(executable, "setup-token", environment, profile, Columns, Rows);
      console.Output += Receive;
      console.Exited.ContinueWith(task => {
        string reason;
        lock (output) reason = LastLines(screen.Text());
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
      string all, shown;
      lock (output) {
        output.Append(text); if (output.Length > 256 * 1024) output.Remove(0, output.Length - 128 * 1024); all = output.ToString();
        screen.Feed(text); shown = screen.Text();
      }
      if (!link.Task.IsCompleted) {
        foreach (Match match in Hyperlink.Matches(all)) {
          Uri uri;
          if (Uri.TryCreate(match.Groups[1].Value, UriKind.Absolute, out uri) && AnthropicPage(uri)) { link.TrySetResult(uri); break; }
        }
      }
      // Read from the rebuilt screen, never the raw stream: the console sends
      // only cells that changed, so the stream can lack some of the token's
      // characters. The token is complete once the line after it is drawn.
      var found = Token.Match(shown);
      if (found.Success && shown.IndexOf("Store this token", found.Index + found.Length, StringComparison.Ordinal) > 0) {
        token.TrySetResult(found.Value);
        lock (output) { output.Clear(); screen.Clear(); }
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

    /// Sends the code from Anthropic's page, as typed by the person. Claude
    /// Code treats a burst of input as a paste, so Enter follows separately;
    /// when it has turned on bracketed paste, the code is marked as one.
    public async Task SubmitCode(string code) {
      var value = (code ?? "").Trim();
      if (value.Length == 0 || value.Length > 2048 || Regex.IsMatch(value, @"[\x00-\x1f]")) throw new JosiException("Paste the code shown on Claude's page.");
      string all;
      lock (output) all = output.ToString();
      var bracketed = all.LastIndexOf("\x1b[?2004h", StringComparison.Ordinal) > all.LastIndexOf("\x1b[?2004l", StringComparison.Ordinal);
      console.Write(bracketed ? "\x1b[200~" + value + "\x1b[201~" : value);
      await Task.Delay(700);
      console.Write("\r");
    }

    /// The last lines Claude Code shows, without the token, so a rejected
    /// code is explained instead of silently waiting.
    public string ReplySinceSubmit() {
      lock (output) return LastLines(screen.Text());
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

  /// The pseudo-console's screen, rebuilt from its output. ConPTY sends only
  /// cells that changed and moves the cursor over cells that already hold the
  /// right character, so on-screen text is read from here, not from the
  /// stream. Handles the small VT vocabulary ConPTY emits; colours, modes and
  /// titles are ignored.
  sealed class ConsoleScreen {
    readonly int width, height;
    readonly char[][] rows;
    int x, y;
    string pending = "";

    public ConsoleScreen(int width, int height) {
      this.width = width; this.height = height;
      rows = new char[height][];
      Clear();
    }

    public void Clear() {
      for (var row = 0; row < height; row++) rows[row] = Blank();
      x = 0; y = 0; pending = "";
    }
    char[] Blank() { var row = new char[width]; for (var i = 0; i < width; i++) row[i] = ' '; return row; }

    public string Text() {
      var text = new StringBuilder();
      foreach (var row in rows) text.Append(new string(row).TrimEnd()).Append('\n');
      return text.ToString();
    }

    public void Feed(string chunk) {
      var s = pending + chunk; pending = "";
      var i = 0;
      while (i < s.Length) {
        var c = s[i];
        if (c == '\x1b') {
          var end = Escape(s, i);
          if (end < 0) { if (s.Length - i <= 4096) pending = s.Substring(i); return; } // completes in the next chunk
          i = end; continue;
        }
        if (c == '\r') x = 0;
        else if (c == '\n') LineFeed();
        else if (c == '\b') { if (x > 0) x--; }
        else if (c >= ' ') {
          if (x >= width) { x = 0; LineFeed(); }
          rows[y][x++] = c;
        }
        i++;
      }
    }

    void LineFeed() {
      if (y < height - 1) { y++; return; }
      for (var row = 1; row < height; row++) rows[row - 1] = rows[row];
      rows[height - 1] = Blank();
    }

    /// Index after the escape sequence at start, or -1 when it is incomplete.
    int Escape(string s, int start) {
      if (start + 1 >= s.Length) return -1;
      var kind = s[start + 1];
      if (kind == '[') {
        var i = start + 2;
        while (i < s.Length && s[i] >= 0x20 && s[i] <= 0x3f) i++;
        if (i >= s.Length) return -1;
        Control(s.Substring(start + 2, i - start - 2), s[i]);
        return i + 1;
      }
      if (kind == ']' || kind == 'P' || kind == '_' || kind == '^') {
        // String sequences end with BEL or ESC \.
        for (var i = start + 2; i < s.Length; i++) {
          if (s[i] == '\x07') return i + 1;
          if (s[i] == '\x1b') return i + 1 < s.Length ? i + 2 : -1;
        }
        return -1;
      }
      if (kind == '(' || kind == ')' || kind == '#') return start + 2 < s.Length ? start + 3 : -1;
      return start + 2;
    }

    void Control(string parameters, char final) {
      if (parameters.Length > 0 && (parameters[0] == '?' || parameters[0] == '>' || parameters[0] == '<' || parameters[0] == '=')) return;
      var parts = parameters.Split(';');
      Func<int, int, int> n = (index, fallback) => {
        int value;
        return index < parts.Length && int.TryParse(parts[index], out value) && value > 0 ? value : fallback;
      };
      switch (final) {
        case 'H': case 'f': y = n(0, 1) - 1; x = n(1, 1) - 1; break;
        case 'A': y -= n(0, 1); break;
        case 'B': y += n(0, 1); break;
        case 'C': x += n(0, 1); break;
        case 'D': x -= n(0, 1); break;
        case 'G': x = n(0, 1) - 1; break;
        case 'd': y = n(0, 1) - 1; break;
        case 'X': Erase(y, x, Math.Min(width, x + n(0, 1))); break;
        case 'K': {
          var mode = n(0, 0);
          if (mode == 0) Erase(y, x, width); else if (mode == 1) Erase(y, 0, x + 1); else Erase(y, 0, width);
          break;
        }
        case 'J': {
          var mode = n(0, 0);
          if (mode == 0) { Erase(y, x, width); for (var row = y + 1; row < height; row++) rows[row] = Blank(); }
          else if (mode == 1) { Erase(y, 0, x + 1); for (var row = 0; row < y; row++) rows[row] = Blank(); }
          else for (var row = 0; row < height; row++) rows[row] = Blank();
          break;
        }
      }
      x = Math.Max(0, Math.Min(width, x)); y = Math.Max(0, Math.Min(height - 1, y));
    }

    void Erase(int row, int from, int to) {
      from = Math.Max(0, from); to = Math.Min(width, to);
      for (var i = from; i < to; i++) rows[row][i] = ' ';
    }
  }
}
