using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Josi.Windows {
  public sealed class OnboardingClient {
    public const string Address = "http://localhost:8080";
    readonly HttpClient client;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    public OnboardingClient(HttpClient client) { this.client = client; }
    public static string ReadBootstrap(string document) {
      if (document.Length > 4096) throw new InvalidDataException();
      var match = Regex.Match(document, @"http://localhost:8080/setup#setup=([a-f0-9]{64})");
      if (!match.Success) throw new InvalidDataException();
      return match.Groups[1].Value;
    }
    public async Task WaitReady(CancellationToken cancel, Func<Task> delay) {
      while (true) {
        cancel.ThrowIfCancellationRequested();
        try {
          using (var response = await client.GetAsync(Address + "/ready", cancel)) {
            if (response.StatusCode == HttpStatusCode.OK) return;
          }
        } catch (HttpRequestException) {} catch (TaskCanceledException) { cancel.ThrowIfCancellationRequested(); }
        await delay();
      }
    }
    public async Task<string> Target(Func<string> bootstrap, CancellationToken cancel) {
      using (var state = await client.GetAsync(Address + "/api/onboarding/state", cancel)) {
        if (!state.IsSuccessStatusCode) throw new InvalidOperationException();
        var body = json.Deserialize<Dictionary<string,object>>(await state.Content.ReadAsStringAsync());
        if (!body.ContainsKey("completed") || !(body["completed"] is bool)) throw new InvalidDataException();
        if ((bool)body["completed"]) return Address + "/";
      }
      string csrf;
      using (var response = await client.GetAsync(Address + "/api/auth/csrf", cancel)) {
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException();
        IEnumerable<string> cookies;
        if (!response.Headers.TryGetValues("Set-Cookie", out cookies)) throw new InvalidDataException();
        csrf = null;
        foreach (var cookie in cookies) {
          var match = Regex.Match(cookie, @"^josi_csrf=([^;]+)");
          if (match.Success) csrf = match.Groups[1].Value;
        }
        if (csrf == null) throw new InvalidDataException();
      }
      using (var request = new HttpRequestMessage(HttpMethod.Post, Address + "/api/onboarding/launch")) {
        request.Headers.Add("x-josi-csrf", Uri.UnescapeDataString(csrf));
        request.Headers.Add("x-josi-setup-token", ReadBootstrap(bootstrap()));
        request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        using (var response = await client.SendAsync(request, cancel)) {
          if (!response.IsSuccessStatusCode) throw new InvalidOperationException();
          var body = json.Deserialize<Dictionary<string,object>>(await response.Content.ReadAsStringAsync());
          var token = body.ContainsKey("token") ? body["token"] as string : null;
          if (token == null || !Regex.IsMatch(token, @"\A[a-f0-9]{64}\z")) throw new InvalidDataException();
          return Address + "/setup#handoff=" + token;
        }
      }
    }
    public static bool TryBrowser(Func<bool> launch) { try { return launch(); } catch { return false; } }
  }

  internal static class Browser {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct ExecuteInfo {
      public int cbSize; public uint fMask; public IntPtr hwnd;
      public string lpVerb, lpFile, lpParameters, lpDirectory;
      public int nShow; public IntPtr hInstApp, lpIDList;
      public string lpClass; public IntPtr hkeyClass; public uint dwHotKey;
      public IntPtr hIcon, hProcess;
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ShellExecuteEx(ref ExecuteInfo info);
    public static bool Open(string file, bool privateDocument) {
      string association = null;
      if (privateDocument) {
        // Resolve the user's HTTP choice, not the possibly unrelated .html
        // editor. Pass only a private file path to that handler, never a token.
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"))
          association = key == null ? "http" : key.GetValue("ProgId") as string;
        if (association == null || !Regex.IsMatch(association, @"\A[A-Za-z0-9._-]{1,160}\z")) return false;
      }
      var info = new ExecuteInfo {cbSize=Marshal.SizeOf(typeof(ExecuteInfo)), fMask=0x100 | 0x400 | (privateDocument ? 1u : 0u),
        lpVerb="open", lpFile=file, lpClass=association, nShow=1};
      return ShellExecuteEx(ref info);
    }
  }

  internal sealed class LauncherWindow : Form {
    readonly Label message = new Label {AutoSize=false, Dock=DockStyle.Top, Height=85};
    readonly TextBox link = new TextBox {ReadOnly=true, Dock=DockStyle.Top, Visible=false};
    readonly Button retry = new Button {Text="Retry", Dock=DockStyle.Bottom, Height=35, Enabled=false};
    readonly Button copy = new Button {Text="Copy private setup URL", Dock=DockStyle.Bottom, Height=35, Visible=false};
    string privateFolder;
    readonly Func<CancellationToken,Task<string>> resolveTarget;
    readonly Func<string,bool,bool> openBrowser;
    readonly System.Windows.Forms.Timer cleanup = new System.Windows.Forms.Timer {Interval=600000};
    public LauncherWindow(Func<CancellationToken,Task<string>> resolveTarget=null, Func<string,bool,bool> openBrowser=null) {
      this.resolveTarget=resolveTarget ?? ResolveTarget;
      this.openBrowser=openBrowser ?? Browser.Open;
      Text="Josi"; ClientSize=new Size(610,205); Padding=new Padding(15);
      StartPosition=FormStartPosition.CenterScreen; MaximizeBox=false; FormBorderStyle=FormBorderStyle.FixedDialog;
      Controls.Add(link); Controls.Add(message); Controls.Add(copy); Controls.Add(retry);
      retry.Click += async (_s,_e) => await StartHandoff();
      copy.Click += (_s,_e) => { try { Clipboard.SetText(link.Text); } catch { message.Text="Select the private URL and copy it, then paste it into your browser."; } };
      cleanup.Tick += (_s,_e) => { DeleteOwnDocument(); Close(); };
      Shown += async (_s,_e) => await StartHandoff();
      FormClosed += (_s,_e) => DeleteOwnDocument();
    }
    void DeleteOwnDocument() {
      if (privateFolder == null) return;
      try { File.Delete(Path.Combine(privateFolder,"Open Josi.html")); Directory.Delete(privateFolder,false); } catch {}
      privateFolder=null;
    }
    internal string CopyableUrl {get{return link.Text;}}
    internal bool CanRetry {get{return retry.Enabled;}}
    internal string PrivateFolder {get{return privateFolder;}}
    internal void RemovePrivateDocument() {cleanup.Stop();DeleteOwnDocument();}
    string Bootstrap() {
      var path=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Josi CE Server\first-run\Open Josi.html");
      var info=new FileInfo(path);
      if (info.Length>4096 || (info.Attributes & FileAttributes.ReparsePoint)!=0) throw new InvalidDataException();
      return File.ReadAllText(path);
    }
    string PrivateDocument(string target) {
      DeleteOwnDocument();
      var acl=new DirectorySecurity(); acl.SetAccessRuleProtection(true,false);
      var sid=WindowsIdentity.GetCurrent().User; acl.SetOwner(sid);
      foreach (var identity in new[] {sid,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")})
        acl.AddAccessRule(new FileSystemAccessRule(identity,FileSystemRights.FullControl,
          InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      privateFolder=Path.Combine(Path.GetTempPath(),"Josi-handoff-"+Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(privateFolder,acl);
      var path=Path.Combine(privateFolder,"Open Josi.html");
      using (var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
        var html="<!doctype html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><title>Josi</title><script>location.replace("+
          new JavaScriptSerializer().Serialize(target)+")</script>Opening Josi...";
        var bytes=Encoding.UTF8.GetBytes(html); stream.Write(bytes,0,bytes.Length);
      }
      return path;
    }
    async Task<string> ResolveTarget(CancellationToken cancel) {
      using (var handler=new HttpClientHandler {AllowAutoRedirect=false,UseProxy=false,CookieContainer=new CookieContainer()})
      using (var http=new HttpClient(handler) {Timeout=TimeSpan.FromSeconds(5)}) {
        var onboarding=new OnboardingClient(http);
        await onboarding.WaitReady(cancel,()=>Task.Delay(500,cancel));
        return await onboarding.Target(Bootstrap,cancel);
      }
    }
    internal async Task StartHandoff() {
      retry.Enabled=false; copy.Visible=false; link.Visible=false; link.Text="";
      message.Text="Installation complete. Waiting for Josi to be ready, then opening your browser…";
      try {
        using (var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(180))) {
          var target=await resolveTarget(cancel.Token);
          var isPrivate=target.Contains("#handoff=");
          var argument=isPrivate ? PrivateDocument(target) : target;
          if (OnboardingClient.TryBrowser(()=>openBrowser(argument,isPrivate))) {
            message.Text="Installation complete. Finish setting up Josi in your browser.";
            if (isPrivate) {Hide(); cleanup.Start();} else Close();
            return;
          }
          link.Text=target; link.Visible=true; copy.Visible=true;
          message.Text="Your browser could not open. Copy this private setup URL into your browser, or click Retry. The link expires in ten minutes and works once. Keep it private.";
        }
      } catch {
        message.Text="Josi setup could not be opened safely. Click Retry when Josi is available. Your saved setup and existing data have been preserved.";
      }
      retry.Enabled=true;
    }
  }

  internal static class Program {
    [STAThread] static void Main() {
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) {
        MessageBox.Show("Open Josi from your normal Windows account. The browser setup does not require administrator access.","Josi"); return;
      }
      Application.Run(new LauncherWindow());
    }
  }
}
