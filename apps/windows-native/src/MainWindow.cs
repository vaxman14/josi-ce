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
      // Chrome starting Josi as the browser extension's native host.
      if (BrowserHost.IsLaunch(args)) return BrowserHost.Run();
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
          if (!AppLinks.Testing) Activation.ActivateExisting();
          return 0;
        }
        AppLinks.Register();
        Notifications.Register();
        SendTo.Register();
        BrowserHost.Register();
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
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
        BrowserBridge.Current.Start(main.Model, app.Dispatcher);
        main.Show();
        if (link != null) app.Dispatcher.BeginInvoke(new Action(() => main.ReceiveLink(link)));
        return app.Run();
      }
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
    Screen? shown;
    WorkspaceView workspace;

    public MainWindow() {
      Title = "Josi";
      Width = 1160; Height = 800; MinWidth = 920; MinHeight = 660;
      WindowStartupLocation = WindowStartupLocation.CenterScreen;
      Background = Ui.Background; Foreground = Ui.Text;
      FontFamily = Ui.Font; FontSize = 14;
      UseLayoutRounding = true;
      TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
      using (var stream = typeof(MainWindow).Assembly.GetManifestResourceStream("Josi.ico"))
        if (stream != null) Icon = System.Windows.Media.Imaging.BitmapFrame.Create(stream, System.Windows.Media.Imaging.BitmapCreateOptions.None, System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);

      var dock = new DockPanel { LastChildFill = true };
      DockPanel.SetDock(busyBar, Dock.Bottom); DockPanel.SetDock(errorBar, Dock.Bottom);
      dock.Children.Add(busyBar); dock.Children.Add(errorBar); dock.Children.Add(content);
      Content = dock;

      Model.Attach(this);
      Model.Changed += Render;
      InputBindings.Add(new KeyBinding(new Command(() => {
        if (Model.Screen == Screen.Workspace && !Model.Busy) Model.Run(() => Model.NewThread());
      }), Key.N, ModifierKeys.Control));
      SourceInitialized += delegate { DarkTitleBar(); };
      Model.RefreshLocal();
      Render();
      // A remembered sign-in opens the server on this PC straight away, once
      // the window runs (requests must resume on its thread).
      var r = Model.Receipt;
      if (r.Installed && r.Running && r.Address.Length > 0 && SessionStore.Load(r.Address) != null)
        Loaded += delegate { if (Model.Screen == Screen.Connect) Model.Run(() => Model.Connect(r.Address, true)); };
    }

    public void ShowError(string message) { Model.Error = message; Model.Busy = false; Render(); }

    /// A josi:// link from the browser: Google sign-in returning.
    public void ReceiveLink(string link) {
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
      Dialogs.ShowRecoveryIfNeeded(this, Model);
    }

    void RenderBars() {
      if (Model.Error.Length > 0) {
        var close = Ui.IconButton(Glyph.Close, "Dismiss", () => { Model.Error = ""; RenderBars(); }, 12);
        var text = Ui.Copyable(Model.Error);
        var row = Ui.Spread(Ui.Row(10, Ui.Icon(Glyph.Warning, 15, Ui.Orange), text), close);
        errorBar.Child = row; errorBar.Padding = new Thickness(14, 10, 14, 10);
        errorBar.Background = new SolidColorBrush(Color.FromArgb(0x24, 0xF6, 0x83, 0x1E));
        errorBar.Visibility = Visibility.Visible;
        System.Windows.Automation.AutomationProperties.SetLiveSetting(errorBar, System.Windows.Automation.AutomationLiveSetting.Assertive);
      } else errorBar.Visibility = Visibility.Collapsed;
      if (Model.Busy) {
        var bar = new ProgressBar { IsIndeterminate = true, Width = 90, Height = 4 };
        busyBar.Child = Ui.Row(12, bar, Ui.T(Model.Activity.Length == 0 ? "Working…" : Model.Activity, 13));
        busyBar.Padding = new Thickness(16, 9, 16, 9); busyBar.Background = Ui.Sidebar;
        busyBar.Visibility = Visibility.Visible;
      } else busyBar.Visibility = Visibility.Collapsed;
    }

    protected override void OnClosing(CancelEventArgs e) {
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
      if (workspace != null) workspace.Detach();
      if (Model.Api != null) Model.Api.Dispose();
      base.OnClosing(e);
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    void DarkTitleBar() {
      var handle = new WindowInteropHelper(this).Handle;
      var on = 1;
      DwmSetWindowAttribute(handle, 20, ref on, sizeof(int));        // immersive dark mode
      var caption = 0x001E110B;                                       // #0B111E as COLORREF (BGR)
      DwmSetWindowAttribute(handle, 35, ref caption, sizeof(int));    // caption color (Windows 11)
      var text = 0x00EAF6FD;
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
