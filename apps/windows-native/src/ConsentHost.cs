using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Windows.Foundation;
using Windows.Security.Credentials;
using Windows.Security.Credentials.UI;

namespace Josi.Native {
  /// Item 29: the device-consent window on the computer that runs the server.
  /// The server starts `Josi.exe --device-consent`, writes one framed request
  /// on stdin (the exact enrollment, as the message the server signs over),
  /// and reads "ready" and then "approved" frames on stdout. The window shows
  /// the request word for word and approves it only after Windows Hello.
  /// Nothing else of Josi runs in this mode: no data folder, no sign-in.
  public static class ConsentHost {
    public static bool IsLaunch(string[] args) { return args.Length == 1 && args[0] == "--device-consent"; }
    const string Prefix = "josi-device-consent.1\n";

    static byte[] ReadFrame(Stream input) {
      var header = Exactly(input, 4); if (header == null) return null;
      var size = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
      if (size <= 0 || size > 96 * 1024) return null;
      return Exactly(input, size);
    }
    static byte[] Exactly(Stream input, int count) {
      var bytes = new byte[count]; var at = 0;
      while (at < count) { var read = input.Read(bytes, at, count - at); if (read <= 0) return null; at += read; }
      return bytes;
    }
    static void WriteFrame(Stream output, string id, string digest, string state) {
      var body = Encoding.UTF8.GetBytes("{\"schemaVersion\":1,\"id\":" + JsonSerializer.Serialize(id) + ",\"challengeDigest\":" + JsonSerializer.Serialize(digest) + ",\"state\":\"" + state + "\"}");
      var header = new[] { (byte)(body.Length >> 24), (byte)(body.Length >> 16), (byte)(body.Length >> 8), (byte)body.Length };
      output.Write(header, 0, 4); output.Write(body, 0, body.Length); output.Flush();
    }

    [STAThread]
    public static int Run() {
      var input = Console.OpenStandardInput(); var output = Console.OpenStandardOutput();
      var frame = ReadFrame(input); if (frame == null) return 2;
      string id, digest; long expires; string message;
      try {
        using (var doc = JsonDocument.Parse(frame)) {
          var root = doc.RootElement;
          if (root.GetProperty("schemaVersion").GetInt32() != 1) return 2;
          id = root.GetProperty("id").GetString(); digest = root.GetProperty("challengeDigest").GetString();
          expires = root.GetProperty("expiresAtMs").GetInt64();
          message = Encoding.UTF8.GetString(Convert.FromBase64String(root.GetProperty("message").GetString()));
        }
      } catch (Exception) { return 2; }
      if (!Wires.IsUuid(id) || digest == null || digest.Length != 64 || !message.StartsWith(Prefix)
          || Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(message))).ToLowerInvariant() != digest) return 2;
      JsonElement fields;
      try { fields = JsonDocument.Parse(message.Substring(Prefix.Length)).RootElement.Clone(); } catch (Exception) { return 2; }
      if (fields.ValueKind != JsonValueKind.Array || fields.GetArrayLength() != 13 || fields[1].GetString() != id) return 2;
      var origin = fields[3].GetString(); var serverId = fields[4].GetString(); var user = fields[5].GetString(); var device = fields[6].GetString();
      var presentation = fields[12];
      var wording = presentation[0].GetString(); var meaning = presentation[1].GetString();
      var advisory = presentation[2].EnumerateArray().Select(a => a.GetString()).ToList();
      if (fields[11].GetInt64() != expires) return 2;
      // The server waits up to ten seconds for this: before any window work.
      WriteFrame(output, id, digest, "ready");

      var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
      Ui.Load(); app.Resources.MergedDictionaries.Add(Ui.Resources);
      var approved = false;
      var window = new Dialogs.Sheet(null, "Josi — Approve a device enrollment", 660);
      window.WindowStartupLocation = WindowStartupLocation.CenterScreen; window.ShowInTaskbar = true; window.Topmost = true;
      var status = Ui.Secondary(""); status.Visibility = Visibility.Collapsed;
      var clock = Ui.Caption("");
      var approve = Ui.Pill("Approve with Windows Hello", null, true);
      var cancel = Ui.Pill("Cancel", () => window.Close()); cancel.IsCancel = true;
      var actions = Ui.Row(8, cancel, approve);
      approve.Click += async delegate {
        approve.IsEnabled = false; cancel.IsEnabled = false; status.Visibility = Visibility.Visible; status.Text = "Windows Hello…";
        try {
          if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expires) throw new JosiException("This request expired.");
          var handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
          if (!await Verify(handle, "Approve the Josi device enrollment shown on this screen.")) throw new JosiException("Windows Hello did not verify you. Nothing was approved.");
          if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expires) throw new JosiException("This request expired.");
          WriteFrame(output, id, digest, "approved"); approved = true;
          status.Text = "Approved. The enrolling PC finishes the enrollment.";
          actions.Children.Clear(); actions.Children.Add(Ui.Pill("Close", () => window.Close(), true));
        } catch (Exception e) {
          status.Text = AppModel.Friendly(e); status.Foreground = Ui.Orange; approve.IsEnabled = true; cancel.IsEnabled = true;
        }
      };
      var items = new List<UIElement> {
        Ui.Row(10, Ui.JosiMark(28), Ui.T("A PC asks to be enrolled for protected approvals", 17, FontWeights.SemiBold)),
        Ui.Secondary("This window was opened by the Josi server on this computer. Approve only if you started this enrollment yourself, and the details match the enrolling PC's window."),
        Ui.Copyable("Server: " + origin + "\nServer ID: " + serverId + "\nAdministrator: " + user + "\nDevice: " + device, 13),
        Ui.T(wording, 15, FontWeights.SemiBold), Ui.Copyable(meaning, 13),
      };
      items.AddRange(advisory.Select(a => (UIElement)Ui.Caption(a)));
      items.Add(status); items.Add(Ui.Spread(clock, actions));
      window.Body(Ui.Stack(12, items.ToArray()));
      var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
      timer.Tick += delegate {
        var left = (expires - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) / 1000;
        if (left <= 0) { timer.Stop(); if (!approved) window.Close(); else clock.Text = ""; return; }
        clock.Text = "This request expires in " + left + " s";
      };
      timer.Start();
      window.Closed += delegate { timer.Stop(); app.Shutdown(); };
      window.Loaded += delegate { window.Activate(); window.Topmost = false; };
      // A server that gives up (closes the pipe) ends this window too.
      Task.Run(() => { try { input.ReadByte(); } catch (Exception) { } app.Dispatcher.BeginInvoke(new Action(() => { if (!approved) window.Close(); })); });
      window.Show();
      app.Run();
      return approved ? 0 : 1;
    }

    /// Windows Hello verification for a desktop window: the window-bound
    /// interop call first, the plain call when the interop is unavailable.
    public static async Task<bool> Verify(IntPtr window, string reason) {
      try {
        var result = await VerifyForWindow(window, reason);
        if (result.HasValue) return result.Value;
      } catch (Exception) { /* fall through to the plain call */ }
      try {
        var available = await UserConsentVerifier.CheckAvailabilityAsync();
        if (available != UserConsentVerifierAvailability.Available) throw new JosiException("Windows Hello is not set up on this computer (" + available + "). Set up a PIN, face or fingerprint in Windows Settings.");
        return await UserConsentVerifier.RequestVerificationAsync(reason) == UserConsentVerificationResult.Verified;
      } catch (JosiException) { throw; }
      catch (Exception) {
        // Last resort: a Windows Hello key operation is itself the gesture.
        var made = await KeyCredentialManager.RequestCreateAsync("Josi device consent", KeyCredentialCreationOption.ReplaceExisting);
        try { return made.Status == KeyCredentialStatus.Success; }
        finally { try { await KeyCredentialManager.DeleteAsync("Josi device consent"); } catch (Exception) { } }
      }
    }

    [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IUserConsentVerifierInterop {
      // IInspectable
      void GetIids(out int count, out IntPtr iids); void GetRuntimeClassName(out IntPtr name); void GetTrustLevel(out int level);
      IntPtr RequestVerificationForWindowAsync(IntPtr appWindow, IntPtr message, ref Guid riid);
    }
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string source, int length, out IntPtr hstring);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hstring);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, out IntPtr factory);
    static async Task<bool?> VerifyForWindow(IntPtr window, string reason) {
      if (window == IntPtr.Zero) return null;
      IntPtr className = IntPtr.Zero, factory = IntPtr.Zero, text = IntPtr.Zero;
      try {
        if (WindowsCreateString("Windows.Security.Credentials.UI.UserConsentVerifier", "Windows.Security.Credentials.UI.UserConsentVerifier".Length, out className) != 0) return null;
        var iid = typeof(IUserConsentVerifierInterop).GUID;
        if (RoGetActivationFactory(className, ref iid, out factory) != 0 || factory == IntPtr.Zero) return null;
        var interop = (IUserConsentVerifierInterop)Marshal.GetObjectForIUnknown(factory);
        if (WindowsCreateString(reason, reason.Length, out text) != 0) return null;
        var operationIid = WinRT.GuidGenerator.GetIID(typeof(IAsyncOperation<UserConsentVerificationResult>));
        var abi = interop.RequestVerificationForWindowAsync(window, text, ref operationIid);
        if (abi == IntPtr.Zero) return null;
        var operation = WinRT.MarshalInterface<IAsyncOperation<UserConsentVerificationResult>>.FromAbi(abi);
        return await operation == UserConsentVerificationResult.Verified;
      } finally {
        if (text != IntPtr.Zero) WindowsDeleteString(text);
        if (className != IntPtr.Zero) WindowsDeleteString(className);
        if (factory != IntPtr.Zero) Marshal.Release(factory);
      }
    }
  }
}
