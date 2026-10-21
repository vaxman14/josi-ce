using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;

namespace Josi.Native {
  /// A password field with a show/hide button. While hidden the value lives
  /// only in the PasswordBox; showing it copies the text into a plain box and
  /// hiding copies it back and clears the plain box.
  public sealed class PasswordInput : UserControl {
    readonly PasswordBox hidden = new PasswordBox();
    readonly TextBox visible = new TextBox { Visibility = Visibility.Collapsed };
    readonly Button toggle;
    bool showing, syncing;
    public event Action Changed;
    public event Action Submitted;

    public PasswordInput(string label) {
      AutomationProperties.SetName(hidden, label);
      AutomationProperties.SetName(visible, label);
      toggle = Ui.IconButton("", "Show password", Toggle, 15);
      toggle.Margin = new Thickness(6, 0, 0, 0);
      hidden.PasswordChanged += delegate { if (!syncing) Raise(); };
      visible.TextChanged += delegate { if (!syncing) Raise(); };
      KeyEventHandler enter = (s, e) => { if (e.Key == Key.Enter) { var handler = Submitted; if (handler != null) handler(); } };
      hidden.KeyDown += enter; visible.KeyDown += enter;
      var grid = new Grid();
      grid.ColumnDefinitions.Add(new ColumnDefinition());
      grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
      grid.Children.Add(hidden); grid.Children.Add(visible);
      Grid.SetColumn(toggle, 1); grid.Children.Add(toggle);
      Content = grid;
      Unloaded += delegate { Hide(); };
    }
    void Raise() { var handler = Changed; if (handler != null) handler(); }
    public string Password { get { return showing ? visible.Text : hidden.Password; } }
    public void Clear() {
      syncing = true;
      try { hidden.Clear(); visible.Clear(); } finally { syncing = false; }
      Raise();
    }
    public new void Focus() { if (showing) visible.Focus(); else hidden.Focus(); }
    void Toggle() { if (showing) Hide(); else Show(); }
    void Show() {
      if (showing) return;
      syncing = true;
      try { visible.Text = hidden.Password; hidden.Clear(); } finally { syncing = false; }
      showing = true;
      hidden.Visibility = Visibility.Collapsed; visible.Visibility = Visibility.Visible;
      SetToggle("", "Hide password");
      visible.Focus(); visible.CaretIndex = visible.Text.Length;
    }
    void Hide() {
      if (!showing) return;
      syncing = true;
      try { hidden.Password = visible.Text; visible.Clear(); } finally { syncing = false; }
      showing = false;
      visible.Visibility = Visibility.Collapsed; hidden.Visibility = Visibility.Visible;
      SetToggle("", "Show password");
    }
    void SetToggle(string glyph, string label) {
      ((TextBlock)toggle.Content).Text = glyph;
      Ui.Name(toggle, label, label);
    }
  }

  /// A new password and its confirmation, with live checks. Valid only when
  /// it is at least 12 characters long and both entries match.
  public sealed class NewPassword : UserControl {
    public const int Minimum = 12;
    readonly PasswordInput first, second;
    readonly TextBlock length, match;
    public event Action Changed;
    public event Action Submitted;

    public NewPassword(string label = "Password") {
      first = new PasswordInput(label);
      second = new PasswordInput("Confirm password");
      length = Ui.Caption(""); match = Ui.Caption("");
      first.Changed += Update; second.Changed += Update;
      second.Submitted += delegate { var handler = Submitted; if (Valid && handler != null) handler(); };
      Content = Ui.Stack(8, Ui.Field(label, first), Ui.Field("Confirm password", second), Ui.Stack(3, length, match));
      Update();
    }
    public bool Valid { get { return first.Password.Length >= Minimum && first.Password == second.Password; } }
    public string Password { get { return first.Password; } }
    public void Clear() { first.Clear(); second.Clear(); }
    public new void Focus() { first.Focus(); }
    void Update() {
      var longEnough = first.Password.Length >= Minimum;
      var same = second.Password.Length > 0 && first.Password == second.Password;
      Check(length, longEnough, "At least " + Minimum + " characters" + (first.Password.Length > 0 && !longEnough ? " (" + first.Password.Length + " so far)" : ""));
      Check(match, same, second.Password.Length == 0 ? "Passwords match" : same ? "Passwords match" : "Passwords do not match");
      var handler = Changed; if (handler != null) handler();
    }
    static void Check(TextBlock line, bool passed, string text) {
      line.Text = (passed ? "✓  " : "•  ") + text;
      line.Foreground = passed ? Ui.Green : Ui.Muted;
      AutomationProperties.SetName(line, (passed ? "Met: " : "Not met: ") + text);
    }
  }
}
