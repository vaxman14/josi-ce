using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Josi.Native {
  /// Durable submission returns before the model runs. A failed receipt is a
  /// terminal result, even though the original POST succeeded and saved a message.
  public sealed class ChatTurnFailure : UserControl {
    public ChatTurnFailure(AppModel model, Wire turn) {
      var code = turn["error"]["code"].Text;
      var modelFailure = new[] { "no_model", "not_probed", "cannot_chat", "capped", "provider_error" }.Contains(code);
      string detail;
      switch (code) {
        case "no_model": detail = "No model is configured for this server."; break;
        case "not_probed": detail = "The saved model must pass its capability check before it can answer."; break;
        case "cannot_chat": detail = "The saved model did not pass its basic reply check."; break;
        case "capped": detail = "The model cannot run with its current connection or usage settings. Check the subscription or API connection and the model limits."; break;
        case "provider_error": detail = "The model provider could not complete this reply. Check its connection and run the model capability check."; break;
        case "session_expired": detail = "Your sign-in expired before this message could run. Sign in again to continue."; break;
        case "worker_interrupted": detail = "The server stopped before this reply finished."; break;
        case "effect_outcome_unknown": case "effect_then_provider_error":
          detail = "Josi could not finish the reply after starting an action. Review the task's saved actions before asking it to continue."; break;
        case "restricted": detail = "The current permissions do not allow Josi to answer this request."; break;
        default: detail = "The server could not finish this reply. Check server health for more information."; break;
      }
      var stack = Ui.Stack(8, Ui.Row(8, Ui.Icon(Glyph.Warning, 15, Ui.Orange), Ui.T("Josi couldn't reply", 15, FontWeights.SemiBold, Ui.Orange)),
        Ui.Copyable(detail, 14, Ui.Orange));
      if (model.IsAdministrator) {
        Ui.Add(stack, Ui.Pill(modelFailure ? "Open Models" : "Open Server", () => {
          model.Section = modelFailure ? "models" : "server";
          if (!modelFailure) model.RefreshLocal();
        }), 8);
      } else if (modelFailure) Ui.Add(stack, Ui.T("Ask your server administrator to check Models.", 14, null, Ui.Orange), 8);
      Content = new Border { Background = new SolidColorBrush(Color.FromArgb(0x14, 0xF6, 0x83, 0x1E)), CornerRadius = new CornerRadius(10), Padding = new Thickness(12), Child = stack };
    }
  }

  /// A disclosure group: a header that reveals content built on demand.
  public sealed class Disclosure : UserControl {
    readonly ContentControl body = new ContentControl { Focusable = false, Margin = new Thickness(0, 10, 0, 0) };
    readonly TextBlock chevron = Ui.Icon("", 11, Ui.Muted);
    readonly Func<UIElement> build;
    public bool Expanded { get; private set; }
    public event Action<bool> Toggled;
    public Disclosure(string title, Func<UIElement> build, bool expanded = false) {
      this.build = build;
      var header = new Button { Style = (Style)Ui.Resources["Plain"], Padding = new Thickness(0, 4, 0, 4), HorizontalAlignment = HorizontalAlignment.Left,
        Content = Ui.Row(8, chevron, Ui.T(title, 14, FontWeights.Medium)) };
      Ui.Name(header, title, null);
      header.Click += delegate { Set(!Expanded); };
      Content = Ui.Stack(0, header, body);
      Set(expanded);
    }
    public void Set(bool expanded) {
      Expanded = expanded;
      chevron.Text = expanded ? "" : "";
      body.Content = expanded ? build() : null;
      body.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
      var handler = Toggled; if (handler != null) handler(expanded);
    }
    public void Rebuild() { if (Expanded) body.Content = build(); }
  }

  public sealed class GoalCard : UserControl {
    readonly AppModel model; readonly Window owner; readonly Wire goal; readonly bool compact;
    WrapPanel liveControls;
    public GoalCard(AppModel model, Window owner, Wire goal, bool compact) {
      this.model = model; this.owner = owner; this.goal = goal; this.compact = compact;
      Content = Build();
      // The buttons follow the busy flag as it changes, not as it was when the
      // card was drawn: a card built during a brief busy moment (opening the
      // section) otherwise stays greyed out until the goal's content changes,
      // and a parked goal's Pause and Cancel never come back.
      Loaded += delegate { model.Changed += SyncEnabled; SyncEnabled(); };
      Unloaded += delegate { model.Changed -= SyncEnabled; };
    }
    void SyncEnabled() { if (liveControls != null) liveControls.IsEnabled = !model.Busy; }
    bool SetupBlocked { get { return goal["activity"].Text == "Automation needs setup"; } }
    bool Recovery {
      get {
        return SetupBlocked || goal["activity"].Text == "Progress needs recovery"
          || goal["continuation"]["text"].Text == "The last segment did not save a next step or verified result. What should Josi try next?";
      }
    }
    List<Wire> VisibleSteps() {
      var steps = goal["steps"].List;
      if (!compact) return steps;
      var required = steps.Where(s => s["state"].Text != "skipped").ToList();
      var active = required.FindIndex(s => s["state"].Text == "working");
      if (active < 0) active = required.FindIndex(s => s["state"].Text != "verified");
      if (active < 0) active = Math.Max(0, required.Count - 1);
      return required.Skip(Math.Max(0, active - 1)).Take(4).ToList();
    }
    static string StepLabel(string state) {
      switch (state) {
        case "pending": return "Pending"; case "working": return "Working"; case "blocked": return "Waiting";
        case "verified": return "Verified"; case "skipped": return "Retired"; default: return state;
      }
    }
    UIElement Build() {
      var state = goal["state"].Text;
      var done = state == "completed" || state == "cancelled";
      var stack = new StackPanel();
      Ui.Add(stack, Ui.Spread(Ui.Headline(goal["title"].Text), Ui.StatusBadge(state)), 0);
      var total = Math.Max(1, goal["totalSteps"].Integer);
      Ui.Add(stack, new ProgressBar { Minimum = 0, Maximum = total, Value = goal["verifiedSteps"].Integer }, 12);
      Ui.Add(stack, Ui.T(goal["verifiedSteps"].Integer + "/" + goal["totalSteps"].Integer + " verified", 13.5, FontWeights.Bold), 12);
      if (goal["activity"].Text.Length > 0) Ui.Add(stack, Ui.Secondary(goal["activity"].Text), 10);
      foreach (var step in VisibleSteps()) {
        var s = step["state"].Text;
        // A repeat step shows how far along it is, counted by the server from
        // what the tools did ("Photo 14 of 53"), live.
        var repeat = step["repeat"];
        var progress = repeat.IsNull ? "" : " — " + Wires.Capitalize(repeat["unit"].Text.Length > 0 ? repeat["unit"].Text : "item") + " " + Math.Min(repeat["done"].Integer, repeat["count"].Integer) + " of " + repeat["count"].Integer;
        var label = Ui.T(step["title"].Text + progress);
        if (s == "skipped") label.TextDecorations = TextDecorations.Strikethrough;
        var icon = Ui.Icon(s == "verified" ? Glyph.Check : s == "skipped" ? Glyph.Minus : Glyph.Circle, 14, s == "verified" ? Ui.Green : Ui.Muted);
        icon.Margin = new Thickness(0, 2, 8, 0); icon.VerticalAlignment = VerticalAlignment.Top;
        var row = new DockPanel(); DockPanel.SetDock(icon, Dock.Left);
        var stateText = Ui.Caption(StepLabel(s)); DockPanel.SetDock(stateText, Dock.Right); stateText.Margin = new Thickness(10, 0, 0, 0);
        row.Children.Add(icon); row.Children.Add(stateText); row.Children.Add(label);
        Ui.Add(stack, row, 10);
        if (!compact && step["blockedReason"].Text.Length > 0) {
          Ui.Add(stack, Ui.Caption(step["blockedReason"].Text), 4);
          if (step["blockedUntil"].Text.Length > 0) Ui.Add(stack, Ui.Caption("Next check: " + Wires.Date(step["blockedUntil"].Text)), 2);
        }
        if (!compact && step["dependsOn"].List.Count > 0) {
          var names = step["dependsOn"].List.Select(d => {
            var found = goal["steps"].List.FirstOrDefault(x => x["id"].Same(d));
            return found == null ? "Unavailable step" : found["title"].Text;
          });
          Ui.Add(stack, Ui.Caption("After: " + string.Join(" · ", names)), 4);
        }
        if (!compact && Wires.IsUuid(step["evidence"].Text) && step["evidence"].Text == step["taskId"].Text)
          Ui.Add(stack, new TaskReceipt(model, step["evidence"].Text, "View Saved Verification Task"), 6);
        if (!compact && !step["retirement"].IsNull) Ui.Add(stack, Ui.Caption("Retired: " + step["retirement"]["reason"].Text), 4);
      }
      if (compact && goal["totalSteps"].Integer > VisibleSteps().Count)
        Ui.Add(stack, Ui.Caption("Showing the current part of the plan. All steps are in Task Manager."), 10);
      if (goal["retiredSteps"].Integer > 0) Ui.Add(stack, Ui.Caption(goal["retiredSteps"].Integer + " retired steps retained in history."), 8);
      var continuation = goal["continuation"];
      if (continuation["kind"].Text == "question") {
        Ui.Add(stack, Ui.T(Recovery && !SetupBlocked ? "Josi stopped before saving the next step. Your original request is still saved. Continue to recheck the task." : continuation["text"].Text, 14, FontWeights.Medium), 12);
        if (SetupBlocked || Recovery) Ui.Add(stack, Ui.Pill("Open Automation", () => { model.Section = "automation"; model.Run(() => model.LoadAutomation()); }), 8);
      }
      if (continuation["kind"].Text == "wait") {
        Ui.Add(stack, Ui.Secondary(continuation["reason"].Text), 10);
        Ui.Add(stack, Ui.Caption("Next check: " + Wires.Date(continuation["wakeAt"].Text)), 4);
      }
      if (goal["planNeedsReview"].Flag) Ui.Add(stack, Ui.Caption("Josi must review the changed plan before new actions."), 8);
      if (goal["updatedAt"].Text.Length > 0) Ui.Add(stack, Ui.Caption("Last saved: " + Wires.Date(goal["updatedAt"].Text)), 8);

      if (!compact) {
        var work = goal["automaticWork"];
        if (!work.IsNull && !done) {
          Ui.Add(stack, Ui.Caption("Automatic continuations since verified progress: " + work["segmentsSinceVerifiedProgress"].Integer + " of " + work["segmentLimit"].Integer + "."), 10);
          if (work["nextCheckAt"].Text.Length > 0 && (state == "planning" || state == "working"))
            Ui.Add(stack, Ui.Caption("Scheduled to continue: " + Wires.Date(work["nextCheckAt"].Text)), 4);
        }
        Ui.Add(stack, new WorkDetails(model, owner, goal), 14);
        var instruction = Ui.Input(Recovery ? "Additional instructions (optional)" : "Instructions for Josi");
        Ui.Add(stack, instruction, 14);
        var controls = new WrapPanel();
        if (!done) {
          controls.Children.Add(Spaced(Ui.Pill("Pause", () => Control("pause", instruction.Text))));
          var resume = Ui.Pill(SetupBlocked ? "Check Connection & Continue" : "Continue", () => Control("resume", instruction.Text));
          resume.IsEnabled = Recovery || instruction.Text.Trim().Length > 0;
          instruction.TextChanged += delegate { resume.IsEnabled = Recovery || instruction.Text.Trim().Length > 0; };
          controls.Children.Add(Spaced(resume));
          controls.Children.Add(Spaced(Ui.Danger("Cancel Work…", () => {
            if (Dialogs.Confirm(owner, "Cancel this work?", "Completed actions remain completed. This stops further work on the goal.", "Cancel Work")) Control("cancel", "");
          })));
        }
        if (state == "verifying") controls.Children.Add(Spaced(Ui.Pill("Confirm Complete", () => Control("confirm", ""), true)));
        controls.IsEnabled = !model.Busy; liveControls = controls;
        Ui.Add(stack, controls, 10);
        var thread = goal["threadId"].Text;
        Ui.Add(stack, Ui.Pill("Continue in Chat", () => model.Run(() => model.SelectThread(thread))), 4);
      } else {
        Ui.Add(stack, Ui.Link("Open Task Manager", () => { model.Section = "tasks"; model.Run(() => model.ReloadWorkspace()); }), 10);
      }
      return Ui.CardBox(null, stack);
    }
    static UIElement Spaced(FrameworkElement element) { element.Margin = new Thickness(0, 0, 8, 8); return element; }
    void Control(string action, string typed) {
      var text = action == "resume" && Recovery && typed.Trim().Length == 0
        ? "Recheck the current automation connection and saved action receipts, then continue the original task within existing permissions. Preserve completed work and inspect any uncertain result before further actions."
        : typed;
      var snapshot = goal;
      model.Run(() => model.Control(snapshot, action, text));
    }
  }

  /// Finished criteria, work notes, owner corrections, limits, outcome edits and history.
  public sealed class WorkDetails : UserControl {
    readonly AppModel model; readonly Window owner; readonly Wire goal;
    StackPanel liveStack;
    public WorkDetails(AppModel model, Window owner, Wire goal) {
      this.model = model; this.owner = owner; this.goal = goal;
      Content = new Disclosure("Work details", Build);
      Loaded += delegate { model.Changed += SyncEnabled; SyncEnabled(); };
      Unloaded += delegate { model.Changed -= SyncEnabled; };
    }
    void SyncEnabled() { if (liveStack != null) liveStack.IsEnabled = !model.Busy; }
    static List<object> Lines(string text) {
      return text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).Select(l => (object)l).ToList();
    }
    static UIElement Notes(Wire notes) {
      var stack = new StackPanel();
      foreach (var pair in new[] { new[] { "decisions", "Decisions" }, new[] { "facts", "Reported facts" }, new[] { "assumptions", "Assumptions" } }) {
        var items = notes[pair[0]].List;
        if (items.Count == 0) continue;
        Ui.Add(stack, Ui.T(pair[1], 13.5, FontWeights.SemiBold), 8);
        foreach (var item in items) Ui.Add(stack, Ui.Copyable("• " + item.Text), 3);
      }
      if (notes["nextAction"].Text.Length > 0) Ui.Add(stack, Ui.Copyable("Next action: " + notes["nextAction"].Text), 8);
      if (stack.Children.Count == 0) Ui.Add(stack, Ui.Secondary("No saved notes."), 0);
      return stack;
    }
    UIElement Build() {
      var stack = new StackPanel();
      var done = goal["state"].Text == "completed" || goal["state"].Text == "cancelled";
      Ui.Add(stack, Ui.Headline("Finished means"), 0);
      foreach (var item in goal["criteria"].List) Ui.Add(stack, Ui.Copyable("• " + item.Text), 4);
      if (!goal["ownerCheckpoint"].IsNull)
        Ui.Add(stack, Ui.CardBox("Your correction", Notes(goal["ownerCheckpoint"]), Ui.Caption("Josi keeps your correction separate from its own progress notes.")), 12);
      Ui.Add(stack, Ui.CardBox("Latest progress notes", Notes(goal["checkpoint"])), 12);
      Ui.Add(stack, MemoryControls(), 12);
      if (!done) {
        Ui.Add(stack, Limits(), 12);
        Ui.Add(stack, new Disclosure("Change Requested Outcome", OutcomeEditor), 12);
        if (!goal["retiredSteps"].IsNull && goal["totalSteps"].Integer > 1) Ui.Add(stack, new Disclosure("Retire an Obsolete Step", RetireEditor), 6);
      }
      foreach (var kind in new[] { new[] { "events", "Activity history" }, new[] { "plans", "Plan history" }, new[] { "outcomes", "Outcome history" } })
        Ui.Add(stack, new WorkHistory(model, goal, kind[0], kind[1]), 6);
      stack.IsEnabled = !model.Busy; liveStack = stack;
      return stack;
    }
    void Change(string endpoint, Dictionary<string, object> fields) {
      var snapshot = goal;
      model.Run(() => model.ChangeGoal(snapshot, endpoint, fields));
    }
    UIElement MemoryControls() {
      var source = goal["ownerCheckpoint"].IsNull ? goal["checkpoint"] : goal["ownerCheckpoint"];
      Func<UIElement> editor = () => {
        var decisions = Ui.Input("Decisions — one per line", string.Join("\n", source["decisions"].List.Select(x => x.Text)), true);
        var facts = Ui.Input("Reported facts — one per line", string.Join("\n", source["facts"].List.Select(x => x.Text)), true);
        var assumptions = Ui.Input("Assumptions — one per line", string.Join("\n", source["assumptions"].List.Select(x => x.Text)), true);
        var next = Ui.Input("Next action", source["nextAction"].Text, true);
        var save = Ui.Pill("Save Correction", () => Change("memory", Wires.O("action", "correct", "checkpoint", Wires.O(
          "decisions", Lines(decisions.Text), "facts", Lines(facts.Text), "assumptions", Lines(assumptions.Text), "nextAction", next.Text))), true);
        save.IsEnabled = next.Text.Trim().Length > 0;
        next.TextChanged += delegate { save.IsEnabled = next.Text.Trim().Length > 0; };
        return Ui.Stack(10, Ui.Field("Decisions — one per line", decisions), Ui.Field("Reported facts — one per line", facts),
          Ui.Field("Assumptions — one per line", assumptions), Ui.Field("Next action", next), Ui.Caption("Up to 12 items per list."), save);
      };
      return Ui.CardBox("Work memory",
        Ui.Caption("Notes help Josi continue. They cannot change permissions or Cardinal Rules. Keep secrets in the Vault."),
        Ui.Wrap(
          Ui.Pill(goal["checkpointPinned"].Flag ? "Unpin" : "Pin for Future Work", () => Change("memory", Wires.O("action", goal["checkpointPinned"].Flag ? "unpin" : "pin"))),
          Ui.Danger("Clear Saved Notes…", () => {
            if (Dialogs.Confirm(owner, "Clear saved notes?", "The task, evidence and original conversation remain. Later work may save new progress notes.", "Clear Notes and Correction"))
              Change("memory", Wires.O("action", "forget"));
          })),
        new Disclosure(goal["ownerCheckpoint"].IsNull ? "Correct Notes" : "Edit Your Correction", editor));
    }
    UIElement Limits() {
      var saved = goal["automaticWork"];
      if (saved["runsUsed"].IsNull) return null;
      Func<UIElement> editor = () => {
        var limited = Ui.Toggle("Set a total background-run limit", !saved["runLimit"].IsNull);
        var runs = Ui.Input("Total runs allowed — 0 to 10,000", (!saved["runLimit"].IsNull ? saved["runLimit"].Integer : Math.Min(10000, saved["runsUsed"].Integer + 12)).ToString(CultureInfo.InvariantCulture));
        var timed = Ui.Toggle("Set a background-work deadline", !saved["deadline"].IsNull);
        DateTimeOffset parsed;
        var initial = DateTimeOffset.TryParse(saved["deadline"].Text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out parsed) ? parsed.LocalDateTime : DateTime.Now.AddHours(1);
        var deadline = Ui.Input("Deadline in your local time", initial.ToString("g", CultureInfo.CurrentCulture));
        return Ui.Stack(10, limited, runs, timed, Ui.Field("Deadline in your local time", deadline),
          Ui.Caption("Saving keeps paused work paused. If a limit was reached, save a larger allowance, then resume with instructions."),
          Ui.Pill("Save Limits", () => {
            int count; DateTime when;
            if (limited.IsChecked == true && (!int.TryParse(runs.Text, out count) || count < 0 || count > 10000)) { model.Error = "Enter a run limit from 0 to 10,000."; model.Notify(); return; }
            if (timed.IsChecked == true && !DateTime.TryParse(deadline.Text, CultureInfo.CurrentCulture, DateTimeStyles.AssumeLocal, out when)) { model.Error = "Enter a valid deadline."; model.Notify(); return; }
            int.TryParse(runs.Text, out count); DateTime.TryParse(deadline.Text, CultureInfo.CurrentCulture, DateTimeStyles.AssumeLocal, out when);
            Change("limits", Wires.O("runLimit", limited.IsChecked == true ? (object)count : null,
              "deadline", timed.IsChecked == true ? (object)when.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) : null));
          }, true));
      };
      return Ui.CardBox("Work limits",
        Ui.T(saved["runsUsed"].Integer + " background runs used · " + (saved["runLimit"].IsNull ? "No goal-specific run limit" : "Total allowed: " + saved["runLimit"].Integer)),
        Ui.T(saved["deadline"].IsNull ? "No goal-specific deadline." : "Deadline: " + Wires.Date(saved["deadline"].Text)),
        Ui.Caption("Runs include queued and interrupted background work. Progress and Resume do not reset the count. These limits stop new background work; actions already sent may finish. Account limits and tool permissions still apply."),
        new Disclosure("Edit Work Limits", editor));
    }
    UIElement OutcomeEditor() {
      var outcome = Ui.Input(null, goal["title"].Text, true);
      var criteria = Ui.Input(null, string.Join("\n", goal["criteria"].List.Select(c => c.Text)), true);
      var reason = Ui.Input(null, "", true);
      var keepGoing = Ui.Toggle("Let Josi review the plan and continue within existing permissions", goal["state"].Text != "paused");
      return Ui.Stack(10, Ui.Field("Requested outcome", outcome), Ui.Field("Finished means — one criterion per line", criteria),
        Ui.Field("What changed, and what should Josi do next?", reason), keepGoing,
        Ui.Caption("Completed work and original steps stay saved. Actions already sent may still finish."),
        Ui.Pill("Save Outcome", () => {
          if (new[] { outcome.Text, criteria.Text, reason.Text }.Any(t => t.Trim().Length == 0)) { model.Error = "Fill in the outcome, criteria and reason."; model.Notify(); return; }
          Change("outcome", Wires.O("outcome", outcome.Text, "criteria", Lines(criteria.Text), "reason", reason.Text, "continueWork", keepGoing.IsChecked == true));
        }, true));
    }
    UIElement RetireEditor() {
      var options = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("", "Choose a step") };
      options.AddRange(goal["steps"].List.Where(s => s["state"].Text != "verified" && s["state"].Text != "skipped").Select(s => new KeyValuePair<string, string>(s.Id, s["title"].Text)));
      var step = Ui.Choice(options, "");
      var reason = Ui.Input(null, "", true);
      var keepGoing = Ui.Toggle("Let Josi review the plan and continue within existing permissions", goal["state"].Text != "paused");
      return Ui.Stack(10, Ui.Field("Step", step), Ui.Field("Why is this step obsolete?", reason), keepGoing,
        Ui.Caption("The step stays in history and stops counting as required work. Uncertain actions must be resolved first."),
        Ui.Pill("Retire Step and Retain History", () => {
          if (Ui.Selected(step).Length == 0 || reason.Text.Trim().Length == 0) { model.Error = "Choose a step and explain why it is obsolete."; model.Notify(); return; }
          Change("retire-step", Wires.O("stepId", Ui.Selected(step), "reason", reason.Text, "continueWork", keepGoing.IsChecked == true));
        }, true));
    }
  }

  public sealed class WorkHistory : UserControl {
    readonly AppModel model; readonly Wire goal; readonly string kind;
    readonly StackPanel list = new StackPanel();
    long before;
    List<Wire> records = new List<Wire>();
    public WorkHistory(AppModel model, Wire goal, string kind, string title) {
      this.model = model; this.goal = goal; this.kind = kind;
      var disclosure = new Disclosure(title, () => list);
      disclosure.Toggled += open => { if (open) Load(); };
      Content = disclosure;
    }
    string RevisionKey { get { return kind == "events" ? "sequence" : kind == "plans" ? "plan_revision" : "outcome_revision"; } }
    async void Load() {
      var api = model.Api; if (api == null) return;
      list.Children.Clear(); list.Children.Add(Ui.Caption("Loading…"));
      try {
        var id = api.Uuid(goal.Id);
        var suffix = before > 0 ? "?before=" + before : kind == "events" ? "?after=" + Math.Max(0, goal["revision"].Integer - 50) : "";
        var result = await api.Request("/assistant/work-goals/" + id + "/" + kind + suffix);
        if (model.Api != api) return;
        records = result[kind].List; Render(null);
      } catch (JosiException e) { Render(e.Message); }
    }
    void Render(string error) {
      list.Children.Clear();
      foreach (var item in records) {
        var stack = Ui.Stack(7, Ui.Copyable(kind == "events" ? item["summary"].Text : kind == "plans" ? item["reason"].Text : item["outcome"].Text),
          Ui.Caption(Wires.Date(item["created_at"].Text)));
        if (kind == "plans") foreach (var step in item["steps"].List) {
          var line = Ui.T("• " + step["title"].Text); if (step["state"].Text == "skipped") line.TextDecorations = TextDecorations.Strikethrough;
          Ui.Add(stack, line, 3);
        }
        if (kind == "outcomes") {
          Ui.Add(stack, Ui.Secondary(item["reason"].Text), 4);
          foreach (var c in item["criteria"].List) Ui.Add(stack, Ui.T("• " + c.Text), 3);
        }
        Ui.Add(list, Ui.CardBox(null, stack), 10);
      }
      if (error != null) Ui.Add(list, Ui.T(error, 14, null, Ui.Orange), 8);
      else if (records.Count == 0) Ui.Add(list, Ui.Secondary("No saved entries."), 8);
      var oldest = records.Select(r => r[RevisionKey].Integer).Where(n => n > 0).DefaultIfEmpty(0).Min();
      var older = Ui.Pill("Older", () => { before = oldest; Load(); }); older.IsEnabled = oldest > 1;
      var latest = Ui.Pill("Latest", () => { before = 0; Load(); }); latest.IsEnabled = before != 0;
      Ui.Add(list, Ui.Row(8, older, latest), 10);
    }
  }

  /// Reads the original owned task and its saved activity. A receipt never
  /// becomes a retry action or a locally inferred goal completion.
  public sealed class TaskReceipt : UserControl {
    readonly AppModel model; readonly string taskId;
    readonly StackPanel body = new StackPanel();
    public TaskReceipt(AppModel model, string taskId, string title = "Saved task activity") {
      this.model = model; this.taskId = taskId;
      var disclosure = new Disclosure(title, () => body);
      disclosure.Toggled += open => { if (open) Load(); };
      Content = disclosure;
    }
    async void Load() {
      var api = model.Api; if (api == null) return;
      body.Children.Clear(); body.Children.Add(Ui.Caption("Loading…"));
      try {
        var id = api.Uuid(taskId);
        var taskResult = await api.Request("/assistant/tasks/" + id);
        var activity = await api.Request("/assistant/tasks/" + id + "/activity");
        if (model.Api != api) return;
        var task = taskResult["task"].IsNull ? taskResult : taskResult["task"];
        body.Children.Clear();
        Ui.Add(body, Ui.T("Task: " + Wires.Words(task["state"].Text), 13.5, FontWeights.Bold), 0);
        if (task["fail_reason"].Text.Length > 0) Ui.Add(body, Ui.T(task["fail_reason"].Text), 4);
        if (task["next_wake_at"].Text.Length > 0) Ui.Add(body, Ui.T("Next check: " + Wires.Date(task["next_wake_at"].Text)), 4);
        if (activity["attempts"].List.Count == 0) Ui.Add(body, Ui.Secondary("No saved attempts."), 6);
        foreach (var attempt in activity["attempts"].List)
          Ui.Add(body, Ui.Stack(3, Ui.T(Wires.Words(attempt["kind"].Text), 13.5, FontWeights.Bold),
            Ui.T(attempt["outcome"].Text.Length == 0 ? "No confirmed outcome recorded." : attempt["outcome"].Text),
            Ui.Caption(Wires.Date(attempt["started_at"].Text))), 8);
        if (activity["approvals"].List.Count > 0) Ui.Add(body, Ui.T("Saved approvals", 13.5, FontWeights.Bold), 10);
        foreach (var approval in activity["approvals"].List)
          Ui.Add(body, Ui.Stack(3, Ui.T(approval["summary"].Text), Ui.Caption(Wires.Words(approval["status"].Text) + " · " + Wires.Date(approval["created_at"].Text))), 6);
      } catch (JosiException e) {
        body.Children.Clear(); body.Children.Add(Ui.T(e.Message, 14, null, Ui.Orange));
      }
    }
  }

  public sealed class TaskManagerView : UserControl {
    readonly AppModel model; readonly Window owner;
    string filter = "active";
    string renderedKey;
    public TaskManagerView(AppModel model, Window owner) { this.model = model; this.owner = owner; }

    public void Refresh() {
      var key = filter + "#" + string.Join("|", model.Goals.Select(g => g.Json)) + "#" + string.Join("|", model.Tasks.Select(t => t.Json))
        + "#" + string.Join("|", model.TaskRuns.Select(r => r.Json)) + "#" + model.ProgressConnection;
      if (key == renderedKey) return;
      renderedKey = key;
      var page = new StackPanel();
      Ui.Add(page, Ui.Heading("Task Manager", "What Josi is working on, and what needs your attention."), 0);
      Ui.Add(page, Ui.Segments(Ui.Options("active", "Active", "attention", "Needs You / Waiting", "history", "History"), filter, value => { filter = value; Refresh(); }), 20);
      var failed = model.TaskRuns.Where(r => r["status"].Text == "failed").ToList();
      if (filter == "active" && failed.Count > 0) Ui.Add(page, Ui.Link(failed.Count + " failed conversation request(s) — Review", () => { filter = "attention"; Refresh(); }), 14);

      var goals = model.Goals.Where(g => {
        var s = g["state"].Text;
        if (filter == "attention") return s == "needs_instruction" || s == "waiting" || s == "paused";
        if (filter == "history") return s == "completed" || s == "cancelled";
        return s != "completed" && s != "cancelled";
      }).ToList();
      var runs = model.TaskRuns.Where(r => {
        var s = r["status"].Text;
        if (filter == "attention") return s == "failed";
        if (filter == "history") return s == "completed" || s == "failed";
        return s == "queued" || s == "running";
      }).ToList();
      var linked = new HashSet<string>(model.Goals.SelectMany(g => g["steps"].List.Select(s => s["taskId"].Text)));
      var standalone = model.Tasks.Where(t => {
        if (linked.Contains(t["id"].Text)) return false;
        var s = t["state"].Text;
        var closed = s == "closed" || s == "confirmed" || s == "cancelled" || s == "failed";
        if (filter == "history") return closed;
        if (filter == "attention") return s == "held" || s == "awaiting_approval" || s == "awaiting_owner" || s == "failed";
        return !closed;
      }).ToList();

      if (goals.Count == 0 && runs.Count == 0 && standalone.Count == 0) Ui.Add(page, Ui.Secondary("No work in this view."), 20);
      foreach (var goal in goals) Ui.Add(page, new GoalCard(model, owner, goal, false), 20);
      if (runs.Count > 0) {
        Ui.Add(page, Ui.Title2("Conversation requests"), 24);
        foreach (var run in runs) {
          var thread = run["thread_id"].Text;
          var card = Ui.CardBox(run["thread_title"].Text.Length == 0 ? "Conversation" : run["thread_title"].Text,
            Ui.Secondary(Wires.Capitalize(run["status"].Text) + " · " + Wires.Date(run["updated_at"].Text)),
            run["status"].Text == "failed" ? new ChatTurnFailure(model, new Wire(Wires.O("error", Wires.O("code", run["error_code"], "retryable", run["error_retryable"])))) : null,
            Ui.Pill("Open Conversation", () => model.Run(() => model.SelectThread(thread))));
          Ui.Add(page, card, 12);
        }
      }
      if (standalone.Count > 0) {
        Ui.Add(page, Ui.Title2("Other tasks"), 24);
        foreach (var task in standalone)
          Ui.Add(page, Ui.CardBox(task["title"].Text.Length == 0 ? task["template_key"].Text : task["title"].Text,
            Ui.Secondary(Wires.Words(task["state"].Text)), new TaskReceipt(model, task["id"].Text)), 12);
      }
      Ui.Add(page, Ui.Caption(model.ProgressConnection), 20);
      if (model.LastRefreshed.HasValue) Ui.Add(page, Ui.Caption("Updated " + model.LastRefreshed.Value.ToString("T", CultureInfo.CurrentCulture)), 4);
      var offset = scroll == null ? 0 : scroll.VerticalOffset;
      scroll = Ui.Scroll(page, double.PositiveInfinity, 28);
      Content = scroll;
      scroll.Dispatcher.BeginInvoke(new Action(() => scroll.ScrollToVerticalOffset(offset)), System.Windows.Threading.DispatcherPriority.Loaded);
    }
    ScrollViewer scroll;
  }
}
