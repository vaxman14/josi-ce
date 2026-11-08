using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace Josi.Native {
  /// Native controls on the user's desktop, independent of the main window.
  /// Blue frames never intercept input. The strip stays usable without a server.
  sealed class PcControlOverlay : IDisposable {
    public static PcControlOverlay Current { get; private set; }
    public bool IsShowing => visible;
    public void ShowControls() {
      var executor = DesktopExecutor.Current;
      Update(true,executor.Busy||PcTerminals.Count>0,executor.Paused,executor.TakenOver,executor.ScreenControl,executor.Activity);
    }
    readonly Action takeOver, pause, resume, stop, permissions;
    readonly List<Window> frames = new List<Window>();
    Window strip;
    TextBlock status, detail;
    Button takeOverButton, pauseButton, resumeButton;
    readonly GhostController ghost = new GhostController();
    HwndSource source;
    bool visible, disposed, hotkey, screenControl;
    string layout = "";
    const int HotkeyId = 0x4A50;
    static readonly Brush Blue = new SolidColorBrush(Color.FromRgb(63, 144, 255));
    static readonly Brush Ink = new SolidColorBrush(Color.FromRgb(49, 24, 65));
    static readonly Brush Gold = new SolidColorBrush(Color.FromRgb(255, 209, 105));

    public PcControlOverlay(Action takeOver, Action pause, Action resume, Action stop, Action permissions) {
      this.takeOver = takeOver; this.pause = pause; this.resume = resume;
      this.stop = stop; this.permissions = permissions;
      Current = this;
    }

    public void Update(bool show, bool working, bool paused, bool takenOver, bool onScreen, string activity) {
      if (disposed) return;
      visible = show; screenControl = onScreen && working && !paused && !takenOver;
      if (!show) {
        foreach (var frame in frames) frame.Hide();
        strip?.Hide();
        return;
      }
      EnsureStrip();
      status.Text = paused ? "Paused · You are in control" : takenOver ? "You are in control" : !working ? "Ready · You are in control" : onScreen ? "Josi is using this PC" : "Josi is working in the background";
      detail.Text = paused ? "Choose Resume when you are ready." : takenOver
        ? (working ? "Background work continues. Screen control waits for Resume." : "Screen control waits for you to choose Resume.")
        : (string.IsNullOrWhiteSpace(activity) ? "Move your mouse or type to take over." : activity);
      takeOverButton.IsEnabled = !takenOver && !paused;
      pauseButton.IsEnabled = !paused;
      resumeButton.IsEnabled = paused || takenOver;
      ghost.Set(working && !paused && !takenOver ? GhostState.Waiting : GhostState.Resting);
      Position();
      strip.Show();
      foreach (var frame in frames) { if (screenControl) frame.Show(); else frame.Hide(); }
    }

    void EnsureStrip() {
      if (strip != null) return;
      strip = NewWindow("Josi computer control", false);
      Automation.Id(strip, "josi.pc-overlay", "Josi computer control");
      status = new TextBlock { Foreground = Brushes.White, FontSize = 14, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
      detail = new TextBlock { Foreground = new SolidColorBrush(Color.FromRgb(225, 208, 234)), FontSize = 11, Margin = new Thickness(0, 3, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis };
      Automation.Id(status, "josi.pc-overlay.status");
      Automation.Id(detail, "josi.pc-overlay.activity");
      var buttons = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
      takeOverButton = AddButton(buttons, "Take over", "takeover", takeOver);
      pauseButton = AddButton(buttons, "Pause", "pause", pause);
      resumeButton = AddButton(buttons, "Resume", "resume", resume);
      AddButton(buttons, "Stop", "stop", stop);
      AddButton(buttons, "Permissions", "permissions", permissions);
      var body = new Grid { Width = 980, Height = 120 };
      var row = new Grid { Margin = new Thickness(111, 0, 24, 0) };
      row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
      row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
      var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 14, 0) };
      words.Children.Add(new TextBlock { Text = "Josi", FontFamily = Ui.Font, FontSize = 23, FontWeight = FontWeights.Bold, Foreground = Gold });
      words.Children.Add(status); words.Children.Add(detail);
      row.Children.Add(words); Grid.SetColumn(buttons, 1); row.Children.Add(buttons);
      body.Children.Add(new Border { Background = Ink, BorderBrush = Gold, BorderThickness = new Thickness(2), CornerRadius = new CornerRadius(43), Margin = new Thickness(2, 36, 2, 2), Child = row });
      var mascot = new GhostView(ghost, 112, true) { HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(8, 0, 0, 0) };
      body.Children.Add(mascot);
      strip.Content = new Viewbox { Stretch = Stretch.Uniform, Child = body };
      strip.SizeToContent = SizeToContent.Height;
      var handle = new WindowInteropHelper(strip).EnsureHandle();
      source = HwndSource.FromHwnd(handle);
      source.AddHook(Messages);
      hotkey = RegisterHotKey(handle, HotkeyId, 0x4003, 0x1B); // Ctrl+Alt+Esc, no repeat.
      strip.ToolTip = hotkey ? "Ctrl + Alt + Esc stops Josi" : "Use Stop to end work (emergency shortcut is already in use)";
    }

    Button AddButton(Panel parent, string label, string id, Action action) {
      var button = new Button {
        Content = label, Padding = new Thickness(14, 10, 14, 10), Margin = new Thickness(0, 0, 7, 0),
        Background = id == "stop" ? new SolidColorBrush(Color.FromRgb(255, 161, 157)) : id == "takeover" ? Gold : new SolidColorBrush(Color.FromRgb(93, 58, 112)),
        Foreground = id == "stop" || id == "takeover" ? Ink : Brushes.White, BorderBrush = Gold, BorderThickness = new Thickness(1), FontSize = 12, FontWeight = FontWeights.SemiBold,
      };
      var outline = new FrameworkElementFactory(typeof(Border));
      outline.SetValue(Border.CornerRadiusProperty, new CornerRadius(19));
      outline.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
      outline.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
      outline.SetValue(Border.BorderThicknessProperty, new Thickness(1));
      outline.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
      var caption = new FrameworkElementFactory(typeof(ContentPresenter));
      caption.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
      outline.AppendChild(caption);
      button.Template = new ControlTemplate(typeof(Button)) { VisualTree = outline };
      button.IsEnabledChanged += (_, __) => button.Opacity = button.IsEnabled ? 1 : .45;
      Automation.Id(button, "josi.pc-overlay." + id);
      button.Click += delegate { action(); };
      parent.Children.Add(button);
      return button;
    }

    Window NewWindow(string title, bool frame) {
      var window = new Window {
        Title = title, WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize,
        AllowsTransparency = true, Background = Brushes.Transparent, ShowInTaskbar = false,
        ShowActivated = false, Topmost = true, Focusable = !frame, Width = 800, Height = 140,
      };
      window.SourceInitialized += delegate {
        var handle = new WindowInteropHelper(window).Handle;
        var style = GetWindowLong(handle, -20) | 0x80;
        if (frame) style |= 0x20 | 0x08000000; // Frames pass input through; the strip accepts deliberate keyboard focus.
        SetWindowLong(handle, -20, style);
        // Status UI must not pollute the model's screenshot observations.
        // This is a capture preference, not an authentication boundary.
        // Target-window capture already excludes this protected Josi surface;
        // ordinary user screenshots may include the ghost and its controls.
      };
      return window;
    }

    void Position() {
      var displays = Displays();
      if (displays.Count == 0) throw new InvalidOperationException("No interactive display is available.");
      var signature = string.Join(";", displays.ConvertAll(d => d.Bounds.Left + "," + d.Bounds.Top + "," + d.Bounds.Right + "," + d.Bounds.Bottom));
      if (signature != layout) {
        foreach (var old in frames) old.Close();
        frames.Clear(); layout = signature;
        foreach (var display in displays) {
          var frame = NewWindow("Josi control border", true);
          frame.Content = new Border { BorderBrush = Blue, BorderThickness = new Thickness(4), Background = Brushes.Transparent, IsHitTestVisible = false };
          var handle = new WindowInteropHelper(frame).EnsureHandle();
          var bounds = display.Bounds;
          if (!SetWindowPos(handle, new IntPtr(-1), bounds.Left, bounds.Top, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, 0x10)) throw new Win32Exception();
          frames.Add(frame);
        }
      }
      var primary = displays.Find(d => (d.Flags & 1) != 0);
      if (primary.Size == 0) primary = displays[0];
      var stripHandle = new WindowInteropHelper(strip).Handle;
      var dpi = GetDpiForWindow(stripHandle); var scale = dpi > 0 ? dpi / 96.0 : 1;
      var width = Math.Min(980, (primary.Work.Right - primary.Work.Left) / scale - 24);
      strip.Width = Math.Max(200, width);
      strip.UpdateLayout();
      var pixelWidth = (int)Math.Round(strip.Width * scale);
      if (!SetWindowPos(stripHandle, new IntPtr(-1), primary.Work.Left + (primary.Work.Right - primary.Work.Left - pixelWidth) / 2,
          primary.Work.Top + 12, 0, 0, 0x11)) throw new Win32Exception(); // No resize or activation.
    }

    IntPtr Messages(IntPtr handle, int message, IntPtr wParam, IntPtr lParam, ref bool handled) {
      if (message == 0x312 && wParam.ToInt32() == HotkeyId && visible) { stop(); handled = true; }
      if ((message == 0x7E || message == 0x2E0) && visible) {
        strip.Dispatcher.BeginInvoke(new Action(() => {
          if (!disposed && visible) {
            Position(); foreach (var frame in frames) { if (screenControl) frame.Show(); else frame.Hide(); }
          }
        }), DispatcherPriority.Background);
      }
      return IntPtr.Zero;
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      if (Current == this) Current = null;
      if (strip != null) {
        if (hotkey) UnregisterHotKey(new WindowInteropHelper(strip).Handle, HotkeyId);
        source?.RemoveHook(Messages); strip.Close();
      }
      foreach (var frame in frames) frame.Close();
      frames.Clear();
    }

    [StructLayout(LayoutKind.Sequential)] struct Rectangle { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Monitor { public int Size; public Rectangle Bounds, Work; public int Flags; }
    delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
    static List<Monitor> Displays() {
      var result = new List<Monitor>();
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, dc, rect, data) => {
        var info = new Monitor { Size = Marshal.SizeOf<Monitor>() };
        if (GetMonitorInfo(monitor, ref info)) result.Add(info);
        return true;
      }, IntPtr.Zero);
      return result;
    }
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr rect, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref Monitor info);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window, int id);
  }
}
