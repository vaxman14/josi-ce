using System;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Josi.Native {
  /// Anything that stops the tunnel. Code is the protocol's word for it and the
  /// message is ready to show. Refused means the server itself said no, inside
  /// the authenticated handshake; nothing else may be treated as its answer.
  public sealed class TunnelException : Exception {
    public readonly string Code;
    public readonly bool Refused;
    public TunnelException(string code, string message = null, Exception inner = null, bool refused = false) : base(message ?? Explain(code), inner) { Code = code; Refused = refused; }
    public static string Explain(string code) {
      switch (code) {
        case "bad_code": return "That code was wrong, used, or expired. Make a new one on your server.";
        case "offline": return "Your Josi server is not connected right now. Check that its computer is on, then try again.";
        case "revoked": return "This PC was removed from your server. Pair it again.";
        case "unknown_device": return "Your server doesn't know this PC. Pair it again.";
        case "stale": return "This PC's clock is wrong. Set the right time, then try again.";
        case "busy": return "Your server is busy. Try again in a moment.";
        case "bad_server": return "Josi couldn't confirm this is your server, so it didn't connect.";
        case "tampered": return "The connection to your server was interfered with, so Josi closed it.";
        case "timeout": return "Your server did not answer.";
        case "reset": return "The server ended this request.";
        default: return "Your Josi server can't be reached right now.";
      }
    }
  }

  /// One direction of a Noise session. A nonce is four zero bytes, then the
  /// counter in little-endian.
  public sealed class NoiseCipher {
    byte[] key;
    ulong n;
    public NoiseCipher(byte[] key) { this.key = key; }
    static byte[] Nonce(ulong n) { var nonce = new byte[12]; BinaryPrimitives.WriteUInt64LittleEndian(nonce.AsSpan(4), n); return nonce; }
    public byte[] Encrypt(byte[] ad, ReadOnlySpan<byte> plain) {
      if (n == ulong.MaxValue) throw new TunnelException("closed", "Nonce exhausted");
      var result = TunnelAead.Seal(key, Nonce(n), ad, plain);
      n++;
      return result;
    }
    /// A failed decryption leaves the counter where it was and throws.
    public byte[] Decrypt(byte[] ad, ReadOnlySpan<byte> text) {
      if (n == ulong.MaxValue) throw new TunnelException("closed", "Nonce exhausted");
      var result = TunnelAead.Open(key, Nonce(n), ad, text);
      n++;
      return result;
    }
    /// Noise's REKEY: the counter carries on under the new key.
    public void Rekey() {
      var next = TunnelAead.Seal(key, Nonce(ulong.MaxValue), Array.Empty<byte>(), new byte[32]);
      var fresh = new byte[32];
      Array.Copy(next, fresh, 32);
      CryptographicOperations.ZeroMemory(key);
      CryptographicOperations.ZeroMemory(next);
      key = fresh;
    }
  }

  /// The initiator's half of Noise_IK_25519_ChaChaPoly_SHA256, revision 34. A
  /// device is always the initiator, so the responder is the server's job.
  public sealed class NoiseHandshake {
    public static readonly byte[] Prologue = Encoding.ASCII.GetBytes("josi-relay/1");
    const int KeySize = X25519.KeySize, TagSize = TunnelAead.TagSize;
    readonly byte[] s, rs;
    byte[] h, ck, e;
    NoiseCipher cipher;
    public NoiseCipher Send, Receive;
    public byte[] Hash { get { return h; } }

    public NoiseHandshake(byte[] staticPrivate, byte[] remoteStatic, byte[] prologue = null) {
      if (remoteStatic == null || remoteStatic.Length != KeySize) throw new TunnelException("bad_server");
      s = staticPrivate; rs = remoteStatic;
      h = Encoding.ASCII.GetBytes("Noise_IK_25519_ChaChaPoly_SHA256");   // exactly 32 bytes, so it isn't hashed
      ck = h;
      MixHash(prologue ?? Prologue);
      MixHash(rs);
    }

    static byte[] Join(params byte[][] parts) {
      var size = 0; foreach (var part in parts) size += part.Length;
      var result = new byte[size]; var at = 0;
      foreach (var part in parts) { part.CopyTo(result, at); at += part.Length; }
      return result;
    }
    void MixHash(byte[] data) { h = SHA256.HashData(Join(h, data)); }
    static void Hkdf(byte[] ck, byte[] ikm, out byte[] one, out byte[] two) {
      var temp = HMACSHA256.HashData(ck, ikm);
      one = HMACSHA256.HashData(temp, new byte[] { 1 });
      two = HMACSHA256.HashData(temp, Join(one, new byte[] { 2 }));
      CryptographicOperations.ZeroMemory(temp);
    }
    void MixKey(byte[] ikm) {
      byte[] next, key;
      Hkdf(ck, ikm, out next, out key);
      CryptographicOperations.ZeroMemory(ikm);
      ck = next; cipher = new NoiseCipher(key);
    }
    byte[] EncryptAndHash(byte[] plain) { var text = cipher.Encrypt(h, plain); MixHash(text); return text; }
    byte[] DecryptAndHash(byte[] text) { var plain = cipher.Decrypt(h, text); MixHash(text); return plain; }

    /// -> e, es, s, ss, with the payload. Tests pass their own ephemeral key.
    public byte[] WriteFirst(byte[] payload, byte[] ephemeral = null) {
      e = ephemeral ?? X25519.NewPrivateKey();
      var publicE = X25519.PublicKey(e);
      MixHash(publicE);
      MixKey(X25519.SharedSecret(e, rs));
      var sealedStatic = EncryptAndHash(X25519.PublicKey(s));
      MixKey(X25519.SharedSecret(s, rs));
      return Join(publicE, sealedStatic, EncryptAndHash(payload));
    }

    /// <- e, ee, se. Throws CryptographicException if it isn't from the holder
    /// of the server key.
    public byte[] ReadSecond(byte[] message) {
      if (message.Length < KeySize + TagSize) throw new CryptographicException("Short handshake message");
      var re = message.AsSpan(0, KeySize).ToArray();
      MixHash(re);
      MixKey(X25519.SharedSecret(e, re));
      MixKey(X25519.SharedSecret(s, re));
      var payload = DecryptAndHash(message.AsSpan(KeySize).ToArray());
      byte[] one, two;
      Hkdf(ck, Array.Empty<byte>(), out one, out two);
      Send = new NoiseCipher(one); Receive = new NoiseCipher(two);
      CryptographicOperations.ZeroMemory(e); CryptographicOperations.ZeroMemory(ck);
      cipher = null;
      return payload;
    }
  }

  /// The transport phase. Framed: flags, 2-byte length, the data, then zeros to
  /// a multiple of 256, so the relay learns sizes only to the nearest block. The
  /// sender rekeys after RekeyMessages or RekeySeconds and marks its last message
  /// under the old key. Not thread-safe: seal and send are one step, in order.
  public sealed class NoiseSession {
    public const int MaxMessage = 65535;
    public const int MaxFramed = MaxMessage - TunnelAead.TagSize - FrameHead;
    const int FrameHead = 3, PadBlock = 256, RekeyFlag = 1;
    static readonly byte[] None = Array.Empty<byte>();
    readonly NoiseCipher send, receive;
    readonly bool framed;
    public int RekeyMessages = 1 << 20;
    public int RekeySeconds = 3600;
    int sent;
    long rekeyed = Environment.TickCount64;

    public NoiseSession(NoiseCipher send, NoiseCipher receive, bool framed = true) { this.send = send; this.receive = receive; this.framed = framed; }

    public byte[] Seal(ReadOnlySpan<byte> plain) {
      if (!framed) {
        if (plain.Length + TunnelAead.TagSize > MaxMessage) throw new ArgumentException("Message too large");
        return send.Encrypt(None, plain);
      }
      if (plain.Length > MaxFramed) throw new ArgumentException("Message too large");
      sent++;
      var rekey = sent >= RekeyMessages || Environment.TickCount64 - rekeyed >= RekeySeconds * 1000L;
      var size = (FrameHead + plain.Length + PadBlock - 1) / PadBlock * PadBlock;
      var body = new byte[Math.Min(size, MaxMessage - TunnelAead.TagSize)];
      body[0] = rekey ? (byte)RekeyFlag : (byte)0;
      BinaryPrimitives.WriteUInt16BigEndian(body.AsSpan(1), (ushort)plain.Length);
      plain.CopyTo(body.AsSpan(FrameHead));
      var result = send.Encrypt(None, body);
      if (rekey) { send.Rekey(); sent = 0; rekeyed = Environment.TickCount64; }
      return result;
    }

    /// Throws unless the message is authentic and well formed. After that the
    /// session is finished: nothing later can be trusted.
    public ArraySegment<byte> Open(byte[] text) {
      if (text.Length > MaxMessage) throw new CryptographicException("Message too large");
      var plain = receive.Decrypt(None, text);
      if (!framed) return new ArraySegment<byte>(plain);
      if (plain.Length < FrameHead || (plain[0] & ~RekeyFlag) != 0) throw new CryptographicException("Bad frame");
      int size = BinaryPrimitives.ReadUInt16BigEndian(plain.AsSpan(1));
      if (FrameHead + size > plain.Length) throw new CryptographicException("Bad frame");
      if ((plain[0] & RekeyFlag) != 0) receive.Rekey();
      return new ArraySegment<byte>(plain, FrameHead, size);
    }
  }

  public enum TunnelFrame : byte { ReqHead = 1, ReqBody = 2, ReqEnd = 3, ResHead = 4, ResBody = 5, ResEnd = 6, Reset = 7, Ping = 8, Pong = 9, Control = 10 }

  /// What travels inside a session: one byte of type, four of stream id, the rest
  /// payload. The relay sees none of this.
  public static class TunnelMux {
    public const int Head = 5;
    /// The largest body piece one frame carries.
    public const int MaxPiece = NoiseSession.MaxFramed - Head;

    public static byte[] Encode(TunnelFrame type, uint stream, ReadOnlySpan<byte> payload = default(ReadOnlySpan<byte>)) {
      var frame = new byte[Head + payload.Length];
      frame[0] = (byte)type;
      BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(1), stream);
      payload.CopyTo(frame.AsSpan(Head));
      return frame;
    }
    public static byte[] Json(TunnelFrame type, uint stream, object value) { return Encode(type, stream, Encoding.UTF8.GetBytes(Wires.Serialize(value))); }
    public static void Decode(ArraySegment<byte> raw, out TunnelFrame type, out uint stream, out ArraySegment<byte> payload) {
      if (raw.Count < Head) throw new CryptographicException("Short frame");
      type = (TunnelFrame)raw[0];
      stream = BinaryPrimitives.ReadUInt32BigEndian(raw.AsSpan(1));
      payload = raw.Slice(Head);
    }
  }
}
