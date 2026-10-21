using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace Josi.Native {
  public sealed class ConnectView : UserControl, IRefresh {
    readonly AppModel model; readonly Window owner;
    readonly TextBox address;
    public ConnectView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      address = Ui.Input("https://josi.example.com", model.Address.Contains("localhost") ? "" : model.Address);
      address.KeyDown += (s, e) => { if (e.Key == Key.Enter) Connect(); };
      Refresh();
    }
    public void Refresh() {
      var r = model.Receipt;
      var local = Ui.CardBox(null,
        Ui.Row(10, Ui.Icon(Glyph.Desktop, 22, Ui.Text), Ui.T("On this PC", 21, FontWeights.Bold)),
        Ui.Secondary(r.Installed ? "Your existing server is available here. Its accounts and data stay with it."
                                 : "Set up a server here, or restore the data retained by your previous installation."),
        r.Installed ? Ui.Caption("Version " + (r.Version.Length == 0 ? "unknown" : r.Version) + " · " + r.Detail) : null,
        r.Installed ? Ui.Pill("Open Josi", () => model.Run(() => model.Connect(r.Address, true)), true)
                    : Ui.Pill("Set Up on This PC…", () => ServerControls.ChooseInstaller(model, owner), true),
        new ServerControls(model, owner, true));
      var remote = Ui.CardBox(null,
        Ui.Row(10, Ui.Icon(Glyph.Network, 22, Ui.Text), Ui.T("On another computer", 21, FontWeights.Bold)),
        Ui.Secondary("Connect to your Josi server and use the same account, conversations and work."),
        address,
        Ui.Pill("Connect", Connect, true),
        Ui.Caption("Remote connections use HTTPS. Localhost is supported for a server on this PC."));
      var cards = new Grid();
      cards.ColumnDefinitions.Add(new ColumnDefinition()); cards.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(24) }); cards.ColumnDefinitions.Add(new ColumnDefinition());
      Grid.SetColumn(remote, 2); cards.Children.Add(local); cards.Children.Add(remote);
      var brand = Ui.Row(14, Ui.JosiMark(52), Ui.Stack(2, Ui.T("Josi", 28, FontWeights.SemiBold), Ui.Caption("Your assistant, on your own server.")));
      var page = Ui.Stack(28, brand, Ui.Heading("Welcome to Josi", "Your conversations, your work, your PC."), cards,
        Ui.Secondary("Closing this window leaves your server running for your other devices."));
      page.IsEnabled = !model.Busy;
      Content = Ui.Scroll(page, 1100, 36);
    }
    void Connect() {
      var value = address.Text;
      if (value.Trim().Length == 0) return;
      model.Run(() => model.Connect(value));
    }
  }

  /// Local hosting controls. Every change goes through Windows UAC.
  public sealed class ServerControls : UserControl {
    public ServerControls(AppModel model, Window owner, bool compact) {
      var r = model.Receipt;
      var stack = new StackPanel();
      if (!compact) {
        Ui.Add(stack, Ui.Heading("Server on this PC", "Manage local hosting without leaving Josi."), 0);
        Ui.Add(stack, Ui.T(r.Installed ? r.Address + " · " + (r.Version.Length == 0 ? "version unknown" : r.Version) + " · " + r.Detail : "Local server is not installed."), 14);
      }
      Action<string, string, string> confirm = (operation, title, detail) => {
        if (Dialogs.Confirm(owner, title, detail, "Continue")) model.Run(() => model.Operate(operation));
      };
      if (r.Development) {
        Ui.Add(stack, Ui.Caption("This development server runs from source under your Windows account. Start and stop it with scripts/windows/dev/Start-DevServer.ps1 and Stop-DevServer.ps1."), 14);
      } else if (r.Installed) {
        Ui.Add(stack, Ui.Wrap(
          Ui.Pill("Start", () => model.Run(() => model.Operate("start"))),
          Ui.Pill("Stop…", () => confirm("stop", "Stop the server on this PC?", "Connected devices will lose access until you start the server again.")),
          Ui.Pill("Restart…", () => confirm("restart", "Restart the server on this PC?", "Connected devices lose access briefly. Keep the app open until the operation finishes."))), 14);
        Ui.Add(stack, Ui.Wrap(Ui.Pill("Update or Repair Server…", () => ChooseInstaller(model, owner))), 0);
      }
      Ui.Add(stack, Ui.Pill("Refresh Status", model.RefreshLocal), r.Installed ? 0 : 14);
      if (!compact) {
        Ui.Add(stack, Ui.Secondary("Updates use the existing recovery-copy and migration process of the Josi CE installer. Windows will ask for administrator approval."), 14);
        Ui.Add(stack, Ui.Pill("Open Installed Apps to Uninstall…", () => {
          try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ms-settings:appsfeatures") { UseShellExecute = true }); }
          catch (Exception) { model.Error = "Windows Settings could not be opened."; model.Notify(); }
        }), 14);
        Ui.Add(stack, Ui.Caption("Uninstalling keeps your retained data and recovery files unless the installer explicitly asks otherwise."), 6);
      }
      stack.IsEnabled = !model.Busy;
      Content = stack;
    }
    public static void ChooseInstaller(AppModel model, Window owner) {
      var dialog = new Microsoft.Win32.OpenFileDialog {
        Title = "Choose the Josi CE Windows installer", Filter = "Josi CE installer (*.exe)|*.exe", CheckFileExists = true
      };
      if (dialog.ShowDialog(owner) != true) return;
      if (!Dialogs.Confirm(owner, "Run this installer?", dialog.FileName + "\n\nJosi will use the installer's recovery copy and migration process. Keep the app open until it finishes.", "Run Installer")) return;
      var path = dialog.FileName;
      model.Run(() => model.RunInstaller(path));
    }
  }

  public sealed class LoginView : UserControl, IRefresh {
    readonly AppModel model; readonly Window owner;
    readonly TextBox identifier = Ui.Input("Username or email");
    readonly PasswordInput password = new PasswordInput("Password");
    readonly PasswordBox code = Ui.Secret("Verification code");
    string shownChallenge;
    public LoginView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      password.Submitted += Submit;
      code.KeyDown += (s, e) => { if (e.Key == Key.Enter) Submit(); };
      Refresh();
      Loaded += delegate { identifier.Focus(); };
    }
    public void Refresh() {
      if (shownChallenge == model.MfaChallenge && Content != null) { ((FrameworkElement)Content).IsEnabled = !model.Busy; return; }
      shownChallenge = model.MfaChallenge;
      var stack = new StackPanel { MaxWidth = 580, Margin = new Thickness(36), VerticalAlignment = VerticalAlignment.Center };
      Ui.Add(stack, Ui.Row(14, Ui.JosiMark(44), Ui.Heading("Sign in to Josi", model.Address)), 0);
      if (model.MfaChallenge.Length == 0) {
        Ui.Add(stack, Ui.Field("Username or email", identifier), 22);
        Ui.Add(stack, Ui.Field("Password", password), 14);
        Ui.Add(stack, Ui.Row(18,
          Ui.Link("Forgot password?", () => { password.Clear(); Dialogs.ForgotPassword(owner, model, identifier.Text.Trim()); }),
          Ui.Link("Have an invitation or reset link?", () => { password.Clear(); Dialogs.PasswordSetup(owner, model); })), 10);
      } else {
        Ui.Add(stack, Ui.T("Enter your verification or recovery code."), 22);
        Ui.Add(stack, code, 12);
        code.Focus();
      }
      var back = Ui.Pill("Back", () => { password.Clear(); code.Clear(); model.Disconnect(); });
      var submit = Ui.Pill(model.MfaChallenge.Length == 0 ? "Sign In" : "Verify", Submit, true);
      submit.IsDefault = true;
      Ui.Add(stack, Ui.Spread(back, submit), 22);
      stack.IsEnabled = !model.Busy;
      Content = stack;
    }
    void Submit() {
      if (model.MfaChallenge.Length == 0) {
        var name = identifier.Text; var secret = password.Password; password.Clear();
        model.Run(() => model.SignIn(name, secret));
      } else {
        var value = code.Password; code.Clear();
        model.Run(() => model.VerifyMfa(value));
      }
    }
  }

  /// In-app first-run setup. The server decides the next step.
  public sealed class SetupView : UserControl, IRefresh {
    readonly AppModel model; readonly Window owner;
    readonly Dictionary<string, Control> fields = new Dictionary<string, Control>();
    string renderedKey;
    string provider = "";
    List<Wire> discovered = new List<Wire>();
    CheckBox enabled, recoverySaved;
    NewPassword ownerPassword;
    PasswordInput resumePassword;
    Button createOwner;
    public SetupView(AppModel model, Window owner) { this.model = model; this.owner = owner; Refresh(); }
    string Step { get { return model.SetupState["nextStep"].Text; } }
    Wire ProviderEntry { get { return model.SetupState["providerCatalog"].List.FirstOrDefault(p => p["kind"].Text == provider) ?? Wire.Null; } }

    public void Refresh() {
      var key = model.SetupState.Json + "|" + model.Recovery.Json + "|" + model.SetupReview.Json + "|" + provider + "|" + discovered.Count;
      if (key == renderedKey && Content != null) { ((FrameworkElement)((ScrollViewer)Content).Content).IsEnabled = !model.Busy; return; }
      if (renderedKey != null && !renderedKey.StartsWith(model.SetupState.Json)) { fields.Clear(); }
      renderedKey = key;
      var page = new StackPanel();
      Ui.Add(page, Ui.Heading("Set up Josi", "Everything stays inside the app. Your server determines the next step."), 0);
      var steps = Ui.Wrap(model.SetupState["steps"].List.Select(item => (UIElement)Ui.Row(5,
        Ui.Icon(item["done"].Flag ? Glyph.Check : Glyph.Circle, 12, item["id"].Text == Step ? Ui.Orange : Ui.Muted),
        Ui.T(item["title"].Text, 12, null, item["id"].Text == Step ? Ui.Orange : Ui.Muted))).ToArray());
      Ui.Add(page, steps, 24);
      if (!model.Recovery.IsNull) Ui.Add(page, RecoveryCard(), 24);
      else {
        var title = model.SetupState["steps"].List.Where(s => s["id"].Text == Step).Select(s => s["title"].Text).FirstOrDefault() ?? "Finish setup";
        var form = new StackPanel();
        Ui.Add(form, Ui.Title2(title), 0);
        foreach (var element in StepForm()) Ui.Add(form, element, 16);
        Ui.Add(page, Ui.CardBox(null, form), 24);
        if (!model.SetupReview.IsNull) {
          var items = model.SetupReview["items"].List.Select(item => (UIElement)Ui.Stack(4, Ui.Headline(item["label"].Text),
            Ui.T(item["statusLabel"].Text, 14, null, item["blocking"].Flag ? Ui.Orange : Ui.Muted),
            item["verification"]["detail"].Text.Length > 0 ? Ui.Caption(item["verification"]["detail"].Text) : null)).ToArray();
          Ui.Add(page, Ui.CardBox("Setup review", items), 24);
        }
      }
      Ui.Add(page, Ui.Row(10, Ui.Pill("Refresh Setup", () => model.Run(() => model.LoadSetup())),
        Ui.Pill("Disconnect", () => { fields.Clear(); model.Disconnect(); })), 24);
      page.IsEnabled = !model.Busy;
      Content = Ui.Scroll(page, 900, 32);
    }

    Control Get(string key, bool secret = false, string fallback = "") {
      Control control;
      if (!fields.TryGetValue(key, out control)) {
        control = secret ? (Control)Ui.Secret(key) : Ui.Input(null, fallback);
        fields[key] = control;
      }
      return control;
    }
    string Value(string key, string fallback = "") {
      Control control;
      if (!fields.TryGetValue(key, out control)) return fallback;
      var box = control as TextBox; if (box != null) return box.Text;
      var secret = control as PasswordBox; if (secret != null) return secret.Password;
      var combo = control as ComboBox; if (combo != null) return Ui.Selected(combo);
      return fallback;
    }
    FrameworkElement Field(string label, string key, bool secret = false, string fallback = "") {
      var control = Get(key, secret, fallback);
      if (control.Parent != null) ((Panel)LogicalTreeHelperParent(control)).Children.Remove(control);
      return Ui.Field(label, control);
    }
    static object LogicalTreeHelperParent(FrameworkElement element) { return element.Parent; }
    FrameworkElement Picker(string label, string key, string fallback, params string[] options) {
      Control control;
      if (!fields.TryGetValue(key, out control)) { control = Ui.Choice(Ui.Options(options), fallback); fields[key] = control; }
      if (control.Parent != null) ((Panel)control.Parent).Children.Remove(control);
      return Ui.Field(label, control);
    }
    Button Next(Func<object> body) { return Ui.Pill("Continue", () => Submit(body()), true); }

    IEnumerable<UIElement> StepForm() {
      var list = new List<UIElement>();
      switch (Step) {
        case "host_checks":
          foreach (var check in model.HostChecks)
            list.Add(Ui.Row(8, Ui.Icon(check["status"].Text == "pass" ? Glyph.Check : Glyph.Warning, 14, check["status"].Text == "pass" ? Ui.Green : Ui.Orange), Ui.T(check["label"].Text)));
          list.Add(Next(() => Wires.O()));
          break;
        case "owner":
          if (model.SetupState["ownerExists"].Flag) {
            list.Add(Ui.T("Sign in to resume your existing owner account."));
            list.Add(Field("Username or email", "identifier"));
            resumePassword = resumePassword ?? new PasswordInput("Password");
            Ui.Detach(resumePassword);
            list.Add(Ui.Field("Password", resumePassword));
            list.Add(Ui.Pill("Sign In and Continue", () => {
              var secret = resumePassword.Password; resumePassword.Clear();
              Submit(Wires.O("resumeOwner", true, "identifier", Value("identifier"), "password", secret));
            }, true));
          } else {
            list.Add(Field("Your name", "displayName")); list.Add(Field("Email", "email")); list.Add(Field("Username", "username"));
            if (ownerPassword == null) {
              ownerPassword = new NewPassword("Password");
              ownerPassword.Changed += delegate { if (createOwner != null) createOwner.IsEnabled = ownerPassword.Valid; };
            }
            Ui.Detach(ownerPassword);
            list.Add(ownerPassword);
            var create = Ui.Pill("Create Account", () => {
              if (!ownerPassword.Valid) return;
              var secret = ownerPassword.Password; ownerPassword.Clear();
              Submit(Wires.O("displayName", Value("displayName"), "email", Value("email"), "username", Value("username"),
                "password", secret, "timezone", IanaZone()));
            }, true);
            create.IsEnabled = ownerPassword.Valid;
            createOwner = create;
            list.Add(create);
          }
          break;
        case "domain":
          list.Add(Field("Server address or domain", "domain"));
          list.Add(Picker("HTTPS", "tlsMode", "bundled_caddy", "bundled_caddy", "Bundled Caddy", "external_proxy", "My own reverse proxy"));
          list.Add(Field("Certificate notification email", "acmeEmail"));
          list.Add(Next(() => Wires.O("domain", Value("domain"), "tlsMode", Value("tlsMode", "bundled_caddy"), "acmeEmail", Value("acmeEmail"))));
          break;
        case "llm":
          list.AddRange(ProviderForm());
          break;
        case "smtp":
          list.Add(Field("SMTP server", "host")); list.Add(Field("Port", "port", false, "587"));
          list.Add(Picker("Security", "security", "starttls", "starttls", "STARTTLS", "tls", "TLS", "none", "None"));
          list.Add(Field("Username", "username")); list.Add(Field("Password", "password", true));
          list.Add(Field("From name", "fromName", false, "Josi")); list.Add(Field("From address", "fromAddress"));
          list.Add(Field("Send a test email to", "testTo"));
          list.Add(Ui.Caption("Save and Test sends one email to the address above. Your mail password is saved in the server's Vault."));
          list.Add(Ui.Row(10,
            Ui.Pill("Save and Test", () => {
              int port; if (!int.TryParse(Value("port", "587"), out port)) port = 587;
              Submit(Wires.O("system", Wires.O("host", Value("host"), "port", port, "security", Value("security", "starttls"), "username", Value("username"),
                "password", Value("password"), "fromName", Value("fromName", "Josi"), "fromAddress", Value("fromAddress")),
                "communications", Wires.O("copyFromSystem", true, "fromName", "Josi", "fromAddress", Value("fromAddress")), "testTo", Value("testTo")));
            }, true),
            Ui.Pill("Skip for Now", () => Submit(Wires.O("skip", true)))));
          break;
        case "security":
          enabled = enabled ?? Ui.Toggle("Allow people to choose folders for Josi to read");
          list.Add(Detach(enabled)); list.Add(Ui.Secondary("Each person still needs to approve their own folders."));
          list.Add(Next(() => Wires.O("folderMappingEnabled", enabled.IsChecked == true)));
          break;
        case "telemetry":
          enabled = enabled ?? Ui.Toggle("Send anonymous usage counts");
          list.Add(Detach(enabled)); list.Add(Ui.Secondary("Optional. Does not include conversations, credentials or business content."));
          list.Add(Next(() => Wires.O("enabled", enabled.IsChecked == true)));
          break;
        case "review":
          list.Add(Ui.T("Review your saved settings below before continuing."));
          list.Add(Next(() => Wires.O()));
          break;
        case "":
          var finish = Ui.Pill("Finish Setup", () => model.Run(() => model.FinishSetup()), true);
          finish.IsEnabled = model.SetupReview["canComplete"].Flag;
          list.Add(finish);
          break;
        default:
          list.Add(Ui.T("This server requires a setup step this app does not yet support. Update Josi to continue."));
          break;
      }
      return list;
    }
    static UIElement Detach(FrameworkElement element) {
      var panel = element.Parent as Panel; if (panel != null) panel.Children.Remove(element);
      return element;
    }
    static string IanaZone() {
      // The server expects an IANA zone; Windows exposes a Windows zone ID.
      var id = TimeZoneInfo.Local.Id;
      var map = new Dictionary<string, string> {
        {"Pacific Standard Time", "America/Los_Angeles"}, {"Mountain Standard Time", "America/Denver"}, {"US Mountain Standard Time", "America/Phoenix"},
        {"Central Standard Time", "America/Chicago"}, {"Eastern Standard Time", "America/New_York"}, {"Alaskan Standard Time", "America/Anchorage"},
        {"Hawaiian Standard Time", "Pacific/Honolulu"}, {"GMT Standard Time", "Europe/London"}, {"W. Europe Standard Time", "Europe/Berlin"},
        {"Romance Standard Time", "Europe/Paris"}, {"Central European Standard Time", "Europe/Warsaw"}, {"Israel Standard Time", "Asia/Jerusalem"},
        {"Russian Standard Time", "Europe/Moscow"}, {"India Standard Time", "Asia/Kolkata"}, {"China Standard Time", "Asia/Shanghai"},
        {"Tokyo Standard Time", "Asia/Tokyo"}, {"AUS Eastern Standard Time", "Australia/Sydney"}, {"UTC", "UTC"}
      };
      string zone;
      return map.TryGetValue(id, out zone) ? zone : "UTC";
    }

    ModelSetupPanel setupModel;
    /// The same four-step model setup as the Models page, on the setup routes.
    /// The server saves and checks the model; setup then moves to its next step.
    IEnumerable<UIElement> ProviderForm() {
      if (setupModel == null) {
        setupModel = new ModelSetupPanel(model, owner, new ModelEndpoints(true), "primary", Wire.Null,
          model.SetupState["providerCatalog"].List, null, async body => { await model.SetupStep("llm", body); return false; });
        // A fixed height tied to the window: long steps scroll inside the
        // panel and Back/Continue stay visible at its bottom.
        Action fit = () => setupModel.Height = Math.Max(420, owner.ActualHeight - 400);
        owner.SizeChanged += delegate { fit(); };
        fit();
      }
      return new UIElement[] { setupModel };
    }
    UIElement RecoveryCard() {
      var key = model.Recovery["key"].Text; var fingerprint = model.Recovery["fingerprint"].Text;
      var shown = Ui.Copyable(key, 14, null, true); shown.Visibility = Visibility.Collapsed;
      var show = Ui.Toggle("Show recovery key");
      show.Checked += delegate { shown.Visibility = Visibility.Visible; }; show.Unchecked += delegate { shown.Visibility = Visibility.Collapsed; };
      recoverySaved = Ui.Toggle("I have saved my recovery key");
      var proceed = Ui.Pill("Continue", () => model.Run(() => model.ConfirmRecovery()), true);
      proceed.IsEnabled = false;
      recoverySaved.Checked += delegate { proceed.IsEnabled = true; }; recoverySaved.Unchecked += delegate { proceed.IsEnabled = false; };
      return Ui.CardBox("Save your Vault recovery key",
        Ui.T("Keep this key somewhere safe outside Josi. It can recover your Vault if the installation key is lost."),
        show, shown, Ui.Secondary("Fingerprint: " + fingerprint),
        Ui.Pill("Save Recovery Key…", () => { if (Dialogs.SaveRecoveryKey(owner, key, fingerprint)) recoverySaved.IsChecked = true; }),
        recoverySaved, proceed);
    }

    void Submit(object body) {
      var step = Step;
      // Clear credential fields before waiting on the request.
      var secrets = new List<string> { "password", "apiKey" };
      secrets.AddRange(ProviderEntry["fields"].List.Where(f => f["secret"].Flag).Select(f => f["key"].Text));
      foreach (var key in secrets) { Control c; if (fields.TryGetValue(key, out c)) { var p = c as PasswordBox; if (p != null) p.Clear(); } }
      model.Run(() => model.SetupStep(step, body));
    }
  }
}
