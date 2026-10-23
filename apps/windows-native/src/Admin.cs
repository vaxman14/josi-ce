using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Josi.Native {
  /// Administrator metadata only. Member conversations, files and credentials are never loaded here.
  public sealed class PeopleView : SectionView {
    List<Wire> people = new List<Wire>(), grants = new List<Wire>(), sessions = new List<Wire>();
    Wire defaultBytes = Wire.Null;
    readonly TextBox email = Ui.Input("Email"), username = Ui.Input("Username"), name = Ui.Input("Display name (optional)");
    string link = "", linkLabel = "";
    bool showSessions;
    public PeopleView(AppModel model, Window owner) : base(model, owner) { }
    protected override void OnLeave() { link = ""; linkLabel = ""; sessions.Clear(); }
    protected override async Task Load() {
      if (!model.IsAdministrator) return;
      var api = Api; var stamp = Stamp;
      var accounts = await api.Request("/admin/users");
      var access = await api.Request("/storage/admin/capabilities");
      var policy = await api.Request("/storage/admin/policy");
      if (!Current(stamp)) return;
      people = accounts["users"].List; grants = access["users"].List; defaultBytes = policy["policy"]["max_total_bytes_per_user"];
      if (showSessions) { var result = await api.Request("/admin/sessions"); if (Current(stamp)) sessions = result["sessions"].List; }
    }
    static void Detach(FrameworkElement element) { var panel = element.Parent as Panel; if (panel != null) panel.Children.Remove(element); }
    bool ValidNew {
      get {
        var address = email.Text.Trim();
        return address.Length <= 254 && address.Contains("@") && !address.Any(char.IsWhiteSpace) && username.Text.Trim().Length > 0 && username.Text.Length <= 80 && name.Text.Length <= 120;
      }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("People", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Manage accounts on this server. Each person keeps their own conversations, tasks and connected files."));
      Detach(email); Detach(username); Detach(name);
      Ui.Add(page, Ui.CardBox("Add a member", Ui.Field("Email", email), Ui.Field("Username", username), Ui.Field("Display name (optional)", name),
        Ui.Pill("Create Invitation", Invite, true),
        Ui.Caption("Creates a member account. Share the invitation yourself; this button does not send an email.")), 20);
      if (link.Length > 0)
        Ui.Add(page, Ui.CardBox(linkLabel, Ui.T("This one-time link sets the account password. Share it only with that person. They can use \"Invitation or password reset\" in the Josi sign-in screen."),
          Ui.Copyable(link, 12, null, true), Ui.Pill("Hide Link", () => { link = ""; linkLabel = ""; Render(); })), 20);
      foreach (var person in people) Ui.Add(page, Person(person), 14);
      var signIns = new Disclosure("Active sign-ins", () => {
        var list = Ui.Stack(12, Ui.Caption("The server returns up to 500 current sign-ins. Ending your own sign-in requires signing in again."));
        foreach (var session in sessions) {
          var s = session;
          Ui.Add(list, Ui.Spread(Ui.Stack(4, Ui.Headline(s["username"].Text), Ui.Caption(s["user_agent"].Text.Length == 0 ? "Unknown client" : s["user_agent"].Text),
            Ui.Caption("Address: " + (s["ip"].Text.Length == 0 ? "Unavailable" : s["ip"].Text)), Ui.Caption("Last active: " + Wires.Date(s["last_seen_at"].Text))),
            Ui.Danger("End Sign-in…", () => Revoke(s))), 12);
        }
        return list;
      }, showSessions);
      Ui.Add(page, signIns, 20);
      signIns.Toggled += open => { if (open != showSessions) { showSessions = open; if (open) StartLoad(); else sessions.Clear(); } };
      Ui.Add(page, Note(), 20);
      return page;
    }
    UIElement Person(Wire person) {
      var grant = grants.FirstOrDefault(g => g["user_id"].Text == person["id"].Text) ?? Wire.Null;
      var isSelf = person["id"].Text == model.User["id"].Text;
      var header = Ui.Spread(Ui.Headline(person["display_name"].Text.Length == 0 ? person["username"].Text : person["display_name"].Text),
        Ui.Row(10, Ui.T(person["role"].Text == "super_admin" ? "Super administrator" : "Member"), Ui.Secondary(Wires.Capitalize(person["status"].Text))));
      var editor = new Disclosure("Account and folder access", () => PersonEditor(person, grant, isSelf));
      return Ui.CardBox(null, header, Ui.Secondary(person["email"].Text), editor);
    }
    UIElement PersonEditor(Wire person, Wire grant, bool isSelf) {
      var user = Ui.Input(null, person["username"].Text); var mail = Ui.Input(null, person["email"].Text); var display = Ui.Input(null, person["display_name"].Text);
      var stack = Ui.Stack(12, Ui.Field("Username", user), Ui.Field("Email", mail), Ui.Field("Display name", display),
        Ui.Pill("Save Account", () => {
          if (user.Text.Trim().Length == 0 || user.Text.Length > 80 || !mail.Text.Contains("@") || mail.Text.Length > 254 || display.Text.Length > 120) { model.Error = "Check the username, email and display name."; model.Notify(); return; }
          Update(person, Wires.O("username", user.Text, "email", mail.Text, "displayName", display.Text));
        }, true));
      var actions = Ui.Wrap(Ui.Pill("Password Reset…", () => Reset(person)), Ui.Pill("End All Sign-ins…", () => RevokeAll(person)),
        isSelf ? null : Ui.Pill(person["status"].Text == "active" ? "Disable Account…" : "Enable Account…", () => SetStatus(person)));
      Ui.Add(stack, actions, 12);
      if (!grant.IsNull && person["status"].Text == "active") {
        var local = Ui.Toggle("Map local folders", grant["may_map_local"].Flag);
        var cloud = Ui.Toggle("Map cloud folders", grant["may_map_cloud"].Flag);
        var index = Ui.Toggle("Index and search connected files", grant["may_index"].Flag);
        var bytes = Ui.Input(null, Gib(grant["max_bytes"]));
        var files = Ui.Input(null, grant["max_files"].IsNull ? "" : grant["max_files"].Integer.ToString(CultureInfo.InvariantCulture));
        Ui.Add(stack, Ui.Divider(), 12);
        Ui.Add(stack, Ui.Headline("Folder access"), 12);
        Ui.Add(stack, local, 10); Ui.Add(stack, cloud, 10); Ui.Add(stack, index, 10);
        Ui.Add(stack, Ui.Caption(grant["mappings"].Integer + " mapped folder(s). Removing indexing access purges derived searchable content."), 8);
        Ui.Add(stack, Ui.Field("Storage override in GiB; blank uses server default", bytes), 10);
        Ui.Add(stack, Ui.Caption(defaultBytes.IsNull ? "Server storage default unavailable." : "Current server default: " + Gib(defaultBytes) + " GiB"), 4);
        Ui.Add(stack, Ui.Field("File-count override; blank uses server default", files), 10);
        Ui.Add(stack, Ui.Pill("Save Folder Access", () => {
          object maxBytes = null, maxFiles = null; double b; int f;
          if (bytes.Text.Trim().Length > 0) { if (!double.TryParse(bytes.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out b) || b < 0 || b * 1073741824 > 9007199254740991) { model.Error = "Enter a valid storage limit."; model.Notify(); return; } maxBytes = Math.Round(b * 1073741824); }
          if (files.Text.Trim().Length > 0) { if (!int.TryParse(files.Text, out f) || f < 0) { model.Error = "Enter a valid file count."; model.Notify(); return; } maxFiles = f; }
          if (grant["may_index"].Flag && index.IsChecked != true &&
              !Dialogs.Confirm(owner, "Remove indexing access?", "This disables indexing on the member's mapped folders and deletes their derived searchable content.", "Remove Access")) return;
          UpdateStorage(person, grant, Wires.O("mayMapLocal", local.IsChecked == true, "mayMapCloud", cloud.IsChecked == true, "mayIndex", index.IsChecked == true, "maxBytes", maxBytes, "maxFiles", maxFiles));
        }, true), 10);
      }
      return stack;
    }
    static string Gib(Wire value) {
      if (value.IsNull) return "";
      double n;
      if (value.IsNumber) n = value.Number;
      else if (!Regex.IsMatch(value.Text, "^[0-9]+$") || !double.TryParse(value.Text, NumberStyles.None, CultureInfo.InvariantCulture, out n)) return "Unavailable";
      return (n / 1073741824).ToString("0.###", CultureInfo.InvariantCulture);
    }
    async Task RequirePerson(JosiApi api, Wire original) {
      var id = api.Uuid(original["id"].Text);
      var response = await api.Request("/admin/users");
      var fresh = response["users"].List.FirstOrDefault(u => u["id"].Text == id);
      if (fresh == null || new[] { "id", "username", "email", "display_name", "role", "status" }.Any(k => !fresh[k].Same(original[k])))
        throw new JosiException("This account changed. Refresh People and review it before saving.");
    }
    void ShowLink(Wire value, string label) {
      Uri url;
      if (!Uri.TryCreate(value.Text, UriKind.Absolute, out url) || (url.Scheme != "http" && url.Scheme != "https") || url.UserInfo.Length > 0
          || url.AbsolutePath != "/set-password" || url.Fragment.Length > 0 || !Regex.IsMatch(url.Query, "^\\?token=[A-Za-z0-9_-]{43}$"))
        throw new JosiException("The account was created or updated, but its returned link is invalid. Review the server's public address before issuing a new reset link.");
      link = value.Text; linkLabel = label;
    }
    void Invite() {
      if (!ValidNew) { model.Error = "Enter a valid email address and username."; model.Notify(); return; }
      var body = Wires.O("email", email.Text.Trim(), "username", username.Text.Trim(), "displayName", name.Text);
      link = ""; linkLabel = "";
      Perform(async (api, stamp) => {
        var result = await api.Request("/admin/users", "POST", body);
        if (!Current(stamp)) return;
        email.Text = ""; username.Text = ""; name.Text = "";
        ShowLink(result["inviteLink"], "Invitation · expires in seven days");
      });
    }
    void Update(Wire person, object patch) {
      Perform(async (api, stamp) => {
        await RequirePerson(api, person);
        if (!Current(stamp)) return;
        await api.Request("/admin/users/" + api.Uuid(person["id"].Text), "PATCH", patch);
        if (Current(stamp)) note = "Account updated.";
      });
    }
    void UpdateStorage(Wire person, Wire original, object patch) {
      Perform(async (api, stamp) => {
        await RequirePerson(api, person);
        var fresh = await api.Request("/storage/admin/capabilities");
        var row = fresh["users"].List.FirstOrDefault(r => r["user_id"].Text == person["id"].Text);
        if (row == null || new[] { "may_map_local", "may_map_cloud", "may_index", "max_files", "max_bytes" }.Any(k => !row[k].Same(original[k])))
          throw new JosiException("Folder access changed. Refresh and review its current settings.");
        if (!Current(stamp)) return;
        await api.Request("/storage/admin/capabilities/" + api.Uuid(person["id"].Text), "PUT", patch);
        if (Current(stamp)) note = "Folder access updated.";
      });
    }
    void Reset(Wire person) {
      if (!Dialogs.Confirm(owner, "Issue a password reset for " + person["username"].Text + "?", "This replaces any earlier unused password-reset link for this account. No email will be sent.", "Issue Reset")) return;
      link = ""; linkLabel = "";
      Perform(async (api, stamp) => {
        await RequirePerson(api, person);
        if (!Current(stamp)) return;
        var result = await api.Request("/admin/users/" + api.Uuid(person["id"].Text) + "/reset-link", "POST", Wires.O());
        if (Current(stamp)) ShowLink(result["link"], "Password reset · expires in one hour");
      });
    }
    void RevokeAll(Wire person) {
      if (!Dialogs.Confirm(owner, "End all sign-ins for " + person["username"].Text + "?", "This signs them out of Josi on every connected device.", "End All Sign-ins")) return;
      var self = person["id"].Text == model.User["id"].Text;
      Perform(async (api, stamp) => {
        await RequirePerson(api, person);
        if (!Current(stamp)) return;
        var result = await api.Request("/admin/users/" + api.Uuid(person["id"].Text) + "/sessions", "DELETE", null);
        if (Current(stamp)) note = result["revoked"].Integer + " sign-in(s) ended.";
        if (self) await model.SignOut();
      }, !self);
    }
    void SetStatus(Wire person) {
      var disable = person["status"].Text == "active";
      if (!Dialogs.Confirm(owner, (disable ? "Disable " : "Enable ") + person["username"].Text + "?",
        disable ? "This prevents sign-in and ends their current sessions. Their account and saved work remain." : "This allows the account to sign in again.", disable ? "Disable" : "Enable")) return;
      Update(person, Wires.O("status", disable ? "disabled" : "active"));
    }
    void Revoke(Wire session) {
      if (!Dialogs.Confirm(owner, "End this sign-in for " + session["username"].Text + "?", "That client will need to sign in again.", "End Sign-in")) return;
      Perform(async (api, stamp) => {
        var fresh = await api.Request("/admin/sessions");
        if (!fresh["sessions"].List.Any(s => s["id"].Same(session["id"]) && s["user_id"].Same(session["user_id"])) || !Current(stamp))
          throw new JosiException("This sign-in is no longer current. Refresh the list.");
        await api.Request("/admin/sessions/" + api.Uuid(session["id"].Text), "DELETE", null);
        if (Current(stamp)) note = "Sign-in ended.";
      });
    }
  }

  public sealed class MailSettingsView : SectionView {
    sealed class Draft {
      public CheckBox Copy = Ui.Toggle("Use the system email server and login");
      public TextBox Host = Ui.Input(), Port = Ui.Input(null, "587"), Username = Ui.Input(), FromName = Ui.Input(null, "Josi"), FromAddress = Ui.Input();
      public ComboBox Security = Ui.Choice(Ui.Options("starttls", "STARTTLS", "tls", "TLS", "none", "None"), "starttls");
      public PasswordBox Password = Ui.Secret("Password");
      public CheckBox Clear = Ui.Toggle("Clear the saved password");
      public bool PasswordSet;
      public string Original = "";
      // The port and the connection security must agree, and the commonest
      // way to break mail delivery is that they do not (587 with TLS never
      // connects: that port speaks plain text first and upgrades). Typing the
      // port picks the matching security; any mismatch is said out loud.
      public readonly TextBlock Hint = Ui.Caption("");
      bool loading;
      public Draft() {
        Hint.Foreground = Ui.Orange; Hint.TextWrapping = TextWrapping.Wrap; Hint.Visibility = Visibility.Collapsed;
        Port.TextChanged += delegate {
          if (loading) return;
          var wanted = Port.Text.Trim() == "465" ? "tls" : Port.Text.Trim() == "587" ? "starttls" : null;
          if (wanted != null && Ui.Selected(Security) != wanted)
            foreach (ComboBoxItem item in Security.Items) if ((string)item.Tag == wanted) Security.SelectedItem = item;
          UpdateHint();
        };
        Security.SelectionChanged += delegate { UpdateHint(); };
      }
      public void UpdateHint() {
        var port = Port.Text.Trim(); var security = Ui.Selected(Security);
        string text = null;
        if (port == "587" && security == "tls") text = "Port 587 starts in plain text and then upgrades, so choose STARTTLS. With TLS here the server cannot connect.";
        else if (port == "465" && security == "starttls") text = "Port 465 is encrypted from the first byte, so choose TLS. With STARTTLS here the server cannot connect.";
        else if (security == "none" && (port == "587" || port == "465")) text = "No encryption on a mail submission port: most providers refuse it. Choose STARTTLS (587) or TLS (465).";
        Hint.Text = text ?? ""; Hint.Visibility = text == null ? Visibility.Collapsed : Visibility.Visible;
      }
      public void Apply(Wire value, bool communications) {
        loading = true;
        Copy.IsChecked = communications && (value.IsNull || value["copyFromSystem"].Flag);
        Host.Text = value["host"].Text; Username.Text = value["username"].Text;
        Port.Text = value["port"].IsNull ? "587" : value["port"].Integer.ToString(CultureInfo.InvariantCulture);
        var security = value["security"].Text.Length == 0 ? "starttls" : value["security"].Text;
        foreach (ComboBoxItem item in Security.Items) if ((string)item.Tag == security) Security.SelectedItem = item;
        PasswordSet = value["passwordSet"].Flag;
        FromName.Text = value.IsNull ? "Josi" : value["fromName"].Text; FromAddress.Text = value["fromAddress"].Text;
        Password.Clear(); Clear.IsChecked = false;
        loading = false; UpdateHint();
        Original = Snapshot();
      }
      public string Snapshot() {
        return string.Join("\u0001", new[] { Copy.IsChecked == true ? "1" : "0", Host.Text, Port.Text, Ui.Selected(Security), Username.Text,
          Password.Password.Length > 0 ? "p" : "", Clear.IsChecked == true ? "c" : "", FromName.Text, FromAddress.Text });
      }
      public bool Dirty { get { return Snapshot() != Original; } }
      public Dictionary<string, object> Body() {
        int port;
        if (!Regex.IsMatch(FromAddress.Text, "^[^\\s@<>,;]+@[^\\s@<>,;]+$") || FromAddress.Text.Length > 254 || FromName.Text.Length > 120
            || Username.Text.Length > 320 || Host.Text.Length > 253 || Password.Password.Length > 4096 || (Clear.IsChecked == true && Password.Password.Length > 0)
            || (Copy.IsChecked != true && Host.Text.Trim().Length == 0) || !int.TryParse(Port.Text, out port) || port < 1 || port > 65535) return null;
        return Wires.O("copyFromSystem", Copy.IsChecked == true, "host", Host.Text, "port", port, "security", Ui.Selected(Security), "username", Username.Text,
          "password", Password.Password, "clearPassword", Clear.IsChecked == true, "fromName", FromName.Text, "fromAddress", FromAddress.Text);
      }
    }
    Wire saved = Wire.Null, delivery = Wire.Null;
    readonly Draft system = new Draft(), communications = new Draft();
    readonly ComboBox testKind = Ui.Choice(Ui.Options("system", "System", "communications", "Communications"), "system");
    readonly TextBox recipient = Ui.Input("Recipient email address");
    bool showDelivery;
    public MailSettingsView(AppModel model, Window owner) : base(model, owner) {
      communications.Copy.Click += delegate { if (communications.Copy.IsChecked == true) { communications.Password.Clear(); communications.Clear.IsChecked = false; } Render(); };
    }
    protected override void OnLeave() { system.Password.Clear(); communications.Password.Clear(); }
    void Apply(Wire value) {
      saved = value;
      system.Apply(value["profiles"].List.FirstOrDefault(p => p["kind"].Text == "system") ?? Wire.Null, false);
      communications.Apply(value["profiles"].List.FirstOrDefault(p => p["kind"].Text == "communications") ?? Wire.Null, true);
    }
    protected override async Task Load() {
      if (!model.IsAdministrator) return;
      var api = Api; var stamp = Stamp;
      var value = await api.Request("/admin/mail/smtp");
      if (Current(stamp)) Apply(value);
      if (showDelivery) { var d = await api.Request("/admin/mail"); if (Current(stamp)) delivery = d; }
    }
    static FrameworkElement F(string label, Control control) { var panel = control.Parent as Panel; if (panel != null) panel.Children.Remove(control); return Ui.Field(label, control); }
    static FrameworkElement D(FrameworkElement element) { var panel = element.Parent as Panel; if (panel != null) panel.Children.Remove(element); return element; }
    bool Dirty { get { return system.Dirty || communications.Dirty; } }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Email Delivery", null, Ui.Pill("Reload Saved Settings", () => {
          if (Dirty && !Dialogs.Confirm(owner, "Discard unsaved email changes?", "Reloading replaces the form with the server's saved settings.", "Reload")) return;
          StartLoad();
        })),
        Ui.Secondary("System email handles sign-in and password recovery. Communications email sends Josi's work messages. Passwords are kept in the server's Vault."));
      if (saved.IsNull) { Ui.Add(page, Ui.Secondary("Email settings have not loaded."), 20); return page; }
      Ui.Add(page, Profile("System email", system, false), 20);
      Ui.Add(page, Profile("Communications email", communications, true), 20);
      Ui.Add(page, Ui.Pill("Save Both Email Profiles", Save, true), 20);
      Ui.Add(page, Ui.Caption("Saving does not send email or report delivery as verified. Use the explicit test below after saving."), 6);
      Ui.Add(page, Ui.CardBox("Send a test message", F("Saved profile", testKind), F("Recipient email address", recipient),
        Ui.Pill("Send One Test Email", Test),
        Ui.Caption("Save or reload your changes before sending a test. Sends one fixed test message to this address. Check its inbox to confirm delivery.")), 20);
      var deliveryPanel = new Disclosure("Recent delivery status", () => {
        var list = Ui.Stack(10, Ui.Pill("Refresh Delivery Status", StartLoad));
        if (!delivery.IsNull) {
          Ui.Add(list, Ui.T(delivery["counts"]["sent"].Integer + " sent · " + delivery["counts"]["failed"].Integer + " failed · " + delivery["counts"]["quarantined"].Integer + " quarantined"), 10);
          Ui.Add(list, Ui.Caption("Up to 200 work-message delivery records. Subjects and message contents are private. Test messages are reported above."), 4);
          foreach (var item in delivery["deliveries"].List)
            Ui.Add(list, Ui.Spread(Ui.Stack(3, Ui.T(item["recipient"].Text), Ui.Caption("Requested by " + item["initiated_by"].Text),
              Ui.Caption(Wires.Date(item["sent_at"].Text.Length == 0 ? item["queued_at"].Text : item["sent_at"].Text))),
              Ui.Secondary(Wires.Words(item["status"].Text) + (item["error_category"].Text.Length > 0 ? " · " + item["error_category"].Text.Replace("_", " ") : ""))), 10);
        }
        return list;
      }, showDelivery);
      deliveryPanel.Toggled += open => { if (open != showDelivery) { showDelivery = open; if (open) StartLoad(); else delivery = Wire.Null; } };
      Ui.Add(page, deliveryPanel, 20);
      Ui.Add(page, new Disclosure("Remove email configuration", () => {
        var list = Ui.Stack(10, Ui.Caption("Removing system email also removes communications email if it uses the system server. Previously saved messages and delivery history remain."));
        foreach (var row in saved["profiles"].List) { var kind = row["kind"].Text; Ui.Add(list, Ui.Danger("Remove " + Wires.Capitalize(kind) + " Profile…", () => Remove(kind)), 8); }
        return list;
      }), 12);
      Ui.Add(page, Note(), 20);
      return page;
    }
    UIElement Profile(string title, Draft draft, bool communicationProfile) {
      var items = new List<UIElement>();
      if (communicationProfile) {
        items.Add(D(draft.Copy));
        if (draft.Copy.IsChecked == true) items.Add(Ui.Caption("Uses the system credential directly from the Vault. Saving removes any separate communications password."));
      }
      if (draft.Copy.IsChecked != true || !communicationProfile) {
        items.Add(F("SMTP server", draft.Host)); items.Add(F("Port", draft.Port)); items.Add(F("Connection security", draft.Security));
        items.Add(D(draft.Hint));
        items.Add(F("Username", draft.Username));
        items.Add(F(draft.PasswordSet ? "Replacement password; blank keeps saved password" : "Password", draft.Password));
        items.Add(D(draft.Clear));
        items.Add(Ui.Caption("Changing the server or account requires entering its password again, or explicitly clearing it."));
      }
      items.Add(F("From name", draft.FromName)); items.Add(F("From email address", draft.FromAddress));
      if (communicationProfile) items.Add(Ui.Pill("Use the System Sender", () => { communications.FromName.Text = system.FromName.Text; communications.FromAddress.Text = system.FromAddress.Text; }));
      return Ui.CardBox(title, items.ToArray());
    }
    void Save() {
      var sys = system.Body(); var comms = communications.Body();
      if (sys == null || comms == null || saved.IsNull) { model.Error = "Check the email settings: a valid sender address, server and port are required."; model.Notify(); return; }
      var body = Wires.O("system", sys, "communications", comms, "expected", saved["versions"]);
      system.Password.Clear(); communications.Password.Clear();
      Perform(async (api, stamp) => {
        var result = await api.Request("/admin/mail/smtp", "PUT", body);
        if (!Current(stamp)) return;
        Apply(result); note = "Email settings saved. No email was sent.";
      }, false);
    }
    void Test() {
      if (Dirty) { model.Error = "Save or reload your changes before sending a test."; model.Notify(); return; }
      var kind = Ui.Selected(testKind);
      var profile = saved["profiles"].List.FirstOrDefault(p => p["kind"].Text == kind);
      if (profile == null || !Regex.IsMatch(recipient.Text, "^[^\\s@<>,;]+@[^\\s@<>,;]+$") || recipient.Text.Length > 254) { model.Error = "Choose a saved profile and enter a valid recipient."; model.Notify(); return; }
      var body = Wires.O("to", recipient.Text, "configurationVersion", profile["configurationVersion"]);
      note = "Sending one test message…";
      Perform(async (api, stamp) => {
        try {
          var result = await api.Request("/admin/mail/smtp/" + kind + "/test", "POST", body);
          if (Current(stamp)) note = result["accepted"].Flag ? "The server accepted the message. Check the recipient's inbox to confirm delivery." : "The test could not be confirmed.";
        } catch (JosiException) {
          if (Current(stamp)) note = "The test was not confirmed. Check the recipient's inbox before deciding whether to send another.";
          throw;
        }
      }, false);
    }
    void Remove(string kind) {
      if (Dirty) return;
      var detail = kind == "system" ? "This removes the system email server and password. A communications profile that uses it is removed too. Password-reset email will stop until reconfigured."
        : "This removes communications email configuration and its separate password. System password-reset email remains configured.";
      if (!Dialogs.Confirm(owner, "Remove " + kind + " email?", detail, "Remove Profile")) return;
      var expected = saved["versions"];
      Perform(async (api, stamp) => {
        var result = await api.Request("/admin/mail/smtp/" + kind, "DELETE", Wires.O("expected", expected));
        if (Current(stamp)) { Apply(result); note = "Email profile removed."; }
      }, false);
    }
  }

  public sealed class ChannelsView : UserControl {
    public ChannelsView(AppModel model, Window owner) {
      var host = new ContentControl { Focusable = false };
      Action<string> show = null;
      show = provider => {
        var picker = Ui.Segments(Ui.Options("telegram", "Telegram", "whatsapp", "WhatsApp", "slack", "Slack"), provider, show);
        picker.Margin = new Thickness(20, 20, 20, 0);
        var dock = new DockPanel();
        DockPanel.SetDock(picker, Dock.Top);
        dock.Children.Add(picker);
        dock.Children.Add(new ChannelView(model, owner, provider));
        host.Content = dock;
      };
      show("telegram");
      Content = host;
    }
  }

  /// Per-user link codes and administrator channel configuration. Credentials
  /// go to the server's Vault and are never shown again.
  public sealed class ChannelView : SectionView {
    readonly string provider;
    Wire status = Wire.Null, config = Wire.Null, health = Wire.Null, minted = Wire.Null;
    List<Wire> links = new List<Wire>(), adminLinks = new List<Wire>();
    readonly Dictionary<string, Control> credentials = new Dictionary<string, Control>();
    readonly CheckBox filesEnabled = Ui.Toggle("Accept files from Telegram");
    readonly TextBox limitMB = Ui.Input("Maximum file size in MiB (1–20)");
    DateTime? deadline;
    readonly DispatcherTimer poll = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
    string Label { get { return provider == "whatsapp" ? "WhatsApp" : provider == "slack" ? "Slack" : "Telegram"; } }
    bool Telegram { get { return provider == "telegram"; } }
    string[][] Fields {
      get {
        if (Telegram) return new[] { new[] { "token", "Bot token" } };
        return provider == "whatsapp"
          ? new[] { new[] { "appSecret", "Meta app secret" }, new[] { "accessToken", "Permanent access token" }, new[] { "phoneNumberId", "Phone number ID" }, new[] { "webhookSecret", "Webhook verification token" } }
          : new[] { new[] { "signingSecret", "Signing secret" }, new[] { "botToken", "Bot token" } };
      }
    }
    public ChannelView(AppModel model, Window owner, string provider) : base(model, owner) {
      this.provider = provider;
      foreach (var f in Fields) credentials[f[0]] = f[0] == "phoneNumberId" ? (Control)Ui.Input() : Ui.Secret(f[1]);
      poll.Tick += async delegate {
        if (minted.IsNull || !deadline.HasValue) { poll.Stop(); return; }
        if (DateTime.UtcNow >= deadline.Value) { ClearCode(); Render(); return; }
        if (!owner.IsActive || model.Busy || Api == null) return;
        var stamp = Stamp;
        try {
          var value = await Api.Request(Telegram ? "/telegram" : "/channels");
          if (!Current(stamp)) return;
          var before = links.Where(l => l["status"].Text == "active").Select(l => l.Id).ToList();
          Adopt(value);
          if (links.Any(l => l["status"].Text == "active" && !before.Contains(l.Id))) { ClearCode(); note = "Your " + Label + " connection is linked."; }
          Render();
        } catch (JosiException e) {
          if (e.Status == 401 || e.Status == 403) { ClearCode(); note = "Sign in again to manage your " + Label + " link."; Render(); }
        }
      };
    }
    protected override void OnLeave() { poll.Stop(); ClearCode(); foreach (var c in credentials.Values) { var p = c as PasswordBox; if (p != null) p.Clear(); } }
    void ClearCode() { minted = Wire.Null; deadline = null; poll.Stop(); }
    void Adopt(Wire value) {
      if (Telegram) { status = value; links = value["links"].List; return; }
      status = value["channels"].List.FirstOrDefault(c => c["provider"].Text == provider) ?? Wire.Null;
      links = value["links"].List.Where(l => l["provider"].Text == provider).ToList();
    }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var own = await api.Request(Telegram ? "/telegram" : "/channels");
      if (!Current(stamp)) return;
      Adopt(own);
      if (!model.IsAdministrator) return;
      if (Telegram) {
        var saved = await api.Request("/admin/telegram");
        var users = await api.Request("/admin/telegram/links");
        var delivery = await api.Request("/admin/telegram/health");
        if (!Current(stamp)) return;
        config = saved["telegram"]; adminLinks = users["links"].List; health = delivery;
        filesEnabled.IsChecked = config["attachmentsEnabled"].Flag;
        limitMB.Text = Math.Max(1, Math.Min(20, config["maxAttachmentBytes"].Integer / (1024 * 1024))).ToString(CultureInfo.InvariantCulture);
      } else {
        var settings = await api.Request("/admin/channels");
        if (Current(stamp)) config = settings["channels"].List.FirstOrDefault(c => c["provider"].Text == provider) ?? Wire.Null;
      }
    }
    static FrameworkElement F(string label, Control control) { var panel = control.Parent as Panel; if (panel != null) panel.Children.Remove(control); return Ui.Field(label, control); }
    protected override UIElement Build() {
      var page = Page(Ui.Heading(Label, "Message the same Josi account from " + Label + "."), loading ? Ui.Caption("Loading…") : null, Note());
      var channel = Telegram ? status["channel"] : status;
      if (!status.IsNull) {
        var enabled = channel["enabled"].Flag;
        var items = new List<UIElement>();
        if (Telegram) {
          items.Add(Ui.T(enabled ? "Messages you send to the linked bot become your private Josi conversation. Work started there can show its saved progress in Telegram."
                                 : "Telegram is off on this server. An administrator can configure and enable the bot below."));
          items.Add(Ui.Caption(channel["attachmentsEnabled"].Flag ? "Files are accepted within this server's limits." : "This server does not accept files through Telegram."));
        } else {
          items.Add(Ui.T(enabled ? "This channel is available." : "This channel is off on the server."));
          items.Add(Ui.Caption("Create a one-time code, then send the command below to Josi in " + Label + "."));
        }
        if (enabled && !(Telegram && links.Any(l => l["status"].Text == "active")))
          items.Add(Ui.Pill(minted.IsNull ? (Telegram ? "Create One-Time Link" : "Create One-Time Code") : (Telegram ? "Replace One-Time Link" : "Replace One-Time Code"), Mint));
        if (!minted.IsNull) {
          if (Telegram) {
            var bot = channel["botUsername"].Text; var code = minted["code"].Text;
            var expectedLink = "https://t.me/" + bot + "?start=" + code;
            if (Regex.IsMatch(bot, "^[A-Za-z0-9_]{5,32}$") && Regex.IsMatch(code, "^[A-Za-z0-9_-]{27}$") && minted["deepLink"].Text == expectedLink)
              items.Add(Ui.Pill("Open Link in Telegram", () => {
                if (!deadline.HasValue || DateTime.UtcNow >= deadline.Value) { ClearCode(); Render(); return; }
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(expectedLink) { UseShellExecute = true }); } catch (Exception) { }
              }, true));
            items.Add(Ui.Copyable("/start " + code, 14, null, true));
            items.Add(Ui.Caption("Send this to @" + bot + ". Expires " + Wires.Date(minted["expiresAt"].Text) + "."));
            items.Add(Ui.Caption("This code is shown once. A replacement invalidates the previous code."));
          } else {
            items.Add(Ui.Copyable("link " + minted["code"].Text, 14, null, true));
            items.Add(Ui.Caption("Expires " + Wires.Date(minted["expiresAt"].Text) + ". A replacement invalidates the previous code."));
          }
          items.Add(Ui.Pill("Hide Code", () => { ClearCode(); Render(); }));
        }
        Ui.Add(page, Ui.CardBox(Telegram ? "Your Telegram chat" : "Your connection", items.ToArray()), 20);
        foreach (var link in links) {
          var l = link;
          var title = Telegram ? (l["telegramUsername"].Text.Length == 0 ? "Your chat " + l["chatId"].Text : "@" + l["telegramUsername"].Text) : Label + " · " + l["status"].Text;
          var detail = l["status"].Text == "active" ? "Linked " + Wires.Date(l["linkedAt"].Text) : "Disconnected";
          Ui.Add(page, Ui.CardBox(null, Ui.Spread(Ui.Stack(5, Ui.Headline(title), Ui.Caption(detail)),
            l["status"].Text == "active" ? Ui.Danger("Disconnect…", () => Disconnect(l, false)) : null)), 12);
        }
      }
      if (model.IsAdministrator && !config.IsNull) Ui.Add(page, new Disclosure(Telegram ? "Telegram bot administration" : "Server channel settings", Administration), 20);
      Ui.Add(page, Ui.Pill("Refresh", StartLoad), 20);
      return page;
    }
    UIElement Administration() {
      var stack = new StackPanel();
      Ui.Add(stack, Ui.Headline(config["enabled"].Flag ? Label + " is on." : Label + " is off."), 0);
      if (Telegram && config["botUsername"].Text.Length > 0) Ui.Add(stack, Ui.T("Bot: @" + config["botUsername"].Text), 6);
      Ui.Add(stack, Ui.Caption(Telegram ? "Use the bot token provided by Telegram's BotFather. The token is saved in the Vault and never displayed again."
                                        : "Credentials are saved in the Vault and never returned to this page. Enter all fields to replace the configuration."), 8);
      foreach (var f in Fields) Ui.Add(stack, F(Telegram && config["tokenSet"].Flag ? "Replacement bot token" : f[1], credentials[f[0]]), 10);
      Ui.Add(stack, Ui.Pill(Telegram ? "Save and Verify Bot" : "Save Configuration", () => {
        var body = new Dictionary<string, object>();
        foreach (var f in Fields) {
          var control = credentials[f[0]];
          var text = control is PasswordBox ? ((PasswordBox)control).Password : ((TextBox)control).Text;
          body[f[0]] = text.Trim();
          if (control is PasswordBox) ((PasswordBox)control).Clear(); else ((TextBox)control).Text = "";
        }
        if (body.Values.Any(v => ((string)v).Length == 0)) { model.Error = "Enter every field to replace the configuration."; model.Notify(); return; }
        if (Telegram) AdminChange("/token", "POST", body, "Bot verified and saved. Register delivery, then turn Telegram on.");
        else AdminChange("config", "POST", body, "Configuration saved. Verify the provider connection before enabling it.");
      }, true), 10);
      var configured = Telegram ? config["tokenSet"].Flag : config["configured"].Flag;
      if (config["probeOk"].IsBool && !config["probeOk"].Flag)
        Ui.Add(stack, Ui.T(Telegram ? "The last bot verification failed. Check the token or server connection." : "The last provider check failed. Review the credentials and server connection.", 14, null, Ui.Orange), 10);
      if (configured) {
        var toggle = Ui.Pill(config["enabled"].Flag ? "Turn " + (Telegram ? "Telegram " : "") + "Off" : "Turn " + (Telegram ? "Telegram " : "") + "On",
          () => AdminChange(Telegram ? "/enabled" : "enabled", "POST", Wires.O("enabled", !config["enabled"].Flag), Label + " availability updated."));
        toggle.IsEnabled = config["enabled"].Flag || (config["probeOk"].IsBool && config["probeOk"].Flag);
        Ui.Add(stack, Ui.Row(8, Ui.Pill(Telegram ? "Verify Bot Connection" : "Verify Provider Connection", () => AdminChange(Telegram ? "/probe" : "probe", "POST", Wires.O(), Telegram ? "Bot connection checked." : "Provider connection verified.")), toggle), 10);
      }
      if (Telegram && config["tokenSet"].Flag) {
        Ui.Add(stack, Ui.Copyable(config["webhookUrl"].Text.Length == 0 ? "Incoming delivery is not registered." : "Incoming delivery: " + config["webhookUrl"].Text, 12), 10);
        Ui.Add(stack, Ui.Caption("Register delivery after this server's public HTTPS address works. This tells Telegram where to deliver messages."), 4);
        Ui.Add(stack, Ui.Pill("Register Incoming Delivery", () => AdminChange("/webhook", "POST", Wires.O(), "Incoming delivery registered.")), 8);
        Ui.Add(stack, Ui.Divider(), 10);
        var filesParent = filesEnabled.Parent as Panel; if (filesParent != null) filesParent.Children.Remove(filesEnabled);
        Ui.Add(stack, filesEnabled, 10);
        Ui.Add(stack, F("Maximum file size in MiB (1–20)", limitMB), 10);
        Ui.Add(stack, Ui.Pill("Save File Settings", () => {
          int limit;
          if (!int.TryParse(limitMB.Text, out limit) || limit < 1 || limit > 20) { model.Error = "Enter a file size from 1 to 20 MiB."; model.Notify(); return; }
          AdminChange("/attachments", "POST", Wires.O("enabled", filesEnabled.IsChecked == true, "maxBytes", limit * 1024 * 1024), "Telegram file settings saved.");
        }), 10);
        if (!health.IsNull) {
          Ui.Add(stack, Ui.Headline("Delivery in the last seven days"), 14);
          Ui.Add(stack, Ui.T("Sent " + health["outbound"]["sent"].Integer + " · Failed " + health["outbound"]["failed"].Integer + " · Pending " + health["outbound"]["pending"].Integer), 4);
        }
        Ui.Add(stack, Ui.Caption("Administration shows link metadata only. Chat identifiers and messages are not shown here."), 10);
        foreach (var link in adminLinks) {
          var l = link;
          Ui.Add(stack, Ui.Spread(Ui.Stack(3, Ui.T(Wires.Words(l["status"].Text)), Ui.Copyable("Account " + l["owner_user_id"].Text, 12, Ui.Muted)),
            l["status"].Text == "active" ? Ui.Danger("Revoke…", () => Disconnect(l, true)) : null), 8);
        }
        Ui.Add(stack, Ui.Danger("Remove Bot…", () => {
          if (Dialogs.Confirm(owner, "Remove the bot from this server?", "This removes the stored bot token and webhook. Telegram delivery stops for this server. Conversations remain saved.", "Remove Bot"))
            AdminChange("", "DELETE", Wires.O(), "The bot was removed.");
        }), 14);
      }
      if (!Telegram) {
        Ui.Add(stack, Ui.Caption("Set the provider's incoming-message URL to this server's public HTTPS address followed by:"), 12);
        Ui.Add(stack, Ui.Copyable("/channels/" + provider + "/webhook", 12, null, true), 4);
        if (provider == "whatsapp") Ui.Add(stack, Ui.Caption("Enter the same webhook verification token in Meta."), 4);
      }
      stack.IsEnabled = !model.Busy;
      return stack;
    }
    void Mint() {
      ClearCode();
      Perform(async (api, stamp) => {
        var value = await api.Request(Telegram ? "/telegram/link-code" : "/channels/" + provider + "/link-code", "POST", Wires.O());
        if (!Current(stamp)) return;
        var pattern = Telegram ? "^[A-Za-z0-9_-]{27}$" : "^[A-Za-z0-9_-]{24}$";
        DateTimeOffset end;
        if (!Regex.IsMatch(value["code"].Text, pattern) || !DateTimeOffset.TryParse(value["expiresAt"].Text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out end)
            || end <= DateTimeOffset.UtcNow || (end - DateTimeOffset.UtcNow).TotalSeconds > 900)
          throw new JosiException("This linking code is unavailable or expired. Create a new one.");
        minted = value; deadline = end.UtcDateTime; poll.Start();
      }, false);
    }
    void Disconnect(Wire link, bool admin) {
      if (!Dialogs.Confirm(owner, "Disconnect this " + Label + " link?", "This stops future Josi delivery through the selected link. Its conversation remains saved.", "Disconnect")) return;
      Perform(async (api, stamp) => {
        var id = api.Uuid(link["id"].Text);
        var route = Telegram ? (admin ? "/admin/telegram/links/" : "/telegram/links/") + id : "/channels/links/" + id;
        await api.Request(route, "DELETE", null);
        if (Current(stamp)) { ClearCode(); note = Label + " link disconnected."; }
      });
    }
    /// Re-read the saved configuration and refuse to apply a change made against stale settings.
    void AdminChange(string path, string method, object body, string message) {
      if (!model.IsAdministrator) return;
      var expected = config;
      Perform(async (api, stamp) => {
        Wire latest;
        if (Telegram) latest = (await api.Request("/admin/telegram"))["telegram"];
        else latest = (await api.Request("/admin/channels"))["channels"].List.FirstOrDefault(c => c["provider"].Text == provider) ?? Wire.Null;
        if (!Current(stamp)) return;
        if (!latest.Same(expected)) throw new JosiException(Label + " settings changed. Refresh before applying this change.");
        await api.Request(Telegram ? "/admin/telegram" + path : "/admin/channels/" + provider + "/" + path, method, body);
        if (Current(stamp)) note = message;
      });
    }
  }
}
