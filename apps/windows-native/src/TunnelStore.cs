using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Josi.Native {
  /// Paired servers on this PC. The device keys go in Windows Credential Manager
  /// beside the remembered sign-ins (encrypted by Windows for this account, never
  /// roamed). What isn't secret sits in a file: the server's public key, its
  /// addresses, its name.
  public sealed class TunnelStore : ITunnelStore {
    public static readonly TunnelStore Current = new TunnelStore();
    const int KeySize = X25519.KeySize;
    readonly object gate = new object();
    static string File { get { return Path.Combine(AppLinks.StateDirectory, AppLinks.Testing ? "pairings-test" + AppLinks.Instance + ".json" : "pairings.json"); } }

    static Dictionary<string, object> Read() {
      try { var value = Wires.Parse(System.IO.File.ReadAllText(File)).Raw as Dictionary<string, object>; if (value != null) return value; } catch (IOException) { } catch (UnauthorizedAccessException) { }
      return new Dictionary<string, object>();
    }
    static void Write(Dictionary<string, object> all) {
      var path = File; var temporary = path + ".new";
      Directory.CreateDirectory(Path.GetDirectoryName(path));
      System.IO.File.WriteAllText(temporary, Wires.Serialize(all));
      System.IO.File.Move(temporary, path, true);
    }

    /// Every pairing whose key is still here, oldest first.
    public List<TunnelPairing> All() {
      lock (gate) {
        var result = new List<TunnelPairing>();
        foreach (var entry in Read()) {
          var pairing = TunnelPairing.FromMetadata(new Wire(entry.Value));
          if (pairing == null) continue;
          var secret = SessionStore.LoadTunnelKeys(pairing.Site);
          if (secret == null) continue;
          try {
            if (secret.Length != KeySize && secret.Length != 2 * KeySize) continue;
            pairing.DeviceKey = secret.AsSpan(0, KeySize).ToArray();
            if (secret.Length == 2 * KeySize) pairing.PendingKey = secret.AsSpan(KeySize).ToArray();
            result.Add(pairing);
          } finally { Array.Clear(secret, 0, secret.Length); }
        }
        return result;
      }
    }

    /// The key first: a record without its key is dropped when read, while a key
    /// without its record is simply replaced.
    public void Save(TunnelPairing pairing) {
      lock (gate) {
        var secret = new byte[pairing.PendingKey == null ? KeySize : 2 * KeySize];
        pairing.DeviceKey.CopyTo(secret, 0);
        if (pairing.PendingKey != null) pairing.PendingKey.CopyTo(secret, KeySize);
        try { SessionStore.SaveTunnelKeys(pairing.Site, secret); }
        finally { Array.Clear(secret, 0, secret.Length); }
        var all = Read();
        all[pairing.Site] = pairing.Metadata();
        Write(all);
      }
    }

    public void Delete(TunnelPairing pairing) {
      lock (gate) {
        var all = Read();
        if (all.Remove(pairing.Site)) Write(all);
        SessionStore.ForgetTunnelKeys(pairing.Site);
      }
    }
  }
}
