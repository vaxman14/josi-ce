using System;
namespace Josi.Native {
  // JosiApi's one reference outside the platform-neutral files.
  static class AppLinks { public static bool Testing { get { return true; } } public static string Instance { get { return ""; } } }
  public static class LocalServer { public static string ReadSetupToken(int port) { throw new NotSupportedException(); } }
}
