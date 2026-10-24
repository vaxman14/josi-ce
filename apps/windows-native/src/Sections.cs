using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Josi.Native {
  /// Common shape for settings sections: load from the server, render the
  /// page, and drop any result that arrives after the account or view changed.
  public abstract class SectionView : UserControl {
    protected readonly AppModel model; protected readonly Window owner;
    protected string note = "";
    protected bool loading;
    int generation;
    ScrollViewer scroll;
    readonly string ownerId;
    readonly JosiApi api;
    protected SectionView(AppModel model, Window owner) {
      this.model = model; this.owner = owner; ownerId = model.User["id"].Text; api = model.Api;
      Unloaded += delegate { generation++; model.Changed -= SyncEnabled; OnLeave(); };
      Loaded += delegate { model.Changed += SyncEnabled; Render(); StartLoad(); };
    }
    /// The page follows the busy flag as it changes. Render() sets it once, and
    /// a save finishes its last Render while the app is still busy, so without
    /// this a settings page stayed greyed out after every save until something
    /// else happened to redraw it.
    void SyncEnabled() {
      var page = scroll == null ? null : scroll.Content as FrameworkElement;
      if (page != null) page.IsEnabled = !model.Busy && !loading;
    }
    protected virtual void OnLeave() { }
    protected bool Current(int stamp) { return model.Api == api && api != null && model.User["id"].Text == ownerId && generation == stamp && IsLoaded; }
    protected int Stamp { get { return generation; } }
    protected JosiApi Api { get { return api; } }
    protected abstract Task Load();
    protected abstract UIElement Build();

    protected async void StartLoad() {
      if (loading || api == null) return;
      loading = true; Render();
      try { await Load(); }
      catch (OperationCanceledException) { }
      catch (Exception e) { if (IsLoaded) { model.Error = AppModel.Friendly(e); model.Notify(); } }
      finally { loading = false; if (IsLoaded) Render(); }
    }
    protected void Render() {
      if (!IsLoaded && scroll != null) return;
      var page = Build() as FrameworkElement;
      if (page == null) return;
      page.IsEnabled = !model.Busy && !loading;
      var offset = scroll == null ? 0 : scroll.VerticalOffset;
      scroll = Ui.Scroll(page, PageWidth(), 30);
      Content = scroll;
      var target = scroll;
      Dispatcher.BeginInvoke(new Action(() => target.ScrollToVerticalOffset(offset)), DispatcherPriority.Loaded);
    }
    protected virtual double PageWidth() { return Ui.PageWidth; }
    /// Run a server change through the shared busy/error handling, then reload.
    protected void Perform(Func<JosiApi, int, Task> action, bool reload = true) {
      if (api == null || model.Busy || loading) return;
      var stamp = Stamp; note = "";
      model.Run(async () => {
        if (!Current(stamp)) return;
        try { await action(api, stamp); }
        finally { if (IsLoaded) Render(); }
        if (reload && Current(stamp)) { await Load(); Render(); }
      });
    }
    protected FrameworkElement Note() { return note.Length == 0 ? null : (FrameworkElement)Ui.Secondary(note); }
    protected static StackPanel Page(params UIElement[] children) { var page = Ui.Stack(Ui.PageSpacing, children); page.Tag = Ui.PageSpacingTag; return page; }
  }

  public sealed class MemoryView : SectionView {
    List<Wire> memories = new List<Wire>(), suggestions = new List<Wire>();
    string savedMode = "", mode = "manual";
    bool showNarration;
    readonly TextBox added = Ui.Input("Something Josi should remember", "", true);
    readonly Dictionary<string, TextBox> drafts = new Dictionary<string, TextBox>();
    Button addButton;
    public MemoryView(AppModel model, Window owner) : base(model, owner) {
      added.TextChanged += delegate { if (addButton != null) addButton.IsEnabled = added.Text.Trim().Length > 0 && added.Text.Length <= 2000; };
    }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var saved = await api.Request("/persona/memories");
      var pending = await api.Request("/persona/suggestions");
      var settings = await api.Request("/persona/settings");
      if (!Current(stamp)) return;
      var value = settings["settings"]["memory_mode"].Text;
      if (value != "manual" && value != "automatic" && value != "off") throw new JosiException("Saved memory changed. Refresh and review it before applying your edit.");
      var previous = savedMode;
      memories = saved["memories"].List; suggestions = pending["suggestions"].List; savedMode = value;
      showNarration = settings["settings"]["show_narration"].Flag;
      if (previous.Length == 0 || mode == previous) mode = value;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Memory", "Review what Josi remembers and the lessons it proposes.", Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Memories help future work. They cannot change permissions or Cardinal Rules. Keep credentials in the Vault."),
        loading ? Ui.Caption("Loading…") : null, Note());
      var picker = Ui.Choice(Ui.Options("manual", "Review suggestions", "automatic", "Remember conversation facts automatically", "off", "Do not learn new memories"), mode);
      picker.SelectionChanged += delegate { mode = Ui.Selected(picker); Render(); };
      var save = Ui.Pill("Save Learning Preference", () => {
        var desired = mode; var expected = savedMode;
        Perform(async (api, stamp) => {
          var current = await api.Request("/persona/settings");
          if (!Current(stamp)) return;
          if (current["settings"]["memory_mode"].Text != expected) throw new JosiException("Saved memory changed. Refresh and review it before applying your edit.");
          await api.Request("/persona/settings", "PUT", Wires.O("memoryMode", desired));
          note = "Learning preference saved.";
        });
      });
      save.IsEnabled = savedMode.Length > 0 && savedMode != mode;
      Ui.Add(page, Ui.CardBox("Learning preferences", Ui.Field("New memories", picker),
        Ui.Caption("Lessons from completed work always require your review. These settings do not clear existing memories or unfinished work and its saved progress."), save), 20);
      // What Josi writes along the way ("Checking your calendar.") is honest
      // but it is not the answer; the final reply alone is the default.
      var narration = Ui.Toggle("Show what Josi says along the way, above the final answer", showNarration);
      narration.Click += delegate {
        var wanted = narration.IsChecked == true;
        Perform(async (api, stamp) => { await api.Request("/persona/settings", "PUT", Wires.O("showNarration", wanted)); note = wanted ? "Josi will show its steps above the answer." : "Josi will show only the final answer."; });
      };
      Ui.Add(page, Ui.CardBox("Replies", narration, Ui.Caption("With this off, a reply that needed a few steps shows only its result. The steps still run and still appear in the Task Manager.")), 20);
      if (suggestions.Count > 0) {
        Ui.Add(page, Ui.Title2("Proposed memories and lessons"), 20);
        foreach (var item in suggestions) Ui.Add(page, Suggestion(item), 12);
      }
      Ui.Add(page, Ui.Title2("Saved memories"), 20);
      Detach(added);
      Ui.Add(page, added, 12);
      var add = Ui.Pill("Add Memory", () => {
        var content = added.Text.Trim();
        Perform(async (api, stamp) => {
          await api.Request("/persona/memories", "POST", Wires.O("content", content));
          if (Current(stamp)) { added.Text = ""; note = "Memory saved."; }
        });
      });
      add.IsEnabled = added.Text.Trim().Length > 0 && added.Text.Length <= 2000;
      addButton = add;
      Ui.Add(page, add, 10);
      if (memories.Count == 0 && !loading) Ui.Add(page, Ui.Secondary("No saved memories."), 12);
      foreach (var item in memories) Ui.Add(page, Saved(item), 12);
      return page;
    }
    static void Detach(FrameworkElement element) { var panel = element.Parent as Panel; if (panel != null) panel.Children.Remove(element); }
    TextBox Draft(string key, string initial) {
      TextBox box;
      if (!drafts.TryGetValue(key, out box)) { box = Ui.Input(null, initial, true); drafts[key] = box; }
      Detach(box);
      return box;
    }
    UIElement Suggestion(Wire item) {
      var draft = Draft("s:" + item.Id, item["content"].Text);
      var keep = Ui.Pill("Keep This Memory", () => Mutate(item, true, "/decide", "POST", Wires.O("accept", true, "content", draft.Text)), true);
      keep.IsEnabled = draft.Text.Trim().Length > 0 && draft.Text.Length <= 2000;
      return Ui.CardBox(item["work_goal_id"].IsNull ? "Proposed memory" : "Lesson from completed work",
        draft,
        Wires.IsUuid(item["work_goal_id"].Text) ? Ui.Pill("View Source Work", () => Dialogs.MemorySource(owner, model, item)) : null,
        Ui.Row(8, keep, Ui.Pill("Discard Proposal", () => Mutate(item, true, "/decide", "POST", Wires.O("accept", false, "content", "")))),
        Ui.Caption("Edits are saved only when you keep the memory."));
    }
    UIElement Saved(Wire item) {
      var stack = new StackPanel();
      Ui.Add(stack, Ui.Copyable(item["content"].Text), 0);
      var confidence = item["confidence"].IsNumber && item["confidence"].Number < 1 ? " · confidence " + Math.Round(item["confidence"].Number * 100) + "%" : "";
      Ui.Add(stack, Ui.Caption(item["provenance"].Text + confidence + (item["pinned"].Flag ? " · pinned" : "")), 8);
      if (item["confirmed_at"].Text.Length > 0) Ui.Add(stack, Ui.Caption("Confirmed " + Wires.Date(item["confirmed_at"].Text)), 4);
      var editor = new Disclosure("Correct", () => {
        var draft = Draft("m:" + item.Id, item["content"].Text);
        return Ui.Stack(8, draft, Ui.Pill("Save Correction", () => {
          if (draft.Text.Trim().Length == 0 || draft.Text.Length > 2000) return;
          Mutate(item, false, "", "PUT", Wires.O("content", draft.Text));
        }, true));
      });
      Ui.Add(stack, editor, 8);
      Ui.Add(stack, Ui.Row(8,
        Ui.Pill(item["pinned"].Flag ? "Unpin" : "Pin", () => Mutate(item, false, "", "PUT", Wires.O("pinned", !item["pinned"].Flag))),
        Ui.Danger("Delete…", () => {
          if (Dialogs.Confirm(owner, "Delete this saved memory?", "This deletes the saved memory. Its source conversation, task and backups remain.", "Delete Memory"))
            Mutate(item, false, "", "DELETE", null);
        }),
        Wires.IsUuid(item["work_goal_id"].Text) ? Ui.Pill("View Source Work", () => Dialogs.MemorySource(owner, model, item)) : null), 8);
      return Ui.CardBox(null, stack);
    }
    /// Compare against the latest saved row before writing so a concurrent edit is never overwritten.
    void Mutate(Wire expected, bool pending, string suffix, string method, object body) {
      Perform(async (api, stamp) => {
        var collection = pending ? "suggestions" : "memories";
        var id = api.Uuid(expected["id"].Text);
        var latest = await api.Request("/persona/" + collection);
        if (!Current(stamp)) return;
        var row = latest[collection].List.FirstOrDefault(r => r["id"].Text == expected["id"].Text);
        if (row == null || !row.Same(expected)) throw new JosiException("Saved memory changed. Refresh and review it before applying your edit.");
        await api.Request("/persona/" + collection + "/" + id + suffix, method, body ?? (method == "DELETE" ? null : Wires.O()));
        if (!Current(stamp)) return;
        drafts.Remove((pending ? "s:" : "m:") + expected.Id);
        note = pending ? "Your memory decision was saved." : "Saved memory updated.";
      });
    }
  }

  public sealed class VaultView : SectionView {
    string tab = "personal";
    Wire personal = Wire.Null, status = Wire.Null, inventory = Wire.Null, migration = Wire.Null;
    readonly PasswordBox password = Ui.Secret("Password"), recovery = Ui.Secret("Vault recovery key"), value = Ui.Secret("Secret");
    readonly TextBox service = Ui.Input("Service"), slot = Ui.Input("Account or slot", "primary"), label = Ui.Input("Label");
    ComboBox kind;
    readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
    static readonly string[] Kinds = { "password", "api_key", "oauth_token", "secure_note", "recovery_code", "certificate", "private_key", "other" };
    public VaultView(AppModel model, Window owner) : base(model, owner) {
      var options = new List<string>();
      foreach (var k in Kinds) { options.Add(k); options.Add(Wires.Words(k)); }
      kind = Ui.Choice(Ui.Options(options.ToArray()), "password");
      timer.Tick += delegate { if (!model.Busy && owner.IsActive) StartLoad(); };
      Loaded += delegate { timer.Start(); };
    }
    protected override void OnLeave() { timer.Stop(); password.Clear(); recovery.Clear(); value.Clear(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      if (model.IsAdministrator) {
        try {
          var state = await api.Request("/admin/vault");
          if (!Current(stamp)) return; status = state["status"];
          var migrationInventory = await api.Request("/admin/vault/migration");
          if (!Current(stamp)) return; inventory = migrationInventory;
        } catch (Exception) {
          if (!Current(stamp)) return;
          status = Wire.Null; inventory = Wire.Null; personal = Wire.Null; throw;
        }
      }
      try {
        var result = await api.Request("/vault");
        if (!Current(stamp)) return; personal = result;
        if (!result["box"]["unlocked"].Flag) value.Clear();
      } catch (Exception) {
        if (!Current(stamp)) return; personal = Wire.Null;
        if (tab == "personal") throw;
      }
    }
    static void Detach(FrameworkElement element) { var panel = element.Parent as Panel; if (panel != null) panel.Children.Remove(element); }
    FrameworkElement F(string title, Control control) { Detach(control); return Ui.Field(title, control); }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Vault", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("The Vault is the source of truth for credentials and permanent rules. Saved secret values are never returned to this screen."));
      if (model.IsAdministrator)
        Ui.Add(page, Ui.Segments(Ui.Options("personal", "My Credentials", "master", "Master Vault"), tab, t => { tab = t; password.Clear(); recovery.Clear(); value.Clear(); note = ""; Render(); }), 20);
      foreach (var element in tab == "master" && model.IsAdministrator ? Master() : Personal()) Ui.Add(page, element, 20);
      Ui.Add(page, Note(), 20);
      return page;
    }
    IEnumerable<UIElement> Personal() {
      if (personal.IsNull) return new UIElement[] { Ui.Secondary("Credential access is unavailable. Refresh to load current Vault status.") };
      if (!personal["status"]["initialized"].Flag) return new UIElement[] { Ui.T("The super administrator must initialize the Master Vault first.") };
      if (personal["status"]["locked"].Flag) return new UIElement[] { Ui.T("The Master Vault is locked. Credential-dependent work needs the administrator to unlock it.") };
      if (!personal["box"]["unlocked"].Flag)
        return new UIElement[] { Ui.CardBox("Unlock your credential list for five minutes", F("Your Josi password", password),
          Ui.Pill("Unlock", () => Send("/vault/unlock", "POST", Wires.O("password", password.Password)), true)) };
      var list = new List<UIElement>();
      Detach(kind);
      list.Add(Ui.CardBox("Store a credential", Ui.Field("Type", kind), F("Service", service), F("Account or slot", slot), F("Label", label), F("Secret", value),
        Ui.Pill("Save Encrypted", SaveCredential, true)));
      var items = personal["box"]["items"].List;
      var rows = new List<UIElement>();
      if (items.Count == 0) rows.Add(Ui.T("No saved credentials."));
      foreach (var item in items) {
        var id = item.Id; var name = item["label"].Text;
        rows.Add(Ui.Spread(Ui.Stack(4, Ui.Headline(name), Ui.Caption(item["service"].Text + " · " + item["slot"].Text), Ui.Caption("Updated " + Wires.Date(item["updatedAt"].Text))),
          Ui.Row(8,
            Ui.Pill("Check", () => Send("/vault/items/" + Api.Uuid(id) + "/test", "POST", Wires.O(), "Encrypted value integrity verified. Provider access was not tested.")),
            Ui.Danger("Delete…", () => {
              if (Dialogs.Confirm(owner, "Delete " + name + "?", "This removes the saved credential from your Vault. Connections that use it may stop working.", "Delete Credential"))
                Send("/vault/items/" + Api.Uuid(id), "DELETE", null, "Credential deleted.");
            }))));
        rows.Add(Ui.Divider());
      }
      list.Add(Ui.CardBox("Saved credentials", rows.ToArray()));
      return list;
    }
    IEnumerable<UIElement> Master() {
      if (status.IsNull) return new UIElement[] { Ui.T("Master Vault status is unavailable. Refresh before changing it.") };
      var list = new List<UIElement>();
      var initialized = status["initialized"].Flag; var locked = status["locked"].Flag;
      list.Add(Ui.CardBox("Master Vault status",
        Ui.Headline(!initialized ? "Not initialized" : locked ? "Locked" : "Available"),
        Ui.T(status["boxes"].Integer + " user boxes · " + status["items"].Integer + " credentials · Key version " + status["keyVersion"].Integer),
        status["recoveryFingerprint"].IsNull ? null : Ui.Copyable("Recovery fingerprint: " + status["recoveryFingerprint"].Text, 12, Ui.Muted),
        Ui.Caption(status["recentFailures"].Integer + " credential failures in the last 24 hours")));
      list.Add(Ui.CardBox(initialized ? "Emergency lock" : "Initialize Master Vault",
        Ui.T(initialized ? "Locking blocks new use of saved credentials. Work already sent to a service may finish."
                         : "Create the Vault and save its one-time recovery key before continuing."),
        F("Administrator password", password),
        initialized ? Ui.Pill(locked ? "Unlock Master Vault" : "Lock Master Vault", () => Send("/admin/vault/lock", "PUT", Wires.O("password", password.Password, "locked", !locked)))
                    : Ui.Pill("Initialize and Show Recovery Key", () => Send("/admin/vault/initialize", "POST", Wires.O("password", password.Password), "Vault updated.", true), true)));
      if (initialized) {
        var legacy = inventory.IsNull ? -1 : inventory["sources"].List.Sum(s => s["legacyFields"].Integer);
        var migrate = Ui.Pill("Check and Migrate Credentials", () => Send("/admin/vault/migration", "POST", Wires.O("password", password.Password), "Vault updated.", false, true));
        migrate.IsEnabled = !locked;
        list.Add(Ui.CardBox("Upgrade stored credentials",
          legacy >= 0 ? Ui.T(legacy + " credentials still use older encryption.") : null,
          Ui.Caption("Migrate while the original installation key is available. Existing permissions stay unchanged."), migrate,
          migration.IsNull ? null : Ui.T(migration["migrated"].Integer + " migrated · " + migration["checked"].Integer + " already current · " + migration["failed"].Integer + " need attention"),
          migration.IsNull ? null : Ui.Caption(migration["legacyMigrationComplete"].Flag ? "Stored credentials migrated. Provider access and recovery were not tested."
                                                                                       : "Unlock affected boxes or repair unavailable credentials, then run migration again.")));
        list.Add(Ui.CardBox("Offline recovery",
          Ui.T("Use after restoring or replacing the installation key. Recovery preserves the Vault key; automation authority must still be reconciled."),
          F("Vault recovery key", recovery),
          Ui.Pill("Recover Master Vault…", () => {
            if (!Dialogs.Confirm(owner, "Recover the Master Vault?", "Use this recovery key to restore access with the current installation key. Permanent automation rules and enrolled devices still require recovery reconciliation.", "Recover Vault")) return;
            Send("/admin/vault/recover", "POST", Wires.O("password", password.Password, "recoveryKey", recovery.Password));
          })));
      }
      return list;
    }
    void Send(string route, string method, object body, string success = "Vault updated.", bool initialization = false, bool isMigration = false) {
      password.Clear(); recovery.Clear(); value.Clear();
      Perform(async (api, stamp) => {
        var result = await api.Request(route, method, body);
        if (!Current(stamp)) return;
        if (initialization) {
          if (result["recoveryKey"].Text.Length == 0 || result["fingerprint"].Text.Length == 0)
            throw new JosiException("The recovery response was not confirmed. Inspect Vault status before retrying.");
          model.VaultRecovery = result; model.Notify();
        }
        if (isMigration) migration = result;
        note = success;
      });
    }
    void SaveCredential() {
      var name = service.Text.Trim(); var account = slot.Text.Trim();
      if (name.Length == 0 || label.Text.Trim().Length == 0 || value.Password.Length == 0) { model.Error = "Enter a service, label and secret."; model.Notify(); return; }
      if (name.Length > 80 || account.Length > 120 || label.Text.Length > 160) { model.Error = "Use a shorter service, account or label."; model.Notify(); return; }
      var existing = personal["box"]["items"].List.FirstOrDefault(i => i["service"].Text == name && i["slot"].Text == account);
      if (existing != null && !Dialogs.Confirm(owner, "Replace " + existing["label"].Text + "?", "This service and account already have a saved credential. Saving replaces that secret.", "Replace Credential")) return;
      var body = Wires.O("kind", Ui.Selected(kind), "service", name, "slot", account, "label", label.Text, "value", value.Password);
      Send("/vault/items", "POST", body, "Credential saved in the Vault.");
    }
  }

  public sealed class AccountView : SectionView {
    static readonly string[][] Actions = { new[] { "email_send", "Sending email" }, new[] { "calendar_write", "Changing calendar events" },
      new[] { "contacts_write", "Changing contacts" }, new[] { "task_management", "Managing tasks" } };
    static readonly string[][] Levels = { new[] { "always_ask", "Always ask" }, new[] { "risky_only", "Ask for risky or destructive actions" }, new[] { "automatic", "Allow routine actions" } };
    readonly Dictionary<string, Wire> levels = new Dictionary<string, Wire>();
    Wire status = Wire.Null, setup = Wire.Null;
    readonly PasswordBox password = Ui.Secret("Current password"), confirmPassword = Ui.Secret("Current password"), code = Ui.Secret("Six-digit authenticator code");
    public AccountView(AppModel model, Window owner) : base(model, owner) { }
    protected override void OnLeave() { setup = Wire.Null; password.Clear(); confirmPassword.Clear(); code.Clear(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var mfa = await api.Request("/auth/mfa");
      if (!Current(stamp)) return; status = mfa;
      foreach (var action in Actions) {
        var value = await api.Request("/assistant/approval-levels/" + action[0]);
        if (!Current(stamp)) return; levels[action[0]] = value;
      }
    }
    static string LevelName(string value) { var found = Levels.FirstOrDefault(l => l[0] == value); return found == null ? "Unavailable" : found[1]; }
    static bool Allowed(string value, Wire policy) {
      if (!policy["managedPolicy"].Flag) return true;
      var ceiling = Array.FindIndex(Levels, l => l[0] == policy["adminCeiling"].Text);
      var rank = Array.FindIndex(Levels, l => l[0] == value);
      return ceiling >= 0 && rank >= 0 && rank <= ceiling;
    }
    static void Detach(FrameworkElement element) { var panel = element.Parent as Panel; if (panel != null) panel.Children.Remove(element); }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Your Settings", null, Ui.Pill("Refresh", StartLoad)), Ui.Secondary(model.SignedInName + " · " + model.Address));
      var approvals = new List<UIElement> { Ui.Caption("These choices apply to existing email, calendar, contact and task tools. Browser and computer access use the separate Automation permissions.") };
      foreach (var action in Actions) {
        Wire current;
        if (!levels.TryGetValue(action[0], out current)) { approvals.Add(Ui.Secondary(action[1] + ": unavailable")); continue; }
        var selected = current["managedPolicy"].Flag ? current["level"].Text : current["userChoice"].Text;
        var options = new List<KeyValuePair<string, string>>();
        foreach (var level in Levels) if (Allowed(level[0], current)) options.Add(new KeyValuePair<string, string>(level[0], level[1]));
        var picker = Ui.Choice(options, selected);
        var key = action[0];
        picker.SelectionChanged += delegate { SaveLevel(key, Ui.Selected(picker)); };
        approvals.Add(Ui.Field(action[1], picker));
        if (current["managedPolicy"].Flag) approvals.Add(Ui.Caption("Administrator limit: " + LevelName(current["adminCeiling"].Text)));
      }
      approvals.Add(Ui.Caption("Existing mandatory approvals remain in effect. These preferences cannot override Cardinal Rules or administrator restrictions."));
      Ui.Add(page, Ui.CardBox("Routine action approvals", approvals.ToArray()), 20);

      var mfa = new List<UIElement>();
      Detach(password); Detach(code);
      if (status.IsNull) mfa.Add(Ui.T("Refresh to load authentication settings."));
      else if (status["enabled"].Flag) {
        mfa.Add(Ui.Headline("Enabled · " + status["recoveryCodesRemaining"].Integer + " recovery codes remain"));
        mfa.Add(Ui.Field("Current password to disable the authenticator", password));
        mfa.Add(Ui.Danger("Disable Authenticator…", () => {
          if (password.Password.Length == 0) return;
          if (!Dialogs.Confirm(owner, "Disable authenticator sign-in?", "This removes the extra sign-in factor and its remaining recovery codes.", "Disable")) return;
          var secret = password.Password; password.Clear();
          Post("/auth/mfa/disable", Wires.O("password", secret));
        }));
      } else if (!setup.IsNull) {
        mfa.Add(Ui.T("Scan this code in your authenticator app, or enter the manual key. Then enter its six-digit code."));
        var qr = QrImage(); if (qr != null) mfa.Add(qr);
        var secretKey = setup["secret"].Text;
        mfa.Add(new Disclosure("Manual setup key", () => Ui.Copyable(secretKey, 14, null, true)));
        mfa.Add(Ui.Field("Six-digit authenticator code", code));
        mfa.Add(Ui.Row(8, Ui.Pill("Enable Authenticator", () => {
          var value = code.Password; code.Clear();
          if (!Regex.IsMatch(value, "^[0-9]{6}$")) { model.Error = "Enter the six-digit code from your authenticator."; model.Notify(); return; }
          Post("/auth/mfa/enable", Wires.O("code", value));
        }, true), Ui.Pill("Close Setup", () => { setup = Wire.Null; code.Clear(); Render(); })));
      } else {
        mfa.Add(Ui.T("Require a code from an authenticator when you sign in. The authenticator secret is held by the server's Vault."));
        mfa.Add(Ui.Pill("Set Up Authenticator", () => Post("/auth/mfa/setup", Wires.O())));
      }
      Ui.Add(page, Ui.CardBox("Authenticator sign-in", mfa.ToArray()), 20);
      Detach(confirmPassword);
      Ui.Add(page, Ui.CardBox("Confirm your identity",
        Ui.Caption("Some existing task and account operations require a recent password confirmation. Protected rule and permission changes still use their own exact review."),
        Ui.Field("Current password", confirmPassword),
        Ui.Pill("Confirm Password", () => { var secret = confirmPassword.Password; confirmPassword.Clear(); if (secret.Length > 0) Post("/assistant/step-up", Wires.O("password", secret)); })), 20);
      Ui.Add(page, Note(), 20);
      return page;
    }
    UIElement QrImage() {
      var raw = setup["qrDataUrl"].Text; const string prefix = "data:image/png;base64,";
      if (!raw.StartsWith(prefix) || raw.Length > 256 * 1024) return null;
      try {
        var bytes = Convert.FromBase64String(raw.Substring(prefix.Length));
        var image = new BitmapImage(); image.BeginInit(); image.StreamSource = new System.IO.MemoryStream(bytes); image.CacheOption = BitmapCacheOption.OnLoad; image.EndInit();
        if (image.PixelWidth <= 0 || image.PixelWidth > 1024) return null;
        var view = new Image { Source = image, Width = 220, Height = 220, HorizontalAlignment = HorizontalAlignment.Left };
        RenderOptions.SetBitmapScalingMode(view, BitmapScalingMode.NearestNeighbor);
        return new Border { Background = Brushes.White, Padding = new Thickness(8), CornerRadius = new CornerRadius(8), Child = view, HorizontalAlignment = HorizontalAlignment.Left };
      } catch (Exception) { return null; }
    }
    void SaveLevel(string action, string value) {
      Wire current;
      if (!levels.TryGetValue(action, out current) || !Allowed(value, current) || value.Length == 0) return;
      var selected = current["managedPolicy"].Flag ? current["level"].Text : current["userChoice"].Text;
      if (selected == value) return;
      Perform(async (api, stamp) => {
        var result = await api.Request("/assistant/approval-levels/" + action, "PUT", Wires.O("level", value));
        if (Current(stamp)) levels[action] = result;
      }, false);
    }
    void Post(string path, object body) {
      Perform(async (api, stamp) => {
        var result = await api.Request(path, "POST", body);
        if (!Current(stamp)) return;
        if (path == "/auth/mfa/enable") {
          var codes = result["recoveryCodes"].List;
          if (!result["enabled"].Flag || codes.Count != 10 || !codes.All(c => Regex.IsMatch(c.Text, "^[A-F0-9]{6}-[A-F0-9]{6}$"))) {
            setup = Wire.Null;
            throw new JosiException("The final authenticator response could not be verified. Refresh sign-in settings before another attempt; do not assume recovery codes were saved.");
          }
          // Held at app scope before any refresh can discard the one-time codes.
          model.MfaRecovery = new Wire(Wires.O("codes", Wires.A(codes), "server", api.OriginText, "account", model.SignedInName));
          setup = Wire.Null; status = new Wire(Wires.O("enabled", true, "recoveryCodesRemaining", codes.Count));
          model.Notify();
        } else if (path == "/auth/mfa/setup") {
          if (!Regex.IsMatch(result["secret"].Text, "^[A-Z2-7]{16,128}$")) throw new JosiException("Authenticator setup was interrupted. Start setup again.");
          setup = result; note = "";
        } else if (path == "/assistant/step-up") {
          note = "Password confirmed for this session's existing sensitive operations.";
        } else { setup = Wire.Null; status = result; note = "Authenticator sign-in disabled."; }
      }, false);
    }
  }

  public sealed class ServerView : SectionView, IRefresh {
    Wire diagnosis = Wire.Null; bool? available; string message = "", error = "";
    public ServerView(AppModel model, Window owner) : base(model, owner) { model.Changed += Refresh; Unloaded += delegate { model.Changed -= Refresh; }; }
    public void Refresh() { if (IsLoaded) Render(); }
    protected override async Task Load() { await LoadHealth(false); }
    async Task LoadHealth(bool check) {
      if (!model.IsAdministrator) return;
      var api = Api; var stamp = Stamp; error = "";
      try {
        var result = await api.Request(check ? "/admin/doctor/check" : "/admin/doctor", check ? "POST" : "GET", check ? Wires.O() : null);
        if (!Current(stamp)) return;
        available = check || result["available"].Flag;
        diagnosis = check ? result : result["diagnosis"];
        message = check ? "" : result["message"].Text;
      } catch (JosiException e) {
        if (!Current(stamp)) return;
        available = null; diagnosis = Wire.Null; message = ""; error = e.Message;
      }
    }
    protected override UIElement Build() {
      var page = Page(Ui.Heading("Server", model.IsAdministrator ? "Health of the server you are connected to, and the server on this PC." : "The server on this PC."));
      if (model.IsAdministrator) {
        var checks = diagnosis["checks"].List;
        var ordered = checks.Where(c => c["state"].Text == "fail").Concat(checks.Where(c => c["state"].Text == "warn")).Concat(checks.Where(c => c["state"].Text != "fail" && c["state"].Text != "warn"));
        var items = new List<UIElement> {
          Ui.Copyable(model.Api == null ? "" : model.Api.OriginText),
          Ui.Spread(Ui.Headline(available == false ? "Diagnostics unavailable" : diagnosis.IsNull ? "No current diagnosis" : diagnosis["healthy"].Flag ? "No failed checks" : "Needs attention"),
            Ui.Pill("Run System Check", () => model.Run(async () => { await LoadHealth(true); Render(); })))
        };
        if (message.Length > 0) items.Add(Ui.Secondary(message));
        if (error.Length > 0) items.Add(Ui.T(error, 14, null, Ui.Orange));
        if (!diagnosis.IsNull) {
          items.Add(Ui.Caption("Checked " + Wires.Date(diagnosis["checkedAt"].Text)));
          foreach (var check in ordered) {
            var pass = check["state"].Text == "pass";
            var detail = check["detail"].Text;
            var header = Ui.Row(8, Ui.Icon(pass ? Glyph.Check : Glyph.Warning, 14, pass ? Ui.Green : Ui.Orange), Ui.T(check["label"].Text),
              Ui.Caption(pass ? "Working" : check["state"].Text == "warn" ? "Attention" : "Needs repair"));
            items.Add(header);
            if (!pass && detail.Length > 0) items.Add(Ui.Copyable(detail, 13, Ui.Muted));
          }
        }
        items.Add(Ui.Caption("Local service changes use the controls below."));
        Ui.Add(page, Ui.CardBox("Connected server health", items.ToArray()), 0);
      }
      Ui.Add(page, new ServerControls(model, owner, false), 10);
      return page;
    }
  }

  /// Current-desktop automation: this PC and explicitly attached browser tabs.
  /// The VM storage cards are retired. Nothing here claims control exists
  /// before the Windows executor and browser bridge are implemented.
  public sealed class AutomationView : UserControl, IWorkspaceRefresh {
    readonly AppModel model; readonly Window owner;
    public AutomationView(AppModel model, Window owner) { this.model = model; this.owner = owner; Render(); }
    public void WorkspaceUpdated() { Render(); }
    void Render() {
      var page = Ui.Stack(20, Ui.Heading("Automation", "This PC, attached browser tabs, connected devices and current authority."));
      if (model.AutomationLoading) Ui.Add(page, Ui.Caption("Checking automation and Vault settings…"), 20);
      if (model.AutomationError.Length > 0)
        Ui.Add(page, Ui.CardBox("Connection check needs attention", Ui.Copyable(model.AutomationError, 14, Ui.Orange),
          Ui.Row(8, Ui.Pill("Open Vault", () => model.Section = "vault"), Ui.Pill("Check Server", () => model.Section = "server"))), 20);
      var automation = model.Automation;
      if (!automation.IsNull) {
        // Blockers about the retired separate desktop do not apply on this PC,
        // where desktop and browser control run through this app.
        var code = automation["blocker"]["code"].Text;
        var retired = code == "no_workspaces" || code == "device_offline" || code == "local_consent_required" || code == "connection_refreshing" || code == "runtime_unavailable" || code == "human_takeover";
        if (automation["blocker"]["message"].Text.Length > 0 && !retired)
          Ui.Add(page, Ui.CardBox("Before Josi can use the browser", Ui.Copyable(automation["blocker"]["message"].Text),
            automation["blocker"]["code"].Text == "vault_locked" ? Ui.Pill("Open Vault", () => model.Section = "vault") : null,
            Ui.Caption("Your task and original instructions stay saved in Task Manager.")), 20);
      } else if (!model.AutomationLoading && model.AutomationError.Length == 0) Ui.Add(page, Ui.Secondary("Refresh to check the automation connection."), 20);

      Ui.Add(page, Ui.CardBox("This PC",
        Ui.Row(10, Ui.Icon(Glyph.Desktop, 20, Ui.Text), Ui.Headline(Environment.MachineName + " · " + Environment.UserName)),
        Ui.T("Josi works in your current Windows session and in browser tabs you explicitly attach. It does not create a separate desktop, virtual machine or browser profile, and your browser sign-ins stay in your browser."),
        model.IsAdministrator
          ? Ui.T("Desktop control is ready while this app is open: Josi can list windows, read a program's controls, take screenshots, click, type, press keys and open programs, within the permissions under PC Control (or Full control). " +
              (BrowserBridge.Current.Attached ? "A " + BrowserBridge.Current.AttachedBrowser + " tab is attached, so browser control is ready too." : "Attach a tab with the Josi browser extension for browser control."), 14)
          : Ui.T("Desktop and browser control on this PC are run by the administrator's Josi app.", 14),
        Ui.Caption("Who is in control is always shown at the top of the window, with Pause and Stop. Moving your mouse or typing stops Josi immediately for 20 seconds; Josi reads a window again before every next step rather than assuming its last action worked."),
        model.IsAdministrator ? Ui.Pill("Open PC Control", () => model.Section = "pc-control") : null), 20);

      var rooms = automation["workspaces"].List;
      if (rooms.Count > 0) {
        var rows = rooms.Select(w => (UIElement)Ui.Stack(4, Ui.Headline(w["label"].Text), Ui.Secondary(Wires.Words(w["state"].Text)))).ToArray();
        Ui.Add(page, Ui.CardBox("Automation connections on the server", rows), 20);
      }
      if (model.IsAdministrator) Ui.Add(page, Authority(), 20);
      var refresh = Ui.Pill("Refresh Automation", () => model.Run(() => model.LoadAutomation()));
      refresh.IsEnabled = !model.Busy;
      Ui.Add(page, refresh, 20);
      Content = Ui.Scroll(page, Ui.PageWidth, 30);
    }
    UIElement Authority() {
      var settings = model.AutomationSettings;
      var items = new List<UIElement> {
        Ui.Caption("Changes to Cardinal Rules, permissions and protected devices need an exact preview and an independent protected local approval. This Windows app shows the current Vault authority; protected approval on Windows is not available yet, so changes are not offered here.")
      };
      if (settings.IsNull) items.Add(Ui.T("Current Vault settings are unavailable. Refresh before reviewing them.", 14, null, Ui.Orange));
      else {
        items.Add(Ui.T("Cardinal Rules", 15, FontWeights.SemiBold));
        var rules = settings["rules"]["document"]["rules"].List;
        if (rules.Count == 0) items.Add(Ui.Secondary("No permanent rules. An explicit empty policy is in effect."));
        foreach (var rule in rules)
          items.Add(Ui.Stack(4, Ui.Headline(rule["definition"]["label"].Text), Ui.Copyable(rule["definition"]["wording"].Text),
            Ui.Caption("Definition version " + rule["source"]["version"].Integer)));
        var drafts = settings["drafts"].List.Count;
        if (drafts > 0) items.Add(Ui.Caption(drafts + " inactive draft(s) saved in the Vault."));
        items.Add(Ui.T("Permissions", 15, FontWeights.SemiBold));
        if (settings["permissions"]["reconciliationRequired"].Flag) items.Add(Ui.T("Vault recovery must be reconciled before permissions can be enforced.", 14, null, Ui.Orange));
        var policies = settings["permissions"]["document"]["policies"].List;
        if (policies.Count == 0) items.Add(Ui.Secondary("No permission policies. Josi asks before automation actions."));
        foreach (var policy in policies) {
          var lines = new List<UIElement> { Ui.Headline(policy["enabled"].Flag ? "Enabled policy" : "Disabled policy"),
            Ui.Caption("Unmatched actions: " + (policy["unmatched"].Text == "deny" ? "Deny" : "Ask for instructions")) };
          foreach (var rule in policy["rules"].List)
            lines.Add(Ui.Stack(2, Ui.T(rule["action"].Text.Replace(".", " · "), 14, FontWeights.Medium), Ui.Caption(Mode(rule["mode"]))));
          items.Add(Ui.Stack(6, lines.ToArray()));
        }
      }
      items.Add(Ui.T("Protected confirmation devices", 15, FontWeights.SemiBold));
      if (model.AutomationDevicesError.Length > 0) items.Add(Ui.T(model.AutomationDevicesError, 14, null, Ui.Orange));
      var devices = model.AutomationDevices;
      if (devices.IsNull && model.AutomationDevicesError.Length == 0) items.Add(Ui.Secondary("Saved devices have not been loaded. Refresh Automation to check this account."));
      if (devices["reconciliationRequired"].Flag) items.Add(Ui.T("Vault recovery must be reconciled before devices can approve changes.", 14, null, Ui.Orange));
      if (!devices.IsNull && devices["devices"].List.Count == 0) items.Add(Ui.Secondary("No protected confirmation devices are enrolled for this account."));
      foreach (var device in devices["devices"].List)
        items.Add(Ui.Stack(3, Ui.Headline(device["label"].Text), Ui.T(device["revokedAt"].IsNull ? "Enrolled" : "Revoked"),
          Ui.Caption(device["identity"]["serverOrigin"].Text + " · Enrolled " + Wires.Date(device["enrolledAt"].Text))));
      return Ui.CardBox("Rules, permissions and devices", items.ToArray());
    }
    static string Mode(Wire mode) {
      var kind = mode["kind"].Text.Length > 0 ? mode["kind"].Text : mode.Text;
      switch (kind) {
        case "deny": return "Never"; case "ask": return "Ask each time"; case "task": return "For this task";
        case "until": return "Until " + Wires.Date(mode["until"].Text); case "standing": return "Standing for this exact scope";
        default: return Wires.Words(kind);
      }
    }
  }

  /// Administrator: one file with everything important. Back up and save it
  /// anywhere, restore from a file, a daily backup kept on the server, and the
  /// history of what was made.
  public sealed class BackupsView : SectionView {
    Wire view = Wire.Null; bool working, cancelWork; string activity = "";
    readonly CheckBox masterKeySaved = Ui.Toggle("I have saved the installation master key separately");
    readonly CheckBox scheduleOn = Ui.Toggle("Back up every day");
    readonly TextBox hour = Ui.Input("3"), keep = Ui.Input("7"), copyTo = Ui.Input("Optional: a folder to copy the newest backup into, such as a mapped NAS drive");
    bool scheduleLoaded;
    readonly DispatcherTimer timer = new DispatcherTimer();
    bool Running { get { return working || view["backups"].List.Any(b => b["state"].Text == "running"); } }
    public BackupsView(AppModel model, Window owner) : base(model, owner) {
      timer.Tick += delegate { timer.Interval = TimeSpan.FromSeconds(Running ? 3 : 15); if (owner.IsActive && !model.Busy && !working) StartLoad(); };
      timer.Interval = TimeSpan.FromSeconds(15);
      Loaded += delegate { timer.Start(); };
    }
    protected override void OnLeave() { timer.Stop(); cancelWork = true; }
    protected override async Task Load() {
      if (!model.IsAdministrator) return;
      var api = Api; var stamp = Stamp;
      try {
        var result = await api.Request("/ops/admin/backups");
        if (!Current(stamp)) return;
        view = result;
        var s = result["schedule"];
        if (!scheduleLoaded && !s.IsNull) {
          scheduleLoaded = true;
          scheduleOn.IsChecked = s["enabled"].Flag; hour.Text = s["hour"].Integer.ToString(); keep.Text = s["keep"].Integer.ToString(); copyTo.Text = s["copy_to"].Text;
        }
      } catch (Exception) { if (Current(stamp)) view = Wire.Null; throw; }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Backups", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("One file holds everything important. Make it, save it anywhere, and bring it back here or on a new server."));
      if (view.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Backup history is unavailable. Refresh to load the current server state."), 0); return page; }

      Ui.Detach(masterKeySaved);
      Ui.Add(page, Ui.CardBox("Keep your recovery material separately",
        Ui.T(view["masterKeyGuidance"].Text.Length == 0 ? "The installation master key is not included in these archives. Keep it and your Vault recovery copy safe outside Josi." : view["masterKeyGuidance"].Text),
        masterKeySaved), 20);

      var actions = Ui.Wrap(Ui.Pill("Back Up and Save…", BackUp, true), Ui.Pill("Restore from a File…", RestoreFile));
      actions.IsEnabled = !Running && model.IsAdministrator;
      var contents = new List<UIElement> { Ui.Caption(view["contents"].Text), actions };
      if (working) contents.Add(Ui.Row(10, Ui.Working(activity.Length > 0 ? activity : "Working…"), Ui.Pill(cancelWork ? "Cancelling…" : "Cancel", () => { cancelWork = true; Render(); })));
      if (note.Length > 0) contents.Add(Ui.Copyable(note, 13.5));
      Ui.Add(page, Ui.CardBox("Back up and restore", contents.ToArray()), 20);

      Ui.Add(page, ScheduleCard(), 20);

      var history = new List<UIElement>();
      if (view["backups"].List.Count == 0) history.Add(Ui.Caption("No backups have been recorded on this server yet."));
      foreach (var backup in view["backups"].List) {
        var item = backup;
        var row = Ui.Stack(3, Ui.Spread(Ui.T((backup["automatic"].Flag ? "Daily backup" : backup["kind"].Text == "portable" ? "Portable export" : "Backup") + " · " + Wires.Date(backup["created_at"].Text), 14, FontWeights.Medium),
          ModelText.Pill(StateLabel(backup["state"].Text), backup["state"].Text == "complete")));
        row.Children.Add(Ui.Caption(ByteLabel(backup["byte_size"]) + (backup["encrypted"].Flag ? " · encrypted" : "") + (backup["attachment_count"].Integer > 0 ? " · " + backup["attachment_count"].Integer + " attachment(s)" : "")));
        if (backup["state"].Text == "running") {
          row.Children.Add(Ui.T(backup["progress_phase"].Text));
          row.Children.Add(new ProgressBar { Minimum = 0, Maximum = 100, Value = Math.Max(0, Math.Min(100, backup["progress_percent"].Integer)) });
        } else if (backup["state"].Text == "complete") {
          var buttons = Ui.Wrap(Ui.Pill("Save a Copy…", () => Download(item)));
          if (backup["kind"].Text == "full") buttons.Children.Add(Ui.Danger("Restore This One…", () => RestoreStored(item)));
          row.Children.Add(buttons);
        } else if (backup["state"].Text == "failed") row.Children.Add(Ui.T(Wires.Words(backup["error_category"].Text), 12, null, Ui.Orange));
        history.Add(new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(12), Child = row });
      }
      Ui.Add(page, Ui.CardBox("On this server", history.ToArray()), 20);
      return page;
    }

    UIElement ScheduleCard() {
      foreach (var c in new Control[] { scheduleOn, hour, keep, copyTo }) Ui.Detach(c);
      var s = view["schedule"];
      var items = new List<UIElement> { scheduleOn,
        Ui.Caption("Into this server's own backups folder, after the hour you choose, keeping the newest few. A copy on another disk is what protects you from losing this PC: name a folder below, or save a backup by hand now and then."),
        Ui.Field("Hour of the day (0–23)", hour), Ui.Field("How many daily backups to keep", keep), Ui.Field("Copy the newest backup into this folder", copyTo),
        Ui.Wrap(Ui.Pill("Choose a Folder…", () => { var d = new Microsoft.Win32.OpenFolderDialog { Title = "Folder for backup copies" }; if (d.ShowDialog(owner) == true) copyTo.Text = d.FolderName; }),
          Ui.Pill("Save Schedule", SaveSchedule, true)) };
      if (!s.IsNull) {
        if (s["last_run_at"].Text.Length > 0) items.Add(Ui.Caption("Last daily backup: " + Wires.Date(s["last_run_at"].Text) + (s["last_copy_ok"].IsBool ? (s["last_copy_ok"].Flag ? " · copied to the folder" : " · the copy failed: " + s["last_copy_error"].Text) : "")));
        else items.Add(Ui.Caption("No daily backup has run yet."));
        var newest = view["backups"].List.FirstOrDefault(b => b["state"].Text == "complete");
        if (newest != null && s["copy_to"].Text.Length == 0) {
          DateTime made;
          if (DateTime.TryParse(newest["created_at"].Text, null, System.Globalization.DateTimeStyles.RoundtripKind, out made) && (DateTime.UtcNow - made.ToUniversalTime()).TotalDays >= 7)
            items.Add(Ui.T("The newest backup on this server is " + (int)(DateTime.UtcNow - made.ToUniversalTime()).TotalDays + " days old and lives only on this PC. Save a copy somewhere else.", 13.5, null, Ui.Orange));
        }
      }
      return Ui.CardBox("Daily backup", items.ToArray());
    }
    void SaveSchedule() {
      int h, k;
      if (!int.TryParse(hour.Text, out h) || h < 0 || h > 23) { model.Error = "The hour is a number from 0 to 23."; model.Notify(); return; }
      if (!int.TryParse(keep.Text, out k) || k < 1 || k > 60) { model.Error = "Keep between 1 and 60 daily backups."; model.Notify(); return; }
      var body = Wires.O("enabled", scheduleOn.IsChecked == true, "hour", h, "keep", k, "copyTo", copyTo.Text.Trim());
      Perform(async (api, stamp) => { await api.Request("/ops/admin/backups/schedule", "PUT", body); if (Current(stamp)) { scheduleLoaded = false; note = "Schedule saved."; } });
    }

    void Begin(string what) { working = true; cancelWork = false; activity = what; note = ""; Render(); }
    void End() { working = false; activity = ""; model.Activity = ""; }
    void Status(string text) { activity = text; model.Activity = text; Render(); }

    void BackUp() {
      if (Running || model.Busy || !model.IsAdministrator) return;
      var confirmed = masterKeySaved.IsChecked == true;
      Begin("Preparing…");
      model.Run(async () => {
        try { var result = await BackupFlows.BackUpAndSave(model, owner, confirmed, Status, () => cancelWork); if (result != null) note = result; }
        catch (OperationCanceledException) { note = "Cancelled. Nothing was saved."; }
        catch (JosiException e) { note = e.Message; }
        finally { End(); StartLoad(); }
      });
    }
    void RestoreFile() {
      if (Running || model.Busy || !model.IsAdministrator) return;
      Begin("Choosing a file…");
      model.Run(async () => {
        try {
          var result = await BackupFlows.RestoreFromFile(model, owner, false, Status, () => cancelWork);
          if (result != null) { Dialogs.Message(owner, "Restored", result); model.Disconnect(); return; }
        }
        catch (OperationCanceledException) { note = "Cancelled. Nothing was changed."; }
        catch (JosiException e) { note = e.Message; }
        finally { End(); if (IsLoaded) StartLoad(); }
      });
    }
    /// Restoring one of the server's own backups replaces the current database
    /// the same way, with the same snapshot first.
    void RestoreStored(Wire backup) {
      var id = backup.Id;
      Perform(async (api, stamp) => {
        var pre = await api.Request("/ops/admin/restore/preflight");
        var detail = "Everything on this server is replaced by the backup from " + Wires.Date(backup["created_at"].Text) + ", and everyone is signed out. A snapshot is taken first."
          + (pre["masterKeyPresent"].Flag ? "" : "\n\nThe installation master key is not present on this server, so saved logins stay sealed until it is restored too.");
        if (!Dialogs.Confirm(owner, "Restore this backup?", detail, "Restore")) return;
        string passphrase = null;
        if (backup["encrypted"].Flag) { var choice = BackupFlows.AskPassphrase(owner, false, "This backup"); if (choice.Cancelled) return; passphrase = choice.Value; }
        var body = Wires.O("confirm", "restore", "backupId", id);
        if (passphrase != null) body["passphrase"] = passphrase;
        var r = await api.Request("/ops/admin/restore", "POST", body);
        Dialogs.Message(owner, "Restored", r["rowsRestored"].Integer + " database rows came back." + (r["warning"].Text.Length > 0 ? " " + r["warning"].Text : "") + " Everyone is signed out; sign in again.");
        model.Disconnect();
      }, false);
    }
    static long? Count(Wire value) {
      long n;
      if (value.Text.Length > 0 && long.TryParse(value.Text, NumberStyles.None, CultureInfo.InvariantCulture, out n)) return n;
      if (value.IsNumber && value.Number >= 0 && value.Number <= 9007199254740991 && Math.Floor(value.Number) == value.Number) return (long)value.Number;
      return null;
    }
    static string ByteLabel(Wire value) { var n = Count(value); return n.HasValue ? Wires.Bytes(n.Value) : "Size unavailable"; }
    static string StateLabel(string value) {
      switch (value) { case "running": return "Being written"; case "complete": return "Ready"; case "failed": return "Did not finish"; default: return "Status unavailable"; }
    }
    void Download(Wire backup) {
      var size = Count(backup["byte_size"]);
      if (!model.IsAdministrator || !size.HasValue || size.Value <= 0 || !Wires.IsUuid(backup.Id)) return;
      var encrypted = backup["encrypted"].Flag;
      var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "josi-backup-" + Wires.Date(backup["created_at"].Text).Replace(":", "-").Replace(" ", "-") + (encrypted ? ".josi-backup" : ".zip"),
        Filter = encrypted ? "Encrypted Josi backup (*.josi-backup)|*.josi-backup" : "ZIP archive (*.zip)|*.zip" };
      if (dialog.ShowDialog(owner) != true || model.Busy) return;
      var destination = dialog.FileName; var expected = size.Value; var id = backup.Id;
      Begin("Saving…");
      Perform(async (api, stamp) => {
        try {
          await api.DownloadBackup(id, expected, destination, count => Status("Saving backup: " + Wires.Bytes(count) + " of " + Wires.Bytes(expected)), () => cancelWork || !Current(stamp));
          note = "Saved to " + destination + ". Keep the installation master key separately; an archive alone is not a complete recovery.";
        } catch (OperationCanceledException) {
          note = "Download cancelled. The selected destination was not replaced.";
        } finally { End(); }
      }, false);
    }
  }
}
