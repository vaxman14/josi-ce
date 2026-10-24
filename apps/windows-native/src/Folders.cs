using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// One way to add a folder, wherever it lives: on this PC (the administrator
  /// picks it in the Windows folder dialog; members pick from the folders the
  /// administrator added) or in a connected cloud account. The sheet switches
  /// on what the folder needs — the person's own folder rights when they are
  /// the administrator, and the account's "read files" capability — instead of
  /// sending them off to find the switch.
  public static class FolderSheet {
    internal static readonly Dictionary<string, string> CloudLabel = new Dictionary<string, string> {
      { "google", "Google Drive" }, { "microsoft", "OneDrive" }, { "dropbox", "Dropbox" }, { "box", "Box" }, { "nextcloud", "Nextcloud" } };
    internal static readonly Dictionary<string, string> CloudCapability = new Dictionary<string, string> {
      { "google", "google.drive.read" }, { "microsoft", "microsoft.files.read" }, { "dropbox", "dropbox.files.read" }, { "box", "box.files.read" }, { "nextcloud", "nextcloud.files.read" } };
    internal static readonly Dictionary<string, string> CloudMapping = new Dictionary<string, string> {
      { "google", "google_drive" }, { "microsoft", "onedrive" }, { "dropbox", "dropbox" }, { "box", "box" }, { "nextcloud", "nextcloud" } };

    internal static string ProviderName(string mappingProvider) {
      foreach (var pair in CloudMapping) if (pair.Value == mappingProvider) return CloudLabel[pair.Key];
      return mappingProvider == "local" ? "This PC" : Wires.Words(mappingProvider);
    }

    /// Opens the sheet. `provider` and `connectionId` jump straight to that
    /// cloud account's folders. Returns a receipt sentence once a folder was
    /// added, or null when nothing changed.
    public static string Show(Window owner, AppModel model, string provider = null, string connectionId = null) {
      var sheet = new Dialogs.Sheet(owner, "Add a folder", 600);
      var host = new ContentControl { Focusable = false };
      var api = model.Api;
      string receipt = null;
      Wire available = Wire.Null;
      var providers = new List<Wire>();

      // One error line, shared by every page, so a failed request is shown on
      // the page it came from with everything the person typed still there.
      var error = Ui.T("", 13.5, null, Ui.Orange); error.Visibility = Visibility.Collapsed;
      Action<string> fail = text => { error.Text = text ?? ""; error.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible; };
      Func<UIElement> slot = () => { Ui.Detach(error); return error; };
      Action<UIElement, string> show = (content, problem) => { fail(problem); host.Content = content; };
      Action<Func<Task>> run = null;
      Action<string> sources = null;

      // The folder rights live on the person's account. The administrator is
      // the one who grants them, so for the administrator the sheet grants them
      // on the spot; anyone else is told exactly who to ask.
      Func<string, bool, Task<string>> ensureRights = async (kind, index) => {
        var fresh = await api.Request("/storage/available");
        available = fresh;
        var cap = fresh["capability"];
        var missing = (kind == "local" ? !cap["may_map_local"].Flag : !cap["may_map_cloud"].Flag) || (index && !cap["may_index"].Flag);
        if (!missing) return null;
        if (!model.IsAdministrator)
          throw new JosiException("Your administrator has not switched folder access on for you yet. Ask them to open People (in Administration), choose your name, and turn on Folder access.");
        object maxBytes = null, maxFiles = null; long bytes;
        if (long.TryParse(cap["max_bytes"].Text, NumberStyles.None, CultureInfo.InvariantCulture, out bytes)) maxBytes = bytes;
        if (cap["max_files"].IsNumber) maxFiles = cap["max_files"].Integer;
        await api.Request("/storage/admin/capabilities/" + api.Uuid(model.User["id"].Text), "PUT",
          Wires.O("mayMapLocal", true, "mayMapCloud", true, "mayIndex", true, "maxBytes", maxBytes, "maxFiles", maxFiles));
        return "Folder access was switched on for your account (you are the administrator).";
      };

      // Map a folder and start reading it. One place, so a PC folder and a cloud
      // folder end up in the same state: mapped, indexed when asked, syncing.
      Func<Dictionary<string, object>, bool, string, Task> finish = async (body, index, granted) => {
        var created = await api.Request("/storage/mappings", "POST", body);
        var id = api.Uuid(created["mapping"].Id);
        var sentence = created["consent"].Text.Length > 0 ? created["consent"].Text : "The folder was added.";
        if (index) {
          try {
            await api.Request("/storage/mappings/" + id + "/indexing", "PUT", Wires.O("enabled", true));
            await api.Request("/storage/mappings/" + id + "/sync", "POST", Wires.O());
            sentence += " Josi is reading it now; files appear as the worker gets to them.";
          } catch (JosiException e) { sentence += " The folder was added, but reading did not start: " + e.Message + " Use Sync Now."; }
        }
        receipt = (granted == null ? "" : granted + " ") + sentence;
      };

      // --- A folder on this PC -------------------------------------------
      Action<string, Wire> confirmPc = (path, root) => {
        var where = path ?? root["label"].Text;
        var label = Ui.Input("A name people will recognise", path == null ? root["label"].Text : System.IO.Path.GetFileName(path.TrimEnd('\\', '/')));
        var subfolders = Ui.Toggle("Include subfolders, including ones added later", true);
        var index = Ui.Toggle("Let Josi read and search the files inside", true);
        var add = Ui.Pill("Add This Folder", () => run(async () => {
          var granted = await ensureRights("local", index.IsChecked == true);
          var rootId = root.IsNull ? "" : root.Id;
          if (path != null) {
            var registered = await api.Request("/storage/roots", "POST", Wires.O("path", path, "label", label.Text.Trim()));
            rootId = registered["root"].Id;
          }
          await finish(Wires.O("provider", "local", "rootId", rootId, "relativePath", "", "recursive", subfolders.IsChecked == true), index.IsChecked == true, granted);
        }), true);
        show(Ui.Stack(12, Ui.Title2("A folder on this PC"), Ui.Copyable(where, 14), slot(),
          path == null ? null : Ui.Field("Shown as", label), subfolders, index,
          Ui.Caption("Josi only reads. It never changes, moves or deletes anything in this folder, and you can remove it from Josi at any time under Files."),
          Ui.Wrap(add, Ui.Pill("Back", () => sources(null)), Ui.Pill("Cancel", sheet.Close))), null);
      };
      Action pickPc = () => {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "Choose a folder for Josi to read", Multiselect = false };
        if (dialog.ShowDialog(sheet) != true) return;
        confirmPc(dialog.FolderName, Wire.Null);
      };
      Action pcList = () => {
        var roots = available["roots"].List;
        var stack = Ui.Stack(10, Ui.Title2("Folders on the server PC"), slot());
        if (roots.Count == 0) stack.Children.Add(Ui.Caption("Your administrator has not added any folders on the server PC yet."));
        else {
          stack.Children.Add(Ui.Caption("Pick one of the folders your administrator made available."));
          foreach (var root in roots) { var r = root; stack.Children.Add(Ui.Link("📁  " + r["label"].Text, () => confirmPc(null, r))); }
        }
        stack.Children.Add(Ui.Wrap(Ui.Pill("Back", () => sources(null)), Ui.Pill("Cancel", sheet.Close)));
        show(stack, null);
      };

      // --- A folder in a cloud account -------------------------------------
      Action<string, string, string> cloud = (kind, connection, capabilityNote) => {
        var label = CloudLabel.ContainsKey(kind) ? CloudLabel[kind] : Wires.Capitalize(kind);
        var mappingProvider = CloudMapping.ContainsKey(kind) ? CloudMapping[kind] : kind;
        var path = new List<Wire>();
        var recursive = Ui.Toggle("Include subfolders, including ones added later", true);
        var index = Ui.Toggle("Let Josi read and search the files inside", true);
        Action<string> browse = null;
        Action<List<Wire>, string> render = null;
        render = (folders, problem) => {
          var stack = Ui.Stack(10, Ui.Title2(label),
            Ui.Caption(path.Count == 0 ? "The top of your " + label + ". Open a folder, then use it. Josi maps one folder at a time, never the whole drive."
              : label + "/" + string.Join("/", path.Select(p => p["name"].Text))));
          if (capabilityNote != null) stack.Children.Add(Ui.Caption(capabilityNote));
          stack.Children.Add(slot());
          if (folders == null) stack.Children.Add(Ui.Caption("Loading…"));
          else if (folders.Count == 0) stack.Children.Add(Ui.Caption("No folders inside this one."));
          else foreach (var folder in folders) { var f = folder; stack.Children.Add(Ui.Link("📁  " + f["name"].Text, () => { path.Add(f); browse(f.Id); })); }
          Ui.Detach(recursive); Ui.Detach(index);
          stack.Children.Add(recursive); stack.Children.Add(index);
          stack.Children.Add(Ui.Caption("Josi only reads. It cannot change or delete anything in your account, and you can remove the folder from Josi at any time under Files."));
          var buttons = Ui.Wrap();
          if (path.Count > 0) {
            var current = path[path.Count - 1];
            buttons.Children.Add(Ui.Pill("Use “" + current["name"].Text + "”", () => run(async () => {
              var granted = await ensureRights("cloud", index.IsChecked == true);
              await finish(Wires.O("provider", mappingProvider, "connectionId", connection, "remoteFolderId", current.Id,
                "displayPath", label + "/" + string.Join("/", path.Select(p => p["name"].Text)), "recursive", recursive.IsChecked == true), index.IsChecked == true, granted);
            }), true));
            buttons.Children.Add(Ui.Pill("Up One Level", () => { path.RemoveAt(path.Count - 1); browse(path.Count == 0 ? null : path[path.Count - 1].Id); }));
          }
          if (provider == null) buttons.Children.Add(Ui.Pill("Back", () => sources(null)));
          buttons.Children.Add(Ui.Pill("Cancel", sheet.Close));
          stack.Children.Add(buttons);
          show(stack, problem);
        };
        browse = async parent => {
          render(null, null);
          try {
            var result = await api.Request("/connections/" + api.Uuid(connection) + "/storage/folders" + (parent == null ? "" : "?parent=" + Uri.EscapeDataString(parent)));
            render(result["folders"].List, null);
          } catch (JosiException e) { render(new List<Wire>(), e.Message); }
        };
        browse(null);
      };
      // Reading files from the account is a capability the person switches on.
      // Adding a folder is that decision, so the sheet makes the switch and
      // says so, rather than refusing until they find it under Connections.
      Action<string, Wire> openCloud = (kind, connection) => run(async () => {
        var key = CloudCapability.ContainsKey(kind) ? CloudCapability[kind] : "";
        string note = null;
        var capability = connection["capabilities"].List.FirstOrDefault(c => c["key"].Text == key);
        if (capability != null && capability["state"].Text != "on") {
          if (capability["state"].Text == "blocked_by_admin") throw new JosiException("An administrator switched off reading files from " + CloudLabel[kind] + " for everyone here.");
          if (capability["needsConsent"].Flag) throw new JosiException("This account needs its permissions upgraded first. Open Connections and use Upgrade Permissions / Reconnect.");
          await api.Request("/connections/" + api.Uuid(connection.Id) + "/capabilities/" + Uri.EscapeDataString(key), "PUT", Wires.O("enabled", true));
          note = "Reading files from " + CloudLabel[kind] + " is now switched on for this account. It is read-only.";
        }
        cloud(kind, connection.Id, note);
      });

      // --- Where is the folder? ----------------------------------------------
      sources = problem => {
        var stack = Ui.Stack(12, Ui.Title2("Where is the folder?"),
          Ui.Caption("Josi reads only the folders you add here, and only for you. Nothing else on the PC or in your accounts is touched."), slot());
        var options = Ui.Stack(8);
        var pc = available["pcFolders"].Flag;
        var roots = available["roots"].List;
        if (pc && model.IsAdministrator && api.IsLocal) options.Children.Add(Choice("💻", "A folder on this PC", "Pick any folder in the Windows folder dialog.", pickPc));
        else if (roots.Count > 0 || (pc && model.IsAdministrator))
          options.Children.Add(Choice("💻", "A folder on the server PC", roots.Count > 0 ? "Pick one of the folders the administrator made available." : "Open Josi on the server PC itself to pick a new folder there.", pcList));
        var missing = new List<string>();
        foreach (var view in providers) {
          var kind = view["provider"].Text;
          if (!CloudLabel.ContainsKey(kind)) continue;
          var accounts = view["connections"].List.Where(c => !c.IsNull).ToList();
          if (accounts.Count == 0 && !view["connection"].IsNull) accounts.Add(view["connection"]);
          var active = accounts.Where(c => c["status"].Text == "active").ToList();
          if (active.Count == 0) { if (view["available"].Flag || kind == "nextcloud") missing.Add(CloudLabel[kind]); continue; }
          foreach (var account in active) {
            var c = account; var k = kind;
            var detail = c["account"].Text.Length > 0 ? c["account"].Text : c["serverUrl"].Text;
            options.Children.Add(Choice("☁", "A folder in " + CloudLabel[kind], detail.Length > 0 ? detail : "Browse the account and pick a folder.", () => openCloud(k, c)));
          }
        }
        if (options.Children.Count == 0) stack.Children.Add(Ui.Caption("There is nowhere to add a folder from yet."));
        stack.Children.Add(options);
        if (missing.Count > 0)
          stack.Children.Add(Ui.Row(10, Ui.Caption("To add a folder from " + string.Join(", ", missing) + ", connect that account first."),
            Ui.Link("Open Connections", () => { sheet.Close(); model.Section = "connections"; })));
        stack.Children.Add(Ui.Wrap(Ui.Pill("Cancel", sheet.Close)));
        show(stack, problem);
      };

      // One request at a time; a refusal lands on the page that asked.
      run = async action => {
        if (sheet.Locked) return;
        sheet.Locked = true; fail(null);
        try {
          await action();
          if (receipt != null) { sheet.Locked = false; sheet.Close(); }
        } catch (JosiException e) { fail(e.Message); }
        catch (Exception e) { fail(AppModel.Friendly(e)); }
        finally { sheet.Locked = false; }
      };

      sheet.Body(host);
      show(Ui.Stack(10, Ui.Title2("Add a folder"), slot(), Ui.Caption("Loading…")), null);
      sheet.Loaded += delegate {
        run(async () => {
          available = await api.Request("/storage/available");
          try { providers = (await api.Request("/connections"))["providers"].List; } catch (JosiException) { providers = new List<Wire>(); }
          if (provider != null && connectionId != null) {
            var view = providers.FirstOrDefault(v => v["provider"].Text == provider);
            var accounts = view == null ? new List<Wire>() : view["connections"].List.Where(c => !c.IsNull).ToList();
            if (view != null && accounts.Count == 0 && !view["connection"].IsNull) accounts.Add(view["connection"]);
            var connection = accounts.FirstOrDefault(c => c.Id == connectionId);
            if (connection != null) { sheet.Locked = false; openCloud(provider, connection); return; }
          }
          sources(null);
        });
      };
      sheet.ShowDialog();
      return receipt;
    }

    static UIElement Choice(string glyph, string title, string detail, Action pick) {
      var button = new Button { Style = (Style)Ui.Resources["Plain"], HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Padding = new Thickness(0) };
      button.Content = new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(14, 12, 14, 12), Background = Ui.Card,
        Child = Ui.Row(12, Ui.T(glyph, 20), Ui.Stack(2, Ui.T(title, 14.5, FontWeights.Medium), Ui.Caption(detail))) };
      Ui.Name(button, title, detail);
      button.Click += delegate { pick(); };
      return button;
    }
  }
}
