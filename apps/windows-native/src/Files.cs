using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Josi.Native {
  /// Local Workspace: folders you explicitly connected. Browse, search,
  /// preview and download; every change (create, edit, rename/move, delete,
  /// new folder) is prepared first and applied only after you approve that
  /// exact change. Also the isolated JavaScript coding sandbox.
  public sealed class FilesView : SectionView {
    List<Wire> mappings = new List<Wire>(), entries = new List<Wire>();
    Wire available = Wire.Null, permissions = Wire.Null;
    string mapping = "", path = "", preview = "", receipt = "";
    Wire pending = Wire.Null; Dictionary<string, object> pendingChange;
    readonly TextBox filter = Ui.Input("Search this folder"), name = Ui.Input("Filename"), content = Ui.Input("", "", true), destination = Ui.Input("Destination relative to the folder");
    readonly ComboBox rootPick = new ComboBox();
    bool editing, moving;
    // Coding sandbox
    readonly TextBox source = Ui.Input("Exact JavaScript source", "", true);
    readonly ComboBox codeMode = Ui.Choice(Ui.Options("check", "Check syntax", "run", "Execute JavaScript"), "check");
    string runId = "", runStatus = "", runOutput = "";
    readonly DispatcherTimer poll = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };

    public FilesView(AppModel model, Window owner) : base(model, owner) {
      filter.TextChanged += delegate { Render(); };
      content.MinHeight = 120; source.MinHeight = 120; source.FontFamily = Ui.Mono;
      poll.Tick += async delegate { await PollRun(); };
    }
    protected override void OnLeave() { poll.Stop(); }
    protected override double PageWidth() { return 1000; }

    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var a = await api.Request("/storage/available");
      var m = await api.Request("/storage/mappings");
      if (!Current(stamp)) return;
      available = a;
      var roots = a["roots"].List;
      mappings = m["mappings"].List.Where(x => x["provider"].Text == "local" && x["status"].Text == "active"
        && a["capability"]["may_map_local"].Flag && roots.Any(r => r.Id == x["root_id"].Text)).ToList();
      rootPick.ItemsSource = roots.Select(r => r["label"].Text).ToList();
      if (rootPick.SelectedIndex < 0 && roots.Count > 0) rootPick.SelectedIndex = 0;
      if (!mappings.Any(x => x.Id == mapping)) mapping = mappings.Count == 1 ? mappings[0].Id : "";
      await List(api, stamp);
    }
    async Task List(JosiApi api, int stamp) {
      if (mapping.Length == 0) { entries = new List<Wire>(); return; }
      var data = await api.Request("/workspace/" + api.Uuid(mapping) + "/list?path=" + Uri.EscapeDataString(path));
      if (!Current(stamp)) return;
      entries = data["entries"].List; permissions = data["permissions"];
    }
    string Full(string entry) { return string.Join("/", new[] { path, entry }.Where(s => s.Length > 0)); }

    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Files", null, Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Browse folders you explicitly connected. Files are never instructions to grant access. Cloud folders (Google Drive, OneDrive, Dropbox, Box, Nextcloud) are added under Connections."));
      if (receipt.Length > 0) Ui.Add(page, Ui.T("Completed. Receipt: " + receipt, 14, null, Ui.Green), 0);
      if (available.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Folders have not loaded."), 0); return page; }
      if (mappings.Count == 0) { Ui.Add(page, Connect(), 0); return page; }
      var picker = Ui.Segments(mappings.Select(m => new KeyValuePair<string, string>(m.Id, m["display_path"].Text)).ToList(), mapping,
        value => { mapping = value; path = ""; preview = ""; pending = Wire.Null; StartLoad(); });
      Ui.Add(page, Ui.Field("Connected folder", new ContentControl { Content = picker, Focusable = false }), 0);
      if (mapping.Length == 0) return page;

      var crumbs = Ui.Wrap(Ui.Link("Folder root", () => { path = ""; StartLoad(); }));
      var parts = path.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
      for (var i = 0; i < parts.Length; i++) { var to = string.Join("/", parts.Take(i + 1)); crumbs.Children.Add(Ui.Link("/ " + parts[i], () => { path = to; StartLoad(); })); }
      Ui.Detach(filter);
      Ui.Add(page, Ui.Spread(crumbs, filter), 0);
      filter.Width = 260;

      var list = Ui.Stack(6);
      var shown = entries.Where(e => e["name"].Text.IndexOf(filter.Text, StringComparison.OrdinalIgnoreCase) >= 0)
        .OrderBy(e => e["kind"].Text == "folder" ? 0 : 1).ThenBy(e => e["name"].Text, StringComparer.CurrentCultureIgnoreCase).ToList();
      if (shown.Count == 0) list.Children.Add(Ui.Secondary(entries.Count == 0 ? "This folder is empty." : "Nothing matches."));
      foreach (var e in shown) {
        var entry = e["name"].Text; var full = Full(entry);
        if (e["kind"].Text == "folder") { list.Children.Add(Ui.Link("📁  " + entry, () => { path = full; StartLoad(); })); continue; }
        var detail = e["size"].IsNumber ? Wires.Bytes(e["size"].Number) + (e["modified"].Text.Length > 0 ? " · " + Wires.Date(e["modified"].Text) : "") : "";
        var actions = Ui.Wrap(Ui.Pill("Preview", () => Perform(async (api, stamp) => {
            var x = await api.Request("/workspace/" + api.Uuid(mapping) + "/preview?path=" + Uri.EscapeDataString(full));
            preview = full + " · " + Wires.Bytes(x["size"].Number) + "\n\n" + x["text"].Text;
          }, false)),
          Ui.Pill("Download…", () => Download(full, entry)));
        if (permissions["edit"].Flag) actions.Children.Add(Ui.Pill("Edit Text", () => Perform(async (api, stamp) => {
            var x = await api.Request("/workspace/" + api.Uuid(mapping) + "/preview?path=" + Uri.EscapeDataString(full));
            name.Text = entry; content.Text = x["text"].Text; editing = true; moving = false;
          }, false)));
        if (permissions["move"].Flag) actions.Children.Add(Ui.Pill("Rename or Move", () => { name.Text = entry; destination.Text = full; moving = true; Render(); }));
        if (permissions["delete"].Flag) actions.Children.Add(Ui.Pill("Delete…", () => Propose(Wires.O("operation", "delete", "path", full))));
        list.Children.Add(Ui.Spread(Ui.Stack(2, Ui.T("📄  " + entry), Ui.Caption(detail)), actions));
      }
      Ui.Add(page, Ui.CardBox(null, list), 0);
      if (preview.Length > 0) Ui.Add(page, Ui.CardBox("Preview", Ui.Copyable(preview, 13, null, true), Ui.Pill("Close Preview", () => { preview = ""; Render(); })), 0);
      if (moving) {
        Ui.Detach(destination);
        Ui.Add(page, Ui.CardBox("Rename or move " + name.Text, Ui.Field("Destination relative to the folder", destination),
          Ui.Wrap(Ui.Pill("Review Move", () => Propose(Wires.O("operation", "move", "path", Full(name.Text), "destination", destination.Text)), true),
            Ui.Pill("Cancel", () => { moving = false; Render(); }))), 0);
      }
      if (permissions["create"].Flag || permissions["edit"].Flag) {
        Ui.Detach(name); Ui.Detach(content);
        var buttons = Ui.Wrap(Ui.Pill(editing ? "Review Text Edit" : "Review File Creation", () => Propose(Wires.O("operation", editing ? "edit" : "create", "path", Full(name.Text), "content", content.Text)), true));
        if (permissions["create"].Flag) buttons.Children.Add(Ui.Pill("Review Folder Creation", () => Propose(Wires.O("operation", "mkdir", "path", Full(name.Text)))));
        buttons.Children.Add(Ui.Pill("Open a Text File…", OpenText));
        if (editing) buttons.Children.Add(Ui.Pill("Create a New File Instead", () => { editing = false; name.Text = ""; content.Text = ""; Render(); }));
        Ui.Add(page, Ui.CardBox(editing ? "Edit " + name.Text : "Create a file or folder", Ui.Field("Name", name), Ui.Field("Contents", content), buttons), 0);
      }
      if (!pending.IsNull) {
        var c = pendingChange;
        var items = new List<UIElement> { Ui.T(c["path"] + (c.ContainsKey("destination") ? " → " + c["destination"] : "")) };
        if ((string)c["operation"] == "delete") items.Add(Ui.Caption("This removes the file from this folder. A recovery copy is kept for the operator."));
        if (c.ContainsKey("content")) items.Add(Ui.Copyable((string)c["content"], 13, null, true));
        items.Add(Ui.Wrap(Ui.Pill("Approve Exact Change", Approve, true), Ui.Pill("Cancel", () => { pending = Wire.Null; Render(); })));
        Ui.Add(page, Ui.CardBox("Confirm " + c["operation"], items.ToArray()), 0);
      }
      Ui.Add(page, Coding(), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }

    UIElement Connect() {
      var native = available["nativeWorkspace"];
      var items = new List<UIElement>();
      var status = native["status"].Text;
      items.Add(Ui.Secondary(status == "unavailable" ? "Josi cannot read the selected workspace folder (" + native["label"].Text + "). Review it and refresh."
        : status == "paused" ? "This folder connection is paused. Review its access settings before reconnecting." : "No local folders connected."));
      var canConnect = (!native.IsNull && (status == "revoked" || status == "awaiting_mapping"))
        || (available["capability"]["may_map_local"].Flag && available["roots"].List.Count > 0 && status != "paused");
      if (canConnect) {
        if (!native.IsNull) items.Add(Ui.T("Selected folder: " + native["label"].Text));
        else { Ui.Detach(rootPick); items.Add(Ui.Field("Available folder", rootPick)); }
        items.Add(Ui.Caption("Connect this folder, everything inside it, and subfolders added later. Files are read when you ask; connecting does not turn on indexing or grant write access."));
        items.Add(Ui.Pill("Connect Folder", () => {
          var roots = available["roots"].List; var index = rootPick.SelectedIndex;
          Perform(async (api, stamp) => {
            if (!native.IsNull) await api.Request("/storage/native-workspace/connect", "POST", Wires.O());
            else if (index >= 0) await api.Request("/storage/mappings", "POST", Wires.O("provider", "local", "rootId", roots[index].Id, "relativePath", "", "recursive", true));
          });
        }, true));
      } else if (status != "unavailable" && status != "paused") {
        items.Add(Ui.Caption("Folder mapping permission and a configured folder are required. Ask your administrator to review local folder access (People and Storage)."));
      }
      return Ui.CardBox("Local Workspace", items.ToArray());
    }

    void Propose(Dictionary<string, object> change) {
      Perform(async (api, stamp) => {
        var x = await api.Request("/workspace/" + api.Uuid(mapping) + "/change", "POST", change);
        if (!Current(stamp)) return;
        pending = x["approval"]; pendingChange = change; receipt = "";
      }, false);
    }
    void Approve() {
      var body = new Dictionary<string, object>(pendingChange); body["confirm"] = true;
      var id = pending.Id;
      Perform(async (api, stamp) => {
        var x = await api.Request("/workspace/" + api.Uuid(mapping) + "/change/" + api.Uuid(id), "POST", body);
        if (!Current(stamp)) return;
        receipt = x["receipt"].Text; pending = Wire.Null; moving = false; editing = false; name.Text = ""; content.Text = "";
      });
    }
    void Download(string full, string fileName) {
      var dialog = new Microsoft.Win32.SaveFileDialog { FileName = fileName, Title = "Save a copy" };
      if (dialog.ShowDialog(owner) != true) return;
      var target = dialog.FileName;
      Perform(async (api, stamp) => {
        await api.DownloadFile("/workspace/" + api.Uuid(mapping) + "/file?path=" + Uri.EscapeDataString(full), target, 512L * 1024 * 1024);
        note = "Saved " + target + ".";
      }, false);
    }
    void OpenText() {
      var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "Text files (*.txt;*.md;*.csv;*.json;*.log)|*.txt;*.md;*.csv;*.json;*.log", CheckFileExists = true };
      if (dialog.ShowDialog(owner) != true) return;
      var info = new System.IO.FileInfo(dialog.FileName);
      if (info.Length > 262144) { model.Error = "Choose a text file of up to 256 KB."; model.Notify(); return; }
      name.Text = info.Name; content.Text = System.IO.File.ReadAllText(info.FullName); editing = false; Render();
    }

    UIElement Coding() {
      var active = runStatus == "pending" || runStatus == "running";
      Ui.Detach(codeMode); Ui.Detach(source);
      codeMode.IsEnabled = !active; source.IsReadOnly = active;
      var items = new List<UIElement> {
        Ui.Caption("Administrator opt-in required. Each run is isolated: JavaScript only, 30 seconds, 128 MB, no network or host files. Review every source line before approval."),
        Ui.Field("Operation", codeMode), Ui.Field("Exact source", source) };
      var buttons = Ui.Wrap();
      if (!active) buttons.Children.Add(Ui.Pill("Prepare for Review", () => {
        var body = Wires.O("mode", Ui.Selected(codeMode), "source", source.Text);
        Perform(async (api, stamp) => { var r = await api.Request("/workspace/" + api.Uuid(mapping) + "/code", "POST", body); runId = r.Id; runStatus = r["status"].Text; runOutput = ""; }, false);
      }));
      if (runStatus == "pending") buttons.Children.Add(Ui.Pill(Ui.Selected(codeMode) == "check" ? "Approve This Exact Source and Check Syntax" : "Approve This Exact Source and Execute", () =>
        Perform(async (api, stamp) => { var r = await api.Request("/workspace/code/" + api.Uuid(runId) + "/start", "POST", Wires.O("confirm", true)); runStatus = r["status"].Text; if (runStatus == "running") poll.Start(); }, false), true));
      if (active) buttons.Children.Add(Ui.Pill("Cancel Run", () => Perform(async (api, stamp) => { var r = await api.Request("/workspace/code/" + api.Uuid(runId) + "/cancel", "POST", Wires.O()); runStatus = r["status"].Text; }, false)));
      items.Add(buttons);
      if (runStatus.Length > 0) items.Add(Ui.Caption("Run " + runId + ": " + runStatus));
      if (runOutput.Length > 0) items.Add(Ui.Copyable(runOutput, 13, null, true));
      return new Disclosure("Coding sandbox", () => Ui.Stack(10, items.ToArray()), runStatus.Length > 0);
    }
    async Task PollRun() {
      if (runId.Length == 0 || runStatus != "running" || Api == null) { poll.Stop(); return; }
      try {
        var r = await Api.Request("/workspace/code/" + Api.Uuid(runId));
        runStatus = r["status"].Text; runOutput = r["output"].Text.Length > 0 ? r["output"].Text : r["error"].Text;
        if (runStatus != "running") poll.Stop();
        Render();
      } catch (JosiException e) { poll.Stop(); model.Error = e.Message; model.Notify(); }
    }
  }

  /// Administrator: storage limits, allowed file types, archives, Windows
  /// antivirus requirement, and who may use the coding sandbox.
  public sealed class StorageAdminView : SectionView {
    Wire policy = Wire.Null, malware = Wire.Null; List<Wire> coders = new List<Wire>();
    readonly Dictionary<string, TextBox> numbers = new Dictionary<string, TextBox>();
    readonly TextBox extensions = Ui.Input("", "", true);
    readonly CheckBox archives = Ui.Toggle("Index supported archives"), scanning = Ui.Toggle("Require malware scanning before file processing");
    const double MB = 1024 * 1024;
    static readonly string[][] Fields = {
      new[] { "maxFileMb", "Maximum file size (MB)" }, new[] { "maxTotalMb", "Maximum storage per person (MB)" }, new[] { "maxFiles", "Maximum files per person" },
      new[] { "archiveMaxEntries", "Maximum entries per archive" }, new[] { "archiveMaxTotalMb", "Maximum expanded size (MB)" },
      new[] { "archiveMaxDepth", "Maximum nested depth (1–3)" }, new[] { "archiveMaxSeconds", "Maximum processing time (seconds)" } };
    public StorageAdminView(AppModel model, Window owner) : base(model, owner) { foreach (var f in Fields) numbers[f[0]] = Ui.Input(f[1]); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var r = await api.Request("/storage/admin/policy");
      List<Wire> people;
      try { people = (await api.Request("/storage/admin/capabilities"))["users"].List; } catch (JosiException) { people = new List<Wire>(); }
      if (!Current(stamp)) return;
      Apply(r); coders = people;
    }
    void Apply(Wire r) {
      policy = r["policy"]; malware = r["malwareScanning"];
      numbers["maxFileMb"].Text = Math.Round(policy["max_file_bytes"].Number / MB).ToString();
      numbers["maxTotalMb"].Text = Math.Round(policy["max_total_bytes_per_user"].Number / MB).ToString();
      numbers["maxFiles"].Text = policy["max_files_per_user"].Integer.ToString();
      numbers["archiveMaxEntries"].Text = policy["archive_max_entries"].Integer.ToString();
      numbers["archiveMaxTotalMb"].Text = Math.Round(policy["archive_max_total_bytes"].Number / MB).ToString();
      numbers["archiveMaxDepth"].Text = policy["archive_max_depth"].Integer.ToString();
      numbers["archiveMaxSeconds"].Text = policy["archive_max_seconds"].Integer.ToString();
      extensions.Text = string.Join(", ", policy["allowed_extensions"].List.Select(x => x.Text));
      archives.IsChecked = policy["archives_enabled"].Flag; scanning.IsChecked = malware["required"].Flag;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Storage", null, Ui.Pill("Refresh", StartLoad)));
      var coding = Ui.Stack(6, Ui.Caption("Off by default. Turning it on lets a person submit JavaScript to the isolated sandbox helper. Every run still needs that person's approval. No host files or network are granted."));
      foreach (var person in coders) {
        var id = person["user_id"].Text; var on = person["coding_enabled"].Flag;
        var box = Ui.Toggle(person["username"].Text, on);
        box.Click += delegate { var enabled = box.IsChecked == true; Perform(async (api, stamp) => await api.Request("/workspace/admin/coding/" + api.Uuid(id), "PUT", Wires.O("enabled", enabled))); };
        coding.Children.Add(box);
      }
      Ui.Add(page, Ui.CardBox("Coding sandbox access", coding), 0);
      if (policy.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Storage settings have not loaded."), 0); return page; }
      if (!malware.IsNull) {
        Ui.Detach(scanning);
        var status = malware["status"].Text;
        Ui.Add(page, Ui.CardBox("Windows antivirus", Ui.Secondary((status == "available" ? "Your installed antivirus accepted an explicit scan request." : status == "error" ? "The antivirus scan failed. Files that require scanning cannot be processed." : "Antivirus scanning is unavailable. Files that require scanning cannot be processed.") + " Josi asks Windows to scan each file when scanning is required."),
          scanning, malware["required"].Flag ? null : Ui.Caption("Scanning is optional under your current policy. Unscanned files are never reported as clean.")), 0);
      }
      Ui.Add(page, Ui.CardBox("Indexing limits", Ui.Caption("These limits protect the server. A limit may cause files to be skipped; raising it can increase CPU, memory and disk use."),
        N("maxFileMb"), N("maxTotalMb"), N("maxFiles")), 0);
      Ui.Detach(extensions);
      Ui.Add(page, Ui.CardBox("Allowed file types", Ui.Caption("Extensions separated by commas or spaces, without dots. Keep executables, disk images, keys and unknown binaries excluded."), extensions), 0);
      Ui.Detach(archives);
      Ui.Add(page, Ui.CardBox("Archives", archives, Ui.Caption("Every extracted entry still passes the file-type, encryption and malware checks."),
        N("archiveMaxEntries"), N("archiveMaxTotalMb"), N("archiveMaxDepth"), N("archiveMaxSeconds")), 0);
      Ui.Add(page, Ui.Pill("Save Storage Settings", Save, true), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    FrameworkElement N(string key) { var box = numbers[key]; Ui.Detach(box); return Ui.Field(Fields.First(f => f[0] == key)[1], box); }
    void Save() {
      var values = new Dictionary<string, double>();
      foreach (var f in Fields) {
        double v;
        if (!double.TryParse(numbers[f[0]].Text, out v) || v < 1) { model.Error = f[1] + " must be a whole number of at least 1."; model.Notify(); return; }
        values[f[0]] = v;
      }
      var list = extensions.Text.Split(new[] { ',', ' ', '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries).Select(e => e.Trim().ToLowerInvariant().TrimStart('.')).Where(e => e.Length > 0).Cast<object>().ToList();
      var body = Wires.O("maxFileBytes", values["maxFileMb"] * MB, "maxTotalBytesPerUser", values["maxTotalMb"] * MB, "maxFilesPerUser", values["maxFiles"],
        "allowedExtensions", list, "archivesEnabled", archives.IsChecked == true, "archiveMaxEntries", values["archiveMaxEntries"],
        "archiveMaxTotalBytes", values["archiveMaxTotalMb"] * MB, "archiveMaxDepth", values["archiveMaxDepth"], "archiveMaxSeconds", values["archiveMaxSeconds"]);
      if (!malware.IsNull) body["malwareScanningEnabled"] = scanning.IsChecked == true;
      Perform(async (api, stamp) => { var r = await api.Request("/storage/admin/policy", "PUT", body); if (Current(stamp)) { Apply(r); note = "Storage settings saved."; } }, false);
    }
  }
}
