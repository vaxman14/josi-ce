using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Josi.Native {
  /// Administrator: what Josi may do on this hosting PC. Off by default; each
  /// permission is one exact scope (browser + profile + origin, folder, or
  /// application) with an approval mode. Emergency stop, pending actions and
  /// the activity log.
  public sealed class PcControlView : SectionView {
    static readonly List<KeyValuePair<string, string>> Modes = Ui.Options("never", "Never allow", "ask", "Ask every time", "task", "Allow for this task", "temporary", "Allow temporarily", "always", "Always allow for this exact scope");
    Wire state = Wire.Null;
    string action = "", mode = "ask";
    readonly TextBox target = Ui.Input("Exact scope"), application = Ui.Input("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), profile = Ui.Input("Default"), expires = Ui.Input("Local time, for example 2026-10-22 17:00");
    readonly ComboBox actionPick = new ComboBox(), taskPick = new ComboBox();
    readonly Dictionary<string, PasswordBox> passwords = new Dictionary<string, PasswordBox>();
    readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
    public PcControlView(AppModel model, Window owner) : base(model, owner) {
      actionPick.SelectionChanged += delegate { var catalog = state["catalog"].List; if (actionPick.SelectedIndex >= 0 && actionPick.SelectedIndex < catalog.Count) { action = catalog[actionPick.SelectedIndex]["action"].Text; target.Text = application.Text = ""; Render(); } };
      timer.Tick += delegate { if (owner.IsActive && !model.Busy) StartLoad(); };
      Loaded += delegate { timer.Start(); };
      refresh = () => { if (!state.IsNull) Render(); };
      BrowserBridge.Current.Changed += refresh;
    }
    readonly Action refresh;
    protected override void OnLeave() { timer.Stop(); BrowserBridge.Current.Changed -= refresh; foreach (var p in passwords.Values) p.Clear(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp; var s = await api.Request("/admin/pc-control");
      if (!Current(stamp)) return;
      state = s;
      var catalog = s["catalog"].List;
      actionPick.ItemsSource = catalog.Select(c => c["label"].Text).ToList();
      if (action.Length == 0 && catalog.Count > 0) action = catalog[0]["action"].Text;
      actionPick.SelectedIndex = catalog.FindIndex(c => c["action"].Text == action);
      taskPick.ItemsSource = s["tasks"].List.Select(t => t["name"].Text + " · " + Wires.Date(t["created_at"].Text)).ToList();
    }
    string Scope(Wire s) { return (s["application"].Text.Length > 0 ? s["application"].Text + " · " : "") + (s["profile"].Text.Length > 0 ? "Profile " + s["profile"].Text + " · " : "") + s["target"].Text; }
    string LabelOf(string a) { return state["catalog"].List.Where(c => c["action"].Text == a).Select(c => c["label"].Text).FirstOrDefault() ?? a; }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("PC Control", null, Ui.Pill("Refresh", StartLoad)));
      if (state.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading PC permissions…" : "PC permissions have not loaded."), 0); return page; }
      var enabled = state["enabled"].Flag;
      var master = Ui.Toggle("Allow Josi to control this PC", enabled);
      master.Click += delegate { var on = master.IsChecked == true; Perform(async (api, stamp) => await api.Request("/admin/pc-control/enabled", "PUT", Wires.O("enabled", on))); };
      Ui.Add(page, Ui.CardBox(null, Ui.Secondary(state["availability"].Text), master,
        Ui.Caption("Off by default. Turning this on grants no browser, folder or application access by itself. These permissions apply only to this PC and your account."),
        Ui.Danger("Stop Control and Revoke Temporary Access", () => { if (Dialogs.Confirm(owner, "Stop PC control now?", "Disables control, cancels active actions and revokes pending approvals and task or temporary grants. Completed changes cannot be undone. Permanent scope choices stay saved.", "Stop")) Perform(async (api, stamp) => await api.Request("/admin/pc-control/stop", "POST", Wires.O())); }),
        state["uac"].Text.Length > 0 ? Ui.Caption(state["uac"].Text) : null), 0);
      Ui.Add(page, BrowserCard(enabled), 0);
      var spec = state["catalog"].List.FirstOrDefault(c => c["action"].Text == action) ?? Wire.Null; var kind = spec["kind"].Text;
      foreach (var c in new Control[] { actionPick, target, application, profile, expires, taskPick }) Ui.Detach(c);
      var form = new List<UIElement> { Ui.Caption("Each browser executable, profile and origin needs its own permission. Folder choices apply to that exact folder; application choices to that exact executable. No wildcard or inherited grants."),
        Ui.Field("Action", actionPick) };
      if (!spec.IsNull) form.Add(Ui.Caption(spec["access"].Text + (spec["highRisk"].Flag ? " · Each exact action needs separate approval in every mode." : "")));
      form.Add(Ui.Field(kind == "browser" ? "Exact website origin (for example https://example.com)" : kind == "application" ? "Exact application .exe path" : kind == "folder" || kind == "command" ? "Exact local folder path" : kind == "secret" ? "Exact credential or item identifier" : "Exact software or settings scope", target));
      if (kind == "browser" || kind == "command") form.Add(Ui.Field("Exact " + (kind == "browser" ? "browser" : "command runner") + " .exe path", application));
      if (kind == "browser") form.Add(Ui.Field("Exact browser profile", profile));
      form.Add(Ui.Field("Approval mode", new ContentControl { Focusable = false, Content = Ui.Segments(Modes, mode, v => { mode = v; Render(); }) }));
      if (mode == "task") { form.Add(Ui.Field("Exact active Josi task", taskPick)); form.Add(Ui.Caption("Expires when the task ends, or after 24 hours, whichever comes first.")); }
      if (mode == "temporary") form.Add(Ui.Field("Expires at (your local time, within 24 hours)", expires));
      form.Add(Ui.Pill("Save Exact-Scope Permission", Save, true));
      form.Add(Ui.Caption("Deleting, submissions and messages, financial actions, credential access, installs, security changes and elevation always ask separately."));
      Ui.Add(page, Ui.CardBox("Choose one exact scope", form.ToArray()), 0);
      var policies = Ui.Stack(10);
      if (state["policies"].List.Count == 0) policies.Children.Add(Ui.Caption("No scopes granted. Unlisted scopes ask before each action while control is on."));
      foreach (var p in state["policies"].List) {
        var id = p.Id; var pspec = state["catalog"].List.FirstOrDefault(c => c["action"].Text == p["action"].Text) ?? Wire.Null;
        policies.Children.Add(Ui.Stack(3, Ui.Spread(Ui.T(LabelOf(p["action"].Text), 14, FontWeights.Medium), Ui.Pill("Revoke", () => Perform(async (api, stamp) => await api.Request("/admin/pc-control/policies/" + api.Uuid(id), "DELETE", null)))),
          Ui.Caption(Scope(p["scope"])), Ui.Caption(pspec["access"].Text + " · " + Modes.First(m => m.Key == p["mode"].Text).Value + (p["active"].Flag ? "" : " · expired or task ended")),
          p["expiresAt"].Text.Length > 0 ? Ui.Caption("Expires " + Wires.Date(p["expiresAt"].Text)) : null));
      }
      Ui.Add(page, Ui.CardBox("Saved scopes and temporary access", policies), 0);
      var pending = Ui.Stack(12);
      if (state["requests"].List.Count == 0) pending.Children.Add(Ui.Caption("No actions awaiting approval."));
      foreach (var q in state["requests"].List) {
        var id = q.Id; var high = q["highRisk"].Flag;
        PasswordBox box; if (!passwords.TryGetValue(id, out box)) passwords[id] = box = Ui.Secret("Your account password");
        Ui.Detach(box);
        var item = Ui.Stack(4, Ui.T(q["description"].Text, 14, FontWeights.Medium), Ui.Caption(q["access"].Text + (high ? " · High risk" : "")));
        foreach (var r in q["requirements"].List) item.Children.Add(Ui.Caption(LabelOf(r["action"].Text) + ": " + Scope(r["scope"])));
        item.Children.Add(Ui.Caption("Expires " + Wires.Date(q["expiresAt"].Text)));
        if (high) item.Children.Add(Ui.Field("Confirm your account password", box));
        item.Children.Add(Ui.Wrap(Ui.Pill("Approve This Exact Action Once", () => {
            if (high && box.Password.Length == 0) { model.Error = "Enter your password to approve a high-risk action."; model.Notify(); return; }
            var password = box.Password; box.Clear();
            Perform(async (api, stamp) => await api.Request("/admin/pc-control/requests/" + api.Uuid(id) + "/decision", "POST", Wires.O("approve", true, "password", password)));
          }, true),
          Ui.Pill("Deny", () => Perform(async (api, stamp) => await api.Request("/admin/pc-control/requests/" + api.Uuid(id) + "/decision", "POST", Wires.O("approve", false))))));
        pending.Children.Add(item);
      }
      Ui.Add(page, Ui.CardBox("Actions awaiting approval", pending), 0);
      var activity = Ui.Stack(6, Ui.Caption("Latest 100 attempts, decisions and outcomes. Form values, command output and credentials are omitted."));
      if (state["activity"].List.Count == 0) activity.Children.Add(Ui.Caption("No PC control activity."));
      foreach (var e in state["activity"].List)
        activity.Children.Add(Ui.Stack(2, Ui.Caption(Wires.Date(e["at"].Text)), Ui.T(e["kind"].Text + (e["description"].Text.Length > 0 ? ": " + e["description"].Text : ""), 13.5)));
      Ui.Add(page, new Disclosure("Activity log", () => activity), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    /// The browser extension: browsers you allowed, the attached tab, and a
    /// shortcut to let Josi read the attached site without asking each time.
    UIElement BrowserCard(bool enabled) {
      var bridge = BrowserBridge.Current; var items = new List<UIElement>();
      var asked = bridge.Discovered;
      if (asked != null) items.Add(Ui.Stack(6, Ui.T(asked.Browser + " asked to connect to Josi", 14, FontWeights.Medium),
        Ui.Caption(asked.Application + " · attaching " + asked.Url),
        Ui.Wrap(Ui.Pill("Allow This Browser", () => bridge.Allow(), true), Ui.Pill("Ignore", () => bridge.Ignore())),
        Ui.Caption("After allowing it, click the Josi extension in the browser and choose Attach this tab again.")));
      if (bridge.Attached) {
        var origin = bridge.AttachedOrigin;
        items.Add(Ui.Stack(6, Ui.T(bridge.AttachedBrowser + " tab attached: " + (bridge.AttachedTitle.Length > 0 ? bridge.AttachedTitle : origin), 14, FontWeights.Medium),
          Ui.Caption(origin + " · " + bridge.AttachedApplication + " · profile " + bridge.AttachedProfile),
          Ui.Wrap(origin.Length > 0 ? Ui.Pill("Always Let Josi Read This Site", () => Perform(async (api, stamp) => await api.Request("/admin/pc-control/policies", "PUT",
              Wires.O("action", "browser.view", "scope", Wires.O("kind", "browser", "target", origin, "application", bridge.AttachedApplication, "profile", bridge.AttachedProfile), "mode", "always")))) : null,
            Ui.Pill("Detach Tab", () => bridge.Disconnect()))));
        if (!enabled) items.Add(Ui.Caption("Turn on \"Allow Josi to control this PC\" above, or Josi cannot use the attached tab."));
      } else if (asked == null) items.Add(Ui.Caption("To let Josi use a browser tab: open the site in Chrome, Brave or Edge with the Josi extension installed, click the Josi icon and choose Attach this tab. Josi stays limited to that tab."));
      var allowed = bridge.Allowed();
      if (allowed.Count > 0) {
        var list = Ui.Stack(6, Ui.Caption("Allowed browsers"));
        foreach (var a in allowed) {
          var nativeProfileId = a["nativeProfileId"].Text;
          list.Children.Add(Ui.Spread(Ui.Caption(a["browser"].Text + " · " + a["application"].Text), Ui.Pill("Remove", () => bridge.Remove(nativeProfileId))));
        }
        items.Add(list);
      }
      items.Add(Ui.Caption("Reading a page asks first unless you allowed that site. Every click asks, with your password. Josi never types passwords or payment details."));
      return Ui.CardBox("Browser", items.ToArray());
    }
    void Save() {
      var spec = state["catalog"].List.FirstOrDefault(c => c["action"].Text == action); if (spec == null) return;
      var kind = spec["kind"].Text;
      var scope = Wires.O("kind", kind, "target", target.Text.Trim());
      if (kind == "browser" || kind == "command") scope["application"] = application.Text.Trim();
      if (kind == "browser") scope["profile"] = profile.Text.Trim();
      if (target.Text.Trim().Length == 0 || ((kind == "browser" || kind == "command") && application.Text.Trim().Length == 0) || (kind == "browser" && profile.Text.Trim().Length == 0)) { model.Error = "Fill in every part of the exact scope."; model.Notify(); return; }
      var body = Wires.O("action", action, "scope", scope, "mode", mode);
      if (mode == "task") { var tasks = state["tasks"].List; if (taskPick.SelectedIndex < 0) { model.Error = "Choose the task."; model.Notify(); return; } body["taskId"] = tasks[taskPick.SelectedIndex].Id; }
      if (mode == "temporary") {
        DateTime at; if (!DateTime.TryParse(expires.Text, CultureInfo.CurrentCulture, DateTimeStyles.AssumeLocal, out at)) { model.Error = "Enter when the access expires."; model.Notify(); return; }
        body["expiresAt"] = at.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
      }
      Perform(async (api, stamp) => await api.Request("/admin/pc-control/policies", "PUT", body));
    }
  }
}
