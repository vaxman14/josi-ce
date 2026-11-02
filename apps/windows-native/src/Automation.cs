using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace Josi.Native {
  /// What an outside automation tool (a UI test, a demo recorder) can hold on
  /// to: stable automation ids on every control, one machine-readable status
  /// line, and demo mode. Nothing here changes how the app behaves for a
  /// person who starts it normally; demo mode is a separate launch.
  /// AUTOMATION.md at the repository root documents all of it.
  public static class Automation {
    // ------------------------------------------------------------- ids
    /// The screen the controls being built belong to: "files", "chat", "sheet".
    public static string Scope = "app";
    static readonly Dictionary<string, int> seen = new Dictionary<string, int>();
    /// Starts a screen: derived ids read josi.<scope>.<label>, numbered on repeats.
    public static void BeginScope(string scope) { Scope = Slug(scope); seen.Clear(); }
    /// A hand-chosen id, which wins over any derived one.
    public static T Id<T>(T element, string id) where T : DependencyObject {
      AutomationProperties.SetAutomationId(element, id);
      return element;
    }
    public static T Id<T>(T element, string id, string name) where T : DependencyObject {
      AutomationProperties.SetAutomationId(element, id);
      if (!string.IsNullOrEmpty(name)) AutomationProperties.SetName(element, name);
      return element;
    }
    /// An id for a control a Ui helper built, from its label: the first
    /// "Refresh" on the Files page is josi.files.refresh, the second josi.files.refresh.2.
    public static void Derive(DependencyObject element, string kind, string label) {
      var slug = Slug(label);
      if (slug.Length == 0) slug = Slug(kind);
      var id = "josi." + Scope + "." + slug;
      int n; seen.TryGetValue(id, out n); n++; seen[id] = n;
      AutomationProperties.SetAutomationId(element, n == 1 ? id : id + "." + n);
    }
    /// True when nothing has set an id on this element yet.
    public static bool Unnamed(DependencyObject element) { return string.IsNullOrEmpty(AutomationProperties.GetAutomationId(element)); }
    public static string Slug(string text) {
      var slug = Regex.Replace((text ?? "").ToLowerInvariant().Replace("’", "").Replace("'", ""), "[^a-z0-9]+", "-").Trim('-');
      return slug.Length > 48 ? slug.Substring(0, 48).TrimEnd('-') : slug;
    }
    /// A container with an id and a name that UI Automation can see. Panels and
    /// borders have no automation peer, so rows and banners are wrapped in one.
    public static UserControl Group(string id, string name, UIElement child) {
      var group = new UserControl { Content = child, Focusable = false, IsTabStop = false };
      Id(group, id, name);
      return group;
    }

    // ---------------------------------------------------------- status
    // One value per thing worth waiting on. A script reads them from the
    // josi.status element, or in demo mode from state\app-status.json.
    static string state = "starting", screen = "", section = "", thread = "", turn = "idle", popup = "none", popupResult = "", pc = "off", auth = "signed-out", folders = "none", activity = "", setup = "", model = "", check = "";
    static bool busy, error;
    public static event Action Changed;
    static bool pending;
    static void Set<T>(ref T field, T value) where T : IEquatable<T> {
      if (field != null && field.Equals(value)) return;
      field = value;
      Raise();
    }
    /// "starting", "connecting", "ready" (signed in, workspace loaded), "resetting", "error".
    public static string State { get { return state; } set { Set(ref state, value ?? ""); } }
    public static string Screen { get { return screen; } set { Set(ref screen, value ?? ""); } }
    public static string Section { get { return section; } set { Set(ref section, value ?? ""); } }
    public static string Thread { get { return thread; } set { Set(ref thread, value ?? ""); } }
    /// "idle", "running" (a reply is being written), "done" (the reply sent from this app finished), "failed".
    public static string Turn { get { return turn; } set { Set(ref turn, value ?? ""); } }
    /// "none", or the kind of sheet open: "settings-change", "confirm", "message", "password", "add-folder", "sheet".
    public static string Popup { get { return popup; } set { Set(ref popup, value ?? ""); } }
    /// How the last popup ended: "settings-change:approved", "confirm:cancelled", and so on.
    public static string PopupResult { get { return popupResult; } set { Set(ref popupResult, value ?? ""); } }
    /// "off", "working", "paused", "takeover", "stopped".
    public static string Pc { get { return pc; } set { Set(ref pc, value ?? ""); } }
    public static string Auth { get { return auth; } set { Set(ref auth, value ?? ""); } }
    /// "none", "syncing", "synced".
    public static string Folders { get { return folders; } set { Set(ref folders, value ?? ""); } }
    public static string Activity { get { return activity; } set { Set(ref activity, value ?? ""); } }
    /// First-run setup: the step the server asks for ("host_checks", "owner", "domain", "llm", "smtp",
    /// "security", "telemetry", "review"), "recovery" while the Vault recovery key is shown,
    /// "done" when Finish Setup is the only thing left; empty outside the setup screen.
    public static string Setup { get { return setup; } set { Set(ref setup, value ?? ""); } }
    /// Demo mode: the name of the model configuration in use ("replay", "ollama", ...), set by --model.
    public static string ModelName { get { return model; } set { Set(ref model, value ?? ""); } }
    /// A model capability check: "running", "passed" or "failed"; empty when none has run.
    public static string Check { get { return check; } set { Set(ref check, value ?? ""); } }
    public static bool Busy { get { return busy; } set { if (busy == value) return; busy = value; Raise(); } }
    public static bool Error { get { return error; } set { if (error == value) return; error = value; Raise(); } }

    /// The whole status on one line: key=value pairs separated by semicolons.
    public static string Summary {
      get {
        return "state=" + state + ";screen=" + screen + ";section=" + section + ";thread=" + thread + ";turn=" + turn
          + ";popup=" + popup + ";popup-result=" + popupResult + ";pc=" + pc + ";auth=" + auth + ";folders=" + folders
          + ";busy=" + (busy ? "1" : "0") + ";error=" + (error ? "1" : "0") + ";setup=" + setup + ";model=" + model + ";check=" + check
          + ";activity=" + activity.Replace(";", ",");
      }
    }
    static void Raise() {
      // Several fields change together; tell listeners once, after the batch.
      if (pending) return;
      pending = true;
      var app = Application.Current;
      Action flush = () => {
        pending = false;
        var handler = Changed; if (handler != null) handler();
        if (Demo) WriteStatusFile();
      };
      if (app != null && !app.Dispatcher.CheckAccess()) app.Dispatcher.BeginInvoke(flush);
      else if (app != null) app.Dispatcher.BeginInvoke(flush, System.Windows.Threading.DispatcherPriority.Background);
      else flush();
    }
    static void WriteStatusFile() {
      if (string.IsNullOrEmpty(DemoRoot)) return;
      try {
        var folder = Path.Combine(DemoRoot, "state");
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, "app-status.json");
        var json = Wires.Serialize(Wires.O("state", state, "screen", screen, "section", section, "thread", thread, "turn", turn,
          "popup", popup, "popupResult", popupResult, "pc", pc, "auth", auth, "folders", folders, "busy", busy, "error", error,
          "setup", setup, "model", model, "check", check, "activity", activity, "summary", Summary, "updatedAt", DateTime.UtcNow.ToString("o"), "pid", Environment.ProcessId));
        var temporary = file + ".tmp";
        File.WriteAllText(temporary, json);
        File.Move(temporary, file, true);
      } catch (Exception) { /* the status file is a convenience for scripts */ }
    }

    // ------------------------------------------------------------ demo
    /// Demo mode: a separate launch (`--demo` or JOSI_DEMO=1) against the demo
    /// server in JOSI_DEMO_ROOT (default C:\Dev\josi-demo), created by
    /// scripts\windows\demo. It never opens the real data folder or the real
    /// sign-in; its settings, sessions and pipes carry their own instance name.
    public static bool Demo;
    public static string DemoRoot = "";
    public static Wire DemoConfig = Wire.Null;
    /// A fresh demo root (`--demo-fresh`, or "fresh": true in its demo.json): a server that has
    /// not been set up yet, so first-run setup itself can be recorded. The app opens on the
    /// Welcome screen and signs nobody in; a reset puts the server back to not set up.
    public static bool Fresh;
    /// Scene requests from the command line, applied once signed in.
    public static string OpenSection, OpenThread, PcBanner, ModelRequest;
    public static bool ResetRequested;

    public sealed class Launch {
      public bool Demo, Status, Reset, Help, Fresh;
      public string Root, Open, Thread, Pc, Model;
      public List<string> Rest = new List<string>();
    }
    /// Reads the automation flags and leaves the rest (josi:// links, --share) alone.
    public static Launch Parse(string[] args) {
      var launch = new Launch { Demo = Environment.GetEnvironmentVariable("JOSI_DEMO") == "1", Root = Environment.GetEnvironmentVariable("JOSI_DEMO_ROOT") };
      for (var i = 0; i < args.Length; i++) {
        var arg = args[i];
        var next = i + 1 < args.Length ? args[i + 1] : null;
        switch (arg) {
          case "--demo": launch.Demo = true; break;
          case "--demo-fresh": launch.Demo = true; launch.Fresh = true; break;
          case "--model": if (next != null) { launch.Demo = true; launch.Model = next; i++; } break;
          case "--demo-reset": case "--reset": launch.Demo = true; launch.Reset = true; break;
          case "--status": launch.Demo = true; launch.Status = true; break;
          case "--demo-root": if (next != null) { launch.Root = next; i++; } break;
          case "--open": if (next != null) { launch.Open = next; i++; } break;
          case "--thread": if (next != null) { launch.Thread = next; i++; } break;
          case "--pc-banner": if (next != null) { launch.Pc = next; i++; } break;
          case "--help": case "-h": case "/?": launch.Help = true; break;
          default: launch.Rest.Add(arg); break;
        }
      }
      if (string.IsNullOrEmpty(launch.Root)) launch.Root = @"C:\Dev\josi-demo";
      return launch;
    }

    /// Switches this process into demo mode. Called first thing in Main, before
    /// anything reads the data folder or the instance name.
    public static void Enable(Launch launch) {
      Demo = true;
      DemoRoot = Path.GetFullPath(launch.Root);
      OpenSection = launch.Open; OpenThread = launch.Thread; PcBanner = launch.Pc; ModelRequest = launch.Model; ResetRequested = launch.Reset;
      try { DemoConfig = Wires.Parse(File.ReadAllText(Path.Combine(DemoRoot, "demo.json"))); } catch (Exception) { DemoConfig = Wire.Null; }
      Fresh = launch.Fresh || DemoConfig["fresh"].Flag;
      var data = DemoConfig["dataDir"].Text.Length > 0 ? DemoConfig["dataDir"].Text : Path.Combine(DemoRoot, "data");
      // The demo server's data folder, never the development or installed one.
      Environment.SetEnvironmentVariable("JOSI_SERVER_DATA", data);
      // Its own instance: own mutex, pipes, settings file and remembered sign-in;
      // no josi:// or browser-host registration, no notifications, no browser.
      // A fresh root is a further instance, so its copy and the seeded demo's
      // copy never hand scene flags to each other.
      Environment.SetEnvironmentVariable("JOSI_TEST_INSTANCE", Fresh ? "DemoFresh" : "Demo");
      Environment.SetEnvironmentVariable("JOSI_TEST_NO_BROWSER", "1");
    }
    public static string DemoAddress { get { var a = DemoConfig["address"].Text; return a.Length > 0 ? a : "http://localhost:" + (DemoConfig["apiPort"].Integer > 0 ? DemoConfig["apiPort"].Integer : 8090); } }
    public static string DemoIdentifier { get { return DemoConfig["account"]["identifier"].Text; } }
    public static string DemoPassword { get { return DemoConfig["account"]["password"].Text; } }
    /// Window geometry: JOSI_DEMO_WINDOW=1280x800+40+40, demo.json "window", or the default.
    public static void PlaceWindow(Window window) {
      var spec = Environment.GetEnvironmentVariable("JOSI_DEMO_WINDOW");
      if (string.IsNullOrEmpty(spec)) spec = DemoConfig["window"].Text;
      var match = Regex.Match(spec ?? "", @"^(\d+)x(\d+)(?:\+(-?\d+)\+(-?\d+))?$");
      double width = 1280, height = 800, left = 40, top = 40;
      if (match.Success) {
        width = int.Parse(match.Groups[1].Value); height = int.Parse(match.Groups[2].Value);
        if (match.Groups[3].Success) { left = int.Parse(match.Groups[3].Value); top = int.Parse(match.Groups[4].Value); }
      }
      window.WindowStartupLocation = WindowStartupLocation.Manual;
      window.Width = width; window.Height = height; window.Left = left; window.Top = top;
    }

    /// A scene command for the running demo copy, carried over the links pipe.
    public static string Link(string command, string key = null, string value = null) {
      return "josi://demo/" + command + (key == null ? "" : "?" + key + "=" + Uri.EscapeDataString(value ?? ""));
    }
    public static bool IsDemoLink(string link) { return link != null && link.StartsWith("josi://demo/", StringComparison.OrdinalIgnoreCase); }

    /// Runs the demo reset (scripts\windows\demo\seed-demo.mjs --reset, or
    /// reset-fresh.mjs for a fresh root) and returns its output. The paths come
    /// from demo.json, written by the seed or by New-DemoServer.ps1.
    public static System.Threading.Tasks.Task<string> RunReset() {
      return System.Threading.Tasks.Task.Run(() => {
        var node = DemoConfig["node"].Text.Length > 0 ? DemoConfig["node"].Text : "node";
        var repo = DemoConfig["repo"].Text;
        if (repo.Length == 0) throw new JosiException("demo.json has no repository path; run the demo seed once.");
        var script = Path.Combine(repo, Fresh ? @"scripts\windows\demo\reset-fresh.mjs" : @"scripts\windows\demo\seed-demo.mjs");
        if (!File.Exists(script)) throw new JosiException("The demo reset script is missing: " + script);
        var info = new ProcessStartInfo(node) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true, WorkingDirectory = repo };
        info.ArgumentList.Add(script); info.ArgumentList.Add(DemoRoot); if (!Fresh) info.ArgumentList.Add("--reset");
        using (var process = Process.Start(info)) {
          var output = process.StandardOutput.ReadToEnd(); var errors = process.StandardError.ReadToEnd();
          if (!process.WaitForExit(240000)) { try { process.Kill(true); } catch (Exception) { } throw new JosiException("The demo reset did not finish in four minutes."); }
          if (process.ExitCode != 0) throw new JosiException("The demo reset failed: " + Tail(errors.Length > 0 ? errors : output));
          return output;
        }
      });
    }
    static string Tail(string text) { text = (text ?? "").Trim(); return text.Length > 400 ? text.Substring(text.Length - 400) : text; }

    // --------------------------------------------------- console output
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int processId);
    /// Prints to the console this copy was started from, for `--status`.
    public static void Print(string text) {
      try {
        AttachConsole(-1);
        using (var stream = Console.OpenStandardOutput())
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true }) writer.WriteLine(text);
      } catch (Exception) { }
    }
    /// The last status the running demo copy wrote, or a line saying it is not running.
    public static string ReadStatus(string root) {
      try {
        var file = Path.Combine(Path.GetFullPath(root), "state", "app-status.json");
        if (!File.Exists(file)) return "{\"state\":\"not-running\",\"summary\":\"state=not-running\"}";
        var status = Wires.Parse(File.ReadAllText(file));
        var pid = (int)status["pid"].Integer;
        var alive = false;
        try { using (var process = Process.GetProcessById(pid)) alive = !process.HasExited; } catch (Exception) { }
        if (!alive) return "{\"state\":\"not-running\",\"summary\":\"state=not-running\",\"last\":" + status.Json + "}";
        return status.Json;
      } catch (Exception) { return "{\"state\":\"unknown\",\"summary\":\"state=unknown\"}"; }
    }
    public const string Usage = "Josi automation flags:\n  --demo                 start in demo mode against JOSI_DEMO_ROOT (C:\\Dev\\josi-demo)\n  --demo-root <folder>   another demo root\n  --demo-fresh           a root whose server is not set up yet: open on Welcome, sign nobody in\n  --open <section>       open a sidebar section once signed in (chat, files, models, ...)\n  --thread <id|n|title>  open a conversation by id, position in the sidebar, or title\n  --pc-banner <state>    show the PC Control banner: working, paused, takeover, off\n  --model <name>         switch the primary model to a configuration named in demo.json (replay, ollama)\n  --demo-reset           restore the seeded demo state (reloads a running demo copy)\n  --status               print the running demo copy's status as JSON\nSee AUTOMATION.md.";
  }
}
