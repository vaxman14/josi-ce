using System;
using System.Numerics;
using System.Security.Cryptography;

namespace Josi.Native {
  /// Ed25519 (RFC 8032) signing for the protected-approval device key. .NET 8
  /// has no Ed25519 of its own and the server verifies exactly this curve, so
  /// the few operations an approval needs run here on BigInteger arithmetic.
  /// It is correct and small, not constant-time: the seed it signs with lives
  /// only for one approval, unwrapped after Windows Hello, in this process.
  public static class Ed25519 {
    static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
    static readonly BigInteger Q = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
    static readonly BigInteger D = Mod(BigInteger.MinusOne * 121665 * Inverse(121666));
    static readonly BigInteger Bx = BigInteger.Parse("15112221349535400772501151409588531511454012693041857206046113283949847762202");
    static readonly BigInteger By = BigInteger.Parse("46316835694926478169428394003475163141307993866256225615783033603165251855960");
    /// SubjectPublicKeyInfo prefix for an Ed25519 public key (RFC 8410).
    public static readonly byte[] SpkiPrefix = { 0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00 };

    static BigInteger Mod(BigInteger a) { var r = a % P; return r.Sign < 0 ? r + P : r; }
    static BigInteger Inverse(BigInteger a) { return BigInteger.ModPow(Mod(a), P - 2, P); }
    struct Point { public BigInteger X, Y; }
    static Point Add(Point a, Point b) {
      var xx = Mod(a.X * b.X); var yy = Mod(a.Y * b.Y); var k = Mod(D * xx * yy);
      var x = Mod((a.X * b.Y + b.X * a.Y) * Inverse(1 + k));
      var y = Mod((yy + xx) * Inverse(1 - k));
      return new Point { X = x, Y = y };
    }
    static Point Multiply(BigInteger scalar, Point point) {
      var result = new Point { X = BigInteger.Zero, Y = BigInteger.One };
      while (scalar.Sign > 0) {
        if (!scalar.IsEven) result = Add(result, point);
        point = Add(point, point); scalar >>= 1;
      }
      return result;
    }
    static byte[] Encode(Point p) {
      var y = p.Y.ToByteArray(true, false);
      var bytes = new byte[32]; Array.Copy(y, bytes, y.Length);
      if (!p.X.IsEven) bytes[31] |= 0x80;
      return bytes;
    }
    static BigInteger Little(byte[] bytes) { return new BigInteger(bytes, true, false); }
    static byte[] Little(BigInteger value, int size) {
      var raw = value.ToByteArray(true, false); var bytes = new byte[size]; Array.Copy(raw, bytes, Math.Min(raw.Length, size)); return bytes;
    }
    static BigInteger Scalar(byte[] hash) {
      var a = new byte[32]; Array.Copy(hash, a, 32);
      a[0] &= 248; a[31] &= 63; a[31] |= 64;
      return Little(a);
    }
    public static byte[] PublicKey(byte[] seed) {
      if (seed == null || seed.Length != 32) throw new ArgumentException("seed");
      var hash = SHA512.HashData(seed);
      try { return Encode(Multiply(Scalar(hash), new Point { X = Bx, Y = By })); }
      finally { Array.Clear(hash, 0, hash.Length); }
    }
    public static byte[] Sign(byte[] seed, byte[] message) {
      if (seed == null || seed.Length != 32) throw new ArgumentException("seed");
      var hash = SHA512.HashData(seed);
      try {
        var a = Scalar(hash);
        var prefix = new byte[32]; Array.Copy(hash, 32, prefix, 0, 32);
        var basePoint = new Point { X = Bx, Y = By };
        var publicKey = Encode(Multiply(a, basePoint));
        var r = Little(SHA512.HashData(Concat(prefix, message))) % Q;
        var encodedR = Encode(Multiply(r, basePoint));
        var k = Little(SHA512.HashData(Concat(encodedR, publicKey, message))) % Q;
        var s = (r + k * a) % Q;
        Array.Clear(prefix, 0, prefix.Length);
        return Concat(encodedR, Little(s, 32));
      } finally { Array.Clear(hash, 0, hash.Length); }
    }
    static byte[] Concat(params byte[][] parts) {
      var size = 0; foreach (var part in parts) size += part.Length;
      var result = new byte[size]; var at = 0;
      foreach (var part in parts) { Array.Copy(part, 0, result, at, part.Length); at += part.Length; }
      return result;
    }
  }
}
