using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;

namespace Josi.Native {
  /// A separate non-exportable executor key; enrolling it grants no permissions.
  /// Existing protected-approval enrollment and Hello keys are not replaced.
  /// Pairing is never started from the background: the loop only notes that
  /// approval is needed, and the person approves from setup, from PC Control,
  /// or when they turn control on from a chat card.
  sealed class PcAuthority {
    readonly string owner, keyName;
    DateTime nextCheck;
    bool approved;
    public PcAuthority(string origin, string owner) {
      this.owner = owner;
      keyName = KeyName(origin, owner);
    }
    /// The key name setup and the running app must agree on: one executor key
    /// per server, owner and PC.
    static string KeyName(string origin, string owner) { return "executor-" + ProtectedWire.Digest(origin + "\n" + owner + "\n" + JosiApi.DeviceId); }
    DeviceKey Key() { return DeviceKey.Open(keyName) ?? DeviceKey.Create(keyName); }
    /// This PC's executor public key for a server and owner, created if needed.
    /// Setup sends it with the owner's password so the PC is paired at install.
    public static string PublicPointFor(string origin, string owner, out bool hardware) {
      var name = KeyName(origin, owner);
      using (var key = DeviceKey.Open(name) ?? DeviceKey.Create(name)) { hardware = key.Hardware; return Convert.ToBase64String(key.PublicPoint()); }
    }
    /// True when the server has no key for this PC yet (or a different one), so
    /// the person has to approve it. Set by the loop, shown by PC Control.
    public bool NeedsApproval { get; private set; }
    /// Set when the server holds a different key: the old identity must be revoked first.
    public bool KeyChanged { get; private set; }
    public Dictionary<string,string> Proof(string method, Uri url, string body) {
      var time = ProtectedWire.Now(); var nonce = Guid.NewGuid().ToString();
      var message = "pc-executor.1\n" + Canon.Array(owner, JosiApi.DeviceId, method, url.PathAndQuery, time, nonce, ProtectedWire.Digest(body ?? ""));
      using (var key = Key()) return new Dictionary<string,string> {
        {"x-josi-pc-time", time.ToString(System.Globalization.CultureInfo.InvariantCulture)},
        {"x-josi-pc-nonce", nonce}, {"x-josi-pc-proof", Convert.ToBase64String(key.HostSign(Encoding.UTF8.GetBytes(message)))}
      };
    }
    /// Whether this PC's key is the one the server knows. Never prompts; it
    /// asks the server at most every few seconds and records what is missing.
    public async Task<bool> Ensure(JosiApi api) {
      if (approved) return true;
      if (DateTime.UtcNow < nextCheck) return false;
      nextCheck = DateTime.UtcNow.AddSeconds(5);
      var identity = await api.Request("/admin/pc-control/identity");
      using (var key = DeviceKey.Open(keyName)) {
        if (key != null && Convert.ToBase64String(key.PublicPoint()) == identity["publicKey"].Text) { approved = true; NeedsApproval = false; KeyChanged = false; return true; }
      }
      KeyChanged = identity["publicKey"].Text.Length > 0;
      NeedsApproval = true;
      return false;
    }
    /// Pair this PC: the person's password, once, in the protected form. Called
    /// from PC Control's "Approve This PC" and after a chat card turns control on.
    public async Task<bool> Approve(JosiApi api, Window window) {
      if (approved) return true;
      var identity = await api.Request("/admin/pc-control/identity");
      if (identity["publicKey"].Text.Length > 0) {
        using (var existing = DeviceKey.Open(keyName))
          if (existing == null || Convert.ToBase64String(existing.PublicPoint()) != identity["publicKey"].Text)
            throw new JosiException("This PC's executor key changed. Revoke its old PC identity under PC Control before pairing it again.");
      }
      using (var key = Key()) {
        var point = Convert.ToBase64String(key.PublicPoint());
        var password = Dialogs.AskPassword(window, "Approve computer control on " + Environment.MachineName,
          "Bind this PC to your signed-in Josi account so Josi can work on it. This does not grant app, file, terminal or administrator permissions by itself; those are chosen under PC Control or in chat.\n\nPC: " + JosiApi.DeviceId + "\nKey: " + ProtectedWire.Digest(point).Substring(0,24) + "\n" + (key.Hardware ? "Windows hardware key" : "Windows protected software key"), "Approve this PC");
        if (password == null) return false;
        await api.Request("/admin/pc-control/identity", "POST", Wires.O("publicKey", point, "password", password));
        approved = true; NeedsApproval = false; KeyChanged = false; return true;
      }
    }
  }
}
