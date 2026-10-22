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
  /// keyboard stops Josi at once and keeps it stopped for a short while.
  sealed class DesktopExecutor {
    public static readonly DesktopExecutor Current = new DesktopExecutor();
    const int MaxElements = 400, MaxDepth = 16, TakeoverSeconds = 20, ScreenshotBase64Limit = 131072;

    sealed class Observation {
      public IntPtr Window; public string Application; public DateTime At;
      public readonly Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
    }
    readonly object gate = new object();
    readonly Dictionary<string, Observation> observations = new Dictionary<string, Observation>();
    Dispatcher ui;
    CancellationTokenSource running;
    DateTime takenOverUntil = DateTime.MinValue;
    bool paused;

    // --------------------------------------------------------------- state
    /// What Josi is doing on the desktop right now, for the control banner.
    public bool Busy { get; private set; }
    public string Activity { get; private set; } = "";
    public bool Paused { get { lock (gate) return paused; } }
    public int TakenOverSecondsLeft { get { lock (gate) { var left = (takenOverUntil - DateTime.UtcNow).TotalSeconds; return left > 0 ? (int)Math.Ceiling(left) : 0; } } }
    public event Action Changed;
    void Raise() { var u = ui; if (u != null) u.BeginInvoke(new Action(() => Changed?.Invoke())); }

    public void Start(Dispatcher dispatcher) { ui = dispatcher; }
    public void Pause() { lock (gate) paused = true; CancelCurrent("paused"); Raise(); }
    public void Resume() { lock (gate) { paused = false; takenOverUntil = DateTime.MinValue; } Raise(); }
    /// True when Josi may not act on the desktop at this moment.
    public bool Blocked { get { lock (gate) return paused || DateTime.UtcNow < takenOverUntil; } }

    // ---------------------------------------------------- human takeover
    // Low-level hooks see every mouse and keyboard event before the programs
    // do, and flag events Josi itself injected, so a real person moving the
    // mouse or typing is unmistakable: the current action is cancelled and
    // the desktop stays Josi-free for a short while.
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    HookProc keyboardHook, mouseHook; IntPtr keyboardHandle, mouseHandle; int engaged;
    Point lastMouse;
    void Engage() {
      var u = ui; if (u == null) return;
      u.Invoke(new Action(() => {
        if (keyboardHandle != IntPtr.Zero) return;
        keyboardHook = KeyboardProc; mouseHook = MouseProc;
        var module = GetModuleHandle(null);
        keyboardHandle = SetWindowsHookEx(13, keyboardHook, module, 0);
        mouseHandle = SetWindowsHookEx(14, mouseHook, module, 0);
        GetCursorPos(out lastMouse);
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
      if (code >= 0) {
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
          if (message != 0x200 || moved) Takeover("mouse");
        }
        lastMouse = new Point(x, y);
      }
      return CallNextHookEx(mouseHandle, code, wParam, lParam);
    }
    void Takeover(string by) {
      bool fresh;
      lock (gate) { fresh = DateTime.UtcNow >= takenOverUntil; takenOverUntil = DateTime.UtcNow.AddSeconds(TakeoverSeconds); }
      CancelCurrent("human_control");
      if (fresh) Raise();
    }
    void CancelCurrent(string reason) { var current = running; if (current != null) { try { current.Cancel(); } catch (ObjectDisposedException) { } } }

    // ------------------------------------------------------------ requests
    /// One approved PC Control request whose payload kind starts with "desktop.".
    public async Task<Tuple<bool, object>> Run(Wire request) {
      var payload = request["payload"]; var scope = request["requirements"].List.Select(r => r["scope"]).FirstOrDefault() ?? Wire.Null;
      var kind = payload["kind"].Text; var requestId = request.Id;
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      if (Blocked) return refuse(Paused ? "paused" : "human_control");
      var cancel = new CancellationTokenSource();
      lock (gate) running = cancel;
      Busy = true; Activity = Describe(kind, scope); Raise();
      if (Interlocked.Increment(ref engaged) == 1) Engage();
      try {
        var result = await Task.Run(() => Perform(kind, requestId, payload, scope, cancel.Token));
        return result;
      } catch (OperationCanceledException) { return refuse(Paused ? "paused" : "human_control"); }
      catch (ElementNotAvailableException) { return refuse("element_gone"); }
      catch (Exception e) when (e is InvalidOperationException || e is COMException || e is Win32Exception || e is IOException || e is UnauthorizedAccessException) {
        return Tuple.Create(false, (object)Wires.O("code", "desktop_action_failed", "detail", e.GetType().Name));
      } finally {
        lock (gate) if (running == cancel) running = null;
        cancel.Dispose();
        Busy = false; Activity = ""; Raise();
        // Keep the hooks a moment longer: the next request usually follows at once.
        _ = Task.Delay(45000).ContinueWith(_ => { if (Interlocked.Decrement(ref engaged) == 0) Disengage(); });
      }
    }
    static string Describe(string kind, Wire scope) {
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
        default: return "Working on the desktop";
      }
    }

    Tuple<bool, object> Perform(string kind, string requestId, Wire payload, Wire scope, CancellationToken cancel) {
      Func<string, Tuple<bool, object>> refuse = code => Tuple.Create(false, (object)Wires.O("code", code));
      Func<object, Tuple<bool, object>> ok = value => Tuple.Create(true, value);
      cancel.ThrowIfCancellationRequested();
      if (kind == "desktop.windows") return ok(Wires.O("kind", "desktop_windows", "windows", Windows().Cast<object>().ToList(), "untrustedContent", true));
      if (kind == "desktop.launch") {
        var application = scope["target"].Text;
        if (!string.Equals(payload["application"].Text, application, StringComparison.OrdinalIgnoreCase) || !File.Exists(application)) return refuse("application_missing");
        var started = Process.Start(new ProcessStartInfo(application) { UseShellExecute = true });
        Thread.Sleep(1500);
        return ok(Wires.O("kind", "desktop_launched", "application", application, "processId", started == null ? 0 : started.Id,
          "windows", Windows().Where(w => string.Equals((string)w["application"], application, StringComparison.OrdinalIgnoreCase)).Cast<object>().ToList()));
      }
      if (kind == "desktop.screenshot") {
        IntPtr window = IntPtr.Zero;
        if (payload["windowId"].Text.Length > 0) { window = WindowHandle(payload["windowId"].Text); if (window == IntPtr.Zero || !IsWindow(window)) return refuse("window_gone"); }
        return ok(Screenshot(window));
      }
      // Everything else needs a live window of the exact program the request was decided for.
      var handle = WindowHandle(payload["windowId"].Text);
      if (handle == IntPtr.Zero || !IsWindow(handle)) return refuse("window_gone");
      var owner = ApplicationOf(handle);
      if (kind == "desktop.read") {
        if (owner == null) return refuse("window_unreadable");
        return ok(Observe(requestId, handle, owner, null, cancel));
      }
      if (owner == null || !string.Equals(owner, scope["target"].Text, StringComparison.OrdinalIgnoreCase)) return refuse("application_changed");
      if (kind == "desktop.close") {
        PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(800);
        return ok(Wires.O("kind", "desktop_closed", "windowId", payload["windowId"].Text, "stillOpen", IsWindow(handle), "untrustedContent", true));
      }
      Observation observation; AutomationElement element = null;
      lock (gate) observations.TryGetValue(payload["observationId"].Text, out observation);
      if (observation == null || observation.Window != handle) return refuse("observation_changed");
      if (kind != "desktop.keys" && !observation.Elements.TryGetValue(payload["elementId"].Text, out element)) return refuse("element_unknown");
      Foreground(handle);
      cancel.ThrowIfCancellationRequested();
      string method;
      if (kind == "desktop.click") method = Click(element);
      else if (kind == "desktop.type") method = TypeText(element, payload["text"].Text, cancel);
      else method = Keys(payload["keys"].Text, cancel);
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
    }

    // ----------------------------------------------------- UI Automation
    Dictionary<string, object> Observe(string requestId, IntPtr handle, string application, Dictionary<string, object> action, CancellationToken cancel) {
      var observation = new Observation { Window = handle, Application = application, At = DateTime.UtcNow };
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
      lock (gate) {
        observations[requestId] = observation;
        foreach (var stale in observations.Where(o => (DateTime.UtcNow - o.Value.At).TotalMinutes > 10).Select(o => o.Key).ToList()) observations.Remove(stale);
      }
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
      foreach (var character in text) {
        cancel.ThrowIfCancellationRequested();
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
      foreach (var modifier in modifiers) KeyDown(modifier, 0);
      if (unicode) SendUnicode(character); else KeyTap(key, 0);
      foreach (var modifier in Enumerable.Reverse(modifiers)) KeyUp(modifier, 0);
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
      if (window != IntPtr.Zero) { Rect r; GetWindowRect(window, out r); area = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom); Foreground(window); Thread.Sleep(150); }
      else area = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
      if (area.Width < 8 || area.Height < 8) throw new InvalidOperationException("Nothing to capture.");
      using (var bitmap = new Bitmap(area.Width, area.Height)) {
        using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size);
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
                if (base64.Length <= ScreenshotBase64Limit)
                  return Wires.O("kind", "desktop_screenshot", "windowId", window == IntPtr.Zero ? "" : window.ToInt64().ToString(), "title", window == IntPtr.Zero ? "Whole screen" : Title(window),
                    "width", small.Width, "height", small.Height, "untrustedContent", true, "shown", "The picture is attached as an image.",
                    "__images", new List<object> { Wires.O("data", base64, "mimeType", "image/jpeg") });
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
      var left = GetSystemMetrics(76); var top = GetSystemMetrics(77); var width = GetSystemMetrics(78); var height = GetSystemMetrics(79);
      var nx = (int)((x - left) * 65535.0 / Math.Max(1, width - 1)); var ny = (int)((y - top) * 65535.0 / Math.Max(1, height - 1));
      Send(new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { X = nx, Y = ny, Flags = 0x0001 | 0x8000 | 0x4000 } } });
      Thread.Sleep(40);
      Send(new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { X = nx, Y = ny, Flags = 0x0002 | 0x8000 | 0x4000 } } },
        new Input { Type = 0, U = new InputUnion { Mouse = new MouseInput { X = nx, Y = ny, Flags = 0x0004 | 0x8000 | 0x4000 } } });
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
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr handle, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
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
