using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;

namespace Josi.Native {
  /// A separate non-exportable executor key; enrolling it grants no permissions.
  /// Existing protected-approval enrollment and Hello keys are not replaced.
  sealed class PcAuthority {
    readonly string owner, keyName;
    DateTime nextPrompt;
    bool approved;
    public PcAuthority(string origin, string owner) {
      this.owner = owner;
      keyName = "executor-" + ProtectedWire.Digest(origin + "\n" + owner + "\n" + JosiApi.DeviceId);
    }
    DeviceKey Key() { return DeviceKey.Open(keyName) ?? DeviceKey.Create(keyName); }
    public Dictionary<string,string> Proof(string method, Uri url, string body) {
      var time = ProtectedWire.Now(); var nonce = Guid.NewGuid().ToString();
      var message = "pc-executor.1\n" + Canon.Array(owner, JosiApi.DeviceId, method, url.PathAndQuery, time, nonce, ProtectedWire.Digest(body ?? ""));
      using (var key = Key()) return new Dictionary<string,string> {
        {"x-josi-pc-time", time.ToString(System.Globalization.CultureInfo.InvariantCulture)},
        {"x-josi-pc-nonce", nonce}, {"x-josi-pc-proof", Convert.ToBase64String(key.HostSign(Encoding.UTF8.GetBytes(message)))}
      };
    }
    public async Task<bool> Ensure(JosiApi api, Window window) {
      if (approved) return true;
      if (DateTime.UtcNow < nextPrompt) return false;
      var identity = await api.Request("/admin/pc-control/identity");
      using (var key = DeviceKey.Open(keyName)) {
        if (key != null && Convert.ToBase64String(key.PublicPoint()) == identity["publicKey"].Text) { approved = true; return true; }
      }
      if (!identity["enabled"].Flag) { nextPrompt = DateTime.UtcNow.AddSeconds(5); return false; }
      if (identity["publicKey"].Text.Length > 0) throw new JosiException("This PC's executor key changed. Revoke its old PC identity before pairing it again.");
      nextPrompt = DateTime.UtcNow.AddMinutes(5);
      using (var key = Key()) {
        var point = Convert.ToBase64String(key.PublicPoint());
        var password = Dialogs.AskPassword(window, "Approve computer control on " + Environment.MachineName,
          "Bind this PC to your signed-in Josi account. This does not grant app, file, terminal or administrator permissions.\n\nPC: " + JosiApi.DeviceId + "\nKey: " + ProtectedWire.Digest(point).Substring(0,24) + "\n" + (key.Hardware ? "Windows hardware key" : "Windows protected software key"), "Approve this PC");
        if (password == null) return false;
        await api.Request("/admin/pc-control/identity", "POST", Wires.O("publicKey", point, "password", password));
        approved = true; return true;
      }
    }
  }
}
