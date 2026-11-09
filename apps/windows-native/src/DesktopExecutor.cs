using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Threading;

namespace Josi.Native {
  /// Josi's hands on this PC's desktop: the windows of your Windows session,
  /// read through Windows UI Automation, pictured with screenshots, and
  /// operated with clicks, typing and keys. Every request arrives already
  /// decided by the server's PC Control (your permissions or your approval),
  /// scoped to one exact program; this executor re-checks that the window
  /// still belongs to that program before touching it. Your own mouse or
  /// keyboard stops screen control until the person explicitly resumes.
  sealed class DesktopExecutor {
    public static readonly DesktopExecutor Current = new DesktopExecutor();
    const int MaxElements = 400, MaxDepth = 16, ScreenshotBase64Limit = 131072;

    sealed class Observation {
      public IntPtr Window; public string Application; public DateTime At;
      public long Tick; public Rect Bounds; public uint Process, Dpi;
      public readonly Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
    }
    readonly object gate = new object();
    readonly object persistenceGate = new object();
    readonly Dictionary<string, Observation> observations = new Dictionary<string, Observation>();
    Dispatcher ui;
    CancellationTokenSource running; bool runningOnScreen;
    bool takenOver;
    bool paused;
    bool pendingStop;
    public bool PendingStop { get { lock (gate) return pendingStop; } }
    string stateFile;

    // --------------------------------------------------------------- state
    /// What Josi is doing on the desktop right now, for the control banner.
    public bool Busy { get; private set; }
    public string Activity { get; private set; } = "";
    public bool Paused { get { lock (gate) return paused; } }
    public bool TakenOver { get { lock (gate) return takenOver; } }
    public bool ScreenControl { get { lock (gate) return runningOnScreen && !paused && !takenOver; } }
    public event Action Changed;
    void Raise() { var u = ui; if (u != null) u.BeginInvoke(new Action(() => Changed?.Invoke())); }

    public void Start(Dispatcher dispatcher, string localStateFile = null) {
      ui = dispatcher;
      stateFile = localStateFile ?? Path.Combine(AppLinks.StateDirectory, "pc-control-pause" + AppLinks.Instance + ".json");
      try {
        if (File.Exists(stateFile)) {
          var stored = Wires.Parse(File.ReadAllText(stateFile));
          lock (gate) { paused = !stored["paused"].IsBool || stored["paused"].Flag; takenOver = !stored["takenOver"].IsBool || stored["takenOver"].Flag; pendingStop = stored["pendingStop"].Flag; }
        }
      } catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is System.Text.Json.JsonException) { paused = true; }
      Raise();
      Microsoft.Win32.SystemEvents.SessionSwitch += (_, e) => { if (e.Reason == Microsoft.Win32.SessionSwitchReason.SessionLock || e.Reason == Microsoft.Win32.SessionSwitchReason.RemoteDisconnect || e.Reason == Microsoft.Win32.SessionSwitchReason.ConsoleDisconnect) Pause(); };
    }
    void SavePause() {
      if (stateFile == null) return;
      lock (persistenceGate) {
      string json;
      lock (gate) json = Wires.Serialize(Wires.O("paused", paused, "takenOver", takenOver, "pendingStop", pendingStop));
      Directory.CreateDirectory(Path.GetDirectoryName(stateFile));
      var temporary = stateFile + ".tmp";
      File.WriteAllText(temporary, json);
      File.Move(temporary, stateFile, true);
      }
    }
    public void Pause() { lock (gate) { paused = true; observations.Clear(); } CancelCurrent("paused"); PcTerminals.StopAll(); Raise(); SavePause(); }
    /// Ends the current work because the app is leaving (quit, or a newer copy
    /// taking over) without remembering a pause: the next copy starts ready.
    /// Only a pause the person chose, a lock or a Stop survives a restart.
    public void PauseForExit() { lock (gate) { paused = true; observations.Clear(); } CancelCurrent("paused"); PcTerminals.StopAll(); }
    public void Resume() {
      if (PendingStop) { Raise(); return; }
      lock (gate) { paused = false; takenOver = false; }
      try { SavePause(); } catch { lock (gate) paused = true; Raise(); throw; }
      Raise();
    }
    public void Stop() { lock (gate) pendingStop = true; Pause(); }
    public void StopAcknowledged() { lock (gate) pendingStop = false; SavePause(); Raise(); }
    /// True when Josi may not act on the desktop at this moment.
    public bool Blocked { get { lock (gate) return paused || takenOver; } }

    // ---------------------------------------------------- human takeover
    // Low-level hooks see every mouse and keyboard event before the programs
    // do, and flag events Josi itself injected, so a real person moving the
    // mouse or typing is unmistakable: the current action is cancelled and
    // the desktop stays under human control until an explicit Resume.
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    HookProc keyboardHook, mouseHook; IntPtr keyboardHandle, mouseHandle; int engaged;
    Point lastMouse;
    void Engage() {
      var u = ui; if (u == null) return;
      u.Invoke(new Action(() => {
        if (keyboardHandle != IntPtr.Zero && mouseHandle != IntPtr.Zero) return;
        keyboardHook = KeyboardProc; mouseHook = MouseProc;
        var module = GetModuleHandle(null);
        keyboardHandle = SetWindowsHookEx(13, keyboardHook, module, 0);
        mouseHandle = SetWindowsHookEx(14, mouseHook, module, 0);
        GetCursorPos(out lastMouse);
        if (keyboardHandle == IntPtr.Zero || mouseHandle == IntPtr.Zero) {
          if (keyboardHandle != IntPtr.Zero) UnhookWindowsHookEx(keyboardHandle);
          if (mouseHandle != IntPtr.Zero) UnhookWindowsHookEx(mouseHandle);
          keyboardHandle = mouseHandle = IntPtr.Zero;
          throw new InvalidOperationException("Human takeover hooks are unavailable.");
        }
      }));
    }
    void Disengage() {
      var u = ui; if (u == null) return;
      u.Invoke(new Action(() => {
        if (keyboardHandle != IntPtr.Zero) { UnhookWindowsHookEx(keyboardHandle); keyboardHandle = IntPtr.Zero; }
        if (mouseHandle != IntPtr.Zero) { UnhookWindowsHookEx(mouseHandle); mouseHandle = IntPtr.Zero; }
      }));
    }
    IntPtr KeyboardProc(int code, IntPtr wParam, IntPtr lParam) {
      if (code >= 0 && (wParam.ToInt64() == 0x100 || wParam.ToInt64() == 0x104)) {
        var flags = Marshal.ReadInt32(lParam, 8);
        if ((flags & 0x10) == 0) Takeover("keyboard");
      }
      return CallNextHookEx(keyboardHandle, code, wParam, lParam);
    }
    IntPtr MouseProc(int code, IntPtr wParam, IntPtr lParam) {
      if (code >= 0) {
        var x = Marshal.ReadInt32(lParam, 0); var y = Marshal.ReadInt32(lParam, 4); var flags = Marshal.ReadInt32(lParam, 12);
        var message = wParam.ToInt64();
        if ((flags & 0x1) == 0) {
          var moved = Math.Abs(x - lastMouse.X) + Math.Abs(y - lastMouse.Y) > 8;
          // Ignore button release: releasing Resume must not pause it again.
          if ((message == 0x200 && moved) || message == 0x201 || message == 0x204 || message == 0x207 || message == 0x20B || message == 0x20A || message == 0x20E) Takeover("mouse");
        }
        lastMouse = new Point(x, y);
      }
      return CallNextHookEx(mouseHandle, code, wParam, lParam);
    }
    public void TakeOver() { Takeover("button"); }
    void Takeover(string by) {
      bool fresh;
      lock (gate) { fresh = !takenOver; takenOver = true; }
      CancelCurrent("human_control");
      if (fresh) {
        Raise();
        // Never do disk I/O inside the low-level input hook.
        var u = ui; if (u != null) u.BeginInvoke(new Action(SavePause));
      }
    }
    void CancelCurrent(string reason) {
      CancellationTokenSource current; bool onScreen;
      lock (gate) { current = running; onScreen = runningOnScreen; }
      // A takeover (your mouse or keyboard) only interrupts work on the screen; Pause ends anything.
      if (current == null || (reason == "human_control" && !onScreen)) return;
      try { current.Cancel(); } catch (ObjectDisposedException) { }
    }

    // ------------------------------------------------------------ requests
    /// One approved PC Control request whose payload kind starts with "desktop.".
    public async Task<Tuple<bool, object>> Run(Wire request) {
      var payload = request["payload"]; var scope = request["requirements"].List.Select(r => r["scope"]).FirstOrDefault() ?? Wire.Null;
      var kind = payload["kind"].Text; var requestId = request.Id;
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      // Your mouse and keyboard only stop work on the screen. A command, a file
      // or a lookup keeps going while you use the PC; Pause and Stop end those too.
      var screen = TouchesScreen(kind);
      if (Paused || (screen && Blocked)) return refuse(Paused ? "paused" : "human_control");
      var cancel = new CancellationTokenSource();
      lock (gate) { running = cancel; runningOnScreen = screen; }
      Busy = true; Activity = Describe(kind, scope, payload);
      var hooked = false;
      try {
        if (ui == null || ui.HasShutdownStarted) return refuse("control_surface_unavailable");
        // The native status and local Stop must be visible before input starts.
        ui.Invoke(new Action(() => Changed?.Invoke()));
        if (screen) { Interlocked.Increment(ref engaged); hooked = true; Engage(); }
        if (Paused || (screen && Blocked)) return refuse(Paused ? "paused" : "human_control");
        cancel.Token.ThrowIfCancellationRequested();
        var result = kind == "desktop.admin.command" ? await PcAdministrator.Execute(request, cancel.Token) : await Task.Run(() => Perform(kind, requestId, payload, scope, cancel.Token));
        return result;
      } catch (OperationCanceledException) { return refuse(Paused ? "paused" : "human_control"); }
      catch (ElementNotAvailableException) { return refuse("element_gone"); }
      catch (Exception e) when (e is InvalidOperationException || e is COMException || e is Win32Exception || e is IOException || e is UnauthorizedAccessException || e is NotSupportedException || e is System.Security.SecurityException) {
        return Tuple.Create(false, (object)Wires.O("code", "desktop_action_failed", "detail", e.GetType().Name));
      } finally {
        lock (gate) if (running == cancel) { running = null; runningOnScreen = false; }
        cancel.Dispose();
        Busy = false; Activity = ""; Raise();
        // Keep the hooks a moment longer: the next request usually follows at once.
        if (hooked) _ = Task.Delay(45000).ContinueWith(_ => { if (Interlocked.Decrement(ref engaged) == 0) Disengage(); });
      }
    }
    /// Work that moves the mouse, types or changes windows, and so must yield to you.
    static bool TouchesScreen(string kind) {
      switch (kind) {
        case "desktop.scroll": case "desktop.drag": case "desktop.click": case "desktop.clickpoint": case "desktop.type": case "desktop.keys": case "desktop.close": case "desktop.launch": case "desktop.screenshot": case "desktop.read": return true;
        default: return false;
      }
    }
    static string Describe(string kind, Wire scope, Wire payload) {
      var program = scope["kind"].Text == "application" ? Path.GetFileNameWithoutExtension(scope["target"].Text) : "";
      switch (kind) {
        case "desktop.windows": return "Looking at the open windows";
        case "desktop.read": return "Reading a window";
        case "desktop.screenshot": return "Taking a screenshot";
        case "desktop.click": return "Clicking in " + program;
        case "desktop.type": return "Typing in " + program;
        case "desktop.keys": return "Pressing keys in " + program;
        case "desktop.launch": return "Opening " + program;
        case "desktop.close": return "Closing " + program;
        case "desktop.environment": return "Looking at this PC";
        case "desktop.apps": return "Looking for a program";
        case "desktop.command": return "Running a command in " + payload["cwd"].Text;
        case "desktop.admin.command": return "Requesting administrator execution through Windows UAC";
        case "desktop.terminal.open": return "Opening a terminal in " + payload["cwd"].Text;
        case "desktop.terminal.input": return "Sending input to an owned terminal";
        case "desktop.terminal.read": return "Reading terminal output";
        case "desktop.terminal.close": return "Closing an owned terminal";
        case "desktop.folder": return "Looking in " + payload["folder"].Text;
        case "desktop.readfile": return "Reading " + payload["path"].Text;
        case "desktop.writefile": return "Writing " + payload["path"].Text;
        default: return "Working on the desktop";
      }
    }

    Tuple<bool, object> Perform(string kind, string requestId, Wire payload, Wire scope, CancellationToken cancel) {
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      Func<object, Tuple<bool, object>> ok = value => Tuple.Create(true, value);
      cancel.ThrowIfCancellationRequested();
      if (PcAdministrator.Elevated) return refuse("main_app_must_be_unelevated");
      if (kind == "desktop.windows") return ok(Wires.O("kind", "desktop_windows", "windows", Windows().Cast<object>().ToList(), "untrustedContent", true));
      // Beyond the screen: this PC, its programs, a shell, and files. Each
      // re-checks its exact scope inside PcWork before doing anything.
      if (kind == "desktop.environment") return PcWork.Environment_();
      if (kind == "desktop.apps") return PcWork.FindApps(payload["query"].Text);
      if (kind.StartsWith("desktop.terminal.", StringComparison.Ordinal)) return PcTerminals.Execute(requestId, payload, scope);
      if (kind == "desktop.command") { if (scope["kind"].Text != "command") return refuse("scope_mismatch"); return PcWork.Command(payload, scope, cancel); }
      if (kind == "desktop.folder") { if (scope["kind"].Text != "folder") return refuse("scope_mismatch"); return PcWork.ListFolder(payload, scope); }
      if (kind == "desktop.readfile") { if (scope["kind"].Text != "folder") return refuse("scope_mismatch"); return PcWork.ReadFile(payload, scope); }
      if (kind == "desktop.writefile") { if (scope["kind"].Text != "folder") return refuse("scope_mismatch"); return PcWork.WriteFile(payload, scope); }
      if (kind == "desktop.launch") {
        var application = scope["target"].Text;
        if (scope["kind"].Text != "application" || !string.Equals(payload["application"].Text, application, StringComparison.OrdinalIgnoreCase) || !File.Exists(application)) return refuse("application_missing");
        if (ProtectedApplication(application)) return refuse("protected_surface");
        var arguments = payload["arguments"].Text;
        var runnable = PcWork.LaunchablePath(application) ?? application;
        Process started;
        try { started = Process.Start(new ProcessStartInfo(runnable) { UseShellExecute = true, Arguments = arguments, WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) }); }
        catch (Win32Exception) when (!string.Equals(runnable, application, StringComparison.OrdinalIgnoreCase) || PcWork.LaunchablePath(application) == null) {
          // A Store app refused a direct start: open it through the shell by name.
          started = Process.Start(new ProcessStartInfo("explorer.exe") { UseShellExecute = true, Arguments = "shell:AppsFolder" });
          return refuse("application_not_launchable");
        }
        Thread.Sleep(1500);
        return ok(Wires.O("kind", "desktop_launched", "application", application, "arguments", arguments, "processId", started == null ? 0 : started.Id,
          "windows", Windows().Where(w => string.Equals((string)w["application"], application, StringComparison.OrdinalIgnoreCase)).Cast<object>().ToList(), "untrustedContent", true));
      }
      if (kind == "desktop.screenshot") {
        IntPtr window = IntPtr.Zero;
        if (payload["windowId"].Text.Length > 0) { window = WindowHandle(payload["windowId"].Text); if (window == IntPtr.Zero || !IsWindow(window)) return refuse("window_gone"); }
        if (ProtectedWindow(window == IntPtr.Zero ? GetForegroundWindow() : window)) return refuse("protected_surface");
        if (window == IntPtr.Zero) return refuse("choose_target_window");
        if (scope["kind"].Text != "application" || !string.Equals(ApplicationOf(window), scope["target"].Text, StringComparison.OrdinalIgnoreCase)) return refuse("application_changed");
        var captured = NewObservation(window, ApplicationOf(window));
        var image = Screenshot(window);
        if (!captured.Bounds.Equals(NewObservation(window, ApplicationOf(window)).Bounds)) return refuse("window_moved");
        Remember(requestId, captured);
        image["observationId"] = requestId;
        return ok(image);
      }
      // Everything else needs a live window of the exact program the request was decided for.
      var handle = WindowHandle(payload["windowId"].Text);
      if (handle == IntPtr.Zero || !IsWindow(handle)) return refuse("window_gone");
      if (ProtectedWindow(handle)) return refuse("protected_surface");
      var owner = ApplicationOf(handle);
      if (kind == "desktop.read") {
        if (owner == null || scope["kind"].Text != "application" || !string.Equals(owner, scope["target"].Text, StringComparison.OrdinalIgnoreCase)) return refuse("application_changed");
        return ok(Observe(requestId, handle, owner, null, cancel));
      }
      if (owner == null || !string.Equals(owner, scope["target"].Text, StringComparison.OrdinalIgnoreCase)) return refuse("application_changed");
      Observation current;
      lock (gate) { observations.TryGetValue(payload["observationId"].Text, out current); observations.Remove(payload["observationId"].Text); }
      Rect bounds; GetWindowRect(handle, out bounds); uint pid; GetWindowThreadProcessId(handle, out pid);
      if (current == null || current.Window != handle || current.Application != owner || current.Process != pid || current.Dpi != GetDpiForWindow(handle)
          || !current.Bounds.Equals(bounds) || Stopwatch.GetElapsedTime(current.Tick).TotalSeconds > 60) return refuse("observation_stale_read_again");
      inputTarget = handle;
      if (kind == "desktop.close") {
        PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(800);
        return ok(Wires.O("kind", "desktop_closed", "windowId", payload["windowId"].Text, "stillOpen", IsWindow(handle), "untrustedContent", true));
      }
      string method;
      if (kind == "desktop.scroll") {
        var delta = Math.Clamp((int)payload["amount"].Integer, -20, 20) * 120;
        var x = bounds.Left + (bounds.Right - bounds.Left) / 2; var y = bounds.Top + (bounds.Bottom - bounds.Top) / 2;
        cancel.ThrowIfCancellationRequested();
        if (!PostMessage(handle, payload["horizontal"].Flag ? 0x020Eu : 0x020Au, new IntPtr((long)(unchecked((uint)delta) << 16)), new IntPtr((y << 16) | (x & 0xffff)))) throw new Win32Exception();
        method = "targeted_scroll";
      } else if (kind == "desktop.drag") {
        var scale = Convert.ToDouble(payload["scale"].Raw);
        if (!(scale > 0)) return refuse("invalid_geometry");
        var x1 = bounds.Left + (int)Math.Round(payload["x"].Integer / scale); var y1 = bounds.Top + (int)Math.Round(payload["y"].Integer / scale);
        var x2 = bounds.Left + (int)Math.Round(payload["endX"].Integer / scale); var y2 = bounds.Top + (int)Math.Round(payload["endY"].Integer / scale);
        if (x1 < bounds.Left || x1 >= bounds.Right || x2 < bounds.Left || x2 >= bounds.Right || y1 < bounds.Top || y1 >= bounds.Bottom || y2 < bounds.Top || y2 >= bounds.Bottom) return refuse("point_outside");
        Foreground(handle); MouseMove(x1, y1);
        if (GetAncestor(WindowFromPoint(new Point(x1, y1)), 2) != handle) return refuse("another_window_under_point");
        Send(new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { Flags = 2 } } });
        try { for (var step = 1; step <= 24; step++) { cancel.ThrowIfCancellationRequested(); CheckInputTarget(); MouseMove(x1 + (x2-x1)*step/24, y1 + (y2-y1)*step/24); Thread.Sleep(20); } }
        finally { Send(new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { Flags = 4 } } }); }
        method = "drag";
      } else if (kind == "desktop.clickpoint") {
        // A point in a screenshot of this window: mapped back through the
        // picture's scale and origin, and only clicked if the window still sits
        // where it was pictured and the program under the point is the same one.
        Rect now; GetWindowRect(handle, out now);
        var scale = payload["scale"].IsNumber ? Convert.ToDouble(payload["scale"].Raw) : 1.0;
        if (scale <= 0 || now.Left != payload["originX"].Integer || now.Top != payload["originY"].Integer) return refuse("window_moved");
        var screenX = (int)Math.Round(now.Left + payload["x"].Integer / scale); var screenY = (int)Math.Round(now.Top + payload["y"].Integer / scale);
        if (screenX < now.Left || screenY < now.Top || screenX >= now.Right || screenY >= now.Bottom) return refuse("point_outside");
        Foreground(handle);
        cancel.ThrowIfCancellationRequested();
        var under = WindowFromPoint(new Point(screenX, screenY));
        if (under == IntPtr.Zero || GetAncestor(under, 2) != handle) return refuse("another_window_under_point");
        MouseClick(screenX, screenY);
        method = "point";
      } else {
        Observation observation = current; AutomationElement element = null;
        // Keys and focused typing may follow a screenshot (no element ids); the
        // server already tied that observation id to this window and program.
        if (observation != null && observation.Window != handle) return refuse("observation_changed");
        var needsElement = kind == "desktop.click" || (kind == "desktop.type" && payload["elementId"].Text.Length > 0);
        if (needsElement && observation == null) return refuse("observation_changed");
        if (needsElement && !observation.Elements.TryGetValue(payload["elementId"].Text, out element)) return refuse("element_unknown");
        if (element != null && element.Current.IsPassword) return refuse("protected_field");
        Foreground(handle);
        cancel.ThrowIfCancellationRequested();
        var focused = AutomationElement.FocusedElement;
        if (focused != null && focused.Current.IsPassword) return refuse("protected_field");
        if (kind == "desktop.click") method = Click(element);
        else if (kind == "desktop.type") method = element == null ? TypeKeystrokes(payload["text"].Text, cancel) : TypeText(element, payload["text"].Text, cancel);
        else method = Keys(payload["keys"].Text, cancel);
      }
      Thread.Sleep(350);
      cancel.ThrowIfCancellationRequested();
      // A fresh read of the same window rides back, so the next step does not
      // need another request; its element ids replace the old ones.
      return ok(Observe(requestId, handle, owner, Wires.O("action", kind.Substring(8), "method", method), cancel));
    }

    // ------------------------------------------------------------- windows
    List<Dictionary<string, object>> Windows() {
      var list = new List<Dictionary<string, object>>(); var own = Environment.ProcessId;
      EnumWindows((handle, _) => {
        if (!IsWindowVisible(handle) || IsCloaked(handle)) return true;
        var title = Title(handle); if (title.Length == 0) return true;
        uint pid; GetWindowThreadProcessId(handle, out pid);
        if (pid == own) return true;
        var application = ApplicationOf(handle); if (application == null) return true;
        list.Add(Wires.O("windowId", handle.ToInt64().ToString(), "title", title, "application", application, "processId", (int)pid));
        return list.Count < 200;
      }, IntPtr.Zero);
      return list;
    }
    static bool ProtectedApplication(string path) {
      if (string.IsNullOrEmpty(path)) return false;
      return string.Equals(path, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase)
        || string.Equals(Path.GetFileName(path), "consent.exe", StringComparison.OrdinalIgnoreCase)
        || string.Equals(Path.GetFileName(path), "CredentialUIBroker.exe", StringComparison.OrdinalIgnoreCase);
    }
    static bool ProtectedWindow(IntPtr handle) {
      if (handle == IntPtr.Zero) return false;
      uint pid; GetWindowThreadProcessId(handle, out pid);
      return pid == Environment.ProcessId || ProtectedApplication(ApplicationOf(handle));
    }
    static IntPtr WindowHandle(string id) { long value; return long.TryParse(id, out value) ? new IntPtr(value) : IntPtr.Zero; }
    static string Title(IntPtr handle) {
      var buffer = new StringBuilder(512); GetWindowTextW(handle, buffer, buffer.Capacity);
      return buffer.ToString().Replace('\r', ' ').Replace('\n', ' ').Trim();
    }
    static bool IsCloaked(IntPtr handle) { int cloaked; return DwmGetWindowAttribute(handle, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0; }
    static string ApplicationOf(IntPtr handle) {
      uint pid; GetWindowThreadProcessId(handle, out pid); if (pid == 0) return null;
      var process = OpenProcess(0x1000, false, pid); if (process == IntPtr.Zero) return null;
      try { var name = new StringBuilder(1024); uint size = 1024; return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString() : null; }
      finally { CloseHandle(process); }
    }
    static void Foreground(IntPtr handle) {
      if (IsIconic(handle)) ShowWindow(handle, 9);
      SetForegroundWindow(handle);
      Thread.Sleep(120);
      if (GetForegroundWindow() != handle) throw new InvalidOperationException("The target window did not receive focus.");
    }

    [ThreadStatic] static IntPtr inputTarget;
    static void CheckInputTarget() {
      if (inputTarget == IntPtr.Zero || GetForegroundWindow() != inputTarget || ProtectedWindow(inputTarget)) throw new InvalidOperationException("The input target changed.");
      var focused = AutomationElement.FocusedElement;
      if (focused == null || focused.Current.IsPassword) throw new InvalidOperationException("The input field is protected.");
    }
    Observation NewObservation(IntPtr window, string application) {
      Rect rect; GetWindowRect(window, out rect); uint pid; GetWindowThreadProcessId(window, out pid);
      return new Observation { Window = window, Application = application, At = DateTime.UtcNow, Tick = Stopwatch.GetTimestamp(), Bounds = rect, Process = pid, Dpi = GetDpiForWindow(window) };
    }
    void Remember(string id, Observation observation) {
      lock (gate) {
        observations[id] = observation;
        foreach (var stale in observations.Where(o => Stopwatch.GetElapsedTime(o.Value.Tick).TotalSeconds > 60).Select(o => o.Key).ToList()) observations.Remove(stale);
        while (observations.Count > 32) observations.Remove(observations.OrderBy(o => o.Value.Tick).First().Key);
      }
    }

    // ----------------------------------------------------- UI Automation
    Dictionary<string, object> Observe(string requestId, IntPtr handle, string application, Dictionary<string, object> action, CancellationToken cancel) {
      var observation = NewObservation(handle, application);
      var root = AutomationElement.FromHandle(handle);
      var elements = new List<object>(); var text = new StringBuilder(); var partial = false;
      var queue = new Queue<Tuple<AutomationElement, int>>(); queue.Enqueue(Tuple.Create(root, 0));
      var walker = TreeWalker.ControlViewWalker;
      while (queue.Count > 0) {
        cancel.ThrowIfCancellationRequested();
        var next = queue.Dequeue(); var element = next.Item1; var depth = next.Item2;
        if (observation.Elements.Count >= MaxElements) { partial = true; break; }
        AutomationElement.AutomationElementInformation info;
        try { info = element.Current; } catch (ElementNotAvailableException) { continue; }
        // Never return password values or a target that can fill one.
        if (info.IsPassword) continue;
        var role = info.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
        var name = (info.Name ?? "").Trim(); if (name.Length > 200) name = name.Substring(0, 200);
        string value = null;
        object pattern;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
          try { value = ((ValuePattern)pattern).Current.Value; if (value != null && value.Length > 300) value = value.Substring(0, 300); } catch (InvalidOperationException) { }
        }
        var interactive = role == "button" || role == "edit" || role == "checkbox" || role == "radiobutton" || role == "combobox" || role == "listitem"
          || role == "menuitem" || role == "tabitem" || role == "hyperlink" || role == "treeitem" || role == "slider" || role == "spinner" || role == "splitbutton" || role == "document";
        var textual = role == "text" || role == "document" || role == "edit";
        if (depth > 0 && !info.IsOffscreen && (interactive || (textual && name.Length > 0))) {
          if (textual && name.Length > 0 && text.Length < 20000) text.Append(name).Append('\n');
          if (interactive) {
            var id = Guid.NewGuid().ToString(); observation.Elements[id] = element;
            var rect = info.BoundingRectangle;
            var entry = Wires.O("id", id, "role", role, "name", name, "enabled", info.IsEnabled);
            if (value != null && value.Length > 0 && role != "document") entry["value"] = value;
            if (!rect.IsEmpty) entry["bounds"] = Wires.O("x", (int)rect.X, "y", (int)rect.Y, "width", (int)rect.Width, "height", (int)rect.Height);
            elements.Add(entry);
          }
        }
        if (depth >= MaxDepth) { partial = true; continue; }
        try {
          for (var child = walker.GetFirstChild(element); child != null; child = walker.GetNextSibling(child)) queue.Enqueue(Tuple.Create(child, depth + 1));
        } catch (ElementNotAvailableException) { }
      }
      Remember(requestId, observation);
      var result = Wires.O("kind", "desktop_observation", "observationId", requestId, "windowId", handle.ToInt64().ToString(), "title", Title(handle),
        "application", application, "text", text.ToString().Trim(), "elements", elements, "partial", partial, "untrustedContent", true);
      if (action != null) result["action"] = action;
      return result;
    }
    static string Click(AutomationElement element) {
      object pattern;
      if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return "invoke"; }
      if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return "toggle"; }
      if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return "select"; }
      if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
        var expand = (ExpandCollapsePattern)pattern;
        if (expand.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) expand.Expand(); else expand.Collapse();
        return "expand";
      }
      var rect = element.Current.BoundingRectangle;
      if (rect.IsEmpty) throw new InvalidOperationException("The control has no position on screen.");
      MouseClick((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2));
      return "mouse";
    }
    static string TypeText(AutomationElement element, string text, CancellationToken cancel) {
      if (element.Current.IsPassword) throw new UnauthorizedAccessException("Protected field.");
      object pattern;
      if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && !((ValuePattern)pattern).Current.IsReadOnly) {
        try { element.SetFocus(); } catch (InvalidOperationException) { }
        ((ValuePattern)pattern).SetValue(text); return "value";
      }
      try { element.SetFocus(); } catch (InvalidOperationException) {
        var rect = element.Current.BoundingRectangle;
        if (!rect.IsEmpty) MouseClick((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2));
      }
      Thread.Sleep(80);
      return TypeKeystrokes(text, cancel);
    }
    /// Types into whatever has the keyboard focus, one character at a time.
    static string TypeKeystrokes(string text, CancellationToken cancel) {
      foreach (var character in text) {
        cancel.ThrowIfCancellationRequested();
        CheckInputTarget();
        if (character == '\n') { KeyTap(0x0D, 0); continue; }
        if (character == '\r') continue;
        SendUnicode(character);
      }
      return "keystrokes";
    }
    static string Keys(string combination, CancellationToken cancel) {
      var parts = combination.Split('+'); var modifiers = new List<ushort>(); ushort key = 0; bool unicode = false; char character = '\0';
      foreach (var part in parts) {
        switch (part) {
          case "ctrl": case "control": modifiers.Add(0x11); break;
          case "alt": modifiers.Add(0x12); break;
          case "shift": modifiers.Add(0x10); break;
          case "win": modifiers.Add(0x5B); break;
          default:
            ushort code;
            if (KeyCodes.TryGetValue(part, out code)) key = code;
            else if (part.Length == 1 && char.IsLetterOrDigit(part[0])) { key = (ushort)char.ToUpperInvariant(part[0]); }
            else if (part.Length == 1) { unicode = true; character = part[0]; }
            else throw new InvalidOperationException("Unknown key: " + part);
            break;
        }
      }
      if (key == 0 && !unicode) throw new InvalidOperationException("No key in: " + combination);
      cancel.ThrowIfCancellationRequested();
      CheckInputTarget();
      foreach (var modifier in modifiers) KeyDown(modifier, 0);
      try { if (unicode) SendUnicode(character); else KeyTap(key, 0); }
      finally { foreach (var modifier in Enumerable.Reverse(modifiers)) KeyUp(modifier, 0); }
      return "keys";
    }
    static readonly Dictionary<string, ushort> KeyCodes = new Dictionary<string, ushort> {
      { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "esc", 0x1B }, { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E },
      { "space", 0x20 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
      { "insert", 0x2D }, { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 },
      { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B } };

    // ---------------------------------------------------------- screenshot
    Dictionary<string, object> Screenshot(IntPtr window) {
      Rectangle area;
      if (window == IntPtr.Zero || IsIconic(window)) throw new InvalidOperationException("Choose a visible target window.");
      Rect r; GetWindowRect(window, out r); area = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
      if (area.Width < 8 || area.Height < 8 || area.Width > 16384 || area.Height > 16384 || (long)area.Width * area.Height > 64000000) throw new InvalidOperationException("Nothing to capture.");
      using (var bitmap = new Bitmap(area.Width, area.Height)) {
        using (var graphics = Graphics.FromImage(bitmap)) {
          var dc = graphics.GetHdc();
          try { if (!PrintWindow(window, dc, 2)) throw new InvalidOperationException("This application cannot provide a targeted capture. Use its accessibility controls."); }
          finally { graphics.ReleaseHdc(dc); }
        }
        var scale = Math.Min(1.0, 1280.0 / Math.Max(bitmap.Width, bitmap.Height));
        var encoder = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        foreach (var longest in new[] { 1280, 1024, 800 }) {
          var factor = Math.Min(scale, (double)longest / Math.Max(bitmap.Width, bitmap.Height));
          using (var small = new Bitmap(bitmap, new Size(Math.Max(1, (int)(bitmap.Width * factor)), Math.Max(1, (int)(bitmap.Height * factor))))) {
            foreach (var quality in new long[] { 80, 60, 45, 30 }) {
              using (var stream = new MemoryStream()) {
                var parameters = new EncoderParameters(1); parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                small.Save(stream, encoder, parameters);
                var base64 = Convert.ToBase64String(stream.ToArray());
                if (base64.Length <= ScreenshotBase64Limit) {
                  // Geometry travels with the picture so a later click at a point in
                  // it can be mapped back to the screen and re-checked.
                  var result = Wires.O("kind", "desktop_screenshot", "windowId", window == IntPtr.Zero ? "" : window.ToInt64().ToString(), "title", window == IntPtr.Zero ? "Whole screen" : Title(window),
                    "width", small.Width, "height", small.Height, "originX", area.Left, "originY", area.Top, "scale", (double)small.Width / area.Width,
                    "untrustedContent", true, "shown", "The picture is attached as an image.",
                    "__images", new List<object> { Wires.O("data", base64, "mimeType", "image/jpeg") });
                  var application = window == IntPtr.Zero ? null : ApplicationOf(window);
                  if (application != null) result["application"] = application;
                  return result;
                }
              }
            }
          }
        }
      }
      throw new InvalidOperationException("The screenshot could not be made small enough.");
    }

    // --------------------------------------------------------- input
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyInput Key; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort Key, Scan; public uint Flags, Time; public IntPtr Extra; }
    static void Send(params Input[] inputs) { if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length) throw new Win32Exception(); }
    static void MouseClick(int x, int y) {
      CheckInputTarget();
      var left = GetSystemMetrics(76); var top = GetSystemMetrics(77); var width = GetSystemMetrics(78); var height = GetSystemMetrics(79);
      var nx = (int)((x - left) * 65535.0 / Math.Max(1, width - 1)); var ny = (int)((y - top) * 65535.0 / Math.Max(1, height - 1));
      Send(new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { X = nx, Y = ny, Flags = 0x0001 | 0x8000 | 0x4000 } } });
      Thread.Sleep(40);
      Send(new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { X = nx, Y = ny, Flags = 0x0002 | 0x8000 | 0x4000 } } },
        new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { X = nx, Y = ny, Flags = 0x0004 | 0x8000 | 0x4000 } } });
    }
    static void MouseMove(int x, int y) {
      var nx = (int)((x - GetSystemMetrics(76)) * 65535.0 / Math.Max(1, GetSystemMetrics(78) - 1));
      var ny = (int)((y - GetSystemMetrics(77)) * 65535.0 / Math.Max(1, GetSystemMetrics(79) - 1));
      Send(new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { X = nx, Y = ny, Flags = 0xC001 } } });
    }
    static void KeyDown(ushort key, uint flags) { Send(new Input { Type = 1, U = new InputUnion { Key = new KeyInput { Key = key, Flags = flags } } }); }
    static void KeyUp(ushort key, uint flags) { Send(new Input { Type = 1, U = new InputUnion { Key = new KeyInput { Key = key, Flags = flags | 0x0002 } } }); }
    static void KeyTap(ushort key, uint flags) { KeyDown(key, flags); Thread.Sleep(15); KeyUp(key, flags); Thread.Sleep(15); }
    static void SendUnicode(char character) {
      Send(new Input { Type = 1, U = new InputUnion { Key = new KeyInput { Scan = character, Flags = 0x0004 } } },
        new Input { Type = 1, U = new InputUnion { Key = new KeyInput { Scan = character, Flags = 0x0004 | 0x0002 } } });
      Thread.Sleep(6);
    }

    // ----------------------------------------------------------- Win32
    delegate bool EnumProc(IntPtr handle, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr handle, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string module);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);
  }
}
