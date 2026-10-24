using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Josi.Native {
  /// Item 29: protected approvals with Windows Hello. Enrolls this PC as a
  /// confirmation device and reviews protected changes (rules, permissions,
  /// device revocation) the way the Mac app does: the server prepares the
  /// exact change, this PC proves itself with its key, shows the exact wording
  /// and meaning, asks Windows Hello, signs, and the server saves to the Vault.
  public static class ProtectedApproval {
    /// Password and authenticator code for a change the server protects.
    static bool Credentials(Window owner, string title, string detail, string action, out string password, out string code) {
      var sheet = new Dialogs.Sheet(owner, "Josi", 520);
      string gotPassword = null, gotCode = "";
      var box = Ui.Secret("Your account password"); var mfa = Ui.Input("Authenticator code, if you use one");
      var go = Ui.Pill(action, () => { if (box.Password.Length == 0) return; gotPassword = box.Password; gotCode = mfa.Text.Trim(); box.Clear(); sheet.Close(); }, true);
      go.IsDefault = true;
      var cancel = Ui.Pill("Cancel", () => { box.Clear(); sheet.Close(); }); cancel.IsCancel = true;
      sheet.Body(Ui.Stack(14, Ui.T(title, 17, FontWeights.SemiBold), Ui.Copyable(detail, 14, Ui.Muted),
        Ui.Field("Confirm your account password", box), Ui.Field("Authenticator code (optional)", mfa), Ui.Spread(null, Ui.Row(8, cancel, go))));
      sheet.Loaded += delegate { box.Focus(); };
      sheet.ShowDialog();
      password = gotPassword; code = gotCode;
      return gotPassword != null;
    }

    /// The review window: the exact change, a countdown, Approve and Cancel,
    /// then the phases of saving. Modeless, so the flow keeps running under it.
    sealed class ReviewSheet {
      readonly Dialogs.Sheet sheet; readonly StackPanel actions; readonly TextBlock status, clock; readonly long expires;
      readonly TaskCompletionSource<bool> decision = new TaskCompletionSource<bool>();
      readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
      public bool Closed;
      public ReviewSheet(Window owner, string title, string approveLabel, Wire challenge, string origin, string note) {
        sheet = new Dialogs.Sheet(owner, "Josi — Protected approval", 640);
        expires = challenge["expiresAtMs"].Integer;
        var p = challenge["presentation"];
        var approve = Ui.Pill(approveLabel, () => decision.TrySetResult(true), true);
        var cancel = Ui.Pill("Cancel", () => { decision.TrySetResult(false); sheet.Close(); }); cancel.IsCancel = true;
        actions = Ui.Row(8, cancel, approve);
        status = Ui.Secondary(""); status.Visibility = Visibility.Collapsed;
        clock = Ui.Caption("");
        var advice = p["advisory"].List.Select(a => (UIElement)Ui.Caption(a.Text)).ToArray();
        var items = new List<UIElement> {
          Ui.Row(10, Ui.JosiMark(28), Ui.T(title, 17, FontWeights.SemiBold)),
          Ui.Copyable(origin, 14), Ui.Caption("Administrator: " + challenge["userId"].Text + "\nDevice: " + challenge["deviceId"].Text),
          Ui.T(p["wording"].Text, 15, FontWeights.SemiBold), Ui.Copyable(p["meaning"].Text, 13),
        };
        items.AddRange(advice);
        if (note != null) items.Add(Ui.Secondary(note));
        items.Add(status); items.Add(Ui.Spread(clock, actions));
        sheet.Body(Ui.Stack(12, items.ToArray()));
        sheet.Closed += delegate { Closed = true; timer.Stop(); decision.TrySetResult(false); };
        timer.Tick += delegate { Tick(); };
        Tick(); timer.Start();
        sheet.Show();
        sheet.Activate();
      }
      void Tick() {
        var left = (expires - ProtectedWire.Now()) / 1000;
        if (left <= 0) { decision.TrySetResult(false); sheet.Locked = false; sheet.Close(); return; }
        clock.Text = "This review expires in " + left + " s";
      }
      public Task<bool> Decide() { return decision.Task; }
      public void Phase(string text) {
        actions.Visibility = Visibility.Collapsed; status.Visibility = Visibility.Visible;
        status.Text = text; sheet.Locked = true;
      }
      public void Finish(string text, bool ok) {
        timer.Stop(); sheet.Locked = false; clock.Text = "";
        status.Visibility = Visibility.Visible; status.Text = text; status.Foreground = ok ? Ui.Muted : Ui.Orange;
        actions.Children.Clear(); actions.Children.Add(Ui.Pill("Close", () => sheet.Close(), true)); actions.Visibility = Visibility.Visible;
      }
      public void Close() { if (!Closed) { sheet.Locked = false; sheet.Close(); } }
      public void Require() { if (Closed) throw new JosiException("The review was closed."); if (expires <= ProtectedWire.Now()) throw new JosiException("The protected review expired. Start it again."); }
    }

    static string Short(string text, int max) { return text.Length <= max ? text : text.Substring(0, max) + "…"; }

    /// Enroll this PC as a protected confirmation device.
    public static async Task Enroll(Window owner, AppModel model) {
      var api = model.Api; if (api == null || !model.IsAdministrator) return;
      var userId = model.User["id"].Text; var origin = api.OriginText;
      if (!model.AutomationCatalog["capabilities"]["deviceEnrollment"].Flag) {
        Dialogs.Message(owner, "This server cannot approve an enrollment right now.",
          "Enrolling a PC needs the Josi app on the computer that runs the server, signed in to Windows with a screen, so the request can be approved there. On a dedicated server that runs as a service this is not available yet. The server also needs an https address or localhost.");
        return;
      }
      if (!await Hello.Available()) {
        Dialogs.Message(owner, "Set up Windows Hello first.", "Protected approvals use your fingerprint, face or PIN. Set one up in Windows Settings › Accounts › Sign-in options, then try again.");
        return;
      }
      // Name, password, code.
      var sheet = new Dialogs.Sheet(owner, "Josi", 540);
      string label = null, password = null, code = "";
      var name = Ui.Input("A name for this PC", Environment.MachineName); var box = Ui.Secret("Your account password"); var mfa = Ui.Input("Authenticator code, if you use one");
      var go = Ui.Pill("Create Device Key", () => {
        var trimmed = name.Text.Trim(); if (trimmed.Length == 0 || trimmed.Length > 120 || box.Password.Length == 0) return;
        label = trimmed; password = box.Password; code = mfa.Text.Trim(); box.Clear(); sheet.Close();
      }, true);
      go.IsDefault = true;
      var cancel = Ui.Pill("Cancel", () => { box.Clear(); sheet.Close(); }); cancel.IsCancel = true;
      sheet.Body(Ui.Stack(14, Ui.T("Enroll this PC for protected approvals", 17, FontWeights.SemiBold),
        Ui.Copyable("Server: " + origin + "\nAdministrator: " + userId + "\n\nA key for this PC is made in Windows' protected key store and tied to Windows Hello. You will see the exact request here and again in a window on the computer that runs the server, where it is approved with Windows Hello. Windows Hello asks up to three times while the key is made. Enrollment grants no automation access by itself.", 13, Ui.Muted),
        Ui.Field("Name of this PC", name), Ui.Field("Confirm your account password", box), Ui.Field("Authenticator code (optional)", mfa),
        Ui.Spread(null, Ui.Row(8, cancel, go))));
      sheet.Loaded += delegate { box.Focus(); };
      sheet.ShowDialog();
      if (label == null) return;

      string attempt = null, deviceId = null; var committed = false; ReviewSheet review = null; byte[] seed = null;
      try {
        var begun = await api.Request("/admin/automation/devices/enroll/begin", "POST", Wires.O("label", label));
        if (model.Api != api) throw new JosiException("The connection changed.");
        var identity = begun["identity"]; ProtectedWire.RequireIdentity(identity, origin, userId);
        attempt = api.Uuid(begun["attemptId"].Text); deviceId = identity["deviceId"].Text;
        var enrollmentId = api.Uuid(begun["enrollmentId"].Text);
        // This PC's keys.
        byte[] point, wrapped, spki;
        using (var key = DeviceKey.Create(deviceId)) {
          point = key.PublicPoint();
          var hello = await Hello.Create(deviceId);
          seed = RandomNumberGenerator.GetBytes(32);
          spki = Ed25519.SpkiPrefix.Concat(Ed25519.PublicKey(seed)).ToArray();
          wrapped = DeviceKey.Wrap(point, seed, hello);
          if (hello != null) Array.Clear(hello, 0, hello.Length);
        }
        var material = Wires.O("schemaVersion", 1L, "identity", identity, "wrappingPublicKey", Convert.ToBase64String(point),
          "signingPublicKeySpki", Convert.ToBase64String(spki), "wrappedPrivateKey", Convert.ToBase64String(wrapped));
        var prepared = await api.Request("/admin/automation/devices/enroll/" + attempt + "/prepare", "POST",
          Wires.O("material", material, "password", password, "mfaCode", code));
        password = null;
        if (model.Api != api) throw new JosiException("The connection changed.");
        var challenge = prepared["challenge"];
        if (challenge["id"].Text != attempt || challenge["enrollmentId"].Text != enrollmentId || !ProtectedWire.SameIdentity(challenge, identity)
            || challenge["requestDigest"].Text.Length != 64) throw new JosiException("The enrollment review does not match this attempt.");
        ProtectedWire.RequireLive(challenge);
        review = new ReviewSheet(owner, "Enroll " + Short(label, 60) + " with Josi?", "Approve with Windows Hello", challenge, origin,
          "The computer that runs the server shows this same request in its own window. Approve it there too; nothing is saved until both approvals are in.");
        if (!await review.Decide()) throw new JosiException("Enrollment cancelled.");
        review.Require();
        review.Phase("Windows Hello…");
        var secret = await Hello.Unlock(deviceId);
        Array.Clear(secret, 0, secret.Length);
        review.Require();
        var possession = ProtectedWire.Base64Url(Ed25519.Sign(seed, Encoding.UTF8.GetBytes(ProtectedWire.EnrollmentMessage(challenge["requestDigest"].Text))));
        Array.Clear(seed, 0, seed.Length); seed = null;
        review.Phase("Waiting for the approval on the computer that runs the server…");
        while (true) {
          review.Require();
          var status = await api.Request("/admin/automation/devices/enroll/" + attempt + "/status");
          if (model.Api != api) throw new JosiException("The connection changed.");
          var state = status["state"].Text;
          if (state == "approved") break;
          if (state != "waiting") throw new JosiException("The request was " + state + " on the server's computer.");
          await Task.Delay(1000);
        }
        review.Require();
        review.Phase("Saving to the Vault…");
        committed = true;
        var result = await api.Request("/admin/automation/devices/enroll/" + attempt + "/commit", "POST", Wires.O("possessionSignature", possession));
        if (!result["enrolled"].Flag || result["deviceId"].Text != deviceId || result["enrollmentId"].Text != enrollmentId) throw new JosiException("The server did not confirm the enrollment.");
        if (model.Api == api) { model.AutomationDevices = result["inventory"]; model.AutomationDevicesError = ""; }
        review.Finish("This PC is enrolled. Protected changes can now be approved here with Windows Hello.", true);
        model.Run(model.LoadAutomation);
      } catch (Exception e) {
        if (seed != null) Array.Clear(seed, 0, seed.Length);
        if (!committed) {
          if (attempt != null && model.Api == api) { try { await api.Request("/admin/automation/devices/enroll/" + attempt + "/cancel", "POST", Wires.O()); } catch (Exception) { } }
          if (deviceId != null) { DeviceKey.Delete(deviceId); await Hello.Delete(deviceId); }
        }
        var text = committed ? "The server's final answer was not confirmed. Refresh Automation before trying again; this PC may already be enrolled." : AppModel.Friendly(e);
        if (review != null && !review.Closed) review.Finish(text, false); else Dialogs.Message(owner, "Enrollment did not finish.", text);
        if (committed) model.Run(model.LoadAutomation);
      }
    }

    /// The enrolled device of this PC for this server, or null.
    public static Wire ThisPc(AppModel model) {
      var api = model.Api; if (api == null) return null;
      return model.AutomationDevices["devices"].List.FirstOrDefault(d => d["revokedAt"].IsNull && d["identity"]["serverOrigin"].Text == api.OriginText
        && d["identity"]["userId"].Text == model.User["id"].Text && DeviceKey.Exists(d["identity"]["deviceId"].Text));
    }

    /// Review and approve one protected change with this PC's key and Windows Hello.
    public static async Task Review(Window owner, AppModel model, string title, Dictionary<string, object> change) {
      var api = model.Api; if (api == null || !model.IsAdministrator) return;
      var userId = model.User["id"].Text; var origin = api.OriginText;
      var device = ThisPc(model);
      if (device == null) { Dialogs.Message(owner, "Enroll this PC first.", "Protected changes are approved on an enrolled PC with Windows Hello. Use \"Enroll This PC\" under Protected confirmation devices."); return; }
      var deviceId = device["identity"]["deviceId"].Text;
      string password, code;
      if (!Credentials(owner, title, "Confirm your account, then review the exact change and approve it with Windows Hello. Windows Hello alone does not approve the change; the exact wording you see is what is saved.", "Review the Change", out password, out code)) return;
      string id = null; var committed = false; ReviewSheet review = null; byte[] seed = null;
      try {
        var prepared = await api.Request("/admin/automation/protected/prepare", "POST", Wires.O("change", change, "deviceId", deviceId, "password", password, "mfaCode", code));
        password = null;
        if (model.Api != api) throw new JosiException("The connection changed.");
        id = api.Uuid(prepared["challengeId"].Text);
        var route = "/admin/automation/protected/" + id + "/";
        var host = (await api.Request(route + "host-challenge"))["challenge"];
        if (host["id"].Text != id) throw new JosiException("The server answered for another review.");
        ProtectedWire.RequireIdentity(host, origin, userId);
        if (host["deviceId"].Text != deviceId) throw new JosiException("The server answered for another device.");
        ProtectedWire.RequireLive(host);
        var hostMessage = ProtectedWire.HostMessage(host);
        byte[] hostSignature;
        using (var key = DeviceKey.Open(deviceId)) {
          if (key == null) throw new JosiException("This PC's protected key is missing. Enroll this PC again.");
          hostSignature = key.HostSign(Encoding.UTF8.GetBytes(hostMessage));
        }
        var proof = Wires.O("schemaVersion", 1L, "challengeId", id, "challengeDigest", ProtectedWire.Digest(hostMessage), "signature", ProtectedWire.Base64Url(hostSignature));
        var challenge = (await api.Request(route + "presentation", "POST", Wires.O("proof", proof)))["challenge"];
        if (model.Api != api) throw new JosiException("The connection changed.");
        if (challenge["id"].Text != id || !ProtectedWire.SameIdentity(host, challenge) || challenge["purpose"].Text != (string)change["kind"]
            || Wires.Serialize(challenge["keyReference"]) != Wires.Serialize(host["keyReference"])) throw new JosiException("The presentation does not match this review.");
        ProtectedWire.RequireLive(challenge);
        var message = ProtectedWire.ControlMessage(challenge);
        review = new ReviewSheet(owner, title, "Approve This Exact Change", challenge, origin, null);
        if (!await review.Decide()) throw new JosiException("No protected change was submitted.");
        review.Require();
        if (!(await api.Request(route + "current"))["current"].Flag) throw new JosiException("The change is no longer current. Review it again.");
        review.Require();
        review.Phase("Opening the signing key…");
        var projection = (await api.Request(route + "projection", "POST", Wires.O("proof", proof)))["projection"];
        if (model.Api != api) throw new JosiException("The connection changed.");
        var material = projection["material"];
        if (projection["schemaVersion"].Integer != 1 || Wires.Serialize(projection["reference"]) != Wires.Serialize(challenge["keyReference"])
            || !ProtectedWire.SameIdentity(material["identity"], challenge) || projection["expiresAtMs"].Integer <= ProtectedWire.Now()) throw new JosiException("The signing key projection does not match this review.");
        var wrapped = Convert.FromBase64String(material["wrappedPrivateKey"].Text);
        review.Phase("Windows Hello…");
        var hello = DeviceKey.NeedsHello(wrapped) ? await Hello.Unlock(deviceId) : null;
        if (hello == null) { var gesture = await Hello.Unlock(deviceId); Array.Clear(gesture, 0, gesture.Length); }
        review.Require();
        using (var key = DeviceKey.Open(deviceId)) {
          if (key == null) throw new JosiException("This PC's protected key is missing. Enroll this PC again.");
          seed = key.Unwrap(wrapped, hello);
        }
        if (hello != null) Array.Clear(hello, 0, hello.Length);
        var spki = Convert.FromBase64String(material["signingPublicKeySpki"].Text);
        if (!spki.Skip(12).SequenceEqual(Ed25519.PublicKey(seed))) throw new JosiException("The signing key does not match this PC's enrollment.");
        var signature = ProtectedWire.Base64Url(Ed25519.Sign(seed, Encoding.UTF8.GetBytes(message)));
        Array.Clear(seed, 0, seed.Length); seed = null;
        review.Require();
        if (!(await api.Request(route + "current"))["current"].Flag) throw new JosiException("The change is no longer current. Review it again.");
        review.Phase("Saving to the Vault…");
        committed = true;
        var result = await api.Request(route + "commit", "POST", Wires.O("receipt",
          Wires.O("schemaVersion", 1L, "challengeId", id, "challengeDigest", ProtectedWire.Digest(message), "signature", signature)));
        if (!result["applied"].Flag) throw new JosiException("The server did not confirm the change.");
        review.Finish("Saved to the Vault.", true);
        model.Run(model.LoadAutomation);
      } catch (Exception e) {
        if (seed != null) Array.Clear(seed, 0, seed.Length);
        if (!committed && id != null && model.Api == api) { try { await api.Request("/admin/automation/protected/" + id + "/cancel", "POST", Wires.O()); } catch (Exception) { } }
        var text = committed ? "The server's final answer was not confirmed. Refresh Automation before another review; the change may already be saved." : AppModel.Friendly(e);
        if (review != null && !review.Closed) review.Finish(text, false); else Dialogs.Message(owner, "The protected change was not saved.", text);
        if (committed) model.Run(model.LoadAutomation);
      }
    }
  }
}
