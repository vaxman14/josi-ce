using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Things Josi will not do without being told to: work it prepared (an
  /// email, a calendar change) and requests to a connected API, where
  /// approving is the sending. Plus your approval history.
  public sealed class ApprovalsView : SectionView {
    List<Wire> approvals = new List<Wire>(), calls = new List<Wire>(), history = new List<Wire>();
    public ApprovalsView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var a = await api.Request("/assistant/approvals");
      Wire c; try { c = await api.Request("/custom-apis/pending"); } catch (JosiException) { c = Wire.Null; }
      Wire h; try { h = await api.Request("/assistant/approvals/history"); } catch (JosiException) { h = Wire.Null; }
      if (!Current(stamp)) return;
      approvals = a["approvals"].List; calls = c["pending"].List; history = h["approvals"].List;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Approvals", null, Ui.Pill("Refresh", StartLoad)));
      if (approvals.Count == 0 && calls.Count == 0)
        Ui.Add(page, Ui.Secondary("Nothing to approve. When Josi wants to do something on your behalf that it should ask about first, it appears here."), 0);
      if (calls.Count > 0) {
        Ui.Add(page, Ui.Heading("Requests to a connected API", "These have not happened. Approving one sends it immediately, exactly as described."), 0);
        foreach (var call in calls) {
          var id = call.Id; var name = call["connectionName"].Text;
          Ui.Add(page, Ui.CardBox(name, Ui.Caption(Wires.Words(call["capability"].Text)), Ui.Copyable(call["summary"].Text),
            Ui.Caption("Expires " + Wires.Date(call["expiresAt"].Text) + ". An old request is not consent, so it stops being answerable then."),
            Ui.Wrap(Ui.Pill("Approve and Send", () => Perform(async (api, stamp) => {
                var r = await api.Request("/custom-apis/pending/" + api.Uuid(id) + "/approve", "POST", Wires.O());
                note = r["ok"].IsBool && !r["ok"].Flag ? name + " was asked and refused the request. Nothing was changed." : "Sent to " + name + ".";
              }), true),
              Ui.Pill("Decline", () => Perform(async (api, stamp) => { await api.Request("/custom-apis/pending/" + api.Uuid(id) + "/deny", "POST", Wires.O()); note = "Declined. Nothing was sent."; })))), 0);
        }
      }
      if (approvals.Count > 0) {
        if (calls.Count > 0) Ui.Add(page, Ui.Headline("Work Josi has prepared"), 0);
        foreach (var a in approvals) {
          var id = a.Id;
          var items = new List<UIElement> { Ui.Copyable(a["summary"].Text), Ui.Caption(Wires.Words(a["action"].Text)) };
          if (a["action_class"].Text == "email_send") items.Add(Ui.Link("Open the final email layout", () => Perform(async (api, stamp) => {
            var r = await api.Request("/mail/templates/approvals/" + api.Uuid(id) + "/preview");
            var file = Path.Combine(Path.GetTempPath(), "josi-approval-" + Guid.NewGuid().ToString("N") + ".html");
            File.WriteAllText(file, "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">" + r["html"].Text);
            ModelText.Open(new Uri(file));
          }, false)));
          items.Add(Ui.Wrap(Ui.Pill("Approve", () => Perform(async (api, stamp) => await api.Request("/assistant/approvals/" + api.Uuid(id) + "/decide", "POST", Wires.O("approve", true))), true),
            Ui.Pill("Decline", () => Perform(async (api, stamp) => await api.Request("/assistant/approvals/" + api.Uuid(id) + "/decide", "POST", Wires.O("approve", false))))));
          Ui.Add(page, Ui.CardBox(null, items.ToArray()), 0);
        }
      }
      Ui.Add(page, new Disclosure("Approval history (" + history.Count + ")", () => {
        var list = Ui.Stack(10);
        if (history.Count == 0) list.Children.Add(Ui.Caption("No decided requests yet."));
        foreach (var h in history)
          list.Children.Add(Ui.Stack(2, Ui.Spread(Ui.T(Wires.Words(h["action"].Text), 14, FontWeights.Medium), ModelText.Pill(Wires.Words(h["status"].Text), h["status"].Text == "approved")),
            Ui.Caption(Wires.Date(h["decided_at"].Text.Length > 0 ? h["decided_at"].Text : h["created_at"].Text)), Ui.Copyable(h["summary"].Text, 13, Ui.Muted)));
        return list;
      }), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
  }

  /// Administrator: the deny-only approval ceiling for each action class. It
  /// can only tighten; loosening is confirmed and recorded.
  public sealed class PolicyView : SectionView {
    static readonly List<KeyValuePair<string, string>> Levels = Ui.Options("always_ask", "Ask me every time", "risky_only", "Ask only for risky actions", "automatic", "Let each person decide for themselves");
    static int Rank(string level) { return level == "automatic" ? 2 : level == "risky_only" ? 1 : 0; }
    Wire data = Wire.Null;
    public PolicyView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() { var api = Api; var stamp = Stamp; var d = await api.Request("/admin/assistant/approval-policy"); if (Current(stamp)) data = d; }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Approval Policy", null, Ui.Pill("Refresh", StartLoad)));
      if (data.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "The approval policy has not loaded."), 0); return page; }
      var migration = data["migration"].List;
      if (migration.Count > 0) {
        var rows = Ui.Stack(4, Ui.Caption("These actions previously had no administrator ceiling, which meant none at all. They now ask for approval. Nothing you had set explicitly was changed."));
        foreach (var m in migration) {
          var cls = data["classes"].List.FirstOrDefault(c => c["key"].Text == m["action_class"].Text);
          rows.Children.Add(Ui.T((cls == null ? m["action_class"].Text : cls["label"].Text) + ": now " + Levels.First(l => l.Key == m["new_max_level"].Text).Value));
        }
        rows.Children.Add(Ui.Pill("I Have Read This", () => Perform(async (api, stamp) => await api.Request("/admin/assistant/approval-policy/acknowledge-migration", "POST", Wires.O()))));
        Ui.Add(page, Ui.CardBox("What changed when this installation was updated", rows), 0);
      }
      var list = Ui.Stack(16, Ui.Caption("This can only tighten. Returning the choice to each person does not switch anyone to automatic. A new user asks about everything by default, and every change is recorded against your account."));
      foreach (var cls in data["classes"].List) {
        var key = cls["key"].Text; var current = cls["maxLevel"].Text.Length > 0 ? cls["maxLevel"].Text : "automatic"; var label = cls["label"].Text; var high = cls["impact"].Text == "high";
        var pick = Ui.Choice(Levels, current);
        pick.SelectionChanged += delegate {
          var level = Ui.Selected(pick); if (level == current) return;
          var relaxing = Rank(level) > Rank(current);
          if (relaxing && !Dialogs.Confirm(owner, "Loosen “" + label + "”?", "This lets Josi act without asking first, for anyone who chooses that for themselves. It is recorded against your account." + (high ? " This is a high-impact action: Josi still asks before each one." : ""), "Loosen")) { Render(); return; }
          Perform(async (api, stamp) => await api.Request("/admin/assistant/approval-policy/" + Uri.EscapeDataString(key), "PUT", Wires.O("maxLevel", level, "confirmRelaxation", relaxing)));
        };
        list.Children.Add(Ui.Stack(4, Ui.Row(8, Ui.T(label, 14, FontWeights.Medium), high ? ModelText.Pill("High impact", false) : null), Ui.Caption(cls["description"].Text), pick,
          high ? Ui.Caption("Josi asks before each individual action in this class whatever this is set to.") : null));
      }
      Ui.Add(page, Ui.CardBox("What is the loosest anyone may choose?", list), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
  }

  /// Soul, About me and Working style files, personality presets, a live
  /// preview, version history and restore. Saving shows what was ignored and
  /// any line that reads like an instruction about permissions.
  public sealed class PersonalizationView : SectionView {
    static readonly string[][] Tabs = { new[] { "soul", "Soul", "Who your assistant is to you." }, new[] { "user", "About Me", "What it should know about you." }, new[] { "agents_user", "Working Style", "How it should behave." } };
    string tab = "soul", boundary = "", previewText = "", notice = "";
    Wire profiles = Wire.Null, effective = Wire.Null, onboarding = Wire.Null;
    List<Wire> presets = new List<Wire>(), versions = new List<Wire>(), ignored = new List<Wire>(), attempts = new List<Wire>(), narrowed = new List<Wire>();
    readonly TextBox editor = Ui.Input("", "", true);
    string editorTab;
    public PersonalizationView(AppModel model, Window owner) : base(model, owner) { editor.MinHeight = 260; editor.FontFamily = Ui.Mono; }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      if (boundary.Length == 0) { try { boundary = (await api.Request("/persona/schema"))["boundary"].Text; } catch (JosiException) { } }
      if (presets.Count == 0) { try { presets = (await api.Request("/persona/presets"))["presets"].List; } catch (JosiException) { } }
      try { onboarding = await api.Request("/persona/onboarding"); } catch (JosiException) { }
      var p = await api.Request("/persona/profiles");
      Wire v; try { v = await api.Request("/persona/profiles/" + tab + "/versions"); } catch (JosiException) { v = Wire.Null; }
      if (!Current(stamp)) return;
      profiles = p["profiles"]; effective = p["effectivePolicy"]; narrowed = p["narrowedByPolicy"].List; versions = v["versions"].List;
      if (editorTab != tab) { editor.Text = profiles[tab]["content"].Text; ignored = profiles[tab]["ignored"].List; editorTab = tab; }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Personalization", boundary.Length > 0 ? boundary : null, Ui.Pill("Refresh", StartLoad)));
      if (onboarding["needed"].Flag && presets.Count > 0) {
        var choices = Ui.Stack(8, Ui.Caption(onboarding["note"].Text));
        foreach (var p in presets) { var key = p["key"].Text; choices.Children.Add(Ui.Pill(p["name"].Text + " · " + p["describes"].Text, () => Perform(async (api, stamp) => await api.Request("/persona/onboarding", "POST", Wires.O("skip", false, "preset", key))))); }
        choices.Children.Add(Ui.Pill("Skip and Use the Default", () => Perform(async (api, stamp) => await api.Request("/persona/onboarding", "POST", Wires.O("skip", true)))));
        Ui.Add(page, Ui.CardBox("Set up your assistant", choices), 0);
      }
      Ui.Add(page, Ui.Segments(Tabs.Select(t => new KeyValuePair<string, string>(t[0], t[1])).ToList(), tab, value => { tab = value; editorTab = null; previewText = ""; notice = ""; attempts.Clear(); StartLoad(); }), 0);
      if (profiles.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Your profiles have not loaded."), 0); return page; }
      var current = profiles[tab]; var info = Tabs.First(t => t[0] == tab);
      var items = new List<UIElement> { Ui.Caption(info[2]) };
      var can = current["explanation"]["can"].List; var cannot = current["explanation"]["cannot"].List;
      if (can.Count + cannot.Count > 0) {
        items.Add(Ui.Stack(2, new UIElement[] { Ui.Headline("This can") }.Concat(can.Select(l => (UIElement)Ui.Caption("· " + l.Text))).ToArray()));
        items.Add(Ui.Stack(2, new UIElement[] { Ui.Headline("This cannot") }.Concat(cannot.Select(l => (UIElement)Ui.Caption("· " + l.Text))).ToArray()));
      }
      Ui.Detach(editor);
      items.Add(Ui.Field("Your " + info[1].ToLowerInvariant() + " file", editor));
      items.Add(Ui.Row(12, Ui.Pill("Save", Save, true), current["version"].Integer > 0 ? Ui.Caption("Version " + current["version"].Integer) : null));
      if (tab == "soul" && presets.Count > 0) {
        var row = Ui.Wrap();
        foreach (var p in presets) { var content = p["content"].Text; row.Children.Add(Ui.Pill(p["name"].Text, () => { editor.Text = content; })); }
        items.Add(Ui.Stack(4, Ui.Headline("Start from a preset"), row, Ui.Caption("A preset fills in the file. Edit it afterwards, or write your own.")));
      }
      items.Add(Ui.Pill("Hear How It Sounds", () => Perform(async (api, stamp) => {
        var r = await api.Request("/persona/preview/live", "POST", Wires.O());
        previewText = r["available"].Flag ? "Josi would say: " + r["reply"].Text : r["reason"].Text;
      }, false)));
      if (previewText.Length > 0) items.Add(Ui.Copyable(previewText));
      if (notice.Length > 0) items.Add(Ui.T(notice, 13.5, null, Ui.Orange));
      if (attempts.Count > 0) { items.Add(Ui.Headline("Lines that read like instructions")); foreach (var a in attempts) items.Add(Ui.Caption("· “" + a["phrase"].Text + "”: kept as personality, changed nothing.")); }
      if (ignored.Count > 0) { items.Add(Ui.Headline("Lines that did nothing")); foreach (var i in ignored) items.Add(Ui.Caption("· " + i["field"].Text + ": " + i["explanation"].Text)); }
      Ui.Add(page, Ui.CardBox(info[1], items.ToArray()), 0);
      if (versions.Count > 0) {
        var list = Ui.Stack(6);
        foreach (var v in versions) {
          var n = v["version"].Integer;
          list.Children.Add(Ui.Spread(Ui.Caption("Version " + n + " · " + Wires.Date(v["created_at"].Text) + " · " + v["bytes"].Integer + " bytes"),
            Ui.Pill("Restore", () => { if (Dialogs.Confirm(owner, "Restore version " + n + "?", "The current file is kept as an earlier version.", "Restore")) Perform(async (api, stamp) => { await api.Request("/persona/profiles/" + tab + "/reset", "POST", Wires.O("toVersion", n)); editorTab = null; }); })));
        }
        Ui.Add(page, new Disclosure("Earlier versions (" + versions.Count + ")", () => list), 0);
      }
      if (tab == "agents_user" && effective.Raw is Dictionary<string, object>) {
        var rows = Ui.Stack(4, Ui.Caption("Your choices after your administrator's policy is applied."));
        foreach (var pair in (Dictionary<string, object>)effective.Raw)
          rows.Children.Add(Ui.Caption(pair.Key + ": " + new Wire(pair.Value).Json.Trim('"') + (narrowed.Any(n => n.Text == pair.Key) ? "  (your administrator requires this)" : "")));
        Ui.Add(page, new Disclosure("What is actually in force", () => rows), 0);
      }
      Ui.Add(page, Ui.Caption("Saved memories are under Memory."), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    void Save() {
      var body = Wires.O("content", editor.Text); var layer = tab;
      Perform(async (api, stamp) => {
        var r = await api.Request("/persona/profiles/" + layer, "PUT", body);
        ignored = r["ignored"].List; attempts = r["authorityAttempts"].List; notice = r["notice"].Text; note = "Saved.";
        editorTab = layer;
      });
    }
  }

  /// Bring portable assistant profiles, memories and conversation history
  /// from OpenClaw, Hermes or a Josi version-1 export. Dry run first, select
  /// and edit, review the exact result, import, keep the receipt; roll back a
  /// batch; search the read-only imported archive.
  public sealed class MigrationView : SectionView {
    static readonly string[] Categories = { "personality", "preferences", "behaviour", "memory", "conversation", "automation", "workspace" };
    static readonly string[] Statuses = { "imported unchanged", "transformed", "duplicate", "sensitive/refused", "unsupported", "ignored" };
    static bool CanImport(Wire i) { var c = i["classification"].Text; return c == "imported unchanged" || c == "transformed"; }
    static bool Editable(Wire i) { return i["category"].Text == "memory" && i["content"].Text.Length > 0 && (CanImport(i) || i["classification"].Text == "duplicate"); }
    string step = "upload", source = "auto", previewId = "", expires = "", revision = "", category = "all";
    readonly List<string> files = new List<string>();
    Wire manifest = Wire.Null, reviewed = Wire.Null, receipt = Wire.Null, archive = Wire.Null;
    readonly HashSet<string> selected = new HashSet<string>();
    readonly Dictionary<string, TextBox> edits = new Dictionary<string, TextBox>();
    List<Wire> batches = new List<Wire>(), archives = new List<Wire>();
    readonly TextBox query = Ui.Input("Search history");
    int page;
    public MigrationView(AppModel model, Window owner) : base(model, owner) { }
    protected override void OnLeave() {
      if (previewId.Length > 0 && Api != null) { var api = Api; var id = previewId; previewId = ""; var _ = api.Request("/migrations/previews/" + Uri.EscapeDataString(id), "DELETE", null).ContinueWith(t => { var e = t.Exception; }); }
    }
    protected override async Task Load() { var api = Api; var stamp = Stamp; var b = await api.Request("/migrations/batches?offset=0"); if (Current(stamp)) batches = b["batches"].List; }
    protected override UIElement Build() {
      var p = Page(Ui.HeadingWith("Migrate From Another Assistant", "Upload, select, review, receipt. Current step: " + step + ".", Ui.Pill("Refresh", StartLoad)),
        Ui.Secondary("Migration transfers data you own and personality preferences. It does not transfer model identity, provider credentials, tool access or unrestricted authority. Josi's approval and security rules still apply."),
        Ui.Caption("Existing profiles and facts are kept. Conversation archives are read-only and never enter prompts. External actions, tasks and automations are never activated. Workspace files need separate mapping."));
      if (step == "upload") {
        var pick = Ui.Choice(Ui.Options("auto", "Detect from documented format", "openclaw", "OpenClaw", "hermes", "Hermes", "josi", "Josi version-1 export"), source);
        pick.SelectionChanged += delegate { source = Ui.Selected(pick); };
        Ui.Add(p, Ui.CardBox("Upload", Ui.Field("Source assistant", pick),
          Ui.Caption("For individual MEMORY.md or USER.md files, choose the source explicitly. Hermes supports its memories files and flat JSONL session export; OpenClaw supports workspace Markdown and Pi session JSONL v3."),
          Ui.Wrap(Ui.Pill("Choose Files…", Choose), Ui.Caption(files.Count == 0 ? "No files chosen." : string.Join(", ", files.Select(Path.GetFileName)))),
          Ui.Caption("One ZIP or up to 100 files; 8 MB total. Previews expire after 10 minutes."),
          Ui.Pill("Scan and Preview", Scan, true)), 0);
      }
      var shown = step == "review" ? reviewed : manifest;
      if ((step == "select" || step == "review") && !shown.IsNull) Ui.Add(p, Results(shown), 0);
      if (step == "receipt" && !receipt.IsNull) {
        Ui.Add(p, Ui.CardBox("Import completed", Ui.T(receipt["created"].Integer + " new rows saved."), Ui.Copyable("Batch: " + receipt["batchId"].Text, 13, Ui.Muted), Counts(receipt["items"].List),
          Ui.Wrap(Ui.Pill("Done", () => { step = "upload"; receipt = Wire.Null; Render(); }, true), Ui.Pill("Save Receipt…", () => SaveReceipt(receipt)))), 0);
      }
      var list = Ui.Stack(10, Ui.Caption("Rollback permanently removes only the rows created by that batch. Pre-existing data stays."));
      if (batches.Count == 0) list.Children.Add(Ui.Caption("No import batches yet."));
      foreach (var b in batches) {
        var id = b.Id;
        var row = Ui.Wrap(Ui.Pill("Receipt…", () => Perform(async (api, stamp) => SaveReceipt((await api.Request("/migrations/batches/" + Uri.EscapeDataString(id)))["receipt"]), false)));
        if (b["rolled_back_at"].Text.Length > 0) row.Children.Add(Ui.Caption("Rolled back " + Wires.Date(b["rolled_back_at"].Text)));
        else row.Children.Add(Ui.Danger("Roll Back Batch…", () => {
          if (!Dialogs.Confirm(owner, "Roll back this batch?", "Removes this batch's imported rows, including edits made to them since import.", "Roll Back")) return;
          Perform(async (api, stamp) => { var r = await api.Request("/migrations/batches/" + Uri.EscapeDataString(id) + "/rollback", "POST", Wires.O("confirm", "rollback")); note = "Rollback completed. " + r["removed"].Integer + " rows removed."; });
        }));
        list.Children.Add(Ui.Stack(4, Ui.Caption(Wires.Date(b["created_at"].Text) + " · " + b["receipt"]["created"].Integer + " rows · " + id), row));
      }
      Ui.Add(p, Ui.CardBox("Your import batches", list), 0);
      Ui.Detach(query);
      var arch = Ui.Stack(8, Ui.Caption("Searchable, read-only historical text. It cannot be resumed and is never loaded into an assistant prompt."), query,
        Ui.Pill("Search Archive", () => Perform(async (api, stamp) => { archives = (await api.Request("/migrations/archives?q=" + Uri.EscapeDataString(query.Text) + "&offset=0"))["archives"].List; archive = Wire.Null; if (archives.Count == 0) note = "No imported conversations match this search."; }, false)));
      foreach (var a in archives) {
        var id = a.Id; var prov = a["source_provenance"];
        arch.Children.Add(Ui.Stack(3, Ui.Caption(prov["source"].Text + " · " + prov["path"].Text + " · " + prov["locator"].Text), Ui.Caption(a["excerpt"].Text),
          Ui.Link("Read conversation", () => Perform(async (api, stamp) => { archive = (await api.Request("/migrations/archives/" + Uri.EscapeDataString(id)))["archive"]; }, false))));
      }
      if (!archive.IsNull) arch.Children.Add(Ui.Stack(6, Ui.Headline(archive["source_provenance"]["path"].Text), Ui.Copyable(archive["content"].Text, 13), Ui.Pill("Close Conversation", () => { archive = Wire.Null; Render(); })));
      Ui.Add(p, Ui.CardBox("Imported conversation archive", arch), 0);
      Ui.Add(p, Note(), 0);
      return p;
    }
    UIElement Counts(List<Wire> items) {
      var wrap = Ui.Wrap();
      foreach (var s in Statuses) wrap.Children.Add(new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6), Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 0, 8, 8),
        Child = Ui.Stack(1, Ui.Caption(Wires.Capitalize(s)), Ui.T(items.Count(i => i["classification"].Text == s).ToString(), 15, FontWeights.SemiBold)) });
      return wrap;
    }
    UIElement Results(Wire shown) {
      var items = shown["items"].List;
      var stack = Ui.Stack(10, Ui.Caption((step == "select" ? "Dry run: nothing has been saved. Select the items you want; edit or redact proposed memories." : "Final dry run: review these exact results before importing.") + " Preview expires " + Wires.Date(expires) + "."), Counts(items));
      if (step == "select") {
        var cats = Ui.Wrap();
        foreach (var name in Categories) {
          var candidates = manifest["items"].List.Where(i => i["category"].Text == name && CanImport(i)).ToList();
          var box = Ui.Toggle(name + " (" + candidates.Count + ")", candidates.Count > 0 && candidates.All(i => selected.Contains(i.Id)));
          box.IsEnabled = candidates.Count > 0; box.Margin = new Thickness(0, 0, 14, 0);
          box.Click += delegate { foreach (var i in candidates) { if (box.IsChecked == true) selected.Add(i.Id); else selected.Remove(i.Id); } Render(); };
          cats.Children.Add(box);
        }
        stack.Children.Add(cats);
      }
      var filter = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("all", "All") };
      filter.AddRange(Categories.Select(c => new KeyValuePair<string, string>(c, Wires.Capitalize(c))));
      stack.Children.Add(Ui.Segments(filter, category, value => { category = value; page = 0; Render(); }));
      var filtered = items.Where(i => category == "all" || i["category"].Text == category).ToList();
      foreach (var item in filtered.Skip(page * 25).Take(25)) {
        var id = item.Id; var prov = item["provenance"];
        var card = Ui.Stack(4, Ui.Spread(Ui.T(prov["path"].Text + " · " + prov["locator"].Text, 13.5, FontWeights.Medium), Ui.Caption(item["classification"].Text)),
          Ui.Caption(prov["source"].Text + " · " + prov["format"].Text), Ui.Caption(item["reason"].Text));
        if (step == "select" && (CanImport(item) || Editable(item))) {
          var box = Ui.Toggle("Select this item", selected.Contains(id));
          box.Click += delegate { if (box.IsChecked == true) selected.Add(id); else selected.Remove(id); };
          card.Children.Add(box);
        }
        if (step == "select" && Editable(item)) {
          TextBox edit; if (!edits.TryGetValue(id, out edit)) { edits[id] = edit = Ui.Input("", item["content"].Text, true); edit.TextChanged += delegate { selected.Add(id); }; }
          Ui.Detach(edit); card.Children.Add(Ui.Field("Proposed memory (edit or redact)", edit));
        } else if (item["content"].Text.Length > 0) card.Children.Add(new Disclosure("View proposed content", () => Ui.Copyable(item["content"].Text, 13)));
        stack.Children.Add(new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(12), Child = card });
      }
      stack.Children.Add(Ui.Row(10, Ui.Pill("Previous Items", () => { page = Math.Max(0, page - 1); Render(); }),
        Ui.Caption((filtered.Count == 0 ? 0 : page * 25 + 1) + "–" + Math.Min(filtered.Count, (page + 1) * 25) + " of " + filtered.Count),
        Ui.Pill("Next Items", () => { if ((page + 1) * 25 < filtered.Count) { page++; Render(); } })));
      var actions = Ui.Wrap();
      if (step == "select") actions.Children.Add(Ui.Pill("Review " + selected.Count + " Selected Items", Review, true));
      else {
        actions.Children.Add(Ui.Pill("Import " + items.Count(CanImport) + " Reviewed Items", Commit, true));
        actions.Children.Add(Ui.Pill("Back to Selection", () => { step = "select"; page = 0; Render(); }));
      }
      actions.Children.Add(Ui.Pill("Discard Preview", Discard));
      stack.Children.Add(actions);
      return Ui.CardBox(step == "select" ? "Select and edit" : "Review", stack);
    }
    void Choose() {
      var dialog = new Microsoft.Win32.OpenFileDialog { Multiselect = true, Filter = "Assistant exports (*.zip;*.md;*.json;*.jsonl)|*.zip;*.md;*.json;*.jsonl", CheckFileExists = true };
      if (dialog.ShowDialog(owner) != true) return;
      files.Clear(); files.AddRange(dialog.FileNames); Render();
    }
    void Scan() {
      if (files.Count == 0 || files.Count > 100 || files.Sum(f => new FileInfo(f).Length) > 8 * 1024 * 1024) { model.Error = "Choose 1–100 files, no more than 8 MB total."; model.Notify(); return; }
      var chosen = files.ToList();
      Perform(async (api, stamp) => {
        var r = await api.UploadFiles("/migrations/scan?source=" + Uri.EscapeDataString(source), "files", chosen, 8 * 1024 * 1024);
        previewId = r["previewId"].Text; expires = r["expiresAt"].Text; manifest = r["manifest"];
        selected.Clear(); edits.Clear(); category = "all"; page = 0; step = "select"; files.Clear();
      }, false);
    }
    void Review() {
      var selections = selected.Select(id => { var o = Wires.O("id", id); TextBox e; if (edits.TryGetValue(id, out e)) o["content"] = e.Text; return (object)o; }).ToList();
      Perform(async (api, stamp) => {
        var r = await api.Request("/migrations/" + Uri.EscapeDataString(previewId) + "/review", "POST", Wires.O("selections", selections));
        reviewed = r["manifest"]; revision = r["revision"].Text; page = 0; category = "all"; step = "review";
      }, false);
    }
    void Commit() {
      Perform(async (api, stamp) => {
        var r = await api.Request("/migrations/" + Uri.EscapeDataString(previewId) + "/commit", "POST", Wires.O("revision", revision, "confirm", "import"));
        receipt = r["receipt"]; step = "receipt"; manifest = reviewed = Wire.Null; previewId = ""; selected.Clear(); edits.Clear();
      });
    }
    void Discard() {
      var id = previewId;
      Perform(async (api, stamp) => {
        if (id.Length > 0) { try { await api.Request("/migrations/previews/" + Uri.EscapeDataString(id), "DELETE", null); } catch (JosiException e) { if (e.Status != 404) throw; } }
        previewId = ""; manifest = reviewed = Wire.Null; selected.Clear(); edits.Clear(); step = "upload";
      }, false);
    }
    void SaveReceipt(Wire value) {
      var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "josi-migration-" + value["batchId"].Text + ".json", Filter = "JSON (*.json)|*.json" };
      if (dialog.ShowDialog(owner) == true) File.WriteAllText(dialog.FileName, value.Json);
    }
  }
}
