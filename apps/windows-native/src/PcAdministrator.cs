using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Josi.Native {
  /// One exact elevated request per helper. The normal Josi app stays unelevated.
  /// UAC is always an OS interaction; no credentials or approval keys enter IPC.
  static class PcAdministrator {
    public static bool Elevated => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
    public static bool IsLaunch(string[] args) => args.Length == 4 && args[0] == "--pc-admin-broker";
    public static async Task<Tuple<bool,object>> Execute(Wire request, CancellationToken cancel) {
      if (Elevated) throw new InvalidOperationException("Run the main Josi app without administrator rights.");
      var serialized=Wires.Serialize(request); var digest=ProtectedWire.Digest(serialized);
      var name="josi-admin-"+Guid.NewGuid().ToString("N");
      using (var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly))
      using (var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancel)) {
        deadline.CancelAfter(TimeSpan.FromSeconds(90));
        using (var helper=await Task.Run(()=>Process.Start(new ProcessStartInfo(Environment.ProcessPath) {
          UseShellExecute=true,Verb="runas",Arguments="--pc-admin-broker "+name+" "+Environment.ProcessId+" "+digest,
          WindowStyle=ProcessWindowStyle.Hidden
        }),cancel)) {
          if(helper==null)throw new InvalidOperationException("Windows did not start the administrator helper.");
          await pipe.WaitForConnectionAsync(deadline.Token);
          uint client;
          if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out client)||client!=helper.Id)throw new InvalidOperationException("The administrator helper identity changed.");
          await Write(pipe,serialized,cancel);
          var result=await Read(pipe,cancel);
          var wire=Wires.Parse(result);
          return Tuple.Create(wire["ok"].Flag,wire["result"].Raw);
        }
      }
    }
    public static int Run(string[] args) {
      if(!Elevated||!args[1].StartsWith("josi-admin-",StringComparison.Ordinal)||args[1].Length!=43||!int.TryParse(args[2],out var parent)||args[3].Length!=64)return 2;
      try { return RunHelper(args[1],parent,args[3]).GetAwaiter().GetResult(); }
      catch { return 1; }
    }
    static async Task<int> RunHelper(string name,int parent,string digest) {
      using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification))
      using(var cancellation=new CancellationTokenSource(TimeSpan.FromMinutes(12))) {
        await pipe.ConnectAsync(30000,cancellation.Token);
        uint server;
        if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out server)||server!=parent)return 2;
        using(var owner=Process.GetProcessById(parent)) {
          var executable=owner.MainModule?.FileName;
          if(executable==null||!string.Equals(Path.GetFullPath(executable),Path.GetFullPath(Environment.ProcessPath),StringComparison.OrdinalIgnoreCase))return 2;
        }
        var serialized=await Read(pipe,cancellation.Token);
        if(ProtectedWire.Digest(serialized)!=digest)return 2;
        var request=Wires.Parse(serialized);var payload=request["payload"];
        if(payload["kind"].Text!="desktop.admin.command")return 2;
        Wire scope=null;var administrator=false;
        foreach(var required in request["requirements"].List){
          if(required["action"].Text=="command.run")scope=required["scope"];
          if(required["action"].Text=="administrator.elevate"&&required["scope"]["target"].Text=="host")administrator=true;
        }
        if(!administrator||scope==null)return 2;
        // Closing the parent's pipe (Stop, revoked lease, exit or connection
        // loss) cancels the elevated process tree without an elevated UI action.
        _=Task.Run(async()=>{try{var probe=new byte[1];await pipe.ReadAsync(probe,cancellation.Token);}catch{}finally{try{cancellation.Cancel();}catch(ObjectDisposedException){}}});
        var result=await Task.Run(()=>PcWork.Command(payload,scope,cancellation.Token));
        await Write(pipe,Wires.Serialize(Wires.O("ok",result.Item1,"result",result.Item2)),cancellation.Token);
        return 0;
      }
    }
    static async Task Write(Stream stream,string value,CancellationToken token){
      var bytes=Encoding.UTF8.GetBytes(value);if(bytes.Length>262144)throw new InvalidOperationException("The helper response is too large.");
      await stream.WriteAsync(BitConverter.GetBytes(bytes.Length),token);await stream.WriteAsync(bytes,token);await stream.FlushAsync(token);
    }
    static async Task<string> Read(Stream stream,CancellationToken token){
      var header=new byte[4];await stream.ReadExactlyAsync(header,token);var length=BitConverter.ToInt32(header);
      if(length<1||length>262144)throw new InvalidOperationException("Invalid helper response.");
      var body=new byte[length];await stream.ReadExactlyAsync(body,token);return Encoding.UTF8.GetString(body);
    }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint process);
  }
}
