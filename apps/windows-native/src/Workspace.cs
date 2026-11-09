using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace Josi.Native {
  public sealed class WorkspaceView : UserControl, IRefresh {
    readonly AppModel model; readonly Window owner;
    readonly StackPanel nav = new StackPanel();
    readonly StackPanel threads = new StackPanel();
    readonly ContentControl detail = new ContentControl { Focusable = false };
    readonly Border footer = new Border();
    readonly TextBox threadSearch = Ui.Input("Search conversations");
    const double MenuWidth = 340;
    readonly Grid overlay = new Grid { Visibility = Visibility.Collapsed };
    readonly Border menuPanel = new Border { Width = MenuWidth, HorizontalAlignment = HorizontalAlignment.Left, Background = Ui.Sheet, BorderBrush = Ui.Hairline, BorderThickness = new Thickness(0, 0, 1, 0) };
    readonly TranslateTransform menuSlide = new TranslateTransform(-MenuWidth, 0);
    readonly TextBlock barTitle = Ui.T("Josi", 18, FontWeights.Bold);
    readonly TextBlock barStatus = Ui.T("online", 12, null, Ui.Muted);
    readonly ContentControl barRight = new ContentControl { Focusable = false, VerticalAlignment = VerticalAlignment.Center };
    readonly ScrollViewer menuScroller;
    Button menuButton;
    bool menuOpen;
    ChatView chat;
    TaskManagerView tasks;
    string shownSection;
    // Item 39: the sidebar is drawn once and then only touched where something
    // changed, and a section page is kept once built, so a click no longer
    // tears the whole left side down and rebuilds the page from nothing.
    readonly System.Collections.Generic.Dictionary<string, Button> navButtons = new System.Collections.Generic.Dictionary<string, Button>();
    readonly System.Collections.Generic.Dictionary<string, TextBlock> navLabels = new System.Collections.Generic.Dictionary<string, TextBlock>();
    readonly System.Collections.Generic.Dictionary<string, UIElement> views = new System.Collections.Generic.Dictionary<string, UIElement>();
    readonly System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, Button>> threadButtons = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, Button>>();
    bool navAdmin; string threadsKey, footerKey;

    public WorkspaceView(AppModel model, Window owner) {
      this.model = model; this.owner = owner;
      var grid = new Grid();
      grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
      grid.RowDefinitions.Add(new RowDefinition());

      Automation.BeginScope("sidebar");
      var closeMenu = Automation.Id(Ui.RoundButton(Glyph.Close, "Close menu", () => ShowMenu(false), 40), "josi.menu.close");
      var header = Ui.Spread(Ui.Row(10, closeMenu, Ui.JosiMark(38), Ui.T("Josi", 25, FontWeights.SemiBold)),
        Automation.Id(Ui.IconButton(Glyph.Compose, "New conversation", () => { ShowMenu(false); model.Run(() => model.NewThread()); }, 18), "josi.sidebar.new-conversation"));
      header.Margin = new Thickness(18, 24, 14, 18);
      var list = new StackPanel { Margin = new Thickness(12, 0, 12, 12) };
      list.Children.Add(nav);
      list.Children.Add(new Border { Height = 1, Background = Ui.Border, Margin = new Thickness(0, 12, 0, 12) });
      var recent = Ui.Caption("Recent conversations"); recent.Margin = new Thickness(12, 0, 0, 5);
      list.Children.Add(recent);
      Automation.Id(threadSearch, "josi.sidebar.search");
      threadSearch.Margin = new Thickness(4, 0, 4, 6);
      threadSearch.TextChanged += delegate { RenderThreads(); };
      list.Children.Add(threadSearch);
      list.Children.Add(threads);
      menuScroller = new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false };
      var sidebar = new DockPanel();
      DockPanel.SetDock(header, Dock.Top); DockPanel.SetDock(footer, Dock.Bottom);
      footer.BorderBrush = Ui.Hairline; footer.BorderThickness = new Thickness(0, 1, 0, 0); footer.Padding = new Thickness(16);
      sidebar.Children.Add(header); sidebar.Children.Add(footer); sidebar.Children.Add(menuScroller);
      menuPanel.Child = sidebar; menuPanel.RenderTransform = menuSlide;
      Automation.Id(menuPanel, "josi.menu", "Josi menu");

      menuButton = Automation.Id(Ui.RoundButton(Glyph.Menu, "Menu", () => ShowMenu(true)), "josi.menu.open");
      var mark = Ui.JosiMark(38);
      var bar = new DockPanel { Margin = new Thickness(16, 12, 16, 8), LastChildFill = false };
      var brand = Ui.Row(12, menuButton, mark, Ui.Stack(1, barTitle, barStatus));
      DockPanel.SetDock(brand, Dock.Left); DockPanel.SetDock(barRight, Dock.Right);
      Automation.Id(barStatus, "josi.status.line");
      bar.Children.Add(brand); bar.Children.Add(barRight);
      grid.Children.Add(bar);
      Grid.SetRow(detail, 1); grid.Children.Add(detail);

      var scrim = new Border { Background = Ui.Scrim };
      scrim.MouseLeftButtonDown += (s, e) => { e.Handled = true; ShowMenu(false); };
      overlay.Children.Add(scrim); overlay.Children.Add(menuPanel);
      Grid.SetRowSpan(overlay, 2); grid.Children.Add(overlay);
      Content = grid;

      owner.PreviewKeyDown += OnEscape;
      model.Ghost.StateChanged += ShowStatus;
      Updates.NotifyIfNewer();

      model.WorkspaceChanged += OnWorkspace;
      model.SectionChanged += OnSection;
      Refresh();
      OnSection();
    }
    /// Slides the menu in over the stage. Esc, a click outside it, or picking an item closes it.
    void ShowMenu(bool open) {
      if (open == menuOpen) return;
      menuOpen = open;
      var quick = GhostView.Still;
      var time = TimeSpan.FromMilliseconds(quick ? 0 : 280);
      var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
      if (open) { overlay.Visibility = Visibility.Visible; menuScroller.ScrollToTop(); }
      var slide = new DoubleAnimation(open ? 0 : -MenuWidth, time) { EasingFunction = ease };
      slide.Completed += delegate {
        if (menuOpen) {
          Button first;
          if (navButtons.TryGetValue(model.Section, out first) || navButtons.TryGetValue("chat", out first)) first.Focus();
          return;
        }
        overlay.Visibility = Visibility.Collapsed;
        menuButton.Focus();
      };
      menuSlide.BeginAnimation(TranslateTransform.XProperty, slide);
      overlay.Children[0].BeginAnimation(OpacityProperty, new DoubleAnimation(open ? 0 : 1, open ? 1 : 0, time));
    }
    void ShowStatus() {
      var state = model.Ghost.State;
      barStatus.Text = state == JosiState.Listening ? "listening…" : state == JosiState.Thinking ? "thinking…" : state == JosiState.Speaking ? "speaking…" : "online";
      barStatus.Foreground = state == JosiState.Online ? Ui.Muted : Ui.Accent;
    }
    void OnEscape(object sender, System.Windows.Input.KeyEventArgs e) {
      if (e.Key != System.Windows.Input.Key.Escape) return;
      if (menuOpen) { ShowMenu(false); e.Handled = true; }
      else if (chat != null && chat.CloseHistory()) e.Handled = true;
    }
    public void Detach() {
      owner.PreviewKeyDown -= OnEscape;
      model.Ghost.StateChanged -= ShowStatus;
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
      if (nav.Children.Count > 0 && navAdmin == model.IsAdministrator) { SyncNav(); return; }
      navAdmin = model.IsAdministrator;
      nav.Children.Clear(); navButtons.Clear(); navLabels.Clear();
      Group("Workspace");
      Item("My World", Glyph.Person, "my-world");
      Item("Chat", Glyph.Chat, "chat");
      Item("Tasks", Glyph.Checklist, "tasks");
      Item("Approvals", Glyph.Approve, "approvals");
      Item("Calendar", Glyph.Calendar, "calendar");
      Item("Contacts", Glyph.Contact, "contacts");
      Item("Vault", Glyph.Vault, "vault");
      Item("Connections", Glyph.Link, "connections");
      Item("Settings", Glyph.Person, "account");
      Item("Files", Glyph.Folder, "files");
      Item("Reminders", Glyph.Clock, "reminders");
      Item("Memory", Glyph.Memory, "memory");
      Item("Personalization", Glyph.Emoji, "personalization");
      Item("Email Templates", Glyph.Document, "templates");
      Item("Workflows", Glyph.Flow, "workflows");
      Item("Automation", Glyph.Automation, "automation");
      Item("Migrate", Glyph.Import, "migration");
      Item("Messaging Apps", Glyph.Send, "channels");
      Item("Usage", Glyph.Chart, "usage");
      Item("Family", Glyph.Home, "family");
      Item("Companion Apps", Glyph.Phone, "apps");
      if (model.IsAdministrator) {
        Group("Admin");
        Item("Overview", Glyph.Health, "overview");
        Item("People", Glyph.People, "people");
        Item("Backups", Glyph.Backups, "backups");
        Item("Model", Glyph.Layers, "models");
        Item("Network & address", Glyph.Globe, "network");
        Item("Getting Started", Glyph.List, "checklist");
        Item("Connectors", Glyph.Plug, "connectors");
        Item("Custom APIs", Glyph.Code, "custom-apis");
        Item("Workflow Providers", Glyph.Flow, "workflow-providers");
        Item("Approval Policy", Glyph.Shield, "policy");
        Item("Parental Controls", Glyph.Home, "parental");
        Item("Storage", Glyph.Folder, "storage");
        Item("Email Delivery", Glyph.Mail, "mail-settings");
        Item("Voice Box", Glyph.Speaker, "voice-box");
        Item("PC Control", Glyph.Desktop, "pc-control");
        Item("Improvements", Glyph.Chart, "improvements");
        Item("Workspace", Glyph.Settings, "workspace");
        Item("Maintenance", Glyph.Repair, "maintenance");
        Item("Audit Log", Glyph.History, "audit");
      }
      Item("Server", Glyph.Server, "server");
      SyncNav();
    }
    /// The selected entry and the busy state, applied to the buttons in place.
    void SyncNav() {
      foreach (var pair in navButtons) {
        var on = model.Section == pair.Key || (pair.Key == "connectors" && model.Section == "integrations");
        var button = pair.Value;
        if (!ReferenceEquals(button.Foreground, on ? Ui.Accent : Ui.Muted)) button.Foreground = on ? Ui.Accent : Ui.Muted;
        var back = on ? Ui.AccentSoft : Brushes.Transparent;
        if (!ReferenceEquals(button.Background, back)) button.Background = back;
        System.Windows.Automation.AutomationProperties.SetItemStatus(button, on ? "selected" : "");
        var weight = on ? FontWeights.Medium : FontWeights.Normal;
        TextBlock label;
        if (navLabels.TryGetValue(pair.Key, out label) && label.FontWeight != weight) label.FontWeight = weight;
        if (button.IsEnabled == model.Busy) button.IsEnabled = !model.Busy;
      }
    }
    void Group(string title) {
      var label = Ui.Caption(title.ToUpperInvariant()); label.Margin = new Thickness(12, 14, 0, 6); label.FontWeight = FontWeights.SemiBold;
      nav.Children.Add(label);
    }
    void Item(string title, string glyph, string section) {
      if (!Flags.Shows(section)) return;
      var on = model.Section == section;
      var label = Ui.T(title, 14, on ? FontWeights.Medium : FontWeights.Normal, null); label.ClearValue(TextBlock.ForegroundProperty);
      label.TextWrapping = TextWrapping.NoWrap; label.TextTrimming = TextTrimming.CharacterEllipsis;
      var icon = Ui.Icon(glyph, 17); icon.Width = 23; icon.TextAlignment = TextAlignment.Center;
      var row = Ui.Row(12, icon, label);
      var button = new Button { Content = row, Style = (Style)Ui.Resources["Plain"], Padding = new Thickness(12, 10, 12, 10),
        Foreground = on ? Ui.Accent : Ui.Muted, Background = on ? Ui.AccentSoft : Brushes.Transparent, Margin = new Thickness(0, 0, 0, 3) };
      Ui.Name(button, title, null);
      Automation.Id(button, "josi.sidebar.item." + section);
      button.IsEnabled = !model.Busy;
      button.Click += delegate { Go(section); };
      nav.Children.Add(button);
      navButtons[section] = button; navLabels[section] = label;
    }
    /// Opens a sidebar section, as a click on it would.
    public void Go(string section) {
      ShowMenu(false);
      model.Section = section;
      if (section == "automation") model.Run(() => model.LoadAutomation());
      else if (section == "server") model.RefreshLocal();
      else if (section == "chat" || section == "tasks") model.Run(() => model.ReloadWorkspace());
    }

    void RenderThreads() {
      var term = threadSearch.Text.Trim();
      // Rebuilt only when the list itself changed (a thread added, renamed or
      // filtered out); the selection and the busy state are applied in place.
      var key = term + "\n" + string.Join("\n", model.Threads.Select(t => t.Id + "\t" + t["title"].Text));
      if (key == threadsKey) {
        foreach (var pair in threadButtons) {
          var on = model.SelectedThread == pair.Key;
          var wanted = on ? Ui.Text : Ui.Muted;
          if (!ReferenceEquals(pair.Value.Foreground, wanted)) pair.Value.Foreground = wanted;
          System.Windows.Automation.AutomationProperties.SetItemStatus(pair.Value, on ? "selected" : "");
          if (pair.Value.IsEnabled == model.Busy) pair.Value.IsEnabled = !model.Busy;
        }
        return;
      }
      threadsKey = key;
      threads.Children.Clear(); threadButtons.Clear();
      var position = 0;
      foreach (var thread in model.Threads) {
        if (term.Length > 0 && thread["title"].Text.IndexOf(term, StringComparison.CurrentCultureIgnoreCase) < 0) continue;
        var id = thread.Id; var on = model.SelectedThread == id;
        var title = Ui.T(thread["title"].Text.Length == 0 ? "Conversation" : thread["title"].Text, 13.5); title.ClearValue(TextBlock.ForegroundProperty);
        title.TextWrapping = TextWrapping.NoWrap; title.TextTrimming = TextTrimming.CharacterEllipsis;
        var icon = Ui.Icon(Glyph.Bubble, 14); icon.Width = 22;
        var button = new Button { Content = Ui.Row(10, icon, title), Style = (Style)Ui.Resources["Plain"], Padding = new Thickness(12, 9, 12, 9),
          Foreground = on ? Ui.Text : Ui.Muted };
        Ui.Name(button, title.Text, null);
        position++;
        Automation.Id(button, "josi.sidebar.thread." + position);
        System.Windows.Automation.AutomationProperties.SetHelpText(button, id);
        button.IsEnabled = !model.Busy;
        button.Click += delegate { ShowMenu(false); model.Run(() => model.SelectThread(id)); };
        threads.Children.Add(button);
        threadButtons.Add(new System.Collections.Generic.KeyValuePair<string, Button>(id, button));
      }
    }
    void RenderFooter() {
      var footerNow = model.SignedInName + "\n" + model.Address + "\n" + model.Busy;
      if (footerNow == footerKey) return;
      footerKey = footerNow;
      var initials = new string(model.SignedInName.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Take(2).Select(w => w[0]).ToArray());
      var avatar = new Border { Width = 36, Height = 36, CornerRadius = new CornerRadius(18), Background = Ui.Raised,
        Child = new TextBlock { Text = initials.ToUpperInvariant(), FontWeight = FontWeights.Bold, Foreground = Ui.Text, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } };
      var name = Ui.T(model.SignedInName, 13.5, FontWeights.SemiBold); name.TextWrapping = TextWrapping.NoWrap; name.TextTrimming = TextTrimming.CharacterEllipsis;
      var where = Ui.Caption(model.Address.Contains("localhost") ? "Local server" : model.Address); where.TextWrapping = TextWrapping.NoWrap; where.TextTrimming = TextTrimming.CharacterEllipsis;
      var who = Ui.Stack(3, name, where); who.MaxWidth = 140;
      Automation.Id(name, "josi.sidebar.account");
      var signOut = Automation.Id(Ui.IconButton(Glyph.SignOut, "Sign out", () => model.Run(() => model.SignOut())), "josi.sidebar.sign-out");
      signOut.IsEnabled = !model.Busy;
      footer.Child = Ui.Spread(Ui.Row(10, avatar, who), signOut);
    }

    void OnSection() {
      RenderNav();
      if (shownSection == model.Section && detail.Content != null) return;
      if (shownSection == "chat" && chat != null) chat.Pause();
      shownSection = model.Section;
      TextBlock heading;
      barTitle.Text = model.Section != "chat" && navLabels.TryGetValue(model.Section, out heading) ? heading.Text : "Josi";
      barStatus.Visibility = model.Section == "chat" ? Visibility.Visible : Visibility.Collapsed;
      barRight.Content = null;
      // A page already built is shown again as it was; its own Loaded handler
      // refreshes the data behind it without a blank page in between.
      UIElement view;
      if (views.TryGetValue(model.Section, out view)) { detail.Content = view; return; }
      if (model.Section == "chat" && chat != null) barRight.Content = chat.BarActions;
      Automation.BeginScope(model.Section);
      switch (model.Section) {
        case "tasks": tasks = tasks ?? new TaskManagerView(model, owner); tasks.Refresh(); view = tasks; break;
        case "memory": view = new MemoryView(model, owner); break;
        case "automation": view = new AutomationView(model, owner); break;
        case "vault": view = new VaultView(model, owner); break;
        case "my-world": view = new MyWorldView(model, owner); break;
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
        // Item 41: one page with a two-way switch; the old "integrations" key
        // lands on its second tab.
        case "connectors": view = model.IsAdministrator ? new ConnectorsHubView(model, owner, "providers") : null; break;
        case "integrations": view = model.IsAdministrator ? new ConnectorsHubView(model, owner, "developer") : null; break;
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
        default: chat = chat ?? new ChatView(model, owner); chat.Refresh(); view = chat; barRight.Content = chat.BarActions; break;
      }
      if (view != null && model.Section != "chat" && model.Section != "tasks") views[model.Section] = view;
      // A section page derives its control ids from the sidebar key it was opened under.
      var page = view as SectionView; if (page != null) page.SectionKey = model.Section;
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
