using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Your own connected accounts: Google, Microsoft 365, Dropbox, Box and
  /// Nextcloud with per-capability switches and read-only cloud folders, plus
  /// developer services connected with a token. Counterpart of the web app's
  /// Connections page. Nothing is pressable unless it works: a provider the
  /// administrator has not registered says so instead of offering Connect.
  public sealed class ConnectionsView : SectionView {
    static readonly string[] OAuth = { "google", "microsoft", "dropbox", "box" };
    static readonly Dictionary<string, string> Label = new Dictionary<string, string> {
      { "google", "Google" }, { "microsoft", "Microsoft 365" }, { "dropbox", "Dropbox" }, { "box", "Box" }, { "nextcloud", "Nextcloud" } };
    static readonly Dictionary<string, string> StorageCapability = new Dictionary<string, string> {
      { "google", "google.drive.read" }, { "microsoft", "microsoft.files.read" }, { "dropbox", "dropbox.files.read" }, { "box", "box.files.read" }, { "nextcloud", "nextcloud.files.read" } };
    static readonly Dictionary<string, string> MappingProvider = new Dictionary<string, string> {
      { "google", "google_drive" }, { "microsoft", "onedrive" }, { "dropbox", "dropbox" }, { "box", "box" }, { "nextcloud", "nextcloud" } };
    static readonly Dictionary<string, string> ErrorText = new Dictionary<string, string> {
      { "revoked", "Access was withdrawn at the provider. Reconnect to restore it." },
      { "expired", "The stored access expired and could not be renewed. Reconnect." },
      { "insufficient_scope", "A permission Josi needs was not granted. Reconnect and approve it." },
      { "rate_limited", "The provider is rate limiting Josi. This usually clears on its own." },
      { "provider_error", "The provider returned an error. If it persists, reconnect." },
      { "network", "Josi could not reach the provider." } };

    List<Wire> providers, developer, mappings, documents;
    readonly Dictionary<string, Wire> mappingStatus = new Dictionary<string, Wire>();
    readonly Dictionary<string, PasswordBox> tokens = new Dictionary<string, PasswordBox>();
    readonly Dictionary<string, TextBox> details = new Dictionary<string, TextBox>();
    readonly TextBox nextcloudServer = Ui.Input("cloud.example.com"), nextcloudUser = Ui.Input("Username");
    readonly PasswordBox nextcloudPassword = Ui.Secret("App password");

    public ConnectionsView(AppModel model, Window owner) : base(model, owner) {
      model.ConnectionFinished += OnFinished;
      Unloaded += delegate { model.ConnectionFinished -= OnFinished; };
    }
    void OnFinished() { if (IsLoaded) StartLoad(); }
    protected override void OnLeave() { foreach (var box in tokens.Values) box.Clear(); nextcloudPassword.Clear(); }

    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var list = await api.Request("/connections");
      if (!Current(stamp)) return;
      providers = list["providers"].List;
      try { var d = await api.Request("/connections/developer"); if (Current(stamp)) developer = d["services"].List; }
      catch (JosiException) { if (Current(stamp)) developer = new List<Wire>(); }
      try { var m = await api.Request("/storage/mappings"); if (Current(stamp)) mappings = m["mappings"].List; }
      catch (JosiException) { if (Current(stamp)) mappings = new List<Wire>(); }
      foreach (var mapping in mappings ?? new List<Wire>()) {
        try { var s = await api.Request("/storage/mappings/" + api.Uuid(mapping.Id) + "/status"); if (Current(stamp)) mappingStatus[mapping.Id] = s; }
        catch (JosiException) { }
      }
      try { var docs = await api.Request("/storage/documents?limit=100"); if (Current(stamp)) documents = docs["documents"].List; }
      catch (JosiException) { if (Current(stamp)) documents = new List<Wire>(); }
    }

    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Connections", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Your own accounts, connected by you. An administrator can see whether a connection is working and can disconnect it, but cannot read what is inside it."));
      if (providers == null) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Connections have not loaded."), 0); return page; }
      foreach (var view in providers) {
        var accounts = view["connections"].List.Where(c => !c.IsNull).ToList();
        if (accounts.Count == 0 && !view["connection"].IsNull) accounts.Add(view["connection"]);
        if (accounts.Count == 0) Ui.Add(page, ProviderCard(view, Wire.Null), 0);
        else foreach (var connection in accounts) Ui.Add(page, ProviderCard(view, connection), 0);
      }
      if (developer != null && developer.Count > 0) {
        Ui.Add(page, Ui.Stack(6, Ui.Title2("Developer services"), Ui.Secondary("Your own accounts, connected with a token you create. Nobody else here can see the token, and disconnecting removes it.")), 30);
        foreach (var row in developer) Ui.Add(page, DeveloperCard(row), 0);
      }
      if (documents != null && documents.Count > 0) {
        var list = Ui.Stack(8);
        foreach (var d in documents)
          list.Children.Add(Ui.Spread(Ui.Stack(2, Ui.T(d["filename"].Text, 14, FontWeights.Medium), Ui.Caption(d["folder"].Text),
              d["skipReason"].Text.Length > 0 ? Ui.T("Skipped: " + Wires.Words(d["skipReason"].Text), 12, null, Ui.Orange) : null),
            ModelText.Pill(Wires.Words(d["state"].Text), d["state"].Text == "indexed")));
        Ui.Add(page, Ui.CardBox("Files Josi can see", list), 12);
      }
      Ui.Add(page, Note(), 0);
      return page;
    }

    UIElement ProviderCard(Wire view, Wire connection) {
      var provider = view["provider"].Text;
      var name = Label.ContainsKey(provider) ? Label[provider] : Wires.Capitalize(provider);
      var items = new List<UIElement>();
      if (!connection.IsNull) {
        var active = connection["status"].Text == "active";
        items.Add(Ui.Row(10, ModelText.Pill(active ? "Connected" : "Needs reconnecting", active),
          Ui.Caption(connection["account"].Text.Length > 0 ? connection["account"].Text : connection["serverUrl"].Text)));
        if (connection["errorCategory"].Text.Length > 0) {
          string text; ErrorText.TryGetValue(connection["errorCategory"].Text, out text);
          items.Add(Ui.T(text ?? "Something went wrong with this connection.", 13.5, null, Ui.Orange));
        }
        if (connection["needsPermissionUpgrade"].Flag) {
          items.Add(Ui.Caption("This account was connected before Josi requested its current permission bundle. Upgrade once; afterwards every capability is controlled here."));
          items.Add(Ui.Pill("Upgrade Permissions / Reconnect " + name, () => StartOAuth(provider, connection.Id)));
        }
        var capabilities = connection["capabilities"].IsNull ? view["capabilities"].List : connection["capabilities"].List;
        foreach (var capability in capabilities) items.Add(Capability(connection, capability));
        var storageOn = capabilities.Any(c => c["key"].Text == StorageCapability[provider] && c["state"].Text == "on");
        items.Add(Folders(provider, connection, storageOn));
        var actions = Ui.Wrap(Ui.Pill("Disconnect…", () => Disconnect(name, connection.Id)));
        if (OAuth.Contains(provider)) actions.Children.Add(Ui.Pill("Add Another " + name + " Account", () => StartOAuth(provider, null)));
        items.Add(actions);
      } else if (!view["available"].Flag && provider != "nextcloud") {
        items.Add(model.IsAdministrator
          ? Ui.Caption("Not set up yet. Register " + name + "'s application credentials under Connectors (in Administration), then anyone here can connect their account.")
          : Ui.Caption("Not set up on this installation. An administrator has to register " + name + " application credentials under Connectors before anyone can connect an account."));
      } else if (provider == "nextcloud") {
        items.Add(Ui.Caption("Connecting starts read-only. In your Nextcloud account, go to Settings → Security → Devices & sessions and create an app password for Josi. Do not use your regular Nextcloud password."));
        items.Add(F("Server address", nextcloudServer)); items.Add(F("Username", nextcloudUser)); items.Add(F("App password", nextcloudPassword));
        items.Add(Ui.Pill("Connect Nextcloud", ConnectNextcloud, true));
      } else {
        items.Add(Ui.Caption(name + " asks once for Josi's supported permission bundle in your browser. Every capability stays off in Josi until you turn it on here."));
        items.Add(Ui.Pill("Connect " + name, () => StartOAuth(provider, null), true));
      }
      return Ui.CardBox(name, items.ToArray());
    }

    UIElement Capability(Wire connection, Wire capability) {
      var state = capability["state"].Text;
      UIElement control;
      if (state == "blocked_by_admin") control = Ui.Caption("Switched off by an administrator");
      else if (capability["needsConsent"].Flag) control = Ui.Caption("Available after the permission upgrade");
      else {
        var on = state == "on";
        control = Ui.Pill(on ? "On" : "Off", () => {
          var key = capability["key"].Text;
          if (!on && capability["kind"].Text == "write" && !Dialogs.Confirm(owner, "Turn on " + capability["label"].Text + "?",
              capability["consequence"].Text.Length > 0 ? capability["consequence"].Text : "This lets Josi make changes in your account.", "Turn On")) return;
          Perform(async (api, stamp) => {
            await api.Request("/connections/" + api.Uuid(connection.Id) + "/capabilities/" + Uri.EscapeDataString(key), "PUT", Wires.O("enabled", !on));
          });
        }, on);
      }
      var stack = Ui.Stack(3, Ui.Spread(Ui.T(capability["label"].Text, 14, FontWeights.Medium), control));
      if (capability["kind"].Text == "write" && capability["consequence"].Text.Length > 0) stack.Children.Add(Ui.Caption(capability["consequence"].Text));
      if (capability["adminNote"].Text.Length > 0) stack.Children.Add(Ui.Caption(capability["adminNote"].Text));
      return stack;
    }

    UIElement Folders(string provider, Wire connection, bool storageOn) {
      var label = provider == "google" ? "Google Drive" : provider == "microsoft" ? "OneDrive" : Label[provider];
      if (!storageOn) return Ui.Caption("To let Josi read folders from " + label + ", switch on reading files above. It is read-only: Josi cannot change or delete anything in your account.");
      var stack = Ui.Stack(8, Ui.Headline(label + " folders"));
      var mine = (mappings ?? new List<Wire>()).Where(m => m["provider"].Text == MappingProvider[provider]).ToList();
      if (mine.Count == 0) stack.Children.Add(Ui.Caption("No folders yet. Choose one and Josi will read it, index the text it can read, and make it searchable, for you only."));
      foreach (var mapping in mine) {
        var id = mapping.Id;
        var row = Ui.Stack(3, Ui.Spread(Ui.T(mapping["display_path"].Text, 14, FontWeights.Medium), ModelText.Pill(Wires.Words(mapping["status"].Text), mapping["status"].Text == "active")));
        if (mapping["paused_reason"].Text.Length > 0) row.Children.Add(Ui.T("Paused: " + Wires.Words(mapping["paused_reason"].Text), 13, null, Ui.Orange));
        Wire status;
        if (mappingStatus.TryGetValue(id, out status) && status["total"].Integer > 0) {
          row.Children.Add(Ui.Caption(status["byState"]["indexed"].Integer + " of " + status["total"].Integer + " file(s) indexed and searchable."));
          foreach (var skipped in status["skipped"].List) {
            var why = status["explanations"][skipped["reason"].Text].Text;
            row.Children.Add(Ui.Caption(skipped["count"].Integer + " skipped: " + (why.Length > 0 ? why : skipped["reason"].Text)));
          }
        }
        row.Children.Add(Ui.Wrap(
          Ui.Pill("Sync Now", () => Perform(async (api, stamp) => { await api.Request("/storage/mappings/" + api.Uuid(id) + "/sync", "POST", Wires.O()); note = "Sync queued. New and changed files appear as the worker gets to them."; })),
          Ui.Pill("Remove…", () => { if (Dialogs.Confirm(owner, "Stop reading this folder?", mapping["display_path"].Text, "Remove")) Perform(async (api, stamp) => await api.Request("/storage/mappings/" + api.Uuid(id), "DELETE", null)); })));
        stack.Children.Add(new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(12), Child = row });
      }
      stack.Children.Add(Ui.Pill("Add a Folder…", () => {
        var receipt = FolderPicker.Show(owner, model, label, MappingProvider[provider], connection.Id);
        if (receipt != null) { note = receipt; StartLoad(); }
      }));
      return stack;
    }

    UIElement DeveloperCard(Wire row) {
      var service = row["service"].Text;
      var connection = row["connection"];
      var items = new List<UIElement> { Ui.Caption(row["capability"].Text) };
      if (!connection.IsNull) {
        var ok = connection["lastCheckOk"].IsBool ? connection["lastCheckOk"].Flag : true;
        var line = "Connected as " + (connection["accountLabel"].Text.Length > 0 ? connection["accountLabel"].Text : "your account");
        if (connection["lastCheckAt"].Text.Length > 0) line += " · checked " + Wires.Date(connection["lastCheckAt"].Text);
        if (connection["lastUsedAt"].Text.Length > 0) line += " · last used " + Wires.Date(connection["lastUsedAt"].Text);
        items.Add(Ui.Row(10, ModelText.Pill(ok ? "Connected" : "Needs attention", ok), Ui.Caption(line)));
        if (!ok && connection["lastError"].Text.Length > 0) items.Add(Ui.T(connection["lastError"].Text, 13.5, null, Ui.Orange));
        items.Add(Ui.Wrap(
          Ui.Pill("Check It Still Works", () => Perform(async (api, stamp) => await api.Request("/connections/developer/" + Uri.EscapeDataString(service) + "/check", "POST", Wires.O()))),
          Ui.Pill("Disconnect…", () => { if (Dialogs.Confirm(owner, "Disconnect " + row["label"].Text + "?", "The saved token is removed.", "Disconnect")) Perform(async (api, stamp) => await api.Request("/connections/developer/" + Uri.EscapeDataString(service), "DELETE", null)); })));
      } else if (!row["allowed"].Flag) {
        items.Add(Ui.Caption(model.IsAdministrator
          ? "Switched off for members. Turn it on under Integrations (in Administration) → Who may connect each service." + (row["note"].Text.Length > 0 ? " " + row["note"].Text : "")
          : "An administrator has not made this available. " + (row["note"].Text.Length > 0 ? row["note"].Text : "Ask your administrator if you need it.")));
      } else {
        if (row["usernameLabel"].Text.Length > 0) items.Add(F(row["usernameLabel"].Text, Detail(service, "username")));
        if (row["emailLabel"].Text.Length > 0) items.Add(F(row["emailLabel"].Text, Detail(service, "email")));
        if (row["baseUrlLabel"].Text.Length > 0) items.Add(F(row["baseUrlLabel"].Text, Detail(service, "baseUrl")));
        PasswordBox token;
        if (!tokens.TryGetValue(service, out token)) tokens[service] = token = Ui.Secret(row["tokenLabel"].Text);
        items.Add(F(row["tokenLabel"].Text, token));
        Uri help;
        var open = Uri.TryCreate(row["tokenUrl"].Text, UriKind.Absolute, out help) && help.Scheme == "https"
          ? Ui.Link("Open " + row["label"].Text, () => ModelText.Open(help)) : null;
        items.Add(Ui.Row(10, Ui.Caption(row["tokenHelp"].Text), open));
        items.Add(Ui.Pill("Connect", () => {
          var body = Wires.O("token", token.Password);
          foreach (var field in new[] { "username", "email", "baseUrl" }) {
            TextBox box; if (details.TryGetValue(service + "/" + field, out box) && box.Text.Trim().Length > 0) body[field] = box.Text.Trim();
          }
          if (token.Password.Trim().Length == 0) { model.Error = "Enter the token first."; model.Notify(); return; }
          token.Clear();
          Perform(async (api, stamp) => { await api.Request("/connections/developer/" + Uri.EscapeDataString(service), "PUT", body); note = row["label"].Text + " connection saved."; });
        }, true));
        items.Add(Ui.Caption("Josi checks the token with " + row["label"].Text + " before saving it, so a token that does not work is never stored."));
      }
      return Ui.CardBox(row["label"].Text, items.ToArray());
    }
    TextBox Detail(string service, string field) {
      TextBox box;
      if (!details.TryGetValue(service + "/" + field, out box)) details[service + "/" + field] = box = Ui.Input(field == "baseUrl" ? "https://your-site.atlassian.net" : "");
      return box;
    }
    static FrameworkElement F(string label, Control control) { Ui.Detach(control); return Ui.Field(label, control); }

    void StartOAuth(string provider, string connectionId) {
      Perform(async (api, stamp) => await model.StartConnection(provider, connectionId), false);
    }
    void ConnectNextcloud() {
      var body = Wires.O("serverUrl", nextcloudServer.Text.Trim(), "username", nextcloudUser.Text.Trim(), "appPassword", nextcloudPassword.Password);
      if (nextcloudServer.Text.Trim().Length == 0 || nextcloudUser.Text.Trim().Length == 0 || nextcloudPassword.Password.Length == 0) {
        model.Error = "Enter the server address, username and app password."; model.Notify(); return;
      }
      nextcloudPassword.Clear();
      Perform(async (api, stamp) => { await api.Request("/connections/nextcloud/connect", "POST", body); note = "Nextcloud connected."; });
    }
    void Disconnect(string name, string id) {
      if (!Dialogs.Confirm(owner, "Disconnect " + name + "?", "Josi stops using this account and removes its saved access. Mapped folders from it stop syncing.", "Disconnect")) return;
      Perform(async (api, stamp) => {
        var result = await api.Request("/connections/" + api.Uuid(id), "DELETE", null);
        if (result["note"].Text.Length > 0) note = result["note"].Text;
      });
    }
  }

  /// Browse a connected cloud account and map one folder: picking it maps the
  /// folder, turns indexing on and queues the first sync, and shows the
  /// server's consent sentence as the receipt.
  static class FolderPicker {
    public static string Show(Window owner, AppModel model, string label, string mappingProvider, string connectionId) {
      var sheet = new Dialogs.Sheet(owner, "Choose a folder", 560);
      var path = new List<Wire>();
      string receipt = null;
      var recursive = Ui.Toggle("Include subfolders, including ones added later", true);
      var host = new ContentControl { Focusable = false };
      Action<string> browse = null;
      Action<List<Wire>, string> render = null;
      render = (folders, error) => {
        var stack = Ui.Stack(10, Ui.Title2("Choose a folder"),
          Ui.Caption(path.Count == 0 ? "The top of your " + label + ". Pick a folder: Josi maps one folder at a time, never the whole drive." : label + "/" + string.Join("/", path.Select(p => p["name"].Text))));
        if (error != null) stack.Children.Add(Ui.T(error, 13.5, null, Ui.Orange));
        if (folders == null) stack.Children.Add(Ui.Caption("Loading…"));
        else if (folders.Count == 0) stack.Children.Add(Ui.Caption("No folders inside this one."));
        else foreach (var folder in folders) {
          var f = folder;
          stack.Children.Add(Ui.Link("📁  " + f["name"].Text, () => { path.Add(f); browse(f.Id); }));
        }
        Ui.Detach(recursive); stack.Children.Add(recursive);
        stack.Children.Add(Ui.Caption("Josi reads it, indexes the text it can read, and starts syncing the moment you use it."));
        var buttons = Ui.Wrap();
        if (path.Count > 0) {
          var current = path[path.Count - 1];
          buttons.Children.Add(Ui.Pill("Use “" + current["name"].Text + "”", async () => {
            sheet.Locked = true;
            try {
              var created = await model.Api.Request("/storage/mappings", "POST", Wires.O("provider", mappingProvider, "connectionId", connectionId,
                "remoteFolderId", current.Id, "displayPath", label + "/" + string.Join("/", path.Select(p => p["name"].Text)), "recursive", recursive.IsChecked == true));
              var id = model.Api.Uuid(created["mapping"].Id);
              try {
                await model.Api.Request("/storage/mappings/" + id + "/indexing", "PUT", Wires.O("enabled", true));
                await model.Api.Request("/storage/mappings/" + id + "/sync", "POST", Wires.O());
                receipt = created["consent"].Text.Length > 0 ? created["consent"].Text : "Syncing started.";
              } catch (JosiException e) { receipt = "The folder was mapped, but syncing did not start: " + e.Message + " Use Sync Now."; }
              sheet.Locked = false; sheet.Close();
            } catch (JosiException e) {
              sheet.Locked = false;
              // "An administrator has not enabled folder mapping for you" read
              // as a dead end to the administrator himself; name the switch.
              var why = e.Message.IndexOf("administrator has not enabled", StringComparison.OrdinalIgnoreCase) >= 0 && model.IsAdministrator
                ? e.Message + " Switch it on under People (in Administration) → your account → Folder access: \"Map cloud folders\" and \"Index and search connected files\", then Save Folder Access."
                : e.Message;
              render(folders, why);
            }
          }, true));
          buttons.Children.Add(Ui.Pill("Up One Level", () => { path.RemoveAt(path.Count - 1); browse(path.Count == 0 ? null : path[path.Count - 1].Id); }));
        }
        buttons.Children.Add(Ui.Pill("Cancel", sheet.Close));
        stack.Children.Add(buttons);
        host.Content = stack;
      };
      browse = async parent => {
        render(null, null);
        try {
          var result = await model.Api.Request("/connections/" + model.Api.Uuid(connectionId) + "/storage/folders" + (parent == null ? "" : "?parent=" + Uri.EscapeDataString(parent)));
          render(result["folders"].List, null);
        } catch (JosiException e) { render(new List<Wire>(), e.Message); }
      };
      sheet.Body(host);
      sheet.Loaded += delegate { browse(null); };
      sheet.ShowDialog();
      return receipt;
    }
  }
}
