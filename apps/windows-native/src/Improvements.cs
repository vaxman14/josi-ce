using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Administrator: Josi's improvement ideas. Josi proposes from evidence
  /// (corrections, failed tools, things it could not do); you approve, edit,
  /// reject, roll back. Skills and memory rules apply on approval; a build
  /// brief is only a written request for a developer.
  public sealed class ImprovementsView : SectionView {
    Wire state = Wire.Null;
    readonly Dictionary<string, TextBox> editors = new Dictionary<string, TextBox>();
    public ImprovementsView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var s = await api.Request("/admin/improvements");
      if (Current(stamp)) state = s;
    }
    static string KindLabel(string kind) { return kind == "skill" ? "Skill" : kind == "memory_rule" ? "Memory rule" : "Build brief (needs a developer)"; }
    /// The text you can edit before approving: a skill's steps, the rule, or the brief.
    static string EditableText(Wire change) {
      var kind = change["kind"].Text;
      return kind == "skill" ? change["skill"]["steps"].Text : kind == "memory_rule" ? change["rule"].Text : change["brief"].Text;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Improvements", null, Ui.Pill("Refresh", StartLoad)));
      Ui.Add(page, Ui.Caption("Josi notices when it was corrected, when a tool failed or when it could not do something, and turns that evidence into ideas. Nothing changes until you approve. Skills and memory rules only guide how Josi uses what it already has; they never add permissions."), 0);
      if (state.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading improvements…" : "Improvements have not loaded."), 0); return page; }
      var proposals = state["proposals"].List;
      var waiting = proposals.Where(p => p["state"].Text == "proposed").ToList();
      var list = Ui.Stack(18);
      if (waiting.Count == 0) list.Children.Add(Ui.Caption("No ideas waiting. " + state["openInsights"].Integer + " observations are collecting; Josi proposes once several point the same way."));
      foreach (var p in waiting) {
        var id = p.Id; var change = p["change"]; var kind = change["kind"].Text;
        TextBox editor; if (!editors.TryGetValue(id, out editor)) { editors[id] = editor = Ui.Input("", "", true); editor.Text = EditableText(change); editor.MinHeight = 110; }
        Ui.Detach(editor);
        var item = Ui.Stack(6, Ui.T(p["title"].Text, 15, FontWeights.SemiBold), Ui.Caption(KindLabel(kind) + " · based on " + p["evidence_count"].Integer + " observations"),
          Ui.Copyable(p["problem"].Text, 13.5));
        if (kind == "skill") item.Children.Add(Ui.Caption("Skill \"" + change["skill"]["name"].Text + "\", used when: " + change["skill"]["whenToUse"].Text
          + (change["skill"]["tools"].List.Count > 0 ? " · tools: " + string.Join(", ", change["skill"]["tools"].List.Select(t => t.Text)) : "")));
        item.Children.Add(Ui.Field(kind == "skill" ? "Steps (you can edit before approving)" : kind == "memory_rule" ? "Rule (you can edit before approving)" : "Brief for a developer", editor));
        if (p["risk"].Text.Length > 0) item.Children.Add(Ui.Caption("Risk: " + p["risk"].Text));
        item.Children.Add(Ui.Wrap(
          Ui.Pill(kind == "build_brief" ? "Approve Brief" : "Approve and Apply", () => {
            var text = editor.Text.Trim(); object edits = null;
            if (text != EditableText(change).Trim()) {
              if (kind == "skill") edits = Wires.O("skill", Wires.O("key", change["skill"]["key"].Text, "name", change["skill"]["name"].Text, "whenToUse", change["skill"]["whenToUse"].Text,
                "steps", text, "tools", change["skill"]["tools"].List.Select(t => (object)t.Text).ToList()));
              else edits = Wires.O(kind == "memory_rule" ? "rule" : "brief", text);
            }
            var body = Wires.O("approve", true); if (edits != null) body["edits"] = edits;
            Perform(async (api, stamp) => await api.Request("/admin/improvements/proposals/" + api.Uuid(id) + "/decision", "POST", body));
          }, true),
          Ui.Pill("Reject", () => Perform(async (api, stamp) => await api.Request("/admin/improvements/proposals/" + api.Uuid(id) + "/decision", "POST", Wires.O("approve", false))))));
        list.Children.Add(item);
      }
      Ui.Add(page, Ui.CardBox("Ideas waiting for you", list), 0);

      var skills = Ui.Stack(12);
      var active = state["skills"].List.Where(s => s["active"].Flag).ToList();
      if (active.Count == 0) skills.Children.Add(Ui.Caption("No skills yet."));
      foreach (var s in active) {
        var key = s["skill_key"].Text;
        var older = state["skills"].List.Count(v => v["skill_key"].Text == key && !v["active"].Flag);
        skills.Children.Add(Ui.Stack(4, Ui.Spread(Ui.T(s["name"].Text + "  · version " + s["version"].Integer, 14, FontWeights.Medium),
            Ui.Pill(older > 0 ? "Roll Back to Previous" : "Turn Off", () => {
              if (Dialogs.Confirm(owner, older > 0 ? "Roll back this skill?" : "Turn off this skill?", older > 0 ? "The previous version becomes active again." : "Josi stops using it. It stays in the history.", older > 0 ? "Roll Back" : "Turn Off"))
                Perform(async (api, stamp) => await api.Request("/admin/improvements/skills/" + Uri.EscapeDataString(key) + "/rollback", "POST", Wires.O()));
            })),
          Ui.Caption("Used when: " + s["when_to_use"].Text), Ui.Copyable(s["steps"].Text, 13)));
      }
      Ui.Add(page, Ui.CardBox("Skills", skills), 0);

      var rules = Ui.Stack(10);
      var activeRules = state["rules"].List.Where(r => r["active"].Flag).ToList();
      if (activeRules.Count == 0) rules.Children.Add(Ui.Caption("No memory rules yet."));
      foreach (var r in activeRules) {
        var id = r.Id;
        rules.Children.Add(Ui.Spread(Ui.Copyable(r["rule"].Text, 13.5), Ui.Pill("Turn Off", () => Perform(async (api, stamp) =>
          await api.Request("/admin/improvements/rules/" + api.Uuid(id) + "/disable", "POST", Wires.O())))));
      }
      Ui.Add(page, Ui.CardBox("Memory rules", rules), 0);

      var decided = proposals.Where(p => p["state"].Text != "proposed").ToList();
      if (decided.Count > 0) {
        Ui.Add(page, new Disclosure("Decided ideas", () => {
          var history = Ui.Stack(8);
          foreach (var p in decided) {
            var change = p["change"];
            var row = Ui.Stack(3, Ui.T(p["title"].Text, 13.5, FontWeights.Medium), Ui.Caption(KindLabel(p["change_kind"].Text) + " · " + Wires.Words(p["state"].Text) + " · " + Wires.Date(p["decided_at"].Text)));
            if (p["change_kind"].Text == "build_brief" && p["state"].Text == "approved") row.Children.Add(Ui.Copyable(change["brief"].Text, 13));
            history.Children.Add(row);
          }
          return history;
        }), 0);
      }
      Ui.Add(page, Note(), 0);
      return page;
    }
  }
}
