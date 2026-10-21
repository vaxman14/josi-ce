using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;

namespace Josi.Native {
  /// Themed modal windows. Recovery dialogs cannot be dismissed until the user
  /// confirms that the one-time material is saved.
  public static class Dialogs {
    static bool recoveryOpen;

    public class Sheet : Window {
      public bool Locked;
      public Sheet(Window owner, string title, double width) {
        Owner = owner; Title = title; Width = width; SizeToContent = SizeToContent.Height; MaxHeight = 760;
        WindowStartupLocation = WindowStartupLocation.CenterOwner; ResizeMode = ResizeMode.NoResize; ShowInTaskbar = false;
        Background = Ui.Sidebar; Foreground = Ui.Text; FontFamily = Ui.Font; FontSize = 14;
        Resources.MergedDictionaries.Add(Ui.Resources);
        KeyDown += (s, e) => { if (e.Key == Key.Escape && !Locked) Close(); };
        SourceInitialized += delegate {
          var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
          var on = 1; NativeDark(handle, 20, ref on);
          var caption = 0x00301E14; NativeDark(handle, 35, ref caption);
        };
      }
      protected override void OnClosing(System.ComponentModel.CancelEventArgs e) { if (Locked) e.Cancel = true; base.OnClosing(e); }
      public void Body(UIElement content) {
        Content = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(26), Focusable = false };
      }
    }
    [System.Runtime.InteropServices.DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    static void NativeDark(IntPtr handle, int attribute, ref int value) { try { DwmSetWindowAttribute(handle, attribute, ref value, sizeof(int)); } catch (Exception) { } }

    public static bool Confirm(Window owner, string title, string detail, string action) {
      var sheet = new Sheet(owner, "Josi", 480);
      var result = false;
      var go = Ui.Pill(action, () => { result = true; sheet.Close(); }, true);
      var cancel = Ui.Pill("Cancel", () => sheet.Close());
      cancel.IsCancel = true;
      sheet.Body(Ui.Stack(14, Ui.T(title, 17, FontWeights.SemiBold), detail == null ? null : Ui.Copyable(detail, 14, Ui.Muted),
        Ui.Spread(null, Ui.Row(8, cancel, go))));
      sheet.Loaded += delegate { cancel.Focus(); };
      sheet.ShowDialog();
      return result;
    }
    public static void Message(Window owner, string title, string detail) {
      var sheet = new Sheet(owner, "Josi", 460);
      var ok = Ui.Pill("OK", () => sheet.Close(), true); ok.IsDefault = true;
      sheet.Body(Ui.Stack(14, Ui.T(title, 17, FontWeights.SemiBold), Ui.Secondary(detail), Ui.Spread(null, ok)));
      sheet.ShowDialog();
    }

    /// Writes a private file (current user only) beside the destination, then moves it into place.
    public static void WritePrivate(string destination, string text) {
      var folder = Path.GetDirectoryName(Path.GetFullPath(destination));
      var temporary = Path.Combine(folder, ".josi-recovery-" + Guid.NewGuid().ToString("N"));
      var security = new FileSecurity();
      security.SetAccessRuleProtection(true, false);
      security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
      var bytes = Encoding.UTF8.GetBytes(text);
      try {
        using (var stream = new FileInfo(temporary).Create(FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, security)) {
          stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
        }
        if (File.Exists(destination)) File.Replace(temporary, destination, null); else File.Move(temporary, destination);
      } finally {
        Array.Clear(bytes, 0, bytes.Length);
        try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { }
      }
    }
    public static bool SaveRecoveryKey(Window owner, string key, string fingerprint) {
      if (key.Length == 0) throw new JosiException("The recovery key is unavailable.");
      var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "Josi-Vault-Recovery.txt", Filter = "Text file (*.txt)|*.txt" };
      if (dialog.ShowDialog(owner) != true) return false;
      try { WritePrivate(dialog.FileName, "Josi Vault recovery key\r\n\r\n" + key + "\r\n\r\nFingerprint: " + fingerprint + "\r\n"); return true; }
      catch (Exception) { Message(owner, "The recovery key could not be saved.", "Choose another location."); return false; }
    }

    public static void ShowRecoveryIfNeeded(Window owner, AppModel model) {
      if (recoveryOpen || (model.VaultRecovery.IsNull && model.MfaRecovery.IsNull)) return;
      recoveryOpen = true;
      owner.Dispatcher.BeginInvoke(new Action(() => {
        try {
          if (!model.MfaRecovery.IsNull) MfaRecovery(owner, model);
          else if (!model.VaultRecovery.IsNull) VaultRecovery(owner, model);
        } finally { recoveryOpen = false; }
        model.Notify();
      }));
    }
    static void VaultRecovery(Window owner, AppModel model) {
      var sheet = new Sheet(owner, "Save Your Vault Recovery Key", 600) { Locked = true };
      var key = model.VaultRecovery["recoveryKey"].Text; var fingerprint = model.VaultRecovery["fingerprint"].Text;
      var shown = Ui.Copyable(key, 14, null, true); shown.Visibility = Visibility.Collapsed;
      var show = Ui.Toggle("Show recovery key");
      show.Checked += delegate { shown.Visibility = Visibility.Visible; }; show.Unchecked += delegate { shown.Visibility = Visibility.Collapsed; };
      var saved = Ui.Toggle("I have saved my recovery key");
      var done = Ui.Pill("Done", () => { sheet.Locked = false; model.VaultRecovery = Wire.Null; sheet.Close(); }, true);
      done.IsEnabled = false;
      saved.Checked += delegate { done.IsEnabled = true; }; saved.Unchecked += delegate { done.IsEnabled = false; };
      sheet.Body(Ui.Stack(18, Ui.Title2("Save Your Vault Recovery Key"),
        Ui.T("Keep this recovery copy somewhere safe outside Josi. Losing both it and the installation key makes your Vault unrecoverable. This key will not be shown again."),
        Ui.Copyable("Fingerprint: " + fingerprint, 12, Ui.Muted), show, shown,
        Ui.Pill("Save Recovery Key…", () => { if (SaveRecoveryKey(sheet, key, fingerprint)) saved.IsChecked = true; }),
        saved, done));
      sheet.ShowDialog();
    }
    static void MfaRecovery(Window owner, AppModel model) {
      var sheet = new Sheet(owner, "Save your sign-in recovery codes", 560) { Locked = true };
      var value = model.MfaRecovery;
      var codes = string.Join("\r\n", value["codes"].List.Select(c => c.Text));
      var shown = Ui.Copyable(codes, 14, null, true); shown.Visibility = Visibility.Collapsed;
      var show = Ui.Toggle("Show recovery codes");
      show.Checked += delegate { shown.Visibility = Visibility.Visible; }; show.Unchecked += delegate { shown.Visibility = Visibility.Collapsed; };
      var confirmed = Ui.Toggle("I have stored these recovery codes safely");
      var note = Ui.Caption("");
      var done = Ui.Pill("Done", () => { sheet.Locked = false; model.MfaRecovery = Wire.Null; sheet.Close(); }, true);
      done.IsEnabled = false;
      confirmed.Checked += delegate { done.IsEnabled = true; }; confirmed.Unchecked += delegate { done.IsEnabled = false; };
      sheet.Body(Ui.Stack(16, Ui.Title2("Save your sign-in recovery codes"),
        Ui.T("Each code works once if your authenticator is unavailable. Keep them in a safe place; Josi will not display them again."),
        show, shown,
        Ui.Pill("Save Private Recovery File…", () => {
          var dialog = new Microsoft.Win32.SaveFileDialog { FileName = "Josi-sign-in-recovery.txt", Title = "Save your one-time sign-in recovery codes", Filter = "Text file (*.txt)|*.txt" };
          if (dialog.ShowDialog(sheet) != true) return;
          try {
            WritePrivate(dialog.FileName, "Josi sign-in recovery codes\r\nAccount: " + value["account"].Text + "\r\nServer: " + value["server"].Text
              + "\r\n\r\nEach code works once. Keep this file private.\r\n\r\n" + codes + "\r\n");
            note.Text = "Saved with private file permissions. Confirm that you have stored it safely.";
          } catch (Exception) { note.Text = "The recovery file could not be saved. Choose another location."; }
        }),
        confirmed, note, done));
      sheet.ShowDialog();
    }

    /// Asks the server to email a password-reset link. The server answers the
    /// same way whether or not the account exists.
    public static void ForgotPassword(Window owner, AppModel model, string identifierText) {
      var sheet = new Sheet(owner, "Forgot your password?", 520);
      var identifier = Ui.Input("Username or email", identifierText ?? "");
      var note = Ui.Secondary("");
      var api = model.Api;
      Action request = () => {
        var value = identifier.Text.Trim();
        if (value.Length == 0 || value.Length > 254 || api == null) { note.Text = "Enter your username or email."; return; }
        note.Text = "";
        model.Run(async () => {
          await api.Request("/auth/forgot-password", "POST", Wires.O("identifier", value));
          note.Text = "If that account exists and this server can send email, a reset link is on its way. Open it, or paste it under \"Have an invitation or reset link?\" on the sign-in page.";
        });
      };
      identifier.KeyDown += (s, e) => { if (e.Key == Key.Enter) request(); };
      var send = Ui.Pill("Send Reset Link", request, true);
      send.IsDefault = true;
      sheet.Body(Ui.Stack(14, Ui.Title2("Forgot your password?"),
        Ui.T("Enter the username or email for your Josi account and the server will email you a reset link."),
        Ui.Field("Username or email", identifier), send, note,
        Ui.Caption("This needs email delivery set up on the server. If it is not, an administrator can create a reset link for you in People."),
        Ui.Spread(Ui.Link("I already have a reset link", () => { sheet.Close(); PasswordSetup(owner, model); }), Ui.Pill("Close", () => sheet.Close()))));
      sheet.Loaded += delegate { identifier.Focus(); };
      sheet.ShowDialog();
    }

    /// Sets a password from an invitation or reset link for the connected server.
    public static void PasswordSetup(Window owner, AppModel model) {
      var sheet = new Sheet(owner, "Invitation or password reset", 560);
      var input = Ui.Input("Paste the one-time link or code");
      var password = new NewPassword("New password");
      var note = Ui.Secondary("");
      var token = ""; var inspected = Wire.Null;
      var api = model.Api;
      var host = new ContentControl { Focusable = false };
      Action render = null;
      Action save = null;
      save = () => {
        if (!password.Valid) return;
        var secret = password.Password; password.Clear(); var selected = token;
        model.Run(async () => {
          var result = await api.Request("/auth/set-password", "POST", Wires.O("token", selected, "password", secret, "signIn", false));
          token = ""; inspected = Wire.Null;
          if (!result["passwordChanged"].Flag) {
            // Older servers may have created a session. Close it instead
            // of treating password recovery as an authenticator bypass.
            await api.Request("/auth/logout", "POST", Wires.O());
            await api.PrimeCsrf();
            note.Text = "The server completed password recovery. Close this panel and sign in normally.";
          } else note.Text = "Password saved. Close this panel and sign in with your new password.";
          render();
        });
      };
      password.Submitted += () => save();
      render = () => {
        if (inspected.IsNull) {
          host.Content = Ui.Stack(12, Ui.T("Paste the one-time link or code you received for this server."), input,
            Ui.Pill("Check Link", () => {
              var value = input.Text.Trim(); input.Text = ""; note.Text = "";
              try {
                var selected = ParseToken(value, api);
                model.Run(async () => {
                  var result = await api.Request("/auth/token/inspect", "POST", Wires.O("token", selected));
                  if (result["purpose"].Text != "invite" && result["purpose"].Text != "reset" || result["username"].Text.Length == 0)
                    throw new JosiException("This link could not be verified.");
                  token = selected; inspected = result; render();
                });
              } catch (JosiException e) { note.Text = e.Message; }
            }, true),
            Ui.Link("Need a reset link? Request one", () => { sheet.Close(); ForgotPassword(owner, model, ""); }));
        } else {
          var saveButton = Ui.Pill("Save Password", save, true);
          saveButton.IsEnabled = password.Valid;
          password.Changed += delegate { saveButton.IsEnabled = password.Valid; };
          Ui.Detach(password);
          host.Content = Ui.Stack(12, Ui.Headline("Set a password for " + inspected["username"].Text), password, saveButton,
            Ui.Caption("Saving ends existing sign-ins. Sign in normally afterward; any enabled authenticator is still required."),
            Ui.Pill("Use Another Link", () => { token = ""; inspected = Wire.Null; render(); }));
          Dispatcher.CurrentDispatcher.BeginInvoke(new Action(() => password.Focus()), System.Windows.Threading.DispatcherPriority.Background);
        }
      };
      render();
      sheet.Body(Ui.Stack(16, Ui.Title2("Invitation or password reset"), host, note, Ui.Spread(null, Ui.Pill("Close", () => sheet.Close()))));
      sheet.ShowDialog();
      password.Clear();
    }
    static string ParseToken(string value, JosiApi api) {
      const string pattern = "^[A-Za-z0-9_-]{43}$";
      if (Regex.IsMatch(value, pattern)) return value;
      Uri link;
      if (value.Length > 4096 || !Uri.TryCreate(value, UriKind.Absolute, out link) || link.Scheme != api.Origin.Scheme
          || !string.Equals(link.Host, api.Origin.Host, StringComparison.OrdinalIgnoreCase) || link.Port != api.Origin.Port
          || link.UserInfo.Length > 0 || link.Fragment.Length > 0 || link.AbsolutePath != "/set-password") {
        throw new JosiException("Use a valid invitation or reset link for the server shown here. If its address differs, reconnect to the address in the link first.");
      }
      var match = Regex.Match(link.Query, "^\\?token=([A-Za-z0-9_-]{43})$");
      if (!match.Success) throw new JosiException("Use a valid invitation or reset link for the server shown here. If its address differs, reconnect to the address in the link first.");
      return match.Groups[1].Value;
    }

    public static void MemorySource(Window owner, AppModel model, Wire source) {
      var sheet = new Sheet(owner, "Source work", 660);
      var body = new ContentControl { Content = Ui.Caption("Loading…"), Focusable = false };
      sheet.Body(Ui.Stack(16, Ui.Spread(Ui.Title2("Source work"), Ui.Pill("Close", () => sheet.Close())), body));
      sheet.Loaded += async delegate {
        var api = model.Api; if (api == null) return;
        try {
          var id = api.Uuid(source["work_goal_id"].Text);
          var value = await api.Request("/assistant/work-goals/" + id);
          var goal = value["goal"];
          if (goal["goalId"].Text != id) throw new JosiException("The original work is unavailable on this server.");
          var stack = Ui.Stack(10, Ui.Headline(goal["title"].Text),
            Ui.T(goal["verifiedSteps"].Integer + "/" + goal["totalSteps"].Integer + " steps verified · " + goal["state"].Text), Ui.Headline("Finished means"));
          foreach (var c in goal["criteria"].List) Ui.Add(stack, Ui.Copyable("• " + c.Text), 4);
          foreach (var s in goal["steps"].List) Ui.Add(stack, Ui.T((s["state"].Text == "verified" ? "✓ " : "• ") + s["title"].Text), 4);
          Ui.Add(stack, Ui.Caption("Lesson source revision: " + source["work_goal_revision"].Integer + " · Current saved revision: " + goal["revision"].Integer), 8);
          var thread = goal["threadId"].Text;
          Ui.Add(stack, Ui.Pill("Open Original Conversation", () => { sheet.Close(); model.Run(() => model.SelectThread(thread)); }), 10);
          body.Content = stack;
        } catch (JosiException) { body.Content = Ui.T("The original work is unavailable on this server.", 14, null, Ui.Orange); }
      };
      sheet.ShowDialog();
    }

    public static void VoiceSettings(Window owner, AppModel model, Voice voice) {
      var sheet = new Sheet(owner, "Voice Box", 500);
      var host = new ContentControl { Focusable = false };
      var error = ""; var working = false;
      var selected = "af_heart"; var transcription = "base.en";
      Action render = null;
      Action sync = () => {
        var saved = voice.Settings["settings"];
        if (saved["voice"].Text.Length > 0) { selected = saved["voice"].Text; transcription = saved["model"].Text; }
      };
      Action<string> perform = async operation => {
        var api = model.Api; if (api == null) return;
        working = true; error = ""; render();
        try {
          object body = Wires.O();
          if (operation == "settings" && voice.Settings["settings"].Raw is IDictionary<string, object>) {
            var saved = new Dictionary<string, object>((IDictionary<string, object>)voice.Settings["settings"].Raw);
            saved["voice"] = selected; saved["model"] = transcription; body = saved;
          }
          await api.Request("/admin/voice-box/" + operation, "POST", body);
          for (var i = 0; i < 20; i++) {
            await voice.Refresh(api); sync();
            if (voice.Available || voice.Settings["phase"].Text != "working") break;
            await System.Threading.Tasks.Task.Delay(2000);
          }
        } catch (JosiException e) { error = e.Message; }
        finally { working = false; render(); }
      };
      render = () => {
        var stack = Ui.Stack(16,
          Ui.Secondary("Dictate into the message box, or talk with Josi and hear its replies. Audio is processed by Voice Box on your Josi server."),
          Ui.Row(10, Ui.Icon(voice.Available ? Glyph.Check : Glyph.Wave, 18, voice.Available ? Ui.Green : Ui.Orange), Ui.Headline(voice.Available ? "Speech models are ready" : "Voice Box needs setup")));
        if (model.IsAdministrator) {
          if (voice.Settings["verified"].Flag) {
            var voices = Ui.Choice(Ui.Options("af_heart", "Kokoro · Heart", "af_bella", "Kokoro · Bella"), selected);
            voices.SelectionChanged += delegate { selected = Ui.Selected(voices); };
            var models = Ui.Choice(Ui.Options("base.en", "Whisper Base · English", "tiny.en", "Whisper Tiny · English"), transcription);
            models.SelectionChanged += delegate { transcription = Ui.Selected(models); };
            Ui.Add(stack, Ui.Field("Speaking voice", voices), 16);
            Ui.Add(stack, Ui.Field("Dictation model", models), 16);
            Ui.Add(stack, Ui.Pill("Save voice settings", () => perform("settings"), true), 16);
            Ui.Add(stack, Ui.Pill("Restart Voice Box", () => perform("restart")), 10);
          } else {
            Ui.Add(stack, Ui.T(voice.Settings["error"].Text.Length == 0 ? "Enable the included local speech models to use voice controls." : voice.Settings["error"].Text), 16);
            var enable = Ui.Pill("Enable Voice Box", () => perform("install"), true);
            enable.IsEnabled = voice.Settings["helperAvailable"].Flag && voice.Settings["releaseAvailable"].Flag;
            Ui.Add(stack, enable, 12);
          }
        } else Ui.Add(stack, Ui.T("Your server administrator manages the voice models."), 16);
        if (error.Length > 0) Ui.Add(stack, Ui.T(error, 13, null, Ui.Orange), 12);
        if (working) Ui.Add(stack, Ui.Caption("Checking speech models…"), 12);
        stack.IsEnabled = !working;
        host.Content = stack;
      };
      sheet.Loaded += async delegate { var api = model.Api; if (api != null) { await voice.Refresh(api); sync(); render(); } };
      render();
      sheet.Body(Ui.Stack(16, Ui.Spread(Ui.Title2("Voice Box"), Ui.Pill("Done", () => sheet.Close())), host));
      sheet.ShowDialog();
    }
  }
}
