using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Josi.Native {
  public sealed class WorkspaceView : UserControl, IRefresh {
    readonly AppModel model; readonly Window owner;
    readonly StackPanel nav = new StackPanel();
    readonly StackPanel threads = new StackPanel();
    readonly ContentControl detail = new ContentControl { Focusable = false };
    readonly Border footer = new Border();
    ChatView chat;
    TaskManagerView tasks;
    string shownSection;

    public WorkspaceView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      var grid = new Grid();
      grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(250) });
      grid.ColumnDefinitions.Add(new ColumnDefinition());

      var header = Ui.Spread(Ui.Row(10, Ui.JosiMark(38), Ui.T("Josi", 25, FontWeights.SemiBold)),
        Ui.IconButton(Glyph.Compose, "New conversation", () => model.Run(() => model.NewThread()), 18));
      header.Margin = new Thickness(18, 24, 14, 18);
      var list = new StackPanel { Margin = new Thickness(12, 0, 12, 12) };
      list.Children.Add(nav);
      list.Children.Add(new Border { Height = 1, Background = Ui.Border, Margin = new Thickness(0, 12, 0, 12) });
      var recent = Ui.Caption("Recent conversations"); recent.Margin = new Thickness(12, 0, 0, 5);
      list.Children.Add(recent);
      list.Children.Add(threads);
      var scroller = new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false };
      var sidebar = new DockPanel { Background = Ui.Sidebar };
      DockPanel.SetDock(header, Dock.Top); DockPanel.SetDock(footer, Dock.Bottom);
      footer.BorderBrush = Ui.Border; footer.BorderThickness = new Thickness(0, 1, 0, 0); footer.Padding = new Thickness(16);
      sidebar.Children.Add(header); sidebar.Children.Add(footer); sidebar.Children.Add(scroller);
      grid.Children.Add(sidebar);
      Grid.SetColumn(detail, 1); grid.Children.Add(detail);
      Content = grid;

      model.WorkspaceChanged += OnWorkspace;
      model.SectionChanged += OnSection;
      Refresh();
      OnSection();
    }
    public void Detach() {
      model.WorkspaceChanged -= OnWorkspace; model.SectionChanged -= OnSection;
      if (chat != null) chat.Detach();
    }
    void OnWorkspace() {
      RenderThreads();
      if (chat != null && shownSection == "chat") chat.Refresh();
      if (tasks != null && shownSection == "tasks") tasks.Refresh();
      var refresh = detail.Content as IWorkspaceRefresh;
      if (refresh != null) refresh.WorkspaceUpdated();
    }
    public void Refresh() {
      RenderNav(); RenderThreads(); RenderFooter();
      if (chat != null && shownSection == "chat") chat.RefreshBusy();
    }

    void RenderNav() {
      nav.Children.Clear();
      Item("Conversations", Glyph.Chat, "chat");
      Item("Task Manager", Glyph.Checklist, "tasks");
      Item("Memory", Glyph.Memory, "memory");
      Item("Automation", Glyph.Automation, "automation");
      Item("Vault", Glyph.Vault, "vault");
      Item("Your Settings", Glyph.Person, "account");
      Item("Messaging Apps", Glyph.Send, "channels");
      if (model.IsAdministrator) {
        Item("Models", Glyph.Layers, "models");
        Item("People", Glyph.People, "people");
        Item("Email Delivery", Glyph.Mail, "mail-settings");
        Item("Backups", Glyph.Backups, "backups");
      }
      Item("Server", Glyph.Server, "server");
    }
    void Item(string title, string glyph, string section) {
      var on = model.Section == section;
      var label = Ui.T(title, 14, on ? FontWeights.Medium : FontWeights.Normal, null); label.ClearValue(TextBlock.ForegroundProperty);
      label.TextWrapping = TextWrapping.NoWrap; label.TextTrimming = TextTrimming.CharacterEllipsis;
      var icon = Ui.Icon(glyph, 17); icon.Width = 23; icon.TextAlignment = TextAlignment.Center;
      var row = Ui.Row(12, icon, label);
      var button = new Button { Content = row, Style = (Style)Ui.Resources["Plain"], Padding = new Thickness(12, 10, 12, 10),
        Foreground = on ? Ui.Orange : Ui.Muted, Background = on ? Ui.OrangeSoft : Brushes.Transparent, Margin = new Thickness(0, 0, 0, 3) };
      Ui.Name(button, title, null);
      button.IsEnabled = !model.Busy;
      button.Click += delegate { Go(section); };
      nav.Children.Add(button);
    }
    void Go(string section) {
      model.Section = section;
      if (section == "automation") model.Run(() => model.LoadAutomation());
      else if (section == "server") model.RefreshLocal();
      else if (section == "chat" || section == "tasks") model.Run(() => model.ReloadWorkspace());
    }

    void RenderThreads() {
      threads.Children.Clear();
      foreach (var thread in model.Threads) {
        var id = thread.Id; var on = model.SelectedThread == id;
        var title = Ui.T(thread["title"].Text.Length == 0 ? "Conversation" : thread["title"].Text, 13.5); title.ClearValue(TextBlock.ForegroundProperty);
        title.TextWrapping = TextWrapping.NoWrap; title.TextTrimming = TextTrimming.CharacterEllipsis;
        var icon = Ui.Icon(Glyph.Bubble, 14); icon.Width = 22;
        var button = new Button { Content = Ui.Row(10, icon, title), Style = (Style)Ui.Resources["Plain"], Padding = new Thickness(12, 9, 12, 9),
          Foreground = on ? Ui.Text : Ui.Muted };
        Ui.Name(button, title.Text, null);
        button.IsEnabled = !model.Busy;
        button.Click += delegate { model.Run(() => model.SelectThread(id)); };
        threads.Children.Add(button);
      }
    }
    void RenderFooter() {
      var initials = new string(model.SignedInName.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Take(2).Select(w => w[0]).ToArray());
      var avatar = new Border { Width = 36, Height = 36, CornerRadius = new CornerRadius(18), Background = Ui.Raised,
        Child = new TextBlock { Text = initials.ToUpperInvariant(), FontWeight = FontWeights.Bold, Foreground = Ui.Text, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } };
      var name = Ui.T(model.SignedInName, 13.5, FontWeights.SemiBold); name.TextWrapping = TextWrapping.NoWrap; name.TextTrimming = TextTrimming.CharacterEllipsis;
      var where = Ui.Caption(model.Address.Contains("localhost") ? "Local server" : model.Address); where.TextWrapping = TextWrapping.NoWrap; where.TextTrimming = TextTrimming.CharacterEllipsis;
      var who = Ui.Stack(3, name, where); who.MaxWidth = 140;
      var signOut = Ui.IconButton(Glyph.SignOut, "Sign out", () => model.Run(() => model.SignOut()));
      signOut.IsEnabled = !model.Busy;
      footer.Child = Ui.Spread(Ui.Row(10, avatar, who), signOut);
    }

    void OnSection() {
      RenderNav();
      if (shownSection == model.Section && detail.Content != null) return;
      if (shownSection == "chat" && chat != null) chat.Pause();
      shownSection = model.Section;
      UIElement view;
      switch (model.Section) {
        case "tasks": tasks = tasks ?? new TaskManagerView(model, owner); tasks.Refresh(); view = tasks; break;
        case "memory": view = new MemoryView(model, owner); break;
        case "automation": view = new AutomationView(model, owner); break;
        case "vault": view = new VaultView(model, owner); break;
        case "account": view = new AccountView(model, owner); break;
        case "channels": view = new ChannelsView(model, owner); break;
        case "models": view = model.IsAdministrator ? new ModelsView(model, owner) : null; break;
        case "people": view = model.IsAdministrator ? new PeopleView(model, owner) : null; break;
        case "mail-settings": view = model.IsAdministrator ? new MailSettingsView(model, owner) : null; break;
        case "backups": view = model.IsAdministrator ? new BackupsView(model, owner) : null; break;
        case "server": view = new ServerView(model, owner); break;
        default: chat = chat ?? new ChatView(model, owner); chat.Refresh(); view = chat; break;
      }
      detail.Content = view;
    }
  }

  public interface IWorkspaceRefresh { void WorkspaceUpdated(); }
}
