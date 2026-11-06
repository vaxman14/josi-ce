using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  public static class Base64Url {
    public static string Encode(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    /// Null when it isn't base64url.
    public static byte[] Decode(string text) {
      if (text == null) return null;
      var clean = text.TrimEnd('=').Replace('-', '+').Replace('_', '/');
      if (clean.Length % 4 == 1) return null;
      try { return Convert.FromBase64String(clean.PadRight((clean.Length + 3) / 4 * 4, '=')); }
      catch (FormatException) { return null; }
    }
  }

  /// Pairing codes: 160 random bits as 32 Crockford base32 characters. The relay
  /// is given only a hash of a code (the invite id), and a box sealed with a key
  /// derived from it.
  public static class PairingCode {
    const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    public const int Length = 32;

    /// Dashes and case are for people. O, I and L are read as the digits they
    /// look like. ToUpperInvariant, so a Turkish Windows still uppercases i to I.
    public static string Normalize(string input) {
      var text = new StringBuilder();
      foreach (var c in (input ?? "").ToUpperInvariant()) {
        if (char.IsWhiteSpace(c) || c == '-' || c == '﻿') continue;
        text.Append(c == 'O' ? '0' : c == 'I' || c == 'L' ? '1' : c);
      }
      return text.ToString();
    }
    public static bool IsValid(string code) { return code != null && code.Length == Length && code.All(c => Alphabet.IndexOf(c) >= 0); }
    static byte[] Hash(string text) { return SHA256.HashData(Encoding.UTF8.GetBytes(text)); }
    public static string InviteId(string code) { return Convert.ToHexString(Hash("josi-invite-id/1|" + code)).ToLowerInvariant().Substring(0, 32); }
    public static byte[] InviteKey(string code) { return Hash("josi-invite-key/1|" + code); }
  }

  /// Everything a device needs to reach a server, and nothing that lets it in.
  public sealed class TunnelInvite {
    /// Where a typed code is looked up. A link carries everything itself, so an
    /// owner's own relay is paired with the link.
    public const string DefaultRelay = "https://relay.heyjosi.com";
    public const int MaxLan = 8;
    const string BadCode = "That code was wrong, used, or expired. Make a new one on your server.";
    public string Code, Site, Relay, Name;
    public byte[] Server;
    public List<string> Lan = new List<string>();

    /// A pasted code or pairing link.
    public static async Task<TunnelInvite> Resolve(string input, string relay = DefaultRelay, CancellationToken cancel = default(CancellationToken)) {
      var text = (input ?? "").Trim();
      if (text.Length > 16384) throw new TunnelException("bad_code", "That doesn't look like a pairing code or link.");
      if (text.Contains("#josi-pair=")) {
        var invite = ParseLink(text);
        if (invite == null) throw new TunnelException("bad_code", "That pairing link isn't complete. Copy it again.");
        return invite;
      }
      var code = PairingCode.Normalize(text);
      if (!PairingCode.IsValid(code)) throw new TunnelException("bad_code", "That doesn't look like a pairing code. It has 32 characters.");
      string body;
      using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) }) {
        try {
          // Only the hash goes out. The code stays here until the handshake.
          using (var response = await client.GetAsync(relay.TrimEnd('/') + "/v1/invites/" + PairingCode.InviteId(code), cancel).ConfigureAwait(false)) {
            if ((int)response.StatusCode == 429) throw new TunnelException("busy", "Too many tries from this network. Try again in an hour.");
            if (!response.IsSuccessStatusCode) throw new TunnelException("bad_code", BadCode);
            body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
          }
        } catch (Exception e) when (e is HttpRequestException || (e is OperationCanceledException && !cancel.IsCancellationRequested)) {
          throw new TunnelException("unreachable", "Josi couldn't reach the relay. Check your internet connection.", e);
        }
      }
      return OpenBox(code, Wires.Parse(body)["box"].Text);
    }

    /// The box the relay holds: 12-byte nonce, then ChaCha20-Poly1305 text. It
    /// opens only with the code, so the relay can't swap the server key in it.
    public static TunnelInvite OpenBox(string code, string sealedBox) {
      var raw = Base64Url.Decode(sealedBox);
      if (raw == null || raw.Length < 12 + TunnelAead.TagSize) throw new TunnelException("bad_code", BadCode);
      byte[] plain;
      try { plain = TunnelAead.Open(PairingCode.InviteKey(code), raw.AsSpan(0, 12).ToArray(), Array.Empty<byte>(), raw.AsSpan(12)); }
      catch (CryptographicException e) { throw new TunnelException("bad_code", BadCode, e); }
      return FromBox(code, Wires.Parse(Encoding.UTF8.GetString(plain))) ?? throw new TunnelException("bad_code", "This server's invitation can't be used. Make a new one.");
    }

    /// A QR link: https://alice.heyjosi.com/#josi-pair=CODE.BOX. It never gets
    /// fetched, and the code only ever leaves inside the handshake.
    public static TunnelInvite ParseLink(string link) {
      var match = Regex.Match((link ?? "").Trim(), @"#josi-pair=([0-9A-Z]+)\.([A-Za-z0-9_-]+)\z");
      if (!match.Success || !PairingCode.IsValid(match.Groups[1].Value)) return null;
      var raw = Base64Url.Decode(match.Groups[2].Value);
      if (raw == null) return null;
      string text;
      try { text = new UTF8Encoding(false, true).GetString(raw); } catch (ArgumentException) { return null; }
      return FromBox(match.Groups[1].Value, Wires.Parse(text));
    }

    static TunnelInvite FromBox(string code, Wire box) {
      var server = Base64Url.Decode(box["server"].Text);
      var relay = box["relay"].Text.TrimEnd('/');
      if (box["v"].Integer != 1 || !X25519.IsUsablePublicKey(server) || !Regex.IsMatch(box["site"].Text, @"\A[0-9a-f]{32}\z") || !ValidRelay(relay)) return null;
      return new TunnelInvite { Code = code, Server = server, Site = box["site"].Text, Relay = relay, Name = box["name"].Text.Length == 0 ? null : box["name"].Text, Lan = CleanLan(box["lan"]) };
    }

    /// wss, or ws to this PC for a relay under development.
    public static bool ValidRelay(string relay) {
      Uri url;
      if (!Uri.TryCreate(relay, UriKind.Absolute, out url) || url.UserInfo.Length > 0 || url.Query.Length > 0 || url.Fragment.Length > 0 || url.AbsolutePath.Length > 1) return false;
      return url.Scheme == "wss" || (url.Scheme == "ws" && (url.IsLoopback || url.Host == "localhost"));
    }

    /// LAN addresses come from the server, but a pasted link carries them too, so
    /// only what could be one is kept. Plain ws is fine here: Noise covers it.
    public static List<string> CleanLan(Wire lan) {
      var result = new List<string>();
      foreach (var item in lan.List) {
        Uri url;
        if (item.Text.Length <= 256 && Uri.TryCreate(item.Text, UriKind.Absolute, out url) && (url.Scheme == "ws" || url.Scheme == "wss") && url.UserInfo.Length == 0 && url.Host.Length > 0
            && !result.Contains(item.Text) && result.Count < MaxLan) result.Add(item.Text);
      }
      return result;
    }
  }

  /// What this PC remembers about one paired server. Everything but the keys is
  /// plain data; ITunnelStore keeps the keys in the OS key store.
  public sealed class TunnelPairing {
    public string Site, Relay, Name, Label, Device, Origin;
    public byte[] Server, DeviceKey, PendingKey;
    public List<string> Lan = new List<string>();

    public Uri RelayUrl { get { return new Uri(Relay + "/v1/sites/" + Site + "/peer"); } }

    /// What JosiApi calls this server. It keys the remembered sign-in, and on a
    /// server with a name it's the public address the server knows itself by. No
    /// traffic goes there: every request travels through the tunnel.
    public static string OriginFor(TunnelInvite invite) {
      // As the server works out its own address (addressOf in relayService.ts).
      var host = new Uri(invite.Relay).Host;
      var domain = host.StartsWith("relay.", StringComparison.Ordinal) ? host.Substring(6) : host;
      var named = invite.Name != null && Regex.IsMatch(invite.Name, @"\A[a-z][a-z0-9-]{1,30}[a-z0-9]\z");
      return "https://" + (named ? invite.Name : invite.Site) + "." + domain;
    }

    public object Metadata() {
      return Wires.O("site", Site, "relay", Relay, "name", Name, "label", Label, "device", Device, "origin", Origin, "server", Base64Url.Encode(Server), "lan", Lan);
    }
    /// Null for anything that isn't a whole, usable record.
    public static TunnelPairing FromMetadata(Wire value) {
      var server = Base64Url.Decode(value["server"].Text);
      if (!X25519.IsUsablePublicKey(server) || !Regex.IsMatch(value["site"].Text, @"\A[0-9a-f]{32}\z") || !TunnelInvite.ValidRelay(value["relay"].Text)
          || value["device"].Text.Length == 0 || !value["origin"].Text.StartsWith("https://", StringComparison.Ordinal)) return null;
      return new TunnelPairing {
        Site = value["site"].Text, Relay = value["relay"].Text, Name = value["name"].Text, Label = value["label"].Text, Device = value["device"].Text,
        Origin = value["origin"].Text, Server = server, Lan = TunnelInvite.CleanLan(value["lan"])
      };
    }
  }

  public interface ITunnelStore {
    void Save(TunnelPairing pairing);
    void Delete(TunnelPairing pairing);
  }
}
