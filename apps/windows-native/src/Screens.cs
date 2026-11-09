using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace Josi.Native {
  /// The server on this PC, or one elsewhere that this PC is paired with.
  public sealed class ConnectView : UserControl, IRefresh {
    readonly AppModel model; readonly Window owner;
    /// Kept across redraws, so a failed connection leaves the address to correct.
    readonly TextBox address = Automation.Id(Ui.Input("https://josi.example.com"), "josi.welcome.address");
    readonly GhostView ghost;
    public ConnectView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      ghost = new GhostView(model.Ghost, 170);
      if (model.Address.Length > 0) address.Text = model.Address;
      Refresh();
    }
    public void Refresh() {
      var r = model.Receipt;
      Automation.BeginScope("welcome");
      // A fresh demo root (AUTOMATION.md): the server on this PC is installed but not set
      // up, so the page offers setup, and the button opens first-run setup in the app.
      var fresh = Automation.Demo && Automation.Fresh;
      var installed = r.Installed && !fresh;
      var local = Ui.CardBox(null,
        Ui.Row(10, Ui.Icon(Glyph.Desktop, 22, Ui.Text), Ui.T("On this PC", 21, FontWeights.Bold)),
        Ui.Secondary(installed ? "Your existing server is available here. Its accounts and data stay with it."
                               : fresh ? "Your server is installed and waiting for its first setup."
                               : "Set up a server here, or restore the data retained by your previous installation."),
        installed ? Ui.Caption("Version " + (r.Version.Length == 0 ? "unknown" : r.Version) + " · " + r.Detail) : null,
        installed ? Automation.Id(Ui.Pill("Open Josi", () => model.Run(async () => { model.Activity = "Connecting to the server on this PC…"; try { await model.Connect(r.Address, true); } finally { model.Activity = ""; } }), true), "josi.welcome.open")
          : fresh ? Automation.Id(Ui.Pill("Set Up on This PC", () => model.Run(async () => { model.Activity = "Opening setup on the server on this PC…"; try { await model.Connect(Automation.DemoAddress, true); } finally { model.Activity = ""; } }), true), "josi.welcome.setup")
                  : Automation.Id(Ui.Pill("Set Up on This PC…", () => ServerControls.ChooseInstaller(model, owner), true), "josi.welcome.setup"),
        new ServerControls(model, owner, true));
      var brand = Ui.Row(14, Ui.JosiMark(52), Ui.Stack(2, Ui.T("Josi", 28, FontWeights.SemiBold), Ui.Caption("Your assistant, on your own server.")));
      Ui.Detach(ghost);
      var page = Ui.Stack(28, Ui.Spread(Ui.Stack(28, brand, Ui.Heading("Welcome to Josi", "Your conversations, your work, your PC.")), ghost), Flags.ServerApp ? local : null,
        Flags.Relay ? Elsewhere() : Flags.ServerApp ? null : Direct(),
        Flags.ServerApp ? Ui.Secondary("Closing this window leaves your server running for your other devices.") : null);
      page.IsEnabled = !model.Busy;
      Automation.Id(this, "josi.welcome", "Welcome to Josi");
      Content = Ui.Scroll(page, 720, 36);
    }
    /// A server reached by its own address, with no relay in between.
    UIElement Direct() {
      Action connect = () => model.Run(async () => {
        var target = address.Text.Trim();
        model.Activity = "Connecting to " + target + "…";
        try { await model.Connect(target); } finally { model.Activity = ""; }
      });
      address.KeyDown += (s, e) => { if (e.Key == Key.Enter) { e.Handled = true; connect(); } };
      return Ui.CardBox(null,
        Ui.Row(10, Ui.Icon(Glyph.Network, 22, Ui.Text), Ui.T("Connect to your server", 21, FontWeights.Bold)),
        Ui.Secondary("Enter your server's HTTPS address, or an HTTP localhost address for a server on this PC."),
        Ui.Field("Server address", address),
        Automation.Id(Ui.Pill("Connect", connect, true), "josi.welcome.connect"));
    }
    UIElement Elsewhere() {
      var paired = TunnelStore.Current.All();
      var items = new List<UIElement> {
        Ui.Row(10, Ui.Icon(Glyph.Network, 22, Ui.Text), Ui.T("On another computer", 21, FontWeights.Bold)),
        Ui.Secondary("Pair this PC with your server to reach it from anywhere. Only your server can read what's sent.")
      };
      foreach (var server in paired) {
        var chosen = server;
        var name = string.IsNullOrEmpty(server.Label) ? new Uri(server.Origin).Host : server.Label;
        items.Add(Ui.Spread(Ui.T(name), Ui.Row(8,
          Automation.Id(Ui.Pill("Open", () => model.Run(async () => { model.Activity = "Connecting to " + name + "…"; try { await model.ConnectPaired(chosen); } finally { model.Activity = ""; } }), true), "josi.welcome.paired.open"),
          Automation.Id(Ui.Pill("Forget…", () => {
            if (Dialogs.Confirm(owner, "Forget " + name + "?", "This PC will need a new pairing code to reach it again. You can remove this PC on your server too.", "Forget")) model.ForgetPairing(chosen);
          }), "josi.welcome.paired.forget"))));
      }
      items.Add(Automation.Id(Ui.Pill("Pair This PC…", () => Dialogs.PairServer(owner, model), paired.Count == 0), "josi.welcome.pair"));
      return Ui.CardBox(null, items.ToArray());
    }
  }

  /// Local hosting controls. Every change goes through Windows UAC.
  public sealed class ServerControls : UserControl {
    public ServerControls(AppModel model, Window owner, bool compact) {
      var r = model.Receipt;
      var stack = new StackPanel();
      Action<string, string, string> confirm = (operation, title, detail) => {
        if (Dialogs.Confirm(owner, title, detail, "Continue")) model.Run(() => model.Operate(operation));
      };
      // One row of controls, grouped: lifecycle, then maintenance, then status.
      var buttons = Ui.Wrap();
      if (r.Installed && !r.Development) {
        buttons.Children.Add(Ui.Pill("Start", () => model.Run(() => model.Operate("start"))));
        buttons.Children.Add(Ui.Pill("Stop…", () => confirm("stop", "Stop the server on this PC?", "Connected devices will lose access until you start the server again.")));
        buttons.Children.Add(Ui.Pill("Restart…", () => confirm("restart", "Restart the server on this PC?", "Connected devices lose access briefly. Keep the app open until the operation finishes.")));
        buttons.Children.Add(Ui.Pill("Update or Repair Server…", () => ChooseInstaller(model, owner)));
      }
      buttons.Children.Add(Ui.Pill("Refresh Status", model.RefreshLocal));
      var status = Automation.Id(Ui.T(r.Installed ? r.Address + " · " + (r.Version.Length == 0 ? "version unknown" : r.Version) + " · " + r.Detail : "Local server is not installed."), "josi." + Automation.Scope + ".server-status");
      if (compact) {
        Ui.Add(stack, status, 0);
        if (r.Development) Ui.Add(stack, Ui.Caption("This development server runs from source under your Windows account. Start and stop it with scripts/windows/dev/Start-DevServer.ps1 and Stop-DevServer.ps1."), 10);
        Ui.Add(stack, buttons, 12);
      } else {
        var items = new List<UIElement> { status };
        if (r.Development) items.Add(Ui.Caption("This development server runs from source under your Windows account. Start and stop it with scripts/windows/dev/Start-DevServer.ps1 and Stop-DevServer.ps1."));
        items.Add(buttons);
        if (r.Installed && !r.Development) items.Add(Ui.Caption("Updates use the existing recovery-copy and migration process of the Josi CE installer. Windows will ask for administrator approval."));
        Ui.Add(stack, Ui.CardBox("Server on this PC", items.ToArray()), 0);
        Ui.Add(stack, Ui.CardBox("Remove Josi from this PC",
          Ui.Caption("Uninstalling keeps your retained data and recovery files unless the installer explicitly asks otherwise."),
          Ui.Pill("Open Installed Apps to Uninstall…", () => {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ms-settings:appsfeatures") { UseShellExecute = true }); }
            catch (Exception) { model.Error = "Windows Settings could not be opened."; model.Notify(); }
          })), Ui.PageSpacing);
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
    readonly GhostView ghost;
    readonly TextBox identifier = Ui.Input("Username or email");
    readonly PasswordInput password = new PasswordInput("Password");
    readonly PasswordBox code = Ui.Secret("Verification code");
    string shown;
    public LoginView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      ghost = new GhostView(model.Ghost, 130);
      identifier.Text = model.RememberedIdentifier;
      password.Submitted += Submit;
      code.KeyDown += (s, e) => { if (e.Key == Key.Enter) Submit(); };
      Refresh();
      Loaded += async delegate {
        if (identifier.Text.Length > 0) password.Focus(); else identifier.Focus();
        await model.LoadSignInOptions();
      };
    }
    public void Refresh() {
      var key = model.MfaChallenge + "|" + model.GoogleSignIn + "|" + model.GoogleWaiting;
      if (shown == key && Content != null) { ((FrameworkElement)Content).IsEnabled = !model.Busy; return; }
      shown = key;
      Automation.BeginScope("login");
      Automation.Id(this, "josi.login", "Sign in to Josi");
      Automation.Id(identifier, "josi.login.identifier"); Automation.Id(password, "josi.login.password"); Automation.Id(code, "josi.login.code");
      var stack = new StackPanel { MaxWidth = 580, Margin = new Thickness(36), VerticalAlignment = VerticalAlignment.Center };
      Ui.Detach(ghost);
      ghost.HorizontalAlignment = HorizontalAlignment.Left;
      Ui.Add(stack, ghost, 0);
      Ui.Add(stack, Ui.Row(14, Ui.JosiMark(44), Ui.Heading("Sign in to Josi", model.Address)), 10);
      if (model.MfaChallenge.Length == 0) {
        Ui.Detach(identifier); Ui.Detach(password);
        Ui.Add(stack, Ui.Field("Username or email", identifier), 22);
        Ui.Add(stack, Ui.Field("Password", password), 14);
        Ui.Add(stack, Ui.Row(18,
          Automation.Id(Ui.Link("Forgot password?", () => { password.Clear(); Dialogs.ForgotPassword(owner, model, identifier.Text.Trim()); }), "josi.login.forgot"),
          Automation.Id(Ui.Link("Have an invitation or reset link?", () => { password.Clear(); Dialogs.PasswordSetup(owner, model); }), "josi.login.reset-link")), 10);
        if (model.GoogleWaiting) {
          Ui.Add(stack, Ui.Working("Finish signing in with Google in your browser.", true), 22);
          Ui.Add(stack, Ui.Row(14, Ui.Caption("Josi continues when Google sends you back."), Ui.Link("Cancel", model.CancelGoogle)), 6);
        } else if (model.GoogleSignIn) {
          var google = Automation.Id(Ui.Pill("Sign in with Google", () => model.Run(() => model.StartGoogle())), "josi.login.google");
          google.HorizontalAlignment = HorizontalAlignment.Stretch;
          Ui.Add(stack, Ui.T("or", 13, null, Ui.Muted), 18);
          Ui.Add(stack, google, 10);
          Ui.Add(stack, Ui.Caption("For a Google account connected to your Josi account under Connections."), 6);
        }
      } else {
        Ui.Add(stack, Ui.T("Enter your verification or recovery code."), 22);
        Ui.Add(stack, code, 12);
        code.Focus();
      }
      var back = Automation.Id(Ui.Pill("Back", () => { password.Clear(); code.Clear(); model.Disconnect(); }), "josi.login.back");
      var submit = Automation.Id(Ui.Pill(model.MfaChallenge.Length == 0 ? "Sign In" : "Verify", Submit, true), "josi.login.submit");
      submit.IsDefault = true;
      Ui.Add(stack, Ui.Spread(back, submit), 22);
      stack.IsEnabled = !model.Busy;
      Content = stack;
    }
    void Submit() {
      if (model.MfaChallenge.Length == 0) {
        var name = identifier.Text; var secret = password.Password; password.Clear();
        model.Run(async () => { model.Activity = "Signing in to " + model.Address + "…"; try { await model.SignIn(name, secret); } finally { model.Activity = ""; } });
      } else {
        var value = code.Password; code.Clear();
        model.Run(async () => { model.Activity = "Checking your code…"; try { await model.VerifyMfa(value); } finally { model.Activity = ""; } });
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
    CheckBox enabled, recoverySaved, pcEnable;
    NewPassword ownerPassword;
    PasswordInput resumePassword;
    Button createOwner;
    string where = "pc", ownerEmail = "";
    readonly GhostView ghost;
    public SetupView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      ghost = new GhostView(model.Ghost, 130);
      Refresh();
    }
    /// The server decides the steps; these are the words the person reads.
    static readonly Dictionary<string, string[]> Words = new Dictionary<string, string[]> {
      {"host_checks", new[] {"Checking this PC", "A quick look to make sure everything Josi needs is here."}},
      {"owner", new[] {"First, who are you?", "This is the account that runs this Josi. You can invite other people later."}},
      {"domain", new[] {"Where will you use Josi?", "This decides which devices can reach her. You can change it later."}},
      {"llm", new[] {"Pick Josi's brain", "The AI model she thinks with. Your subscription or your own key both work."}},
      {"smtp", new[] {"Email, if you want it", "Lets Josi send invitations and password resets. You can skip this for now."}},
      {"security", new[] {"Your folders", "Choose whether people here may give Josi access to folders."}},
      {"pc_control", new[] {"Let Josi use this PC", "Commands, programs, files and windows on this computer, with your permission for each. You can skip this."}},
      {"telemetry", new[] {"Help improve Josi", "Completely optional, and it never includes your conversations."}},
      {"review", new[] {"Almost there", "One last look at what you chose."}},
      {"", new[] {"All set", "Josi is ready when you are."}},
    };
    /// The step the server expects next.
    string ServerStep { get { return model.SetupState["nextStep"].Text; } }
    /// An earlier step the person went Back to, or null for the server's step.
    string viewing;
    string Step { get { return viewing ?? ServerStep; } }
    /// The server lets only these finished steps be submitted again (REVISABLE_STEPS
    /// in apps/api/src/setup/steps.ts); the rest are shown as already saved.
    static readonly string[] Revisable = { "llm", "smtp" };
    bool Done(string step) { return model.SetupState["steps"].List.Any(s => s["id"].Text == step && s["done"].Flag); }
    /// Back and Next between steps. Next only walks back towards the server's step.
    UIElement StepNavigation(List<Wire> all, int position) {
      var index = position < 0 ? all.Count : position;
      var back = Automation.Id(Ui.Pill("Back", () => { viewing = all[index - 1]["id"].Text; Refresh(); }), "josi.setup.back");
      back.IsEnabled = index > 0;
      if (viewing == null) return back;
      var forward = Automation.Id(Ui.Pill("Next Step", () => {
        var next = index + 1 < all.Count ? all[index + 1]["id"].Text : null;
        viewing = next == null || next == ServerStep || !Done(next) ? null : next;
        Refresh();
      }), "josi.setup.next");
      return Ui.Row(10, back, forward);
    }
    Wire ProviderEntry { get { return model.SetupState["providerCatalog"].List.FirstOrDefault(p => p["kind"].Text == provider) ?? Wire.Null; } }

    public void Refresh() {
      // A step the server no longer lists, or one it now expects anyway, ends the look back.
      if (viewing != null && (viewing == ServerStep || !Done(viewing))) viewing = null;
      var key = model.SetupState.Json + "|" + model.Recovery.Json + "|" + model.SetupReview.Json + "|" + provider + "|" + discovered.Count + "|" + where + "|" + viewing;
      if (key == renderedKey && Content != null) { ((FrameworkElement)((ScrollViewer)Content).Content).IsEnabled = !model.Busy; return; }
      if (renderedKey != null && !renderedKey.StartsWith(model.SetupState.Json)) { fields.Clear(); }
      renderedKey = key;
      Automation.BeginScope("setup");
      Automation.Id(this, "josi.setup", "Set up Josi");
      var page = new StackPanel();
      Ui.Detach(ghost);
      string[] words; if (!Words.TryGetValue(Step, out words)) words = new[] { "Set up Josi", "" };
      var all = model.SetupState["steps"].List;
      var position = all.FindIndex(s => s["id"].Text == Step);
      var count = position < 0 ? "" : "Step " + (position + 1) + " of " + all.Count;
      Ui.Add(page, Ui.Spread(Ui.Stack(6, Ui.Row(12, Ui.JosiMark(40), Ui.Caption(count)), Ui.Heading(words[0], words[1])), ghost), 0);
      var steps = Ui.Wrap(model.SetupState["steps"].List.Select(item => (UIElement)Ui.Row(5,
        Ui.Icon(item["done"].Flag ? Glyph.Check : Glyph.Circle, 12, item["id"].Text == Step ? Ui.Accent : Ui.Muted),
        Ui.T(item["title"].Text, 12, null, item["id"].Text == Step ? Ui.Accent : Ui.Muted))).ToArray());
      Ui.Add(page, steps, 24);
      if (model.Recovery.IsNull) Ui.Add(page, StepNavigation(all, position), 16);
      if (!model.Recovery.IsNull) Ui.Add(page, RecoveryCard(), 24);
      else {
        var form = new StackPanel();
        foreach (var element in StepForm()) Ui.Add(form, element, 16);
        Ui.Add(page, Ui.CardBox(null, form), 24);
        if (!model.SetupReview.IsNull) {
          var items = model.SetupReview["items"].List.Select(item => (UIElement)Ui.Stack(4, Ui.Headline(item["label"].Text),
            Ui.T(item["statusLabel"].Text, 14, null, item["blocking"].Flag ? Ui.Accent : Ui.Muted),
            item["verification"]["detail"].Text.Length > 0 ? Ui.Caption(item["verification"]["detail"].Text) : null)).ToArray();
          Ui.Add(page, Ui.CardBox("Setup review", items), 24);
        }
      }
      // A brand-new server can come back from a backup instead of being set
      // up from nothing; the server refuses this once an owner exists.
      if (!model.SetupState["ownerExists"].Flag) Ui.Add(page, Ui.CardBox("Already have a Josi backup?",
        Ui.Caption("Restore it here and skip setup: people, conversations, settings and connections come back. Saved logins also need the old server's installation master key, copied separately."),
        Ui.Pill("Restore from a Backup…", () => model.Run(async () => {
          model.Activity = "Choosing a backup…";
          try {
            var result = await BackupFlows.RestoreFromFile(model, owner, true, text => { model.Activity = text; model.Notify(); }, () => false);
            if (result != null) { Dialogs.Message(owner, "Restored", result); await model.LoadSetup(); }
          } finally { model.Activity = ""; }
        }))), 24);
      Ui.Add(page, Ui.Row(10, Ui.Pill("Refresh Setup", () => model.Run(() => model.LoadSetup())),
        Ui.Pill("Disconnect", () => { fields.Clear(); model.Disconnect(); })), 24);
      page.IsEnabled = !model.Busy;
      Content = Ui.Scroll(page, 760, 32);
      Fill(page);
    }

    /// The setup column grows with the window and stays centered in it, instead
    /// of a fixed 760-pixel strip on the left of a wide window.
    bool filling;
    FrameworkElement filled;
    void Fill(FrameworkElement page) {
      filled = page;
      page.HorizontalAlignment = HorizontalAlignment.Center;
      if (!filling) { filling = true; owner.SizeChanged += delegate { Fit(); }; }
      Fit();
    }
    void Fit() {
      if (filled == null) return;
      var width = owner.ActualWidth > 0 ? owner.ActualWidth : owner.Width;
      filled.MaxWidth = Math.Max(640, Math.Min(1180, width - 140));
    }

    Control Get(string key, bool secret = false, string fallback = "") {
      Control control;
      if (!fields.TryGetValue(key, out control)) {
        control = secret ? (Control)Ui.Secret(key) : Ui.Input(null, fallback);
        // Fixed ids by the server's field key (josi.setup.displayName, josi.setup.host, ...).
        Automation.Id(control, "josi.setup." + key);
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
      if (!fields.TryGetValue(key, out control)) { control = Automation.Id(Ui.Choice(Ui.Options(options), fallback), "josi.setup." + key); fields[key] = control; }
      if (control.Parent != null) ((Panel)control.Parent).Children.Remove(control);
      return Ui.Field(label, control);
    }
    Button Next(Func<object> body) { return Automation.Id(Ui.Pill("Continue", () => Submit(body()), true), "josi.setup.continue"); }

    IEnumerable<UIElement> StepForm() {
      var list = new List<UIElement>();
      if (viewing != null && !Revisable.Contains(viewing)) {
        // The server keeps these once saved: the owner account and the consent
        // choices must not be replayable. They change in Settings after setup.
        list.Add(Ui.T("You've already done this step, and it's saved."));
        list.Add(Ui.Secondary(viewing == "owner"
          ? "Your account is set. You can change your name, email and password in Settings once setup is finished."
          : viewing == "host_checks" ? "Everything Josi needs was here."
          : "You can change this in Settings once setup is finished."));
        list.Add(Automation.Id(Ui.Pill("Continue Where I Left Off", () => { viewing = null; Refresh(); }, true), "josi.setup.resume"));
        return list;
      }
      switch (Step) {
        case "host_checks":
          foreach (var check in model.HostChecks)
            list.Add(Ui.Row(8, Ui.Icon(check["status"].Text == "pass" ? Glyph.Check : Glyph.Warning, 14, check["status"].Text == "pass" ? Ui.Green : Ui.Error), Ui.T(check["label"].Text)));
          list.Add(Next(() => Wires.O()));
          break;
        case "owner":
          if (model.SetupState["ownerExists"].Flag) {
            list.Add(Ui.T("Sign in to resume your existing owner account."));
            list.Add(Field("Username or email", "identifier"));
            resumePassword = resumePassword ?? new PasswordInput("Password");
            Ui.Detach(resumePassword);
            list.Add(Ui.Field("Password", resumePassword));
            resumePassword.SetId("josi.setup.resume-password");
            list.Add(Automation.Id(Ui.Pill("Sign In and Continue", () => {
              var secret = resumePassword.Password; resumePassword.Clear();
              Submit(Wires.O("resumeOwner", true, "identifier", Value("identifier"), "password", secret));
            }, true), "josi.setup.sign-in"));
          } else {
            list.Add(Field("Your name", "displayName")); list.Add(Field("Username", "username")); list.Add(Field("Email", "email"));
            list.Add(Ui.Caption("You sign in with your username or email. Password resets go to that email."));
            foreach (var name in new[] { "displayName", "username", "email" }) {
              var box = (TextBox)fields[name];
              box.TextChanged -= OwnerEdited; box.TextChanged += OwnerEdited;
            }
            if (ownerPassword == null) {
              ownerPassword = new NewPassword("Password");
              ownerPassword.SetId("josi.setup.password");
              ownerPassword.Changed += delegate { OwnerEdited(null, null); };
            }
            Ui.Detach(ownerPassword);
            list.Add(ownerPassword);
            var create = Ui.Pill("Create Account", () => {
              if (!OwnerReady) return;
              var secret = ownerPassword.Password; ownerPassword.Clear();
              ownerEmail = Value("email").Trim();
              Submit(Wires.O("displayName", Value("displayName"), "email", Value("email"), "username", Value("username"),
                "password", secret, "timezone", TimeZones.Local()));
            }, true);
            Automation.Id(create, "josi.setup.create-account");
            create.IsEnabled = OwnerReady;
            createOwner = create;
            list.Add(create);
          }
          break;
        case "domain":
          list.Add(Automation.Id(Ui.Segments(Ui.Options("pc", "Just this PC", "network", "Home or office network", "domain", "My own domain"), where, v => { where = v; Refresh(); }), "josi.setup.where"));
          if (where == "pc") list.Add(Ui.Secondary("Josi answers on this PC only. It's the simplest start, and nothing is reachable from outside."));
          else if (where == "network") {
            list.Add(Field("This PC's address on your network", "lanAddress", false, LocalAddress()));
            list.Add(Ui.Secondary("Phones and computers on the same Wi-Fi or network reach Josi here. Nothing is reachable from the internet."));
          } else {
            list.Add(Field("Your domain", "publicDomain"));
            list.Add(Ui.Secondary("For example josi.yourname.com. Reach Josi from anywhere, with HTTPS."));
            list.Add(Picker("HTTPS", "tlsMode", "bundled_caddy", "bundled_caddy", "Josi sets it up for me (recommended)", "external_proxy", "I run my own reverse proxy"));
            list.Add(Field("Email for certificate notices", "acmeEmail", false, ownerEmail));
            list.Add(Ui.Caption("Before you continue: point your domain's DNS at this server, and open ports 80 and 443. Josi can't get a certificate until both are done."));
          }
          list.Add(Automation.Id(Ui.Pill("Continue", SubmitWhere, true), "josi.setup.continue"));
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
            Automation.Id(Ui.Pill("Save and Test", () => {
              int port; if (!int.TryParse(Value("port", "587"), out port)) port = 587;
              Submit(Wires.O("system", Wires.O("host", Value("host"), "port", port, "security", Value("security", "starttls"), "username", Value("username"),
                "password", Value("password"), "fromName", Value("fromName", "Josi"), "fromAddress", Value("fromAddress")),
                "communications", Wires.O("copyFromSystem", true, "fromName", "Josi", "fromAddress", Value("fromAddress")), "testTo", Value("testTo")));
            }, true), "josi.setup.smtp.save"),
            Automation.Id(Ui.Pill("Skip for Now", () => Submit(Wires.O("skip", true))), "josi.setup.smtp.skip")));
          break;
        case "security":
          enabled = enabled ?? Automation.Id(Ui.Toggle("Allow people to choose folders for Josi to read"), "josi.setup.enabled");
          list.Add(Detach(enabled)); list.Add(Ui.Secondary("Each person still needs to approve their own folders."));
          list.Add(Next(() => Wires.O("folderMappingEnabled", enabled.IsChecked == true)));
          break;
        case "pc_control":
          list.Add(Ui.T("Josi can work on this PC the way an assistant at the keyboard would: run commands and scripts, open programs, read and write files and use windows. Every action goes through PC Control: you choose which shells, folders and programs are allowed, once or until revoked, and a control bar with Stop is always visible while it works."));
          pcEnable = pcEnable ?? Automation.Id(Ui.Toggle("Let Josi use this PC now: programs, files and windows. Commands ask once per folder.", true), "josi.setup.pc-enable");
          list.Add(Detach(pcEnable));
          list.Add(Ui.Secondary("Approving pairs this PC to your account with the key it just made; your new password confirms it. Deleting, purchases, credentials, installs, security changes and administrator prompts always ask. Change any of this later in PC Control or by asking Josi."));
          list.Add(Ui.Row(10,
            Automation.Id(Ui.Pill("Approve This PC and Continue", () => {
              var ownerId = model.SetupState["ownerId"].Text; var api = model.Api;
              if (api == null || !Wires.IsUuid(ownerId)) { model.Error = "Create your account first."; model.Notify(); return; }
              bool hardware; var point = PcAuthority.PublicPointFor(api.OriginText, ownerId, out hardware);
              var password = Dialogs.AskPassword(owner, "Approve computer control on " + Environment.MachineName,
                "PC: " + JosiApi.DeviceId + "\nKey: " + ProtectedWire.Digest(point).Substring(0, 24) + "\n" + (hardware ? "Windows hardware key" : "Windows protected software key") + "\n\nEnter the password of the account you just created.", "Approve this PC");
              if (password == null) return;
              Submit(Wires.O("pcId", JosiApi.DeviceId, "publicKey", point, "password", password, "enable", pcEnable.IsChecked == true));
            }, true), "josi.setup.pc-approve"),
            Automation.Id(Ui.Pill("Skip for Now", () => Submit(Wires.O("skip", true))), "josi.setup.pc-skip")));
          break;
        case "telemetry":
          enabled = enabled ?? Automation.Id(Ui.Toggle("Send anonymous usage counts"), "josi.setup.enabled");
          list.Add(Detach(enabled)); list.Add(Ui.Secondary("Optional. Does not include conversations, credentials or business content."));
          list.Add(Next(() => Wires.O("enabled", enabled.IsChecked == true)));
          break;
        case "review":
          list.Add(Ui.T("Review your saved settings below before continuing."));
          list.Add(Next(() => Wires.O()));
          break;
        case "":
          var finish = Automation.Id(Ui.Pill("Finish Setup", () => model.Run(() => model.FinishSetup()), true), "josi.setup.finish");
          finish.IsEnabled = model.SetupReview["canComplete"].Flag;
          list.Add(finish);
          break;
        default:
          list.Add(Ui.T("This server requires a setup step this app does not yet support. Update Josi to continue."));
          break;
      }
      return list;
    }
    bool OwnerReady {
      get {
        return Value("displayName").Trim().Length > 0 && Value("username").Trim().Length > 0
          && System.Text.RegularExpressions.Regex.IsMatch(Value("email").Trim(), @"^[^@\s]+@[^@\s]+\.[^@\s]+$")
          && ownerPassword != null && ownerPassword.Valid;
      }
    }
    void OwnerEdited(object sender, EventArgs e) { if (createOwner != null) createOwner.IsEnabled = OwnerReady; }

    /// People paste whole addresses. The server wants only the host.
    static string HostOnly(string text) {
      var host = System.Text.RegularExpressions.Regex.Replace((text ?? "").Trim().ToLowerInvariant(), @"^[a-z]+://", "");
      return host.Split('/')[0].Split(':')[0];
    }
    void SubmitWhere() {
      if (where == "pc") { Submit(Wires.O("domain", "localhost", "tlsMode", "bundled_caddy", "acmeEmail", "")); return; }
      var host = HostOnly(Value(where == "network" ? "lanAddress" : "publicDomain"));
      if (where == "network") {
        if (host.Length == 0) { model.Error = "Enter this PC's address on your network."; model.Notify(); return; }
        Submit(Wires.O("domain", host, "tlsMode", "bundled_caddy", "acmeEmail", ""));
        return;
      }
      System.Net.IPAddress numeric;
      if (!host.Contains(".") || System.Net.IPAddress.TryParse(host, out numeric)) { model.Error = "Enter a domain name, like josi.yourname.com."; model.Notify(); return; }
      Submit(Wires.O("domain", host, "tlsMode", Value("tlsMode", "bundled_caddy"), "acmeEmail", Value("acmeEmail").Trim()));
    }
    /// This PC's address on the local network, as a starting suggestion.
    static string LocalAddress() {
      try {
        foreach (var card in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()) {
          if (card.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up || card.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;
          var properties = card.GetIPProperties();
          if (properties.GatewayAddresses.Count == 0) continue;
          foreach (var address in properties.UnicastAddresses)
            if (address.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) return address.Address.ToString();
        }
      } catch (Exception) { }
      return "";
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
          model.SetupState["providerCatalog"].List, null, async body => {
            var check = await model.SetupStep("llm", body);
            if (!check.IsNull && check["status"].Text == "passed") { viewing = null; Refresh(); }
            // Passing moves setup to its next step. Otherwise show why, with
            // Change Settings, instead of returning silently to the same step.
            if (!check.IsNull && check["status"].Text != "passed") {
              var probe = check["probe"];
              setupModel.ShowResult(new Wire(Wires.O(
                "provider", Wires.O("active", false, "capabilities", probe["capabilities"].IsNull ? null : probe["capabilities"].Raw),
                "result", Wires.O("steps", probe["steps"].IsNull ? new List<object>() : probe["steps"].Raw,
                  "fatal", check["detail"].Text.Length > 0 ? check["detail"].Text : "The model did not pass its check."))));
            }
            return false;
          });
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
      var shown = Automation.Id(Ui.Copyable(key, 14, null, true), "josi.setup.recovery.key"); shown.Visibility = Visibility.Collapsed;
      var show = Automation.Id(Ui.Toggle("Show recovery key"), "josi.setup.recovery.show");
      show.Checked += delegate { shown.Visibility = Visibility.Visible; }; show.Unchecked += delegate { shown.Visibility = Visibility.Collapsed; };
      recoverySaved = Automation.Id(Ui.Toggle("I have saved my recovery key"), "josi.setup.recovery.saved");
      var proceed = Automation.Id(Ui.Pill("Continue", () => model.Run(() => model.ConfirmRecovery()), true), "josi.setup.recovery.continue");
      proceed.IsEnabled = false;
      recoverySaved.Checked += delegate { proceed.IsEnabled = true; }; recoverySaved.Unchecked += delegate { proceed.IsEnabled = false; };
      return Ui.CardBox("Save your Vault recovery key",
        Ui.T("Keep this key somewhere safe outside Josi. It can recover your Vault if the installation key is lost."),
        show, shown, Ui.Secondary("Fingerprint: " + fingerprint),
        Automation.Id(Ui.Pill("Save Recovery Key…", () => { if (Dialogs.SaveRecoveryKey(owner, key, fingerprint)) recoverySaved.IsChecked = true; }), "josi.setup.recovery.save"),
        recoverySaved, proceed);
    }

    void Submit(object body) {
      var step = Step;
      // Clear credential fields before waiting on the request.
      var secrets = new List<string> { "password", "apiKey" };
      secrets.AddRange(ProviderEntry["fields"].List.Where(f => f["secret"].Flag).Select(f => f["key"].Text));
      foreach (var key in secrets) { Control c; if (fields.TryGetValue(key, out c)) { var p = c as PasswordBox; if (p != null) p.Clear(); } }
      // A changed earlier step returns to where setup left off once it's saved.
      model.Run(async () => { await model.SetupStep(step, body); viewing = null; Refresh(); });
    }
  }
}
