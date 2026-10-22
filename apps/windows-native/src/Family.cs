using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Family: Parental Controls as the two people in it see it. The server
  /// decides which reading this is: a parent sees the accounts they look
  /// after; a child sees exactly what is being looked at. Everything here
  /// says plainly what it controls (access to Josi) and what it does not (a
  /// device, other apps, emergencies). The server's own routes carry the
  /// safeguards: password plus authenticator code to change who looks after
  /// whom, the password again to change hours, and a written record every
  /// time a parent opens a conversation.
  public sealed class FamilyView : SectionView {
    static readonly string[] Days = { "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" };
    Wire overview = Wire.Null; bool absent;
    // Per-child editing state survives redraws.
    readonly Dictionary<string, string> tabs = new Dictionary<string, string>();
    readonly Dictionary<string, Wire> controlDrafts = new Dictionary<string, Wire>();
    readonly Dictionary<string, List<Wire>> conversations = new Dictionary<string, List<Wire>>();
    readonly Dictionary<string, Wire> openConversation = new Dictionary<string, Wire>();
    readonly Dictionary<string, Wire> usage = new Dictionary<string, Wire>();
    readonly Dictionary<string, Control> fields = new Dictionary<string, Control>();
    bool adding; string inviteLink = "";
    public FamilyView(AppModel model, Window owner) : base(model, owner) { }

    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      try { var o = await api.Request("/parental/overview"); if (Current(stamp)) { overview = o; absent = false; } }
      catch (JosiException e) { if (e.Status == 404 && Current(stamp)) { absent = true; overview = Wire.Null; } else throw; }
    }
    static string AccessLabel(string reason) {
      switch (reason) {
        case "allowed": return "Josi is available now"; case "outside_schedule": return "Outside the agreed hours"; case "daily_limit": return "Today's time is used up";
        case "not_managed": return "Not a managed account"; case "module_inert": return "Parental Controls is not active here"; default: return Wires.Words(reason);
      }
    }
    static string AccessDetail(string reason) {
      switch (reason) {
        case "outside_schedule": return "Josi will answer again at the next time in the timetable.";
        case "daily_limit": return "The daily limit has been reached. It starts again tomorrow, in this account's own time zone.";
        case "module_inert": return "Without a licence the hours and limits do not apply and nobody can see these conversations.";
        default: return null;
      }
    }
    static string Clock(long minute) { return (minute / 60 % 24).ToString("00") + ":" + (minute % 60).ToString("00"); }
    static long MinutesOf(string value) { var parts = value.Split(':'); int h, m; int.TryParse(parts[0], out h); if (parts.Length < 2 || !int.TryParse(parts[1], out m)) m = 0; return h * 60 + m; }
    static string Describe(string kind) {
      switch (kind) {
        case "parental.conversation_read": return "Read one of your conversations"; case "parental.conversations_listed": return "Looked at the list of your conversations";
        case "parental.usage_viewed": return "Looked at how much you have used Josi"; case "parental.controls_updated": return "Changed your hours or your daily limit";
        case "parental.link_created": return "Set this account up"; case "parental.link_ended": return "Stopped looking after this account"; default: return kind;
      }
    }
    UIElement Beta() {
      return new Border { Background = Ui.OrangeFaint, BorderBrush = Ui.Orange, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(14),
        Child = Ui.Stack(4, Ui.T("BETA: do not rely on these controls for a child's safety.", 14, FontWeights.SemiBold, Ui.Orange),
          Ui.Caption("This feature is experimental and may fail, be delayed or behave unexpectedly. It controls only access to Josi; it cannot supervise a device, block other apps or websites, provide emergency monitoring, or replace active adult supervision and device-level parental controls. Verify important restrictions yourself.")) };
    }
    Control Field(string key, string placeholder = "", string value = "", bool secret = false) {
      Control control;
      if (!fields.TryGetValue(key, out control)) fields[key] = control = secret ? (Control)Ui.Secret(placeholder) : Ui.Input(placeholder, value);
      Ui.Detach(control);
      return control;
    }
    string Text(string key) { Control c; if (!fields.TryGetValue(key, out c)) return ""; var box = c as TextBox; if (box != null) return box.Text.Trim(); var p = c as PasswordBox; return p == null ? "" : p.Password; }
    void Clear(string key) { Control c; if (fields.TryGetValue(key, out c)) { var p = c as PasswordBox; if (p != null) p.Clear(); var box = c as TextBox; if (box != null) box.Text = ""; } }

    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Family", null, Ui.Pill("Refresh", StartLoad)), Beta());
      if (absent) {
        Ui.Add(page, Ui.CardBox("Parental Controls is not part of this installation",
          Ui.Secondary("It is a paid module. Until somebody activates a licence for it, nothing here exists: no account is managed, no conversation is visible to anybody else, and no timetable applies."),
          model.IsAdministrator ? Ui.Pill("Open Parental Controls (licence)", () => model.Section = "parental") : Ui.Caption("Whoever administers this installation can add it.")), 0);
        return page;
      }
      if (overview.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "The Family page has not loaded."), 0); return page; }
      if (overview["role"].Text == "child") ChildView(page); else ParentView(page);
      Ui.Add(page, Note(), 0);
      return page;
    }

    // ------------------------------------------------------------- the child
    void ChildView(StackPanel page) {
      var child = overview["child"]; var honesty = overview["honesty"];
      var can = Ui.Stack(3, Ui.T("They can", 14, FontWeights.SemiBold)); foreach (var line in child["canSee"].List) can.Children.Add(Ui.Caption("• " + line.Text));
      var cannot = Ui.Stack(3, Ui.T("They cannot", 14, FontWeights.SemiBold)); foreach (var line in child["cannotSee"].List) cannot.Children.Add(Ui.Caption("• " + line.Text));
      var columns = new Grid(); columns.ColumnDefinitions.Add(new ColumnDefinition()); columns.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) }); columns.ColumnDefinitions.Add(new ColumnDefinition());
      Grid.SetColumn(cannot, 2); columns.Children.Add(can); columns.Children.Add(cannot);
      Ui.Add(page, Ui.CardBox(child["guardian"].Text + " looks after this account",
        Ui.Secondary("This is not hidden from you, and it is not meant to be. Here is exactly what that means, so you are never guessing."), columns), 0);
      var access = child["access"]; var controls = child["controls"];
      var now = new List<UIElement> { Ui.Row(8, ModelText.Pill(AccessLabel(access["reason"].Text), access["allowed"].Flag),
          access["opensAgain"].Text.Length > 0 ? ModelText.Pill("Back at " + access["opensAgain"].Text, Ui.Muted) : null),
        Ui.Caption(AccessDetail(access["reason"].Text) ?? honesty["minutes"].Text),
        Ui.T("Used today: " + child["usedMinutesToday"].Integer + " minute" + (child["usedMinutesToday"].Integer == 1 ? "" : "s")
          + (controls["dailyLimitMinutes"].IsNumber ? " of " + controls["dailyLimitMinutes"].Integer : " (no daily limit is set)")) };
      if (controls["scheduleEnabled"].Flag) now.Add(Timetable(controls["windows"].List));
      Ui.Add(page, Ui.CardBox("Right now", now.ToArray()), 0);
      var looked = new List<UIElement> { Ui.Caption("Every time " + child["guardian"].Text + " opened one of your conversations, or changed your hours, it is written down here. Supervision you can see is different from being watched.") };
      if (child["activity"].List.Count == 0) looked.Add(Ui.Caption("Nothing yet."));
      foreach (var entry in child["activity"].List) looked.Add(Ui.Spread(Ui.T(Describe(entry["kind"].Text), 13.5), Ui.Caption(Wires.Date(entry["at"].Text))));
      Ui.Add(page, Ui.CardBox("When they looked", looked.ToArray()), 0);
      Ui.Add(page, Honesty(honesty), 0);
    }
    static UIElement Timetable(List<Wire> windows) {
      if (windows.Count == 0) return Ui.Caption("No hours are set, so Josi does not answer.");
      var list = Ui.Stack(2);
      foreach (var w in windows) list.Children.Add(Ui.Caption(Days[(int)w["weekday"].Integer % 7] + ": " + Clock(w["startMinute"].Integer) + " to " + Clock(w["endMinute"].Integer % 1440)));
      return list;
    }
    static UIElement Honesty(Wire honesty) {
      return Ui.CardBox("What this does, and what it does not", Ui.Caption(honesty["scope"].Text), Ui.Caption(honesty["notDevice"].Text), Ui.Caption(honesty["minutes"].Text), Ui.Caption(honesty["admin"].Text));
    }

    // ------------------------------------------------------------ the parent
    void ParentView(StackPanel page) {
      var children = overview["children"].List;
      Ui.Add(page, Honesty(overview["honesty"]), 0);
      if (children.Count == 0) Ui.Add(page, Ui.CardBox("You are not looking after any accounts",
        Ui.Secondary("Adding a child creates a new account here and links it to yours. They are told, on their own Family page, exactly what you can see.")), 0);
      foreach (var child in children) Ui.Add(page, ChildCard(child), 0);
      Ui.Add(page, AddChild(children.Count >= (int)Math.Max(1, overview["maxChildren"].Integer)), 0);
    }
    UIElement AddChild(bool atCeiling) {
      if (atCeiling) return Ui.CardBox("Add a child", Ui.Secondary("You are looking after as many accounts as one account may. Ending a relationship frees a place."));
      var items = new List<UIElement> { Ui.Secondary("This creates a new account and links it to yours. There is deliberately no way to take over an account that already exists here: somebody else's account cannot become a managed one without them being asked.") };
      if (!overview["secondFactorReady"].Flag) items.Add(Ui.T("First, turn on the authenticator sign-in for your own account, under Your Settings. Looking after somebody else's conversations should cost more than one secret.", 14));
      else if (!adding) items.Add(Ui.Pill("Add a Child", () => { adding = true; Render(); }, true));
      else {
        items.Add(Ui.Field("Username", Field("child.username", "Username")));
        items.Add(Ui.Field("Email address", Field("child.email", "Email address")));
        items.Add(Ui.Field("What to call them", Field("child.name", "Display name")));
        items.Add(Authority("create", "Confirm and Create the Account", async api => {
          var created = await api.Request("/parental/children", "POST", Wires.O("username", Text("child.username"), "email", Text("child.email"), "displayName", Text("child.name"), "timezone", TimeZones.Local()));
          inviteLink = created["inviteLink"].Text; adding = false; Clear("child.username"); Clear("child.email"); Clear("child.name");
          note = created["note"].Text;
        }));
        items.Add(Ui.Pill("Cancel", () => { adding = false; Render(); }));
      }
      if (inviteLink.Length > 0) {
        items.Add(Ui.Field("Set-up link: open this on their device", Ui.Copyable(inviteLink, 13, null, true)));
        items.Add(Ui.Caption("The link sets their password once and then stops working. Their Family page will show them what you can see."));
      }
      return Ui.CardBox("Add a child", items.ToArray());
    }
    /// Password and authenticator code together, which is what the server
    /// asks for before a relationship is created or ended.
    UIElement Authority(string key, string label, Func<JosiApi, Task> then) {
      var password = Field("authority." + key + ".password", "Your password", "", true);
      var code = Field("authority." + key + ".code", "Six-digit code");
      return new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(14), Child = Ui.Stack(10,
        Ui.Caption("Changing who looks after whom needs your password and a code from your authenticator, together. A signed-in app on its own is not enough."),
        Ui.Field("Your password", password), Ui.Field("Six-digit code", code),
        Ui.Pill(label, () => {
          var secret = Text("authority." + key + ".password"); var digits = Text("authority." + key + ".code"); Clear("authority." + key + ".password");
          if (secret.Length == 0 || digits.Length == 0) { model.Error = "Enter your password and the code from your authenticator."; model.Notify(); return; }
          Perform(async (api, stamp) => {
            model.Activity = "Checking your password and code…"; model.Notify();
            try { await api.Request("/parental/authority", "POST", Wires.O("password", secret, "code", digits)); Clear("authority." + key + ".code"); await then(api); }
            finally { model.Activity = ""; }
          });
        }, true)) };
    }
    UIElement ChildCard(Wire child) {
      var id = child.Id; var label = child["displayName"].Text.Length > 0 ? child["displayName"].Text : child["username"].Text;
      string tab; if (!tabs.TryGetValue(id, out tab)) tab = "controls";
      var header = Ui.Spread(Ui.Stack(2, Ui.Headline(label), Ui.Caption(child["username"].Text + " · looked after since " + Wires.Date(child["since"].Text))),
        Ui.Row(8, ModelText.Pill(AccessLabel(child["access"]["reason"].Text), child["access"]["allowed"].Flag),
          ModelText.Pill(child["usedMinutesToday"].Integer + " min today" + (child["controls"]["dailyLimitMinutes"].IsNumber ? " of " + child["controls"]["dailyLimitMinutes"].Integer : ""), Ui.Muted)));
      var picker = Ui.Segments(Ui.Options("controls", "Hours and limit", "conversations", "Conversations", "usage", "How much", "end", "Stop looking after"), tab, value => { tabs[id] = value; if (value == "conversations") LoadConversations(id); if (value == "usage") LoadUsage(id); Render(); });
      UIElement body;
      switch (tab) {
        case "conversations": body = Conversations(id); break;
        case "usage": body = Usage(id); break;
        case "end": body = End(child); break;
        default: body = Controls(child); break;
      }
      return Ui.CardBox(null, header, picker, body);
    }

    // ---------------------------------------------------------- hours & limit
    Wire Draft(Wire child) {
      Wire draft;
      if (!controlDrafts.TryGetValue(child.Id, out draft)) {
        var saved = child["controls"];
        draft = new Wire(Wires.O("timezone", saved.IsNull ? "UTC" : saved["timezone"].Text, "dailyLimitMinutes", saved.IsNull ? null : saved["dailyLimitMinutes"].Raw,
          "scheduleEnabled", !saved.IsNull && saved["scheduleEnabled"].Flag, "windows", saved.IsNull ? new List<object>() : saved["windows"].List.Select(w => w.Raw).ToList()));
        controlDrafts[child.Id] = draft;
      }
      return draft;
    }
    UIElement Controls(Wire child) {
      var id = child.Id; var draft = Draft(child); var map = (IDictionary<string, object>)draft.Raw;
      var timezone = Field("tz." + id, "America/Los_Angeles", draft["timezone"].Text);
      var limit = Field("limit." + id, "Blank for no limit", draft["dailyLimitMinutes"].IsNumber ? draft["dailyLimitMinutes"].Integer.ToString() : "");
      var schedule = Ui.Toggle("Only answer during set hours", draft["scheduleEnabled"].Flag);
      schedule.Click += delegate { map["scheduleEnabled"] = schedule.IsChecked == true; Render(); };
      var items = new List<UIElement> {
        Ui.Field("Their time zone (the day is cut here, not where the server is)", timezone),
        Ui.Field("Minutes a day, counted as minutes in which they sent something to Josi", limit),
        schedule };
      if (draft["scheduleEnabled"].Flag) {
        items.Add(Ui.Caption("A day with no hours is a day Josi does not answer. For a stretch that runs past midnight, set hours on both days."));
        var windows = draft["windows"].List;
        for (var weekday = 0; weekday < 7; weekday++) {
          var day = weekday; var window = windows.FirstOrDefault(w => w["weekday"].Integer == day);
          var on = Ui.Toggle(Days[day], window != null); on.Width = 130;
          on.Click += delegate {
            var rest = draft["windows"].List.Where(w => w["weekday"].Integer != day).Select(w => w.Raw).ToList();
            if (on.IsChecked == true) rest.Add(Wires.O("weekday", day, "startMinute", 16 * 60, "endMinute", 19 * 60));
            map["windows"] = rest.OrderBy(w => (long)((IDictionary<string, object>)w)["weekday"] is long ? (long)((IDictionary<string, object>)w)["weekday"] : Convert.ToInt64(((IDictionary<string, object>)w)["weekday"])).ToList();
            Render();
          };
          if (window == null) { items.Add(Ui.Row(10, on, Ui.Caption("Josi does not answer"))); continue; }
          var from = Field("from." + id + "." + day, "16:00", Clock(window["startMinute"].Integer)); from.Width = 90;
          var until = Field("until." + id + "." + day, "19:00", Clock(window["endMinute"].Integer % 1440)); until.Width = 90;
          items.Add(Ui.Row(10, on, from, Ui.Caption("to"), until));
        }
      }
      items.Add(Ui.Pill("Save", () => SaveControls(child), true));
      return Ui.Stack(12, items.ToArray());
    }
    void SaveControls(Wire child) {
      var id = child.Id; var draft = Draft(child);
      var windows = new List<object>();
      if (draft["scheduleEnabled"].Flag)
        foreach (var w in draft["windows"].List) {
          var day = w["weekday"].Integer;
          var start = Text("from." + id + "." + day); var end = Text("until." + id + "." + day);
          windows.Add(Wires.O("weekday", day, "startMinute", start.Length > 0 ? MinutesOf(start) : w["startMinute"].Integer, "endMinute", end.Length > 0 ? (MinutesOf(end) == 0 ? 1440 : MinutesOf(end)) : w["endMinute"].Integer));
        }
      var limitText = Text("limit." + id); long minutes;
      object limit = limitText.Length == 0 ? null : (long.TryParse(limitText, out minutes) ? (object)minutes : null);
      if (limitText.Length > 0 && limit == null) { model.Error = "Minutes a day must be a whole number, or blank."; model.Notify(); return; }
      var body = Wires.O("timezone", Text("tz." + id).Length > 0 ? Text("tz." + id) : "UTC", "dailyLimitMinutes", limit, "scheduleEnabled", draft["scheduleEnabled"].Flag, "windows", windows);
      Perform(async (api, stamp) => {
        try { await api.Request("/parental/children/" + api.Uuid(id) + "/controls", "PUT", body); }
        catch (JosiException e) {
          // The server asks for the password again for exactly this change: the
          // threat is somebody using the parent's own open laptop.
          if (e.Status != 401) throw;
          var password = Dialogs.AskPassword(owner, "Confirm your password to change this", e.Message, "Confirm and Save");
          if (password == null) return;
          await api.Request("/assistant/step-up", "POST", Wires.O("password", password));
          await api.Request("/parental/children/" + api.Uuid(id) + "/controls", "PUT", body);
        }
        controlDrafts.Remove(id);
        note = "Saved. It applies to their next message.";
      });
    }

    // ------------------------------------------------------- conversations
    void LoadConversations(string id) {
      if (conversations.ContainsKey(id)) return;
      Perform(async (api, stamp) => { var r = await api.Request("/parental/children/" + api.Uuid(id) + "/conversations"); if (Current(stamp)) conversations[id] = r["conversations"].List; }, false);
    }
    UIElement Conversations(string id) {
      var items = new List<UIElement> { Ui.Caption("Opening a conversation is written down, and they can see it on their own Family page. That is the deal this feature makes with both of you.") };
      List<Wire> list;
      if (!conversations.TryGetValue(id, out list)) { items.Add(Ui.Working("Loading their conversations…")); return Ui.Stack(10, items.ToArray()); }
      if (list.Count == 0) items.Add(Ui.Caption("Nothing here yet."));
      foreach (var c in list) {
        var threadId = c.Id;
        items.Add(Ui.Spread(Ui.Stack(1, Ui.T(c["title"].Text.Length > 0 ? c["title"].Text : "Untitled conversation", 14), Ui.Caption(c["messages"].Integer + " messages · " + Wires.Date(c["lastActivityAt"].Text))),
          Ui.Pill("Read", () => Perform(async (api, stamp) => { var r = await api.Request("/parental/children/" + api.Uuid(id) + "/conversations/" + api.Uuid(threadId)); if (Current(stamp)) { openConversation[id] = r; note = r["note"].Text; } }, false))));
      }
      Wire open;
      if (openConversation.TryGetValue(id, out open)) {
        var messages = Ui.Stack(8);
        foreach (var m in open["messages"].List)
          messages.Children.Add(Ui.Stack(1, Ui.Caption((m["direction"].Text == "in" ? "Them" : "Josi") + " · " + Wires.Date(m["createdAt"].Text)), Ui.Copyable(m["body"].Text, 13.5)));
        items.Add(new Border { BorderBrush = Ui.Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(12), Child = messages });
      }
      return Ui.Stack(10, items.ToArray());
    }

    // ---------------------------------------------------------------- usage
    void LoadUsage(string id) {
      if (usage.ContainsKey(id)) return;
      Perform(async (api, stamp) => { var r = await api.Request("/parental/children/" + api.Uuid(id) + "/usage?days=14"); if (Current(stamp)) usage[id] = r["usage"]; }, false);
    }
    UIElement Usage(string id) {
      Wire u;
      if (!usage.TryGetValue(id, out u)) return Ui.Working("Adding up the last two weeks…");
      var items = new List<UIElement> { Ui.T(u["totalMinutes"].Integer + " minutes over the last two weeks, across " + u["conversations"].Integer + " conversations and " + u["messagesSent"].Integer + " messages sent. Days are counted in " + u["timezone"].Text + ".") };
      var days = u["days"].List;
      if (days.Count == 0) items.Add(Ui.Caption("Nothing in this period."));
      var busiest = Math.Max(1, days.Count == 0 ? 1 : days.Max(d => d["minutes"].Integer));
      foreach (var day in days) {
        var bar = new Border { Background = Ui.Orange, CornerRadius = new CornerRadius(3), Height = 8, Width = Math.Max(2, 300.0 * day["minutes"].Integer / busiest), VerticalAlignment = VerticalAlignment.Center };
        var date = Ui.Caption(day["day"].Text); date.Width = 100;
        items.Add(Ui.Row(10, date, bar, Ui.Caption(day["minutes"].Integer + " min")));
      }
      return Ui.Stack(8, items.ToArray());
    }

    // ------------------------------------------------------------------ end
    UIElement End(Wire child) {
      var id = child.Id;
      return Ui.Stack(10,
        Ui.Caption("Their account stays and becomes an ordinary account here. You stop being able to see their conversations, and their hours and daily limit are removed. Nothing they wrote is deleted, and nothing of theirs is transferred to you."),
        Authority("end." + id, "Confirm and Stop Looking After", async api => {
          var r = await api.Request("/parental/children/" + api.Uuid(id), "DELETE", null);
          note = r["note"].Text.Length > 0 ? r["note"].Text : "Done.";
          tabs.Remove(id); controlDrafts.Remove(id);
        }));
    }
  }

  /// Administrator: the licence that unlocks Parental Controls, and nothing
  /// else. The administrator cannot see who looks after whom or read what a
  /// child says to Josi; that belongs to the family.
  public sealed class ParentalControlsView : SectionView {
    Wire view = Wire.Null; bool replacing;
    readonly TextBox token = Ui.Input("Paste the licence key you were sent", "", true);
    public ParentalControlsView(AppModel model, Window owner) : base(model, owner) { token.FontFamily = Ui.Mono; token.MinHeight = 70; }
    protected override async Task Load() { var api = Api; var stamp = Stamp; var v = await api.Request("/admin/licence"); if (Current(stamp)) view = v; }
    static string StateLabel(string state) {
      switch (state) {
        case "active": return "Licensed"; case "none": return "Not licensed"; case "expired": return "Expired"; case "wrong_installation": return "Issued to another installation";
        case "invalid": return "Not recognised"; case "unverifiable_build": return "This build cannot check licences"; default: return Wires.Words(state);
      }
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Parental Controls", "Parental controls are a licensed feature. This page is where the licence is activated and managed.", Ui.Pill("Refresh", StartLoad)));
      Ui.Add(page, new Border { Background = Ui.OrangeFaint, BorderBrush = Ui.Orange, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(14),
        Child = Ui.Stack(4, Ui.T("BETA: experimental and not suitable as a safety control.", 14, FontWeights.SemiBold, Ui.Orange),
          Ui.Caption("Do not trust or rely on this feature to protect a child. It controls only Josi, not the device, other apps, websites, location or emergencies. Use active adult supervision and proven device-level controls, and verify restrictions independently.")) }, 0);
      if (view.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "The licence has not loaded."), 0); return page; }
      var state = view["state"].Text; var licensed = state == "active";
      var items = new List<UIElement> { Ui.Row(10, ModelText.Pill(StateLabel(state), licensed ? Ui.Green : state == "none" ? Ui.Muted : Ui.Orange)), Ui.Secondary(view["detail"].Text) };
      var licence = view["licence"];
      if (!licence.IsNull) {
        items.Add(Ui.Caption("Issued to: " + licence["subject"].Text));
        items.Add(Ui.Caption("Covers: " + (licence["features"].List.Count > 0 ? string.Join(", ", licence["features"].List.Select(f => f.Text)) : "nothing")));
        items.Add(Ui.Caption("Expires: " + (licence["expiresAt"].Text.Length > 0 ? Wires.Date(licence["expiresAt"].Text) : "does not expire")));
        if (view["activatedAt"].Text.Length > 0) items.Add(Ui.Caption("Activated: " + Wires.Date(view["activatedAt"].Text)));
      }
      if (view["canActivate"].Flag && (!licensed || replacing)) {
        Ui.Detach(token);
        items.Add(Ui.Field("Licence key", token));
        items.Add(Ui.Caption("This is the key SOCAL RECEPTIONIST LLC sent you. It is checked against the publisher's signature before it is stored, so a key that is not genuine is never accepted."));
        items.Add(Ui.Wrap(Ui.Pill(licensed ? "Replace Licence" : "Activate Licence", () => {
            var key = token.Text.Trim(); if (key.Length == 0) { model.Error = "Paste the licence key first."; model.Notify(); return; }
            Perform(async (api, stamp) => { await api.Request("/admin/licence", "PUT", Wires.O("token", key)); token.Text = ""; replacing = false; note = "Licence saved."; });
          }, true), replacing ? Ui.Pill("Cancel", () => { replacing = false; token.Text = ""; Render(); }) : null));
      }
      if (licensed && !replacing) items.Add(Ui.Wrap(Ui.Pill("Replace Licence", () => { replacing = true; Render(); }),
        Ui.Danger("Deactivate", () => { if (Dialogs.Confirm(owner, "Deactivate the licence?", "Hours, limits and conversation access stop applying for every family here until a licence is activated again. Nothing is deleted.", "Deactivate")) Perform(async (api, stamp) => await api.Request("/admin/licence", "DELETE", null)); })));
      if (state == "wrong_installation" || state == "none") items.Add(Ui.Field("This installation's ID (needed to have the right licence issued)", Ui.Copyable(view["installationId"].Text, 13, null, true)));
      Ui.Add(page, Ui.CardBox("Licence", items.ToArray()), 0);
      var build = view["supportedBuild"];
      if (!build.IsNull) {
        var steps = new List<UIElement> { Ui.Secondary("Licences are verified against a key that " + build["publisher"].Text + " stamps into the build it publishes. This build has none, so it cannot check any licence; entering one here would not help. Your data is not affected by switching.") };
        var n = 1; foreach (var step in build["steps"].List) steps.Add(Ui.Caption((n++) + ". " + step.Text));
        steps.Add(Ui.Field("Build to use", Ui.Copyable(build["image"].Text, 13, null, true)));
        Uri docs; if (Uri.TryCreate(build["docs"].Text, UriKind.Absolute, out docs) && docs.Scheme == "https") steps.Add(Ui.Link("Installation guide", () => ModelText.Open(docs)));
        Ui.Add(page, Ui.CardBox("Install the supported build", steps.ToArray()), 0);
      }
      if (licensed) Ui.Add(page, Ui.CardBox("Manage parental controls",
        Ui.Secondary("The licence is active. Child accounts, schedules, daily limits, usage and conversation access are managed from the Family page, by each parent; you cannot see who is looking after whom or read what a child says to Josi."),
        Ui.Pill("Open Family", () => model.Section = "family")), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
  }
}
