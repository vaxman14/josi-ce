using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Josi.Native {
  /// Where backups are kept besides this server: NAS (SMB or NFS) or S3-style
  /// storage (Amazon S3, S3-compatible, MinIO, Cloudflare R2, Backblaze B2).
  /// Fields come from the server's catalogue in each vendor's own words; the
  /// credential is sealed on the server and proved by an explicit test.
  public sealed class BackupDestinationPanel : UserControl {
    readonly AppModel model; readonly Window owner;
    Wire view = Wire.Null; string kind = "", error = "", result = "", recoveryKey = "";
    bool editing, resultOk;
    readonly Dictionary<string, Control> fields = new Dictionary<string, Control>();
    readonly TextBox label = Ui.Input("Off-site copy");
    readonly CheckBox encrypt = Ui.Toggle("Encrypt off-site backups (recommended). Without it, anyone with storage access can read the archive.", true);
    string protocol = "smb"; List<Wire> folders = new List<Wire>(); readonly ComboBox folderPick = new ComboBox();
    public BackupDestinationPanel(AppModel model, Window owner) { this.model = model; this.owner = owner; Loaded += async delegate { await Load(); }; }
    async Task Load() {
      if (model.Api == null) return;
      // A reload after an action keeps that action's message: clearing it here
      // made every refused test and every save warning vanish before it was read.
      try { view = await model.Api.Request("/ops/admin/backups/destination"); }
      catch (JosiException e) { error = e.Message; }
      var d = view["destination"];
      if (!editing) kind = !d.IsNull ? d["kind"].Text : view["catalog"].List.Select(c => c["kind"].Text).FirstOrDefault() ?? "";
      Render();
    }
    Control Field(Wire f) {
      Control c;
      if (!fields.TryGetValue(f["key"].Text, out c)) fields[f["key"].Text] = c = f["secret"].Flag ? (Control)Ui.Secret(f["label"].Text) : Ui.Input(f["placeholder"].Text);
      return c;
    }
    string Value(string key) { Control c; if (!fields.TryGetValue(key, out c)) return ""; var t = c as TextBox; if (t != null) return t.Text.Trim(); var p = c as PasswordBox; return p == null ? "" : p.Password; }
    void Run(Func<JosiApi, Task> work) {
      model.Run(async () => { error = ""; try { await work(model.Api); } catch (JosiException e) { error = e.Message; } finally { await Load(); } });
    }
    void Render() {
      var items = new List<UIElement>();
      if (error.Length > 0) items.Add(Ui.T(error, 13.5, null, Ui.Orange));
      if (recoveryKey.Length > 0) {
        var key = recoveryKey;
        items.Add(Ui.Stack(6, Ui.Headline("Save the backup recovery key now"), Ui.Caption("This is the only visible copy. Keep it somewhere other than the backup destination."),
          Ui.Copyable(key, 13, null, true), Ui.Wrap(Ui.Pill("Save to a File…", () => {
            var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "josi-backup-recovery-key.txt", Filter = "Text (*.txt)|*.txt" };
            if (dialog.ShowDialog(owner) == true) { Dialogs.WritePrivate(dialog.FileName, key + "\n"); recoveryKey = ""; Render(); }
          }, true), Ui.Pill("I Have Saved It", () => { recoveryKey = ""; Render(); }))));
      }
      items.Add(Ui.Caption("Every backup is written to this server at " + (view["localPath"].Text.Length > 0 ? view["localPath"].Text : "its data folder") + ". A copy somewhere else protects you from losing the server itself."));
      var d = view["destination"]; var catalog = view["catalog"].List;
      if (!d.IsNull && !editing) {
        var kindLabel = catalog.Where(c => c["kind"].Text == d["kind"].Text).Select(c => c["label"].Text).FirstOrDefault() ?? d["kind"].Text;
        var tested = d["lastCheckOk"].IsBool ? (d["lastCheckOk"].Flag ? "Tested" : "Last test failed") : "Not tested yet";
        items.Add(Ui.Row(10, Ui.T(kindLabel + (d["label"].Text.Length > 0 ? " · " + d["label"].Text : "")), ModelText.Pill(tested, d["lastCheckOk"].Flag)));
        items.Add(Ui.Caption(d["kind"].Text == "nas" ? "NAS: " + d["shareProtocol"].Text.ToUpperInvariant() + " · " + d["shareHost"].Text + "/" + d["shareName"].Text : "Bucket: " + d["bucket"].Text + (d["region"].Text.Length > 0 ? " · Region: " + d["region"].Text : "")));
        if (d["objectPrefix"].Text.Length > 0) items.Add(Ui.Caption("Folder: " + d["objectPrefix"].Text));
        if (d["kind"].Text != "nas") items.Add(Ui.Caption("Address: " + d["resolvedEndpoint"].Text));
        items.Add(Ui.Caption(d["encryptionEnabled"].Flag ? "Encrypted off-site." : "Not encrypted off-site."));
        if (d["lastCheckOk"].IsBool && !d["lastCheckOk"].Flag && d["lastCheckError"].Text.Length > 0) items.Add(Ui.T(d["lastCheckError"].Text, 13.5, null, Ui.Orange));
        if (result.Length > 0) items.Add(Ui.T(result, 13.5, null, resultOk ? Ui.Green : Ui.Orange));
        items.Add(Ui.Wrap(Ui.Pill(d["lastCheckOk"].Flag ? "Test Again" : "Test Connection", () => Run(async api => { var r = await api.Request("/ops/admin/backups/destination/test", "POST", Wires.O()); result = r["detail"].Text; resultOk = r["ok"].Flag; }), true),
          Ui.Pill("Change", () => {
            editing = true; kind = d["kind"].Text; label.Text = d["label"].Text; encrypt.IsChecked = d["encryptionEnabled"].Flag; protocol = d["shareProtocol"].Text.Length > 0 ? d["shareProtocol"].Text : "smb";
            foreach (var f in catalog.Where(c => c["kind"].Text == kind).SelectMany(c => c["fields"].List)) { var box = Field(f) as TextBox; if (box != null) box.Text = d[f["key"].Text].Text; }
            Render();
          }),
          Ui.Pill("Remove Destination…", () => { if (Dialogs.Confirm(owner, "Remove this backup destination?", "Existing backups are not deleted.", "Remove")) Run(async api => await api.Request("/ops/admin/backups/destination", "DELETE", null)); })));
      } else {
        items.Add(Ui.Segments(catalog.Select(c => new KeyValuePair<string, string>(c["kind"].Text, c["label"].Text)).ToList(), kind, v => { kind = v; fields.Clear(); folders.Clear(); result = ""; Render(); }));
        var entry = catalog.FirstOrDefault(c => c["kind"].Text == kind);
        if (entry != null) {
          Uri docs; var help = Uri.TryCreate(entry["docsUrl"].Text, UriKind.Absolute, out docs) && docs.Scheme == "https" ? Ui.Link("Their documentation", () => ModelText.Open(docs)) : null;
          items.Add(Ui.Row(8, Ui.Caption(entry["credentialsHelp"].Text), help));
          if (kind == "nas") items.Add(Ui.Segments(Ui.Options("smb", "SMB", "nfs", "NFS"), protocol, v => { protocol = v; Render(); }));
          Ui.Detach(label); items.Add(Ui.Field("A name for this (optional)", label));
          var keeping = !d.IsNull && d["credentialsSet"].Flag && d["kind"].Text == kind;
          foreach (var f in entry["fields"].List) {
            var c = Field(f); Ui.Detach(c);
            items.Add(Ui.Field(f["label"].Text + (f["required"].Flag ? "" : " (optional)") + (f["secret"].Flag && keeping ? " (saved; leave empty to keep)" : ""), c));
            if (f["help"].Text.Length > 0) items.Add(Ui.Caption(f["help"].Text));
          }
          if (kind == "nas") {
            items.Add(Ui.Pill("Connect and Browse", () => {
              var body = Values(); body["shareProtocol"] = protocol;
              Run(async api => { folders = (await api.Request("/ops/admin/backups/destination/nas/browse", "POST", body))["folders"].List; folderPick.ItemsSource = new[] { "Share root" }.Concat(folders.Select(x => x.Text)).ToList(); folderPick.SelectedIndex = 0; });
            }));
            if (folders.Count > 0) { Ui.Detach(folderPick); items.Add(Ui.Field("Folder", folderPick)); }
          }
          Ui.Detach(encrypt); items.Add(encrypt);
          items.Add(Ui.Caption("Stored encrypted with this installation's master key. Saving clears any previous test result."));
          var buttons = Ui.Wrap(Ui.Pill("Save Destination", () => {
            var body = Values(); body["kind"] = kind; body["label"] = label.Text.Trim(); body["encryptionEnabled"] = encrypt.IsChecked == true;
            if (kind == "nas") { body["shareProtocol"] = protocol; if (folderPick.SelectedIndex > 0) body["folder"] = folders[folderPick.SelectedIndex - 1].Text; }
            var missing = entry["fields"].List.Where(f => f["required"].Flag && !(f["secret"].Flag && keeping) && Value(f["key"].Text).Length == 0).Select(f => f["label"].Text).ToList();
            if (missing.Count > 0) { error = "Still needed: " + string.Join(", ", missing) + "."; Render(); return; }
            // A username without its password is the one combination no share
            // accepts; saying so here beats a refusal from the NAS later.
            if (kind == "nas" && !keeping && Value("username").Length > 0 && Value("password").Length == 0) { error = "Enter the password for that username, or leave both empty for a share that allows guest access."; Render(); return; }
            foreach (var p in fields.Values.OfType<PasswordBox>()) p.Clear();
            Run(async api => { var r = await api.Request("/ops/admin/backups/destination", "PUT", body); recoveryKey = r["recoveryKey"].Text; if (r["warning"].Text.Length > 0) error = r["warning"].Text; editing = false; fields.Clear(); });
          }, true));
          if (!d.IsNull) buttons.Children.Add(Ui.Pill("Cancel", () => { editing = false; fields.Clear(); Render(); }));
          items.Add(buttons);
        }
      }
      Content = Ui.CardBox("Where backups are kept", items.ToArray());
    }
    Dictionary<string, object> Values() { var body = new Dictionary<string, object>(); foreach (var key in fields.Keys) { var v = Value(key); if (v.Length > 0) body[key] = v; } return body; }
  }

  /// Administrator: Josi Doctor and updates. Doctor checks the installation,
  /// explains problems, and repairs a fixed set of safe problems only after
  /// you approve the exact plan; it snapshots first, verifies, and rolls back
  /// if readiness gets worse. Updates never install on their own: approve a
  /// specific version, Josi backs up first, verifies, and rolls back when it
  /// can. Also diagnostics bundles and support tickets.
  public sealed class MaintenanceView : SectionView {
    Wire status = Wire.Null, diagnosis = Wire.Null, plan = Wire.Null, update = Wire.Null, diagOptions = Wire.Null, supportOptions = Wire.Null, bundle = Wire.Null;
    readonly TextBox confirm = Ui.Input("UPDATE x.y.z"), description = Ui.Input("Describe the problem or request", "", true);
    string window = "24h", category = "bug_report", ticketResult = "";
    readonly CheckBox acknowledged = Ui.Toggle("I understand there is no guaranteed response");
    readonly DispatcherTimer poll = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
    public MaintenanceView(AppModel model, Window owner) : base(model, owner) {
      poll.Tick += delegate { if (update["job"]["state"].Text == "running") StartLoad(); else poll.Stop(); };
    }
    protected override void OnLeave() { poll.Stop(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var s = await api.Request("/admin/doctor");
      Wire u; try { u = await api.Request("/admin/doctor/update"); } catch (JosiException) { u = Wire.Null; }
      Wire d, so; try { d = await api.Request("/ops/diagnostics/options"); } catch (JosiException) { d = Wire.Null; }
      try { so = await api.Request("/ops/support/options"); } catch (JosiException) { so = Wire.Null; }
      if (!Current(stamp)) return;
      status = s; if (diagnosis.IsNull) diagnosis = s["diagnosis"]; update = u; diagOptions = d; supportOptions = so;
      if (update["job"]["state"].Text == "running") poll.Start();
    }
    static string Label(string state) { return state == "pass" ? "Working" : state == "warn" ? "Attention" : "Needs repair"; }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Maintenance", "Josi Doctor checks this installation, explains problems plainly, and repairs a limited set of safe problems after you approve the exact plan.", Ui.Pill("Refresh", StartLoad)));
      Ui.Add(page, Updates(), 0);
      if (status["available"].IsBool && !status["available"].Flag) {
        Ui.Add(page, Ui.CardBox("Josi Doctor needs one refresh", Ui.Secondary(status["message"].Text), Ui.Caption("Run the Josi installer's repair once. It adds the isolated repair helper without replacing your data.")), 0);
      } else {
        var healthy = !diagnosis.IsNull && diagnosis["healthy"].Flag;
        var items = new List<UIElement> { Ui.Caption("Checks the server, storage, the database, networking, backups, notifications and background work.") };
        var buttons = Ui.Wrap(Ui.Pill("Check System", () => Perform(async (api, stamp) => {
          diagnosis = await api.Request("/admin/doctor/check", "POST", Wires.O()); plan = Wire.Null;
          note = diagnosis["healthy"].Flag ? (diagnosis["checks"].List.Any(c => c["state"].Text == "warn") ? "No failures were found. Some items still need attention." : "Everything Josi checked is working.") : "The check found something that needs attention.";
        }, false), true));
        if (!diagnosis.IsNull && !healthy && diagnosis["safeRepairAvailable"].Flag)
          buttons.Children.Add(Ui.Pill("Prepare Automatic Fix", () => Perform(async (api, stamp) => { plan = await api.Request("/admin/doctor/plan", "POST", Wires.O()); diagnosis = plan["diagnosis"]; }, false)));
        items.Add(buttons);
        if (!diagnosis.IsNull && !healthy && !diagnosis["safeRepairAvailable"].Flag) items.Add(Ui.Caption("This problem is outside Doctor's safe repair boundary. It will not guess or change unrelated software."));
        Ui.Add(page, Ui.CardBox(diagnosis.IsNull ? "Check this installation" : healthy ? "Josi looks healthy" : "Josi found a problem", items.ToArray()), 0);
      }
      if (!plan.IsNull) {
        var p = plan["plan"];
        var items = new List<UIElement> { Ui.Secondary(p["summary"].Text) };
        foreach (var n in p["notes"].List) items.Add(Ui.Caption("• " + n.Text));
        items.Add(Ui.Caption(plan["modelUsed"].Flag ? "Josi's configured model explained this redacted diagnosis. The model cannot choose commands or expand the repair." : "The model was unavailable, so Josi used its built-in explanation. The repair boundary is unchanged."));
        items.Add(Ui.Caption("Doctor takes a snapshot first, verifies the result, and rolls back if readiness gets worse."));
        var id = plan.Id; var sha = plan["planSha256"].Text;
        items.Add(Ui.Wrap(Ui.Pill("Apply Approved Fix", () => Perform(async (api, stamp) => {
            try {
              var r = await api.Request("/admin/doctor/repair", "POST", Wires.O("planId", id, "planSha256", sha));
              diagnosis = r["diagnosis"];
              note = diagnosis["healthy"].Flag ? "Repair complete. Josi reran the check and everything is working." : "The repair finished, but something still needs attention.";
            } finally { plan = Wire.Null; }
          }, false), true), Ui.Pill("Cancel", () => { plan = Wire.Null; Render(); })));
        Ui.Add(page, Ui.CardBox("Review the repair", items.ToArray()), 0);
      }
      if (!diagnosis.IsNull) {
        var list = Ui.Stack(8, Ui.Caption("Checked " + Wires.Date(diagnosis["checkedAt"].Text)));
        foreach (var c in diagnosis["checks"].List.OrderBy(c => c["state"].Text == "fail" ? 0 : c["state"].Text == "warn" ? 1 : 2))
          list.Children.Add(Ui.Stack(2, Ui.Spread(Ui.T(c["label"].Text, 14, FontWeights.Medium), ModelText.Pill(Label(c["state"].Text), c["state"].Text == "pass")),
            c["state"].Text == "pass" ? null : Ui.Caption(c["detail"].Text)));
        Ui.Add(page, Ui.CardBox("What Josi checked", list), 0);
      }
      Ui.Add(page, Support(), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    UIElement Updates() {
      if (update.IsNull) return Ui.CardBox("Josi updates", Ui.Caption("The updater could not be reached."));
      var job = update["job"]; var installer = job["applyMode"].Text == "installer";
      var items = new List<UIElement> { Ui.Row(10, ModelText.Pill(job["state"].Text == "running" ? "Updating" : update["updateAvailable"].Flag ? "Update available" : "Version " + update["currentVersion"].Text, !update["updateAvailable"].Flag),
          Ui.Caption(installer ? "Updates use the signed Josi installer. Your data is kept." : "Updates never install automatically. Josi backs up first, verifies the new release, and rolls back when it safely can.")) };
      if (update["lastCheckAt"].Text.Length > 0) items.Add(Ui.Caption("Last checked " + Wires.Date(update["lastCheckAt"].Text)));
      if (job["state"].Text == "running") items.Add(Ui.Secondary("Updating to " + job["targetVersion"].Text + ". " + job["message"].Text + " Josi may briefly disconnect while it restarts."));
      else if (job["message"].Text.Length > 0 && job["state"].Text != "idle") items.Add(Ui.Secondary(job["message"].Text));
      if (!installer && update["updateAvailable"].Flag && update["availableVersion"].Text.Length > 0) {
        var version = update["availableVersion"].Text; var release = update["release"];
        items.Add(Ui.Headline("Version " + version + " is available" + (release["name"].Text.Length > 0 ? ": " + release["name"].Text : "")));
        if (release["notes"].Text.Length > 0) items.Add(Ui.Copyable(release["notes"].Text, 13));
        Uri notes; if (Uri.TryCreate(release["url"].Text, UriKind.Absolute, out notes) && notes.Scheme == "https") items.Add(Ui.Link("Open release notes", () => ModelText.Open(notes)));
        Ui.Detach(confirm);
        items.Add(Ui.Field("Type UPDATE " + version + " to approve", confirm));
        items.Add(Ui.Pill("Back Up and Update to " + version, () => {
          if (confirm.Text != "UPDATE " + version) { model.Error = "Type UPDATE " + version + " exactly to approve."; model.Notify(); return; }
          var text = confirm.Text; confirm.Text = "";
          Perform(async (api, stamp) => { var r = await api.Request("/admin/doctor/update/start", "POST", Wires.O("version", version, "confirm", text)); note = r["message"].Text; });
        }, true));
      }
      if (!installer) items.Add(Ui.Pill("Check for Updates", () => Perform(async (api, stamp) => { update = await api.Request("/admin/doctor/update/check", "POST", Wires.O()); }, false)));
      return Ui.CardBox("Josi updates", items.ToArray());
    }
    UIElement Support() {
      var items = new List<UIElement>();
      if (!diagOptions.IsNull) {
        items.Add(Ui.Headline("Diagnostics bundle"));
        items.Add(Ui.Caption("Contains: " + string.Join("; ", diagOptions["includes"].List.Select(x => x.Text)) + "."));
        items.Add(Ui.Caption("Never contains: " + string.Join("; ", diagOptions["excludes"].List.Select(x => x.Text)) + "."));
        items.Add(Ui.Segments(Ui.Options("1h", "Last hour", "24h", "Last 24 hours", "7d", "Last 7 days"), window, v => { window = v; Render(); }));
        items.Add(Ui.Pill("Build Bundle", () => { var w = window; Perform(async (api, stamp) => { bundle = await api.Request("/ops/diagnostics", "POST", Wires.O("window", w)); }, false); }));
        if (!bundle.IsNull) items.Add(Ui.Caption("Bundle " + bundle.Id + " · " + Wires.Bytes(bundle["byteSize"].Number) + " · " + bundle["redactions"].Integer + " secret(s) removed" + (bundle["trimmed"].Flag ? " · trimmed to the size limit" : "") + "."));
      }
      if (!supportOptions.IsNull) {
        items.Add(Ui.Headline("Support request"));
        var gateway = supportOptions["gateway"];
        var options = supportOptions["categories"].List.Select(c => new KeyValuePair<string, string>(c["category"].Text, Wires.Words(c["category"].Text))).ToList();
        if (options.Count > 0) items.Add(Ui.Segments(options, category, v => { category = v; Render(); }));
        var chosen = supportOptions["categories"].List.FirstOrDefault(c => c["category"].Text == category);
        if (chosen != null) {
          items.Add(Ui.Caption(chosen["acknowledgement"].Text));
          if (chosen["diagnosticsRequired"].Flag) items.Add(Ui.Caption("This kind of request needs a diagnostics bundle. Build one above first."));
        }
        Ui.Detach(description); Ui.Detach(acknowledged);
        items.Add(description); items.Add(acknowledged);
        items.Add(Ui.Pill("Prepare Support Request", () => {
          if (description.Text.Trim().Length == 0) { model.Error = "Describe the problem first."; model.Notify(); return; }
          var body = Wires.O("category", category, "description", description.Text.Trim(), "acknowledged", acknowledged.IsChecked == true);
          if (!bundle.IsNull) body["bundleId"] = bundle.Id;
          var bundleId = bundle.IsNull ? null : bundle.Id;
          Perform(async (api, stamp) => {
            if (bundleId != null) { await api.Request("/ops/diagnostics/" + Uri.EscapeDataString(bundleId)); await api.Request("/ops/diagnostics/" + Uri.EscapeDataString(bundleId) + "/approve", "POST", Wires.O()); }
            var ticket = await api.Request("/ops/support/tickets", "POST", body);
            if (!Dialogs.Confirm(owner, "Send this support request?", "It leaves this installation" + (bundleId != null ? " with the diagnostics bundle you approved" : "") + ".", "Send")) { ticketResult = "Saved, not sent."; return; }
            var sent = await api.Request("/ops/support/tickets/" + Uri.EscapeDataString(ticket.Id) + "/submit", "POST", Wires.O());
            ticketResult = sent["sent"].IsBool && !sent["sent"].Flag ? "Saved, but not sent: " + sent["reason"].Text : "Sent. " + ticket["acknowledgement"].Text;
            description.Text = "";
          }, false);
        }, true));
        if (gateway["configured"].IsBool && !gateway["configured"].Flag) items.Add(Ui.Caption("No support gateway is configured on this installation, so requests are kept here and not sent."));
        if (ticketResult.Length > 0) items.Add(Ui.Secondary(ticketResult));
      }
      return new Disclosure("Diagnostics and support", () => Ui.Stack(10, items.ToArray()));
    }
  }
}
