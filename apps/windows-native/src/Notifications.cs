using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Josi.Native {
  /// Windows notifications for approvals waiting, reminders that fired and
  /// replies that finished while Josi was in the background. The app's
  /// notification identity is registered for this Windows account only;
  /// clicking a notification opens Josi (josi://open). Test runs never notify.
  static class Notifications {
    const string AppId = "SOCALReceptionist.Josi";
    [DllImport("shell32.dll")] static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);
    static bool ready;

    public static void Register() {
      if (AppLinks.Testing) return;
      try {
        SetCurrentProcessExplicitAppUserModelID(AppId);
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Josi");
        Directory.CreateDirectory(folder);
        var icon = Path.Combine(folder, "josi-notification.png");
        if (!File.Exists(icon))
          using (var source = typeof(Notifications).Assembly.GetManifestResourceStream("josi-mark.png"))
          using (var target = File.Create(icon)) if (source != null) source.CopyTo(target);
        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppUserModelId\" + AppId)) {
          key.SetValue("DisplayName", "Josi");
          key.SetValue("IconUri", icon);
          key.SetValue("IconBackgroundColor", "FF0B111E");
        }
        ready = true;
      } catch (Exception) { ready = false; }
    }

    public static void Show(string title, string body) {
      if (!ready) return;
      try {
        var xml = new Windows.Data.Xml.Dom.XmlDocument();
        xml.LoadXml("<toast launch=\"josi://open\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\"><text>" + SecurityElement.Escape(Trim(title, 120)) +
          "</text><text>" + SecurityElement.Escape(Trim(body, 300)) + "</text></binding></visual></toast>");
        Windows.UI.Notifications.ToastNotificationManager.CreateToastNotifier(AppId).Show(new Windows.UI.Notifications.ToastNotification(xml));
      } catch (Exception) { }
    }
    static string Trim(string value, int max) { value = (value ?? "").Replace("\r", " ").Replace("\n", " ").Trim(); return value.Length > max ? value.Substring(0, max - 1) + "…" : value; }
  }

  /// Watches for things worth a notification while Josi is signed in: new
  /// approvals and reminders delivered since the last look. What is already
  /// there at sign-in is not announced.
  sealed class NotificationWatcher {
    readonly HashSet<string> approvals = new HashSet<string>(), reminders = new HashSet<string>(), proposals = new HashSet<string>(), applying = new HashSet<string>();
    bool seeded; string owner = "";
    public async Task Check(AppModel model) {
      var api = model.Api; if (api == null || model.Screen != Screen.Workspace) return;
      if (owner != model.User["id"].Text) { owner = model.User["id"].Text; seeded = false; approvals.Clear(); reminders.Clear(); proposals.Clear(); applying.Clear(); }
      try {
        var a = (await api.Request("/assistant/approvals"))["approvals"].List;
        var r = (await api.Request("/assistant/reminders"))["recent"].List.Where(x => x["status"].Text == "delivered").ToList();
        foreach (var item in a) if (approvals.Add(item.Id) && seeded) Notifications.Show("Josi needs your approval", item["summary"].Text);
        foreach (var item in r) if (reminders.Add(item.Id) && seeded) Notifications.Show("Reminder", item["body"].Text);
        seeded = true;
      } catch (JosiException) { }
      await CheckSettingsChanges(model, api);
    }
    /// Settings changes Josi prepared in conversation: a popup asks the person
    /// who can make it live; one approved for this person's own app is applied
    /// now; an administrator hears about other people's proposals as a toast.
    async Task CheckSettingsChanges(AppModel model, JosiApi api) {
      Wire list;
      try { list = await api.Request("/settings-changes"); } catch (JosiException) { return; }
      if (model.Api != api) return;
      foreach (var item in list["proposals"].List) {
        var id = item.Id;
        if (item["state"].Text == "approved" && !item["apply"].IsNull) {
          if (applying.Add(id)) await model.ApplySettingsChange(item, item["apply"]);
          continue;
        }
        if (item["state"].Text != "proposed" || !proposals.Add(id)) continue;
        if (item["canApprove"].Flag) model.OfferSettingsChange(item);
        else if (!item["mine"].Flag) Notifications.Show("Settings change proposed", item["proposer"].Text + ": " + item["title"].Text);
      }
    }
  }

  /// "Send to › Josi" in File Explorer: files sent there are attached to the
  /// conversation you have open. Registered for this Windows account only.
  static class SendTo {
    public static void Register() {
      if (AppLinks.Testing) return;
      try {
        var exe = Environment.ProcessPath; if (string.IsNullOrEmpty(exe)) return;
        var link = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.SendTo), "Josi.lnk");
        var type = Type.GetTypeFromProgID("WScript.Shell"); if (type == null) return;
        dynamic shell = Activator.CreateInstance(type);
        dynamic shortcut = shell.CreateShortcut(link);
        if (File.Exists(link) && string.Equals((string)shortcut.TargetPath, exe, StringComparison.OrdinalIgnoreCase)) return;
        shortcut.TargetPath = exe; shortcut.Arguments = "--share"; shortcut.IconLocation = exe + ",0"; shortcut.Description = "Attach to a Josi conversation";
        shortcut.Save();
      } catch (Exception) { }
    }
  }
}
