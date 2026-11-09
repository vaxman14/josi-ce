using System;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Diagnostics;
using System.Threading;

// Calls PcWork in the built Josi.dll with the same Wire payloads and scopes the
// server would send, and prints each result. Exit code 1 if any check fails.
static class Probe {
  static int failures;
  static Assembly josi;
  static Type wire, wires, work;

  static object Parse(string json) { return wires.GetMethod("Parse").Invoke(null, new object[] { json }); }
  static string Json(object value) { return (string)wire.GetProperty("Json").GetValue(value); }
  static object Call(string method, params object[] args) {
    var m = work.GetMethod(method, BindingFlags.Public | BindingFlags.Static);
    return m.Invoke(null, args);
  }
  static string Run(string name, string method, params object[] args) {
    try {
      var tuple = Call(method, args);
      var ok = (bool)tuple.GetType().GetProperty("Item1").GetValue(tuple);
      var result = tuple.GetType().GetProperty("Item2").GetValue(tuple);
      var json = (string)wires.GetMethod("Serialize").Invoke(null, new object[] { result });
      Console.WriteLine("== " + name + " -> " + (ok ? "ok" : "refused"));
      Console.WriteLine(json.Length > 1500 ? json.Substring(0, 1500) + " ..." : json);
      return (ok ? "ok:" : "refused:") + json;
    } catch (TargetInvocationException e) {
      Console.WriteLine("== " + name + " -> threw " + e.InnerException.GetType().Name + ": " + e.InnerException.Message);
      return "threw:" + e.InnerException.GetType().Name;
    }
  }
  static void Expect(string name, string outcome, string contains) {
    if (outcome.Contains(contains)) Console.WriteLine("   PASS " + name);
    else { failures++; Console.WriteLine("   FAIL " + name + " (wanted " + contains + ")"); }
  }
  static void ExpectNot(string name, string outcome, string absent) {
    if (!outcome.Contains(absent)) Console.WriteLine("   PASS " + name);
    else { failures++; Console.WriteLine("   FAIL " + name + " (found " + absent + ")"); }
  }
  static string Q(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

  static int Main(string[] args) {
    var dll = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "Josi.dll"));
    josi = Assembly.LoadFrom(dll);
    wire = josi.GetType("Josi.Native.Wire"); wires = josi.GetType("Josi.Native.Wires"); work = josi.GetType("Josi.Native.PcWork");
    var ps = (string)Call("ShellPath", "powershell"); var cmd = (string)Call("ShellPath", "cmd");
    var scratch = Path.Combine(Path.GetTempPath(), "josi-pcwork-probe-" + Guid.NewGuid().ToString("N").Substring(0, 8));
    Directory.CreateDirectory(scratch); var sub = Path.Combine(scratch, "sub"); Directory.CreateDirectory(sub);
    var none = CancellationToken.None;
    string Scope(string shell, string root) { return "{\"kind\":\"command\",\"target\":" + Q(root) + ",\"application\":" + Q(shell) + "}"; }
    try {
      if (Array.IndexOf(args,"--terminal-only") < 0) {
      var env = Run("environment", "Environment_");
      Expect("environment names the user and shells", env, "\"user\":" ); Expect("environment lists powershell", env, "powershell.exe");

      var apps = Run("find notepad", "FindApps", "notepad");
      Expect("notepad found", apps, "notepad.exe");
      var noapps = Run("find nothing", "FindApps", "zzqqxx-no-such-program");
      Expect("no match is ok with empty list", noapps, "\"apps\":[]");

      var echo = Run("powershell echo", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"powershell\",\"command\":\"Write-Output (Get-Location).Path; Write-Output 'héllo wörld'; Write-Error 'warned'; exit 3\",\"cwd\":" + Q(sub) + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":30}"), Parse(Scope(ps, scratch)), none);
      Expect("exit code 3", echo, "\"exitCode\":3"); Expect("cwd is the subfolder", echo, sub.Replace("\\", "\\\\")); Expect("unicode survives", echo, "h" + "\\" + "u00E9llo w" + "\\" + "u00F6rld"); Expect("stderr captured as plain text", echo, "warned"); ExpectNot("no CLIXML noise", echo, "CLIXML");

      var dir = Run("cmd dir", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"cmd\",\"command\":\"echo from cmd && cd\",\"cwd\":" + Q(scratch) + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":30}"), Parse(Scope(cmd, scratch)), none);
      Expect("cmd exit 0", dir, "\"exitCode\":0"); Expect("cmd output", dir, "from cmd");

      var slow = Run("timeout kills the tree", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"powershell\",\"command\":\"Start-Sleep -Seconds 60\",\"cwd\":" + Q(scratch) + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":5}"), Parse(Scope(ps, scratch)), none);
      Expect("timed out", slow, "\"timedOut\":true");

      var outside = Run("cwd outside scope", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"powershell\",\"command\":\"echo no\",\"cwd\":" + Q(Path.GetTempPath().TrimEnd('\\')) + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":30}"), Parse(Scope(ps, scratch)), none);
      Expect("refused outside scope", outside, "folder_outside_scope");
      var wrongShell = Run("shell not in scope", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"cmd\",\"command\":\"echo no\",\"cwd\":" + Q(scratch) + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":30}"), Parse(Scope(ps, scratch)), none);
      Expect("refused other shell", wrongShell, "shell_unknown");
      var sibling = Run("sibling folder with same prefix", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"powershell\",\"command\":\"echo no\",\"cwd\":" + Q(scratch + "2") + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":30}"), Parse(Scope(ps, scratch)), none);
      Expect("refused sibling", sibling, "folder_outside_scope");

      var big = Run("long output is trimmed", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"powershell\",\"command\":\"1..20000 | ForEach-Object { 'line number ' + $_ }\",\"cwd\":" + Q(scratch) + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":60}"), Parse(Scope(ps, scratch)), none);
      Expect("truncated flag", big, "\"truncated\":true"); Expect("tail kept", big, "line number 20000");

      var cancel = new CancellationTokenSource(1500);
      var cancelled = Run("cancel ends the command", "Command", Parse("{\"kind\":\"desktop.command\",\"shell\":\"powershell\",\"command\":\"Start-Sleep -Seconds 60\",\"cwd\":" + Q(scratch) + ",\"scopeFolder\":" + Q(scratch) + ",\"timeoutSeconds\":60}"), Parse(Scope(ps, scratch)), cancel.Token);
      Expect("cancel throws OperationCanceled", cancelled, "OperationCanceledException");

      var folderScope = Parse("{\"kind\":\"folder\",\"target\":" + Q(scratch) + "}");
      var file = Path.Combine(scratch, "note.txt");
      var written = Run("write file", "WriteFile", Parse("{\"kind\":\"desktop.writefile\",\"path\":" + Q(file) + ",\"content\":\"first line\\n\",\"append\":false}"), folderScope);
      Expect("created", written, "\"created\":true");
      var appended = Run("append file", "WriteFile", Parse("{\"kind\":\"desktop.writefile\",\"path\":" + Q(file) + ",\"content\":\"second ünïcode line\\n\",\"append\":true}"), folderScope);
      Expect("appended", appended, "\"appended\":true");
      var read = Run("read file", "ReadFile", Parse("{\"kind\":\"desktop.readfile\",\"path\":" + Q(file) + "}"), folderScope);
      Expect("read both lines", read, "first line\\nsecond \\u00FCn\\u00EFcode line");
      var list = Run("list folder", "ListFolder", Parse("{\"kind\":\"desktop.folder\",\"folder\":" + Q(scratch) + "}"), folderScope);
      Expect("lists note.txt", list, "note.txt"); Expect("lists sub as folder", list, "\"kind\":\"folder\"");
      var readOutside = Run("read outside scope", "ReadFile", Parse("{\"kind\":\"desktop.readfile\",\"path\":" + Q(Path.Combine(sub, "x.txt")) + "}"), folderScope);
      Expect("refused subfolder file", readOutside, "file_outside_scope");
      var binary = Path.Combine(scratch, "bin.dat"); File.WriteAllBytes(binary, new byte[] { 1, 0, 2, 0, 3 });
      var readBinary = Run("read binary", "ReadFile", Parse("{\"kind\":\"desktop.readfile\",\"path\":" + Q(binary) + "}"), folderScope);
      Expect("binary flagged", readBinary, "\"binary\":true");
      var newFolder = Path.Combine(scratch, "made"); var newScope = Parse("{\"kind\":\"folder\",\"target\":" + Q(newFolder) + "}");
      var made = Run("write creates the exact scope folder", "WriteFile", Parse("{\"kind\":\"desktop.writefile\",\"path\":" + Q(Path.Combine(newFolder, "a.txt")) + ",\"content\":\"x\",\"append\":false}"), newScope);
      Expect("folder created and written", made, "\"created\":true");
      var deep = Run("write refuses missing parent chain", "WriteFile", Parse("{\"kind\":\"desktop.writefile\",\"path\":" + Q(Path.Combine(scratch, "no", "deeper", "a.txt")) + ",\"content\":\"x\",\"append\":false}"), Parse("{\"kind\":\"folder\",\"target\":" + Q(Path.Combine(scratch, "no", "deeper")) + "}"));
      Expect("refused folder_missing", deep, "folder_missing");
      }
      // Exercise the new persistent shell, not a console UI or another app.
      var terminals = josi.GetType("Josi.Native.PcTerminals");
      var session = Guid.NewGuid().ToString();
      string Terminal(string kind, string text = "") {
        var payload = Parse(JsonSerializer.Serialize(new { kind="desktop.terminal."+kind, sessionId=session, shell="powershell", cwd=scratch, timeoutSeconds=30, text }));
        var tuple = terminals.GetMethod("Execute").Invoke(null,new[]{(object)session,payload,Parse(Scope(ps,scratch))});
        return (string)wires.GetMethod("Serialize").Invoke(null,new[]{tuple.GetType().GetProperty("Item2").GetValue(tuple)});
      }
      try {
        Expect("persistent terminal opens",Terminal("open"),"\"running\":true");
        Terminal("input","$josiProbeValue = 6 * 7\r");
        Terminal("input","Write-Output ('JOSI-PERSIST-' + $josiProbeValue)\r");
        var wait = Stopwatch.StartNew(); string output;
        do {Thread.Sleep(100);output=Terminal("read");} while(!output.Contains("JOSI-PERSIST-42")&&wait.ElapsedMilliseconds<8000);
        Expect("PowerShell state persists between inputs",output,"JOSI-PERSIST-42");
        if(!output.Contains("JOSI-PERSIST-42"))Console.WriteLine(output.Length>1800?output.Substring(0,1800):output);
        Expect("terminal closes its owned process",Terminal("close"),"\"running\":false");
      } finally { terminals.GetMethod("StopAll").Invoke(null,null); }
    } finally { try { Directory.Delete(scratch, true); } catch (IOException) { } }
    Console.WriteLine(failures == 0 ? "ALL PASSED" : failures + " FAILED");
    return failures == 0 ? 0 : 1;
  }
}
