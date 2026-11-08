using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

// Real WPF/executor regression probe. Uses only its own controls and a harmless
// background command; no server, account, service, global keyboard or mouse input.
static class Probe {
  static int failures;
  static Type executorType, overlayType;
  static object executor, overlay;
  static Assembly josi;
  static readonly BindingFlags Instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
  static object Invoke(object target, string method, params object[] values) => target.GetType().GetMethod(method, Instance).Invoke(target, values);
  static object Field(object target, string name) => target.GetType().GetField(name, Instance).GetValue(target);
  static bool State(string name) => (bool)executorType.GetProperty(name).GetValue(executor);
  static void Check(string name, bool ok) { Console.WriteLine((ok ? "PASS " : "FAIL ") + name); if (!ok) failures++; }
  static void Update() => Invoke(overlay, "Update", State("Busy") || State("Paused") || State("TakenOver"), State("Busy"), State("Paused"), State("TakenOver"), State("ScreenControl"), executorType.GetProperty("Activity").GetValue(executor));

  static async Task Run(string evidence) {
    josi = Assembly.LoadFrom(Path.Combine(AppContext.BaseDirectory, "Josi.dll"));
    executorType = josi.GetType("Josi.Native.DesktopExecutor");
    overlayType = josi.GetType("Josi.Native.PcControlOverlay");
    executor = executorType.GetField("Current").GetValue(null);
    var pauseFile = Path.Combine(evidence,"probe-pause-state.json");
    Invoke(executor, "Start", Dispatcher.CurrentDispatcher, pauseFile);
    Invoke(executor, "Resume");
    overlay = Activator.CreateInstance(overlayType, Instance, null, new object[] {
      (Action)(() => Invoke(executor,"TakeOver")), (Action)(() => Invoke(executor,"Pause")),
      (Action)(() => Invoke(executor,"Resume")), (Action)(() => Invoke(executor,"Pause")), (Action)(() => {})
    }, null);
    var update = (Action)Update;
    executorType.GetEvent("Changed").AddEventHandler(executor, update);
    try {
      Invoke(executor, "TakeOver");
      await Task.Delay(100);
      Check("human takeover blocks screen control", State("TakenOver") && State("Blocked"));
      Capture(evidence, "pc-control-takeover.png");
      await Task.Delay(TimeSpan.FromSeconds(21));
      Check("no automatic return after the former 20 second timeout", State("TakenOver") && State("Blocked"));
      ((Button)Field(overlay, "resumeButton")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
      await Task.Delay(50);
      Check("native Resume explicitly returns control", !State("TakenOver") && !State("Blocked"));

      Invoke(executor, "Pause");
      await Task.Delay(50);
      Capture(evidence, "pc-control-paused.png");
      Check("Pause keeps local executor blocked", State("Paused") && State("Blocked"));
      var restarted = Activator.CreateInstance(executorType,true);
      Invoke(restarted,"Start",Dispatcher.CurrentDispatcher,pauseFile);
      Check("a stopped executor stays paused across restart", (bool)executorType.GetProperty("Paused").GetValue(restarted));
      Invoke(executor, "Resume");
      var wire = josi.GetType("Josi.Native.Wires");
      var shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
      var request = wire.GetMethod("Parse").Invoke(null, new object[] { JsonSerializer.Serialize(new {
        id=Guid.NewGuid().ToString(), payload=new { kind="desktop.command",shell="powershell",cwd=Environment.CurrentDirectory,command="Start-Sleep -Seconds 30; Write-Output 'should be stopped'",timeoutSeconds=45 },
        requirements=new[] { new { action="command.run",scope=new { kind="command",target=Environment.CurrentDirectory,application=shell } } }
      }) });
      var running = (Task<Tuple<bool,object>>)Invoke(executor,"Run",request);
      await Task.Delay(500);
      Check("background command is visible without taking screen control", State("Busy") && !State("ScreenControl"));
      Invoke(executor,"TakeOver");
      await Task.Delay(150);
      Check("human takeover leaves permitted background work running", State("Busy") && !running.IsCompleted);
      var timer = Stopwatch.StartNew();
      Invoke(executor,"Pause"); // Same synchronous local action used by Stop, without a network.
      var ended = await Task.WhenAny(running, Task.Delay(6000));
      Check("local Stop cancels the running process without a server", ended == running && !(await running).Item1 && timer.ElapsedMilliseconds < 6000);
      var strip = (Window)Field(overlay,"strip");
      var handle = new WindowInteropHelper(strip).Handle;
      var protectedMethod = executorType.GetMethod("ProtectedWindow", BindingFlags.Static | BindingFlags.NonPublic);
      Check("Josi's own control window cannot be automated", (bool)protectedMethod.Invoke(null,new object[] { handle }));
      Check("overlay has no owner so minimizing Josi cannot hide it", strip.Owner == null && !strip.ShowInTaskbar);
      Invoke(overlay,"Update",true,true,false,false,true,"Running a command in the approved project");
      await Task.Delay(80);
      Capture(evidence,"pc-control-working.png");
      var frames = (System.Collections.ICollection)Field(overlay,"frames");
      Check("native monitor frames were created", frames.Count > 0);

      var lease = josi.GetType("Josi.Native.PcExecutionLease").GetMethod("Run");
      Invoke(executor,"Resume");
      int checks=0;
      var lost = (Task<Tuple<bool,object>>)lease.Invoke(null,new object[] {
        (Func<CancellationToken,Task<bool>>)(_ => Task.FromResult(++checks == 1)),
        (Func<bool>)(() => true),
        (Func<Task<Tuple<bool,object>>>)(() => (Task<Tuple<bool,object>>)Invoke(executor,"Run",request)),
        (Action)(() => Invoke(executor,"Pause"))
      });
      var leaseResult = await lost;
      Check("revoked server lease cancels a real running PowerShell process", !leaseResult.Item1 && checks==2 && !State("Busy") && State("Paused"));
      int starts=0;
      var unavailable = (Task<Tuple<bool,object>>)lease.Invoke(null,new object[] {
        (Func<CancellationToken,Task<bool>>)(async token => { await Task.Delay(60000,token); return true; }),
        (Func<bool>)(() => true),
        (Func<Task<Tuple<bool,object>>>)(() => { starts++; return Task.FromResult(Tuple.Create(true,(object)null)); }),
        (Action)(() => Invoke(executor,"Pause"))
      });
      timer.Restart();
      Check("unreachable server fails closed before execution", !(await unavailable).Item1 && starts==0 && timer.ElapsedMilliseconds<5000);
    } finally {
      executorType.GetEvent("Changed").RemoveEventHandler(executor,update);
      Invoke(executor,"Pause");
      ((IDisposable)overlay).Dispose();
      if (File.Exists(pauseFile)) File.Delete(pauseFile);
    }
  }

  static void Capture(string evidence, string name) {
    var strip = (Window)Field(overlay,"strip");
    strip.UpdateLayout();
    var target = (FrameworkElement)strip.Content;
    var bitmap = new RenderTargetBitmap((int)Math.Ceiling(target.ActualWidth), (int)Math.Ceiling(target.ActualHeight),96,96,PixelFormats.Pbgra32);
    bitmap.Render(target);
    var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
    using (var output = File.Create(Path.Combine(evidence,name))) encoder.Save(output);
    Check("rendered " + name, target.ActualWidth > 400 && target.ActualHeight > 80);
  }

  [STAThread] static int Main(string[] args) {
    if (args.Length != 1 || !Path.IsPathFullyQualified(args[0])) { Console.Error.WriteLine("Pass an absolute evidence folder inside the workspace."); return 2; }
    Directory.CreateDirectory(args[0]);
    var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
    app.Dispatcher.BeginInvoke(new Action(async () => {
      try { await Run(args[0]); } catch (Exception e) { failures++; Console.WriteLine(e); }
      finally { app.Shutdown(); }
    }));
    app.Run();
    Console.WriteLine(failures == 0 ? "ALL PASSED" : failures + " FAILED");
    return failures == 0 ? 0 : 1;
  }
}
