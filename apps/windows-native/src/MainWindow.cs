using System;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;

namespace Josi.Native {
  public static class Program {
    [STAThread]
    public static int Main(string[] args) {
      if (PcAdministrator.IsLaunch(args)) return PcAdministrator.Run(args);
      // Chrome starting Josi as the browser extension's native host.
      if (BrowserHost.IsLaunch(args)) return BrowserHost.Run();
      // The server starting the device-consent window on its own screen (item 29).
      if (ConsentHost.IsLaunch(args)) return ConsentHost.Run();
      // Automation flags (AUTOMATION.md): --demo, --demo-reset, --status, --open,
      // --thread, --pc-banner. Read before anything touches the data folder or
      // the instance name, because demo mode changes both.
      var launch = Automation.Parse(args);
      if (launch.Help) { Automation.Print(Automation.Usage); return 0; }
      if (launch.Status) { Automation.Print(Automation.ReadStatus(launch.Root)); return 0; }
      if (launch.Demo) { Automation.Enable(launch); args = launch.Rest.ToArray(); }
      bool created;
      // A josi:// link (Google sign-in returning) arrives as the only argument.
      var link = args.Length == 1 && AppLinks.IsLink(args[0]) ? args[0] : null;
      // Send to › Josi: "--share" followed by the chosen files.
      if (args.Length > 1 && args[0] == "--share") {
        var files = args.Skip(1).Where(p => System.IO.File.Exists(p)).Take(10).ToList();
        if (files.Count > 0) link = AppLinks.SharePrefix + string.Join("\n", files);
      }
      // Automated UI tests run beside a person's open copy without touching it.
      using (var single = new Mutex(true, @"Local\Josi.Native.Windows" + AppLinks.Instance, out created)) {
        if (!created) {
          if (link != null) AppLinks.Forward(link);
          // A demo copy is already open: hand it the scene and leave.
          if (Automation.Demo) { foreach (var scene in SceneLinks(launch)) AppLinks.Forward(scene); return 0; }
          if (!AppLinks.Testing) Activation.ActivateExisting();
          return 0;
        }
        // `--demo-reset` on its own, with no demo copy open: restore the seeded
        // state and leave without opening a window.
        if (Automation.Demo && launch.Reset && launch.Open == null && launch.Thread == null && launch.Pc == null) {
          try { Automation.Print(Automation.RunReset().GetAwaiter().GetResult()); return 0; }
          catch (JosiException e) { Automation.Print(e.Message); return 1; }
        }
        AppLinks.Register();
        Notifications.Register();
        SendTo.Register();
        if (Flags.LocalWorkspace) BrowserHost.Register();
        // Closing the window hides it in the tray; the app ends from Quit (OnClosing shuts down).
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        Ui.Load();
        app.Resources.MergedDictionaries.Add(Ui.Resources);
        app.DispatcherUnhandledException += (s, e) => {
          // Keep the app open with a visible error instead of losing unsaved
          // recovery material to an unexpected exception.
          e.Handled = true;
          var window = app.MainWindow as MainWindow;
          if (window != null) window.ShowError(AppModel.Friendly(e.Exception));
        };
        var main = new MainWindow();
        app.MainWindow = main;
        AppLinks.Listen(value => app.Dispatcher.BeginInvoke(new Action(() => main.ReceiveLink(value))));
        if (Flags.LocalWorkspace) BrowserBridge.Current.Start(main.Model, app.Dispatcher);
        main.Show();
        if (link != null) app.Dispatcher.BeginInvoke(new Action(() => main.ReceiveLink(link)));
        return app.Run();
      }
    }
    /// The scene a second `--demo` launch asked for, as links for the open copy.
    static System.Collections.Generic.IEnumerable<string> SceneLinks(Automation.Launch launch) {
      if (launch.Reset) yield return Automation.Link("reset");
      if (launch.Model != null) yield return Automation.Link("model", "name", launch.Model);
      if (launch.Open != null) yield return Automation.Link("open", "section", launch.Open);
      if (launch.Thread != null) yield return Automation.Link("thread", "value", launch.Thread);
      if (launch.Pc != null) yield return Automation.Link("pc", "state", launch.Pc);
    }
  }

  static class Activation {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string className, string title);
    public static void ActivateExisting() {
      var existing = FindWindow(null, "Josi");
      if (existing != IntPtr.Zero) { ShowWindow(existing, 9); SetForegroundWindow(existing); }
    }
  }

  public sealed class MainWindow : Window {
    public readonly AppModel Model = new AppModel();
    readonly ContentControl content = new ContentControl { Focusable = false };
    readonly Border errorBar = new Border();
    readonly Border busyBar = new Border();
    readonly Border controlBar = new Border { Visibility = Visibility.Collapsed };
    PcControlOverlay controlOverlay;
    // One line of machine-readable state for automation (AUTOMATION.md):
    // invisible to a person, readable through UI Automation as josi.status.
    readonly TextBlock statusLine = new TextBlock { FontSize = 1, Height = 1, Foreground = Brushes.Transparent, IsHitTestVisible = false, Focusable = false };
    Screen? shown;
    WorkspaceView workspace;
    Tray tray; bool quitting;
    // Demo mode: a scripted PC Control banner (--pc-banner) and "stopped" after Stop Josi.
    string demoPc; bool pcStopped;
    /// Brings the window back from the tray.
    public void Reopen() { Show(); if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Activate(); }
    /// Really closes: the tray's Quit, or a closing with Shift held.
    public void Quit() { quitting = true; Close(); }

    /// Who is in control of this desktop: Josi working (with Pause and Stop),
    /// paused, or you after touching the mouse or keyboard (until Resume). Hidden when nothing is happening.
    void RenderControlBar() {
      var executor = DesktopExecutor.Current;
      var takenOver = executor.TakenOver;
      var scripted = Automation.Demo ? demoPc : null;
      var paused = scripted != null ? scripted == "paused" : executor.Paused;
      var working = scripted != null ? scripted == "working" : executor.Busy || PcTerminals.Count > 0;
      if (scripted != null) takenOver = scripted == "takeover";
      if (executor.Busy && !executor.Paused && !executor.PendingStop) pcStopped = false;
      var stopped = pcStopped || executor.PendingStop;
      // Only while something is happening on the screen: a paused or stopped
      // Josi takes no room. Resume lives in PC Control, the chat cards and the tray.
      var show = working || takenOver;
      tray?.Update(paused, working);
      Automation.Pc = stopped ? "stopped" : !show ? "off" : paused ? "paused" : takenOver ? "takeover" : working ? "working" : "ready";
      if (controlOverlay != null) controlOverlay.Stopped = stopped;
      controlOverlay?.Update(show, working, paused, takenOver, scripted != null || executor.ScreenControl, executor.Busy ? executor.Activity : PcTerminals.Count > 0 ? PcTerminals.Count + " terminal session(s) running" : executor.Activity);
      if (!show) { controlBar.Visibility = Visibility.Collapsed; controlBar.Child = null; return; }
      Action pause = () => { if (scripted != null) { demoPc = "paused"; RenderControlBar(); } else executor.Pause(); };
      Action resume = () => { pcStopped = false; if (scripted != null) { demoPc = "working"; RenderControlBar(); } else executor.Resume(); };
      Automation.BeginScope("pc-control");
      UIElement status; var actions = Ui.Wrap(); string sentence;
      if (stopped) {
        sentence = "PC control is stopped. You are in control.";
        status = Ui.Row(10, Ui.Icon(Glyph.Desktop, 15, Ui.Accent), Ui.T(sentence, 13.5, FontWeights.Medium));
      } else if (paused) {
        sentence = "Josi is paused on this PC.";
        status = Ui.Row(10, Ui.Icon(Glyph.Desktop, 15, Ui.Accent), Ui.T(sentence, 13.5, FontWeights.Medium));
        actions.Children.Add(Automation.Id(Ui.Pill("Resume", resume, true), "josi.pc-control.resume"));
      } else if (takenOver) {
        sentence = "You are in control. Josi waits until you choose Resume.";
        status = Ui.Row(10, Ui.Icon(Glyph.Desktop, 15, Ui.Accent), Ui.T(sentence, 13.5, FontWeights.Medium));
        actions.Children.Add(Automation.Id(Ui.Pill("Resume", resume), "josi.pc-control.continue"));
        actions.Children.Add(Automation.Id(Ui.Pill("Pause Josi", pause), "josi.pc-control.pause"));
      } else if (!working) {
        sentence = "Josi is ready. You are in control.";
        status = Ui.T(sentence, 13.5, FontWeights.Medium);
      } else {
        sentence = "Josi is using this PC: " + (scripted != null ? "demo activity" : executor.Activity) + ". Move the mouse or type to take over.";
        status = Ui.Working(sentence, true, 20);
        actions.Children.Add(Automation.Id(Ui.Pill("Pause", pause), "josi.pc-control.pause"));
      }
      actions.Children.Add(Automation.Id(Ui.Danger("Stop Josi", () => {
        StopPcControl();
      }), "josi.pc-control.stop"));
      controlBar.Child = Automation.Group("josi.pc-control.banner", sentence, Ui.Spread(status, actions));
      controlBar.Padding = new Thickness(16, 8, 16, 8); controlBar.Background = Ui.AccentFaint;
      controlBar.BorderBrush = Ui.Accent; controlBar.BorderThickness = new Thickness(0, 0, 0, 1);
      controlBar.Visibility = Visibility.Visible;
    }

    void StopPcControl() {
      pcStopped = true;
      if (Automation.Demo && demoPc != null) { demoPc = "stopped"; RenderControlBar(); return; }
      // Local cancellation is synchronous and never waits for the network.
      DesktopExecutor.Current.Stop();
      Model.Run(async () => { var api = Model.Api; if (api != null) { await api.Request("/admin/pc-control/stop", "POST", Wires.O()); DesktopExecutor.Current.StopAcknowledged(); } });
    }

    public MainWindow() {
      Title = "Josi";
      Width = 1160; Height = 800; MinWidth = 920; MinHeight = 660;
      WindowStartupLocation = WindowStartupLocation.CenterScreen;
      Background = Ui.Backdrop; Foreground = Ui.Text;
      FontFamily = Ui.Font; FontSize = 14;
      UseLayoutRounding = true;
      TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
      using (var stream = typeof(MainWindow).Assembly.GetManifestResourceStream("Josi.ico"))
        if (stream != null) Icon = System.Windows.Media.Imaging.BitmapFrame.Create(stream, System.Windows.Media.Imaging.BitmapCreateOptions.None, System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);

      if (Automation.Demo) Automation.PlaceWindow(this);
      Automation.Id(this, "josi.main", "Josi");
      Automation.Id(statusLine, "josi.status", "Josi status");
      Automation.Id(content, "josi.content");

      var dock = new DockPanel { LastChildFill = true };
      DockPanel.SetDock(busyBar, Dock.Bottom); DockPanel.SetDock(errorBar, Dock.Bottom); DockPanel.SetDock(controlBar, Dock.Top); DockPanel.SetDock(statusLine, Dock.Bottom);
      dock.Children.Add(controlBar); dock.Children.Add(busyBar); dock.Children.Add(errorBar); dock.Children.Add(statusLine); dock.Children.Add(content);
      var root = new Grid();
      root.Children.Add(new Stars()); root.Children.Add(dock);
      Content = root;
      if (Flags.LocalWorkspace) DesktopExecutor.Current.Start(Dispatcher);
      DesktopExecutor.Current.Changed += RenderControlBar;
      PcTerminals.Changed += () => Dispatcher.BeginInvoke(new Action(RenderControlBar));
      if (Flags.LocalWorkspace) controlOverlay = new PcControlOverlay(
        () => { if (Automation.Demo && demoPc != null) { demoPc = "takeover"; RenderControlBar(); } else DesktopExecutor.Current.TakeOver(); },
        () => { if (Automation.Demo && demoPc != null) { demoPc = "paused"; RenderControlBar(); } else DesktopExecutor.Current.Pause(); },
        () => { pcStopped = false; if (Automation.Demo && demoPc != null) { demoPc = "working"; RenderControlBar(); } else DesktopExecutor.Current.Resume(); },
        StopPcControl, () => { Show(); WindowState = WindowState.Normal; Activate(); Model.Section = "chat"; workspace?.Go("chat"); });
      Automation.Changed += () => { statusLine.Text = Automation.Summary; System.Windows.Automation.AutomationProperties.SetName(statusLine, Automation.Summary); };
      if (!Automation.Demo && !AppLinks.Testing) tray = new Tray(Reopen, () => { pcStopped = false; DesktopExecutor.Current.Resume(); }, Quit);

      Model.Attach(this);
      Model.Changed += Render;
      Model.WorkspaceChanged += UpdateStatus;
      Model.SectionChanged += UpdateStatus;
      // A settings change Josi prepared: ask here, in front of whatever is open.
      Model.SettingsChangeProposed += proposal => Dispatcher.BeginInvoke(new Action(() => {
        if (Model.Screen == Screen.Workspace) Dialogs.SettingsChange(this, Model, proposal);
      }), System.Windows.Threading.DispatcherPriority.Background);
      InputBindings.Add(new KeyBinding(new Command(() => {
        if (Model.Screen == Screen.Workspace && !Model.Busy) Model.Run(() => Model.NewThread());
      }), Key.N, ModifierKeys.Control));
      SourceInitialized += delegate {
        DarkTitleBar();
        // A second launch (or anything else) that shows the hidden window through
        // Win32 would leave WPF believing it is hidden: an unpainted black frame.
        // Reopen it the WPF way as soon as such a show arrives.
        var source = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
        if (source != null) source.AddHook((IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled) => {
          if (msg == 0x0018 && wParam != IntPtr.Zero && Visibility != Visibility.Visible) Dispatcher.BeginInvoke(new Action(Reopen));
          return IntPtr.Zero;
        });
      };
      Loaded += delegate { Model.Ghost.Set(GhostState.Hello); };
      Model.RefreshLocal();
      Render();
      // A remembered sign-in opens the server on this PC straight away, once
      // the window runs (requests must resume on its thread).
      var r = Model.Receipt;
      if (Automation.Demo) Loaded += delegate { StartDemo(); };
      else if (Flags.ServerApp && r.Installed && r.Running && r.Address.Length > 0 && SessionStore.Load(r.Address) != null)
        Loaded += delegate { if (Model.Screen == Screen.Connect) Model.Run(() => Model.Connect(r.Address, true)); };
      else if (Flags.Relay) {
        var paired = TunnelStore.Current.All().FirstOrDefault(p => SessionStore.Load(p.Origin) != null);
        if (paired != null) Loaded += delegate { if (Model.Screen == Screen.Connect) Model.Run(() => Model.ConnectPaired(paired)); };
      }
    }

    public void ShowError(string message) { Model.Error = message; Model.Busy = false; Render(); }

    // ------------------------------------------------------------ status
    /// Reads the model into the automation status values (AUTOMATION.md).
    void UpdateStatus() {
      Automation.Screen = Model.Screen.ToString().ToLowerInvariant();
      Automation.Section = Model.Screen == Screen.Workspace ? Model.Section : "";
      Automation.Thread = Model.SelectedThread ?? "";
      Automation.Auth = Model.Screen == Screen.Workspace ? "signed-in" : "signed-out";
      Automation.Busy = Model.Busy; Automation.Error = Model.Error.Length > 0; Automation.Activity = Model.Activity ?? "";
      var turn = "idle";
      if (Model.PendingMessage || Model.Turns.Any(t => t["status"].Text == "queued" || t["status"].Text == "running")) turn = "running";
      else if (Model.LastAcceptedTurnId != null) {
        var last = Model.Turns.FirstOrDefault(t => t.Id == Model.LastAcceptedTurnId);
        if (last != null) turn = last["status"].Text == "failed" ? "failed" : last["status"].Text == "completed" ? "done" : "running";
      }
      Automation.Turn = turn;
      Automation.Setup = Model.Screen != Screen.Setup ? "" : !Model.Recovery.IsNull ? "recovery"
        : Model.SetupState.IsNull ? "" : Model.SetupState["nextStep"].Text.Length > 0 ? Model.SetupState["nextStep"].Text : "done";
      if (Automation.State != "resetting" && Automation.State != "error")
        Automation.State = Model.Screen == Screen.Workspace ? (Model.LastRefreshed.HasValue && !Model.Busy ? "ready" : "loading") : Model.Busy ? "connecting" : "waiting";
    }

    // -------------------------------------------------------------- demo
    /// Demo mode opens straight into the seeded workspace: connect to the demo
    /// server, sign in with the demo account from demo.json, then apply any
    /// scene the command line asked for.
    async void StartDemo() {
      Automation.State = "connecting";
      if (Automation.ResetRequested) { Automation.ResetRequested = false; await ResetDemo(); }
      if (Automation.Fresh) {
        // A server that is not set up yet: stay on Welcome, where "Set Up on This
        // PC" opens first-run setup. A sign-in remembered from an earlier take
        // must not skip it.
        try { SessionStore.Forget(new Uri(Automation.DemoAddress).GetLeftPart(UriPartial.Authority)); } catch (Exception) { }
        Automation.State = "waiting"; UpdateStatus();
        return;
      }
      if (Model.Screen != Screen.Workspace) {
        await Model.RunTask(async () => {
          Model.Activity = "Opening the demo…";
          try {
            if (Model.Screen == Screen.Connect) await Model.Connect(Automation.DemoAddress, true);
            if (Model.Screen == Screen.Login) {
              var who = Automation.DemoIdentifier; var secret = Automation.DemoPassword;
              if (who.Length == 0 || secret.Length == 0) throw new JosiException("demo.json has no demo account yet. Run scripts\\windows\\demo\\Start-DemoServer.ps1, which seeds the demo.");
              await Model.SignIn(who, secret);
            }
          } finally { Model.Activity = ""; }
        });
      }
      if (Model.Screen == Screen.Workspace) await ApplyScene();
      else { Automation.State = "error"; UpdateStatus(); }
    }
    /// Opens the section, conversation and banner state the command line or a
    /// josi://demo link asked for. Nothing to do when none was asked.
    async System.Threading.Tasks.Task ApplyScene() {
      var section = Automation.OpenSection; var thread = Automation.OpenThread; var pc = Automation.PcBanner; var modelName = Automation.ModelRequest;
      Automation.OpenSection = Automation.OpenThread = Automation.PcBanner = Automation.ModelRequest = null;
      if (pc != null) { demoPc = pc == "off" ? null : pc; if (pc == "off") pcStopped = false; RenderControlBar(); }
      if (modelName != null) await Model.RunTask(() => SwitchDemoModel(modelName));
      if (thread != null) {
        var id = FindThread(thread);
        if (id != null) await Model.RunTask(() => Model.SelectThread(id));
        else { Model.Error = "No conversation matches \"" + thread + "\"."; Model.Notify(); }
      }
      if (section != null && workspace != null) workspace.Go(section);
    }
    /// Demo mode: makes the primary model the configuration demo.json names
    /// under "models" (for example "replay" for the canned replies and "ollama"
    /// for a real local model), saved and checked through the ordinary
    /// administrator routes. The status reads model=<name> once it is in use.
    async System.Threading.Tasks.Task SwitchDemoModel(string name) {
      var spec = Automation.DemoConfig["models"][name];
      if (spec.IsNull) throw new JosiException("demo.json names no model configuration \"" + name + "\" under \"models\".");
      var api = Model.Api; if (api == null) return;
      Model.Activity = "Switching the model to " + name + "…"; Model.Notify();
      Automation.Check = "running";
      try {
        var body = Wires.O("provider", spec["provider"].Text, "baseUrl", spec["baseUrl"].Text, "model", spec["model"].Text,
          "externalAcknowledged", spec["externalAcknowledged"].Flag);
        foreach (var pair in (System.Collections.Generic.Dictionary<string, object>)(spec["fields"].IsNull ? new System.Collections.Generic.Dictionary<string, object>() : spec["fields"].Raw)) body[pair.Key] = pair.Value;
        await api.Request("/admin/llm/providers/primary", "PUT", body);
        var result = await api.Request("/admin/llm/providers/primary/probe", "POST", Wires.O());
        var passed = result["provider"]["active"].Flag || result["passed"].Flag;
        Automation.Check = passed ? "passed" : "failed";
        if (!passed) throw new JosiException("The model \"" + name + "\" did not pass its capability check: " + result["result"]["fatal"].Text);
        Automation.ModelName = name;
      } catch (Exception) { if (Automation.Check == "running") Automation.Check = "failed"; throw; }
      finally { Model.Activity = ""; }
      if (workspace != null && Model.Section == "models") workspace.Go("models");
    }
    /// A conversation by id, by 1-based position in the sidebar, or by part of its title.
    string FindThread(string value) {
      if (Wires.IsUuid(value)) return Model.Threads.Any(t => t.Id == value) ? value : null;
      int index;
      if (int.TryParse(value, out index) && index >= 1 && index <= Model.Threads.Count) return Model.Threads[index - 1].Id;
      var match = Model.Threads.FirstOrDefault(t => t["title"].Text.IndexOf(value, StringComparison.CurrentCultureIgnoreCase) >= 0);
      return match == null ? null : match.Id;
    }
    /// Restores the seeded demo state (scripts\windows\demo\seed-demo.mjs --reset)
    /// and reloads the workspace, without restarting the server or this app.
    async System.Threading.Tasks.Task ResetDemo() {
      Automation.State = "resetting";
      // A sheet left open by the last take (a model setup half done, a popup) is not part
      // of the seeded state: close it before the workspace reloads.
      foreach (var owned in OwnedWindows.Cast<Window>().ToList()) { try { owned.Close(); } catch (Exception) { } }
      await Model.RunTask(async () => {
        Model.Activity = "Resetting the demo…"; Model.Notify();
        try { await Automation.RunReset(); } finally { Model.Activity = ""; }
        if (Model.Screen == Screen.Workspace) {
          Model.SelectedThread = null; Model.Messages.Clear(); Model.Turns.Clear(); Model.LastAcceptedTurnId = null; Model.Draft = "";
          Model.Section = "chat";
          await Model.ReloadWorkspace();
        }
      });
      Automation.PopupResult = ""; Automation.Folders = "none"; Automation.ModelName = ""; Automation.Check = ""; demoPc = null; pcStopped = false; RenderControlBar();
      if (Automation.Fresh && Model.Screen != Screen.Connect) Model.Disconnect();
      Automation.State = Automation.Fresh ? "waiting" : "loading"; UpdateStatus();
    }
    void HandleDemoLink(string link) {
      Uri uri; if (!Uri.TryCreate(link, UriKind.Absolute, out uri)) return;
      var value = uri.Query.Length > 1 ? Uri.UnescapeDataString(uri.Query.Substring(uri.Query.IndexOf('=') + 1)) : "";
      switch (uri.AbsolutePath) {
        case "/reset": Automation.ResetRequested = true; break;
        case "/model": Automation.ModelRequest = value; break;
        case "/open": Automation.OpenSection = value; break;
        case "/thread": Automation.OpenThread = value; break;
        case "/pc": Automation.PcBanner = value; break;
        default: return;
      }
      if (Model.Busy) return;
      if (Automation.Fresh) {
        // A fresh root has no workspace to apply scenes to; only a reset applies.
        if (Automation.ResetRequested) { Automation.ResetRequested = false; var _ = ResetDemo(); }
        return;
      }
      if (Model.Screen == Screen.Workspace) {
        if (Automation.ResetRequested) { Automation.ResetRequested = false; var _ = ResetDemo().ContinueWith(t => Dispatcher.BeginInvoke(new Action(() => { var __ = ApplyScene(); }))); }
        else { var _ = ApplyScene(); }
      }
    }

    /// A josi:// link from the browser: Google sign-in returning.
    public void ReceiveLink(string link) {
      // Scene commands for the demo copy (AUTOMATION.md); ignored outside demo mode.
      if (Automation.IsDemoLink(link)) { if (Automation.Demo) HandleDemoLink(link); return; }
      if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
      Activate();
      if (link.StartsWith(AppLinks.SharePrefix, StringComparison.Ordinal)) Model.Share(link.Substring(AppLinks.SharePrefix.Length).Split('\n').ToList());
      else if (link.StartsWith("josi://open", StringComparison.OrdinalIgnoreCase)) return;
      else if (link.StartsWith("josi://connections/", StringComparison.OrdinalIgnoreCase)) Model.Run(() => Model.CompleteConnection(link));
      else Model.Run(() => Model.CompleteGoogle(link));
    }

    void Render() {
      if (shown != Model.Screen) {
        shown = Model.Screen;
        if (Model.Screen != Screen.Workspace && workspace != null) { workspace.Detach(); workspace = null; }
        switch (Model.Screen) {
          case Screen.Login: content.Content = new LoginView(Model, this); break;
          case Screen.Setup: content.Content = new SetupView(Model, this); break;
          case Screen.Workspace: workspace = new WorkspaceView(Model, this); content.Content = workspace; break;
          default: content.Content = new ConnectView(Model, this); break;
        }
      } else {
        var refreshable = content.Content as IRefresh;
        if (refreshable != null) refreshable.Refresh();
      }
      RenderBars();
      UpdateStatus();
      Dialogs.ShowRecoveryIfNeeded(this, Model);
    }

    void RenderBars() {
      if (Model.Error.Length > 0) {
        Automation.BeginScope("error");
        var close = Automation.Id(Ui.IconButton(Glyph.Close, "Dismiss", () => { Model.Error = ""; RenderBars(); UpdateStatus(); }, 12), "josi.error.dismiss");
        var text = Automation.Id(Ui.Copyable(Model.Error), "josi.error.text");
        var row = Automation.Group("josi.error", Model.Error, Ui.Spread(Ui.Row(10, Ui.Icon(Glyph.Warning, 15, Ui.Error), text), close));
        errorBar.Child = row; errorBar.Padding = new Thickness(14, 10, 14, 10);
        errorBar.Background = Skin.Solid(Skin.Current.Error, 0x24);
        errorBar.Visibility = Visibility.Visible;
        System.Windows.Automation.AutomationProperties.SetLiveSetting(errorBar, System.Windows.Automation.AutomationLiveSetting.Assertive);
      } else errorBar.Visibility = Visibility.Collapsed;
      if (Model.Busy) {
        // One live indicator for every wait: the J, the sentence, and a clock
        // so a long request reads as working rather than stuck.
        var working = busyBar.Child as WorkingIndicator;
        if (working == null) { working = Automation.Id(Ui.Working(Model.Activity.Length == 0 ? "Working…" : Model.Activity, true, 20), "josi.busy"); busyBar.Child = working; }
        else working.Text = Model.Activity.Length == 0 ? "Working…" : Model.Activity;
        busyBar.Padding = new Thickness(16, 9, 16, 9); busyBar.Background = Ui.Sidebar;
        busyBar.Visibility = Visibility.Visible;
      } else { busyBar.Visibility = Visibility.Collapsed; busyBar.Child = null; }
    }

    protected override void OnClosing(CancelEventArgs e) {
      // The X puts Josi in the tray: PC control, terminals and notifications
      // keep working, and other devices keep being answered. Quit is in the
      // tray menu (or Shift while closing). Demo and test copies close for real.
      if (!quitting && tray != null && !Automation.Demo && !AppLinks.Testing && (Keyboard.Modifiers & ModifierKeys.Shift) == 0) {
        e.Cancel = true; Hide(); tray.SayHidden(); return;
      }
      if (Model.RecoveryPending) {
        Dialogs.Message(this, "Save your recovery information before closing.", "Finish the recovery step in Josi so you keep access to your account and Vault.");
        e.Cancel = true; return;
      }
      if (Model.Busy) {
        Dialogs.Message(this, "Let the current operation finish.", "Josi is applying your request. Server changes may still be running.");
        e.Cancel = true; return;
      }
      // Closing the window never stops a server on this PC; it keeps serving
      // other devices until stopped from Server.
      DesktopExecutor.Current.Pause();
      DesktopExecutor.Current.Changed -= RenderControlBar;
      controlOverlay?.Dispose();
      if (workspace != null) workspace.Detach();
      if (Model.Api != null) Model.Api.Dispose();
      tray?.Dispose(); tray = null;
      base.OnClosing(e);
      System.Windows.Application.Current?.Shutdown();
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    void DarkTitleBar() {
      var handle = new WindowInteropHelper(this).Handle;
      var on = 1;
      DwmSetWindowAttribute(handle, 20, ref on, sizeof(int));        // immersive dark mode
      var caption = Skin.ColorRef(Skin.Current.Deep);
      DwmSetWindowAttribute(handle, 35, ref caption, sizeof(int));    // caption color (Windows 11)
      var text = Skin.ColorRef(Skin.Current.Text);
      DwmSetWindowAttribute(handle, 36, ref text, sizeof(int));       // caption text color
    }
  }

  public interface IRefresh { void Refresh(); }

  public sealed class Command : ICommand {
    readonly Action action;
    public Command(Action action) { this.action = action; }
    public event EventHandler CanExecuteChanged { add { } remove { } }
    public bool CanExecute(object parameter) { return true; }
    public void Execute(object parameter) { action(); }
  }
}
