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
    readonly TextBlock title = Ui.T("Conversation", 18, FontWeights.SemiBold);
    readonly TextBlock modelName = Ui.Caption("");
    readonly StackPanel messages = new StackPanel { MaxWidth = 900, Margin = new Thickness(28) };
    readonly ScrollViewer scroller;
    readonly TextBox editor;
    readonly WrapPanel attachments = new WrapPanel();
    readonly TextBlock partial = Ui.T("", 13.5, null, Ui.Muted);
    readonly TextBlock voiceError = Ui.T("", 12, null, Ui.Orange);
    readonly StackPanel left = new StackPanel { Orientation = Orientation.Horizontal };
    readonly StackPanel right = new StackPanel { Orientation = Orientation.Horizontal };
    readonly TextBlock hint = Ui.Caption("");
    readonly Voice voice;
    string renderedKey, lastMessageId;
    bool wasThinking, loadedModel;

    public ChatView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      voice = new Voice(model);
      voice.Changed += RenderComposer;

      var header = Ui.Spread(Ui.Stack(5, title, Ui.Caption("Conversation")), modelName);
      header.Margin = new Thickness(28, 24, 28, 18);
      var rule = new Border { Height = 1, Background = Ui.Border, Margin = new Thickness(24, 0, 24, 0) };
      scroller = new ScrollViewer { Content = messages, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false };

      editor = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 44, MaxHeight = 140,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = Brushes.Transparent, BorderThickness = new Thickness(0),
        FontSize = 15, Padding = new Thickness(3, 6, 3, 6) };
      editor.Template = EditorTemplate();
      Ui.Placeholder(editor, "Message Josi…", Brushes.Transparent);
      System.Windows.Automation.AutomationProperties.SetName(editor, "Message Josi");
      System.Windows.Automation.AutomationProperties.SetHelpText(editor, "Enter sends the message. Shift+Enter starts a new line.");
      editor.PreviewKeyDown += OnKey;
      editor.TextChanged += delegate { model.Draft = editor.Text; RenderComposer(); };

      var controls = new DockPanel { LastChildFill = false };
      DockPanel.SetDock(left, Dock.Left); DockPanel.SetDock(right, Dock.Right);
      controls.Children.Add(left); controls.Children.Add(right);
      var composerStack = Ui.Stack(10, attachments, editor, partial, voiceError, controls);
      var composer = new Border { Child = composerStack, Padding = new Thickness(16), CornerRadius = new CornerRadius(23),
        Background = new SolidColorBrush(Color.FromArgb(0xBF, 0x1F, 0x28, 0x3D)), BorderBrush = new SolidColorBrush(Color.FromArgb(0x59, 0x9D, 0xAB, 0xBE)),
        BorderThickness = new Thickness(1), MaxWidth = 882, Margin = new Thickness(24, 8, 24, 10) };
      hint.HorizontalAlignment = HorizontalAlignment.Center; hint.Margin = new Thickness(0, 0, 0, 16);

      var dock = new DockPanel();
      DockPanel.SetDock(header, Dock.Top); DockPanel.SetDock(rule, Dock.Top);
      DockPanel.SetDock(hint, Dock.Bottom); DockPanel.SetDock(composer, Dock.Bottom);
      dock.Children.Add(header); dock.Children.Add(rule); dock.Children.Add(hint); dock.Children.Add(composer); dock.Children.Add(scroller);
      Content = dock;
      Loaded += delegate { if (!loadedModel) { loadedModel = true; LoadModelName(); } editor.Focus(); };
    }
    public void Detach() { voice.Stop(); }
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
        lastMessageId = last; wasThinking = thinking;
      }
      RenderComposer();
    }

    void RenderMessages(List<Wire> goals) {
      messages.Children.Clear();
      if (model.Messages.Count == 0) {
        var welcome = Ui.Stack(16, Ui.JosiMark(64), Ui.T("What would you like to get done?", 21, FontWeights.SemiBold),
          Ui.Secondary("Ask Josi, attach a photo, or start a voice conversation."));
        foreach (FrameworkElement child in welcome.Children) { child.HorizontalAlignment = HorizontalAlignment.Center; var t = child as TextBlock; if (t != null) t.TextAlignment = TextAlignment.Center; }
        welcome.Margin = new Thickness(0, 70, 0, 30);
        messages.Children.Add(welcome);
      }
      foreach (var message in model.Messages) {
        Ui.Add(messages, MessageRow(message), 28);
        foreach (var turn in model.Turns.Where(t => t["status"].Text == "failed" && t["inbound_message_id"].Text == message.Id))
          Ui.Add(messages, new ChatTurnFailure(model, turn), 12);
      }
      foreach (var goal in goals) Ui.Add(messages, new GoalCard(model, owner, goal, true), 20);
      foreach (var turn in model.Turns.Where(t => t["status"].Text == "failed" && !model.Messages.Any(m => m.Id == t["inbound_message_id"].Text)))
        Ui.Add(messages, new ChatTurnFailure(model, turn), 12);
      if (Thinking) Ui.Add(messages, Ui.Thinking(), 20);
    }

    UIElement MessageRow(Wire message) {
      if (message["direction"].Text == "in") {
        var bubbleStack = new StackPanel();
        foreach (var item in message["attachments"].List) Ui.Add(bubbleStack, Ui.Row(6, Ui.Icon(Glyph.Clip, 12, Ui.Muted), Ui.Caption(item["filename"].Text)), 6);
        var body = Ui.Copyable(message["body"].Text, 15);
        Ui.Add(bubbleStack, body, 8);
        var bubble = new Border { Background = Ui.Raised, CornerRadius = new CornerRadius(20), Padding = new Thickness(18, 14, 18, 14), Child = bubbleStack, HorizontalAlignment = HorizontalAlignment.Right };
        var you = Ui.Caption("You"); you.HorizontalAlignment = HorizontalAlignment.Right;
        var column = Ui.Stack(7, bubble, you);
        column.MaxWidth = 640; column.HorizontalAlignment = HorizontalAlignment.Right; column.Margin = new Thickness(70, 0, 0, 0);
        return column;
      }
      var text = Markdown(message["body"].Text);
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
      var read = Ui.IconButton(voice.Speaking ? Glyph.Stop : Glyph.Speaker, "Read aloud", () => voice.ToggleSpeak(message["body"].Text), 14);
      read.IsEnabled = voice.Available;
      var column2 = Ui.Stack(12, Ui.T("Josi", 13.5, FontWeights.SemiBold), text, Ui.Row(10, copy, read));
      var grid = new Grid();
      grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
      grid.ColumnDefinitions.Add(new ColumnDefinition());
      var markElement = Ui.JosiMark(34); markElement.VerticalAlignment = VerticalAlignment.Top; markElement.Margin = new Thickness(0, 0, 15, 0);
      grid.Children.Add(markElement); Grid.SetColumn(column2, 1); grid.Children.Add(column2);
      return grid;
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
      Fill(block, source);
      return box;
    }
    static void Fill(Paragraph block, string source) {
      var pattern = new Regex(@"(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?://[^)\s]+\)|\*[^*\n]+\*|_[^_\n]+_)");
      var index = 0;
      foreach (Match match in pattern.Matches(source ?? "")) {
        if (match.Index > index) block.Inlines.Add(new Run(source.Substring(index, match.Index - index)));
        var token = match.Value;
        if (token.StartsWith("**")) block.Inlines.Add(new Bold(new Run(token.Substring(2, token.Length - 4))));
        else if (token.StartsWith("`")) block.Inlines.Add(new Run(token.Substring(1, token.Length - 2)) { FontFamily = Ui.Mono, Background = Ui.Raised });
        else if (token.StartsWith("[")) {
          var split = token.IndexOf("](", StringComparison.Ordinal);
          var label = token.Substring(1, split - 1); var url = token.Substring(split + 2, token.Length - split - 3);
          Uri target;
          if (Uri.TryCreate(url, UriKind.Absolute, out target) && (target.Scheme == "https" || target.Scheme == "http")) {
            var link = new Hyperlink(new Run(label)) { NavigateUri = target, Foreground = Ui.Orange, ToolTip = target.Host };
            link.RequestNavigate += (s, e) => { try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); } catch (Exception) { } };
            block.Inlines.Add(link);
          } else block.Inlines.Add(new Run(token));
        } else block.Inlines.Add(new Italic(new Run(token.Substring(1, token.Length - 2))));
        index = match.Index + match.Length;
      }
      if (index < (source ?? "").Length) block.Inlines.Add(new Run(source.Substring(index)));
      // A FlowDocument run shows "\n" as a space; keep the reply's line breaks.
      foreach (var run in block.Inlines.OfType<Run>().Where(r => r.Text.Contains("\n")).ToList()) {
        var lines = run.Text.Replace("\r\n", "\n").Split('\n'); var at = (Inline)run;
        for (var i = 0; i < lines.Length; i++) {
          if (i > 0) { var br = new LineBreak(); block.Inlines.InsertAfter(at, br); at = br; }
          var piece = new Run(lines[i]) { FontFamily = run.FontFamily, Background = run.Background };
          block.Inlines.InsertAfter(at, piece); at = piece;
        }
        block.Inlines.Remove(run);
      }
    }

    void RenderComposer() {
      editor.IsEnabled = !model.PendingMessage && voice.Mode != VoiceMode.Conversation;
      attachments.Children.Clear();
      foreach (var item in model.DraftAttachments) {
        var id = item.Id;
        var remove = Ui.IconButton(Glyph.Close, "Remove attachment from message", () => { model.DraftAttachments.RemoveAll(a => a.Id == id); RenderComposer(); }, 10);
        var chip = new Border { Background = Ui.Card, CornerRadius = new CornerRadius(14), Padding = new Thickness(10, 4, 4, 4), Margin = new Thickness(0, 0, 8, 0),
          Child = Ui.Row(6, Ui.Icon(Glyph.Clip, 12, Ui.Muted), Ui.Caption(item["filename"].Text), remove) };
        attachments.Children.Add(chip);
      }
      attachments.Visibility = model.DraftAttachments.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
      partial.Text = voice.Partial; partial.Visibility = voice.Partial.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
      voiceError.Text = voice.Error; voiceError.Visibility = voice.Error.Length == 0 ? Visibility.Collapsed : Visibility.Visible;

      left.Children.Clear(); right.Children.Clear();
      var attach = Ui.PillIcon(Glyph.Plus, null, Attach, false, "Attach a file or photo");
      attach.IsEnabled = !model.Busy && !model.PendingMessage && model.DraftAttachments.Count < 10 && voice.Mode == VoiceMode.None;
      var settings = Ui.PillIcon(Glyph.Chevron, voice.ModelLabel, () => Dialogs.VoiceSettings(owner, model, voice), false, "Voice models and settings");
      settings.IsEnabled = voice.Mode == VoiceMode.None;
      Ui.Add(left, attach, 8); Ui.Add(left, settings, 8);

      var dictate = Ui.PillIcon(voice.Mode == VoiceMode.Dictation ? Glyph.Stop : Glyph.Mic, voice.Mode == VoiceMode.Dictation ? "Done" : "Dictate", () => ToggleVoice(VoiceMode.Dictation));
      dictate.IsEnabled = !model.PendingMessage && !voice.Starting && voice.Mode != VoiceMode.Conversation;
      Ui.Add(right, dictate, 8);
      Button primary;
      if (voice.Mode == VoiceMode.Conversation) primary = Ui.PillIcon(Glyph.Stop, "End voice", voice.Stop, true);
      else if (CanSend) primary = Ui.PillIcon(Glyph.Up, null, Send, true, model.PendingMessage ? "Retry delivery" : "Send message");
      else {
        primary = Ui.PillIcon(Glyph.Wave, "Voice chat", () => ToggleVoice(VoiceMode.Conversation), true);
        primary.IsEnabled = !voice.Starting && !model.Busy && voice.Mode == VoiceMode.None && model.DraftAttachments.Count == 0;
      }
      Ui.Add(right, primary, 8);
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
      if (!voice.Available) { Dialogs.VoiceSettings(owner, model, voice); return; }
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
