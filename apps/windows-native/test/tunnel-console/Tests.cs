using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  sealed class MemoryStore : ITunnelStore {
    public TunnelPairing Saved; public int Saves; public bool Deleted;
    public void Save(TunnelPairing p) { Saved = p; Saves++; }
    public void Delete(TunnelPairing p) { Deleted = true; }
  }
  /// Answers the handshake with whatever it's told to.
  sealed class Scripted : ITunnelTransport {
    public Func<byte[], byte[]> Reply;
    public byte[] Next; public bool Closed;
    public Task SendAsync(byte[] data) { Next = Reply(data); return Task.CompletedTask; }
    public Task<byte[]> ReceiveAsync(CancellationToken cancel) { return Task.FromResult(Next); }
    public void Close() { Closed = true; }
  }

  public static class Tests {
    static int passed, failed;
    static void Check(string name, bool ok, string detail = "") {
      if (ok) passed++; else { failed++; Console.WriteLine("FAIL " + name + " " + detail); }
    }
    static byte[] H(string hex) { return Convert.FromHexString(hex); }
    static string X(byte[] b) { return Convert.ToHexString(b).ToLowerInvariant(); }
    static string X(ReadOnlySpan<byte> b) { return Convert.ToHexString(b).ToLowerInvariant(); }
    static void Throws<T>(string name, Action action, Func<T, bool> also = null) where T : Exception {
      try { action(); Check(name, false, "did not throw"); }
      catch (T e) { Check(name, also == null || also(e), e.Message); }
      catch (Exception e) { Check(name, false, "threw " + e.GetType().Name + ": " + e.Message); }
    }
    static async Task ThrowsAsync<T>(string name, Func<Task> action, Func<T, bool> also = null) where T : Exception {
      try { await action(); Check(name, false, "did not throw"); }
      catch (T e) { Check(name, also == null || also(e), e.GetType().Name + " " + e.Message); }
      catch (Exception e) { Check(name, false, "threw " + e.GetType().Name + ": " + e.Message); }
    }
    static JsonElement Load(string path) { return JsonDocument.Parse(File.ReadAllText(path)).RootElement; }

    static void Rfc7748(bool million) {
      Check("7748 vector 1", X(X25519.ScalarMult(H("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), H("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"))) == "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552");
      Check("7748 vector 2", X(X25519.ScalarMult(H("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d"), H("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493"))) == "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957");
      var k = new byte[32]; k[0] = 9; var u = (byte[])k.Clone();
      var clock = Stopwatch.StartNew();
      for (var i = 1; i <= (million ? 1000000 : 1000); i++) {
        var next = X25519.ScalarMult(k, u); u = k; k = next;
        if (i == 1) Check("7748 iter 1", X(k) == "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079");
        if (i == 1000) { Check("7748 iter 1000", X(k) == "684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51"); Console.WriteLine("  x25519 " + clock.ElapsedMilliseconds / 1000.0 + " ms each"); }
        if (i == 1000000) Check("7748 iter 1000000", X(k) == "7c3911e0ab2586fd864497297e575e6f3bc601c0883c30df5f4dd2d24f665424");
      }
      var a = H("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"); var b = H("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
      Check("7748 alice public", X(X25519.PublicKey(a)) == "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
      Check("7748 bob public", X(X25519.PublicKey(b)) == "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
      Check("7748 shared", X(X25519.SharedSecret(a, X25519.PublicKey(b))) == "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
      Check("7748 shared other way", X(X25519.SharedSecret(b, X25519.PublicKey(a))) == "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
      string[] low = {
        "0000000000000000000000000000000000000000000000000000000000000000", "0100000000000000000000000000000000000000000000000000000000000000",
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        // The same with bit 255 set, which RFC 7748 says to ignore.
        "0000000000000000000000000000000000000000000000000000000000000080", "0100000000000000000000000000000000000000000000000000000000000080",
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880", "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f11d7",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" };
      foreach (var point in low) {
        var mine = X25519.NewPrivateKey();
        Throws<CryptographicException>("low order refused " + point.Substring(0, 8), () => X25519.SharedSecret(mine, H(point)));
        Check("low order not usable " + point.Substring(0, 8), !X25519.IsUsablePublicKey(H(point)));
      }
      Check("real key usable", X25519.IsUsablePublicKey(X25519.PublicKey(X25519.NewPrivateKey())));
      Check("short key not usable", !X25519.IsUsablePublicKey(new byte[31]));
    }

    static void Aead() {
      var key = H("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f"); var nonce = H("070000004041424344454647"); var ad = H("50515253c0c1c2c3c4c5c6c7");
      var plain = Encoding.ASCII.GetBytes("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
      var expected = "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b61161ae10b594f09e26a7e902ecbd0600691";
      Check("8439 seal", X(TunnelAead.Seal(key, nonce, ad, plain)) == expected);
      Check("8439 open", TunnelAead.Open(key, nonce, ad, H(expected)).SequenceEqual(plain));
      var bad = H(expected); bad[3] ^= 1;
      Throws<CryptographicException>("aead refuses changed text", () => TunnelAead.Open(key, nonce, ad, bad));
      bad = H(expected); bad[bad.Length - 1] ^= 1;
      Throws<CryptographicException>("aead refuses changed tag", () => TunnelAead.Open(key, nonce, ad, bad));
      Throws<CryptographicException>("aead refuses changed ad", () => TunnelAead.Open(key, nonce, new byte[12], H(expected)));
      Throws<CryptographicException>("aead refuses short text", () => TunnelAead.Open(key, nonce, ad, new byte[15]));
    }

    static void Generated(JsonElement v) {
      foreach (var c in v.GetProperty("x25519").EnumerateArray())
        Check("x25519 vs noble", X(X25519.ScalarMult(H(c.GetProperty("k").GetString()), H(c.GetProperty("u").GetString()))) == c.GetProperty("out").GetString());
      foreach (var c in v.GetProperty("poly").EnumerateArray()) {
        var poly = new ManagedAead.Poly1305(H(c.GetProperty("key").GetString()));
        poly.Absorb(H(c.GetProperty("data").GetString()));
        var tag = new byte[16]; poly.Finish(tag);
        Check("poly1305 vs noble", X(tag) == c.GetProperty("tag").GetString());
      }
      foreach (var c in v.GetProperty("aead").EnumerateArray()) {
        var key = H(c.GetProperty("key").GetString()); var nonce = H(c.GetProperty("nonce").GetString()); var ad = H(c.GetProperty("ad").GetString()); var plain = H(c.GetProperty("plain").GetString());
        Check("aead seal vs noble", X(TunnelAead.Seal(key, nonce, ad, plain)) == c.GetProperty("out").GetString());
        Check("aead open vs noble", X(TunnelAead.Open(key, nonce, ad, H(c.GetProperty("out").GetString()))) == X(plain));
      }
      foreach (var c in v.GetProperty("normalize").EnumerateArray()) {
        var input = c.GetProperty("input").GetString();
        if (input.Contains('ß')) continue;   // JS uppercases it to SS; neither makes a code
        Check("normalize like TS: " + input, PairingCode.Normalize(input) == c.GetProperty("output").GetString(), PairingCode.Normalize(input));
      }
      foreach (var c in v.GetProperty("pairing").EnumerateArray()) {
        var code = c.GetProperty("code").GetString();
        Check("display normalizes", PairingCode.Normalize(c.GetProperty("display").GetString()) == code);
        Check("messy normalizes", PairingCode.Normalize(c.GetProperty("messy").GetString()) == code, c.GetProperty("messy").GetString());
        Check("valid code", PairingCode.IsValid(code));
        Check("invite id", PairingCode.InviteId(code) == c.GetProperty("id").GetString());
        var box = c.GetProperty("box");
        var opened = TunnelInvite.OpenBox(code, c.GetProperty("sealed").GetString());
        Check("box opens", opened.Site == box.GetProperty("site").GetString() && Base64Url.Encode(opened.Server) == box.GetProperty("server").GetString() && opened.Relay == "wss://relay.heyjosi.test" && opened.Code == code);
        var link = TunnelInvite.ParseLink(c.GetProperty("link").GetString());
        Check("link parses", link != null && link.Code == code && link.Site == opened.Site && X(link.Server) == X(opened.Server) && link.Lan.Count == opened.Lan.Count && link.Name == opened.Name);
        Throws<TunnelException>("wrong code refused", () => TunnelInvite.OpenBox("0123456789ABCDEFGHJKMNPQRSTVWXYZ", c.GetProperty("sealed").GetString()), e => e.Code == "bad_code");
        var raw = Base64Url.Decode(c.GetProperty("sealed").GetString()); raw[raw.Length - 1] ^= 1;
        Throws<TunnelException>("changed box refused", () => TunnelInvite.OpenBox(code, Base64Url.Encode(raw)), e => e.Code == "bad_code");
      }
      Func<string, string, string> origin = (relay, name) => TunnelPairing.OriginFor(new TunnelInvite { Relay = relay, Name = name, Site = new string('a', 32) });
      Check("origin strips relay.", origin("wss://relay.heyjosi.com", "alice") == "https://alice.heyjosi.com");
      Check("origin keeps other hosts whole", origin("wss://tunnel.example.org", "alice") == "https://alice.tunnel.example.org", origin("wss://tunnel.example.org", "alice"));
      Check("origin keeps a deep host whole", origin("wss://a.b.example.org", "alice") == "https://alice.a.b.example.org");
      Check("origin strips only a leading relay.", origin("wss://myrelay.example.org", "alice") == "https://alice.myrelay.example.org");
      Check("origin keeps a two-label host", origin("wss://example.org", "alice") == "https://alice.example.org");
      Check("origin without a name uses the site", origin("wss://relay.heyjosi.com", null) == "https://" + new string('a', 32) + ".heyjosi.com");
      Check("short code invalid", !PairingCode.IsValid("K7QM4XHT"));
      Check("U is not in the alphabet", !PairingCode.IsValid(new string('U', 32)));
      Check("short link", TunnelInvite.ParseLink("https://alice.heyjosi.test/#josi-pair=SHORT.e30") == null);
      Check("trailing newline trimmed", TunnelInvite.ParseLink(v.GetProperty("pairing")[0].GetProperty("link").GetString() + "\n") != null);
      Check("turkish casing", PairingCode.Normalize("i") == "1");
      var culture = System.Globalization.CultureInfo.CurrentCulture;
      try { System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo("tr-TR"); Check("turkish culture normalize", PairingCode.Normalize("ai") == "A1", PairingCode.Normalize("ai")); }
      finally { System.Globalization.CultureInfo.CurrentCulture = culture; }
      var evil = "https://x/#josi-pair=" + new string('0', 32) + "." + Base64Url.Encode(Encoding.UTF8.GetBytes("{\"v\":1,\"server\":\"" + Base64Url.Encode(new byte[32]) + "\",\"site\":\"" + new string('0', 32) + "\",\"relay\":\"wss://r.example\"}"));
      Check("link with a low-order server key refused", TunnelInvite.ParseLink(evil) == null);
      var plainRelay = "https://x/#josi-pair=" + new string('0', 32) + "." + Base64Url.Encode(Encoding.UTF8.GetBytes("{\"v\":1,\"server\":\"" + Base64Url.Encode(X25519.PublicKey(X25519.NewPrivateKey())) + "\",\"site\":\"" + new string('0', 32) + "\",\"relay\":\"ws://r.example\"}"));
      Check("link with an unencrypted remote relay refused", TunnelInvite.ParseLink(plainRelay) == null);
    }

    static void NoiseVector(JsonElement v) {
      var m = v.GetProperty("messages");
      Func<int, string, string> at = (i, k) => m[i].GetProperty(k).GetString();
      var ini = new NoiseHandshake(H(v.GetProperty("init_static").GetString()), H(v.GetProperty("init_remote_static").GetString()), H(v.GetProperty("init_prologue").GetString()));
      Check("noise message 1", X(ini.WriteFirst(H(at(0, "payload")), H(v.GetProperty("init_ephemeral").GetString()))) == at(0, "ciphertext"));
      Check("noise message 2", X(ini.ReadSecond(H(at(1, "ciphertext")))) == at(1, "payload"));
      Check("noise handshake hash", X(ini.Hash) == v.GetProperty("handshake_hash").GetString());
      var s = new NoiseSession(ini.Send, ini.Receive, false);
      Check("noise transport 3", X(s.Seal(H(at(2, "payload")))) == at(2, "ciphertext"));
      Check("noise transport 4", X(s.Open(H(at(3, "ciphertext")))) == at(3, "payload"));
      Check("noise transport 5", X(s.Seal(H(at(4, "payload")))) == at(4, "ciphertext"));
      Check("noise transport 6", X(s.Open(H(at(5, "ciphertext")))) == at(5, "payload"));
      // Tampering the second message, and a low-order ephemeral in it.
      foreach (var spot in new[] { 40, 32, 60 }) {
        var again = new NoiseHandshake(H(v.GetProperty("init_static").GetString()), H(v.GetProperty("init_remote_static").GetString()), H(v.GetProperty("init_prologue").GetString()));
        again.WriteFirst(H(at(0, "payload")), H(v.GetProperty("init_ephemeral").GetString()));
        var bad = H(at(1, "ciphertext")); bad[spot] ^= 1;
        Throws<CryptographicException>("noise refuses changed message 2", () => again.ReadSecond(bad));
      }
      var lowOrder = new NoiseHandshake(H(v.GetProperty("init_static").GetString()), H(v.GetProperty("init_remote_static").GetString()), H(v.GetProperty("init_prologue").GetString()));
      lowOrder.WriteFirst(new byte[0]);
      Throws<CryptographicException>("noise refuses low-order ephemeral", () => lowOrder.ReadSecond(new byte[48]));
      Throws<TunnelException>("noise refuses low-order pin", () => new NoiseHandshake(X25519.NewPrivateKey(), new byte[31]));
      var zeroPin = new NoiseHandshake(X25519.NewPrivateKey(), new byte[32]);
      Throws<CryptographicException>("noise refuses all-zero server key", () => zeroPin.WriteFirst(new byte[0]));
    }

    static void Framing(JsonElement v) {
      var key = H(v.GetProperty("key").GetString());
      var s = new NoiseSession(new NoiseCipher((byte[])key.Clone()), new NoiseCipher(new byte[32])) { RekeyMessages = v.GetProperty("rekey_messages").GetInt32() };
      var r = new NoiseSession(new NoiseCipher(new byte[32]), new NoiseCipher((byte[])key.Clone()));
      var messages = v.GetProperty("messages"); var texts = v.GetProperty("ciphertexts");
      for (var i = 0; i < messages.GetArrayLength(); i++) {
        var plain = Encoding.UTF8.GetBytes(messages[i].GetString());
        var ct = s.Seal(plain);
        Check("framing " + i, X(ct) == texts[i].GetString(), X(ct).Substring(0, 16));
        Check("framing open " + i, r.Open(H(texts[i].GetString())).SequenceEqual(plain));
      }
      var k = new byte[32]; Array.Fill(k, (byte)7);
      Func<NoiseSession> make = () => new NoiseSession(new NoiseCipher((byte[])k.Clone()), new NoiseCipher((byte[])k.Clone()));
      var a = make(); var b = make();
      Check("pads to the block", a.Seal(new byte[1]).Length == a.Seal(new byte[200]).Length && a.Seal(new byte[253]).Length == 272 && a.Seal(new byte[254]).Length == 528);
      Check("largest frame", a.Seal(new byte[NoiseSession.MaxFramed]).Length == 65535);
      Throws<ArgumentException>("too large refused", () => a.Seal(new byte[NoiseSession.MaxFramed + 1]));
      var x = make(); var y = make();
      Check("largest frame round trip", y.Open(x.Seal(new byte[NoiseSession.MaxFramed])).Count == NoiseSession.MaxFramed);
      var ct2 = x.Seal(Encoding.ASCII.GetBytes("secret")); ct2[0] ^= 1;
      Throws<CryptographicException>("session refuses tampering", () => y.Open(ct2));
      var c = make(); var d = make();
      var first = c.Seal(new byte[3]); d.Open(first);
      Throws<CryptographicException>("session refuses a replay", () => d.Open(first));
      var e = make(); var f = make();
      var one = e.Seal(new byte[1]); var two = e.Seal(new byte[1]);
      Throws<CryptographicException>("session refuses reordering", () => f.Open(two));
      // A bad frame inside an authentic message.
      var inner = new NoiseCipher((byte[])k.Clone()); var body = new byte[256]; body[0] = 2;
      var g = make();
      Throws<CryptographicException>("session refuses unknown flags", () => g.Open(inner.Encrypt(Array.Empty<byte>(), body)));
      var inner2 = new NoiseCipher((byte[])k.Clone()); var body2 = new byte[256]; body2[1] = 1; body2[2] = 0xff;
      var g2 = make();
      Throws<CryptographicException>("session refuses a length past the end", () => g2.Open(inner2.Encrypt(Array.Empty<byte>(), body2)));
      // Rekey keeps counting, and both ends stay in step over many.
      var p = make(); p.RekeyMessages = 3; var q = make();
      var ok = true;
      for (var i = 0; i < 1000; i++) ok &= q.Open(p.Seal(BitConverter.GetBytes(i))).SequenceEqual(BitConverter.GetBytes(i));
      Check("rekey in step", ok);
      var t = make(); t.RekeySeconds = 0; var w = make();
      Check("time rekey in step", w.Open(t.Seal(new byte[2])).Count == 2 && w.Open(t.Seal(new byte[2])).Count == 2);
      var frame = TunnelMux.Encode(TunnelFrame.ResBody, 0x01020304, new byte[] { 9 });
      Check("mux head is big-endian", X(frame) == "050102030409");
      TunnelFrame type; uint stream; ArraySegment<byte> payload;
      TunnelMux.Decode(new ArraySegment<byte>(frame), out type, out stream, out payload);
      Check("mux decode", type == TunnelFrame.ResBody && stream == 0x01020304 && payload.Count == 1 && payload[0] == 9);
      Throws<CryptographicException>("mux short", () => { TunnelFrame a1; uint b1; ArraySegment<byte> c1; TunnelMux.Decode(new ArraySegment<byte>(new byte[4]), out a1, out b1, out c1); });
    }

    // ---------------------------------------------------------- against the TS host
    static HttpClient control = new HttpClient();
    static int controlPort;
    static async Task<JsonElement> Ctl(string path, object body = null) {
      var response = await control.PostAsync("http://127.0.0.1:" + controlPort + path, new StringContent(JsonSerializer.Serialize(body ?? new { })));
      return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
    }
    static async Task Until(string name, Func<Task<bool>> ready, int ms = 5000) {
      var clock = Stopwatch.StartNew();
      while (clock.ElapsedMilliseconds < ms) { if (await ready()) { Check(name, true); return; } await Task.Delay(20); }
      Check(name, false, "timed out");
    }
    static async Task<TunnelConnection> PairNew(MemoryStore store, object lan = null) {
      var mint = await Ctl("/mint", new { lan = lan ?? new string[0] });
      var connection = await TunnelConnection.Pair(TunnelInvite.ParseLink(mint.GetProperty("link").GetString()), "Test PC", store);
      connection.LanRetry = TimeSpan.FromHours(1);
      return connection;
    }
    static HttpClient Raw(TunnelHandler handler, string bearer = "tok") {
      var client = new HttpClient(handler, false) { BaseAddress = new Uri("https://alice.heyjosi.test") };
      client.DefaultRequestHeaders.TryAddWithoutValidation("x-josi-client", "native");
      client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
      return client;
    }
    static string Sha(byte[] data) { return X(SHA256.HashData(data)); }

    static async Task Interop(string harness) {
      var start = new ProcessStartInfo("node", "\"" + harness + "\"") { RedirectStandardOutput = true, UseShellExecute = false };
      using (var node = Process.Start(start)) {
        try {
          var config = JsonDocument.Parse(await node.StandardOutput.ReadLineAsync()).RootElement;
          controlPort = config.GetProperty("control").GetInt32();
          await Scenarios(config);
        } finally { try { node.Kill(); } catch (Exception) { } }
      }
    }

    static async Task Scenarios(JsonElement config) {
      await Ctl("/lanlist", new { list = new string[0] });
      // Pairing by link over the relay. The relay carries sealed bytes only.
      var store = new MemoryStore();
      var mint = await Ctl("/mint");
      var code = mint.GetProperty("code").GetString();
      var invite = await TunnelInvite.Resolve(mint.GetProperty("link").GetString());
      var connection = await TunnelConnection.Pair(invite, "Test PC", store);
      connection.LanRetry = TimeSpan.FromHours(1);
      Check("paired by link", Wires.IsUuid(store.Saved.Device) && store.Saved.Label == "Alice server" && connection.Route == "Through the relay", connection.Route);
      Check("origin from name", store.Saved.Origin.StartsWith("https://alice."), store.Saved.Origin);
      Check("relay never saw the code", !(await Ctl("/seen", new { text = code })).GetProperty("contains").GetBoolean());
      await ThrowsAsync<TunnelException>("a used code is refused", async () => await TunnelConnection.Pair(invite, "Again", new MemoryStore()), e => e.Code == "bad_code" && e.Refused);

      // A typed code, looked up by its hash.
      var mint2 = await Ctl("/mint");
      var typed = mint2.GetProperty("display").GetString().ToLowerInvariant().Replace('0', 'o').Replace('1', 'l');
      var store2 = new MemoryStore();
      var connection2 = await TunnelConnection.Pair(await TunnelInvite.Resolve(typed, mint2.GetProperty("relay").GetString()), "Typed PC", store2);
      Check("paired by typed code", Wires.IsUuid(store2.Saved.Device));
      await ThrowsAsync<TunnelException>("an unknown code is refused", () => TunnelInvite.Resolve("00000000000000000000000000000000", mint2.GetProperty("relay").GetString()), e => e.Code == "bad_code");
      await ThrowsAsync<TunnelException>("junk is refused", () => TunnelInvite.Resolve("hello"), e => e.Code == "bad_code");
      connection2.Dispose();

      // JosiApi with no bearer session: no cookie ever comes back.
      using (var api = new JosiApi(store.Saved.Origin, new TunnelHandler(connection))) {
        await api.PrimeCsrf();
        var echo = await api.Request("/echo", "POST", Wires.O("a", 1));
        Check("csrf post passes", echo["method"].Text == "POST" && echo["headers"]["cookie"].Text.Contains("josi_csrf=") && echo["headers"]["x-josi-csrf"].Text.Length > 0, echo.Json);
        Check("path has the /api prefix", echo["path"].Text == "/api/echo");
        Check("host is the public one", echo["headers"]["host"].Text == "alice.heyjosi.test");
        Check("content length sent", echo["headers"]["content-length"].Text == "7", echo["headers"]["content-length"].Text);
        Check("app headers pass", echo["headers"]["user-agent"].Text == JosiApi.UserAgent && echo["headers"]["x-josi-pc"].Text == JosiApi.DeviceId);
        await Ctl("/set", new { api = new { omitCsrfBody = true } });
        await api.PrimeCsrf();
        Check("no token in the body is fine", (await api.Request("/echo", "POST", Wires.O("a", 2)))["method"].Text == "POST");
        await Ctl("/forget-jar", new { device = store.Saved.Device });
        Check("an emptied jar refills", (await api.Request("/echo", "PATCH", Wires.O("a", 3)))["method"].Text == "PATCH");
        await Ctl("/set", new { api = new { omitCsrfBody = false } });

        // Sign-in, then a bearer session.
        api.UseNative();
        var login = await api.Request("/auth/login", "POST", Wires.O("identifier", "a", "password", "not-a-real-password"));
        api.UseSession(login["sessionToken"].Text);
        Check("bearer works", (await api.Request("/auth/me"))["user"]["id"].Text == "u1");
        var withBearer = await api.Request("/echo", "POST", Wires.O("b", 1));
        Check("bearer post has no jar", withBearer["headers"]["authorization"].Text.StartsWith("Bearer ") && withBearer["headers"]["cookie"].Text.Length == 0, withBearer.Json);

        // A streaming response, cancelled the way the app cancels it.
        var signals = 0;
        var before = (await Ctl("/state")).GetProperty("api").GetProperty("sseClosed").GetInt32();
        var follow = api.FollowWorkProgress(evt => { Interlocked.Increment(ref signals); });
        await Until("stream arrives live", () => Task.FromResult(signals >= 3));
        api.CancelWorkProgress();
        try { await follow; } catch (OperationCanceledException) { }
        Check("stream call finished", follow.IsCompleted);
        await Until("cancel reaches the server", async () => (await Ctl("/state")).GetProperty("api").GetProperty("sseClosed").GetInt32() > before);

        // A big download through DownloadFile, with fast rekeys both ways.
        await Ctl("/rekey-fast", new { n = 7 });
        (await connection.Connected()).Session.RekeyMessages = 5;
        var file = Path.GetTempFileName();
        var expected = new byte[40 * 1000 * 1000];
        for (var i = 0; i < expected.Length; i++) expected[i] = (byte)(((i % 65536) * 31 + 7) & 255);
        var clock = Stopwatch.StartNew();
        await api.DownloadFile("/big?n=" + expected.Length, file, long.MaxValue);
        Console.WriteLine("  40 MB through relay + Noise in " + clock.ElapsedMilliseconds + " ms");
        Check("download intact", Sha(File.ReadAllBytes(file)) == Sha(expected));
        File.Delete(file);

        // Uploads.
        var folder = Path.GetTempPath();
        var upload = Path.Combine(folder, "tunnel-upload-" + Guid.NewGuid().ToString("N") + ".bin");
        var data = RandomNumberGenerator.GetBytes(5 * 1000 * 1000);
        File.WriteAllBytes(upload, data);
        var multipart = await api.UploadFiles("/echo", "file", new List<string> { upload }, long.MaxValue);
        Check("multipart upload", multipart["size"].Integer > data.Length && multipart["headers"]["content-type"].Text.StartsWith("multipart/form-data"), multipart["size"].Text);
        var archive = await api.UploadArchive("/echo", upload, new Dictionary<string, string> { { "password", "not-a-real-password" } }, null, () => false);
        Check("streamed upload", archive["size"].Integer > data.Length);
        File.Delete(upload);

        using (var raw = Raw(new TunnelHandler(connection))) {
          var body = RandomNumberGenerator.GetBytes(3 * 1000 * 1000 + 17);
          var echoed = Wires.Parse(await (await raw.PostAsync("/api/echo", new ByteArrayContent(body))).Content.ReadAsStringAsync());
          Check("exact body", echoed["sha256"].Text == Sha(body) && echoed["size"].Integer == body.Length && echoed["headers"]["content-length"].Text == body.Length.ToString(), echoed["size"].Text);
          var stream = new StreamContent(new NoLength(body));
          var chunked = Wires.Parse(await (await raw.PostAsync("/api/echo", stream)).Content.ReadAsStringAsync());
          Check("body of unknown length", chunked["sha256"].Text == Sha(body));
          var empty = Wires.Parse(await (await raw.PostAsync("/api/echo", new ByteArrayContent(new byte[0]))).Content.ReadAsStringAsync());
          Check("empty body", empty["size"].Integer == 0 && empty["method"].Text == "POST");

          // Many at once: one nonce order, whichever thread gets there first.
          var running = Enumerable.Range(0, 60).Select(async i => {
            var piece = RandomNumberGenerator.GetBytes(1000 + i * 3000);
            var answer = Wires.Parse(await (await raw.PostAsync("/api/echo?i=" + i, new ByteArrayContent(piece))).Content.ReadAsStringAsync());
            return answer["sha256"].Text == Sha(piece) && answer["path"].Text == "/api/echo?i=" + i;
          }).ToList();
          Check("sixty at once", (await Task.WhenAll(running)).All(ok => ok));

          // Cancelling while waiting for the head, and a response dropped early.
          var hung = (await Ctl("/state")).GetProperty("api").GetProperty("hangClosed").GetInt32();
          using (var soon = new CancellationTokenSource(150))
            await ThrowsAsync<OperationCanceledException>("cancel waiting for an answer", () => raw.GetAsync("/api/hang", soon.Token));
          await Until("that cancel reaches the server", async () => (await Ctl("/state")).GetProperty("api").GetProperty("hangClosed").GetInt32() > hung);
          using (var big = await raw.GetAsync("/api/big?n=2000000000", HttpCompletionOption.ResponseHeadersRead)) {
            Check("length header", big.Content.Headers.ContentLength == 2000000000L);
            var s = await big.Content.ReadAsStreamAsync();
            var buffer = new byte[1000];
            Check("reads some", await s.ReadAsync(buffer, 0, buffer.Length) > 0);
          }
          Check("tunnel fine after dropping a response", (await raw.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);

          // A reader that goes away without saying so can't stop everything else.
          var limit = TunnelBody.StallLimit; TunnelBody.StallLimit = TimeSpan.FromMilliseconds(300);
          var stalled = await raw.GetAsync("/api/big?n=200000000", HttpCompletionOption.ResponseHeadersRead);
          await Task.Delay(1000); // Long enough to fill the body buffer on a slower PC, then go past the limit.
          Check("others go on past a stalled reader", (await raw.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);
          await ThrowsAsync<IOException>("stalled reader is told", async () => { var s = await stalled.Content.ReadAsStreamAsync(); var b = new byte[1 << 20]; while (await s.ReadAsync(b, 0, b.Length) > 0) { } });
          stalled.Dispose();
          TunnelBody.StallLimit = limit;

          var moved = await raw.GetAsync("/api/redirect");
          Check("redirect not followed", (int)moved.StatusCode == 302 && moved.Headers.Location.AbsoluteUri == "https://accounts.example.test/o?x=1");
          await ThrowsAsync<HttpRequestException>("server reset surfaces", () => raw.GetAsync("/api/reset"));
          Check("tunnel fine after a reset", (await raw.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);
        }

        // A changed byte ends the session; the next request starts a fresh one.
        await Ctl("/set", new { relay = new { tamperNext = true } });
        await ThrowsAsync<JosiException>("tampering stops the request", () => api.Request("/auth/me"), e => e.Message.Contains("interfered"));
        Check("session ended", connection.Route == "Not connected", connection.Route);
        Check("fresh session after tampering", (await api.Request("/auth/me"))["user"]["id"].Text == "u1");

        // Status lines are hints only.
        await Ctl("/set", new { relay = new { hostile = true } });
        await Ctl("/kick");
        await Until("connection noticed gone", () => Task.FromResult(connection.Route == "Not connected"));
        Check("junk text changes nothing", (await api.Request("/auth/me"))["user"]["id"].Text == "u1" && !store.Deleted);
        await Ctl("/set", new { relay = new { hostile = false } });

        await Ctl("/say-offline");
        await Until("server-offline ends the connection", () => Task.FromResult(connection.Route == "Not connected"));
        await Ctl("/set", new { relay = new { online = false } });
        await ThrowsAsync<JosiException>("offline is said plainly", () => api.Request("/auth/me"), e => e.Message.Contains("not connected right now"));
        Check("offline hint didn't touch the pairing", !store.Deleted && store.Saved != null);
        await Ctl("/set", new { relay = new { online = true, delayOnline = 300 } });
        Check("waits for server-online", (await api.Request("/auth/me"))["user"]["id"].Text == "u1");
        await Ctl("/set", new { relay = new { delayOnline = 0 } });
      }
      // JosiApi's Dispose ended that connection.
      await ThrowsAsync<TunnelException>("disposed connection refuses", () => connection.Connected());

      // A dead path is noticed by the pings.
      var pingStore = new MemoryStore();
      var quiet = await PairNew(pingStore);
      (await quiet.Connected()).PingEvery = TimeSpan.FromMilliseconds(100);
      quiet.Dispose();
      var fresh = new TunnelConnection(pingStore.Saved, pingStore) { PingEvery = TimeSpan.FromMilliseconds(200) };
      await fresh.Connected();
      await Ctl("/set", new { relay = new { blackhole = true } });
      await Until("silent path is dropped", () => Task.FromResult(fresh.Route == "Not connected"), 3000);
      await Ctl("/set", new { relay = new { blackhole = false } });
      fresh.Dispose();

      // The LAN first; a dead address is passed over in about 800 ms.
      var lanUrl = (await Ctl("/lanurl")).GetProperty("url").GetString();
      var dead = "ws://10.255.255.1:9/__josi/noise";
      var lanStore = new MemoryStore();
      await Ctl("/lanlist", new { list = new[] { dead, lanUrl } });
      var viaLan = await PairNew(lanStore, new[] { dead, lanUrl });
      Check("pairs on the LAN", viaLan.Route == "Direct, on your network", viaLan.Route);
      viaLan.Dispose();
      var clock2 = Stopwatch.StartNew();
      var near = new TunnelConnection(lanStore.Saved, lanStore);
      near.LanRetry = TimeSpan.FromHours(1);
      await near.Connected();
      Check("reaches the LAN", near.Route == "Direct, on your network" && clock2.ElapsedMilliseconds < 1600, near.Route + " " + clock2.ElapsedMilliseconds);
      Check("keeps the welcome's addresses", lanStore.Saved.Lan.SequenceEqual(new[] { dead, lanUrl }));
      near.Dispose();

      // LAN gone: the relay. LAN back: new requests move, running ones finish.
      await Ctl("/lan-down");
      var moving = new TunnelConnection(lanStore.Saved, lanStore) { LanRetry = TimeSpan.FromMilliseconds(200) };
      using (var handler = new TunnelHandler(moving))
      using (var http = Raw(handler)) {
        Check("falls back to the relay", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK && moving.Route == "Through the relay", moving.Route);
        var first = await moving.Connected();
        var longRun = await http.GetAsync("/api/assistant/work-goals/stream", HttpCompletionOption.ResponseHeadersRead);
        await Ctl("/lan-up");
        await Until("moves to the LAN when it answers", () => Task.FromResult(moving.Route == "Direct, on your network"));
        Check("new requests go direct", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK && !ReferenceEquals(await moving.Connected(), first));
        var reader = new StreamReader(await longRun.Content.ReadAsStreamAsync());
        await reader.ReadLineAsync();
        Check("running stream stays on the relay", !first.IsClosed);
        longRun.Dispose();
        await Until("old path closes when drained", () => Task.FromResult(first.IsClosed));
      }

      // Server key rotation, live and in a welcome.
      await Ctl("/lanlist", new { list = new string[0] });
      var rotStore = new MemoryStore();
      var rot = await PairNew(rotStore);
      using (var handler = new TunnelHandler(rot))
      using (var http = Raw(handler)) {
        var newKey = (await Ctl("/rotate")).GetProperty("publicKey").GetString();
        await Until("rotation notice saved", () => Task.FromResult(Base64Url.Encode(rotStore.Saved.Server) == newKey));
        Check("session goes on after rotation", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);
        await Ctl("/drop-previous");
        await Until("dropped", () => Task.FromResult(rot.Route == "Not connected"));
        Check("uses the new key next time", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);
        var quietKey = (await Ctl("/rotate-quiet")).GetProperty("publicKey").GetString();
        await Ctl("/kick");
        await Until("dropped again", () => Task.FromResult(rot.Route == "Not connected"));
        Check("reaches the old key", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);
        Check("welcome's rotate saved", Base64Url.Encode(rotStore.Saved.Server) == quietKey);
        await Ctl("/drop-previous");
        await Until("dropped a third time", () => Task.FromResult(rot.Route == "Not connected"));
        Check("uses that key too", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);

        // Device key rotation.
        var oldDevice = rotStore.Saved.DeviceKey;
        await rot.RotateDeviceKey();
        Check("device key changed", X(oldDevice) != X(rotStore.Saved.DeviceKey) && rotStore.Saved.PendingKey == null);
        var known = (await Ctl("/keys")).GetProperty("known").EnumerateArray().Select(k => k.GetString()).ToList();
        Check("server has the new key", known.Contains(X(X25519.PublicKey(rotStore.Saved.DeviceKey))));
        await Ctl("/kick");
        await Until("dropped for the new key", () => Task.FromResult(rot.Route == "Not connected"));
        Check("reconnects on the new key", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK);
        await Ctl("/set", new { host = new { rejectRotation = true } });
        var keep = X(rotStore.Saved.DeviceKey);
        await ThrowsAsync<TunnelException>("refused rotation surfaces", () => rot.RotateDeviceKey(), e => e.Refused);
        Check("refused rotation keeps the key", X(rotStore.Saved.DeviceKey) == keep && rotStore.Saved.PendingKey == null);
        await Ctl("/set", new { host = new { rejectRotation = false, dropOldKey = true } });
        // The server took the new key but the answer never arrived.
        var before = rotStore.Saved.DeviceKey;
        await rot.RotateDeviceKey();
        var taken = rotStore.Saved.DeviceKey;
        rotStore.Saved.DeviceKey = before; rotStore.Saved.PendingKey = taken;
        await Ctl("/kick");
        await Until("dropped for the lost reply", () => Task.FromResult(rot.Route == "Not connected"));
        Check("recovers from a lost rotation reply", (await http.GetAsync("/api/auth/me")).StatusCode == HttpStatusCode.OK && X(rotStore.Saved.DeviceKey) == X(taken) && rotStore.Saved.PendingKey == null && !rotStore.Deleted);
        await Ctl("/set", new { host = new { dropOldKey = false } });
      }

      // Revocation, live and at the door.
      var revStore = new MemoryStore();
      var rev = await PairNew(revStore);
      string ended = null;
      rev.Ended += reason => ended = reason;
      await Ctl("/revoke", new { device = revStore.Saved.Device });
      await Until("revoked at once", () => Task.FromResult(ended != null));
      Check("revoked deletes the pairing", revStore.Deleted);
      await ThrowsAsync<TunnelException>("no more requests", () => rev.Connected(), e => e.Code == "revoked");
      rev.Dispose();

      var doorStore = new MemoryStore();
      var door = await PairNew(doorStore);
      door.Dispose();
      await Ctl("/revoke", new { device = doorStore.Saved.Device });
      var back = new TunnelConnection(doorStore.Saved, doorStore);
      string endedAtDoor = null;
      back.Ended += reason => endedAtDoor = reason;
      await ThrowsAsync<TunnelException>("revoked at the door", () => back.Connected(), e => e.Code == "revoked" && e.Refused);
      Check("door revocation deletes the pairing", doorStore.Deleted && endedAtDoor != null);
      back.Dispose();

      // A hello with an old clock is refused, and it isn't the end of the pairing.
      var clockStore = new MemoryStore();
      var clockTest = await PairNew(clockStore);
      clockTest.Dispose();
      var relayUrl = clockStore.Saved.RelayUrl;
      var transport = await WebSocketTransport.Open(relayUrl, true, TimeSpan.FromSeconds(5), CancellationToken.None);
      await ThrowsAsync<TunnelException>("stale clock", () => TunnelClient.Connect(transport, clockStore.Saved.DeviceKey, clockStore.Saved.Server,
        Wires.O("v", 1, "op", "connect", "client", "windows", "ts", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 600000), TimeSpan.FromSeconds(5)), e => e.Code == "stale" && e.Refused && e.Message.Contains("clock"));

      // The relay can't stand in for the server.
      var impostor = await WebSocketTransport.Open(relayUrl, true, TimeSpan.FromSeconds(5), CancellationToken.None);
      await ThrowsAsync<TunnelException>("wrong pinned key gets nowhere", () => TunnelClient.Connect(impostor, clockStore.Saved.DeviceKey, X25519.PublicKey(X25519.NewPrivateKey()),
        Wires.O("v", 1, "op", "connect", "client", "windows", "ts", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()), TimeSpan.FromSeconds(3)), e => !e.Refused);
      var forged = new Scripted { Reply = first => {
        // A forged refusal from something without the server key.
        var attempt = new byte[32 + 40]; RandomNumberGenerator.Fill(attempt); return attempt;
      } };
      await ThrowsAsync<TunnelException>("forged welcome isn't believed", () => TunnelClient.Connect(forged, clockStore.Saved.DeviceKey, clockStore.Saved.Server,
        Wires.O("v", 1, "op", "connect", "client", "windows", "ts", 0L), TimeSpan.FromSeconds(3)), e => e.Code == "bad_server" && !e.Refused);
      Check("forged welcome closes the path", forged.Closed);
      var unknown = await WebSocketTransport.Open(relayUrl, true, TimeSpan.FromSeconds(5), CancellationToken.None);
      await ThrowsAsync<TunnelException>("never-paired device", () => TunnelClient.Connect(unknown, X25519.NewPrivateKey(), clockStore.Saved.Server,
        Wires.O("v", 1, "op", "connect", "client", "windows", "ts", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()), TimeSpan.FromSeconds(5)), e => e.Code == "unknown_device" && e.Refused);

      // A record survives its own JSON.
      var round = TunnelPairing.FromMetadata(Wires.Parse(Wires.Serialize(clockStore.Saved.Metadata())));
      Check("pairing record round trip", round != null && round.Site == clockStore.Saved.Site && X(round.Server) == X(clockStore.Saved.Server) && round.Device == clockStore.Saved.Device && round.Origin == clockStore.Saved.Origin && round.Relay == clockStore.Saved.Relay);
      Check("no key in the record", !Wires.Serialize(clockStore.Saved.Metadata()).Contains(Base64Url.Encode(clockStore.Saved.DeviceKey)));
    }

    /// Hides its length, so the request goes out with none.
    sealed class NoLength : MemoryStream {
      public NoLength(byte[] data) : base(data) { }
      public override bool CanSeek { get { return false; } }
    }

    public static async Task<int> Main(string[] args) {
      var vectors = args[0]; var generated = Load(args[1]); var harness = args[2];
      var million = args.Contains("--million");
      Console.WriteLine("ChaCha20Poly1305.IsSupported=" + ChaCha20Poly1305.IsSupported);
      Rfc7748(million);
      foreach (var managed in new[] { false, true }) {
        TunnelAead.UseManaged = managed;
        Console.WriteLine("-- AEAD: " + (managed ? "managed RFC 8439" : "platform"));
        var before = failed;
        Aead();
        Generated(generated);
        NoiseVector(Load(Path.Combine(vectors, "noise_vector_ik.json")));
        Framing(Load(Path.Combine(vectors, "framing.json")));
        await Interop(harness);
        Console.WriteLine("   failures in this pass: " + (failed - before));
      }
      Console.WriteLine(passed + " passed, " + failed + " failed");
      return failed == 0 ? 0 : 1;
    }
  }
}
