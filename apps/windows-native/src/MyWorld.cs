using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// My World: everything about the person, in the Vault, fed by chat. The
  /// plain facts show at once; a secret field is set through a secure box and
  /// shown again only behind the person's password, on this screen, never in
  /// a conversation. The "Josi knows" list is the person's to correct.
  public sealed class MyWorldView : SectionView {
    Wire world = Wire.Null;
    string kindFilter = "all", addKind = "vehicle";
    bool adding;
    readonly PasswordBox password = Ui.Visible(Ui.Secret("Your Josi password"));
    readonly Dictionary<string, TextBox> addFields = new Dictionary<string, TextBox>();
    TextBox addLabel; TextBox noteBox;
    public MyWorldView(AppModel model, Window owner) : base(model, owner) { }
    protected override void OnLeave() { password.Clear(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var result = await api.Request("/my-world");
      if (!Current(stamp)) return;
      world = result;
    }
    Wire Spec(string kind) { return world.IsNull ? Wire.Null : world["kinds"].List.FirstOrDefault(k => k["kind"].Text == kind) ?? Wire.Null; }
    static string LabelOf(Wire spec, string key) {
      var field = spec["fields"].List.FirstOrDefault(f => f["key"].Text == key);
      if (field != null) return field["label"].Text;
      var date = spec["dates"].List.FirstOrDefault(d => d["key"].Text == key);
      return date != null ? date["label"].Text : Wires.Words(key);
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("My World", "Who am I? Everything about you, kept in your Vault. Josi fills it in from conversation; secrets never pass through her.",
        Ui.Row(8, Ui.Pill("Add…", () => { adding = !adding; Render(); }), Ui.Pill("Refresh", StartLoad))));
      if (world.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "Your World has not loaded."), 0); return page; }
      var unlocked = world["unlocked"].Flag;
      if (adding) Ui.Add(page, AddCard(), 20);
      var kinds = world["kinds"].List;
      var options = new List<string> { "all", "Everything" };
      foreach (var k in kinds) { options.Add(k["kind"].Text); options.Add(k["plural"].Text); }
      Ui.Add(page, Ui.Segments(Ui.Options(options.ToArray()), kindFilter, k => { kindFilter = k; Render(); }), 20);
      var items = world["items"].List.Where(i => kindFilter == "all" || i["kind"].Text == kindFilter).ToList();
      if (items.Count == 0) Ui.Add(page, Ui.CardBox("Nothing here yet", Ui.Secondary("Tell Josi about your life (\"I just bought a 2026 Ford Explorer\", \"Dana is my daughter\") or use Add. Secret fields, like a plate or a card number, are typed into a protected box, never into the chat.")), 20);
      foreach (var item in items) Ui.Add(page, ItemCard(item, unlocked), 20);
      Ui.Add(page, KnowsCard(), 20);
      Ui.Add(page, Note(), 20);
      return page;
    }
    UIElement AddCard() {
      var kinds = world["kinds"].List;
      var pairs = new List<string>();
      foreach (var k in kinds) { pairs.Add(k["kind"].Text); pairs.Add(k["label"].Text); }
      var kindPick = Ui.Choice(Ui.Options(pairs.ToArray()), addKind);
      kindPick.SelectionChanged += delegate { var chosen = Ui.Selected(kindPick); if (chosen.Length > 0 && chosen != addKind) { addKind = chosen; addFields.Clear(); addLabel = null; Render(); } };
      var spec = Spec(addKind);
      if (addLabel == null) addLabel = Ui.Visible(Ui.Input("Name, for example \"2026 Ford Explorer\" or \"Dana\""));
      var rows = new List<UIElement> { Ui.Field("What kind of thing", kindPick), Ui.Field("Name", Detach(addLabel)) };
      foreach (var f in spec["fields"].List.Where(f => !f["secret"].Flag)) {
        var key = f["key"].Text;
        if (!addFields.ContainsKey(key)) addFields[key] = Ui.Visible(Ui.Input(f["hint"].Text.Length > 0 ? f["hint"].Text : null));
        rows.Add(Ui.Field(f["label"].Text, Detach(addFields[key])));
      }
      foreach (var d in spec["dates"].List) {
        var key = "date:" + d["key"].Text;
        if (!addFields.ContainsKey(key)) addFields[key] = Ui.Visible(Ui.Input("YYYY-MM-DD"));
        rows.Add(Ui.Field(d["label"].Text, Detach(addFields[key])));
      }
      var secretNames = spec["fields"].List.Where(f => f["secret"].Flag).Select(f => f["label"].Text).ToList();
      if (secretNames.Count > 0) rows.Add(Ui.Caption("Secret fields (" + string.Join(", ", secretNames) + ") are set after saving, each in its own protected box."));
      rows.Add(Ui.Row(8, Ui.Pill("Save", SaveNew, true), Ui.Pill("Cancel", () => { adding = false; addFields.Clear(); addLabel = null; Render(); })));
      return Ui.CardBox("Add to your World", rows.ToArray());
    }
    static Control Detach(Control control) { var panel = control.Parent as Panel; if (panel != null) panel.Children.Remove(control); return control; }
    void SaveNew() {
      var label = addLabel == null ? "" : addLabel.Text.Trim();
      if (label.Length == 0) { model.Error = "Give it a name."; model.Notify(); return; }
      var fields = new Dictionary<string, object>(); var dates = new Dictionary<string, object>();
      foreach (var pair in addFields) {
        var value = pair.Value.Text.Trim(); if (value.Length == 0) continue;
        if (pair.Key.StartsWith("date:")) dates[pair.Key.Substring(5)] = value; else fields[pair.Key] = value;
      }
      var kind = addKind;
      Perform(async (api, stamp) => {
        await api.Request("/my-world/items", "POST", Wires.O("kind", kind, "label", label, "fields", fields, "dates", dates));
        adding = false; addFields.Clear(); addLabel = null; note = "Added " + label + " to your World.";
      });
    }
    UIElement ItemCard(Wire item, bool unlocked) {
      var id = item.Id; var spec = Spec(item["kind"].Text); var label = item["label"].Text;
      var lines = new List<UIElement> { Ui.Caption(spec["label"].Text) };
      var fields = item["fields"].Raw as IDictionary<string, object>;
      if (fields != null) foreach (var pair in fields) lines.Add(Ui.Spread(Ui.Caption(LabelOf(spec, pair.Key)), Ui.T(Convert.ToString(pair.Value) ?? "", 14)));
      var dates = item["dates"].Raw as IDictionary<string, object>;
      if (dates != null) foreach (var pair in dates) lines.Add(Ui.Spread(Ui.Caption(LabelOf(spec, pair.Key)), Ui.T(Convert.ToString(pair.Value) ?? "", 14)));
      var secretKeys = item["secretKeys"].List.Select(k => k.Text).ToList();
      var set = item["secretsSet"].List.Select(k => k.Text).ToList();
      foreach (var key in secretKeys) {
        var fieldKey = key; var fieldLabel = LabelOf(spec, key); var isSet = set.Contains(key);
        var actions = Ui.Row(6,
          isSet && unlocked ? Ui.Pill("Show", () => Reveal(id, fieldKey, fieldLabel, label)) : null,
          Ui.Pill(isSet ? "Replace…" : "Set…", () => SetSecret(id, fieldKey, fieldLabel, label)),
          isSet ? Ui.Danger("Clear", () => { if (Dialogs.Confirm(owner, "Clear " + fieldLabel + "?", "The saved value is removed from your World.", "Clear")) Perform(async (api, stamp) => { await api.Request("/my-world/items/" + api.Uuid(id) + "/secrets/" + Uri.EscapeDataString(fieldKey), "DELETE", null); }); }) : null);
        lines.Add(Ui.Spread(Ui.Caption(fieldLabel + (isSet ? " · set, secret" : " · not set")), actions));
      }
      if (secretKeys.Any(set.Contains) && !unlocked) lines.Add(UnlockRow());
      lines.Add(Ui.Caption("Updated " + Wires.Date(item["updatedAt"].Text)));
      lines.Add(Ui.Wrap(Ui.Danger("Remove…", () => {
        if (Dialogs.Confirm(owner, "Remove " + label + " from your World?", "Its facts, its secret fields and what Josi knows about it are removed.", "Remove"))
          Perform(async (api, stamp) => { await api.Request("/my-world/items/" + api.Uuid(id), "DELETE", null); note = "Removed " + label + "."; });
      })));
      return Automation.Group("josi.my-world.item", label, Ui.CardBox(label, lines.ToArray()));
    }
    UIElement UnlockRow() {
      return Ui.Row(8, Detach(password), Ui.Pill("Unlock for five minutes", () => {
        var secret = password.Password; password.Clear();
        if (secret.Length == 0) { model.Error = "Enter your password to show secret fields."; model.Notify(); return; }
        Perform(async (api, stamp) => { await api.Request("/vault/unlock", "POST", Wires.O("password", secret)); note = "Unlocked. Secret fields can be shown for five minutes."; });
      }));
    }
    void SetSecret(string id, string key, string fieldLabel, string itemLabel) {
      var value = Dialogs.AskSecret(owner, fieldLabel + " for " + itemLabel, "Typed here, sealed into your World. Josi never sees it, and it is shown again only on this page behind your password.", fieldLabel, "Save");
      if (value == null) return;
      Perform(async (api, stamp) => { await api.Request("/my-world/items/" + api.Uuid(id) + "/secrets/" + Uri.EscapeDataString(key), "PUT", Wires.O("value", value)); note = fieldLabel + " saved."; });
    }
    void Reveal(string id, string key, string fieldLabel, string itemLabel) {
      Perform(async (api, stamp) => {
        var result = await api.Request("/my-world/items/" + api.Uuid(id) + "/secrets/" + Uri.EscapeDataString(key) + "/reveal", "POST", Wires.O());
        if (!Current(stamp)) return;
        var value = result["value"].Text;
        owner.Dispatcher.Invoke(() => Dialogs.Reveal(owner, fieldLabel + " for " + itemLabel, value));
      }, false);
    }
    UIElement KnowsCard() {
      var lines = world["memory"].List;
      var rows = new List<UIElement> { Ui.Secondary("What Josi knows from your World, in her own words. She reads this every time you talk; only you change it, here or by asking. Secret values are never in it.") };
      if (lines.Count == 0) rows.Add(Ui.Caption("Nothing yet."));
      foreach (var line in lines) {
        var id = line.Id; var text = line["content"].Text;
        rows.Add(Ui.Spread(Ui.Copyable(text, 13.5), Ui.Danger("Forget", () => Perform(async (api, stamp) => { await api.Request("/my-world/memory/" + api.Uuid(id), "DELETE", null); }))));
      }
      if (noteBox == null) noteBox = Ui.Visible(Ui.Input("Something Josi should know, in a sentence"));
      rows.Add(Ui.Row(8, Detach(noteBox), Ui.Pill("Add", () => {
        var text = noteBox.Text.Trim(); if (text.Length < 3) return;
        Perform(async (api, stamp) => { await api.Request("/my-world/memory", "POST", Wires.O("content", text)); noteBox.Text = ""; });
      })));
      return Ui.CardBox("Josi knows", rows.ToArray());
    }
  }
}
