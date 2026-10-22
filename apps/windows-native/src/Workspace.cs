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
    readonly TextBox threadSearch = Ui.Input("Search conversations");
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
      threadSearch.Margin = new Thickness(4, 0, 4, 6);
      threadSearch.TextChanged += delegate { RenderThreads(); };
      list.Children.Add(threadSearch);
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
      Item("Approvals", Glyph.Approve, "approvals");
      Item("Calendar", Glyph.Calendar, "calendar");
      Item("Contacts", Glyph.Contact, "contacts");
      Item("Files", Glyph.Folder, "files");
      Item("Reminders", Glyph.Clock, "reminders");
      Group("Your assistant");
      Item("Memory", Glyph.Memory, "memory");
      Item("Personalization", Glyph.Emoji, "personalization");
      Item("Email Templates", Glyph.Document, "templates");
      Item("Workflows", Glyph.Flow, "workflows");
      Item("Automation", Glyph.Automation, "automation");
      Item("Migrate", Glyph.Import, "migration");
      Group("Account");
      Item("Connections", Glyph.Link, "connections");
      Item("Vault", Glyph.Vault, "vault");
      Item("Messaging Apps", Glyph.Send, "channels");
      Item("Usage", Glyph.Chart, "usage");
      Item("Your Settings", Glyph.Person, "account");
      Item("Family", Glyph.Home, "family");
      Item("Companion Apps", Glyph.Phone, "apps");
      if (model.IsAdministrator) {
        Group("Administration");
        Item("Overview", Glyph.Health, "overview");
        Item("Getting Started", Glyph.List, "checklist");
        Item("Models", Glyph.Layers, "models");
        Item("People", Glyph.People, "people");
        Item("Connectors", Glyph.Plug, "connectors");
        Item("Integrations", Glyph.Code, "integrations");
        Item("Custom APIs", Glyph.Code, "custom-apis");
        Item("Workflow Providers", Glyph.Flow, "workflow-providers");
        Item("Approval Policy", Glyph.Shield, "policy");
        Item("Parental Controls", Glyph.Home, "parental");
        Item("Storage", Glyph.Folder, "storage");
        Item("Email Delivery", Glyph.Mail, "mail-settings");
        Item("Backups", Glyph.Backups, "backups");
        Item("Voice Box", Glyph.Speaker, "voice-box");
        Item("PC Control", Glyph.Desktop, "pc-control");
        Item("Improvements", Glyph.Chart, "improvements");
        Item("Workspace", Glyph.Settings, "workspace");
        Item("Network", Glyph.Globe, "network");
        Item("Maintenance", Glyph.Repair, "maintenance");
        Item("Audit Log", Glyph.History, "audit");
      }
      Item("Server", Glyph.Server, "server");
    }
    void Group(string title) {
      var label = Ui.Caption(title.ToUpperInvariant()); label.Margin = new Thickness(12, 14, 0, 6); label.FontWeight = FontWeights.SemiBold;
      nav.Children.Add(label);
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
      var term = threadSearch.Text.Trim();
      foreach (var thread in model.Threads) {
        if (term.Length > 0 && thread["title"].Text.IndexOf(term, StringComparison.CurrentCultureIgnoreCase) < 0) continue;
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
        case "approvals": view = new ApprovalsView(model, owner); break;
        case "calendar": view = new CalendarView(model, owner); break;
        case "contacts": view = new ContactsView(model, owner); break;
        case "files": view = new FilesView(model, owner); break;
        case "reminders": view = new RemindersView(model, owner); break;
        case "personalization": view = new PersonalizationView(model, owner); break;
        case "templates": view = new TemplatesView(model, owner); break;
        case "workflows": view = new WorkflowsView(model, owner); break;
        case "migration": view = new MigrationView(model, owner); break;
        case "connections": view = new ConnectionsView(model, owner); break;
        case "usage": view = new UsageView(model, owner); break;
        case "family": view = new FamilyView(model, owner); break;
        case "parental": view = model.IsAdministrator ? new ParentalControlsView(model, owner) : null; break;
        case "apps": view = ComingSoonPage.Build("Companion Apps", "There is no iPhone or Android build of Josi yet. When one exists it will be linked here.", "Signing in will use your email address and normal Josi password. A small directory service tells the app which installation owns your address; it never receives your password or anything else from this installation. Your administrator adds your address to the approved list first."); break;
        case "overview": view = model.IsAdministrator ? new OverviewView(model, owner) : null; break;
        case "checklist": view = model.IsAdministrator ? new ChecklistView(model, owner) : null; break;
        case "connectors": view = model.IsAdministrator ? new ConnectorsView(model, owner) : null; break;
        case "integrations": view = model.IsAdministrator ? new IntegrationsView(model, owner) : null; break;
        case "custom-apis": view = model.IsAdministrator ? new CustomApisView(model, owner) : null; break;
        case "workflow-providers": view = model.IsAdministrator ? new WorkflowAdminView(model, owner) : null; break;
        case "policy": view = model.IsAdministrator ? new PolicyView(model, owner) : null; break;
        case "storage": view = model.IsAdministrator ? new StorageAdminView(model, owner) : null; break;
        case "voice-box": view = model.IsAdministrator ? new VoiceBoxView(model, owner) : null; break;
        case "pc-control": view = model.IsAdministrator ? new PcControlView(model, owner) : null; break;
        case "improvements": view = model.IsAdministrator ? new ImprovementsView(model, owner) : null; break;
        case "workspace": view = model.IsAdministrator ? new WorkspaceSettingsView(model, owner) : null; break;
        case "network": view = model.IsAdministrator ? new NetworkView(model, owner) : null; break;
        case "maintenance": view = model.IsAdministrator ? new MaintenanceView(model, owner) : null; break;
        case "audit": view = model.IsAdministrator ? new AuditView(model, owner) : null; break;
        default: chat = chat ?? new ChatView(model, owner); chat.Refresh(); view = chat; break;
      }
      detail.Content = view;
    }
  }

  public interface IWorkspaceRefresh { void WorkspaceUpdated(); }

  static class ComingSoonPage {
    /// A section the product has not released yet: said plainly, nothing to press.
    public static UIElement Build(string title, string detail, string more) {
      return Ui.Scroll(Ui.Stack(20, Ui.Row(10, Ui.Title2(title), ModelText.Pill("Coming soon", false)), Ui.CardBox(null, Ui.Secondary(detail), Ui.Caption(more))), Ui.PageWidth, 30);
    }
  }
}
