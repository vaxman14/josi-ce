using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// What Josi has cost you this month, said honestly: tokens, provider
  /// charges and a local estimate are separate numbers, never blended.
  public sealed class UsageView : SectionView {
    Wire status = Wire.Null;
    public UsageView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() { var api = Api; var stamp = Stamp; var s = await api.Request("/llm/status"); if (Current(stamp)) status = s; }
    static UIElement Tile(string title, string value, string caption) {
      return new Border { Background = Ui.Raised, CornerRadius = new CornerRadius(12), Padding = new Thickness(16), Margin = new Thickness(0, 0, 12, 12), MinWidth = 200,
        Child = Ui.Stack(4, Ui.Caption(title), Ui.T(value, 24, FontWeights.SemiBold), Ui.Caption(caption)) };
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Usage", null, Ui.Pill("Refresh", StartLoad)));
      if (status.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Usage has not loaded."), 0); return page; }
      var usage = status["usage"]; var cap = status["cap"];
      Ui.Add(page, Ui.Secondary("Your own usage this month (" + usage["month"].Text + ")."), 0);
      Ui.Add(page, Ui.Wrap(Tile("Tokens", usage["totalTokens"].Integer.ToString("N0"), usage["calls"].Integer + " request" + (usage["calls"].Integer == 1 ? "" : "s")),
        Tile("Provider charges", "$" + usage["reportedCostUsd"].Number.ToString("0.00"), "As reported by the provider"),
        Tile("Estimated", "$" + usage["estimatedCostUsd"].Number.ToString("0.00"), "Worked out locally, not a bill")), 0);
      if (usage["selfHostedCalls"].Integer > 0)
        Ui.Add(page, Ui.Caption(usage["selfHostedCalls"].Integer + " request(s) to a model on your own hardware: $0 provider charge. Hardware and electricity are not counted."), 0);
      Ui.Add(page, Ui.CardBox("Budget", Ui.Row(10, ModelText.Pill(Wires.Words(cap["status"].Text), cap["allowed"].Flag), Ui.Secondary(cap["message"].Text))), 0);
      foreach (var n in usage["notes"].List) Ui.Add(page, Ui.Caption(n.Text), 0);
      return page;
    }
  }

  /// Administrator: installation readiness, activity and the problems that
  /// need action, with a link to the section that fixes each one.
  public sealed class OverviewView : SectionView {
    Wire data = Wire.Null;
    readonly List<string[]> checks = new List<string[]>();  // label, state, detail, section
    DateTime? checkedAt;
    public OverviewView(AppModel model, Window owner) : base(model, owner) { }
    async Task<Wire> Try(JosiApi api, string route) { try { return await api.Request(route); } catch (JosiException) { return null; } }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var assistant = await Try(api, "/admin/assistant"); var launch = await Try(api, "/admin/launch-checklist"); var llm = await Try(api, "/admin/llm");
      var storage = await Try(api, "/storage/admin/policy"); var backups = await Try(api, "/ops/admin/backups"); var channels = await Try(api, "/admin/channels");
      var voice = await Try(api, "/admin/voice-box"); var vault = await Try(api, "/admin/vault");
      if (!Current(stamp)) return;
      data = assistant ?? Wire.Null; checks.Clear();
      checks.Add(new[] { "API and database", assistant != null ? "working" : "unavailable", assistant != null ? "The application can read installation data." : "The core installation check failed.", "server" });
      var primary = llm == null ? Wire.Null : llm["primary"];
      checks.Add(new[] { "AI model", llm == null ? "unavailable" : primary.IsNull ? "unconfigured" : primary["active"].Flag && primary["probedAt"].Text.Length > 0 ? "working" : "attention",
        llm == null ? "Model status could not be read." : primary.IsNull ? "Choose and test a model before using Josi." : primary["active"].Flag ? "The active model passed its readiness test." : "The selected model still needs a successful test.", "models" });
      checks.Add(new[] { "Storage", storage != null ? "working" : "unavailable", storage != null ? "Storage policy is available." : "Storage settings could not be read.", "storage" });
      var completed = backups != null && backups["backups"].List.Any(b => b["state"].Text == "complete");
      checks.Add(new[] { "Backups", backups == null ? "unavailable" : completed ? "working" : "unconfigured", backups == null ? "Backup history could not be read." : completed ? "At least one backup completed." : "Backups are optional and none have been created.", "backups" });
      var vs = vault == null ? Wire.Null : vault["status"];
      checks.Add(new[] { "Master Vault", vault == null ? "unavailable" : !vs["initialized"].Flag ? "unconfigured" : vs["locked"].Flag || vs["recentFailures"].Integer > 0 ? "attention" : "working",
        vault == null ? "Vault health could not be read." : !vs["initialized"].Flag ? "Initialize the Master Vault and save its recovery key offline." : vs["locked"].Flag ? "The Master Vault is locked; credential jobs are stopped." : vs["recentFailures"].Integer > 0 ? vs["recentFailures"].Integer + " credential jobs were blocked in the last 24 hours." : "The Master Vault is available.", "vault" });
      var list = channels == null ? new List<Wire>() : channels["channels"].List;
      checks.Add(new[] { "Channels and connections", channels == null ? "unavailable" : list.Any(c => c["enabled"].Flag && c["probeOk"].Flag) ? "working" : list.Any(c => c["configured"].Flag) ? "attention" : "unconfigured",
        channels == null ? "Channel status could not be read." : list.Any(c => c["enabled"].Flag && c["probeOk"].Flag) ? "At least one channel is enabled and tested." : list.Any(c => c["configured"].Flag) ? "A configured channel still needs a successful test or enabling." : "No optional messaging channel is configured.", "channels" });
      checks.Add(new[] { "Voice Box", voice == null ? "unavailable" : !voice["helperAvailable"].Flag || voice["phase"].Text == "absent" ? "unconfigured" : voice["healthy"].Flag && voice["verified"].Flag ? "working" : "attention",
        voice == null ? "Voice Box status could not be read." : voice["healthy"].Flag && voice["verified"].Flag ? "Voice Box is installed, verified and healthy." : !voice["helperAvailable"].Flag || voice["phase"].Text == "absent" ? "Voice Box is optional and not installed." : "Voice Box is installed but not ready.", "voice-box" });
      checks.Add(new[] { "Security and setup", launch == null ? "unavailable" : launch["complete"].Flag ? "working" : launch["reminders"].List.Count > 0 ? "attention" : "unconfigured",
        launch == null ? "Setup requirements could not be read." : launch["complete"].Flag ? "The getting-started checklist is complete." : launch["progress"]["done"].Integer + " of " + launch["progress"]["total"].Integer + " getting-started items are settled.", "workspace" });
      checkedAt = DateTime.Now;
    }
    static string Label(string state) { return state == "working" ? "Working" : state == "attention" ? "Needs attention" : state == "unavailable" ? "Unavailable" : "Not configured"; }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Overview", "Installation readiness, activity, and problems that need action.", Ui.Pill("Check Again", StartLoad)));
      if (checkedAt.HasValue) Ui.Add(page, Ui.Caption("Last checked " + checkedAt.Value.ToString("g")), 0);
      if (!data.IsNull) {
        var counts = data["counts"];
        Ui.Add(page, Ui.Wrap(new[] { new[] { "Conversations", "threads" }, new[] { "Messages", "messages" }, new[] { "Tasks", "tasks" }, new[] { "Open", "openTasks" } }
          .Select(p => (UIElement)new Border { Background = Ui.Raised, CornerRadius = new CornerRadius(12), Padding = new Thickness(16), Margin = new Thickness(0, 0, 12, 12), MinWidth = 150,
            Child = Ui.Stack(2, Ui.Caption(p[0]), Ui.T(counts[p[1]].Integer.ToString("N0"), 24, FontWeights.SemiBold)) }).ToArray()), 0);
      }
      var list = Ui.Stack(8);
      foreach (var c in checks) {
        var section = c[3];
        list.Children.Add(Ui.Spread(Ui.Stack(2, Ui.T(c[0], 14, FontWeights.Medium), Ui.Caption(c[2])),
          Ui.Row(8, ModelText.Pill(Label(c[1]), c[1] == "working"), Ui.Pill("Review", () => { model.Section = section; }))));
      }
      Ui.Add(page, Ui.CardBox("System checkup", list), 0);
      var order = new Dictionary<string, int> { { "attention", 0 }, { "unavailable", 1 }, { "unconfigured", 2 }, { "working", 3 } };
      var recommendations = checks.Where(c => c[1] != "working" && (c[1] != "unconfigured" || c[0] == "AI model" || c[0] == "Security and setup")).OrderBy(c => order[c[1]]).ToList();
      Ui.Add(page, Ui.CardBox("Recommendations", recommendations.Count == 0 ? (UIElement)Ui.T("No essential problems found.", 14, null, Ui.Green)
        : Ui.Stack(6, recommendations.Select((c, i) => (UIElement)Ui.Stack(2, Ui.T((i + 1) + ". Fix " + c[0].ToLowerInvariant(), 14, FontWeights.Medium), Ui.Caption(c[2]))).ToArray())), 0);
      if (!data.IsNull) {
        var m = data["metrics"];
        Ui.Add(page, Ui.CardBox("How reliably work completes", Ui.Secondary("Interrupt rate " + Math.Round(m["interrupt_rate"].Number * 100) + "%. Correction rate " + Math.Round(m["correction_rate"].Number * 100) + "% across " + m["reviewed"].Integer + " reviewed task(s).")), 0);
        var people = Ui.Stack(6, Ui.Spread(Ui.Caption("Person"), Ui.Caption("Conversations · Tasks")));
        foreach (var u in data["perUser"].List) people.Children.Add(Ui.Spread(Ui.T(u["username"].Text), Ui.T(u["threads"].Integer + " · " + u["tasks"].Integer)));
        Ui.Add(page, Ui.CardBox("Activity per person", people), 0);
      }
      return page;
    }
  }
}
