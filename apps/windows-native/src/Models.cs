using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace Josi.Native {
  /// Where model settings live: the administrator routes after setup, or the
  /// first-run setup routes (which the server removes once setup completes).
  public sealed class ModelEndpoints {
    public readonly bool Setup;
    public ModelEndpoints(bool setup) { Setup = setup; }
    public string Discover { get { return Setup ? "/setup/models" : "/admin/llm/models"; } }
    public string Codex { get { return Setup ? "/setup/subscription" : "/admin/llm/subscription"; } }
    public string Claude { get { return Codex + "/claude"; } }
    public async Task<Wire> Status(JosiApi api, string provider) {
      if (Setup) {
        var all = await api.Request("/setup/subscription");
        return provider == "anthropic_subscription" ? all["claudeCli"] : all["cli"];
      }
      return (await api.Request((provider == "anthropic_subscription" ? Claude : Codex) + "/status"))["cli"];
    }
  }

  static class ModelText {
    public static bool Subscription(string kind) { return kind == "openai_subscription" || kind == "anthropic_subscription"; }
    public static string PlanName(string kind) { return kind == "anthropic_subscription" ? "Claude" : "ChatGPT"; }
    public static Wire Entry(IEnumerable<Wire> catalog, string kind) { return catalog.FirstOrDefault(c => c["kind"].Text == kind) ?? Wire.Null; }
    public static UIElement Chip(string text, Brush brush) {
      return new Border { Background = Ui.Raised, CornerRadius = new CornerRadius(11), Padding = new Thickness(9, 3, 9, 3), Margin = new Thickness(0, 0, 6, 6),
        Child = Ui.T(text, 12, FontWeights.Medium, brush) };
    }
    public static UIElement Pill(string text, bool good) {
      var color = good ? Ui.Green : Ui.Orange;
      return new Border { Background = Ui.OrangeFaint, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 5, 10, 5), VerticalAlignment = VerticalAlignment.Center,
        Child = Ui.Row(6, new System.Windows.Shapes.Ellipse { Width = 7, Height = 7, Fill = color }, Ui.T(text, 12, FontWeights.SemiBold, color)) };
    }
    public static UIElement Capabilities(Wire caps) {
      var wrap = new WrapPanel();
      if (caps.IsNull) return wrap;
      Action<string, string> add = (key, label) => wrap.Children.Add(Chip((caps[key].Flag ? "✓ " : "✗ ") + label, caps[key].Flag ? Ui.Green : Ui.Muted));
      add("chat", "Chat"); add("toolCalling", "Tools"); add("vision", "Images"); add("structuredOutput", "Structured answers");
      if (caps["contextTokens"].Integer > 0) wrap.Children.Add(Chip(caps["contextTokens"].Integer.ToString("N0", CultureInfo.CurrentCulture) + " token context", Ui.Muted));
      return wrap;
    }
    public static UIElement Steps(IEnumerable<Wire> steps) {
      var stack = new StackPanel();
      foreach (var step in steps) {
        var passed = step["passed"].Flag;
        var line = Ui.Row(8, Ui.Icon(passed ? Glyph.Check : Glyph.Warning, 13, passed ? Ui.Green : Ui.Orange),
          Ui.T(step["label"].Text, 13.5, FontWeights.Medium));
        Ui.Add(stack, line, 6);
        if (step["detail"].Text.Length > 0) { var detail = Ui.Copyable(step["detail"].Text, 12.5, Ui.Muted); detail.Margin = new Thickness(21, 2, 0, 0); Ui.Add(stack, detail, 0); }
      }
      return stack;
    }
    public static void Open(Uri uri) {
      // Automated UI tests must never open the tester's browser.
      if (Environment.GetEnvironmentVariable("JOSI_TEST_NO_BROWSER") == "1") return;
      try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch (Exception) { }
    }
  }

  /// Connects the server's ChatGPT or Claude subscription without leaving the
  /// app. ChatGPT: the server runs OpenAI's device sign-in; the person approves
  /// a one-time code. Claude: this app runs Anthropic's signed `claude
  /// setup-token` privately and hands the resulting token to the Vault.
  public sealed class SubscriptionSignIn : UserControl {
    readonly AppModel model; readonly Window owner; readonly ModelEndpoints endpoints; readonly string provider;
    readonly ContentControl body = new ContentControl { Focusable = false };
    readonly DispatcherTimer poll = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
    Wire status = Wire.Null, login = Wire.Null;
    string error = "", stage = "";
    ClaudeSetupToken claude;
    Uri claudePage;
    readonly TextBox claudeCode = Ui.Input("Paste the code from Claude's page");
    readonly PasswordBox manualToken = Ui.Secret("Claude subscription token");
    bool openedChallenge, manual, submitting;
    public event Action<Wire> StatusChanged;
    public bool SignedIn { get { return status["signedIn"].Flag; } }

    public SubscriptionSignIn(AppModel model, Window owner, ModelEndpoints endpoints, string provider) {
      this.model = model; this.owner = owner; this.endpoints = endpoints; this.provider = provider;
      Content = body;
      poll.Tick += async delegate { await PollLogin(); };
      Loaded += async delegate { model.Changed += SyncEnabled; SyncEnabled(); await Refresh(); };
      Unloaded += delegate {
        model.Changed -= SyncEnabled;
        // A parent redraw removes and re-adds this panel; only end the
        // sign-in when it has really left the screen.
        Dispatcher.BeginInvoke(new Action(() => {
          if (IsLoaded) return;
          poll.Stop(); CancelClaude(); manualToken.Clear();
        }), DispatcherPriority.Background);
      };
      claudeCode.KeyDown += (s, e) => { if (e.Key == Key.Enter) SubmitClaudeCode(); };
      Render();
    }
    bool Claude { get { return provider == "anthropic_subscription"; } }
    string Base { get { return Claude ? endpoints.Claude : endpoints.Codex; } }
    object Expected { get { var c = status["credential"]; return c.IsNull ? null : Wires.O("itemId", c["itemId"], "revision", c["revision"]); } }

    public async Task Refresh() {
      var api = model.Api; if (api == null) return;
      try {
        status = await endpoints.Status(api, provider);
        if (model.Api != api) return;
        var handler = StatusChanged; if (handler != null) handler(status);
      } catch (JosiException e) { error = e.Message; }
      Render();
    }

    void Render() {
      var stack = new StackPanel();
      var name = ModelText.PlanName(provider);
      if (status.IsNull) Ui.Add(stack, Ui.Caption("Checking your " + name + " connection…"), 0);
      else {
        Ui.Add(stack, Ui.Row(10, ModelText.Pill(SignedIn ? name + " connected" : "Not connected", SignedIn),
          status["busy"].Flag ? ModelText.Pill("In use", false) : null), 0);
        if (status["detail"].Text.Length > 0) Ui.Add(stack, Ui.Caption(status["detail"].Text), 8);
        if (!status["installed"].Flag)
          Ui.Add(stack, Ui.T("The server does not have the pinned " + (Claude ? "Claude Code" : "Codex") + " program it needs for this subscription.", 13.5, null, Ui.Orange), 8);
      }
      if (Claude) RenderClaude(stack); else RenderChatGpt(stack);
      if (stage.Length > 0) Ui.Add(stack, Ui.Row(8, new ProgressBar { IsIndeterminate = true, Width = 60, Height = 4 }, Ui.Caption(stage)), 10);
      if (error.Length > 0) Ui.Add(stack, Ui.Copyable(error, 13.5, Ui.Orange), 10);
      if (!endpoints.Setup && SignedIn && stage.Length == 0 && claude == null && !LoginActive) {
        var signOut = Ui.Danger("Sign Out of " + name + "…", () => {
          if (Dialogs.Confirm(owner, "Sign out of the server's " + name + " subscription?", "Josi will need a new sign-in before this subscription can answer.", "Sign Out"))
            Act(Base + "/logout", Wires.O("expected", Expected), "Signed out.");
        });
        signOut.IsEnabled = !status["busy"].Flag;
        Ui.Add(stack, signOut, 12);
      }
      body.Content = stack;
      SyncEnabled();
      if (claude != null && claudePage != null)
        Dispatcher.BeginInvoke(new Action(() => { if (claudeCode.IsEnabled) claudeCode.Focus(); }), DispatcherPriority.Background);
    }
    /// Follows the app's busy state on every change, not only when this panel
    /// redraws: otherwise a panel drawn during a request stays disabled.
    void SyncEnabled() {
      body.IsEnabled = !model.Busy;
    }

    // ------------------------------------------------------------ ChatGPT
    bool LoginActive {
      get { var s = login["state"].Text; return s == "starting" || s == "awaiting_approval" || s == "awaiting_code" || s == "verifying"; }
    }
    void RenderChatGpt(StackPanel stack) {
      var challenge = login["challenge"];
      if (LoginActive && challenge["userCode"].Text.Length > 0) {
        Uri page;
        Uri.TryCreate(challenge["verificationUrl"].Text, UriKind.Absolute, out page);
        var valid = page != null && page.Scheme == "https" && (page.Host == "auth.openai.com" || page.Host.EndsWith(".openai.com")) && page.UserInfo.Length == 0;
        if (valid && !openedChallenge) { openedChallenge = true; ModelText.Open(page); }
        var code = Ui.T(challenge["userCode"].Text, 30, FontWeights.Bold, Ui.Text); code.FontFamily = Ui.Mono;
        var card = new Border { Background = Ui.Raised, CornerRadius = new CornerRadius(12), Padding = new Thickness(18), Child = Ui.Stack(10,
          Ui.T("1. Sign in to ChatGPT on OpenAI's page in your browser.", 14),
          Ui.T("2. Enter this one-time code there:", 14),
          Ui.Row(12, code, Ui.PillIcon(Glyph.Copy, "Copy", () => { try { Clipboard.SetText(challenge["userCode"].Text); } catch (Exception) { } })),
          valid ? (UIElement)Ui.Row(10, Ui.Pill("Open OpenAI's Page Again", () => ModelText.Open(page)), Ui.Caption(page.Host)) : Ui.T("The sign-in page address was not from OpenAI; it was not opened.", 13, null, Ui.Orange),
          login["expiresAt"].Text.Length > 0 ? Ui.Caption("Expires " + Wires.Date(login["expiresAt"].Text) + ". Josi finishes automatically after you approve.") : null) };
        Ui.Add(stack, card, 12);
        Ui.Add(stack, Ui.Pill("Cancel Sign-In", () => Act(Base + "/login/cancel", Wires.O(), "Sign-in cancelled.")), 10);
        return;
      }
      if (LoginActive) { stage = "Starting OpenAI's sign-in…"; return; }
      if (login["state"].Text == "failed" || login["state"].Text == "expired") {
        var message = login["message"].Text;
        Ui.Add(stack, Ui.T(message.Length > 0 ? message : "The sign-in did not finish. Start it again.", 13.5, null, Ui.Orange), 10);
      }
      if (status["credential"]["state"].Text == "leased" && status["credential"]["expiredLease"].Flag) {
        Ui.Add(stack, Ui.Pill("Repair Interrupted Sign-In…", () => {
          if (Dialogs.Confirm(owner, "Clear the interrupted sign-in?", "The server confirms the earlier sign-in has stopped and its temporary files are gone before you can sign in again. No task restarts.", "Clear Sign-In"))
            Act(Base + "/reconcile", Wires.O("expected", Expected), "The interrupted sign-in was cleared.");
        }), 12);
        return;
      }
      if (!status.IsNull && status["installed"].Flag && !status["busy"].Flag) {
        var start = Ui.Pill(SignedIn ? "Sign In Again" : "Sign In with ChatGPT", StartChatGpt, !SignedIn);
        Ui.Add(stack, start, 12);
        Ui.Add(stack, Ui.Caption("OpenAI's own Codex program signs in on the server. Your ChatGPT password is entered only on OpenAI's page; the saved login stays in the server's Vault."), 8);
      }
    }
    void StartChatGpt() {
      var api = model.Api; if (api == null) return;
      error = ""; openedChallenge = false; stage = "Starting OpenAI's sign-in…"; Render();
      model.Run(async () => {
        try {
          login = await api.Request(Base + "/login", "POST", Expected == null ? Wires.O() : Wires.O("expected", Expected));
          poll.Start();
        } catch (JosiException e) { error = e.Message; }
        finally { stage = ""; Render(); }
      });
    }
    async Task PollLogin() {
      var api = model.Api;
      if (api == null || Claude || !LoginActive) { poll.Stop(); return; }
      try {
        login = await api.Request(Base + "/login");
        if (login["state"].Text == "signed_in") { poll.Stop(); login = Wire.Null; await Refresh(); return; }
        if (!LoginActive) { poll.Stop(); await Refresh(); }
      } catch (JosiException e) { poll.Stop(); error = "Sign-in status could not be refreshed: " + e.Message; }
      Render();
    }

    // ------------------------------------------------------------- Claude
    void RenderClaude(StackPanel stack) {
      if (claude != null) {
        if (claudePage == null) return; // stage text shows progress
        Ui.Detach(claudeCode);
        var send = Ui.Pill("Continue", SubmitClaudeCode, true);
        send.IsEnabled = !submitting; claudeCode.IsReadOnly = submitting;
        var card = new Border { Background = Ui.Raised, CornerRadius = new CornerRadius(12), Padding = new Thickness(18), Child = Ui.Stack(10,
          Ui.T("1. Sign in to Claude on Anthropic's page in your browser and approve access.", 14),
          Ui.T("2. Anthropic then shows a code. Copy it and paste it here:", 14),
          claudeCode,
          Ui.Row(10, send, Ui.Pill("Open Claude's Page Again", () => ModelText.Open(claudePage)), Ui.Caption(claudePage.Host))) };
        Ui.Add(stack, card, 12);
        Ui.Add(stack, Ui.Pill("Cancel Sign-In", () => { CancelClaude(); stage = ""; Render(); }), 10);
        return;
      }
      if (status.IsNull || stage.Length > 0) return;
      if (status["credential"].IsNull) {
        Ui.Add(stack, Ui.T("The server's Vault is not available for a subscription token. Unlock or initialize the Vault, then refresh.", 13.5, null, Ui.Orange), 10);
        return;
      }
      if (!status["installed"].Flag || status["busy"].Flag) return;
      if (manual) {
        Ui.Detach(manualToken);
        Ui.Add(stack, Ui.Caption("This PC does not have Anthropic's Claude Code program, so Josi cannot run the sign-in here. Paste a token created with Claude Code's setup-token command on any computer."), 10);
        Ui.Add(stack, Ui.Field("Claude subscription token", manualToken), 8);
        Ui.Add(stack, Ui.Row(10, Ui.Pill("Save Token in Vault", () => {
          var value = manualToken.Password.Trim(); manualToken.Clear();
          if (value.Length < 16 || value.Length > 16384) { error = "That is not a Claude subscription token."; Render(); return; }
          Connect(value);
        }, true), Ui.Pill("Cancel", () => { manual = false; manualToken.Clear(); Render(); })), 8);
        return;
      }
      Ui.Add(stack, Ui.Pill(SignedIn ? "Replace with a New Sign-In" : "Sign In with Claude", StartClaude, !SignedIn), 12);
      Ui.Add(stack, Ui.Caption("Josi runs Anthropic's own signed Claude Code program on this PC to create a one-year subscription token. You sign in only on Anthropic's page; the token goes straight to the server's Vault and is never shown or saved on this PC. Everyone using this server shares the subscription's limits."), 8);
    }
    void StartClaude() {
      if (model.Api == null) return;
      error = ""; stage = "Checking Anthropic's Claude Code program…"; Render();
      model.Run(async () => {
        try {
          var executable = await Task.Run(() => ClaudeCli.Locate());
          if (executable == null) { manual = true; return; }
          stage = "Starting Claude's sign-in…"; Render();
          claude = await ClaudeSetupToken.Start(executable);
          var session = claude;
          var page = await Task.WhenAny(session.SignInPage, Task.Delay(TimeSpan.FromSeconds(45)));
          if (page != session.SignInPage) throw new JosiException("Claude Code did not show a sign-in page. Check this PC's internet connection and try again.");
          claudePage = await session.SignInPage;
          ModelText.Open(claudePage);
          stage = "";
          _ = Finish(session);
        } catch (JosiException e) { CancelClaude(); error = e.Message; }
        catch (Exception e) { CancelClaude(); error = "Claude's sign-in could not start: " + e.Message; }
        finally { if (claude == null) stage = ""; Render(); }
      });
      Dispatcher.BeginInvoke(new Action(() => claudeCode.Focus()), DispatcherPriority.Background);
    }
    async void SubmitClaudeCode() {
      var session = claude;
      if (session == null || submitting) return;
      var code = claudeCode.Text;
      submitting = true; error = ""; stage = "Sending the code to Claude…"; Render();
      try {
        await session.SubmitCode(code);
        claudeCode.Clear();
        stage = "Waiting for Claude to issue the token…"; Render();
        // A valid code finishes within seconds; otherwise say what Claude Code showed.
        var done = await Task.WhenAny(session.Result, Task.Delay(TimeSpan.FromSeconds(20)));
        if (done != session.Result && claude == session) {
          var reply = session.ReplySinceSubmit();
          error = "Claude did not accept the code" + (reply.Length > 0 ? ": " + reply : ".") +
            " Copy the whole code from Claude's page (use its Copy button) and paste it again, or open the page again for a new code.";
        }
      } catch (JosiException e) { error = e.Message; }
      finally { submitting = false; if (claude == session) stage = ""; Render(); }
    }
    async Task Finish(ClaudeSetupToken session) {
      string token;
      try {
        var done = await Task.WhenAny(session.Result, Task.Delay(TimeSpan.FromMinutes(15)));
        if (done != session.Result) throw new JosiException("Claude's sign-in timed out. Start it again.");
        token = await session.Result;
      } catch (OperationCanceledException) { return; }
      catch (JosiException e) { if (claude == session) { CancelClaude(); stage = ""; error = e.Message; Render(); } return; }
      if (claude != session) return;
      CancelClaude();
      Connect(token);
    }
    void Connect(string token) {
      var api = model.Api; if (api == null) return;
      stage = "Saving the token in the server's Vault…"; Render();
      var expected = Expected;
      // Sent once to the Vault route; the server never returns or logs it.
      model.Run(async () => {
        try {
          var result = await api.Request(Base + "/connect", "POST", Wires.O("token", token, "expected", expected));
          status = result["cli"];
          var handler = StatusChanged; if (handler != null) handler(status);
          manual = false;
        } catch (JosiException e) { error = e.Message; }
        finally { stage = ""; Render(); }
      });
    }
    void CancelClaude() {
      var session = claude; claude = null; claudePage = null;
      if (session != null) session.Dispose();
      claudeCode.Clear();
    }

    void Act(string route, object body, string done) {
      var api = model.Api; if (api == null) return;
      error = ""; poll.Stop();
      model.Run(async () => {
        try { await api.Request(route, "POST", body); login = Wire.Null; await Refresh(); error = ""; }
        catch (JosiException e) { error = e.Message; }
        finally { Render(); }
      });
    }
  }

  /// The four-step model setup used by the Models page and first-run setup.
  public sealed class ModelSetupPanel : UserControl {
    readonly AppModel model; readonly Window owner; readonly ModelEndpoints endpoints;
    readonly string role; readonly Wire initial; readonly List<Wire> catalog; readonly List<Wire> options;
    readonly Func<Dictionary<string, object>, Task<bool>> save;
    readonly Dictionary<string, Control> fields = new Dictionary<string, Control>();
    readonly TextBox search = Ui.Input("Search models");
    readonly TextBox custom = Ui.Input("Model name");
    readonly CheckBox external = Ui.Toggle("");
    readonly ContentControl stepHost = new ContentControl { Focusable = false };
    readonly StackPanel rail = new StackPanel { Orientation = Orientation.Horizontal };
    readonly StackPanel footer = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
    int step;
    string kind = "", chosenModel = "", discoveryMessage = "";
    bool discovering, discoveredFromCatalog, allowsCustom = true, planDefault = true;
    List<Wire> discovered = new List<Wire>();
    SubscriptionSignIn signIn;
    Wire checkResult = Wire.Null;
    static readonly string[] StepNames = { "Choose", "Connect", "Model", "Review and check" };

    /// save: performs the save (and capability check where the caller does);
    /// returns true when the panel should show its finished state.
    public ModelSetupPanel(AppModel model, Window owner, ModelEndpoints endpoints, string role, Wire initial, List<Wire> catalog,
        List<Wire> options, Func<Dictionary<string, object>, Task<bool>> save, int startStep = 0) {
      this.model = model; this.owner = owner; this.endpoints = endpoints; this.role = role; this.initial = initial ?? Wire.Null;
      this.catalog = catalog; this.options = options ?? new List<Wire>(); this.save = save;
      kind = this.initial["provider"].Text;
      if (kind.Length > 0) Reset(kind, true);
      step = kind.Length > 0 ? Math.Min(startStep, 3) : 0;
      search.TextChanged += delegate { if (step == 2) RenderStep(); };
      custom.TextChanged += delegate { chosenModel = custom.Text.Trim(); planDefault = false; UpdateFooter(); };
      external.Checked += delegate { UpdateFooter(); };
      external.Unchecked += delegate { UpdateFooter(); };
      var layout = new DockPanel();
      rail.Margin = new Thickness(0, 0, 0, 18);
      footer.Margin = new Thickness(0, 18, 0, 0);
      DockPanel.SetDock(rail, Dock.Top); DockPanel.SetDock(footer, Dock.Bottom);
      layout.Children.Add(rail); layout.Children.Add(footer); layout.Children.Add(stepHost);
      Content = layout;
      // The footer buttons wait while the app is busy; a sign-in that finishes
      // during a request must enable them once that request ends.
      Loaded += delegate { model.Changed += FollowBusy; FollowBusy(); };
      Unloaded += delegate { model.Changed -= FollowBusy; };
      Render();
    }
    bool footerBusy;
    void FollowBusy() {
      if (footerBusy == model.Busy) return;
      footerBusy = model.Busy;
      UpdateFooter();
    }
    Wire Entry { get { return ModelText.Entry(catalog, kind); } }
    bool IsSubscription { get { return ModelText.Subscription(kind); } }

    void Reset(string next, bool fromInitial) {
      kind = next; fields.Clear(); discovered = new List<Wire>(); discoveryMessage = ""; checkResult = Wire.Null;
      var entry = Entry; var same = fromInitial || next == initial["provider"].Text;
      foreach (var field in entry["fields"].List) {
        fields[field["key"].Text] = field["secret"].Flag ? (Control)Ui.Secret(field["label"].Text)
          : Ui.Input(field["placeholder"].Text, same ? initial["providerConfig"][field["key"].Text].Text : "");
      }
      fields["baseUrl"] = Ui.Input(entry["defaultBaseUrl"].Text, same && initial["baseUrl"].Text.Length > 0 ? initial["baseUrl"].Text : entry["defaultBaseUrl"].Text);
      chosenModel = same ? initial["model"].Text : "";
      planDefault = ModelText.Subscription(next) && chosenModel.Length == 0;
      custom.Text = "";
      external.IsChecked = same && initial["externalAcknowledged"].Flag;
      signIn = ModelText.Subscription(next) ? new SubscriptionSignIn(model, owner, endpoints, next) : null;
      if (signIn != null) signIn.StatusChanged += delegate { UpdateFooter(); };
    }
    string Read(string key) {
      Control control;
      if (!fields.TryGetValue(key, out control)) return "";
      var box = control as TextBox; if (box != null) return box.Text.Trim();
      var secret = control as PasswordBox; return secret == null ? "" : secret.Password;
    }
    Dictionary<string, object> Body() {
      var body = Wires.O("provider", kind, "baseUrl", Entry["baseUrlMode"].Text == "none" ? "" : Read("baseUrl"),
        "model", IsSubscription && planDefault ? "" : chosenModel, "externalAcknowledged", external.IsChecked == true);
      foreach (var field in Entry["fields"].List) body[field["key"].Text] = Read(field["key"].Text);
      return body;
    }
    bool KeepsStoredKey { get { return kind == initial["provider"].Text && initial["apiKeySet"].Flag; } }
    bool CanContinue() {
      switch (step) {
        case 0: return kind.Length > 0;
        case 1:
          if (IsSubscription) return signIn != null && signIn.SignedIn;
          foreach (var field in Entry["fields"].List)
            if (field["required"].Flag && Read(field["key"].Text).Length == 0 && !(field["secret"].Flag && KeepsStoredKey)) return false;
          return Entry["baseUrlMode"].Text != "required" || Read("baseUrl").Length > 0;
        case 2: return IsSubscription && planDefault || chosenModel.Length > 0;
        default: return !Entry["external"].Flag || external.IsChecked == true;
      }
    }

    void Render() {
      rail.Children.Clear();
      for (var index = 0; index < StepNames.Length; index++) {
        var i = index; var current = i == step; var reachable = i < step || (i == step);
        var label = Ui.T((i + 1) + "  " + StepNames[i], 13.5, current ? FontWeights.SemiBold : FontWeights.Normal, current ? Ui.Orange : i < step ? Ui.Text : Ui.Muted);
        var button = new Button { Content = label, Style = (Style)Ui.Resources["Plain"], Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 0, 6, 0),
          Background = current ? Ui.OrangeSoft : Brushes.Transparent, IsEnabled = reachable && checkResult.IsNull };
        button.Click += delegate { if (i < step) { step = i; Render(); } };
        rail.Children.Add(button);
      }
      RenderStep();
      UpdateFooter();
    }

    void UpdateFooter() {
      footer.Children.Clear();
      if (!checkResult.IsNull) return;
      if (step > 0) footer.Children.Add(Spaced(Ui.Pill("Back", () => { step--; Render(); })));
      // Choosing a provider already moves on; Continue only returns to a choice made before.
      if (step == 0 && kind.Length == 0) return;
      if (step < 3) {
        var next = Ui.Pill("Continue", () => {
          step++;
          if (step == 2 && discovered.Count == 0) Discover();
          Render();
        }, true);
        next.IsEnabled = CanContinue() && !model.Busy;
        footer.Children.Add(next);
      } else {
        var go = Ui.Pill(endpoints.Setup ? "Save and Check Model" : "Save and Run Capability Check", SaveAndCheck, true);
        go.IsEnabled = CanContinue() && !model.Busy;
        footer.Children.Add(go);
      }
    }
    static FrameworkElement Spaced(FrameworkElement element) { element.Margin = new Thickness(0, 0, 8, 0); return element; }

    void RenderStep() {
      UIElement content;
      switch (step) {
        case 0: content = ChooseStep(); break;
        case 1: content = ConnectStep(); break;
        case 2: content = ModelStep(); break;
        default: content = ReviewStep(); break;
      }
      stepHost.Content = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false, Padding = new Thickness(0, 0, 8, 0) };
    }

    // ------------------------------------------------------------- 1 Choose
    // Shown first; everything else is one click away under "More providers".
    static readonly string[] Featured = { "openai_subscription", "anthropic_subscription", "openai", "anthropic", "gemini", "openai_compatible" };
    UIElement ChooseStep() {
      var stack = new StackPanel();
      Ui.Add(stack, Ui.T(role == "fallback" ? "Choose a backup for when the primary model can't answer" : "Choose how Josi thinks", 18, FontWeights.SemiBold), 0);
      var subscriptions = catalog.Where(c => ModelText.Subscription(c["kind"].Text)).ToList();
      var popular = catalog.Where(c => Featured.Contains(c["kind"].Text) && !ModelText.Subscription(c["kind"].Text) && c["external"].Flag).ToList();
      var own = catalog.Where(c => !c["external"].Flag && !ModelText.Subscription(c["kind"].Text)).ToList();
      var more = catalog.Where(c => !subscriptions.Contains(c) && !popular.Contains(c) && !own.Contains(c)).ToList();
      if (subscriptions.Count > 0) { Ui.Add(stack, Ui.Caption("YOUR SUBSCRIPTIONS"), 14); Ui.Add(stack, Rows(subscriptions, 2), 6); }
      if (popular.Count > 0) { Ui.Add(stack, Ui.Caption("API SERVICES"), 14); Ui.Add(stack, Rows(popular, 3), 6); }
      if (own.Count > 0) { Ui.Add(stack, Ui.Caption("YOUR OWN HARDWARE"), 14); Ui.Add(stack, Rows(own, 2), 6); }
      if (more.Count > 0)
        Ui.Add(stack, new Disclosure("More providers (" + more.Count + ")", () => Rows(more, 3), more.Any(c => c["kind"].Text == kind)), 12);
      return stack;
    }
    /// Compact provider rows; choosing one goes straight to Connect.
    UIElement Rows(IEnumerable<Wire> entries, int columns) {
      var grid = new UniformGrid { Columns = columns };
      foreach (var entry in entries) {
        var id = entry["kind"].Text; var selected = id == kind;
        var option = options.FirstOrDefault(o => o["provider"].Text == id);
        var available = option == null || option["available"].Flag;
        var detail = ModelText.Subscription(id) ? "Uses your " + ModelText.PlanName(id) + " plan"
          : entry["external"].Flag ? (entry["residency"].Text.Length > 0 ? entry["residency"].Text : "Cloud service") : "Runs on hardware you control";
        var title = Ui.T(entry["label"].Text, 14, FontWeights.SemiBold, selected ? Ui.Orange : Ui.Text);
        title.TextWrapping = TextWrapping.NoWrap; title.TextTrimming = TextTrimming.CharacterEllipsis;
        var sub = Ui.Caption(detail); sub.TextWrapping = TextWrapping.NoWrap; sub.TextTrimming = TextTrimming.CharacterEllipsis;
        var row = new Button { Style = (Style)Ui.Resources["Plain"], Margin = new Thickness(0, 0, 8, 8), Padding = new Thickness(0),
          HorizontalContentAlignment = HorizontalAlignment.Stretch, IsEnabled = available,
          Content = new Border { Background = selected ? Ui.OrangeFaint : Ui.Card, BorderBrush = selected ? Ui.Orange : Ui.Border,
            BorderThickness = new Thickness(selected ? 2 : 1), CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 8, 12, 8),
            Child = Ui.Stack(2, title, sub) } };
        Ui.Name(row, entry["label"].Text, available ? detail : (option == null ? null : option["reason"].Text));
        row.Click += delegate {
          if (kind != id) Reset(id, false);
          step = 1;
          Render();
        };
        grid.Children.Add(row);
      }
      return grid;
    }

    // ------------------------------------------------------------ 2 Connect
    UIElement ConnectStep() {
      var entry = Entry; var stack = new StackPanel();
      Ui.Add(stack, Ui.Title2("Connect " + entry["label"].Text), 0);
      if (IsSubscription) {
        Ui.Detach(signIn);
        Ui.Add(stack, signIn, 14);
        return stack;
      }
      if (entry["docsUrl"].Text.Length > 0) {
        Uri docs;
        if (Uri.TryCreate(entry["docsUrl"].Text, UriKind.Absolute, out docs) && docs.Scheme == "https")
          Ui.Add(stack, Ui.Link("Where to find these details (" + docs.Host + ")", () => ModelText.Open(docs)), 8);
      }
      foreach (var field in entry["fields"].List) {
        var control = fields[field["key"].Text];
        Ui.Detach(control);
        var label = field["label"].Text + (field["required"].Flag ? "" : " (optional)");
        Ui.Add(stack, Ui.Field(label, control), 14);
        var box = control as TextBox; if (box != null) box.TextChanged += delegate { UpdateFooter(); };
        var secret = control as PasswordBox; if (secret != null) secret.PasswordChanged += delegate { UpdateFooter(); };
        if (field["help"].Text.Length > 0) Ui.Add(stack, Ui.Caption(field["help"].Text), 4);
      }
      if (KeepsStoredKey) Ui.Add(stack, Ui.Caption("A credential is already saved in the Vault. Leave secret fields blank to keep it, or enter a replacement."), 10);
      if (entry["baseUrlMode"].Text != "none") {
        var endpoint = fields["baseUrl"]; Ui.Detach(endpoint);
        ((TextBox)endpoint).TextChanged += delegate { UpdateFooter(); };
        Ui.Add(stack, Ui.Field(entry["baseUrlMode"].Text == "required" ? "Endpoint address" : "Endpoint address (leave as is unless you use a custom endpoint)", endpoint), 14);
      }
      Ui.Add(stack, Ui.Caption(entry["external"].Flag
        ? "Secrets are sent once to your Josi server and saved in its Vault. They are never shown again."
        : "Josi connects to this model from the server. Nothing leaves the network you configure."), 14);
      return stack;
    }

    // -------------------------------------------------------------- 3 Model
    void Discover() {
      var api = model.Api; if (api == null) return;
      discovering = true; discoveryMessage = "";
      var body = Body(); var forKind = kind;
      Task.Run(async () => {
        try {
          var result = await api.Request(endpoints.Discover, "POST", body);
          await Dispatcher.InvokeAsync(() => {
            if (kind != forKind) return;
            discovered = result["models"].List;
            discoveredFromCatalog = result["fromCatalog"].Flag;
            allowsCustom = result["allowsCustomModel"].Flag || discovered.Count == 0;
            discoveryMessage = result["fromCatalog"].Flag ? "This list is Josi's own catalog; the provider did not supply one." : result["message"].Text;
          });
        } catch (JosiException e) {
          await Dispatcher.InvokeAsync(() => { discoveryMessage = "Models could not be listed: " + e.Message; allowsCustom = true; });
        } finally {
          await Dispatcher.InvokeAsync(() => { discovering = false; if (step == 2) RenderStep(); UpdateFooter(); });
        }
      });
    }
    UIElement ModelStep() {
      var stack = new StackPanel();
      Ui.Add(stack, Ui.Title2("Choose the " + (Entry["modelNoun"].Text.Length > 0 ? Entry["modelNoun"].Text : "model")), 0);
      if (IsSubscription) {
        var planRow = Row("Use my plan's default (recommended)", "The subscription picks its current default model.", planDefault, () => { planDefault = true; chosenModel = ""; RenderStep(); UpdateFooter(); });
        Ui.Add(stack, planRow, 14);
      }
      if (discovering) { Ui.Add(stack, Ui.Row(8, new ProgressBar { IsIndeterminate = true, Width = 60, Height = 4 }, Ui.Caption("Asking the provider which models you can use…")), 14); return stack; }
      if (discoveryMessage.Length > 0) Ui.Add(stack, Ui.Caption(discoveryMessage), 10);
      if (discovered.Count > 0) {
        Ui.Detach(search);
        Ui.Add(stack, search, 14);
        var filter = search.Text.Trim();
        var list = new StackPanel();
        foreach (var item in discovered.Where(d => filter.Length == 0 || (d["id"].Text + " " + d["label"].Text).IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0).Take(200)) {
          var id = item["id"].Text;
          var label = item["label"].Text.Length > 0 && item["label"].Text != id ? item["label"].Text : id;
          list.Children.Add(Row(label, label == id ? "" : id, !planDefault && chosenModel == id, () => { chosenModel = id; planDefault = false; custom.Text = ""; RenderStep(); UpdateFooter(); }));
        }
        Ui.Add(stack, new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(4),
          Child = new ScrollViewer { Content = list, MaxHeight = 300, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } }, 8);
      }
      Ui.Add(stack, Ui.Pill("Refresh List", () => { Discover(); RenderStep(); }), 10);
      if (allowsCustom || !discoveredFromCatalog) {
        Ui.Detach(custom);
        Ui.Add(stack, Ui.Field("Or enter a model name", custom), 16);
      }
      return stack;
    }
    UIElement Row(string title, string detail, bool selected, Action pick) {
      var text = Ui.Stack(2, Ui.T(title, 14, selected ? FontWeights.SemiBold : FontWeights.Normal, selected ? Ui.Orange : Ui.Text), detail.Length > 0 ? Ui.Caption(detail) : null);
      var button = new Button { Style = (Style)Ui.Resources["Plain"], Padding = new Thickness(12, 8, 12, 8), HorizontalContentAlignment = HorizontalAlignment.Stretch,
        Background = selected ? Ui.OrangeSoft : Brushes.Transparent,
        Content = Ui.Row(10, Ui.Icon(selected ? Glyph.Check : Glyph.Circle, 14, selected ? Ui.Orange : Ui.Muted), text) };
      Ui.Name(button, title, null);
      button.Click += delegate { pick(); };
      return button;
    }

    // ------------------------------------------------------------- 4 Review
    UIElement ReviewStep() {
      var entry = Entry; var stack = new StackPanel();
      if (!checkResult.IsNull) return Finished();
      Ui.Add(stack, Ui.Title2("Review and check"), 0);
      var modelName = IsSubscription && planDefault ? "Plan default" : chosenModel;
      Ui.Add(stack, Ui.CardBox(null,
        Line("Role", role == "fallback" ? "Fallback model" : "Primary model"),
        Line("Provider", entry["label"].Text),
        Line(entry["modelNoun"].Text.Length > 0 ? Wires.Capitalize(entry["modelNoun"].Text) : "Model", modelName),
        entry["baseUrlMode"].Text != "none" && Read("baseUrl").Length > 0 ? Line("Endpoint", Read("baseUrl")) : null,
        entry["residency"].Text.Length > 0 ? Line("Where data is processed", entry["residency"].Text) : null), 14);
      if (entry["external"].Flag) {
        external.Content = "Allow Josi to send task content — messages, attachments and tool results — to " + entry["label"].Text;
        Ui.Detach(external);
        Ui.Add(stack, external, 16);
      }
      Ui.Add(stack, Ui.Caption(endpoints.Setup
        ? "Josi saves this model and immediately checks what it can do. The check sends a few small requests and uses your subscription or API quota."
        : "Saving turns this slot off until its capability check passes. The check sends a few small requests and uses your subscription or API quota."), 14);
      return stack;
    }
    static UIElement Line(string label, string value) {
      var grid = new Grid();
      grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
      grid.ColumnDefinitions.Add(new ColumnDefinition());
      var left = Ui.Caption(label); var right = Ui.Copyable(value, 14);
      Grid.SetColumn(right, 1); grid.Children.Add(left); grid.Children.Add(right);
      return grid;
    }
    UIElement Finished() {
      var stack = new StackPanel();
      var passed = checkResult["provider"]["active"].Flag || checkResult["passed"].Flag;
      Ui.Add(stack, Ui.Row(10, Ui.Icon(passed ? Glyph.Check : Glyph.Warning, 22, passed ? Ui.Green : Ui.Orange),
        Ui.Title2(passed ? "The model is ready" : "The model did not pass its check")), 0);
      Ui.Add(stack, ModelText.Capabilities(checkResult["provider"]["capabilities"]), 14);
      Ui.Add(stack, ModelText.Steps(checkResult["result"]["steps"].List), 10);
      if (checkResult["result"]["fatal"].Text.Length > 0) Ui.Add(stack, Ui.Copyable(checkResult["result"]["fatal"].Text, 13.5, Ui.Orange), 10);
      Ui.Add(stack, Ui.Row(10, passed ? null : Ui.Pill("Change Settings", () => { checkResult = Wire.Null; step = 1; Render(); }),
        // Only the separate setup window closes; first-run setup embeds this panel in the main window.
        endpoints.Setup ? null : Ui.Pill("Done", () => { var window = Window.GetWindow(this) as ModelSetupWindow; if (window != null) window.Close(); }, passed)), 18);
      return stack;
    }
    void SaveAndCheck() {
      var body = Body();
      foreach (var control in fields.Values) { var secret = control as PasswordBox; if (secret != null) secret.Clear(); }
      model.Run(async () => {
        var finished = await save(body);
        if (!finished) return;
      });
    }
    /// Admin path result: shows the capability check in place.
    public void ShowResult(Wire result) { checkResult = result; Render(); }
  }

  public sealed class ModelSetupWindow : Dialogs.Sheet {
    public bool Saved;
    public ModelSetupWindow(Window owner, AppModel model, string role, Wire initial, List<Wire> catalog, List<Wire> options, int startStep)
      : base(owner, role == "fallback" ? "Fallback Model" : "Primary Model", 880) {
      SizeToContent = SizeToContent.Manual; Height = 720; ResizeMode = ResizeMode.CanResize; MinHeight = 520;
      var api = model.Api; var administrator = model.User["id"].Text;
      ModelSetupPanel panel = null;
      panel = new ModelSetupPanel(model, this, new ModelEndpoints(false), role, initial, catalog, options, async body => {
        if (model.Api != api || model.User["id"].Text != administrator) throw new JosiException("You are no longer signed in as this administrator.");
        var latest = await api.Request("/admin/llm");
        if (!latest[role].Same(initial ?? Wire.Null)) throw new JosiException("The model settings changed while you were editing. Close this window and review the current configuration.");
        await api.Request("/admin/llm/providers/" + role, "PUT", body);
        Saved = true;
        model.Activity = "Running the capability check…"; model.Notify();
        try {
          var result = await api.Request("/admin/llm/providers/" + role + "/probe", "POST", Wires.O());
          panel.ShowResult(result);
        } catch (JosiException e) {
          panel.ShowResult(new Wire(Wires.O("result", Wires.O("steps", new List<object>(), "fatal", e.Message))));
        } finally { model.Activity = ""; }
        return true;
      }, startStep);
      var header = Ui.Spread(Ui.Title2(role == "fallback" ? "Fallback model" : "Primary model"), Ui.Pill("Close", Close));
      header.Margin = new Thickness(0, 0, 0, 14);
      var dock = new DockPanel { Margin = new Thickness(26) };
      DockPanel.SetDock(header, Dock.Top);
      dock.Children.Add(header); dock.Children.Add(panel);
      Content = dock;
    }
  }

  public sealed class ModelsView : SectionView {
    Wire settings = Wire.Null, usage = Wire.Null;
    readonly Dictionary<string, Wire> subscriptions = new Dictionary<string, Wire>();
    readonly TextBox cost = Ui.Input("No cap"), tokens = Ui.Input("No cap");
    readonly CheckBox localOnly = Ui.Toggle("Only use models running on your own computer or network");
    public ModelsView(AppModel model, Window owner) : base(model, owner) {
      localOnly.Checked += delegate { if (IsLoaded) Render(); };
      localOnly.Unchecked += delegate { if (IsLoaded) Render(); };
    }
    protected override double PageWidth() { return 1100; }
    protected override async Task Load() {
      if (!model.IsAdministrator) return;
      var api = Api; var stamp = Stamp;
      var next = await api.Request("/admin/llm");
      if (!Current(stamp)) return;
      settings = next; localOnly.IsChecked = next["localOnly"].Flag;
      cost.Text = Amount(next["caps"]["monthly_cost_usd"]); tokens.Text = Amount(next["caps"]["monthly_tokens"]);
      foreach (var kind in new[] { "openai_subscription", "anthropic_subscription" }) {
        if (!next["subscriptionOptions"].List.Any(o => o["provider"].Text == kind && o["available"].Flag)) continue;
        try { subscriptions[kind] = await new ModelEndpoints(false).Status(api, kind); } catch (JosiException) { subscriptions.Remove(kind); }
      }
      try { var counts = await api.Request("/admin/llm/usage"); if (Current(stamp)) usage = counts; } catch (JosiException) { usage = Wire.Null; }
    }
    static string Amount(Wire value) { return value.IsNumber ? value.Number.ToString("0.######", CultureInfo.InvariantCulture) : value.Text; }

    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Models", "Which AI Josi uses to think, how it signs in, and what it may spend.", Ui.Pill("Refresh", StartLoad)));
      if (settings.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading model settings…" : "Model settings are unavailable. Refresh to load them."), 20); return page; }
      var slots = new Grid();
      slots.ColumnDefinitions.Add(new ColumnDefinition()); slots.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) }); slots.ColumnDefinitions.Add(new ColumnDefinition());
      var primary = Slot("primary"); var fallback = Slot("fallback");
      Grid.SetColumn(fallback, 2); slots.Children.Add(primary); slots.Children.Add(fallback);
      Ui.Add(page, slots, 20);
      foreach (var feature in settings["disabledFeatures"].List)
        Ui.Add(page, Ui.Row(8, Ui.Icon(Glyph.Warning, 13, Ui.Orange), Ui.Caption(Wires.Capitalize(feature["feature"].Text.Replace("_", " ")) + " is off: " + feature["reason"].Text)), 8);

      var available = settings["subscriptionOptions"].List.Where(o => o["available"].Flag).ToList();
      if (available.Count > 0) {
        Ui.Add(page, Ui.Title2("Subscriptions"), 28);
        Ui.Add(page, Ui.Secondary("Sign-ins the server keeps in its Vault. A model slot can use a subscription once it is connected here or in the model setup."), 6);
        var cards = new UniformGrid { Columns = Math.Min(2, available.Count) };
        foreach (var option in available) {
          var kind = option["provider"].Text;
          var control = new SubscriptionSignIn(model, owner, new ModelEndpoints(false), kind);
          control.StatusChanged += value => {
            Wire previous;
            var changed = !subscriptions.TryGetValue(kind, out previous) || previous["signedIn"].Flag != value["signedIn"].Flag;
            subscriptions[kind] = value;
            // The model cards depend on this sign-in; redraw them after it settles.
            if (changed) Dispatcher.BeginInvoke(new Action(Render), DispatcherPriority.Background);
          };
          var card = Ui.CardBox(ModelText.PlanName(kind) + " plan", Ui.Caption(option["reason"].Text), control);
          card.Margin = new Thickness(0, 0, 14, 14);
          cards.Children.Add(card);
        }
        Ui.Add(page, cards, 12);
      }

      Ui.Add(page, Ui.Title2("Privacy and spending"), 28);
      Ui.Detach(localOnly); Ui.Detach(cost); Ui.Detach(tokens);
      var saveLocal = Ui.Pill("Save", () => Request("/admin/llm/local-only", "PUT", Wires.O("enabled", localOnly.IsChecked == true), "Local-only setting saved."));
      saveLocal.IsEnabled = (localOnly.IsChecked == true) != settings["localOnly"].Flag;
      var limits = new Grid();
      limits.ColumnDefinitions.Add(new ColumnDefinition()); limits.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) }); limits.ColumnDefinitions.Add(new ColumnDefinition());
      var costField = Ui.Field("Monthly spend cap (USD)", cost); var tokenField = Ui.Field("Monthly token cap", tokens);
      Grid.SetColumn(tokenField, 2); limits.Children.Add(costField); limits.Children.Add(tokenField);
      var privacy = new Grid();
      privacy.ColumnDefinitions.Add(new ColumnDefinition()); privacy.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) }); privacy.ColumnDefinitions.Add(new ColumnDefinition());
      var localCard = Ui.CardBox("Local-only mode", localOnly,
        Ui.Caption("Stops every request to external providers, including subscriptions. Replace or remove external models before turning it on."), saveLocal);
      var capsCard = Ui.CardBox("Monthly limits", limits,
        Ui.Caption("Leave a field blank for no cap. Subscriptions report no cost; their calls are counted separately."),
        Ui.Pill("Save Limits", () => {
          try { Request("/admin/llm/caps", "PUT", Wires.O("monthlyCostUsd", Cap(cost.Text, false), "monthlyTokens", Cap(tokens.Text, true)), "Limits saved."); }
          catch (JosiException e) { model.Error = e.Message; model.Notify(); }
        }));
      Grid.SetColumn(capsCard, 2); privacy.Children.Add(localCard); privacy.Children.Add(capsCard);
      Ui.Add(page, privacy, 12);

      if (!usage.IsNull) {
        var s = usage["summary"];
        var stats = new UniformGrid { Columns = 4 };
        Action<string, string> stat = (value, label) => stats.Children.Add(Ui.Stack(2, Ui.T(value, 22, FontWeights.SemiBold), Ui.Caption(label)));
        stat(s["calls"].Integer.ToString("N0", CultureInfo.CurrentCulture), "requests");
        stat(s["totalTokens"].Integer.ToString("N0", CultureInfo.CurrentCulture), "tokens");
        stat("$" + Amount(s["reportedCostUsd"]), "reported cost");
        stat(s["subscriptionCalls"].Integer.ToString("N0", CultureInfo.CurrentCulture), "subscription requests");
        var notes = s["notes"].List.Select(n => (UIElement)Ui.Caption(n.Text)).ToList();
        notes.Insert(0, stats);
        notes.Insert(1, Ui.Caption("Estimated cost: $" + Amount(s["estimatedCostUsd"]) + " · Local model requests: " + s["selfHostedCalls"].Integer));
        Ui.Add(page, Ui.CardBox("This month", notes.ToArray()), 20);
      }
      Ui.Add(page, Note(), 16);
      return page;
    }

    FrameworkElement Slot(string role) {
      var saved = settings[role];
      var title = role == "primary" ? "Primary model" : "Fallback model";
      var items = new List<UIElement>();
      var catalog = settings["providerCatalog"].List;
      if (saved.IsNull) {
        items.Add(ModelText.Pill("Not set up", false));
        items.Add(Ui.Secondary(role == "primary" ? "Josi needs a primary model before it can answer." : "Optional. Josi uses it when the primary model cannot answer."));
        items.Add(Ui.Pill(role == "primary" ? "Set Up a Model…" : "Add a Fallback…", () => Edit(role, 0), role == "primary"));
        return Card(title, items);
      }
      var kind = saved["provider"].Text;
      var entry = ModelText.Entry(catalog, kind);
      var subscriptionMissing = ModelText.Subscription(kind) && subscriptions.ContainsKey(kind) && !subscriptions[kind]["signedIn"].Flag;
      var state = subscriptionMissing ? "Not signed in" : saved["active"].Flag ? "Ready" : saved["probedAt"].Text.Length == 0 ? "Needs a capability check" : "Check failed";
      items.Add(ModelText.Pill(state, state == "Ready"));
      items.Add(Ui.T(entry.IsNull ? kind : entry["label"].Text, 17, FontWeights.SemiBold));
      items.Add(Ui.Secondary(saved["model"].Text.Length == 0 ? (ModelText.Subscription(kind) ? "Plan default model" : "Provider default model") : saved["model"].Text));
      if (saved["external"].Flag) items.Add(Ui.Caption("Task content is sent to " + (entry.IsNull ? kind : entry["label"].Text)
        + (entry["residency"].Text.Length > 0 ? " · " + entry["residency"].Text : "") + "."));
      else items.Add(Ui.Caption("Runs on a model you host."));
      items.Add(ModelText.Capabilities(saved["capabilities"]));
      if (saved["probedAt"].Text.Length > 0) items.Add(Ui.Caption("Last checked " + Wires.Date(saved["probedAt"].Text)));
      var steps = saved["probeSteps"].List;
      if (steps.Count > 0) items.Add(new Disclosure("Check details", () => ModelText.Steps(steps)));
      var actions = Ui.Wrap(
        subscriptionMissing ? Ui.Pill("Sign In…", () => Edit(role, 1), true) : null,
        Ui.Pill("Change…", () => Edit(role, 0)),
        subscriptionMissing ? null : Ui.Pill(saved["active"].Flag ? "Check Again" : "Run Capability Check", () => Probe(role), !saved["active"].Flag),
        role == "fallback" ? Ui.Danger("Remove…", () => {
          if (Dialogs.Confirm(owner, "Remove the fallback model?", "Josi will use only its primary model.", "Remove"))
            Request("/admin/llm/providers/fallback", "DELETE", null, "Fallback model removed.");
        }) : null);
      items.Add(actions);
      return Card(title, items);
    }
    static FrameworkElement Card(string title, List<UIElement> items) {
      var box = Ui.CardBox(title, items.ToArray());
      box.VerticalAlignment = VerticalAlignment.Stretch;
      return box;
    }
    void Edit(string role, int startStep) {
      try {
        var window = new ModelSetupWindow(owner, model, role, settings[role], settings["providerCatalog"].List, settings["subscriptionOptions"].List, startStep);
        window.ShowDialog();
      } catch (Exception e) {
        model.Error = "The model setup window could not open: " + e.GetType().Name + ": " + e.Message; model.Notify();
      }
      StartLoad();
    }
    void Probe(string role) {
      if (!Dialogs.Confirm(owner, "Run a capability check?", "Josi sends a few small test requests to this model and uses its API billing or subscription quota. A passing check turns the model on.", "Run Check")) return;
      Perform(async (api, stamp) => {
        model.Activity = "Running the capability check…"; model.Notify();
        try {
          var result = await api.Request("/admin/llm/providers/" + role + "/probe", "POST", Wires.O());
          if (Current(stamp)) note = result["provider"]["active"].Flag ? "The model passed its capability check." : "The model did not pass. Open Check details for the reason.";
        } finally { model.Activity = ""; }
      });
    }
    void Request(string path, string method, object body, string done) {
      Perform(async (api, stamp) => {
        await api.Request(path, method, body);
        if (Current(stamp)) note = done;
      });
    }
    static object Cap(string value, bool whole) {
      if (value.Trim().Length == 0) return null;
      double n;
      if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out n) || double.IsInfinity(n) || n <= 0 || n > 9007199254740991 || (whole && Math.Floor(n) != n))
        throw new JosiException("Use positive limits, whole numbers for tokens, or leave a field blank for no cap.");
      return n;
    }
  }
}
