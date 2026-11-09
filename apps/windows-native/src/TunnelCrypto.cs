using System;
using System.Buffers.Binary;
using System.Numerics;
using System.Security.Cryptography;

namespace Josi.Native {
  /// X25519 (RFC 7748) for the relay tunnel. .NET 8 has none of its own. Unlike
  /// Ed25519.cs this key is used on every connection, with a peer on the network
  /// choosing the input, so it is not BigInteger: this is the 16-limb field
  /// arithmetic from TweetNaCl, with no branch or table lookup on a secret.
  public static class X25519 {
    public const int KeySize = 32;
    static readonly byte[] BasePoint = Point9();
    static byte[] Point9() { var p = new byte[KeySize]; p[0] = 9; return p; }

    public static byte[] NewPrivateKey() { return RandomNumberGenerator.GetBytes(KeySize); }
    public static byte[] PublicKey(byte[] privateKey) { return ScalarMult(privateKey, BasePoint); }

    /// The shared secret. A low-order public key gives all zeros whatever our
    /// key is, which would hand the session to whoever sent it, so it is refused.
    public static byte[] SharedSecret(byte[] privateKey, byte[] remotePublic) {
      var result = ScalarMult(privateKey, remotePublic);
      if (IsZero(result)) throw new CryptographicException("Low-order public key");
      return result;
    }

    /// Whether a public key is 32 bytes and not of low order. Multiplying by any
    /// clamped scalar clears the cofactor, so the all-zero scalar will do.
    public static bool IsUsablePublicKey(byte[] publicKey) {
      return publicKey != null && publicKey.Length == KeySize && !IsZero(ScalarMult(new byte[KeySize], publicKey));
    }

    static bool IsZero(byte[] value) {
      var diff = 0;
      foreach (var b in value) diff |= b;
      return diff == 0;
    }

    /// RFC 7748's X25519 function: clamps the scalar, ignores the top bit of u.
    public static byte[] ScalarMult(byte[] scalar, byte[] point) {
      if (scalar == null || scalar.Length != KeySize) throw new ArgumentException("scalar");
      if (point == null || point.Length != KeySize) throw new ArgumentException("point");
      Span<byte> z = stackalloc byte[KeySize];
      scalar.AsSpan().CopyTo(z);
      z[0] &= 248; z[31] &= 127; z[31] |= 64;
      Span<long> x = stackalloc long[16], a = stackalloc long[16], b = stackalloc long[16], c = stackalloc long[16],
        d = stackalloc long[16], e = stackalloc long[16], f = stackalloc long[16];
      Span<long> a24 = stackalloc long[16];
      a24[0] = 0xDB41; a24[1] = 1;   // 121665
      Unpack(x, point);
      x.CopyTo(b);
      a.Clear(); c.Clear(); d.Clear();
      a[0] = 1; d[0] = 1;
      for (var i = 254; i >= 0; i--) {
        long bit = (z[i >> 3] >> (i & 7)) & 1;
        Swap(a, b, bit); Swap(c, d, bit);
        Add(e, a, c); Sub(a, a, c); Add(c, b, d); Sub(b, b, d);
        Mul(d, e, e); Mul(f, a, a); Mul(a, c, a); Mul(c, b, e);
        Add(e, a, c); Sub(a, a, c); Mul(b, a, a); Sub(c, d, f);
        Mul(a, c, a24); Add(a, a, d); Mul(c, c, a); Mul(a, d, f); Mul(d, b, x); Mul(b, e, e);
        Swap(a, b, bit); Swap(c, d, bit);
      }
      Invert(c, c);
      Mul(a, a, c);
      var result = new byte[KeySize];
      Pack(result, a);
      z.Clear(); x.Clear(); a.Clear(); b.Clear(); c.Clear(); d.Clear(); e.Clear(); f.Clear();
      return result;
    }

    static void Unpack(Span<long> o, byte[] n) {
      for (var i = 0; i < 16; i++) o[i] = n[2 * i] + ((long)n[2 * i + 1] << 8);
      o[15] &= 0x7fff;
    }
    static void Carry(Span<long> o) {
      for (var i = 0; i < 16; i++) {
        o[i] += 1L << 16;
        var c = o[i] >> 16;
        if (i < 15) o[i + 1] += c - 1; else o[0] += 38 * (c - 1);
        o[i] -= c << 16;
      }
    }
    /// Swaps p and q when bit is 1, without a branch.
    static void Swap(Span<long> p, Span<long> q, long bit) {
      var mask = ~(bit - 1);
      for (var i = 0; i < 16; i++) {
        var t = mask & (p[i] ^ q[i]);
        p[i] ^= t; q[i] ^= t;
      }
    }
    static void Pack(byte[] o, Span<long> n) {
      Span<long> m = stackalloc long[16], t = stackalloc long[16];
      n.CopyTo(t);
      Carry(t); Carry(t); Carry(t);
      for (var j = 0; j < 2; j++) {
        m[0] = t[0] - 0xffed;
        for (var i = 1; i < 15; i++) {
          m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
          m[i - 1] &= 0xffff;
        }
        m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
        var borrow = (m[15] >> 16) & 1;
        m[14] &= 0xffff;
        Swap(t, m, 1 - borrow);
      }
      for (var i = 0; i < 16; i++) { o[2 * i] = (byte)t[i]; o[2 * i + 1] = (byte)(t[i] >> 8); }
      m.Clear(); t.Clear();
    }
    static void Add(Span<long> o, Span<long> a, Span<long> b) { for (var i = 0; i < 16; i++) o[i] = a[i] + b[i]; }
    static void Sub(Span<long> o, Span<long> a, Span<long> b) { for (var i = 0; i < 16; i++) o[i] = a[i] - b[i]; }
    static void Mul(Span<long> o, Span<long> a, Span<long> b) {
      Span<long> t = stackalloc long[31];
      t.Clear();
      for (var i = 0; i < 16; i++) for (var j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
      for (var i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
      t.Slice(0, 16).CopyTo(o);
      Carry(o); Carry(o);
      t.Clear();
    }
    /// a^(p-2). The exponent is public, so these branches give nothing away.
    static void Invert(Span<long> o, Span<long> input) {
      Span<long> c = stackalloc long[16];
      input.CopyTo(c);
      for (var a = 253; a >= 0; a--) {
        Mul(c, c, c);
        if (a != 2 && a != 4) Mul(c, c, input);
      }
      c.CopyTo(o);
      c.Clear();
    }
  }

  /// ChaCha20-Poly1305, 12-byte nonce, tag after the text. Windows only has it
  /// from build 20142, so ChaCha20Poly1305.IsSupported is false on every Windows
  /// 10 this app supports (19041 and up). Those PCs use the RFC 8439 code below.
  public static class TunnelAead {
    public const int TagSize = 16;
    public static bool UseManaged = !ChaCha20Poly1305.IsSupported;

    public static byte[] Seal(byte[] key, byte[] nonce, byte[] ad, ReadOnlySpan<byte> plain) {
      var result = new byte[plain.Length + TagSize];
      var text = result.AsSpan(0, plain.Length); var tag = result.AsSpan(plain.Length);
      if (UseManaged) ManagedAead.Seal(key, nonce, ad, plain, text, tag);
      else using (var cipher = new ChaCha20Poly1305(key)) cipher.Encrypt(nonce, plain, text, tag, ad);
      return result;
    }
    /// Throws CryptographicException unless the text is authentic.
    public static byte[] Open(byte[] key, byte[] nonce, byte[] ad, ReadOnlySpan<byte> sealedText) {
      if (sealedText.Length < TagSize) throw new CryptographicException("Short message");
      var text = sealedText.Slice(0, sealedText.Length - TagSize); var tag = sealedText.Slice(text.Length);
      var result = new byte[text.Length];
      if (UseManaged) ManagedAead.Open(key, nonce, ad, text, tag, result);
      else using (var cipher = new ChaCha20Poly1305(key)) cipher.Decrypt(nonce, text, tag, result, ad);
      return result;
    }
  }

  /// RFC 8439, for PCs whose Windows has no ChaCha20-Poly1305.
  public static class ManagedAead {
    public static void Seal(byte[] key, byte[] nonce, ReadOnlySpan<byte> ad, ReadOnlySpan<byte> plain, Span<byte> text, Span<byte> tag) {
      Check(key, nonce);
      Crypt(key, nonce, plain, text);
      Mac(key, nonce, ad, text, tag);
    }
    public static void Open(byte[] key, byte[] nonce, ReadOnlySpan<byte> ad, ReadOnlySpan<byte> text, ReadOnlySpan<byte> tag, Span<byte> plain) {
      Check(key, nonce);
      Span<byte> expected = stackalloc byte[16];
      Mac(key, nonce, ad, text, expected);
      if (!CryptographicOperations.FixedTimeEquals(expected, tag)) throw new AuthenticationTagMismatchException();
      Crypt(key, nonce, text, plain);
    }
    static void Check(byte[] key, byte[] nonce) {
      if (key == null || key.Length != 32) throw new ArgumentException("key");
      if (nonce == null || nonce.Length != 12) throw new ArgumentException("nonce");
    }

    static void State(Span<uint> s, byte[] key, byte[] nonce) {
      s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
      for (var i = 0; i < 8; i++) s[4 + i] = BinaryPrimitives.ReadUInt32LittleEndian(key.AsSpan(4 * i));
      s[12] = 0;
      for (var i = 0; i < 3; i++) s[13 + i] = BinaryPrimitives.ReadUInt32LittleEndian(nonce.AsSpan(4 * i));
    }
    static void Quarter(Span<uint> x, int a, int b, int c, int d) {
      x[a] += x[b]; x[d] = BitOperations.RotateLeft(x[d] ^ x[a], 16);
      x[c] += x[d]; x[b] = BitOperations.RotateLeft(x[b] ^ x[c], 12);
      x[a] += x[b]; x[d] = BitOperations.RotateLeft(x[d] ^ x[a], 8);
      x[c] += x[d]; x[b] = BitOperations.RotateLeft(x[b] ^ x[c], 7);
    }
    static void Block(ReadOnlySpan<uint> state, Span<byte> output) {
      Span<uint> x = stackalloc uint[16];
      state.CopyTo(x);
      for (var i = 0; i < 10; i++) {
        Quarter(x, 0, 4, 8, 12); Quarter(x, 1, 5, 9, 13); Quarter(x, 2, 6, 10, 14); Quarter(x, 3, 7, 11, 15);
        Quarter(x, 0, 5, 10, 15); Quarter(x, 1, 6, 11, 12); Quarter(x, 2, 7, 8, 13); Quarter(x, 3, 4, 9, 14);
      }
      for (var i = 0; i < 16; i++) BinaryPrimitives.WriteUInt32LittleEndian(output.Slice(4 * i), x[i] + state[i]);
      x.Clear();
    }
    /// The cipher, from block 1. Block 0 makes the Poly1305 key.
    static void Crypt(byte[] key, byte[] nonce, ReadOnlySpan<byte> input, Span<byte> output) {
      Span<uint> state = stackalloc uint[16];
      Span<byte> stream = stackalloc byte[64];
      State(state, key, nonce);
      for (var at = 0; at < input.Length; at += 64) {
        state[12]++;
        Block(state, stream);
        var end = Math.Min(64, input.Length - at);
        for (var i = 0; i < end; i++) output[at + i] = (byte)(input[at + i] ^ stream[i]);
      }
      state.Clear(); stream.Clear();
    }

    static void Mac(byte[] key, byte[] nonce, ReadOnlySpan<byte> ad, ReadOnlySpan<byte> text, Span<byte> tag) {
      Span<uint> state = stackalloc uint[16];
      Span<byte> block = stackalloc byte[64];
      State(state, key, nonce);
      Block(state, block);
      var poly = new Poly1305(block.Slice(0, 32));
      poly.Absorb(ad);
      poly.Absorb(text);
      Span<byte> lengths = stackalloc byte[16];
      BinaryPrimitives.WriteUInt64LittleEndian(lengths, (ulong)ad.Length);
      BinaryPrimitives.WriteUInt64LittleEndian(lengths.Slice(8), (ulong)text.Length);
      poly.Absorb(lengths);
      poly.Finish(tag);
      state.Clear(); block.Clear();
    }

    /// Poly1305 in 26-bit limbs (poly1305-donna-32). The AEAD pads everything it
    /// feeds in to 16 bytes, so every block here is a full one.
    internal struct Poly1305 {
      uint r0, r1, r2, r3, r4, s1, s2, s3, s4, h0, h1, h2, h3, h4, pad0, pad1, pad2, pad3;
      static uint U32(ReadOnlySpan<byte> m, int at) { return BinaryPrimitives.ReadUInt32LittleEndian(m.Slice(at)); }
      public Poly1305(ReadOnlySpan<byte> key) {
        r0 = U32(key, 0) & 0x3ffffff;
        r1 = (U32(key, 3) >> 2) & 0x3ffff03;
        r2 = (U32(key, 6) >> 4) & 0x3ffc0ff;
        r3 = (U32(key, 9) >> 6) & 0x3f03fff;
        r4 = (U32(key, 12) >> 8) & 0x00fffff;
        s1 = r1 * 5; s2 = r2 * 5; s3 = r3 * 5; s4 = r4 * 5;
        h0 = h1 = h2 = h3 = h4 = 0;
        pad0 = U32(key, 16); pad1 = U32(key, 20); pad2 = U32(key, 24); pad3 = U32(key, 28);
      }
      /// Data, then zeros up to a multiple of 16.
      public void Absorb(ReadOnlySpan<byte> data) {
        var at = 0;
        for (; at + 16 <= data.Length; at += 16) Round(data.Slice(at, 16));
        if (at == data.Length) return;
        Span<byte> last = stackalloc byte[16];
        last.Clear();
        data.Slice(at).CopyTo(last);
        Round(last);
      }
      void Round(ReadOnlySpan<byte> m) {
        h0 += U32(m, 0) & 0x3ffffff;
        h1 += (U32(m, 3) >> 2) & 0x3ffffff;
        h2 += (U32(m, 6) >> 4) & 0x3ffffff;
        h3 += (U32(m, 9) >> 6) & 0x3ffffff;
        h4 += (U32(m, 12) >> 8) | (1u << 24);
        ulong a0 = h0, a1 = h1, a2 = h2, a3 = h3, a4 = h4;
        var d0 = a0 * r0 + a1 * s4 + a2 * s3 + a3 * s2 + a4 * s1;
        var d1 = a0 * r1 + a1 * r0 + a2 * s4 + a3 * s3 + a4 * s2;
        var d2 = a0 * r2 + a1 * r1 + a2 * r0 + a3 * s4 + a4 * s3;
        var d3 = a0 * r3 + a1 * r2 + a2 * r1 + a3 * r0 + a4 * s4;
        var d4 = a0 * r4 + a1 * r3 + a2 * r2 + a3 * r1 + a4 * r0;
        var c = d0 >> 26; h0 = (uint)d0 & 0x3ffffff;
        d1 += c; c = d1 >> 26; h1 = (uint)d1 & 0x3ffffff;
        d2 += c; c = d2 >> 26; h2 = (uint)d2 & 0x3ffffff;
        d3 += c; c = d3 >> 26; h3 = (uint)d3 & 0x3ffffff;
        d4 += c; c = d4 >> 26; h4 = (uint)d4 & 0x3ffffff;
        h0 += (uint)c * 5;
        var carry = h0 >> 26; h0 &= 0x3ffffff; h1 += carry;
      }
      public void Finish(Span<byte> tag) {
        var c = h1 >> 26; h1 &= 0x3ffffff;
        h2 += c; c = h2 >> 26; h2 &= 0x3ffffff;
        h3 += c; c = h3 >> 26; h3 &= 0x3ffffff;
        h4 += c; c = h4 >> 26; h4 &= 0x3ffffff;
        h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff;
        h1 += c;
        // h - p, and keep it when that did not go below zero.
        var g0 = h0 + 5; c = g0 >> 26; g0 &= 0x3ffffff;
        var g1 = h1 + c; c = g1 >> 26; g1 &= 0x3ffffff;
        var g2 = h2 + c; c = g2 >> 26; g2 &= 0x3ffffff;
        var g3 = h3 + c; c = g3 >> 26; g3 &= 0x3ffffff;
        var g4 = unchecked(h4 + c - (1u << 26));
        var mask = (g4 >> 31) - 1;
        g0 &= mask; g1 &= mask; g2 &= mask; g3 &= mask; g4 &= mask;
        mask = ~mask;
        h0 = (h0 & mask) | g0; h1 = (h1 & mask) | g1; h2 = (h2 & mask) | g2; h3 = (h3 & mask) | g3; h4 = (h4 & mask) | g4;
        var w0 = h0 | (h1 << 26);
        var w1 = (h1 >> 6) | (h2 << 20);
        var w2 = (h2 >> 12) | (h3 << 14);
        var w3 = (h3 >> 18) | (h4 << 8);
        ulong f = (ulong)w0 + pad0; BinaryPrimitives.WriteUInt32LittleEndian(tag, (uint)f);
        f = (ulong)w1 + pad1 + (f >> 32); BinaryPrimitives.WriteUInt32LittleEndian(tag.Slice(4), (uint)f);
        f = (ulong)w2 + pad2 + (f >> 32); BinaryPrimitives.WriteUInt32LittleEndian(tag.Slice(8), (uint)f);
        f = (ulong)w3 + pad3 + (f >> 32); BinaryPrimitives.WriteUInt32LittleEndian(tag.Slice(12), (uint)f);
      }
    }
  }
}
