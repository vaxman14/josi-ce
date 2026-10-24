using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Josi.Native {
  /// The Josi CE Windows server installed by the existing native installer:
  /// six least-privilege services listening on localhost. This app observes and
  /// starts/stops them with Windows UAC; it never weakens their security.
  public sealed class ServerReceipt {
    public bool Installed;
    public bool Running;
    public bool Stopped;
    /// A development server run from source under this user (no services).
    public bool Development;
    public string Version = "";
    public string Address = "http://localhost:8080";
    public string Detail = "";
  }

  public static class LocalServer {
    public const string InstallerAppId = "{2DEB2167-EEA2-4A06-A5B0-45D5198EA8C1}_is1";
    static readonly string[] Services = { "JosiDatabase", "JosiWeb", "JosiWorker", "JosiVoice", "JosiVoiceControl", "JosiProxy" };
    static string InstalledRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Josi CE Server"); } }
    /// JOSI_SERVER_DATA points at a development server's data folder
    /// (scripts/windows/dev). Installed servers always use ProgramData.
    static string DevelopmentRoot {
      get {
        var value = Environment.GetEnvironmentVariable("JOSI_SERVER_DATA");
        if (string.IsNullOrEmpty(value) || !Path.IsPathRooted(value) || !File.Exists(Path.Combine(value, @"config\runtime.json"))) return null;
        return Path.GetFullPath(value);
      }
    }
    static string DataRoot { get { return DevelopmentRoot ?? InstalledRoot; } }

    public static ServerReceipt Read() {
      var receipt = new ServerReceipt();
      ServiceController[] all;
      try { all = ServiceController.GetServices(); } catch (Win32Exception) { receipt.Detail = "Windows service status is unavailable."; return receipt; }
      try {
        var installed = all.Where(s => Services.Contains(s.ServiceName)).ToList();
        receipt.Installed = installed.Any(s => s.ServiceName == "JosiWeb");
        if (!receipt.Installed && DevelopmentRoot != null) return ReadDevelopment(receipt);
        if (receipt.Installed) {
          var stopped = installed.Where(s => s.ServiceName != "JosiVoice" && s.ServiceName != "JosiVoiceControl" && s.Status != ServiceControllerStatus.Running).ToList();
          receipt.Running = stopped.Count == 0;
          receipt.Stopped = installed.All(s => s.Status == ServiceControllerStatus.Stopped);
          receipt.Detail = receipt.Running ? "Running" : receipt.Stopped ? "Stopped" : "Partly running: " + string.Join(", ", stopped.Select(s => Label(s.ServiceName)));
        }
      } finally { foreach (var s in all) s.Dispose(); }
      receipt.Version = InstalledVersion();
      var port = PublicPort();
      if (port > 0) receipt.Address = "http://localhost:" + port;
      return receipt;
    }
    static ServerReceipt ReadDevelopment(ServerReceipt receipt) {
      var settings = Wires.Parse(File.ReadAllText(Path.Combine(DevelopmentRoot, @"config\runtime.json")));
      receipt.Installed = true; receipt.Development = true;
      receipt.Version = settings["version"].Text;
      var port = PublicPort();
      receipt.Address = "http://localhost:" + port;
      try {
        using (var client = new System.Net.Sockets.TcpClient()) {
          receipt.Running = client.ConnectAsync("127.0.0.1", port).Wait(500) && client.Connected;
        }
      } catch (Exception) { receipt.Running = false; }
      receipt.Stopped = !receipt.Running;
      receipt.Detail = "Development server · " + (receipt.Running ? "Running" : "Stopped");
      return receipt;
    }
    static string Label(string service) {
      switch (service) {
        case "JosiDatabase": return "database"; case "JosiWeb": return "web service"; case "JosiWorker": return "background work";
        case "JosiProxy": return "web access"; default: return "speech";
      }
    }
    static string InstalledVersion() {
      foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
        try {
          using (var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
          using (var key = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\" + InstallerAppId)) {
            if (key == null) continue;
            var value = key.GetValue("DisplayVersion") as string;
            if (!string.IsNullOrEmpty(value) && value.Length < 64) return value;
          }
        } catch (System.Security.SecurityException) { } catch (UnauthorizedAccessException) { }
      }
      return "";
    }
    /// runtime.json is service-protected; when the interactive user cannot read
    /// it the installer's fixed public port applies.
    static int PublicPort() {
      try {
        var file = new FileInfo(Path.Combine(DataRoot, @"config\runtime.json"));
        if (!file.Exists || file.Length > 8192) return 8080;
        var value = Wires.Parse(File.ReadAllText(file.FullName));
        Uri url;
        if (Uri.TryCreate(value["publicUrl"].Text, UriKind.Absolute, out url) && url.Host == "localhost" && url.Port >= 1024) return url.Port;
      } catch (IOException) { } catch (UnauthorizedAccessException) { }
      return 8080;
    }

    /// Preferred handoff: first-run\bootstrap.json {schemaVersion, port, token},
    /// readable only by the person who installed the server. Older installs
    /// wrote the token into a private "Open Josi.html" redirect instead.
    public static string ReadSetupToken(int port) {
      var bootstrap = Path.Combine(DataRoot, @"first-run\bootstrap.json");
      if (File.Exists(bootstrap)) {
        try {
          var info = new FileInfo(bootstrap);
          if (info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
          var value = Wires.Parse(File.ReadAllText(bootstrap));
          if (value["schemaVersion"].Integer != 1 || value["port"].Integer != port || !Regex.IsMatch(value["token"].Text, "^[a-f0-9]{64}$"))
            throw new JosiException("The setup handoff does not match this server.");
          return value["token"].Text;
        } catch (UnauthorizedAccessException) {
          throw new JosiException("The first-run setup file for this PC is unavailable. Sign in to Windows as the person who installed Josi.");
        } catch (InvalidDataException) {
          throw new JosiException("The first-run setup file could not be read safely.");
        }
      }
      var path = Path.Combine(DataRoot, @"first-run\Open Josi.html");
      string document;
      try {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new FileNotFoundException();
        document = File.ReadAllText(path);
      } catch (Exception e) {
        if (e is IOException || e is UnauthorizedAccessException)
          throw new JosiException("The first-run setup document for this PC is unavailable. Sign in to Windows as the person who installed Josi, or use Repair.");
        throw;
      }
      var match = Regex.Match(document, @"http://localhost:" + port + @"/setup#setup=([a-f0-9]{64})");
      if (!match.Success) throw new JosiException("The setup handoff does not match this server.");
      return match.Groups[1].Value;
    }

    /// start/stop/restart run one fixed elevated command. Windows shows its own
    /// UAC prompt; Josi never stores or bypasses administrator approval.
    public static async Task Operate(string operation) {
      if (operation == "start") await Task.Run(() => RefuseOwnedPorts());
      await OperateElevated(operation);
    }
    /// Starting the installed services while another Josi owns the ports (on
    /// a developer's PC, the development server) knocks that one off its ports
    /// and leaves two half-servers. Say who owns them instead, before UAC asks.
    static void RefuseOwnedPorts() {
      ServiceController[] all;
      try { all = ServiceController.GetServices(); } catch (Win32Exception) { return; }
      if (all.Any(s => Services.Contains(s.ServiceName) && s.Status == ServiceControllerStatus.Running)) return;
      var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
      var probe = "Get-NetTCPConnection -State Listen -LocalPort 8080,15432 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; '{0} {1} {2}' -f $_.LocalPort, $p.ProcessName, $_.OwningProcess }";
      var info = new ProcessStartInfo(powershell, "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + probe + "\"") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
      var owners = new List<string>();
      try {
        using (var process = Process.Start(info)) {
          var output = process.StandardOutput.ReadToEnd(); process.WaitForExit(15000);
          foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) {
            var parts = line.Trim().Split(' ');
            if (parts.Length == 3) owners.Add("port " + parts[0] + " by " + parts[1] + " (process " + parts[2] + ")");
          }
        }
      } catch (Exception) { return; }
      if (owners.Count == 0) return;
      throw new JosiException("Josi's ports are already in use on this PC: " + string.Join(", ", owners.Distinct()) + ". Another Josi, most likely the development server, is running here. Stop it first (scripts\\windows\\dev\\Stop-DevServer.ps1), then start the installed server.");
    }
    static Task OperateElevated(string operation) {
      string script;
      var forward = string.Join(",", Services.Select(s => "'" + s + "'"));
      var reverse = string.Join(",", Enumerable.Reverse(Services).Select(s => "'" + s + "'"));
      switch (operation) {
        case "start": script = "$ErrorActionPreference='Stop';foreach($n in @(" + forward + ")){if(Get-Service -Name $n -ErrorAction SilentlyContinue){Start-Service -Name $n}}"; break;
        case "stop": script = "$ErrorActionPreference='Stop';foreach($n in @(" + reverse + ")){if(Get-Service -Name $n -ErrorAction SilentlyContinue){Stop-Service -Name $n -Force}}"; break;
        case "restart": script = "$ErrorActionPreference='Stop';foreach($n in @(" + reverse + ")){if(Get-Service -Name $n -ErrorAction SilentlyContinue){Stop-Service -Name $n -Force}};foreach($n in @(" + forward + ")){if(Get-Service -Name $n -ErrorAction SilentlyContinue){Start-Service -Name $n}}"; break;
        default: throw new JosiException("That server operation is not available here.");
      }
      var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
      return RunElevated(powershell, "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"" + script + "\"");
    }

    /// Runs a user-selected Josi CE installer. Inno Setup's own transaction,
    /// recovery copy and migration process applies.
    public static Task RunInstaller(string path) {
      var info = new FileInfo(path);
      if (!info.Exists || !info.Extension.Equals(".exe", StringComparison.OrdinalIgnoreCase)) throw new JosiException("Choose the Josi CE Windows installer (.exe).");
      return RunElevated(info.FullName, "");
    }

    static Task RunElevated(string file, string arguments) {
      return Task.Run(() => {
        var start = new ProcessStartInfo(file, arguments) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
        Process process;
        try { process = Process.Start(start); }
        catch (Win32Exception e) {
          if (e.NativeErrorCode == 1223) throw new JosiException("Windows administrator approval was cancelled. Nothing was changed.");
          throw new JosiException("Windows could not start that operation.");
        }
        using (process) {
          process.WaitForExit();
          if (process.ExitCode != 0)
            throw new JosiException("The server change did not finish. Refresh its status before trying again; recovery is available.");
        }
      });
    }
  }
}
