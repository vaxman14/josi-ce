using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Josi.Native {
  /// Backups as one file (build item 42). The flows shared by the Backups
  /// page and the first-time setup screen: make a backup and save it where
  /// you like, and restore from a file you pick, with the passphrase asked
  /// at the right moments.
  public static class BackupFlows {
    public sealed class PassphraseChoice { public string Value = ""; public bool Skipped, Cancelled; }

    /// Asks for a passphrase. When creating, it is typed twice and may be
    /// skipped for this one backup; when opening, once.
    public static PassphraseChoice AskPassphrase(Window owner, bool creating, string filename = null) {
      var sheet = new Dialogs.Sheet(owner, "Backup passphrase", 520);
      var choice = new PassphraseChoice { Cancelled = true };
      var first = Ui.Secret("Passphrase"); var second = Ui.Secret("Passphrase again");
      var error = Ui.T("", 13.5, null, Ui.Orange); error.Visibility = Visibility.Collapsed;
      var go = Ui.Pill(creating ? "Encrypt and Back Up" : "Open", () => {
        if (creating && first.Password.Length < 8) { error.Text = "Use at least 8 characters."; error.Visibility = Visibility.Visible; return; }
        if (creating && first.Password != second.Password) { error.Text = "The two passphrases differ."; error.Visibility = Visibility.Visible; return; }
        if (!creating && first.Password.Length == 0) { error.Text = "Enter the passphrase this backup was made with."; error.Visibility = Visibility.Visible; return; }
        choice.Value = first.Password; choice.Cancelled = false; sheet.Close();
      }, true);
      go.IsDefault = true;
      var buttons = Ui.Wrap(go);
      if (creating) buttons.Children.Add(Ui.Pill("Skip Encryption This Time", () => { choice.Skipped = true; choice.Cancelled = false; sheet.Close(); }));
      var cancel = Ui.Pill("Cancel", sheet.Close); cancel.IsCancel = true; buttons.Children.Add(cancel);
      var items = new List<UIElement> { Ui.Title2(creating ? "Encrypt this backup" : "This backup is encrypted") };
      items.Add(Ui.Secondary(creating
        ? "The file is unreadable without this passphrase, and there is no way to recover it: a lost passphrase is a lost backup. Keep it somewhere other than the backup."
        : (filename ?? "The file") + " was sealed with a passphrase when it was made."));
      items.Add(Ui.Field("Passphrase", first));
      if (creating) items.Add(Ui.Field("Passphrase again", second));
      items.Add(error); items.Add(buttons);
      sheet.Body(Ui.Stack(14, items.ToArray()));
      sheet.Loaded += delegate { first.Focus(); };
      sheet.ShowDialog();
      return choice;
    }

    /// Whether a file on disk is a sealed Josi backup (its first bytes say so).
    public static bool IsSealed(string path) {
      try {
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
          var head = new byte[6]; var n = stream.Read(head, 0, 6);
          return n == 6 && System.Text.Encoding.ASCII.GetString(head) == "JOSIP1";
        }
      } catch (Exception) { return false; }
    }

    /// Back up now and save the file where the person chooses. Returns the
    /// receipt sentence, or null when nothing happened.
    public static async Task<string> BackUpAndSave(AppModel model, Window owner, bool masterKeyConfirmed, Action<string> status, Func<bool> cancelled) {
      var api = model.Api; if (api == null) return null;
      var passphrase = AskPassphrase(owner, true);
      if (passphrase.Cancelled) return null;
      var encrypted = !passphrase.Skipped;
      var stamp = DateTime.Now.ToString("yyyy-MM-dd-HHmm");
      var dialog = new Microsoft.Win32.SaveFileDialog {
        FileName = "josi-backup-" + stamp + (encrypted ? ".josi-backup" : ".zip"),
        Filter = encrypted ? "Encrypted Josi backup (*.josi-backup)|*.josi-backup" : "ZIP archive (*.zip)|*.zip",
        Title = "Save the backup",
      };
      if (dialog.ShowDialog(owner) != true) return null;
      var destination = dialog.FileName;
      status("Backing up the database and attachments…");
      var body = Wires.O("kind", "full", "masterKeyConfirmed", masterKeyConfirmed);
      if (encrypted) body["passphrase"] = passphrase.Value;
      var created = await api.Request("/ops/admin/backups", "POST", body);
      var id = api.Uuid(created["backup"].Id);
      // The server writes the file while the row says running; wait for it.
      Wire row = created["backup"];
      for (var i = 0; i < 1800 && row["state"].Text != "complete" && row["state"].Text != "failed"; i++) {
        if (cancelled()) throw new OperationCanceledException();
        await Task.Delay(1000);
        var list = await api.Request("/ops/admin/backups");
        row = list["backups"].List.FirstOrDefault(b => b.Id == id) ?? row;
        status((row["progress_phase"].Text.Length > 0 ? Wires.Capitalize(row["progress_phase"].Text) : "Working") + "…");
      }
      if (row["state"].Text != "complete") throw new JosiException("The backup did not finish: " + Wires.Words(row["error_category"].Text.Length > 0 ? row["error_category"].Text : "unknown") + ".");
      long size; if (!long.TryParse(row["byte_size"].Text, out size) || size <= 0) size = (long)row["byte_size"].Number;
      status("Saving " + Wires.Bytes(size) + "…");
      await api.DownloadBackup(id, size, destination, count => status("Saving backup: " + Wires.Bytes(count) + " of " + Wires.Bytes(size)), cancelled);
      return "Backup saved to " + destination + " (" + Wires.Bytes(size) + (encrypted ? ", encrypted" : "") + "). "
        + "Copy it somewhere other than this PC. The installation master key is not inside it; keep that separately.";
    }

    /// Restore from a file. On a server with an owner: upload, read the
    /// manifest, show what restoring means, confirm by typing a word, restore.
    /// On a brand-new server (setup): one step. Returns the outcome sentence
    /// or null when cancelled.
    public static async Task<string> RestoreFromFile(AppModel model, Window owner, bool fresh, Action<string> status, Func<bool> cancelled) {
      var api = model.Api; if (api == null) return null;
      var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "Josi backups (*.zip;*.josi-backup)|*.zip;*.josi-backup|All files (*.*)|*.*", Title = "Choose a Josi backup", CheckFileExists = true };
      if (dialog.ShowDialog(owner) != true) return null;
      var path = dialog.FileName;
      string passphrase = null;
      if (IsSealed(path)) {
        var choice = AskPassphrase(owner, false, Path.GetFileName(path));
        if (choice.Cancelled) return null;
        passphrase = choice.Value;
      }
      var fields = new Dictionary<string, string>();
      if (passphrase != null) fields["passphrase"] = passphrase;
      if (fresh) {
        if (!Dialogs.Confirm(owner, "Restore " + Path.GetFileName(path) + " onto this new server?",
          "Everything in the backup comes back: people, conversations, settings and connections. Saved logins need the installation master key from the old server as well.", "Restore")) return null;
        status("Uploading and restoring…");
        var result = await api.UploadArchive("/setup/restore", path, fields, count => status("Uploading: " + Wires.Bytes(count)), cancelled);
        return "Restored from " + Path.GetFileName(path) + (result["attachmentsRestored"].Integer > 0 ? " with " + result["attachmentsRestored"].Integer + " attachment(s)" : "") + ". "
          + (result["warning"].Text.Length > 0 ? result["warning"].Text + " " : "") + "Sign in with an account from the backup.";
      }
      status("Uploading and reading the backup…");
      var staged = await api.UploadArchive("/ops/admin/restore/stage", path, fields, count => status("Uploading: " + Wires.Bytes(count)), cancelled);
      status("");
      if (!ConfirmRestore(owner, staged, Path.GetFileName(path))) return null;
      status("Restoring… this takes a moment. Josi takes a snapshot first.");
      var body = Wires.O("confirm", "restore", "stagedId", staged["stagedId"].Text);
      if (passphrase != null) body["passphrase"] = passphrase;
      var outcome = await api.Request("/ops/admin/restore", "POST", body);
      return "Restored. " + outcome["rowsRestored"].Integer + " database rows and " + Math.Max(0, outcome["attachmentsRestored"].Integer) + " attachment(s) came back."
        + (outcome["warning"].Text.Length > 0 ? " " + outcome["warning"].Text : "") + " Everyone is signed out; sign in again.";
    }

    static bool ConfirmRestore(Window owner, Wire staged, string filename) {
      var sheet = new Dialogs.Sheet(owner, "Restore from a backup", 600);
      var ok = false;
      var manifest = staged["manifest"];
      var facts = Ui.Stack(4,
        Ui.T(filename, 14, FontWeights.Medium),
        Ui.Caption("Made " + (manifest["createdAt"].Text.Length > 0 ? Wires.Date(manifest["createdAt"].Text) : "at an unknown time") + " by Josi " + manifest["josiVersion"].Text
          + " · " + Wires.Bytes(staged["byteSize"].Number) + (staged["encrypted"].Flag ? " · encrypted" : "")),
        Ui.Caption("Inside: the whole database" + (staged["attachments"].Integer > 0 ? " and " + staged["attachments"].Integer + " attachment(s)" : "") + "."));
      var refusals = staged["refusals"].List.Select(r => r.Text).ToList();
      var warnings = staged["warnings"].List.Select(w => w.Text).ToList();
      var notes = Ui.Stack(6);
      foreach (var r in refusals) notes.Children.Add(Ui.T("✕  " + r, 13.5, null, Ui.Orange));
      foreach (var w in warnings) notes.Children.Add(Ui.T("•  " + w, 13.5, null, Ui.Muted));
      var typed = Ui.Input("Type restore to continue");
      var go = Ui.Danger("Restore and Replace Everything", () => { ok = true; sheet.Close(); });
      go.IsEnabled = false;
      typed.TextChanged += delegate { go.IsEnabled = refusals.Count == 0 && typed.Text.Trim().Equals("restore", StringComparison.OrdinalIgnoreCase); };
      var cancel = Ui.Pill("Cancel", sheet.Close); cancel.IsCancel = true;
      sheet.Body(Ui.Stack(14, Ui.Title2("Restore from a backup"), facts, notes,
        refusals.Count == 0 ? Ui.Field("To confirm, type the word restore", typed) : Ui.Caption("This file cannot be restored here."),
        Ui.Wrap(go, cancel)));
      sheet.ShowDialog();
      return ok;
    }
  }
}
