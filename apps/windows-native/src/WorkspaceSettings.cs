using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Small per-PC app preferences, kept in %LOCALAPPDATA%\Josi\settings.json.
  /// Not secrets: those live in Windows Credential Manager or the server Vault.
  static class LocalSettings {
    static string File { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Josi",
      AppLinks.Testing ? "settings-test" + AppLinks.Instance + ".json" : "settings.json"); } }
    static Dictionary<string, object> Read() {
      try { var value = Wires.Parse(System.IO.File.ReadAllText(File)).Raw as Dictionary<string, object>; if (value != null) return value; } catch (Exception) { }
      return new Dictionary<string, object>();
    }
    public static string Get(string key, string fallback = "") { object value; return Read().TryGetValue(key, out value) && value is string ? (string)value : fallback; }
    public static void Set(string key, string value) {
      var all = Read(); all[key] = value;
      Directory.CreateDirectory(Path.GetDirectoryName(File));
      System.IO.File.WriteAllText(File, Wires.Serialize(all));
    }
  }

  /// Administrator: workspace name, time zone (automatic from Windows by
  /// default, or pinned to a zone you choose) and anonymous usage counts.
  public sealed class WorkspaceSettingsView : SectionView {
    Wire workspace = Wire.Null, telemetry = Wire.Null;
    readonly TextBox name = Ui.Input("Workspace name");
    readonly ComboBox zone;
    readonly List<KeyValuePair<string, string>> zones = TimeZones.All();
    string mode;
    public WorkspaceSettingsView(AppModel model, Window owner) : base(model, owner) {
      zone = Ui.Choice(zones.Select(z => new KeyValuePair<string, string>(z.Key, z.Value + "  (" + z.Key + ")")).ToList(), TimeZones.Local());
      mode = model.WorkspaceZoneMode;
    }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var w = await api.Request("/admin/workspace");
      Wire t; try { t = await api.Request("/ops/admin/telemetry"); } catch (JosiException) { t = Wire.Null; }
      if (!Current(stamp)) return;
      workspace = w["workspace"]; telemetry = t;
      if (!workspace.IsNull) {
        name.Text = workspace["name"].Text;
        var saved = workspace["timezone"].Text;
        if (zones.Any(z => z.Key == saved)) zone.SelectedValue = saved;
      }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Workspace", null, Ui.Pill("Refresh", StartLoad)));
      if (workspace.IsNull) {
        if (loading) { Ui.Add(page, Ui.Secondary("Loading…"), 0); return page; }
        Ui.Add(page, Ui.CardBox("No workspace yet", Ui.Secondary("This installation has no workspace record. Recover it from the administrator and deployment settings already saved here."),
          Ui.Pill("Recover Workspace", () => Perform(async (api, stamp) => await api.Request("/admin/workspace/recover", "POST", Wires.O())), true)), 0);
        return page;
      }
      Ui.Detach(name); Ui.Detach(zone);
      var items = new List<UIElement> { Ui.Field("Name", name), Ui.Headline("Time zone"),
        Ui.Segments(Ui.Options("auto", "Automatic from Windows", "pinned", "Pinned"), mode, v => { mode = v; Render(); }) };
      if (mode == "auto") items.Add(Ui.Caption("Follows this PC's Windows time zone: " + TimeZoneInfo.Local.DisplayName + " (" + TimeZones.Local() + "). Josi updates the workspace when Windows' zone changes, each time you open Josi here."));
      else { items.Add(zone); items.Add(Ui.Caption("Stays on this zone whatever Windows is set to.")); }
      items.Add(Ui.Caption("Saved on the server: " + workspace["timezone"].Text));
      items.Add(Ui.Pill("Save", () => {
        var tz = mode == "auto" ? TimeZones.Local() : Ui.Selected(zone);
        var body = Wires.O("name", name.Text.Trim(), "timezone", tz); var chosen = mode;
        Perform(async (api, stamp) => { var r = await api.Request("/admin/workspace", "PATCH", body); workspace = r["workspace"]; model.WorkspaceZoneMode = chosen; note = "Saved."; });
      }, true));
      Ui.Add(page, Ui.CardBox("Business profile", items.ToArray()), 0);
      if (!telemetry.IsNull) {
        var on = telemetry["enabled"].Flag;
        var t = new List<UIElement> { Ui.Secondary(telemetry["disclosure"].Text.Length > 0 ? telemetry["disclosure"].Text : "Optional anonymous usage counts. Never conversations, credentials or business content."),
          Ui.Row(10, ModelText.Pill(on ? "On" : "Off", on), Ui.Pill(on ? "Turn Off" : "Turn On", () => Perform(async (api, stamp) => await api.Request("/ops/admin/telemetry", "PUT", Wires.O("enabled", !on))))) };
        if (telemetry["last_sent_at"].Text.Length > 0) t.Add(Ui.Caption("Last sent " + Wires.Date(telemetry["last_sent_at"].Text) + " · " + telemetry["last_status"].Text));
        if (!telemetry["lastPayload"].IsNull) t.Add(new Disclosure("Exactly what was last sent", () => Ui.Copyable(telemetry["lastPayload"].Json, 12.5, null, true)));
        Ui.Add(page, Ui.CardBox("Anonymous usage counts", t.ToArray()), 0);
      }
      Ui.Add(page, Ui.CardBox("Name and identity", Ui.Caption("Josi CE is created and published by SOCAL RECEPTIONIST LLC. The code is licensed under the AGPL; you may modify and redistribute it. The Josi name and marks are separate from that licence: a modified version should carry your own identity. The full policy is in TRADEMARK.md.")), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
  }

  /// Administrator: what still has to be done on this installation. Every
  /// item comes from what the installation contains, except the master-key
  /// backup, which Josi cannot observe.
  public sealed class ChecklistView : SectionView {
    Wire data = Wire.Null;
    public ChecklistView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      try { await api.Request("/admin/launch-checklist/seen", "POST", Wires.O()); } catch (JosiException) { }
      var d = await api.Request("/admin/launch-checklist"); if (Current(stamp)) data = d;
    }
    static string Section(string href) {
      if (string.IsNullOrEmpty(href)) return null;
      var map = new[] { new[] { "backup", "backups" }, new[] { "model", "models" }, new[] { "people", "people" }, new[] { "user", "people" }, new[] { "mail", "mail-settings" }, new[] { "smtp", "mail-settings" },
        new[] { "connector", "connectors" }, new[] { "connection", "connections" }, new[] { "vault", "vault" }, new[] { "channel", "channels" }, new[] { "telegram", "channels" }, new[] { "voice", "voice-box" },
        new[] { "storage", "storage" }, new[] { "network", "network" }, new[] { "workspace", "workspace" }, new[] { "policy", "policy" }, new[] { "diagnostic", "server" }, new[] { "security", "account" }, new[] { "mfa", "account" } };
      foreach (var m in map) if (href.IndexOf(m[0], StringComparison.OrdinalIgnoreCase) >= 0) return m[1];
      return null;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Getting Started", null, Ui.Pill("Refresh", StartLoad)));
      if (data.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "The checklist has not loaded."), 0); return page; }
      var done = data["progress"]["done"].Integer; var total = data["progress"]["total"].Integer;
      Ui.Add(page, Ui.Secondary("Josi is installed. These are the things only you can do: " + done + " of " + total + " settled."), 0);
      Ui.Add(page, new ProgressBar { Height = 6, Maximum = Math.Max(1, total), Value = done }, 0);
      var reminders = data["reminders"].List;
      if (reminders.Count > 0) Ui.Add(page, Ui.CardBox("Do these before you rely on this installation", reminders.Select(r => (UIElement)Ui.T("• " + r["label"].Text)).ToArray()), 0);
      foreach (var g in new[] { new[] { "critical", "Protect this installation" }, new[] { "important", "Finish essential setup" }, new[] { "optional", "Optional capabilities" } }) {
        var items = data["items"].List.Where(i => i["severity"].Text == g[0]).ToList();
        if (items.Count == 0) continue;
        var settled = items.Count(i => i["state"].Text == "done" || i["state"].Text == "dismissed" || i["state"].Text == "unavailable");
        var attention = items.Any(i => i["state"].Text == "failed" || (g[0] == "critical" && i["state"].Text == "outstanding"));
        Ui.Add(page, new Disclosure(g[1] + " · " + settled + " of " + items.Count + " settled" + (attention ? " · needs attention" : ""), () => {
          var list = Ui.Stack(14);
          foreach (var item in items) {
            var key = item["key"].Text; var state = item["state"].Text; var section = Section(item["href"].Text);
            var row = Ui.Stack(3, Ui.Spread(Ui.T(item["label"].Text, 14, FontWeights.Medium), ModelText.Pill(state == "done" ? "Done" : state == "outstanding" ? "To do" : state == "failed" ? "Not working" : state == "dismissed" ? "Put aside" : "Not available here", state == "done")),
              Ui.Caption(item["why"].Text));
            if (item["href"].Text.Length == 0 && (state == "outstanding" || state == "failed") && item["insteadOfScreen"].Text.Length > 0) row.Children.Add(Ui.Caption(item["insteadOfScreen"].Text));
            if (item["detail"].Text.Length > 0) row.Children.Add(Ui.Caption(item["detail"].Text));
            var actions = Ui.Wrap();
            if (state == "outstanding" || state == "failed") {
              if (key == "master_key_backup") actions.Children.Add(Ui.Pill("I Have Copied It Somewhere Safe", () => Perform(async (api, stamp) => await api.Request("/admin/launch-checklist/master-key-backed-up", "POST", Wires.O())), true));
              else if (section != null) actions.Children.Add(Ui.Pill("Do This", () => { model.Section = section; }, true));
            }
            if (item["dismissible"].Flag && state == "outstanding") actions.Children.Add(Ui.Pill("Skip", () => Perform(async (api, stamp) => await api.Request("/admin/launch-checklist/dismiss/" + Uri.EscapeDataString(key), "POST", Wires.O()))));
            if (state == "dismissed") actions.Children.Add(Ui.Pill("Put It Back on the List", () => Perform(async (api, stamp) => await api.Request("/admin/launch-checklist/restore/" + Uri.EscapeDataString(key), "POST", Wires.O()))));
            row.Children.Add(actions);
            list.Children.Add(row);
          }
          return list;
        }, attention), 0);
      }
      Ui.Add(page, Ui.Caption("You can come back to this from the sidebar at any time. Nothing here expires."), 0);
      return page;
    }
  }

  /// Administrator: change LAN, public domain, reverse proxy, HTTPS and port
  /// settings through the server's protected maintenance controller, which
  /// previews the change, checks health at the new address and restores the
  /// previous configuration if it fails.
  public sealed class NetworkView : SectionView {
    readonly PasswordBox password = Ui.Secret("Your current administrator password");
    Wire launch = Wire.Null;
    public NetworkView(AppModel model, Window owner) : base(model, owner) { }
    protected override void OnLeave() { password.Clear(); }
    protected override Task Load() { return Task.CompletedTask; }
    protected override UIElement Build() {
      var page = Page(Ui.Heading("Network and Address", "Change LAN, public-domain, reverse-proxy, HTTPS and port settings without reinstalling Josi."));
      Ui.Detach(password);
      var items = new List<UIElement> { Ui.Secondary("Josi briefly opens a separate local controller because this connection is unavailable while the address changes. The controller previews the change, verifies health at the new address, and restores the previous configuration if it fails."),
        Ui.Field("Administrator password (used once to re-confirm; never saved)", password),
        Ui.Pill("Open Protected Maintenance", () => {
          if (password.Password.Length == 0) { model.Error = "Enter your current Josi administrator password."; model.Notify(); return; }
          var body = Wires.O("password", password.Password, "host", model.Api == null ? "localhost" : model.Api.Origin.Host); password.Clear();
          Perform(async (api, stamp) => {
            launch = await api.Request("/admin/maintenance/network/launch", "POST", body);
            Uri url; if (Uri.TryCreate(launch["url"].Text, UriKind.Absolute, out url) && (url.Scheme == "http" || url.Scheme == "https")) ModelText.Open(url);
          }, false);
        }, true) };
      if (!launch.IsNull) {
        items.Add(Ui.Secondary("Protected maintenance is ready in your browser. If it did not open, use this address:"));
        items.Add(Ui.Copyable(launch["url"].Text, 13, null, true));
        items.Add(Ui.T("Setup code: " + launch["code"].Text, 18, FontWeights.SemiBold));
        items.Add(Ui.Caption("The code works once and expires with the maintenance session."));
      }
      Ui.Add(page, Ui.CardBox("Open protected maintenance", items.ToArray()), 0);
      return page;
    }
  }
}
