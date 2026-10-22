using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Media;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Josi.Native {
  /// Administrator: the optional local Voice Box. Install or enable, speech
  /// settings (voice, transcription model, CPU or NVIDIA GPU, detection
  /// threshold, pause, speed), preview, restart, update, roll back, remove.
  public sealed class VoiceBoxView : SectionView {
    Wire status = Wire.Null;
    string voice = "af_heart", transcription = "base.en", device = "cpu";
    readonly TextBox threshold = Ui.Input("0.5"), silence = Ui.Input("800"), speed = Ui.Input("1.0");
    bool settingsLoaded;
    readonly DispatcherTimer poll = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
    public VoiceBoxView(AppModel model, Window owner) : base(model, owner) { poll.Tick += delegate { if (status["phase"].Text == "working") StartLoad(); else poll.Stop(); }; }
    protected override void OnLeave() { poll.Stop(); }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp; var s = await api.Request("/admin/voice-box");
      if (!Current(stamp)) return;
      status = s;
      if (!settingsLoaded && !s["settings"].IsNull) {
        var st = s["settings"]; settingsLoaded = true;
        voice = st["voice"].Text; transcription = st["model"].Text; device = st["device"].Text.Length > 0 ? st["device"].Text : "cpu";
        threshold.Text = st["threshold"].Number.ToString("0.##"); silence.Text = st["silenceMs"].Integer.ToString(); speed.Text = st["speed"].Number.ToString("0.##");
      }
      if (s["phase"].Text == "working") poll.Start();
    }
    void Operation(string name, object body = null) {
      Perform(async (api, stamp) => { await api.Request("/admin/voice-box/" + name, "POST", body ?? Wires.O()); poll.Start(); });
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Voice Box", "Optional local voice chat. Kokoro speaks on your CPU and Whisper transcribes. Audio stays on this installation; transcripts go through your configured model and its permissions.", Ui.Pill("Refresh", StartLoad)));
      if (status.IsNull) { Ui.Add(page, Ui.Secondary(loading ? "Checking Voice Box…" : "Voice Box status has not loaded."), 0); return page; }
      var managed = status["managedByInstaller"].Flag; var working = model.Busy || status["phase"].Text == "working";
      Ui.Add(page, Ui.Secondary(working ? "Applying changes and checking speech models…" : status["healthy"].Flag ? "Speech models are ready." : status["apiReady"].Flag ? "Speech models are starting." : status["phase"].Text == "absent" ? (managed ? "Voice Box is turned off." : "Voice Box is not installed.") : "Voice Box is not ready."), 0);
      if (status["error"].Text.Length > 0) Ui.Add(page, Ui.T(status["error"].Text, 13.5, null, Ui.Orange), 0);
      if (!status["verified"].Flag) {
        var items = new List<UIElement>();
        foreach (var r in status["requirements"].List) items.Add(Ui.Caption("• " + r.Text));
        items.Add(Ui.Caption("Kokoro weights and the Heart and Bella voices use Apache-2.0 terms; Whisper uses MIT terms. No microphone audio is sent to a speech provider."));
        if (!status["helperAvailable"].Flag) items.Add(Ui.Caption("The server operator must enable the optional Voice Box helper once."));
        else if (!status["releaseAvailable"].Flag) items.Add(Ui.Caption("A Voice Box release has not yet been authorized."));
        var install = Ui.Pill(managed ? "Enable Voice Box" : "Install Voice Box", () => Operation("install"), true);
        install.IsEnabled = status["helperAvailable"].Flag && status["releaseAvailable"].Flag && !working;
        items.Add(install);
        Ui.Add(page, Ui.CardBox(managed ? "Enable local voice" : "Before you install", items.ToArray()), 0);
        return page;
      }
      foreach (var box in new[] { threshold, silence, speed }) Ui.Detach(box);
      var gpu = status["gpuAvailable"].Flag;
      var settings = new List<UIElement> {
        Ui.Field("Voice", new ContentControl { Focusable = false, Content = Ui.Segments(Ui.Options("af_heart", "Heart · US English", "af_bella", "Bella · US English"), voice, v => { voice = v; Render(); }) }),
        Ui.Field("Transcription model", new ContentControl { Focusable = false, Content = Ui.Segments(Ui.Options("base.en", "Whisper Base · English", "tiny.en", "Whisper Tiny · lighter"), transcription, v => { transcription = v; Render(); }) }),
        Ui.Field("Transcription acceleration", new ContentControl { Focusable = false, Content = Ui.Segments(gpu ? Ui.Options("cpu", "CPU", "cuda", "NVIDIA GPU") : Ui.Options("cpu", "CPU"), device, v => { device = v; Render(); }) }),
        gpu ? null : Ui.Caption("No NVIDIA GPU was detected, so transcription uses the CPU."),
        Ui.Field("Speech detection threshold (0.2–0.9)", threshold), Ui.Field("Pause before sending, in milliseconds (300–1800)", silence), Ui.Field("Speaking speed (0.7–1.4)", speed),
        Ui.Caption("Save and wait for model verification before previewing a new voice.") };
      var actions = Ui.Wrap(Ui.Pill("Save and Verify", Save, true), Ui.Pill("Preview Voice", Preview), Ui.Pill("Restart", () => Operation("restart")));
      if (!managed) actions.Children.Add(Ui.Pill("Update Voice Box", () => Operation("update")));
      var back = Ui.Pill(managed ? "Restore Previous Settings" : "Roll Back", () => Operation("rollback")); back.IsEnabled = !status["previous"].IsNull; actions.Children.Add(back);
      actions.Children.Add(Ui.Danger(managed ? "Turn Off Voice Box…" : "Uninstall…", () => {
        if (Dialogs.Confirm(owner, managed ? "Turn off local voice?" : "Remove Voice Box?", "Conversations and settings are preserved. You can enable it again here.", managed ? "Turn Off" : "Uninstall")) Operation("uninstall");
      }));
      settings.Add(actions);
      if (managed) settings.Add(Ui.Caption("Voice Box updates are included in Josi updates."));
      var card = Ui.CardBox("Speech settings", settings.ToArray());
      card.IsEnabled = status["healthy"].Flag && !working;
      Ui.Add(page, card, 0);
      Ui.Add(page, Note(), 0);
      return page;
    }
    void Save() {
      double t, sp; int si;
      if (!double.TryParse(threshold.Text, out t) || t < 0.2 || t > 0.9 || !int.TryParse(silence.Text, out si) || si < 300 || si > 1800 || !double.TryParse(speed.Text, out sp) || sp < 0.7 || sp > 1.4) {
        model.Error = "Check the threshold (0.2–0.9), pause (300–1800 ms) and speed (0.7–1.4)."; model.Notify(); return;
      }
      Operation("settings", Wires.O("voice", voice, "model", transcription, "device", device, "threshold", t, "silenceMs", si, "speed", sp));
    }
    void Preview() {
      Perform(async (api, stamp) => {
        var audio = await api.VoiceAudio("/admin/voice-box/preview", Wires.O());
        await Task.Run(() => { using (var player = new SoundPlayer(new MemoryStream(audio))) player.PlaySync(); });
      }, false);
    }
  }

  /// Administrator: the audit log. What happened and who did it; payloads are
  /// the server's own redacted summaries.
  public sealed class AuditView : SectionView {
    List<Wire> events = new List<Wire>();
    readonly TextBox filter = Ui.Input("Filter by kind, for example auth.login");
    public AuditView(AppModel model, Window owner) : base(model, owner) { filter.KeyDown += (s, e) => { if (e.Key == System.Windows.Input.Key.Enter) StartLoad(); }; }
    protected override double PageWidth() { return 1100; }
    protected override async Task Load() {
      var api = Api; var stamp = Stamp; var kind = filter.Text.Trim();
      var r = await api.Request("/admin/events?limit=300" + (kind.Length > 0 ? "&kind=" + Uri.EscapeDataString(kind) : ""));
      if (Current(stamp)) events = r["events"].List;
    }
    protected override UIElement Build() {
      var page = Page(Ui.HeadingWith("Audit Log", "Sign-ins, approvals, connections, settings changes and other recorded events.", Ui.Pill("Refresh", StartLoad)));
      Ui.Detach(filter);
      Ui.Add(page, Ui.Row(10, filter, Ui.Pill("Filter", StartLoad)), 0); filter.Width = 360;
      if (events.Count == 0) { Ui.Add(page, Ui.Secondary(loading ? "Loading…" : "No events."), 0); return page; }
      // One row per event with a divider between rows; the record's details
      // stay small and quiet under the event name instead of a wall of JSON.
      var list = Ui.Stack(0);
      foreach (var e in events) {
        var payload = e["payload"].IsNull ? "" : e["payload"].Json;
        if (list.Children.Count > 0) list.Children.Add(Ui.Divider());
        var row = Ui.Stack(3, Ui.Spread(Ui.T(e["kind"].Text, 14, FontWeights.Medium), Ui.Caption(Wires.Date(e["created_at"].Text))),
          Ui.Caption(Wires.Capitalize(e["actor"].Text) + (e["actor_username"].Text.Length > 0 ? " · " + e["actor_username"].Text : "") + (e["subject_type"].Text.Length > 0 ? " · " + e["subject_type"].Text : "")),
          payload.Length > 2 && payload != "{}" ? Ui.Copyable(payload, 11.5, Ui.Muted, true) : null);
        row.Margin = new Thickness(0, 8, 0, 8);
        list.Children.Add(row);
      }
      Ui.Add(page, Ui.CardBox(null, list), 0);
      return page;
    }
  }
}
