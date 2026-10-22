using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Josi.Native {
  /// Small builders over the shared theme so every screen matches the Mac app:
  /// navy surfaces, cream text, orange accents, rounded cards and pill buttons.
  public static class Ui {
    public static ResourceDictionary Resources;
    public static Brush Background, Sidebar, Card, Raised, Border, Orange, Text, Muted, OrangeSoft, OrangeFaint, Green, Warning;
    public static FontFamily Font, Icons, Mono;
    static BitmapImage mark;

    public static void Load() {
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Theme.xaml"))
        Resources = (ResourceDictionary)XamlReader.Load(stream);
      Background = (Brush)Resources["Background"]; Sidebar = (Brush)Resources["Sidebar"]; Card = (Brush)Resources["Card"];
      Raised = (Brush)Resources["Raised"]; Border = (Brush)Resources["BorderBrush"]; Orange = (Brush)Resources["Orange"];
      Text = (Brush)Resources["Text"]; Muted = (Brush)Resources["Muted"]; OrangeSoft = (Brush)Resources["OrangeSoft"];
      OrangeFaint = (Brush)Resources["OrangeFaint"];
      Green = Freeze(new SolidColorBrush(Color.FromRgb(0x5C, 0xC9, 0x7B)));
      Warning = Orange;
      Font = (FontFamily)Resources["Font"]; Icons = (FontFamily)Resources["Icons"]; Mono = (FontFamily)Resources["Mono"];
    }
    static Brush Freeze(SolidColorBrush brush) { brush.Freeze(); return brush; }

    public static BitmapImage Mark {
      get {
        if (mark == null) {
          mark = new BitmapImage();
          mark.BeginInit();
          mark.StreamSource = Assembly.GetExecutingAssembly().GetManifestResourceStream("josi-mark.png");
          mark.CacheOption = BitmapCacheOption.OnLoad;
          mark.DecodePixelWidth = 256;
          mark.EndInit(); mark.Freeze();
        }
        return mark;
      }
    }

    /// White J on navy, from the approved master asset.
    public static FrameworkElement JosiMark(double size) {
      var image = new Image { Source = Mark, Width = size, Height = size, Stretch = Stretch.UniformToFill };
      RenderOptions.SetBitmapScalingMode(image, BitmapScalingMode.HighQuality);
      var radius = size * 0.22;
      image.Clip = new RectangleGeometry(new Rect(0, 0, size, size), radius, radius);
      AutomationHidden(image);
      return image;
    }
    static void AutomationHidden(UIElement element) {
      // Decorative: no name, no focus, no hit testing, so screen readers skip it.
      element.Focusable = false;
    }

    public static TextBlock T(string text, double size = 14, FontWeight? weight = null, Brush brush = null) {
      return new TextBlock {
        Text = text ?? "", FontSize = size, FontFamily = Font, FontWeight = weight ?? FontWeights.Normal,
        Foreground = brush ?? Text, TextWrapping = TextWrapping.Wrap
      };
    }
    public static TextBlock Caption(string text) { return T(text, 12, null, Muted); }
    public static TextBlock Secondary(string text) { return T(text, 14, null, Muted); }
    public static TextBlock Headline(string text) { return T(text, 15, FontWeights.SemiBold); }
    public static TextBlock Title2(string text) { return T(text, 21, FontWeights.Bold); }
    static ControlTemplate plainText;
    static ControlTemplate PlainTextTemplate() {
      if (plainText == null) {
        plainText = (ControlTemplate)XamlReader.Parse("<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' TargetType='TextBox'><ScrollViewer x:Name='PART_ContentHost' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' Focusable='False' HorizontalScrollBarVisibility='Disabled' VerticalScrollBarVisibility='Disabled'/></ControlTemplate>");
      }
      return plainText;
    }
    public static TextBox Copyable(string text, double size = 14, Brush brush = null, bool mono = false) {
      return new TextBox {
        Text = text ?? "", IsReadOnly = true, TextWrapping = TextWrapping.Wrap, Background = Brushes.Transparent,
        BorderThickness = new Thickness(0), Padding = new Thickness(0), FontSize = size, Foreground = brush ?? Text,
        FontFamily = mono ? Mono : Font, Template = PlainTextTemplate()
      };
    }

    public static TextBlock Icon(string glyph, double size = 16, Brush brush = null) {
      var icon = new TextBlock { Text = glyph, FontFamily = Icons, FontSize = size, Foreground = brush, VerticalAlignment = VerticalAlignment.Center };
      if (brush == null) icon.ClearValue(TextBlock.ForegroundProperty);
      AutomationHidden(icon);
      return icon;
    }

    /// Vertical rhythm of a section page: the gap between its top-level blocks.
    public const double PageSpacing = 18;
    public static readonly object PageSpacingTag = "page";
    /// The content column every section shares: one left edge, one width.
    public const double PageWidth = 1040;
    public static StackPanel Stack(double spacing, params UIElement[] children) {
      var panel = new StackPanel();
      foreach (var child in children) Add(panel, child, spacing);
      return panel;
    }
    static readonly System.Runtime.CompilerServices.ConditionalWeakTable<FrameworkElement, object> baseMargins =
      new System.Runtime.CompilerServices.ConditionalWeakTable<FrameworkElement, object>();
    /// Controls that keep typed text live across renders are reattached here,
    /// so remove them from their previous parent and reuse their own margin.
    public static void Detach(FrameworkElement element) {
      var panel = element.Parent as Panel;
      if (panel != null) { panel.Children.Remove(element); return; }
      var decorator = element.Parent as Decorator;
      if (decorator != null) { decorator.Child = null; return; }
      var content = element.Parent as ContentControl;
      if (content != null) content.Content = null;
    }
    public static void Add(Panel panel, UIElement child, double spacing) {
      if (child == null) return;
      var element = child as FrameworkElement;
      if (element != null) {
        if (element.Parent != null) Detach(element);
        object original;
        if (baseMargins.TryGetValue(element, out original)) element.Margin = (Thickness)original;
        else baseMargins.Add(element, element.Margin);
      }
      if (element != null && panel.Children.Count > 0) {
        // A section page keeps one rhythm between its blocks whatever each
        // call passed, so headings, cards and lists never touch.
        if (PageSpacingTag.Equals(panel.Tag) && spacing < PageSpacing) spacing = PageSpacing;
        var margin = element.Margin;
        var horizontal = panel is StackPanel && ((StackPanel)panel).Orientation == Orientation.Horizontal;
        element.Margin = horizontal ? new Thickness(margin.Left + spacing, margin.Top, margin.Right, margin.Bottom)
                                    : new Thickness(margin.Left, margin.Top + spacing, margin.Right, margin.Bottom);
      }
      panel.Children.Add(child);
    }
    public static StackPanel Row(double spacing, params UIElement[] children) {
      var panel = new StackPanel { Orientation = Orientation.Horizontal };
      foreach (var child in children) {
        var element = child as FrameworkElement;
        if (element != null) element.VerticalAlignment = VerticalAlignment.Center;
        Add(panel, child, spacing);
      }
      return panel;
    }
    public static WrapPanel Wrap(params UIElement[] children) {
      var panel = new WrapPanel();
      foreach (var child in children) {
        if (child == null) continue;
        var element = child as FrameworkElement;
        if (element != null) { if (element.Parent != null) Detach(element); element.Margin = new Thickness(0, 0, 8, 8); }
        panel.Children.Add(child);
      }
      return panel;
    }
    /// Left content, flexible space, right content.
    public static Grid Spread(UIElement left, UIElement right) {
      var grid = new Grid();
      grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
      grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
      foreach (var part in new[] { left, right }) { var e = part as FrameworkElement; if (e != null && e.Parent != null) Detach(e); }
      if (left != null) { Grid.SetColumn(left, 0); grid.Children.Add(left); }
      if (right != null) {
        Grid.SetColumn(right, 1); grid.Children.Add(right);
        var element = right as FrameworkElement;
        if (element != null) { element.VerticalAlignment = VerticalAlignment.Center; element.Margin = new Thickness(12, 0, 0, 0); }
      }
      return grid;
    }

    /// JosiGroupBoxStyle: card with optional headline.
    public static Border CardBox(string title, params UIElement[] content) {
      var stack = new StackPanel();
      if (!string.IsNullOrEmpty(title)) Add(stack, Headline(title), 0);
      foreach (var child in content) Add(stack, child, 12);
      return new Border {
        Background = Card, BorderBrush = Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14),
        Padding = new Thickness(18), Child = stack, HorizontalAlignment = HorizontalAlignment.Stretch
      };
    }

    public static FrameworkElement Heading(string title, string subtitle) {
      return Stack(6, T(title, 30, FontWeights.Bold), subtitle == null ? null : Secondary(subtitle));
    }
    /// Title with an action on the right, kept level with the title even when
    /// the subtitle wraps to several lines.
    public static FrameworkElement HeadingWith(string title, string subtitle, UIElement right) {
      var grid = Spread(Heading(title, subtitle), right);
      var element = right as FrameworkElement;
      if (element != null) { element.VerticalAlignment = VerticalAlignment.Top; element.Margin = new Thickness(16, 4, 0, 0); }
      return grid;
    }

    public static Button Pill(string text, Action click, bool prominent = false) {
      var button = new Button { Content = text, Style = (Style)Resources[prominent ? "PillProminent" : "Pill"] };
      if (click != null) button.Click += delegate { click(); };
      return button;
    }
    public static Button Danger(string text, Action click) {
      var button = new Button { Content = text, Style = (Style)Resources["PillDanger"] };
      if (click != null) button.Click += delegate { click(); };
      return button;
    }
    public static Button PillIcon(string glyph, string label, Action click, bool prominent = false, string tip = null) {
      var content = new StackPanel { Orientation = Orientation.Horizontal };
      content.Children.Add(Icon(glyph, 14));
      if (!string.IsNullOrEmpty(label)) {
        var text = T(label, 13.5, FontWeights.Medium); text.Margin = new Thickness(7, 0, 0, 0); text.Foreground = null;
        text.ClearValue(TextBlock.ForegroundProperty);
        content.Children.Add(text);
      }
      var button = new Button { Content = content, Style = (Style)Resources[prominent ? "PillProminent" : "Pill"] };
      Name(button, label ?? tip, tip);
      if (click != null) button.Click += delegate { click(); };
      return button;
    }
    public static Button IconButton(string glyph, string label, Action click, double size = 16) {
      var button = new Button { Content = Icon(glyph, size), Style = (Style)Resources["Plain"], Padding = new Thickness(6) };
      Name(button, label, label);
      if (click != null) button.Click += delegate { click(); };
      return button;
    }
    public static Button Link(string text, Action click) {
      var button = new Button { Content = text, Style = (Style)Resources["LinkButton"] };
      if (click != null) button.Click += delegate { click(); };
      return button;
    }
    public static void Name(FrameworkElement element, string name, string tip) {
      if (!string.IsNullOrEmpty(name)) System.Windows.Automation.AutomationProperties.SetName(element, name);
      if (!string.IsNullOrEmpty(tip)) element.ToolTip = tip;
    }

    public static TextBox Input(string placeholder = null, string value = "", bool multiline = false) {
      var box = new TextBox { Text = value ?? "" };
      if (multiline) { box.AcceptsReturn = true; box.TextWrapping = TextWrapping.Wrap; box.MinHeight = 64; box.VerticalScrollBarVisibility = ScrollBarVisibility.Auto; }
      if (!string.IsNullOrEmpty(placeholder)) Placeholder(box, placeholder);
      return box;
    }
    public static PasswordBox Secret(string placeholder = null) {
      var box = new PasswordBox();
      if (!string.IsNullOrEmpty(placeholder)) System.Windows.Automation.AutomationProperties.SetName(box, placeholder);
      return box;
    }
    /// Label above a control, as the Mac setup forms present fields.
    public static FrameworkElement Field(string label, Control control) {
      System.Windows.Automation.AutomationProperties.SetName(control, label);
      return Stack(5, T(label, 13.5), control);
    }
    public static void Placeholder(TextBox box, string text, Brush fill = null) {
      System.Windows.Automation.AutomationProperties.SetName(box, text);
      var surface = fill ?? Raised;
      Action update = () => {
        var size = box.FontSize;
        if (box.Text.Length == 0) {
          // The hint starts where typed text starts: border, padding, then the
          // text view's own 2-pixel inset. A drawing anchored at the box's
          // corner keeps that offset; a brush visual would lose its margin.
          var hint = new FormattedText(text, System.Globalization.CultureInfo.CurrentUICulture, FlowDirection.LeftToRight,
            new Typeface(Font, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal), size, Muted,
            VisualTreeHelper.GetDpi(box).PixelsPerDip);
          var drawing = new DrawingGroup();
          drawing.Children.Add(new GeometryDrawing(surface, null, new RectangleGeometry(new Rect(0, 0, 4000, 400))));
          drawing.Children.Add(new GeometryDrawing(Muted, null, hint.BuildGeometry(
            new Point(box.BorderThickness.Left + box.Padding.Left + 2, box.BorderThickness.Top + box.Padding.Top))));
          box.Background = new DrawingBrush(drawing) { Stretch = Stretch.None, AlignmentX = AlignmentX.Left, AlignmentY = AlignmentY.Top };
        }
        else box.Background = surface;
      };
      box.TextChanged += delegate { update(); };
      // Padding and font size come from the theme once the box is on screen.
      box.Loaded += delegate { update(); };
      update();
    }
    public static CheckBox Toggle(string text, bool value = false) {
      return new CheckBox { Content = text, IsChecked = value };
    }
    public static ComboBox Choice(IList<KeyValuePair<string, string>> options, string selected) {
      var combo = new ComboBox();
      foreach (var option in options) {
        var item = new ComboBoxItem { Content = option.Value, Tag = option.Key };
        combo.Items.Add(item);
        if (option.Key == selected) combo.SelectedItem = item;
      }
      return combo;
    }
    public static string Selected(ComboBox combo) {
      var item = combo.SelectedItem as ComboBoxItem;
      return item == null ? "" : (string)item.Tag;
    }
    public static List<KeyValuePair<string, string>> Options(params string[] pairs) {
      var list = new List<KeyValuePair<string, string>>();
      for (var i = 0; i + 1 < pairs.Length; i += 2) list.Add(new KeyValuePair<string, string>(pairs[i], pairs[i + 1]));
      return list;
    }

    /// Segmented control, as Picker(.segmented) and the Task Manager filters.
    public static Border Segments(IList<KeyValuePair<string, string>> options, string selected, Action<string> pick) {
      var grid = new UniformGrid { Rows = 1 };
      foreach (var option in options) {
        var key = option.Key;
        var on = key == selected;
        var label = T(option.Value, 13.5, FontWeights.Medium, on ? Orange : Muted);
        label.TextAlignment = TextAlignment.Center; label.HorizontalAlignment = HorizontalAlignment.Center;
        var button = new Button { Content = label, Style = (Style)Resources["Plain"], Padding = new Thickness(12, 9, 12, 9),
          Background = on ? (Brush)Resources["OrangeSoft"] : Brushes.Transparent, Margin = new Thickness(2) };
        button.Click += delegate { pick(key); };
        grid.Children.Add(button);
      }
      return new Border { Background = new SolidColorBrush(Color.FromArgb(0x80, 0x1F, 0x28, 0x3D)), CornerRadius = new CornerRadius(11),
        Padding = new Thickness(3), Child = grid, MaxWidth = 620, HorizontalAlignment = HorizontalAlignment.Left };
    }

    public static Separator Divider() {
      return new Separator { Background = Border, Margin = new Thickness(0, 4, 0, 4) };
    }
    public static ScrollViewer Scroll(UIElement content, double maxWidth = double.PositiveInfinity, double padding = 30) {
      var element = content as FrameworkElement;
      // One left edge for every section, so moving between tabs does not shift
      // the content column; wide pages (calendar, chat) still stretch.
      if (element != null) { element.Margin = new Thickness(padding + 6, padding, padding, padding); element.MaxWidth = maxWidth; element.HorizontalAlignment = double.IsInfinity(maxWidth) ? HorizontalAlignment.Stretch : HorizontalAlignment.Left; }
      return new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false };
    }

    public static FrameworkElement StatusBadge(string state) {
      var labels = new Dictionary<string, string> {
        {"planning", "Planning"}, {"working", "In progress"}, {"needs_instruction", "Needs attention"}, {"waiting", "Waiting"},
        {"paused", "Paused"}, {"verifying", "Ready to review"}, {"completed", "Complete"}, {"cancelled", "Cancelled"}
      };
      string text;
      if (!labels.TryGetValue(state, out text)) text = Wires.Capitalize(state);
      var color = state == "completed" ? Green : Orange;
      var row = Row(6, new System.Windows.Shapes.Ellipse { Width = 7, Height = 7, Fill = color }, T(text, 12, FontWeights.SemiBold, color));
      return new Border { Background = OrangeFaint, CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 5, 10, 5), Child = row, VerticalAlignment = VerticalAlignment.Center };
    }

    /// The J mark, gently rocking and bobbing; still when Windows animations are off.
    public static FrameworkElement AnimatedMark(double size) {
      var markElement = JosiMark(size);
      var rotate = new RotateTransform(0, size / 2, size / 2);
      var move = new TranslateTransform();
      var group = new TransformGroup(); group.Children.Add(rotate); group.Children.Add(move);
      markElement.RenderTransform = group;
      if (SystemParameters.ClientAreaAnimation) {
        var ease = new SineEase { EasingMode = EasingMode.EaseInOut };
        var lift = Math.Max(2, size / 9.5);
        var spin = new DoubleAnimation(-9, 9, TimeSpan.FromSeconds(0.52)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = ease };
        var bob = new DoubleAnimation(lift / 2, -lift, TimeSpan.FromSeconds(0.52)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = ease };
        rotate.BeginAnimation(RotateTransform.AngleProperty, spin);
        move.BeginAnimation(TranslateTransform.YProperty, bob);
      }
      return markElement;
    }
    /// The animated J thinking indicator in the chat.
    public static FrameworkElement Thinking() {
      var row = Row(14, AnimatedMark(38), T("Josi is thinking…", 14, null, Muted));
      row.Margin = new Thickness(0, 12, 0, 12);
      System.Windows.Automation.AutomationProperties.SetName(row, "Josi is thinking");
      return row;
    }
    /// A small animated J with a sentence, for any wait: "Checking…",
    /// "Waiting for your approval…". With `elapsed`, a seconds counter shows
    /// the wait is alive rather than stuck.
    public static WorkingIndicator Working(string text, bool elapsed = false, double size = 22) {
      return new WorkingIndicator(text, elapsed, size);
    }

    public static bool Confirm(Window owner, string title, string detail, string action) {
      return Dialogs.Confirm(owner, title, detail, action);
    }
  }

  public sealed class WorkingIndicator : UserControl {
    readonly TextBlock label, clock;
    readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
    readonly DateTime started = DateTime.UtcNow;
    public WorkingIndicator(string text, bool elapsed, double size) {
      label = Ui.T(text, 13.5, null, Ui.Muted);
      clock = Ui.T("", 12, null, Ui.Muted);
      clock.VerticalAlignment = VerticalAlignment.Center;
      Focusable = false;
      Content = Ui.Row(10, Ui.AnimatedMark(size), label, elapsed ? clock : null);
      System.Windows.Automation.AutomationProperties.SetName(this, text);
      if (elapsed) {
        timer.Tick += delegate { Tick(); };
        Loaded += delegate { Tick(); timer.Start(); };
        Unloaded += delegate { timer.Stop(); };
      }
    }
    void Tick() {
      var seconds = (int)(DateTime.UtcNow - started).TotalSeconds;
      clock.Text = seconds < 60 ? seconds + " s" : (seconds / 60) + " min " + (seconds % 60) + " s";
    }
    public string Text {
      get { return label.Text; }
      set { label.Text = value; System.Windows.Automation.AutomationProperties.SetName(this, value); }
    }
  }

  /// Segoe Fluent Icons / MDL2 glyphs standing in for the Mac's SF Symbols.
  public static class Glyph {
    public const string Chat = "", Checklist = "", Memory = "", Automation = "", Vault = "",
      Person = "", Send = "", Layers = "", People = "", Mail = "", Backups = "",
      Server = "", Compose = "", SignOut = "", Warning = "", Close = "", Plus = "",
      Chevron = "", Mic = "", Stop = "", Up = "", Copy = "", Speaker = "", Clip = "",
      Wave = "", Check = "", Circle = "", Minus = "", Desktop = "", Network = "", Bubble = "",
      Pause = "", Play = "", Refresh = "",
      // Segoe Fluent Icons for the sections added with the full build list.
      Calendar = "\uE787", Contact = "\uE77B", Folder = "\uE8B7", Clock = "\uE823", Link = "\uE71B", Shield = "\uE83D",
      Approve = "\uE8FB", Emoji = "\uE76E", Flow = "\uE9D5", Chart = "\uE9D9", Settings = "\uE713", Globe = "\uE774",
      History = "\uE81C", Code = "\uE943", Plug = "\uE703", Import = "\uE8B5", Document = "\uE8A5", Health = "\uE95E",
      Repair = "\uE90F", List = "\uE8FD", Phone = "\uE8EA", Home = "\uE80F";
  }
}
