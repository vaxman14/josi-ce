using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Josi.Native {
  /// The computer's administrator agreeing that this PC is a node of one Josi
  /// account (docs/WINDOWS_CLIENT_NODE_SPEC.md). Josi starts itself elevated,
  /// Windows asks in its own prompt, and the elevated copy writes one record
  /// under HKEY_LOCAL_MACHINE, which only an administrator can write. Nothing
  /// secret is passed or stored: the server's address, the account's id and
  /// the fingerprint of this PC's public key. The person is proven separately,
  /// by their sign-in or password.
  static class NodeApproval {
    const string Root = @"SOFTWARE\Josi\Nodes";
    public static bool IsLaunch(string[] args) { return args.Length == 2 && args[0] == "--node-approve"; }
    static string Name(string origin, string owner) { return ProtectedWire.Digest(origin + "\n" + owner + "\n" + JosiApi.DeviceId); }
    static string Print(string point) { return ProtectedWire.Digest(point); }

    /// Whether an administrator of this computer already approved this key for this server and account.
    public static bool Recorded(string origin, string owner, string point) {
      try {
        using (var key = Registry.LocalMachine.OpenSubKey(Root + @"\" + Name(origin, owner)))
          return key != null && (key.GetValue("Key") as string) == Print(point) && (key.GetValue("Server") as string) == origin && (key.GetValue("User") as string) == owner;
      } catch (Exception) { return false; }
    }

    /// Asks Windows for elevation and waits for the record. False when the
    /// prompt was declined or nothing was written.
    public static async Task<bool> Request(string origin, string owner, string point) {
      // Automated tests and the demo never raise a Windows prompt.
      if (AppLinks.Testing || Automation.Demo) return true;
      var request = Convert.ToBase64String(Encoding.UTF8.GetBytes(Wires.Serialize(Wires.O("name", Name(origin, owner), "server", origin, "user", owner, "key", Print(point)))));
      try {
        using (var helper = await Task.Run(() => Process.Start(new ProcessStartInfo(Environment.ProcessPath) {
          UseShellExecute = true, Verb = "runas", Arguments = "--node-approve " + request, WindowStyle = ProcessWindowStyle.Hidden
        }))) {
          if (helper == null) return false;
          await helper.WaitForExitAsync();
        }
      } catch (Win32Exception) { return false; }  // Declined in the Windows prompt.
      return Recorded(origin, owner, point);
    }

    /// The elevated copy: checks what it was given, writes the record, exits.
    public static int Run(string[] args) {
      if (!PcAdministrator.Elevated) return 2;
      try {
        if (args[1].Length > 2048) return 2;
        var request = Wires.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(args[1])));
        string name = request["name"].Text, server = request["server"].Text, user = request["user"].Text, print = request["key"].Text;
        Uri address;
        if (!Regex.IsMatch(name, "^[0-9a-f]{64}$") || !Regex.IsMatch(print, "^[0-9a-f]{64}$") || !Wires.IsUuid(user)
            || !Uri.TryCreate(server, UriKind.Absolute, out address) || (address.Scheme != "https" && address.Scheme != "http") || server.Length > 300) return 2;
        using (var key = Registry.LocalMachine.CreateSubKey(Root + @"\" + name)) {
          key.SetValue("Server", server); key.SetValue("User", user); key.SetValue("Key", print);
          key.SetValue("ApprovedAt", DateTime.UtcNow.ToString("o")); key.SetValue("ApprovedBy", Environment.UserName);
        }
        return 0;
      } catch (Exception) { return 1; }
    }
  }
}
