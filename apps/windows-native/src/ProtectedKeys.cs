using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Security.Credentials;

namespace Josi.Native {
  /// JSON exactly as JavaScript's JSON.stringify writes it, for the messages
  /// the server verifies byte for byte.
  public static class Canon {
    public static string Array(params object[] items) { var sb = new StringBuilder(); Value(sb, items); return sb.ToString(); }
    static void Value(StringBuilder sb, object v) {
      if (v == null) { sb.Append("null"); return; }
      var text = v as string; if (text != null) { Str(sb, text); return; }
      if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
      if (v is long || v is int) { sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture)); return; }
      var wire = v as Wire; if (wire != null) { Value(sb, wire.Raw); return; }
      var list = v as IEnumerable;
      if (list != null) {
        sb.Append('['); var first = true;
        foreach (var item in list) { if (!first) sb.Append(','); first = false; Value(sb, item); }
        sb.Append(']'); return;
      }
      throw new JosiException("Unsupported value in a protected message.");
    }
    static void Str(StringBuilder sb, string s) {
      sb.Append('"');
      foreach (var c in s) {
        switch (c) {
          case '"': sb.Append("\\\""); break; case '\\': sb.Append("\\\\"); break;
          case '\b': sb.Append("\\b"); break; case '\f': sb.Append("\\f"); break; case '\n': sb.Append("\\n"); break;
          case '\r': sb.Append("\\r"); break; case '\t': sb.Append("\\t"); break;
          default: if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c); break;
        }
      }
      sb.Append('"');
    }
  }

  /// The messages of the protected-approval protocol, built the way the server
  /// builds them (packages/protocol): one byte off and the signature fails.
  public static class ProtectedWire {
    public static string Hex(byte[] bytes) { return Convert.ToHexString(bytes).ToLowerInvariant(); }
    public static string Digest(string message) { return Hex(SHA256.HashData(Encoding.UTF8.GetBytes(message))); }
    public static string Base64Url(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    static object[] Reference(Wire r) { return new object[] { r["recordId"].Text, r["version"].Integer, r["digest"].Text, r["epoch"].Integer }; }
    public static string EnrollmentMessage(string requestDigest) { return "josi-protected-device-enrollment.1\n" + Canon.Array("device.enroll", requestDigest); }
    public static string HostMessage(Wire c) {
      return "josi-protected-host-auth.1\n" + Canon.Array(1L, c["id"].Text, c["nonce"].Text, c["serverOrigin"].Text, c["serverId"].Text, c["userId"].Text, c["deviceId"].Text,
        Reference(c["keyReference"]), c["wrappingFingerprint"].Text, c["issuedAtMs"].Integer, c["expiresAtMs"].Integer);
    }
    public static string ControlMessage(Wire c) {
      var p = c["presentation"];
      return "josi-protected-control.1\n" + Canon.Array(1L, c["id"].Text, c["nonce"].Text, c["serverOrigin"].Text, c["serverId"].Text, c["userId"].Text, c["deviceId"].Text,
        c["purpose"].Text, c["requestDigest"].Text, Reference(c["keyReference"]), c["issuedAtMs"].Integer, c["expiresAtMs"].Integer,
        new object[] { p["wording"].Text, p["meaning"].Text, p["advisory"].List.Select(a => (object)a.Text).ToArray() });
    }
    public static bool SameIdentity(Wire a, Wire b) {
      return a["serverOrigin"].Text == b["serverOrigin"].Text && a["serverId"].Text == b["serverId"].Text && a["userId"].Text == b["userId"].Text && a["deviceId"].Text == b["deviceId"].Text;
    }
    public static void RequireIdentity(Wire identity, string origin, string userId) {
      if (identity["serverOrigin"].Text != origin || identity["userId"].Text != userId || !Wires.IsUuid(identity["serverId"].Text)
          || !Wires.IsUuid(identity["userId"].Text) || !Wires.IsUuid(identity["deviceId"].Text)) throw new JosiException("The protected request does not belong to this server and account.");
    }
    public static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    public static void RequireLive(Wire challenge) {
      var now = Now();
      if (challenge["issuedAtMs"].Integer > now + 60_000 || challenge["expiresAtMs"].Integer <= now) throw new JosiException("The protected review expired. Start it again.");
    }
  }

  /// This PC's protected-approval key: a P-256 key in Windows' key store for
  /// this account (the PC's TPM where it can do both jobs), which proves this
  /// PC to the server and unwraps the signing key the Vault keeps; and the
  /// Windows Hello key that the signing key is also wrapped to, so nothing is
  /// signed without a fingerprint, face or PIN.
  public sealed class DeviceKey : IDisposable {
    readonly CngKey key;
    DeviceKey(CngKey key) { this.key = key; }
    static string Name(string deviceId) { return "Josi.Protected." + deviceId; }
    static readonly CngProvider[] Providers = { new CngProvider("Microsoft Platform Crypto Provider"), CngProvider.MicrosoftSoftwareKeyStorageProvider };
    static readonly byte[] Label = Encoding.ASCII.GetBytes("josi-windows-protected-key.1");

    public static DeviceKey Create(string deviceId) {
      var name = Name(deviceId);
      foreach (var provider in Providers) {
        try {
          var parameters = new CngKeyCreationParameters { Provider = provider, KeyUsage = CngKeyUsages.AllUsages, ExportPolicy = CngExportPolicies.None };
          var created = new DeviceKey(CngKey.Create(CngAlgorithm.ECDiffieHellmanP256, name, parameters));
          // Both jobs must work on this provider: proving (ECDSA) and unwrapping (ECDH).
          created.HostSign(new byte[] { 1 });
          var probe = Wrap(created.PublicPoint(), new byte[32], null);
          var back = created.Unwrap(probe, null);
          if (back.Length != 32) throw new CryptographicException();
          return created;
        } catch (Exception) { try { CngKey.Open(name, provider).Delete(); } catch (Exception) { } }
      }
      throw new JosiException("This PC could not create a protected key in Windows' key store.");
    }
    public static DeviceKey Open(string deviceId) {
      foreach (var provider in Providers) { try { return new DeviceKey(CngKey.Open(Name(deviceId), provider)); } catch (Exception) { } }
      return null;
    }
    public static bool Exists(string deviceId) { using (var k = Open(deviceId)) return k != null; }
    public static void Delete(string deviceId) {
      foreach (var provider in Providers) { try { CngKey.Open(Name(deviceId), provider).Delete(); } catch (Exception) { } }
    }
    public bool Hardware { get { return key.Provider.Provider == Providers[0].Provider; } }
    /// Uncompressed P-256 point, 65 bytes: what the server stores as wrappingPublicKey.
    public byte[] PublicPoint() {
      using (var ecdh = new ECDiffieHellmanCng(key)) {
        var q = ecdh.ExportParameters(false).Q;
        var point = new byte[65]; point[0] = 4;
        Array.Copy(q.X, 0, point, 1 + 32 - q.X.Length, q.X.Length); Array.Copy(q.Y, 0, point, 33 + 32 - q.Y.Length, q.Y.Length);
        return point;
      }
    }
    /// ECDSA over SHA-256, DER encoded: the proof that this PC holds the enrolled key.
    public byte[] HostSign(byte[] message) {
      using (var dsa = new ECDsaCng(key)) return dsa.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
    }
    static ECDiffieHellmanPublicKey PublicKeyOf(byte[] point) {
      if (point == null || point.Length != 65 || point[0] != 4) throw new JosiException("The protected key material is invalid.");
      var parameters = new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = point.Skip(1).Take(32).ToArray(), Y = point.Skip(33).Take(32).ToArray() } };
      using (var other = ECDiffieHellman.Create(parameters)) return other.PublicKey;
    }
    /// Wraps the 32-byte signing seed to this PC: first to the Windows Hello
    /// key (when `hello` is given), then to the P-256 key with an ephemeral
    /// ECDH agreement. Layout: version, ephemeral point (65), nonce (12), AES-GCM text, tag (16).
    public static byte[] Wrap(byte[] point, byte[] seed, byte[] hello) {
      var inner = seed;
      if (hello != null) {
        var nonce = RandomNumberGenerator.GetBytes(12); var text = new byte[seed.Length]; var tag = new byte[16];
        using (var aes = new AesGcm(hello, 16)) aes.Encrypt(nonce, seed, text, tag, Label);
        inner = nonce.Concat(text).Concat(tag).ToArray();
      }
      using (var ephemeral = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256)) {
        var q = ephemeral.ExportParameters(false).Q;
        var ephemeralPoint = new byte[65]; ephemeralPoint[0] = 4;
        Array.Copy(q.X, 0, ephemeralPoint, 1 + 32 - q.X.Length, q.X.Length); Array.Copy(q.Y, 0, ephemeralPoint, 33 + 32 - q.Y.Length, q.Y.Length);
        var secret = ephemeral.DeriveKeyFromHash(PublicKeyOf(point), HashAlgorithmName.SHA256, Label, ephemeralPoint);
        var nonce = RandomNumberGenerator.GetBytes(12); var text = new byte[inner.Length]; var tag = new byte[16];
        using (var aes = new AesGcm(secret, 16)) aes.Encrypt(nonce, inner, text, tag, ephemeralPoint);
        Array.Clear(secret, 0, secret.Length);
        if (hello != null) Array.Clear(inner, 0, inner.Length);
        return new[] { hello != null ? (byte)2 : (byte)1 }.Concat(ephemeralPoint).Concat(nonce).Concat(text).Concat(tag).ToArray();
      }
    }
    public static bool NeedsHello(byte[] wrapped) { return wrapped != null && wrapped.Length > 0 && wrapped[0] == 2; }
    public byte[] Unwrap(byte[] wrapped, byte[] hello) {
      if (wrapped == null || wrapped.Length < 1 + 65 + 12 + 16 + 32 || (wrapped[0] != 1 && wrapped[0] != 2)) throw new JosiException("The wrapped signing key is not in this PC's format.");
      var ephemeralPoint = wrapped.Skip(1).Take(65).ToArray(); var nonce = wrapped.Skip(66).Take(12).ToArray();
      var body = wrapped.Skip(78).ToArray(); var text = body.Take(body.Length - 16).ToArray(); var tag = body.Skip(body.Length - 16).ToArray();
      byte[] secret;
      using (var ecdh = new ECDiffieHellmanCng(key)) secret = ecdh.DeriveKeyFromHash(PublicKeyOf(ephemeralPoint), HashAlgorithmName.SHA256, Label, ephemeralPoint);
      var inner = new byte[text.Length];
      try { using (var aes = new AesGcm(secret, 16)) aes.Decrypt(nonce, text, tag, inner, ephemeralPoint); }
      catch (CryptographicException) { throw new JosiException("This PC's key could not open the signing key. Enroll this PC again."); }
      finally { Array.Clear(secret, 0, secret.Length); }
      if (wrapped[0] == 1) return inner;
      if (hello == null || inner.Length < 12 + 16 + 1) throw new JosiException("Windows Hello is needed to open the signing key.");
      var helloNonce = inner.Take(12).ToArray(); var helloText = inner.Skip(12).Take(inner.Length - 28).ToArray(); var helloTag = inner.Skip(inner.Length - 16).ToArray();
      var seed = new byte[helloText.Length];
      try { using (var aes = new AesGcm(hello, 16)) aes.Decrypt(helloNonce, helloText, helloTag, seed, Label); }
      catch (CryptographicException) { throw new JosiException("Windows Hello did not open the signing key. Enroll this PC again."); }
      finally { Array.Clear(inner, 0, inner.Length); }
      return seed;
    }
    public void Dispose() { key.Dispose(); }
  }

  /// Windows Hello for this enrollment: a Hello-protected key whose signature
  /// of a fixed sentence is the second wrapping secret. Every use asks for the
  /// person's fingerprint, face or PIN.
  public static class Hello {
    static string Name(string deviceId) { return "Josi protected approvals " + deviceId; }
    public static async Task<bool> Available() { try { return await KeyCredentialManager.IsSupportedAsync(); } catch (Exception) { return false; } }
    static string Reason(KeyCredentialStatus status) {
      switch (status) {
        case KeyCredentialStatus.UserCanceled: return "Windows Hello was cancelled.";
        case KeyCredentialStatus.NotFound: return "This PC's Windows Hello key for Josi is missing. Enroll this PC again.";
        case KeyCredentialStatus.UserPrefersPassword: return "Windows Hello is not set up for this account. Set up a PIN, face or fingerprint in Windows Settings first.";
        case KeyCredentialStatus.SecurityDeviceLocked: return "Windows Hello is locked right now. Try again in a moment.";
        default: return "Windows Hello is unavailable (" + status + ").";
      }
    }
    static async Task<byte[]> Secret(KeyCredential credential, string deviceId) {
      var data = Encoding.UTF8.GetBytes("josi-windows-hello-wrap.1\n" + deviceId).AsBuffer();
      var signed = await credential.RequestSignAsync(data);
      if (signed.Status != KeyCredentialStatus.Success) throw new JosiException(Reason(signed.Status));
      var signature = signed.Result.ToArray();
      try { return SHA256.HashData(signature); } finally { Array.Clear(signature, 0, signature.Length); }
    }
    /// Makes the Hello key and returns its wrapping secret, or null when this
    /// PC's Hello signatures are not repeatable (then Hello still gates each use).
    public static async Task<byte[]> Create(string deviceId) {
      var made = await KeyCredentialManager.RequestCreateAsync(Name(deviceId), KeyCredentialCreationOption.ReplaceExisting);
      if (made.Status != KeyCredentialStatus.Success) throw new JosiException(Reason(made.Status));
      var first = await Secret(made.Credential, deviceId);
      var second = await Secret(made.Credential, deviceId);
      if (first.SequenceEqual(second)) return first;
      Array.Clear(first, 0, first.Length); Array.Clear(second, 0, second.Length);
      return null;
    }
    /// Asks Windows Hello now and returns the wrapping secret.
    public static async Task<byte[]> Unlock(string deviceId) {
      var opened = await KeyCredentialManager.OpenAsync(Name(deviceId));
      if (opened.Status != KeyCredentialStatus.Success) throw new JosiException(Reason(opened.Status));
      return await Secret(opened.Credential, deviceId);
    }
    public static async Task Delete(string deviceId) { try { await KeyCredentialManager.DeleteAsync(Name(deviceId)); } catch (Exception) { } }
  }
}
