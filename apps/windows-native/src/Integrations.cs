using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Administrator: this installation's own Google, Microsoft, Dropbox and Box
  /// applications, the member capability ceiling, and connection health. It
  /// never grants a capability and never shows what is inside an account.
  public sealed class ConnectorsView : SectionView {
    static readonly Dictionary<string, string> Label = new Dictionary<string, string> {
      { "google", "Google" }, { "microsoft", "Microsoft 365" }, { "dropbox", "Dropbox" }, { "box", "Box" }, { "nextcloud", "Nextcloud" } };
    static readonly Dictionary<string, string> Help = new Dictionary<string, string> {
      { "google", "Used for Google Mail, Calendar, Contacts and Drive, and for Sign in with Google." },
      { "microsoft", "Used for Outlook Mail, Calendar, Contacts and OneDrive." },
      { "dropbox", "Used for read-only access to Dropbox folders people choose." },
      { "box", "Used for read-only access to Box folders people choose." } };
    Wire view = Wire.Null; List<Wire> health = new List<Wire>();
    readonly Dictionary<string, TextBox> ids = new Dictionary<string, TextBox>(), uris = new Dictionary<string, TextBox>();
    readonly Dictionary<string, PasswordBox> secrets = new Dictionary<string, PasswordBox>();
    public ConnectorsView(AppModel model, Window owner) : base(model, owner) { }
    protected override void OnLeave() { foreach (var s in secrets.Values) s.Clear(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var v = await api.Request("/admin/connectors");
      var h = await api.Request("/admin/connectors/connections");
      if (!Current(stamp)) return;
      view = v; health = h["connections"].List;
      foreach (var client in view["clients"].List) {
        var p = client["provider"].Text;
        var suggested = view["suggestedRedirectUris"].List.FirstOrDefault(u => u["provider"].Text == p);
        if (!ids.ContainsKey(p)) ids[p] = Ui.Input("Client ID", client["clientId"].Text);
        if (!uris.ContainsKey(p)) uris[p] = Ui.Input("Redirect URL", client["redirectUri"].Text.Length > 0 ? client["redirectUri"].Text : suggested == null ? "" : suggested["uri"].Text);
        if (!secrets.ContainsKey(p)) secrets[p] = Ui.Secret("Client secret");
      }
    }
    /// Where an administrator creates the OAuth application for each provider.
    static readonly Dictionary<string, string[]> Console = new Dictionary<string, string[]> {
      { "google", new[] { "Google Cloud Console", "https://console.cloud.google.com/apis/credentials",
        "APIs & Services, Credentials, Create credentials, OAuth client ID, type Web application. Fill in the consent screen once if Google asks for it." } },
      { "microsoft", new[] { "Microsoft Entra admin center", "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
        "App registrations, New registration, platform Web. Then Certificates & secrets, New client secret." } },
      { "dropbox", new[] { "Dropbox App Console", "https://www.dropbox.com/developers/apps",
        "Create app, Scoped access, Full Dropbox or App folder. The App key is the client ID, the App secret is the client secret." } },
      { "box", new[] { "Box Developer Console", "https://app.box.com/developers/console",
        "Create Platform App, Custom App, User Authentication (OAuth 2.0)." } } };

    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Connectors", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Register this installation's own applications with Google, Microsoft, Dropbox and Box. People then connect their accounts under Connections. You configure and see health here, never what is inside anyone's account."));
      if (view.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Connector settings have not loaded."), 0); return page; }
      var registration = view["registration"];
      if (!registration["available"].Flag) {
        Ui.Add(page, Ui.CardBox("A public address is needed first", Ui.Secondary(registration["reason"].Text),
          Ui.Caption("Currently detected address: " + registration["detectedOrigin"].Text),
          Ui.Caption("Set one under Network, then come back here. Nothing else depends on it and no data is affected.")), 0);
      } else {
        var address = Ui.Copyable(registration["publicHttpsBase"].Text, 14, null, true);
        Ui.Add(page, Ui.CardBox(null, Ui.Spread(
          Ui.Stack(4, Ui.Headline("Public address"), Ui.Caption("Every provider calls Josi back on this address. It comes from the server's Network settings.")),
          Ui.Row(12, address, ModelText.Pill("Ready", true)))), 0);
        foreach (var client in view["clients"].List) Ui.Add(page, Client(client), 0);
      }
      Ui.Add(page, Ui.CardBox(null, Ui.Spread(
        Ui.Stack(4, Ui.Headline("Nextcloud"), Ui.Caption("No application to register. Each person connects Nextcloud under Connections with their server address, username and an app password.")),
        ModelText.Pill("Nothing to set up", true))), 0);

      var policy = Ui.Stack(10, Ui.Caption("This only takes choices away. \"Allowed\" does not switch anything on for anyone; it leaves the choice to each person."));
      foreach (var row in view["policy"].List) {
        var key = row["key"].Text; var allowed = row["allowed"].Flag;
        var provider = Label.ContainsKey(row["provider"].Text) ? Label[row["provider"].Text] : row["provider"].Text;
        policy.Children.Add(Ui.Spread(Ui.Stack(2, Ui.T(row["label"].Text), Ui.Caption(provider + (row["kind"].Text == "write" ? " · can change things" : " · read-only"))),
          Ui.Pill(allowed ? "Allowed" : "Switched Off", () => Perform(async (api, stamp) => await api.Request("/admin/connectors/policy/" + Uri.EscapeDataString(key), "PUT", Wires.O("allowed", !allowed))), !allowed)));
      }
      Ui.Add(page, Ui.CardBox("What members may connect", policy), 0);

      var rows = Ui.Stack(10, Ui.Caption("Whose connection it is and whether it works. Not the account address, not what is inside it."));
      if (health.Count == 0) rows.Children.Add(Ui.Secondary("Nobody has connected an account yet."));
      foreach (var row in health) {
        var id = row.Id;
        rows.Children.Add(Ui.Spread(Ui.Stack(2, Ui.T(row["username"].Text + " · " + (Label.ContainsKey(row["provider"].Text) ? Label[row["provider"].Text] : row["provider"].Text)),
            row["last_error_category"].Text.Length > 0 ? Ui.Caption(Wires.Words(row["last_error_category"].Text)) : null),
          Ui.Row(10, ModelText.Pill(Wires.Words(row["status"].Text), row["status"].Text == "active"),
            Ui.Pill("Disconnect…", () => { if (Dialogs.Confirm(owner, "Disconnect " + row["username"].Text + "'s connection?", "Their saved access is removed. They can connect again.", "Disconnect")) Perform(async (api, stamp) => await api.Request("/admin/connectors/connections/" + api.Uuid(id), "DELETE", null)); }))));
      }
      Ui.Add(page, Ui.CardBox("Connection health", rows), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }

    /// One provider: what it is for, what people will be asked to allow, and
    /// a numbered setup with the two addresses ready to copy.
    UIElement Client(Wire client) {
      var p = client["provider"].Text; var name = Label.ContainsKey(p) ? Label[p] : p;
      var configured = client["configured"].Flag;
      var suggestion = view["suggestedRedirectUris"].List.FirstOrDefault(u => u["provider"].Text == p);
      var header = Ui.Spread(Ui.Stack(4, Ui.T(name, 17, FontWeights.SemiBold), Ui.Caption(Help.ContainsKey(p) ? Help[p] : "")),
        ModelText.Pill(configured ? "Set up" : "Not set up", configured));
      var asks = view["policy"].List.Where(c => c["provider"].Text == p && c["kind"].Text == "read").ToList();
      var allow = new StackPanel();
      if (asks.Count > 0) {
        Ui.Add(allow, Ui.T("People will be asked to allow", 13.5, FontWeights.Medium), 0);
        foreach (var a in asks) Ui.Add(allow, Ui.Caption("•  " + a["label"].Text + " (read-only)"), 3);
      }
      var setup = new Disclosure(configured ? "Change the application" : "Set up the application", () => {
        var stack = new StackPanel();
        var where = Console.ContainsKey(p) ? Console[p] : null;
        Ui.Add(stack, Ui.T("1.  Create an OAuth application for this installation", 13.5, FontWeights.Medium), 0);
        if (where != null) {
          Ui.Add(stack, Ui.Caption(where[2]), 4);
          Ui.Add(stack, Ui.Link("Open " + where[0] + " ↗", () => {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(where[1]) { UseShellExecute = true }); }
            catch (Exception e) { model.Error = "The browser could not be opened: " + e.Message; model.Notify(); }
          }), 4);
        }
        Ui.Add(stack, Ui.T("2.  Add these redirect addresses, exactly as shown", 13.5, FontWeights.Medium), 14);
        if (suggestion != null) {
          Ui.Add(stack, Address("Redirect address for connections", suggestion["uri"].Text), 6);
          foreach (var extra in suggestion["additionalUris"].List) Ui.Add(stack, Address("Also, for Sign in with " + name, extra.Text), 6);
        }
        Ui.Add(stack, Ui.T("3.  Paste the application's credentials here", 13.5, FontWeights.Medium), 14);
        Ui.Add(stack, Ui.Caption("The secret is encrypted with the installation's master key and never shown again."), 4);
        Ui.Detach(ids[p]); Ui.Detach(secrets[p]); Ui.Detach(uris[p]);
        Ui.Add(stack, Ui.Field("Client ID", ids[p]), 10);
        Ui.Add(stack, Ui.Field(configured ? "Client secret (stored; enter a new one to replace it)" : "Client secret", secrets[p]), 10);
        Ui.Add(stack, new Disclosure("Advanced: the address Josi reports to " + name, () => Ui.Stack(6,
          Ui.Caption("Change this only when a proxy rewrites the path. It must match what you registered above."), uris[p])), 10);
        Ui.Add(stack, Ui.Spread(null, Ui.Pill("Save " + name + " Application", () => {
          var body = Wires.O("clientId", ids[p].Text.Trim(), "clientSecret", secrets[p].Password, "redirectUri", uris[p].Text.Trim());
          if (ids[p].Text.Trim().Length == 0 || secrets[p].Password.Length == 0 || !uris[p].Text.Trim().StartsWith("http")) { model.Error = "Enter the client ID, the client secret and a redirect address."; model.Notify(); return; }
          secrets[p].Clear();
          Perform(async (api, stamp) => { await api.Request("/admin/connectors/clients/" + p, "PUT", body); note = name + " application saved."; });
        }, true)), 14);
        return stack;
      }, !configured);
      return Ui.CardBox(null, header, allow.Children.Count > 0 ? allow : null, setup);
    }

    /// A labelled address with its own Copy button, so it goes into the
    /// provider's console exactly as Josi expects it back.
    static UIElement Address(string label, string url) {
      var copy = Ui.IconButton(Glyph.Copy, "Copy " + label.ToLowerInvariant(), null, 14);
      copy.Click += delegate {
        var done = false;
        for (var attempt = 0; attempt < 5 && !done; attempt++) {
          try { Clipboard.SetDataObject(url, true); done = true; }
          catch (System.Runtime.InteropServices.ExternalException) { System.Threading.Thread.Sleep(40); }
        }
        copy.ToolTip = done ? "Copied" : "Could not copy. Select the text and press Ctrl+C.";
      };
      var box = new Border { Background = Ui.Raised, CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 8, 8, 8),
        Child = Ui.Spread(Ui.Stack(2, Ui.Caption(label), Ui.Copyable(url, 13, null, true)), copy) };
      return box;
    }
  }

  /// Administrator: who may connect each developer service (GitHub, GitLab,
  /// Vercel, Notion…), kept separate from who actually has. No credential is
  /// ever entered here. Also Obsidian vaults from the workspace mount.
  public sealed class IntegrationsView : SectionView {
    static readonly string[][] Catalog = {
      new[] { "Code & deployment", "GitHub, GitLab, Cloudflare, Netlify, Vercel, Docker Hub, GitHub Container Registry, Railway, Render, npm" },
      new[] { "Data & monitoring", "Supabase, Neon, Sentry" }, new[] { "Knowledge", "Notion, Obsidian (workspace)" }, new[] { "Project management", "Linear, Jira" } };
    static readonly List<KeyValuePair<string, string>> Modes = Ui.Options("not_allowed", "Not allowed", "everyone", "Allowed for everyone", "specific_users", "Allowed for specific people");
    Wire view = Wire.Null;
    readonly Dictionary<string, string> mode = new Dictionary<string, string>();
    readonly Dictionary<string, HashSet<string>> selected = new Dictionary<string, HashSet<string>>();
    readonly Dictionary<string, TextBox> notes = new Dictionary<string, TextBox>();
    List<Wire> vaults; string vaultStatus = "", markdown = "";
    readonly ComboBox vaultPick = new ComboBox(); readonly TextBox notePath = Ui.Input("Notes/example.md");
    public IntegrationsView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var v = await api.Request("/admin/developer-services");
      if (!Current(stamp)) return;
      view = v;
      foreach (var row in view["services"].List) {
        var s = row["service"].Text;
        mode[s] = row["mode"].Text;
        selected[s] = new HashSet<string>(row["allowedUserIds"].List.Select(x => x.Text));
        notes[s] = Ui.Input("Ask the platform team if you need this.", row["note"].Text);
      }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Integrations", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Each person connects their own developer accounts under Connections with their own token. What you decide here is who is permitted to. You never enter or see anyone's credential."));
      var catalog = Ui.Stack(6);
      foreach (var c in Catalog) catalog.Children.Add(Ui.Stack(2, Ui.Headline(c[0]), Ui.Caption(c[1])));
      Ui.Add(page, Ui.CardBox("Available integrations", catalog, Ui.Caption("Custom REST APIs are managed under Custom APIs.")), 0);
      Ui.Add(page, Obsidian(), 0);
      if (view.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Integrations have not loaded."), 0); return page; }
      // The per-service rows live in one card with dividers, instead of a
      // loose column of chevrons.
      var services = Ui.Stack(0, Ui.Caption("Open a service to decide who may connect it and see who has."));
      foreach (var row in view["services"].List) {
        services.Children.Add(Ui.Divider());
        var service = Service(row); service.Margin = new Thickness(0, 4, 0, 4);
        services.Children.Add(service);
      }
      Ui.Add(page, Ui.CardBox("Who may connect each service", services), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    FrameworkElement Service(Wire row) {
      var s = row["service"].Text; var people = view["people"].List;
      var attention = row["connections"].List.Any(c => c["lastCheckOk"].IsBool && !c["lastCheckOk"].Flag);
      return new Disclosure(row["label"].Text + " · " + Modes.First(m => m.Key == row["mode"].Text).Value + (attention ? " · needs attention" : ""), () => {
        var stack = Ui.Stack(10, Ui.Caption(row["capability"].Text), Ui.Headline("Who may connect this"));
        stack.Children.Add(Ui.Segments(Modes, mode[s], value => { mode[s] = value; Render(); }));
        if (mode[s] == "specific_users") {
          var list = Ui.Stack(4);
          foreach (var person in people) {
            var id = person.Id;
            var box = Ui.Toggle(person["username"].Text + "  ·  " + person["email"].Text, selected[s].Contains(id));
            box.Checked += delegate { selected[s].Add(id); }; box.Unchecked += delegate { selected[s].Remove(id); };
            list.Children.Add(box);
          }
          stack.Children.Add(list);
        }
        Ui.Detach(notes[s]);
        stack.Children.Add(Ui.Field("Reason to show anyone who cannot connect it (optional)", notes[s]));
        stack.Children.Add(Ui.Caption(row["summary"].Text));
        stack.Children.Add(Ui.Pill("Save Who May Connect", () => {
          var body = Wires.O("mode", mode[s], "note", notes[s].Text, "userIds", mode[s] == "specific_users" ? selected[s].Cast<object>().ToList() : new List<object>());
          Perform(async (api, stamp) => { await api.Request("/admin/developer-services/" + Uri.EscapeDataString(s), "PUT", body); note = row["label"].Text + " permissions saved."; });
        }, true));
        stack.Children.Add(Ui.Headline("Who has actually connected"));
        if (row["connections"].List.Count == 0)
          stack.Children.Add(Ui.Caption(row["mode"].Text == "not_allowed" ? "Nobody is permitted to, so this is not a sign of whether anyone wants it." : "They are permitted to; none of them has yet."));
        foreach (var c in row["connections"].List) {
          var bad = c["lastCheckOk"].IsBool && !c["lastCheckOk"].Flag;
          stack.Children.Add(Ui.Spread(Ui.Stack(2, Ui.T(c["username"].Text), Ui.Caption((c["accountLabel"].Text.Length > 0 ? c["accountLabel"].Text : "account not named") +
              (c["lastCheckAt"].Text.Length > 0 ? " · checked " + Wires.Date(c["lastCheckAt"].Text) : "")), bad ? Ui.T(c["lastError"].Text, 12, null, Ui.Orange) : null),
            ModelText.Pill(bad ? "Needs attention" : Wires.Words(c["status"].Text), !bad)));
        }
        return stack;
      }, attention);
    }
    UIElement Obsidian() {
      var items = new List<UIElement> { Ui.Caption("Read-only Markdown access through the installation's workspace mount. Attachments and .obsidian settings stay untouched."),
        Ui.Pill("Discover Vaults", () => Perform(async (api, stamp) => {
          var r = await api.Request("/connections/developer/obsidian-vaults");
          vaults = r["vaults"].List;
          vaultStatus = r["available"].Flag ? vaults.Count + " workspace vault(s) found." : "Configure the Local Workspace mount under Network and address first.";
          vaultPick.ItemsSource = vaults.Select(x => x["name"].Text + "  (" + x["path"].Text + ")").ToList();
        }, false)) };
      if (vaultStatus.Length > 0) items.Add(Ui.Caption(vaultStatus));
      if (vaults != null && vaults.Count > 0) {
        Ui.Detach(vaultPick); Ui.Detach(notePath);
        items.Add(Ui.Field("Vault", vaultPick)); items.Add(Ui.Field("Markdown note path", notePath));
        items.Add(Ui.Pill("Read Note", () => {
          if (vaultPick.SelectedIndex < 0 || !notePath.Text.EndsWith(".md")) { model.Error = "Choose a vault and a Markdown (.md) note."; model.Notify(); return; }
          var vault = vaults[vaultPick.SelectedIndex]["path"].Text; var path = notePath.Text;
          Perform(async (api, stamp) => {
            var r = await api.Request("/connections/developer/obsidian-note?vault=" + Uri.EscapeDataString(vault) + "&note=" + Uri.EscapeDataString(path));
            markdown = r["markdown"].Text;
          }, false);
        }));
      }
      if (markdown.Length > 0) items.Add(Ui.Copyable(markdown, 13, null, true));
      return Ui.CardBox("Obsidian workspace vaults", items.ToArray());
    }
  }
}
