using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Josi.Native {
  /// Remembered sign-ins. The server's native session for one server is kept in
  /// Windows Credential Manager for this Windows account on this PC (encrypted
  /// by Windows, never roamed), so Josi opens signed in after a restart or an
  /// update. The password itself is never stored. Signing out removes it, and
  /// the server can end the session at any time.
  static class SessionStore {
    public sealed class Saved { public string Identifier, Token; }

    static string Target(string origin) {
      // Automated UI tests use their own entries, never a person's sign-in.
      var test = Environment.GetEnvironmentVariable("JOSI_TEST_INSTANCE");
      return "Josi/session/" + origin + (string.IsNullOrEmpty(test) ? "" : "/test/" + test);
    }

    public static void Save(string origin, string identifier, string token) {
      var secret = Encoding.UTF8.GetBytes(token);
      var blob = Marshal.AllocHGlobal(secret.Length);
      try {
        Marshal.Copy(secret, 0, blob, secret.Length);
        var credential = new Credential {
          Type = 1, TargetName = Target(origin), UserName = identifier ?? "", Persist = 2,  // GENERIC, LOCAL_MACHINE
          CredentialBlobSize = secret.Length, CredentialBlob = blob,
        };
        if (!CredWrite(ref credential, 0)) throw new JosiException("Windows could not remember this sign-in: " + new Win32Exception().Message);
      } finally {
        for (var i = 0; i < secret.Length; i++) Marshal.WriteByte(blob, i, 0);
        Marshal.FreeHGlobal(blob);
        Array.Clear(secret, 0, secret.Length);
      }
    }

    public static Saved Load(string origin) {
      IntPtr found;
      if (!CredRead(Target(origin), 1, 0, out found)) return null;
      try {
        var credential = (Credential)Marshal.PtrToStructure(found, typeof(Credential));
        if (credential.CredentialBlobSize <= 0 || credential.CredentialBlobSize > 1024) return null;
        var secret = new byte[credential.CredentialBlobSize];
        Marshal.Copy(credential.CredentialBlob, secret, 0, secret.Length);
        try { return new Saved { Identifier = credential.UserName ?? "", Token = Encoding.UTF8.GetString(secret) }; }
        finally { Array.Clear(secret, 0, secret.Length); }
      } finally { CredFree(found); }
    }

    public static void Forget(string origin) { CredDelete(Target(origin), 1, 0); }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Credential {
      public int Flags, Type;
      public string TargetName, Comment;
      public long LastWritten;
      public int CredentialBlobSize;
      public IntPtr CredentialBlob;
      public int Persist, AttributeCount;
      public IntPtr Attributes;
      public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWrite(ref Credential credential, int flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDelete(string target, int type, int flags);
    [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  }
}
