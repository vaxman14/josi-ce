using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.IO;
using System.Security.AccessControl;
using Josi.Windows;

internal sealed class FixtureHandler : HttpMessageHandler {
  public int ReadyCalls, LaunchCalls; public bool Completed, FailLaunch, Ready;
  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
    var path=request.RequestUri.AbsolutePath;
    if (request.RequestUri.Host!="localhost" || request.RequestUri.Port!=8080) throw new Exception("Unexpected destination");
    var response=new HttpResponseMessage(HttpStatusCode.OK);
    if (path=="/ready") {ReadyCalls++; response.StatusCode=(Ready || ReadyCalls>=3) ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable;}
    else if(path=="/api/onboarding/state") response.Content=new StringContent("{\"completed\":"+(Completed?"true":"false")+"}");
    else if(path=="/api/auth/csrf") response.Headers.Add("Set-Cookie","josi_csrf=fixture; Path=/");
    else if(path=="/api/onboarding/launch") {
      LaunchCalls++;
      if(!request.Headers.Contains("x-josi-csrf") || !request.Headers.Contains("x-josi-setup-token")) throw new Exception("Missing authorization");
      response.StatusCode=FailLaunch?HttpStatusCode.ServiceUnavailable:HttpStatusCode.OK;
      response.Content=new StringContent("{\"token\":\""+new string((char)('a'+LaunchCalls),64)+"\"}");
    } else throw new Exception("Unexpected route");
    return Task.FromResult(response);
  }
}
internal static class LauncherTests {
  static void Assert(bool value) {if(!value)throw new Exception("Launcher assertion failed");}
  static async Task Run() {
    var fixture=new FixtureHandler();
    using(var http=new HttpClient(fixture)) {
      var client=new OnboardingClient(http); var delays=0;
      await client.WaitReady(CancellationToken.None,()=>{delays++;return Task.FromResult(0);});
      Assert(fixture.ReadyCalls==3 && delays==2);
      var document="location.replace(\"http://localhost:8080/setup#setup="+new string('a',64)+"\")";
      var first=await client.Target(()=>document,CancellationToken.None);
      Assert(first=="http://localhost:8080/setup#handoff="+new string('b',64));
      var retry=await client.Target(()=>document,CancellationToken.None); Assert(first!=retry);
      Assert(!OnboardingClient.TryBrowser(()=>false));
      Assert(!OnboardingClient.TryBrowser(()=>{throw new Exception();}));
      Assert(OnboardingClient.TryBrowser(()=>true));
      fixture.Completed=true;
      Assert(await client.Target(()=>{throw new Exception("Must not read secrets after completion");},CancellationToken.None)=="http://localhost:8080/");
      fixture.Completed=false; fixture.FailLaunch=true;
      var failed=false;try{await client.Target(()=>document,CancellationToken.None);}catch(InvalidOperationException){failed=true;} Assert(failed);
      failed=false;try{OnboardingClient.ReadBootstrap("http://remote.invalid/setup#setup="+new string('a',64));}catch(System.IO.InvalidDataException){failed=true;} Assert(failed);
      using(var cancel=new CancellationTokenSource()) {
        cancel.Cancel(); failed=false;try{await client.WaitReady(cancel.Token,()=>Task.FromResult(0));}catch(OperationCanceledException){failed=true;}Assert(failed);
      }
    }
    var attempts=0; var launches=0;
    using(var form=new LauncherWindow(cancel=>Task.FromResult("http://localhost:8080/setup#handoff="+new string((char)('d'+ ++attempts),64)),
      (argument,isPrivate)=>{
        launches++;Assert(isPrivate && argument.EndsWith("Open Josi.html") && !argument.Contains("#handoff="));
        var acl=Directory.GetAccessControl(Path.GetDirectoryName(argument));Assert(acl.AreAccessRulesProtected);
        Assert(File.ReadAllText(argument).Contains("location.replace"));
        return launches>1;
      })) {
      try {
        await form.StartHandoff();Assert(form.CanRetry && form.CopyableUrl.EndsWith(new string('e',64)));
        var firstDirectory=form.PrivateFolder;
        await form.StartHandoff();Assert(!form.CanRetry && form.CopyableUrl=="" && attempts==2 && launches==2);
        Assert(!Directory.Exists(firstDirectory));
      }finally{var directory=form.PrivateFolder;form.RemovePrivateDocument();if(directory!=null)Assert(!Directory.Exists(directory));}
    }
  }
  [STAThread] public static int Main() {try{Run().GetAwaiter().GetResult();Console.WriteLine("Launcher tests passed: readiness, URL, retry, browser success/failure, completed upgrade, unavailable failure, cancellation, private origin, real fallback form, private document ACL and cleanup.");return 0;}catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}}
}
