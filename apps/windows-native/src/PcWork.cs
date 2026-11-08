using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Josi.Native {
  /// Josi's hands on this PC beyond the screen: commands in a shell, the
  /// user's folders and files, and the programs installed here. Every request
  /// arrives already decided by the server's PC Control; this side re-checks
  /// the exact scope (the shell, the folder tree, the file's folder) before
  /// doing anything, runs as the signed-in user, and never keeps what it saw.
  static class PcWork {
    const int StdoutHead = 40 * 1024, StdoutTail = 24 * 1024, StderrKeep = 16 * 1024, MaxEntries = 500, ReadBytes = 200 * 1024, ReadChars = 64 * 1024;
    static readonly string[] Tools = { "git", "node", "npm", "npx", "dotnet", "python", "py", "pip", "java", "gradle", "gh", "az", "code", "docker", "cargo", "go", "rustc", "adb", "winget", "choco", "pwsh", "wsl", "ffmpeg", "curl", "tar" };

    // ------------------------------------------------------------ shells
    /// The shell exe a request names, if it is one of the two Josi offers and
    /// it is where Windows keeps it. Anything else is refused.
    public static string ShellPath(string name) {
      var system = Environment.GetFolderPath(Environment.SpecialFolder.System);
      switch ((name ?? "").ToLowerInvariant()) {
        case "powershell": return Path.Combine(system, @"WindowsPowerShell\v1.0\powershell.exe");
        case "cmd": return Path.Combine(system, "cmd.exe");
        case "pwsh": {
          var candidate = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"PowerShell\7\pwsh.exe");
          return File.Exists(candidate) ? candidate : null;
        }
        default: return null;
      }
    }
    static bool SamePath(string a, string b) {
      return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }
    /// True when folder is root or lies under it (exact path match, not a prefix of a sibling's name).
    public static bool Within(string folder, string root) {
      var f = Path.GetFullPath(folder).TrimEnd('\\'); var r = Path.GetFullPath(root).TrimEnd('\\');
      return string.Equals(f, r, StringComparison.OrdinalIgnoreCase) || f.StartsWith(r + "\\", StringComparison.OrdinalIgnoreCase);
    }

    /// Runs one command in the shell the scope names, in a folder inside the
    /// scope folder, with no window and no keyboard, and reports exit code and
    /// bounded output. The whole process tree ends on timeout or cancel.
    public static Tuple<bool, object> Command(Wire payload, Wire scope, CancellationToken cancel) {
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      var shell = ShellPath(payload["shell"].Text);
      if (shell == null || !SamePath(shell, scope["application"].Text) || !File.Exists(shell)) return refuse("shell_unknown");
      var cwd = payload["cwd"].Text; var root = scope["target"].Text;
      if (cwd.Length == 0 || !Directory.Exists(cwd) || !Within(cwd, root)) return refuse("folder_outside_scope");
      var command = payload["command"].Text; if (command.Trim().Length == 0) return refuse("empty_command");
      var seconds = payload["timeoutSeconds"].IsNumber ? Math.Min(600, Math.Max(5, (int)payload["timeoutSeconds"].Integer)) : 120;
      var info = new ProcessStartInfo(shell) {
        WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
      };
      if (payload["shell"].Text == "cmd") info.Arguments = "/d /s /c \"" + command.Replace("\r", "").Replace("\n", " & ") + "\"";
      else {
        // EncodedCommand preserves quotes/newlines without leaving an executable
        // script on disk. UTF-8 keeps non-ASCII output intact through the pipe.
        var script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\n" + command + "\n";
        info.Arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
      }
      info.Environment["JOSI_PC_CONTROL"] = "1";
      info.Environment["TERM"] = "dumb"; info.Environment["NO_COLOR"] = "1"; info.Environment["CI"] = "1";
      var stdout = new Capture(StdoutHead, StdoutTail); var stderr = new Capture(StderrKeep, 0);
      var watch = Stopwatch.StartNew(); bool timedOut = false, cancelled = false; int exit;
      exit = PcOwnedProcess.Run(info, stdout.Add, stderr.Add, seconds, cancel, out timedOut, out cancelled);
      watch.Stop();
      if (cancelled) cancel.ThrowIfCancellationRequested();
      return Tuple.Create(true, (object)Wires.O("kind", "desktop_command", "shell", payload["shell"].Text, "cwd", cwd, "exitCode", exit, "timedOut", timedOut,
        "durationMs", (int)watch.ElapsedMilliseconds, "stdout", stdout.Text(), "stderr", PlainErrors(stderr.Text()), "truncated", stdout.Truncated || stderr.Truncated, "untrustedContent", true));
    }
    /// powershell.exe writes its error stream as CLIXML when stderr is a pipe.
    /// Keep the error, warning and verbose text; drop progress records and markup.
    static string PlainErrors(string text) {
      if (!text.StartsWith("#< CLIXML", StringComparison.Ordinal)) return text;
      var lines = new StringBuilder();
      foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(text, "<S S=\"(Error|Warning|Verbose|Debug|Information)\">(.*?)</S>", System.Text.RegularExpressions.RegexOptions.Singleline)) {
        var value = System.Net.WebUtility.HtmlDecode(m.Groups[2].Value);
        value = System.Text.RegularExpressions.Regex.Replace(value, "_x([0-9A-Fa-f]{4})_", x => ((char)Convert.ToInt32(x.Groups[1].Value, 16)).ToString());
        lines.Append(value.Replace("\r\n", "\n"));
        if (!value.EndsWith("\n")) lines.Append('\n');
      }
      return lines.ToString();
    }
    /// Keeps the first and last part of a character stream, dropping the middle.
    sealed class Capture {
      readonly int head, tail; readonly StringBuilder first = new StringBuilder(); readonly StringBuilder last = new StringBuilder();
      long dropped;
      public Capture(int head, int tail) { this.head = head; this.tail = tail; }
      public bool Truncated { get { return dropped > 0; } }
      public void Add(string line) {
        lock (first) {
          var keep = Math.Min(head - first.Length, line.Length);
          first.Append(line, 0, keep);
          last.Append(line, keep, line.Length - keep);
          if (last.Length > tail) { var omit = last.Length - tail; dropped += omit; last.Remove(0, omit); }
        }
      }
      public string Text() {
        lock (first) {
          if (dropped == 0 && last.Length == 0) return first.ToString();
          var text = new StringBuilder(first.ToString());
          if (dropped > 0) text.Append("\n[... ").Append(dropped).Append(" characters omitted ...]\n\n");
          text.Append(last);
          return text.ToString();
        }
      }
    }

    // ------------------------------------------------------------ this PC
    /// Who and where Josi is: the user, home, machine, Windows, shells, tools on PATH and drives.
    public static Tuple<bool, object> Environment_() {
      var shells = Wires.O("powershell", ShellPath("powershell"), "cmd", ShellPath("cmd"));
      var pwsh = OnPath("pwsh"); if (pwsh != null) shells["pwsh"] = pwsh;
      var tools = new Dictionary<string, object>();
      foreach (var tool in Tools) { var found = OnPath(tool); if (found != null) tools[tool] = found; }
      var drives = new List<object>();
      foreach (var drive in DriveInfo.GetDrives()) {
        try { if (drive.IsReady) drives.Add(Wires.O("name", drive.Name, "label", drive.VolumeLabel, "type", drive.DriveType.ToString(), "freeBytes", drive.AvailableFreeSpace, "totalBytes", drive.TotalSize)); }
        catch (IOException) { } catch (UnauthorizedAccessException) { }
      }
      var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      return Tuple.Create(true, (object)Wires.O("kind", "desktop_environment",
        "user", Environment.UserName, "home", home, "computer", Environment.MachineName, "windows", Environment.OSVersion.VersionString,
        "is64Bit", Environment.Is64BitOperatingSystem, "processors", Environment.ProcessorCount,
        "folders", Wires.O("desktop", Environment.GetFolderPath(Environment.SpecialFolder.Desktop), "documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
          "downloads", Path.Combine(home, "Downloads"), "pictures", Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "appData", Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
          "localAppData", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "programFiles", Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "temp", Path.GetTempPath().TrimEnd('\\')),
        "shells", shells, "tools", tools, "drives", drives, "josiApp", Environment.ProcessPath ?? "", "untrustedContent", true));
    }
    static string OnPath(string tool) {
      var path = Environment.GetEnvironmentVariable("PATH") ?? ""; var exts = new[] { ".exe", ".cmd", ".bat", ".com" };
      foreach (var folder in path.Split(';').Where(f => f.Trim().Length > 0)) {
        foreach (var ext in exts) {
          try { var candidate = Path.Combine(folder.Trim(), tool + ext); if (File.Exists(candidate)) return Path.GetFullPath(candidate); }
          catch (ArgumentException) { } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
      }
      return null;
    }

    // ------------------------------------------------------------ programs
    /// Installed programs whose name matches: Start Menu shortcuts (both menus),
    /// App Paths in the registry, and the PATH. Each with its exact exe.
    public static Tuple<bool, object> FindApps(string query) {
      var words = (query ?? "").ToLowerInvariant().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
      if (words.Length == 0) return Tuple.Create(false, (object)Wires.O("code", "empty_query"));
      var found = new List<Dictionary<string, object>>(); var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      Func<string, bool> matches = name => { var n = name.ToLowerInvariant(); return words.All(w => n.Contains(w)); };
      Action<string, string, string, string> add = (name, exe, args, source) => {
        if (exe == null || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(exe)) return;
        var key = exe + "|" + (args ?? "");
        if (!seen.Add(key) || found.Count >= 30) return;
        var entry = Wires.O("name", name, "application", Path.GetFullPath(exe), "source", source);
        if (!string.IsNullOrWhiteSpace(args)) entry["arguments"] = args.Trim();
        found.Add(entry);
      };
      foreach (var menu in new[] { Environment.GetFolderPath(Environment.SpecialFolder.Programs), Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms) }) {
        if (!Directory.Exists(menu)) continue;
        IEnumerable<string> links;
        try { links = Directory.EnumerateFiles(menu, "*.lnk", SearchOption.AllDirectories); } catch (IOException) { continue; } catch (UnauthorizedAccessException) { continue; }
        foreach (var link in links) {
          var name = Path.GetFileNameWithoutExtension(link);
          if (!matches(name)) continue;
          string target, args; if (!Shortcut(link, out target, out args)) continue;
          add(name, target, args, "start-menu");
        }
      }
      foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
        try {
          using (var key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths")) {
            if (key == null) continue;
            foreach (var sub in key.GetSubKeyNames()) {
              var name = Path.GetFileNameWithoutExtension(sub);
              if (!matches(name)) continue;
              using (var app = key.OpenSubKey(sub)) { var exe = (app?.GetValue("") as string)?.Trim('"'); if (exe != null) add(name, Environment.ExpandEnvironmentVariables(exe), null, "app-paths"); }
            }
          }
        } catch (System.Security.SecurityException) { } catch (IOException) { }
      }
      if (words.Length == 1) { var exe = OnPath(words[0]); if (exe != null) add(words[0], exe, null, "path"); }
      return Tuple.Create(true, (object)Wires.O("kind", "desktop_apps", "query", query, "apps", found.Cast<object>().ToList(), "untrustedContent", true));
    }
    static bool Shortcut(string link, out string target, out string arguments) {
      target = null; arguments = null;
      try {
        var type = Type.GetTypeFromProgID("WScript.Shell"); if (type == null) return false;
        dynamic shell = Activator.CreateInstance(type);
        dynamic shortcut = shell.CreateShortcut(link);
        target = (string)shortcut.TargetPath; arguments = (string)shortcut.Arguments;
        return !string.IsNullOrEmpty(target);
      } catch (COMException) { return false; } catch (InvalidOperationException) { return false; } catch (Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { return false; }
    }

    // ------------------------------------------------------------ files
    static bool InScopeFolder(string file, Wire scope, out string refuse) {
      refuse = null;
      var folder = Path.GetDirectoryName(Path.GetFullPath(file));
      if (folder == null || !SamePath(folder, scope["target"].Text)) { refuse = "file_outside_scope"; return false; }
      // Reparse points (junctions, symbolic links) could lead out of the folder the owner approved.
      try {
        var info = new FileInfo(file);
        if (info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0) { refuse = "file_is_link"; return false; }
        var dir = new DirectoryInfo(folder);
        if ((dir.Attributes & FileAttributes.ReparsePoint) != 0) { refuse = "folder_is_link"; return false; }
      } catch (IOException) { refuse = "file_unreadable"; return false; } catch (UnauthorizedAccessException) { refuse = "file_unreadable"; return false; }
      return true;
    }
    public static Tuple<bool, object> ListFolder(Wire payload, Wire scope) {
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      var folder = payload["folder"].Text;
      if (folder.Length == 0 || !SamePath(folder, scope["target"].Text)) return refuse("folder_outside_scope");
      if (!Directory.Exists(folder)) return refuse("folder_missing");
      using var heldFolder = new PcFileGuard(folder);
      var entries = new List<object>(); var partial = false;
      foreach (var entry in new DirectoryInfo(folder).EnumerateFileSystemInfos()) {
        if (entries.Count >= MaxEntries) { partial = true; break; }
        var file = entry as FileInfo;
        var item = Wires.O("name", entry.Name, "kind", file != null ? "file" : "folder", "modified", entry.LastWriteTimeUtc.ToString("o"));
        if (file != null) item["bytes"] = file.Length;
        if ((entry.Attributes & FileAttributes.Hidden) != 0) item["hidden"] = true;
        if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) item["link"] = true;
        entries.Add(item);
      }
      return Tuple.Create(true, (object)Wires.O("kind", "desktop_folder", "folder", Path.GetFullPath(folder), "entries", entries, "partial", partial, "untrustedContent", true));
    }
    public static Tuple<bool, object> ReadFile(Wire payload, Wire scope) {
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      var file = payload["path"].Text; string why = null;
      if (file.Length == 0 || !InScopeFolder(file, scope, out why)) return refuse(why ?? "file_outside_scope");
      if (!File.Exists(file)) return refuse("file_missing");
      long length;
      using var heldFolder = new PcFileGuard(Path.GetDirectoryName(Path.GetFullPath(file)));
      byte[] bytes;
      using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        PcFileGuard.Verify(stream.SafeFileHandle,file);
        length = stream.Length;
        bytes = new byte[Math.Min(length, ReadBytes)]; var read = 0;
        while (read < bytes.Length) { var n = stream.Read(bytes, read, bytes.Length - read); if (n <= 0) break; read += n; }
        if (read < bytes.Length) Array.Resize(ref bytes, read);
      }
      if (bytes.Take(8192).Contains((byte)0)) return Tuple.Create(true, (object)Wires.O("kind", "desktop_file", "path", Path.GetFullPath(file), "bytes", length, "binary", true,
        "text", "", "note", "This is not a text file.", "untrustedContent", true));
      var text = new UTF8Encoding(false, false).GetString(bytes);
      var cut = text.Length > ReadChars || bytes.Length < length;
      if (text.Length > ReadChars) text = text.Substring(0, ReadChars);
      return Tuple.Create(true, (object)Wires.O("kind", "desktop_file", "path", Path.GetFullPath(file), "bytes", length, "text", text, "truncated", cut, "sha256", bytes.Length == length ? Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant() : null, "untrustedContent", true));
    }
    public static Tuple<bool, object> WriteFile(Wire payload, Wire scope) {
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      var file = payload["path"].Text; string why = null;
      var folder = file.Length == 0 ? null : Path.GetDirectoryName(Path.GetFullPath(file));
      if (folder == null || !SamePath(folder, scope["target"].Text)) return refuse("file_outside_scope");
      // The approved folder may be created; nothing above it is touched.
      if (!Directory.Exists(folder)) {
        var parent = Path.GetDirectoryName(folder);
        if (parent == null || !Directory.Exists(parent)) return refuse("folder_missing");
        using var heldParent = new PcFileGuard(parent);
        Directory.CreateDirectory(folder);
      }
      if (!InScopeFolder(file, scope, out why)) return refuse(why);
      var content = payload["content"].Text; var append = payload["append"].Flag;
      var existed = File.Exists(file);
      var expected = payload["expectedSha256"].Text;
      if (!existed && expected.Length > 0) return refuse("file_changed_read_again");
      using var heldFolder = new PcFileGuard(folder);
      using (var stream = new FileStream(file, existed ? FileMode.Open : FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)) {
        PcFileGuard.Verify(stream.SafeFileHandle,file);
        if (existed && expected.Length > 0) {
          var actual = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream)).ToLowerInvariant();
          if (actual != expected) return refuse("file_changed_read_again");
        }
        if (append) stream.Seek(0,SeekOrigin.End); else {stream.Position=0;stream.SetLength(0);}
        using (var writer = new StreamWriter(stream,new UTF8Encoding(false))) writer.Write(content);
      }
      return Tuple.Create(true, (object)Wires.O("kind", "desktop_file_written", "path", Path.GetFullPath(file), "bytes", new FileInfo(file).Length, "appended", append, "created", !existed));
    }
  }
}
