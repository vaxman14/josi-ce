using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Josi.Native {
  /// One view of the calendars you choose from all connected Google and
  /// Microsoft accounts: list, month, week and day, in a time zone you pick
  /// (Windows' own by default). Events are created and changed by the
  /// assistant with approval; this view reads them.
  public sealed class CalendarView : SectionView {
    List<Wire> sources = new List<Wire>(), events = new List<Wire>();
    readonly List<string> warnings = new List<string>();
    string view = "week";
    DateTime anchor = DateTime.Today;
    TimeZoneInfo zone = TimeZoneInfo.Local;
    readonly ComboBox zonePick = new ComboBox { Width = 320 };
    Wire detail = Wire.Null;
    public CalendarView(AppModel model, Window owner) : base(model, owner) {
      var zones = TimeZoneInfo.GetSystemTimeZones().ToList();
      zonePick.ItemsSource = zones.Select(z => z.DisplayName).ToList();
      zonePick.SelectedIndex = zones.FindIndex(z => z.Id == TimeZoneInfo.Local.Id);
      zonePick.SelectionChanged += delegate { if (zonePick.SelectedIndex >= 0) { zone = zones[zonePick.SelectedIndex]; StartLoad(); } };
    }
    protected override double PageWidth() { return double.PositiveInfinity; }
    List<DateTime> Days() {
      var first = anchor.Date; var count = view == "day" ? 1 : 7;
      if (view == "week") first = anchor.Date.AddDays(-(int)anchor.DayOfWeek);
      if (view == "month") { first = new DateTime(anchor.Year, anchor.Month, 1); first = first.AddDays(-(int)first.DayOfWeek); count = 42; }
      if (view == "list") count = 14;
      return Enumerable.Range(0, count).Select(i => first.AddDays(i)).ToList();
    }
    DateTimeOffset Utc(DateTime civil) { return new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(civil, DateTimeKind.Unspecified), zone), TimeSpan.Zero); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var s = await api.Request("/calendar/sources" + (refreshSources ? "?refresh=true" : ""));
      refreshSources = false;
      if (!Current(stamp)) return;
      sources = s["sources"].List; warnings.Clear();
      warnings.AddRange(s["discoveryErrors"].List.Select(e => e["error"].Text));
      var days = Days();
      var start = Utc(days[0]).ToString("o", CultureInfo.InvariantCulture); var end = Utc(days[days.Count - 1].AddDays(1)).ToString("o", CultureInfo.InvariantCulture);
      var e2 = await api.Request("/calendar/events?start=" + Uri.EscapeDataString(start) + "&end=" + Uri.EscapeDataString(end));
      if (!Current(stamp)) return;
      events = e2["events"].List;
      warnings.AddRange(e2["sourceErrors"].List.Select(e => e["error"].Text));
    }
    bool refreshSources;
    DateTime? Local(string value) {
      DateTimeOffset parsed;
      if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out parsed)) return null;
      return TimeZoneInfo.ConvertTime(parsed, zone).DateTime;
    }
    IEnumerable<Wire> On(DateTime day) {
      return events.Where(e => {
        if (e["start"].Text.Length == 0) return false;
        if (e["allDay"].Flag) {
          var s = e["start"].Text.Substring(0, 10); var en = e["end"].Text.Length >= 10 ? e["end"].Text.Substring(0, 10) : DateTime.Parse(s).AddDays(1).ToString("yyyy-MM-dd");
          var key = day.ToString("yyyy-MM-dd"); return string.CompareOrdinal(s, key) <= 0 && string.CompareOrdinal(en, key) > 0;
        }
        var start = Local(e["start"].Text); var end = Local(e["end"].Text.Length > 0 ? e["end"].Text : e["start"].Text) ?? start;
        return start.HasValue && start.Value < day.AddDays(1) && (end.Value > day || start.Value >= day);
      }).OrderBy(e => e["allDay"].Flag ? 0 : 1).ThenBy(e => e["start"].Text);
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Calendar", "One view of the calendars you choose from all your connected accounts.",
        Ui.Pill("Refresh Calendars", () => { refreshSources = true; StartLoad(); })));
      foreach (var w in warnings.Distinct()) Ui.Add(page, Ui.T(w, 13.5, null, Ui.Orange), 0);
      var title = view == "month" ? anchor.ToString("MMMM yyyy") : view == "day" ? anchor.ToString("D") : Days()[0].ToString("MMM d") + " – " + Days().Last().ToString("MMM d, yyyy");
      Ui.Detach(zonePick);
      Ui.Add(page, Ui.Spread(Ui.Row(8, Ui.Pill("Previous", () => Move(-1)), Ui.Pill("Today", () => { anchor = DateTime.Today; StartLoad(); }), Ui.Pill("Next", () => Move(1)), Ui.Headline(title)),
        Ui.Segments(Ui.Options("list", "List", "month", "Month", "week", "Week", "day", "Day"), view, v => { view = v; StartLoad(); })), 0);
      Ui.Add(page, Ui.Row(10, Ui.Caption("Time zone"), zonePick), 0);
      if (loading && events.Count == 0) { Ui.Add(page, Ui.Secondary("Loading…"), 0); }
      else {
        if (events.Count == 0) Ui.Add(page, Ui.Secondary("No events in this range."), 0);
        Ui.Add(page, view == "list" ? ListView() : view == "month" ? Month() : Columns(), 0);
      }
      if (!detail.IsNull) {
        var d = detail;
        Ui.Add(page, Ui.CardBox(d["title"].Text.Length > 0 ? d["title"].Text : "Untitled event",
          Ui.Caption("Calendar: " + d["sourceName"].Text + " · " + Wires.Capitalize(d["provider"].Text) + " · " + d["account"].Text),
          Ui.T("When: " + When(d)), d["location"].Text.Length > 0 ? Ui.T("Where: " + d["location"].Text) : null,
          d["organizer"].Text.Length > 0 ? Ui.Caption("Organizer: " + d["organizer"].Text) : null,
          d["attendees"].List.Count > 0 ? Ui.Caption("Attendees: " + string.Join(", ", d["attendees"].List.Select(a => a.Text.Length > 0 ? a.Text : a["email"].Text))) : null,
          d["description"].Text.Length > 0 ? Ui.Copyable(d["description"].Text, 13) : null,
          Ui.Pill("Close", () => { detail = Wire.Null; Render(); })), 0);
      }
      var list = Ui.Stack(6);
      if (sources.Count == 0) list.Children.Add(Ui.Caption("No calendar connection yet. Connect Google or Microsoft under Connections and turn on calendar reading."));
      foreach (var s in sources) {
        var id = s.Id; var on = s["selected"].Flag;
        var box = Ui.Toggle(s["name"].Text + "  ·  " + Wires.Capitalize(s["provider"].Text) + " · " + (s["account"].Text.Length > 0 ? s["account"].Text : s["connectionId"].Text), on);
        box.Click += delegate { Perform(async (api, stamp) => await api.Request("/calendar/sources/" + Uri.EscapeDataString(id), "PUT", Wires.O("selected", !on))); };
        var row = Ui.Row(10, Swatch(s["color"].Text), box);
        if (s["primary"].Flag) row.Children.Add(Ui.Caption("Primary"));
        if (s["writable"].Flag) row.Children.Add(s["writeDefault"].Flag ? (UIElement)Ui.Caption("Default for new events") :
          Ui.Link("Make default", () => Perform(async (api, stamp) => await api.Request("/calendar/sources/" + Uri.EscapeDataString(id), "PUT", Wires.O("writeDefault", true)))));
        list.Children.Add(row);
      }
      Ui.Add(page, Ui.CardBox("Calendars", list), 0);
      return page;
    }
    static UIElement Swatch(string color) {
      Brush brush = Ui.Orange;
      try { if (color.Length > 0) brush = (Brush)new BrushConverter().ConvertFromString(color); } catch (Exception) { }
      return new Border { Width = 12, Height = 12, CornerRadius = new CornerRadius(6), Background = brush, VerticalAlignment = VerticalAlignment.Center };
    }
    string Time(Wire e) {
      if (e["allDay"].Flag) return "All day";
      var start = Local(e["start"].Text); return start.HasValue ? start.Value.ToString("t") : "Unknown time";
    }
    string When(Wire e) {
      if (e["allDay"].Flag) return "All day " + e["start"].Text.Substring(0, Math.Min(10, e["start"].Text.Length));
      var s = Local(e["start"].Text); var en = Local(e["end"].Text);
      return (s.HasValue ? s.Value.ToString("f") : "Unknown") + " – " + (en.HasValue ? en.Value.ToString("t") : "Unknown") + " (" + zone.StandardName + ")";
    }
    UIElement Event(Wire e, bool compact) {
      var t = e["title"].Text.Length > 0 ? e["title"].Text : "Untitled event";
      var content = compact ? Ui.Stack(1, Ui.T(t, 12.5, FontWeights.Medium), Ui.Caption(Time(e)))
        : Ui.Stack(2, Ui.T(t, 14, FontWeights.Medium), Ui.Caption(Time(e) + " · " + e["sourceName"].Text + (e["location"].Text.Length > 0 ? " · " + e["location"].Text : "")));
      Brush accent = Ui.Orange;
      try { if (e["sourceColor"].Text.Length > 0) accent = (Brush)new BrushConverter().ConvertFromString(e["sourceColor"].Text); } catch (Exception) { }
      var button = new Button { Style = (Style)Ui.Resources["Plain"], HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(8, 5, 8, 5), Margin = new Thickness(0, 0, 0, 4),
        BorderBrush = accent, BorderThickness = new Thickness(4, 0, 0, 0), Background = Ui.Raised, Content = content };
      Ui.Name(button, t + ", " + Time(e), null);
      var source = e["sourceId"].Text; var id = e["eventId"].Text;
      button.Click += delegate { Perform(async (api, stamp) => {
        var r = await api.Request("/calendar/events/" + Uri.EscapeDataString(source) + "/" + Uri.EscapeDataString(id));
        var d = new Dictionary<string, object>((Dictionary<string, object>)r["event"].Raw);
        d["sourceName"] = e["sourceName"].Raw; d["account"] = e["account"].Raw; d["provider"] = e["provider"].Raw;
        detail = new Wire(d);
      }, false); };
      return button;
    }
    UIElement ListView() {
      var stack = Ui.Stack(14);
      foreach (var day in Days()) {
        var rows = On(day).ToList(); if (rows.Count == 0) continue;
        stack.Children.Add(Ui.Stack(6, new UIElement[] { Ui.Headline(day.ToString("dddd, MMM d")) }.Concat(rows.Select(e => Event(e, false))).ToArray()));
      }
      return stack;
    }
    UIElement Month() {
      var grid = new UniformGridish(7);
      foreach (var name in CultureInfo.CurrentCulture.DateTimeFormat.AbbreviatedDayNames) grid.Add(Ui.T(name, 12.5, FontWeights.SemiBold, Ui.Muted));
      foreach (var day in Days()) {
        var d = day;
        var cell = Ui.Stack(3, Ui.Link(day.Day + (day == DateTime.Today ? " · Today" : ""), () => { anchor = d; view = "day"; StartLoad(); }));
        foreach (var e in On(day).Take(4)) cell.Children.Add(Event(e, true));
        var more = On(day).Count() - 4; if (more > 0) cell.Children.Add(Ui.Caption("+" + more + " more"));
        grid.Add(new Border { MinHeight = 110, Padding = new Thickness(5), BorderBrush = Ui.Border, BorderThickness = new Thickness(0.5),
          Background = day.Month == anchor.Month ? Brushes.Transparent : Ui.Sidebar, Child = cell });
      }
      return grid.Panel;
    }
    UIElement Columns() {
      var days = Days();
      var grid = new Grid();
      foreach (var _ in days) grid.ColumnDefinitions.Add(new ColumnDefinition { MinWidth = 130 });
      for (var i = 0; i < days.Count; i++) {
        var day = days[i];
        var col = Ui.Stack(4, Ui.T(day.ToString("ddd d"), 13.5, FontWeights.SemiBold, day == DateTime.Today ? Ui.Orange : Ui.Text));
        var rows = On(day).ToList();
        if (rows.Count == 0) col.Children.Add(Ui.Caption("No events"));
        foreach (var e in rows) col.Children.Add(Event(e, days.Count > 1));
        var cell = new Border { Padding = new Thickness(6), BorderBrush = Ui.Border, BorderThickness = new Thickness(0.5), MinHeight = 320, Child = col };
        Grid.SetColumn(cell, i); grid.Children.Add(cell);
      }
      return grid;
    }
    void Move(int direction) {
      anchor = view == "month" ? anchor.AddMonths(direction) : anchor.AddDays(direction * (view == "day" ? 1 : view == "list" ? 14 : 7));
      StartLoad();
    }
    /// A simple fixed-column grid that grows by rows.
    sealed class UniformGridish {
      public readonly Grid Panel = new Grid(); readonly int columns; int count;
      public UniformGridish(int columns) { this.columns = columns; for (var i = 0; i < columns; i++) Panel.ColumnDefinitions.Add(new ColumnDefinition()); }
      public void Add(UIElement element) {
        var row = count / columns; if (row >= Panel.RowDefinitions.Count) Panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(element, row); Grid.SetColumn(element, count % columns); Panel.Children.Add(element); count++;
      }
    }
  }

  /// What the assistant scheduled for you: upcoming reminders (change the
  /// message or time, or cancel) and what happened to recent ones.
  public sealed class RemindersView : SectionView {
    List<Wire> upcoming = new List<Wire>(), recent = new List<Wire>();
    string editing = "";
    readonly TextBox message = Ui.Input("Message", "", true), due = Ui.Input("Due (for example 2026-10-22 09:30)");
    public RemindersView(AppModel model, Window owner) : base(model, owner) { }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp; var r = await api.Request("/assistant/reminders");
      if (Current(stamp)) { upcoming = r["upcoming"].List; recent = r["recent"].List; }
    }
    static string When(Wire r) {
      DateTimeOffset at;
      return DateTimeOffset.TryParse(r["due_at"].Text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out at) ? at.ToLocalTime().ToString("f") : r["due_at"].Text;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Reminders", "Ask Josi in a conversation to remind you of something; it appears here.", Ui.Pill("Refresh", StartLoad)));
      if (upcoming.Count == 0) Ui.Add(page, Ui.Secondary("No upcoming reminders."), 0);
      foreach (var r in upcoming) {
        var id = r.Id;
        var items = new List<UIElement> { Ui.T(r["body"].Text), Ui.Caption(When(r) + " · " + r["timezone"].Text) };
        if (editing == id) {
          Ui.Detach(message); Ui.Detach(due);
          items.Add(Ui.Field("Message", message)); items.Add(Ui.Field("Due, in your local time", due));
          items.Add(Ui.Wrap(Ui.Pill("Save", () => {
            DateTime local;
            if (!DateTime.TryParse(due.Text, CultureInfo.CurrentCulture, DateTimeStyles.AssumeLocal, out local)) { model.Error = "Enter a valid date and time."; model.Notify(); return; }
            var body = Wires.O("message", message.Text, "due_at", local.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture), "timezone", TimeZones.Local());
            Perform(async (api, stamp) => { await api.Request("/assistant/reminders/" + api.Uuid(id), "PUT", body); editing = ""; note = "Reminder changed."; });
          }, true), Ui.Pill("Cancel Editing", () => { editing = ""; Render(); })));
        } else {
          items.Add(Ui.Wrap(Ui.Pill("Change", () => {
            editing = id; message.Text = r["body"].Text;
            DateTimeOffset at; due.Text = DateTimeOffset.TryParse(r["due_at"].Text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out at) ? at.ToLocalTime().ToString("g") : "";
            Render();
          }), Ui.Pill("Cancel Reminder…", () => { if (Dialogs.Confirm(owner, "Cancel this reminder?", r["body"].Text, "Cancel Reminder")) Perform(async (api, stamp) => await api.Request("/assistant/reminders/" + api.Uuid(id) + "/cancel", "POST", Wires.O())); })));
        }
        Ui.Add(page, Ui.CardBox(null, items.ToArray()), 0);
      }
      if (recent.Count > 0) {
        var list = Ui.Stack(8);
        foreach (var r in recent) list.Children.Add(Ui.Spread(Ui.Stack(2, Ui.T(r["body"].Text), Ui.Caption(When(r))), ModelText.Pill(Wires.Words(r["status"].Text), r["status"].Text == "delivered")));
        Ui.Add(page, Ui.CardBox("Recent", list), 0);
      }
      Ui.Add(page, Note(), 0);
      return page;
    }
  }

  /// Your private contacts: added by hand or synced from Google and Outlook,
  /// with sync status, interval, stop and restart, and duplicate suggestions
  /// that are shown, never merged without you.
  public sealed class ContactsView : SectionView {
    List<Wire> contacts = new List<Wire>(), origins = new List<Wire>(), review = new List<Wire>();
    readonly TextBox name = Ui.Input("Name"), email = Ui.Input("Email"), phone = Ui.Input("Phone"), search = Ui.Input("Search contacts");
    static readonly List<KeyValuePair<string, string>> Intervals = Ui.Options("300", "Every 5 minutes", "900", "Every 15 minutes", "1800", "Every 30 minutes", "3600", "Every hour", "86400", "Once a day");
    public ContactsView(AppModel model, Window owner) : base(model, owner) { search.TextChanged += delegate { Render(); }; }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var c = await api.Request("/assistant/contacts");
      Wire o; try { o = await api.Request("/contacts/sync"); } catch (JosiException) { o = Wire.Null; }
      if (!Current(stamp)) return;
      contacts = c["contacts"].List; origins = o["origins"].List;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Contacts", "Private to you, like your conversations.", Ui.Pill("Refresh", StartLoad)));
      Ui.Detach(name); Ui.Detach(email); Ui.Detach(phone);
      Ui.Add(page, Ui.CardBox("Add a contact", Ui.Field("Name", name), Ui.Field("Email", email), Ui.Field("Phone", phone),
        Ui.Pill("Add Contact", () => {
          if (name.Text.Trim().Length == 0) { model.Error = "Enter a name."; model.Notify(); return; }
          var body = Wires.O("name", name.Text.Trim(), "email", email.Text.Trim(), "phone", phone.Text.Trim());
          Perform(async (api, stamp) => { await api.Request("/assistant/contacts", "POST", body); name.Text = email.Text = phone.Text = ""; });
        }, true)), 0);
      var sync = Ui.Stack(10);
      if (origins.Count == 0) sync.Children.Add(Ui.Caption("Contact sync starts automatically after you turn on contact reading for a Google or Microsoft account under Connections. Imported contacts stay when you stop syncing."));
      foreach (var o in origins) {
        var id = o.Id; var status = o["status"].Text;
        var item = Ui.Stack(4, Ui.Spread(Ui.T(Wires.Capitalize(o["provider"].Text) + " · " + o["sourceAccount"].Text), Ui.Caption(Wires.Words(status) + " · " + Wires.Words(o["syncMode"].Text).ToLowerInvariant())),
          Ui.Caption((o["lastSyncAt"].Text.Length > 0 ? "Last synced " + Wires.Date(o["lastSyncAt"].Text) : "Not synced yet") + (status == "error" && o["lastErrorCategory"].Text.Length > 0 ? " · " + Wires.Words(o["lastErrorCategory"].Text) : "")));
        if (status != "disconnected") {
          var interval = Ui.Choice(Intervals, o["intervalSeconds"].Integer.ToString());
          interval.SelectionChanged += delegate { var seconds = int.Parse(Ui.Selected(interval)); Perform(async (api, stamp) => await api.Request("/contacts/sync/" + api.Uuid(id) + "/interval", "PUT", Wires.O("seconds", seconds))); };
          item.Children.Add(Ui.Wrap(Ui.Pill("Sync Now", () => Act("/contacts/sync/" + id + "/run")), Ui.Pill("Stop Syncing", () => Act("/contacts/sync/" + id + "/stop")), interval));
        } else {
          var connection = o["connectionId"].Text;
          item.Children.Add(Ui.Pill("Restart Import Sync", () => Perform(async (api, stamp) => await api.Request("/contacts/sync/" + api.Uuid(connection), "PUT", Wires.O("mode", "import_only")))));
        }
        sync.Children.Add(item);
      }
      if (review.Count > 0) {
        sync.Children.Add(Ui.Headline("Possible duplicates"));
        sync.Children.Add(Ui.Caption("Nothing has been merged. Josi only joins records automatically when they are the same record from the same account."));
        foreach (var r in review) sync.Children.Add(Ui.Caption("• " + r["reason"].Text));
      }
      Ui.Add(page, Ui.CardBox("Synced accounts", sync), 0);
      Ui.Detach(search);
      var shown = contacts.Where(c => (c["name"].Text + " " + c["email"].Text + " " + c["phone"].Text).IndexOf(search.Text, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
      Ui.Add(page, Ui.Stack(10, Ui.Title2("Your contacts" + (contacts.Count > 0 ? " · " + contacts.Count : "")), search,
        shown.Count == 0 ? Ui.Secondary(contacts.Count == 0 ? "No contacts yet. Add one above, or connect Google or Microsoft under Connections." : "Nothing matches.") : null), 30);
      foreach (var c in shown) {
        var source = c["source"].Text;
        Ui.Add(page, Ui.CardBox(null, Ui.Spread(Ui.T(c["name"].Text.Length > 0 ? c["name"].Text : "Unnamed", 14, FontWeights.Medium),
            source.Length > 0 && source != "josi" ? Ui.Caption(Wires.Capitalize(source) + (c["source_account"].Text.Length > 0 ? " · " + c["source_account"].Text : "")) : null),
          c["email"].Text.Length > 0 ? Ui.Copyable(c["email"].Text, 13.5, Ui.Muted) : null, c["phone"].Text.Length > 0 ? Ui.Copyable(c["phone"].Text, 13.5, Ui.Muted) : null,
          c["conflict_state"].Text == "both_changed" ? Ui.T("Changed both here and at the provider. Josi kept both versions for you to choose.", 12.5, null, Ui.Orange) : null), 0);
      }
      Ui.Add(page, Note(), 0);
      return page;
    }
    void Act(string route) {
      Perform(async (api, stamp) => {
        var parts = route.Split('/');
        var result = await api.Request("/contacts/sync/" + api.Uuid(parts[3]) + "/" + parts[4], "POST", Wires.O());
        if (Current(stamp) && !result["needsReview"].IsNull) review = result["needsReview"].List;
      });
    }
  }

  /// Reusable email templates with merge fields, a live preview (desktop and
  /// mobile HTML open in your browser; the plain-text fallback is shown here),
  /// and drafting a message for approval. Nothing is sent from this page.
  public sealed class TemplatesView : SectionView {
    static readonly string[][] Fields = { new[] { "name", "Template name" }, new[] { "subject", "Subject" }, new[] { "heading", "Heading" }, new[] { "body", "Body" },
      new[] { "accentColor", "Accent color (#rrggbb)" }, new[] { "ctaLabel", "Button label (optional)" }, new[] { "ctaUrl", "Button URL (http or https)" }, new[] { "footer", "Footer / signature" } };
    static readonly Dictionary<string, string> Initial = new Dictionary<string, string> { { "name", "Welcome" }, { "subject", "Welcome, {{name}}" }, { "heading", "A warm welcome" },
      { "body", "Hello {{name}},\n\nThank you for getting in touch. We look forward to working with you." }, { "accentColor", "#2563eb" }, { "ctaLabel", "" }, { "ctaUrl", "" }, { "footer", "Warm regards,\nYour team" } };
    List<Wire> templates = new List<Wire>();
    string id = "", selection = "", draftSummary = "";
    Wire preview = Wire.Null;
    readonly Dictionary<string, TextBox> form = new Dictionary<string, TextBox>();
    readonly TextBox recipient = Ui.Input("To"), mergeName = Ui.Input("Recipient name"), mergeDate = Ui.Input("Date text"), mergeTime = Ui.Input("Time text and zone"),
      plainSubject = Ui.Input("Subject"), plainBody = Ui.Input("Body", "", true);
    public TemplatesView(AppModel model, Window owner) : base(model, owner) {
      foreach (var f in Fields) form[f[0]] = Ui.Input(f[1], Initial[f[0]], f[0] == "body" || f[0] == "footer");
      form["body"].MinHeight = 140;
    }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp;
      var r = await api.Request("/mail/templates");
      if (Current(stamp)) templates = r["templates"].List;
    }
    Dictionary<string, object> Body() { var b = new Dictionary<string, object>(); foreach (var f in Fields) b[f[0]] = form[f[0]].Text; return b; }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Email Templates", "Private reusable messages with a layout that works on desktop and mobile.", Ui.Pill("Refresh", StartLoad)));
      var options = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("", "New template") };
      options.AddRange(templates.Select(t => new KeyValuePair<string, string>(t.Id, t["name"].Text + " · " + t.Id.Substring(0, Math.Min(8, t.Id.Length)))));
      var picker = Ui.Choice(options, id);
      picker.SelectionChanged += delegate {
        id = Ui.Selected(picker); var t = templates.FirstOrDefault(x => x.Id == id);
        foreach (var f in Fields) form[f[0]].Text = t == null ? Initial[f[0]] : t[f[0]].Text;
        preview = Wire.Null; Render();
      };
      Ui.Add(page, Ui.Field("Saved template", picker), 0);
      if (id.Length > 0) Ui.Add(page, Ui.Copyable("Exact template ID for the assistant: " + id, 12.5, Ui.Muted), 0);
      var fields = new List<UIElement>();
      foreach (var f in Fields) { Ui.Detach(form[f[0]]); fields.Add(Ui.Field(f[1], form[f[0]])); }
      fields.Add(Ui.Caption("Text only. Blank lines make paragraphs; line breaks are kept. HTML and Markdown are shown as text."));
      var actions = Ui.Wrap(Ui.Pill("Save Template", Save, true), Ui.Pill("Preview", Preview));
      if (id.Length > 0) actions.Children.Add(Ui.Danger("Delete…", Delete));
      fields.Add(actions);
      Ui.Add(page, Ui.CardBox(id.Length > 0 ? "Edit template" : "New template", fields.ToArray()), 0);
      if (!preview.IsNull) {
        Ui.Add(page, Ui.CardBox("Preview", Ui.Caption("Sample values: Alex, alex@example.test, September 18, 2026, 10:00 AM PDT."),
          Ui.T("Subject: " + preview["subject"].Text, 14, FontWeights.Medium), Ui.Copyable(preview["text"].Text, 13.5),
          Ui.Wrap(Ui.Pill("Open Desktop HTML Preview", () => OpenHtml(false)), Ui.Pill("Open Mobile HTML Preview", () => OpenHtml(true)))), 0);
      }
      Ui.Add(page, Ui.CardBox("Merge fields", Ui.Secondary("Use exactly {{recipient}} for the To address, {{name}} for the recipient's name, {{date}} for your date text and {{time}} for your time text (include the time zone). Fields work in subject, heading, body, button label and footer. Missing values stop the draft. Button URLs cannot contain merge fields.")), 0);
      var draftOptions = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("", "No template (plain text)") };
      draftOptions.AddRange(options.Skip(1));
      var draftPick = Ui.Choice(draftOptions, selection);
      draftPick.SelectionChanged += delegate { selection = Ui.Selected(draftPick); draftSummary = ""; Render(); };
      foreach (var box in new[] { recipient, mergeName, mergeDate, mergeTime, plainSubject, plainBody }) Ui.Detach(box);
      var draft = new List<UIElement> { Ui.Caption("Choose a template or write a plain message. Review the final content before approving it under Approvals."),
        Ui.Field("Template", draftPick), Ui.Field("To", recipient) };
      if (selection.Length > 0) { draft.Add(Ui.Field("Recipient name", mergeName)); draft.Add(Ui.Field("Date text", mergeDate)); draft.Add(Ui.Field("Time text and zone", mergeTime)); }
      else { draft.Add(Ui.Field("Subject", plainSubject)); draft.Add(Ui.Field("Body", plainBody)); }
      draft.Add(Ui.Pill("Prepare for Approval", Prepare, true));
      if (draftSummary.Length > 0) { draft.Add(Ui.T("Prepared. No email has been sent. Approve it under Approvals.", 14, null, Ui.Green)); draft.Add(Ui.Copyable(draftSummary, 13.5)); }
      Ui.Add(page, Ui.CardBox("Draft an email", draft.ToArray()), 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    void Save() {
      var body = Body();
      Perform(async (api, stamp) => {
        var r = id.Length > 0 ? await api.Request("/mail/templates/" + api.Uuid(id), "PUT", body) : await api.Request("/mail/templates", "POST", body);
        id = r["template"].Id; note = "Template saved.";
      });
    }
    void Delete() {
      if (!Dialogs.Confirm(owner, "Delete this template?", "Approved drafts keep their original content.", "Delete")) return;
      var target = id;
      Perform(async (api, stamp) => {
        await api.Request("/mail/templates/" + api.Uuid(target), "DELETE", null);
        id = ""; if (selection == target) selection = "";
        foreach (var f in Fields) form[f[0]].Text = Initial[f[0]];
        note = "Template deleted.";
      });
    }
    void Preview() {
      var body = Wires.O("template", Body(), "recipient", "alex@example.test", "merge_values", Wires.O("name", "Alex", "date", "September 18, 2026", "time", "10:00 AM PDT"));
      Perform(async (api, stamp) => { preview = await api.Request("/mail/templates/preview", "POST", body); }, false);
    }
    void OpenHtml(bool mobile) {
      if (preview.IsNull) return;
      var html = mobile ? "<!doctype html><meta name='viewport' content='width=device-width'><div style='width:375px;margin:20px auto;border:1px solid #ccc'>" + preview["html"].Text + "</div>" : preview["html"].Text;
      var file = Path.Combine(Path.GetTempPath(), "josi-template-preview-" + Guid.NewGuid().ToString("N") + ".html");
      // Content-Security-Policy: no scripts, no network loads from the preview.
      File.WriteAllText(file, "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">" + html);
      ModelText.Open(new Uri(file));
    }
    void Prepare() {
      var body = Wires.O("recipient", recipient.Text.Trim());
      if (selection.Length > 0) { body["template_id"] = selection; body["merge_values"] = Wires.O("name", mergeName.Text, "date", mergeDate.Text, "time", mergeTime.Text); }
      else { body["subject"] = plainSubject.Text; body["body"] = plainBody.Text; }
      Perform(async (api, stamp) => {
        var r = await api.Request("/mail/templates/draft", "POST", body);
        if (r["state"].Text != "prepared") throw new JosiException(r["message"].Text.Length > 0 ? r["message"].Text : "Complete the draft first.");
        draftSummary = r["summary"].Text;
      }, false);
    }
  }
}
