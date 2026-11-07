using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace Josi.Native {
  public sealed class ChatView : UserControl {
    readonly AppModel model; readonly Window owner;
    readonly TextBlock title = Ui.Caption("Conversation");
    readonly TextBlock modelName = Ui.Caption("");
    readonly StackPanel messages = new StackPanel { MaxWidth = 900, Margin = new Thickness(28) };
    readonly ScrollViewer scroller;
    // Work in progress sits beside the conversation, never under the composer.
    readonly StackPanel goalPanel = new StackPanel { Width = 380, Margin = new Thickness(0, 20, 24, 12) };
    readonly ScrollViewer goalScroller;
    readonly TextBox editor;
    readonly WrapPanel attachments = new WrapPanel();
    readonly TextBlock partial = Ui.T("", 13.5, null, Ui.Muted);
    readonly TextBlock voiceError = Ui.T("", 12, null, Ui.Error);
    readonly StackPanel left = new StackPanel { Orientation = Orientation.Horizontal };
    readonly StackPanel right = new StackPanel { Orientation = Orientation.Horizontal };
    readonly TextBlock hint = Ui.Caption("");
    readonly Voice voice;
    string renderedKey, lastMessageId;
    bool wasThinking, loadedModel;
    const double StageLineHeight = 200;
    static readonly string[] Acknowledgements = { "I got you.", "Consider it handled. Well, almost.", "On it. Try to contain your excitement.", "Oh, I like this one. Give me a sec.", "Say less." };
    static readonly string[] Suggestions = { "What's on my calendar today?", "Remind me to call Dana", "Draft a note to the team" };
    readonly GhostView ghost;
    readonly Button goalChip, closeHistory;
    readonly Grid stage = new Grid();
    readonly ContentControl stageLine = new ContentControl { Focusable = false };
    readonly Grid history = new Grid { Visibility = Visibility.Collapsed };
    readonly TranslateTransform historySlide = new TranslateTransform();
    readonly TextBlock historyCount = new TextBlock { FontSize = 10, FontWeight = FontWeights.Bold, Foreground = Ui.OnGold, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    readonly Border historyBadge = new Border { MinWidth = 18, Height = 18, CornerRadius = new CornerRadius(9), Background = Ui.Accent, Padding = new Thickness(4, 0, 4, 0),
      HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, -4, -4, 0), IsHitTestVisible = false };
    /// What the top bar shows on the right while Chat is open.
    public readonly UIElement BarActions;
    bool historyOpen;
    readonly FrameworkElement thinkingChip;
    readonly TextBlock thinkingLabel;
    System.Windows.Threading.DispatcherTimer reveal;
    string ghostThread, ghostReply, ghostFailure, ghostError = "", freshReply, stageKey;
    /// True from a send until its outcome. Loading an old conversation brings in
    /// replies and failures too, and those must not play as if they just happened.
    bool ghostWaiting;
    readonly Dictionary<string, string> ghostGoals = new Dictionary<string, string>();

    public ChatView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      voice = new Voice(model);
      voice.Changed += RenderComposer;

      Automation.BeginScope("chat");
      Automation.Id(title, "josi.chat.title"); Automation.Id(modelName, "josi.chat.model");
      scroller = new ScrollViewer { Content = messages, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false };
      goalScroller = new ScrollViewer { Content = goalPanel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false, Visibility = Visibility.Collapsed };

      // The stage: the ghost big in the middle, and only the current line under it.
      ghost = new GhostView(model.Ghost, 300, true) { VerticalAlignment = VerticalAlignment.Bottom, HorizontalAlignment = HorizontalAlignment.Center };
      stage.RowDefinitions.Add(new RowDefinition());
      stage.RowDefinitions.Add(new RowDefinition { Height = new GridLength(StageLineHeight) });
      stage.Children.Add(ghost);
      stageLine.MaxWidth = 760; stageLine.Margin = new Thickness(24, 10, 24, 0); stageLine.HorizontalAlignment = HorizontalAlignment.Center;
      Automation.Id(stageLine, "josi.chat.stage");
      thinkingChip = Ui.Thinking(null, out thinkingLabel);
      thinkingChip.HorizontalAlignment = HorizontalAlignment.Center; thinkingChip.Margin = new Thickness(0, 12, 0, 0);
      thinkingChip.Visibility = Visibility.Collapsed;
      model.Ghost.StateChanged += () => { thinkingChip.Visibility = model.Ghost.State == JosiState.Thinking ? Visibility.Visible : Visibility.Collapsed; };
      var under = new StackPanel();
      under.Children.Add(stageLine); under.Children.Add(thinkingChip);
      Grid.SetRow(under, 1); stage.Children.Add(under);
      stage.SizeChanged += delegate { ghost.Resize(Math.Max(170, Math.Min(480, Math.Min(stage.ActualHeight - StageLineHeight - 4, stage.ActualWidth * 0.7)))); };

      editor = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 42, MaxHeight = 140,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = Brushes.Transparent, BorderThickness = new Thickness(0),
        FontSize = 15, Padding = new Thickness(8, 10, 8, 8), VerticalAlignment = VerticalAlignment.Bottom };
      editor.Template = EditorTemplate();
      Ui.Placeholder(editor, "Message Josi…", Brushes.Transparent);
      System.Windows.Automation.AutomationProperties.SetName(editor, "Message Josi");
      Automation.Id(editor, "josi.chat.composer");
      Automation.Id(hint, "josi.chat.hint");
      System.Windows.Automation.AutomationProperties.SetHelpText(editor, "Enter sends the message. Shift+Enter starts a new line.");
      editor.PreviewKeyDown += OnKey;
      editor.TextChanged += delegate { model.Draft = editor.Text; RenderComposer(); };

      var controls = new DockPanel();
      DockPanel.SetDock(left, Dock.Left); DockPanel.SetDock(right, Dock.Right);
      left.VerticalAlignment = VerticalAlignment.Bottom; right.VerticalAlignment = VerticalAlignment.Bottom;
      attachments.Visibility = Visibility.Collapsed;
      controls.Children.Add(left); controls.Children.Add(right); controls.Children.Add(editor);
      var composerStack = new StackPanel();
      composerStack.Children.Add(attachments); composerStack.Children.Add(partial); composerStack.Children.Add(voiceError); composerStack.Children.Add(controls);
      var composer = new Border { Child = composerStack, Padding = new Thickness(8), CornerRadius = new CornerRadius(29),
        Background = Ui.Frost, BorderBrush = Ui.Hairline,
        BorderThickness = new Thickness(1), MaxWidth = 820, Margin = new Thickness(24, 8, 24, 8) };
      hint.HorizontalAlignment = HorizontalAlignment.Center; hint.Margin = new Thickness(0, 0, 0, 14);

      var dock = new DockPanel();
      DockPanel.SetDock(hint, Dock.Bottom); DockPanel.SetDock(composer, Dock.Bottom);
      dock.Children.Add(hint); dock.Children.Add(composer); dock.Children.Add(stage);

      // The whole conversation, in a panel that rises over the stage.
      closeHistory = Automation.Id(Ui.RoundButton(Glyph.Close, "Close chat history", () => ShowHistory(false), 40), "josi.chat.history.close");
      var head = Ui.Spread(Ui.Stack(3, Ui.T("Chat history", 20, FontWeights.Bold), title), closeHistory);
      head.Margin = new Thickness(28, 18, 20, 14);
      var rule = new Border { Height = 1, Background = Ui.Hairline };
      var sheet = new DockPanel { Background = Ui.Sheet };
      DockPanel.SetDock(head, Dock.Top); DockPanel.SetDock(rule, Dock.Top);
      var panes = new Grid();
      panes.ColumnDefinitions.Add(new ColumnDefinition());
      panes.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
      panes.Children.Add(scroller); Grid.SetColumn(goalScroller, 1); panes.Children.Add(goalScroller);
      sheet.Children.Add(head); sheet.Children.Add(rule); sheet.Children.Add(panes);
      history.Children.Add(sheet); history.RenderTransform = historySlide;
      Automation.Id(history, "josi.chat.history", "Chat history");

      var open = Automation.Id(Ui.RoundButton(Glyph.History, "History", () => ShowHistory(true)), "josi.chat.history.open");
      historyBadge.Child = historyCount; historyBadge.Visibility = Visibility.Collapsed;
      var holder = new Grid(); holder.Children.Add(open); holder.Children.Add(historyBadge);
      modelName.VerticalAlignment = VerticalAlignment.Center;
      goalChip = Automation.Id(Ui.Pill("", () => ShowHistory(true)), "josi.chat.goals");
      goalChip.Visibility = Visibility.Collapsed;
      BarActions = Ui.Row(12, goalChip, modelName, holder);

      var root = new Grid();
      root.Children.Add(dock); root.Children.Add(history);
      Content = root;
      Loaded += delegate { if (!loadedModel) { loadedModel = true; LoadModelName(); } editor.Focus(); };
    }
    public void Detach() { voice.Stop(); }

    void ShowHistory(bool open) {
      if (open == historyOpen) return;
      historyOpen = open;
      var time = TimeSpan.FromMilliseconds(GhostView.Still ? 0 : 340);
      var rise = new System.Windows.Media.Animation.DoubleAnimation(open ? 0 : Math.Max(ActualHeight, 1), time) {
        EasingFunction = new System.Windows.Media.Animation.CubicEase { EasingMode = System.Windows.Media.Animation.EasingMode.EaseOut } };
      if (open) {
        historySlide.Y = ActualHeight; history.Visibility = Visibility.Visible;
        Dispatcher.BeginInvoke(new Action(() => { scroller.ScrollToEnd(); closeHistory.Focus(); }), System.Windows.Threading.DispatcherPriority.Loaded);
      }
      rise.Completed += delegate { if (!historyOpen) { history.Visibility = Visibility.Collapsed; editor.Focus(); } };
      historySlide.BeginAnimation(TranslateTransform.YProperty, rise);
    }
    /// Esc from the workspace. True if the panel was open.
    public bool CloseHistory() { if (!historyOpen) return false; ShowHistory(false); return true; }

    /// The one thing under the ghost: a short acknowledgement while Josi works, then her reply.
    void RenderStage() {
      var last = model.Messages.Count == 0 ? null : model.Messages[model.Messages.Count - 1];
      var mine = last != null && last["direction"].Text == "in";
      var thinking = Thinking;
      var failed = model.Turns.LastOrDefault(t => t["status"].Text == "failed");
      if (failed != null && last != null && !(mine && failed["inbound_message_id"].Text == last.Id) && model.Messages.Any(m => m.Id == failed["inbound_message_id"].Text)) failed = null;
      var key = model.SelectedThread + "|" + (last == null ? "" : last.Id) + "|" + thinking + "|" + (failed == null ? "" : failed.Id) + "|" + model.Busy;
      thinkingLabel.Text = model.TurnActivity.Length == 0 ? "Josi is thinking" : model.TurnActivity;
      if (key == stageKey) return;
      var sameLine = stageKey != null && stageKey.Substring(0, stageKey.LastIndexOf('|')) == key.Substring(0, key.LastIndexOf('|'));
      stageKey = key;
      if (sameLine) return;
      if (reveal != null) { reveal.Stop(); reveal = null; }
      var line = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
      if (failed != null) {
        Ui.Add(line, Label("Josi"), 0);
        Ui.Add(line, Automation.Id(new ChatTurnFailure(model, failed), "josi.chat.stage.failure", "Josi couldn't reply"), 8);
      } else if (last == null && !thinking) Greeting(line);
      else if (mine || thinking) {
        Ui.Add(line, Label("Josi"), 0);
        var seed = (last == null ? "" : last.Id).Sum(c => (int)c);
        Ui.Add(line, Sentence(Acknowledgements[seed % Acknowledgements.Length], Ui.Text), 7);
      } else Reply(line, last);
      stageLine.Content = line;
      if (GhostView.Still) return;
      var move = new TranslateTransform(0, 18); line.RenderTransform = move;
      var time = TimeSpan.FromMilliseconds(420);
      var ease = new System.Windows.Media.Animation.CubicEase { EasingMode = System.Windows.Media.Animation.EasingMode.EaseOut };
      move.BeginAnimation(TranslateTransform.YProperty, new System.Windows.Media.Animation.DoubleAnimation(0, time) { EasingFunction = ease });
      line.BeginAnimation(OpacityProperty, new System.Windows.Media.Animation.DoubleAnimation(0, 1, time));
    }
    static TextBlock Label(string who) {
      var label = Ui.T(who.ToUpperInvariant(), 11, FontWeights.SemiBold, Ui.Muted);
      label.HorizontalAlignment = HorizontalAlignment.Center;
      return label;
    }
    TextBlock Sentence(string text, Brush brush) {
      var sentence = Ui.T(text, 20, FontWeights.Medium, brush);
      sentence.TextAlignment = TextAlignment.Center; sentence.LineHeight = 28; sentence.MaxHeight = 28 * 4;
      sentence.TextTrimming = TextTrimming.WordEllipsis; sentence.HorizontalAlignment = HorizontalAlignment.Center;
      sentence.Cursor = Cursors.Hand; sentence.ToolTip = "Open the conversation";
      sentence.MouseLeftButtonUp += (s, e) => {
        for (var at = e.OriginalSource as FrameworkContentElement; at != null; at = at.Parent as FrameworkContentElement) if (at is Hyperlink) return;
        ShowHistory(true);
      };
      Automation.Id(sentence, "josi.chat.stage.text", text);
      return sentence;
    }
    void Greeting(StackPanel line) {
      var first = model.SignedInName.Split(' ')[0];
      var hello = Ui.T(first.Length == 0 ? "Hi, I'm Josi." : "Hi " + first + ", I'm Josi.", 24, FontWeights.Bold);
      hello.HorizontalAlignment = HorizontalAlignment.Center;
      var more = Ui.Secondary("Go on, give me something good to do."); more.HorizontalAlignment = HorizontalAlignment.Center;
      var chips = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Center };
      foreach (var text in Suggestions) {
        var chosen = text;
        var chip = Ui.Pill(chosen, () => { model.Draft = chosen; editor.Text = chosen; Send(); });
        chip.Margin = new Thickness(4);
        chips.Children.Add(chip);
      }
      var group = Ui.Stack(6, hello, more, chips);
      Ui.Add(line, Automation.Group("josi.chat.empty", "Hi, I'm Josi.", group), 0);
    }
    void Reply(StackPanel line, Wire message) {
      var parts = GhostController.Parts(message["body"].Text);
      var animate = freshReply == message.Id && !GhostView.Still;
      freshReply = null;
      Ui.Add(line, Label("Josi"), 0);
      var list = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
      Action showList = () => {
        var shown = parts.Items.Take(5).ToList();
        for (var i = 0; i < shown.Count; i++) {
          var item = Ui.T("", 15); Fill(item.Inlines, shown[i]);
          var row = Ui.Row(8, Ui.T((i + 1).ToString(), 15, FontWeights.Bold, Ui.Accent), item);
          Ui.Add(list, row, 4);
          if (animate) row.BeginAnimation(OpacityProperty, new System.Windows.Media.Animation.DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(320)) { BeginTime = TimeSpan.FromMilliseconds(i * 300) });
        }
        if (parts.Items.Count > 5) Ui.Add(list, Ui.T("And " + (parts.Items.Count - 5) + " more", 13, null, Ui.Muted), 4);
      };
      var lead = parts.Lead.Length > 0 ? parts.Lead : parts.Items.Count > 0 ? "" : message["body"].Text;
      if (lead.Length == 0) { showList(); Ui.Add(line, list, 8); return; }
      var sentence = Sentence(Plain(lead), Ui.Text);
      sentence.Inlines.Clear(); Fill(sentence.Inlines, lead);
      Ui.Add(line, sentence, 7); Ui.Add(line, list, 8);
      if (!animate) { showList(); return; }
      // Each word appears in its place: all of them are laid out from the start,
      // unseen, so nothing jumps. A word in a link or in bold keeps that styling.
      var words = new List<Run>(); var backs = new List<Brush>();
      Split(sentence.Inlines, words);
      foreach (var word in words) { backs.Add(word.Background); word.Background = null; word.Foreground = Brushes.Transparent; }
      var at = 0;
      var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(Math.Max(16, GhostController.RevealStepMs(words.Count))) };
      timer.Tick += delegate {
        if (at < words.Count) { words[at].ClearValue(TextElement.ForegroundProperty); words[at].Background = backs[at]; at++; }
        if (at < words.Count) return;
        timer.Stop(); showList();
      };
      reveal = timer; timer.Start();
    }
    /// Breaks every run into one run per word, in place, and lists them in reading order.
    static void Split(InlineCollection inlines, List<Run> words) {
      foreach (var inline in inlines.ToList()) {
        var span = inline as Span;
        if (span != null) { Split(span.Inlines, words); continue; }
        var run = inline as Run;
        if (run == null) continue;
        foreach (Match word in Regex.Matches(run.Text, @"\s*\S+\s*")) {
          var piece = new Run(word.Value) { FontFamily = run.FontFamily, Background = run.Background };
          inlines.InsertBefore(run, piece);
          words.Add(piece);
        }
        inlines.Remove(run);
      }
    }
    /// The words of a Markdown line, for screen readers and tooltips.
    static string Plain(string source) {
      var text = Regex.Replace(source ?? "", @"\[([^\]\n]+)\]\(https?://[^)\s]+\)", "$1");
      return Regex.Replace(text, @"\*\*|`", "");
    }
    public void Pause() { voice.Stop(); }
    static ControlTemplate EditorTemplate() {
      return (ControlTemplate)System.Windows.Markup.XamlReader.Parse("<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='TextBox'><Border Background='{TemplateBinding Background}'><ScrollViewer x:Name='PART_ContentHost' Margin='{TemplateBinding Padding}' Focusable='False'/></Border></ControlTemplate>");
    }

    async void LoadModelName() {
      var api = model.Api; if (api == null) return;
      await voice.Refresh(api);
      if (model.IsAdministrator) {
        try {
          var primary = (await api.Request("/admin/llm"))["primary"];
          if (model.Api == api) modelName.Text = primary["provider"].Text == "openai_subscription" ? "ChatGPT plan" : primary["model"].Text;
        } catch (Exception) { }
      }
      RenderComposer();
    }

    bool Thinking { get { return model.Turns.Any(t => t["status"].Text == "queued" || t["status"].Text == "running"); } }
    bool CanSend { get { return !model.Busy && (model.PendingMessage || model.Draft.Trim().Length > 0); } }

    void OnKey(object sender, KeyEventArgs e) {
      // Key.ImeProcessed is reported while an input method is composing, so a
      // Return that completes composition never sends.
      if (e.Key != Key.Enter && e.Key != Key.Return) return;
      var mods = Keyboard.Modifiers;
      if ((mods & ModifierKeys.Shift) != 0 || (mods & ModifierKeys.Alt) != 0) return;
      e.Handled = true;
      Send();
    }
    void Send() {
      if (!CanSend || voice.Mode == VoiceMode.Conversation) return;
      voice.Stop();
      model.Ghost.Set(GhostState.Received);
      ghostWaiting = true;
      model.Run(() => model.Send());
    }

    public void RefreshBusy() { RenderComposer(); }
    public void Refresh() {
      var thread = model.Threads.FirstOrDefault(t => t.Id == model.SelectedThread);
      title.Text = thread != null && thread["title"].Text.Length > 0 ? thread["title"].Text : "Conversation";
      if (editor.Text != model.Draft) { editor.Text = model.Draft; editor.CaretIndex = editor.Text.Length; }
      var goals = model.ChatGoals;
      var key = string.Join("|", model.Messages.Select(m => m.Json)) + "#" + string.Join("|", model.Turns.Select(t => t.Json)) + "#" + string.Join("|", goals.Select(g => g.Json));
      if (key != renderedKey) {
        renderedKey = key;
        RenderMessages(goals);
        var last = model.Messages.Count == 0 ? null : model.Messages[model.Messages.Count - 1].Id;
        var thinking = Thinking;
        if (last != lastMessageId || (thinking && !wasThinking)) scroller.ScrollToEnd();
        var count = model.Messages.Count;
        historyCount.Text = count.ToString(); historyBadge.Visibility = count < 2 ? Visibility.Collapsed : Visibility.Visible;
        lastMessageId = last; wasThinking = thinking;
      }
      RenderComposer();
    }

    void RenderMessages(List<Wire> goals) {
      Automation.BeginScope("chat");
      messages.Children.Clear();
      if (model.Messages.Count == 0) {
        var none = Ui.Secondary("Your conversation with Josi shows up here."); none.TextAlignment = TextAlignment.Center; none.Margin = new Thickness(0, 60, 0, 0);
        messages.Children.Add(none);
      }
      // josi.chat.turn.<n> is the n-th message you sent, josi.chat.reply.<n> the n-th
      // reply from Josi, josi.chat.failure.<n> the n-th reply that failed.
      int turns = 0, replies = 0, failures = 0;
      foreach (var message in model.Messages) {
        var incoming = message["direction"].Text == "in";
        var position = incoming ? ++turns : ++replies;
        Ui.Add(messages, Automation.Group("josi.chat." + (incoming ? "turn." : "reply.") + position, message["body"].Text, MessageRow(message, position)), 28);
        foreach (var turn in model.Turns.Where(t => t["status"].Text == "failed" && t["inbound_message_id"].Text == message.Id))
          Ui.Add(messages, Automation.Id(new ChatTurnFailure(model, turn), "josi.chat.failure." + (++failures), "Josi couldn't reply"), 12);
      }
      goalPanel.Children.Clear();
      foreach (var goal in goals) Ui.Add(goalPanel, new GoalCard(model, owner, goal, true), 16);
      goalScroller.Visibility = goals.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
      goalChip.Visibility = goalScroller.Visibility;
      goalChip.Content = goals.Count == 1 ? "1 task" : goals.Count + " tasks";
      System.Windows.Automation.AutomationProperties.SetName(goalChip, "Open tasks");
      foreach (var turn in model.Turns.Where(t => t["status"].Text == "failed" && !model.Messages.Any(m => m.Id == t["inbound_message_id"].Text)))
        Ui.Add(messages, Automation.Id(new ChatTurnFailure(model, turn), "josi.chat.failure." + (++failures), "Josi couldn't reply"), 12);
    }

    UIElement MessageRow(Wire message, int position) {
      if (message["direction"].Text == "in") {
        var bubbleStack = new StackPanel();
        foreach (var item in message["attachments"].List) Ui.Add(bubbleStack, Ui.Row(6, Ui.Icon(Glyph.Clip, 12, Ui.OnGold), Ui.T(item["filename"].Text, 12, null, Ui.OnGold)), 6);
        var body = Automation.Id(Ui.Copyable(message["body"].Text, 15, Ui.OnGold), "josi.chat.turn." + position + ".text");
        Ui.Add(bubbleStack, body, 8);
        var bubble = new Border { Background = Ui.GoldGradient, CornerRadius = new CornerRadius(20), Padding = new Thickness(18, 14, 18, 14), Child = bubbleStack, HorizontalAlignment = HorizontalAlignment.Right };
        var you = Ui.Caption("You"); you.HorizontalAlignment = HorizontalAlignment.Right;
        var column = Ui.Stack(7, bubble, you);
        column.MaxWidth = 640; column.HorizontalAlignment = HorizontalAlignment.Right; column.Margin = new Thickness(70, 0, 0, 0);
        return column;
      }
      var text = Automation.Id(Markdown(message["body"].Text), "josi.chat.reply." + position + ".text", message["body"].Text);
      Button copy = null;
      copy = Ui.IconButton(Glyph.Copy, "Copy message", () => {
        // The clipboard can be briefly held by another app; try a few times
        // and say so either way.
        var done = false;
        for (var attempt = 0; attempt < 5 && !done; attempt++) {
          try { Clipboard.SetDataObject(message["body"].Text, true); done = true; }
          catch (System.Runtime.InteropServices.ExternalException) { System.Threading.Thread.Sleep(40); }
        }
        copy.ToolTip = done ? "Copied" : "Could not copy. Select the text and press Ctrl+C.";
        copy.Content = Ui.Icon(done ? Glyph.Approve : Glyph.Copy, 14);
        var reset = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
        reset.Tick += delegate { reset.Stop(); copy.Content = Ui.Icon(Glyph.Copy, 14); copy.ToolTip = "Copy message"; };
        reset.Start();
      }, 14);
      Automation.Id(copy, "josi.chat.reply." + position + ".copy");
      var read = Automation.Id(Ui.IconButton(voice.Speaking ? Glyph.Stop : Glyph.Speaker, "Read aloud", () => voice.ToggleSpeak(message["body"].Text), 14), "josi.chat.reply." + position + ".read");
      read.IsEnabled = voice.Available;
      var turn = model.Turns.FirstOrDefault(t => t["assistant_message_id"].Text == message.Id);
      var knew = Automation.Id(Ui.IconButton(Glyph.List, "What Josi knew", () => ShowKnew(turn == null ? "" : turn.Id), 14), "josi.chat.reply." + position + ".knew");
      knew.IsEnabled = turn != null; knew.ToolTip = "What Josi knew for this reply";
      var column2 = new Border { Background = Ui.Frost, BorderBrush = Ui.Hairline, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(18), Padding = new Thickness(16, 12, 16, 8),
        Child = Ui.Stack(10, Ui.T("Josi", 13.5, FontWeights.SemiBold), text, Ui.Row(10, copy, read, knew)) };
      var grid = new Grid();
      grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
      grid.ColumnDefinitions.Add(new ColumnDefinition());
      var markElement = Ui.JosiMark(34); markElement.VerticalAlignment = VerticalAlignment.Top; markElement.Margin = new Thickness(0, 0, 15, 0);
      grid.Children.Add(markElement); Grid.SetColumn(column2, 1); grid.Children.Add(column2);
      return grid;
    }

    /// What a reply was given: memories, snippets recalled from earlier
    /// conversations, the summary of older messages, skills and memory rules.
    async void ShowKnew(string turnId) {
      var api = model.Api; if (api == null || turnId.Length == 0) return;
      Wire context;
      try { context = (await api.Request("/assistant/turn-context/" + api.Uuid(turnId)))["context"]; }
      catch (JosiException e) { Dialogs.Message(owner, "What Josi knew", e.Message); return; }
      var sheet = new Dialogs.Sheet(owner, "Josi", 600, "knew");
      var stack = Ui.Stack(12, Ui.T("What Josi knew for this reply", 17, FontWeights.SemiBold));
      Action<string, IEnumerable<string>, string> section = (title, items, empty) => {
        var list = items.Where(i => i.Length > 0).ToList();
        stack.Children.Add(Ui.T(title, 14, FontWeights.SemiBold));
        if (list.Count == 0) stack.Children.Add(Ui.Caption(empty));
        foreach (var item in list) stack.Children.Add(Ui.Copyable("• " + item, 13.5));
      };
      section("Memories", context["memories"].List.Select(m => m["content"].Text), "No saved memories matched.");
      section("From earlier conversations", context["recalled"].List.Select(r => r["at"].Text + (r["title"].Text.Length > 0 ? " · " + r["title"].Text : "") + " · " + r["snippet"].Text), "Nothing recalled.");
      section("Approved skills", context["skills"].List.Select(s => s["name"].Text + " (version " + s["version"].Integer + ")"), "No skill applied.");
      section("Memory rules", context["rules"].List.Select(r => r.Text), "No memory rules.");
      stack.Children.Add(Ui.Caption(context["historyMessages"].Integer + " earlier messages of this conversation were included"
        + (context["summaryUsed"].Flag ? ", plus Josi's notes on the older part." : ".")));
      var close = Ui.Pill("Close", () => sheet.Close(), true); close.IsDefault = true;
      stack.Children.Add(Ui.Spread(null, close));
      sheet.Body(stack);
      sheet.ShowDialog();
    }

    static ControlTemplate selectableTemplate;
    /// Inline Markdown as the Mac's Text(.init) renders it: bold, italic, code
    /// and HTTPS links, in a read-only box so any part can be selected and copied.
    public static RichTextBox Markdown(string source) {
      var block = new Paragraph { Margin = new Thickness(0), LineHeight = 23 };
      if (selectableTemplate == null)
        selectableTemplate = (ControlTemplate)System.Windows.Markup.XamlReader.Parse("<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='RichTextBox'><ScrollViewer x:Name='PART_ContentHost' Focusable='False' HorizontalScrollBarVisibility='Disabled' VerticalScrollBarVisibility='Disabled'/></ControlTemplate>");
      var box = new RichTextBox { IsReadOnly = true, IsDocumentEnabled = true, Background = Brushes.Transparent, BorderThickness = new Thickness(0),
        Padding = new Thickness(0), FontSize = 15, Foreground = Ui.Text, FontFamily = Ui.Font, Template = selectableTemplate,
        Document = new FlowDocument(block) { PagePadding = new Thickness(0), FontSize = 15, FontFamily = Ui.Font, Foreground = Ui.Text } };
      Fill(block.Inlines, Regex.Replace(source ?? "", @"(?m)^#{1,6}\s+", ""));
      return box;
    }
    static void Fill(InlineCollection inlines, string source) {
      var pattern = new Regex(@"(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?://[^)\s]+\)|\*[^*\n]+\*|_[^_\n]+_)");
      var index = 0;
      foreach (Match match in pattern.Matches(source ?? "")) {
        if (match.Index > index) inlines.Add(new Run(source.Substring(index, match.Index - index)));
        var token = match.Value;
        if (token.StartsWith("**")) inlines.Add(new Bold(new Run(token.Substring(2, token.Length - 4))));
        else if (token.StartsWith("`")) inlines.Add(new Run(token.Substring(1, token.Length - 2)) { FontFamily = Ui.Mono, Background = Ui.Raised });
        else if (token.StartsWith("[")) {
          var split = token.IndexOf("](", StringComparison.Ordinal);
          var label = token.Substring(1, split - 1); var url = token.Substring(split + 2, token.Length - split - 3);
          Uri target;
          if (Uri.TryCreate(url, UriKind.Absolute, out target) && (target.Scheme == "https" || target.Scheme == "http")) {
            var link = new Hyperlink(new Run(label)) { NavigateUri = target, Foreground = Ui.Accent, ToolTip = target.Host };
            link.RequestNavigate += (s, e) => { Automation.PopupResult = "link:" + e.Uri.Host; if (AppLinks.Testing) return; try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); } catch (Exception) { } };
            inlines.Add(link);
          } else inlines.Add(new Run(token));
        } else inlines.Add(new Italic(new Run(token.Substring(1, token.Length - 2))));
        index = match.Index + match.Length;
      }
      if (index < (source ?? "").Length) inlines.Add(new Run(source.Substring(index)));
      // A FlowDocument run shows "\n" as a space; keep the reply's line breaks.
      foreach (var run in inlines.OfType<Run>().Where(r => r.Text.Contains("\n")).ToList()) {
        var lines = run.Text.Replace("\r\n", "\n").Split('\n'); var at = (Inline)run;
        for (var i = 0; i < lines.Length; i++) {
          if (i > 0) { var br = new LineBreak(); inlines.InsertAfter(at, br); at = br; }
          var piece = new Run(lines[i]) { FontFamily = run.FontFamily, Background = run.Background };
          inlines.InsertAfter(at, piece); at = piece;
        }
        inlines.Remove(run);
      }
    }

    /// Tells the ghost what just changed. A thread's existing replies, goals and
    /// errors are history, so opening it plays nothing.
    void FollowGhost() {
      var ghost = model.Ghost;
      var failure = model.Turns.LastOrDefault(t => t["status"].Text == "failed");
      var failureId = failure == null ? null : failure.Id;
      var reply = model.Messages.LastOrDefault(m => m["direction"].Text != "in");
      var replyId = reply == null ? null : reply.Id;
      if (ghostThread != model.SelectedThread) {
        ghostThread = model.SelectedThread; ghostReply = replyId; ghostFailure = failureId; ghostGoals.Clear();
        ShowHistory(false);
        foreach (var goal in model.ChatGoals) ghostGoals[goal["goalId"].Text] = goal["state"].Text;
      } else {
        if (Thinking) ghostWaiting = true;
        if (replyId != ghostReply) {
          ghostReply = replyId;
          if (replyId != null && ghostWaiting) { ghostWaiting = false; freshReply = replyId; ghost.Replied(reply["body"].Text); }
        }
        if (failureId != ghostFailure) {
          ghostFailure = failureId;
          if (failureId != null && ghostWaiting) { ghostWaiting = false; ghost.Set(GhostState.Error); }
        }
        foreach (var goal in model.ChatGoals) {
          string before; var state = goal["state"].Text; var id = goal["goalId"].Text;
          if (state == "completed" && ghostGoals.TryGetValue(id, out before) && before != state) ghost.Set(GhostState.TaskDone);
          ghostGoals[id] = state;
        }
      }
      if (model.Error.Length > 0 && model.Error != ghostError) ghost.Set(GhostState.Error);
      ghostError = model.Error;
      ghost.Set(voice.Mode != VoiceMode.None ? GhostState.Voice : Thinking ? GhostState.Waiting : editor.Text.Trim().Length > 0 ? GhostState.Typing : GhostState.Idle);
      RenderStage();
    }

    void RenderComposer() {
      FollowGhost();
      Automation.BeginScope("chat");
      editor.IsEnabled = !model.PendingMessage && voice.Mode != VoiceMode.Conversation;
      attachments.Children.Clear();
      var attachmentNumber = 0;
      foreach (var item in model.DraftAttachments) {
        var id = item.Id;
        var remove = Automation.Id(Ui.IconButton(Glyph.Close, "Remove attachment from message", () => { model.DraftAttachments.RemoveAll(a => a.Id == id); RenderComposer(); }, 10), "josi.chat.attachment." + (++attachmentNumber) + ".remove");
        var chip = new Border { Background = Ui.Card, CornerRadius = new CornerRadius(14), Padding = new Thickness(10, 4, 4, 4), Margin = new Thickness(0, 0, 8, 0),
          Child = Ui.Row(6, Ui.Icon(Glyph.Clip, 12, Ui.Muted), Ui.Caption(item["filename"].Text), remove) };
        attachments.Children.Add(chip);
      }
      attachments.Visibility = model.DraftAttachments.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
      partial.Text = voice.Partial; partial.Visibility = voice.Partial.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
      voiceError.Text = voice.Error; voiceError.Visibility = voice.Error.Length == 0 ? Visibility.Collapsed : Visibility.Visible;

      left.Children.Clear(); right.Children.Clear();
      var attach = Automation.Id(Ui.RoundButton(Glyph.Plus, "Attach a file or photo", Attach, 42, Ui.Text), "josi.chat.attach");
      attach.IsEnabled = !model.Busy && !model.PendingMessage && model.DraftAttachments.Count < 10 && voice.Mode == VoiceMode.None;
      var settings = Automation.Id(Ui.PillIcon(Glyph.Chevron, voice.ModelLabel, () => Dialogs.VoiceSettings(owner, model, voice), false, "Voice models and settings"), "josi.chat.voice-settings");
      settings.IsEnabled = voice.Mode == VoiceMode.None;
      left.Children.Add(attach);
      if (Flags.VoiceBox) { settings.Margin = new Thickness(6, 0, 0, 0); left.Children.Add(settings); }

      var dictate = Automation.Id(Ui.RoundButton(voice.Mode == VoiceMode.Dictation ? Glyph.Stop : Glyph.Mic, voice.Mode == VoiceMode.Dictation ? "Done" : "Dictate", () => ToggleVoice(VoiceMode.Dictation), 42), "josi.chat.dictate");
      dictate.IsEnabled = !model.PendingMessage && !voice.Starting && voice.Mode != VoiceMode.Conversation;
      right.Children.Add(dictate);
      Button primary;
      // josi.chat.send is the one button in that place whatever it does right
      // now: send, retry delivery, start voice chat or end it. Its Name says which.
      if (voice.Mode == VoiceMode.Conversation) primary = Ui.RoundButton(Glyph.Stop, "End voice", voice.Stop, 42, Ui.OnGold, Ui.SendFill);
      else if (CanSend || !Flags.Talk) {
        primary = Ui.RoundButton(Glyph.Up, model.PendingMessage ? "Retry delivery" : "Send message", Send, 42, Ui.OnGold, Ui.SendFill);
        primary.IsEnabled = CanSend;
      } else {
        primary = Ui.RoundButton(Glyph.Wave, "Voice chat", () => ToggleVoice(VoiceMode.Conversation), 42, Ui.OnGold, Ui.SendFill);
        primary.IsEnabled = !voice.Starting && !model.Busy && voice.Mode == VoiceMode.None && model.DraftAttachments.Count == 0;
      }
      Automation.Id(primary, "josi.chat.send");
      primary.Margin = new Thickness(6, 0, 0, 0);
      right.Children.Add(primary);
      hint.Text = model.PendingMessage ? "Delivery is unconfirmed. Retry keeps the same message and attachments." : "Enter to send · Shift + Enter for a new line";
    }

    void Attach() {
      var dialog = new Microsoft.Win32.OpenFileDialog { Title = "Choose a file or photo to attach to this conversation.", CheckFileExists = true, Multiselect = false };
      if (dialog.ShowDialog(owner) != true) return;
      var path = dialog.FileName;
      model.Run(() => model.AttachFile(path));
    }
    void ToggleVoice(VoiceMode mode) {
      if (voice.Mode != VoiceMode.None) {
        if (voice.Mode == VoiceMode.Dictation && voice.Partial.Length > 0) AppendDraft(voice.Partial);
        voice.Stop(); return;
      }
      if (!voice.Available) {
        if (Flags.VoiceBox) Dialogs.VoiceSettings(owner, model, voice);
        else { voice.Error = "Voice isn't set up on this server."; RenderComposer(); }
        return;
      }
      var api = model.Api; if (api == null) return;
      voice.Start(mode, api, async text => {
        if (mode == VoiceMode.Dictation) { AppendDraft(text); return null; }
        return await model.VoiceTurn(text);
      });
    }
    void AppendDraft(string text) {
      var current = model.Draft ?? "";
      model.Draft = current + (current.Length == 0 || current.EndsWith(" ") || current.EndsWith("\n") ? "" : " ") + text;
      editor.Text = model.Draft; editor.CaretIndex = editor.Text.Length;
    }
  }
}
