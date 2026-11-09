using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Josi.Native {
  /// Persistent ConPTY sessions. Each shell enters a non-breakaway, kill-on-close
  /// job during CreateProcess, before any of its code can run. Pipes never touch
  /// the foreground console or keyboard. This is process ownership, not a sandbox.
  static class PcTerminals {
    static readonly object gate = new object();
    static readonly Dictionary<string, Terminal> sessions = new Dictionary<string, Terminal>();
    public static event Action Changed;
    public static int Count { get { lock (gate) return sessions.Values.Count(s => !s.Closed); } }
    public static List<Dictionary<string,object>> Snapshot() {
      lock (gate) return sessions.Select(pair=>pair.Value.Read(pair.Key,0,true)).ToList();
    }
    public static void Close(string id) {
      Terminal terminal;lock(gate){if(!sessions.Remove(id,out terminal))return;}
      terminal.Dispose();Changed?.Invoke();
    }
    public static void StopAll() {
      Terminal[] copy; lock (gate) { copy = sessions.Values.ToArray(); sessions.Clear(); }
      foreach (var terminal in copy) terminal.Dispose();
      Changed?.Invoke();
    }
    public static Tuple<bool, object> Execute(string requestId, Wire payload, Wire scope) {
      var kind = payload["kind"].Text;
      var id = kind == "desktop.terminal.open" ? requestId : payload["sessionId"].Text;
      if (scope["kind"].Text != "command") throw new InvalidOperationException("Terminal scope is missing.");
      Terminal terminal;
      lock (gate) {
        if (kind == "desktop.terminal.open") {
          if (sessions.Count >= 8) throw new InvalidOperationException("Close a terminal before opening another.");
          var shell = PcWork.ShellPath(payload["shell"].Text);
          if (shell == null || !File.Exists(shell) || !string.Equals(shell, scope["application"].Text, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The shell changed.");
          var cwd = payload["cwd"].Text;
          if (!Directory.Exists(cwd) || !PcWork.Within(cwd, scope["target"].Text)) throw new InvalidOperationException("The starting folder changed.");
          var duration = Math.Clamp((int)payload["timeoutSeconds"].Integer, 30, 28800);
          terminal = new Terminal(shell, payload["shell"].Text == "cmd" ? "/d /q" : "-NoLogo -NoProfile -NoExit", cwd, scope, duration);
          sessions.Add(id, terminal);
        } else {
          if (!sessions.TryGetValue(id, out terminal)) throw new InvalidOperationException("Terminal session has ended.");
          if (terminal.Scope["target"].Text != scope["target"].Text || terminal.Scope["application"].Text != scope["application"].Text) throw new InvalidOperationException("Terminal scope changed.");
          if (kind == "desktop.terminal.close") sessions.Remove(id);
        }
      }
      if (kind == "desktop.terminal.input") terminal.Write(payload["text"].Text);
      else if (kind == "desktop.terminal.close") terminal.Dispose();
      else if (kind != "desktop.terminal.read" && kind != "desktop.terminal.open") throw new InvalidOperationException("Unknown terminal operation.");
      Changed?.Invoke();
      return Tuple.Create(true, (object)terminal.Read(id, payload["cursor"].Integer));
    }
    public static async Task Watch(string id, Func<CancellationToken, Task<bool>> authorize, Func<bool> attached) {
      Terminal terminal; lock (gate) if (!sessions.TryGetValue(id, out terminal)) return;
      try {
        while (!terminal.Completed) {
          using (var deadline = new CancellationTokenSource(3000)) {
            if (!attached() || !await authorize(deadline.Token).WaitAsync(deadline.Token)) break;
          }
          if (terminal.Age.Elapsed.TotalSeconds >= terminal.Seconds) break;
          await Task.Delay(1500);
        }
      } catch (Exception e) when (e is JosiException || e is IOException || e is OperationCanceledException || e is System.Net.Http.HttpRequestException) { }
      finally {
        terminal.Dispose();
        Changed?.Invoke();
      }
    }
    sealed class Terminal : IDisposable {
      public readonly Wire Scope;
      public readonly Stopwatch Age = Stopwatch.StartNew();
      public readonly int Seconds;
      readonly object outputGate = new object();
      readonly StringBuilder output = new StringBuilder();
      readonly object inputGate = new object();
      FileStream input, reader;
      IntPtr pseudo, job, process;
      long start, end;
      int closed;
      int? exitCode;
      public bool Closed => Volatile.Read(ref closed) != 0;
      public bool Completed {
        get { var handle=process; if(handle!=IntPtr.Zero&&GetExitCodeProcess(handle,out var exit)&&exit!=259){exitCode=(int)exit;return true;}return Closed; }
      }
      public Terminal(string shell, string arguments, string cwd, Wire scope, int seconds) {
        Scope = scope; Seconds = seconds;
        if (new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)) throw new InvalidOperationException("Normal terminals require an unelevated Josi app.");
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobValue = IntPtr.Zero;
        bool attributesReady = false;
        try {
          if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw new Win32Exception();
          var hr = CreatePseudoConsole(new Coord { X = 120, Y = 36 }, inRead, outWrite, 0, out pseudo);
          if (hr != 0) Marshal.ThrowExceptionForHR(hr);
          input = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write); inWrite = IntPtr.Zero;
          reader = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read); outRead = IntPtr.Zero;
          // Drain independently, including while ClosePseudoConsole emits its final frame.
          _ = Task.Run(Drain);
          job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception();
          var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
          if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception();
          IntPtr size = IntPtr.Zero;
          InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
          attributes = Marshal.AllocHGlobal(size);
          if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new Win32Exception();
          attributesReady = true;
          if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20016), pseudo, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
          jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
          if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
          // Explicit null standard handles make Windows attach the child to
          // ConPTY instead of inheriting a launcher's redirected pipes.
          // https://github.com/microsoft/terminal/discussions/15814
          var startup = new StartupEx { Info = new Startup { Size = Marshal.SizeOf<StartupEx>(), Flags = 0x100 }, Attributes = attributes };
          ProcessInfo info;
          if (!CreateProcess(shell, new StringBuilder("\"" + shell + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 0x80000, IntPtr.Zero, cwd, ref startup, out info)) throw new Win32Exception();
          process = info.Process; CloseHandle(info.Thread);
        } catch { Dispose(); throw; }
        finally {
          foreach (var handle in new[] { inRead, inWrite, outRead, outWrite }) if (handle != IntPtr.Zero) CloseHandle(handle);
          if (attributesReady) DeleteProcThreadAttributeList(attributes);
          if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
          if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
        }
      }
      void Drain() {
        try {
          using (var text = new StreamReader(reader, new UTF8Encoding(false, false), false, 4096)) {
            var buffer = new char[4096]; int length;
            while ((length = text.Read(buffer, 0, buffer.Length)) > 0) lock (outputGate) {
              output.Append(buffer, 0, length); end += length;
              if (output.Length > 262144) { var remove = output.Length - 262144; output.Remove(0, remove); start += remove; }
            }
          }
        } catch (IOException) { } catch (ObjectDisposedException) { }
      }
      public void Write(string text) {
        if (Closed || Age.Elapsed.TotalSeconds >= Seconds || text.Length == 0 || text.Length > 16384) throw new InvalidOperationException("Terminal input is unavailable.");
        lock (inputGate) {
          if (Closed) throw new InvalidOperationException("Terminal closed.");
          var bytes = Encoding.UTF8.GetBytes(text); input.Write(bytes, 0, bytes.Length); input.Flush();
        }
      }
      public Dictionary<string, object> Read(string id, long cursor, bool tail = false) {
        uint exit = 259; var handle = process;
        if (handle != IntPtr.Zero) GetExitCodeProcess(handle, out exit);
        lock (outputGate) {
          var from = tail ? Math.Max(start, end - 48000) : Math.Clamp(cursor, start, end); var count = (int)Math.Min(end - from, 48000);
          return Wires.O("kind", "desktop_terminal", "sessionId", id, "cursor", from + count, "output", output.ToString((int)(from - start), count),
            "truncated", cursor < start, "hasMore", from + count < end, "running", !Closed && exit == 259,
            "exitCode", exitCode.HasValue ? (object)exitCode.Value : exit == 259 ? null : (object)(int)exit, "scope", Scope.Raw, "untrustedContent", true);
        }
      }
      public void Dispose() {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        var ownedJob = Interlocked.Exchange(ref job, IntPtr.Zero);
        if (ownedJob != IntPtr.Zero) { TerminateJobObject(ownedJob, 1); CloseHandle(ownedJob); }
        var ownedProcess = Interlocked.Exchange(ref process, IntPtr.Zero);
        if (ownedProcess != IntPtr.Zero) CloseHandle(ownedProcess);
        // Do not hold the input lock: a full pipe must never block local Stop.
        var ownedPseudo = Interlocked.Exchange(ref pseudo, IntPtr.Zero);
        _ = Task.Run(() => { if (ownedPseudo != IntPtr.Zero) ClosePseudoConsole(ownedPseudo); input?.Dispose(); });
      }
    }
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Startup { public int Size; public IntPtr Reserved, Desktop, Title; public int X,Y,Width,Height,CharsX,CharsY,Fill,Flags; public short Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error; }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public int ProcessId,ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr security,int size);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,uint flags,out IntPtr pseudo);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr pseudo);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,int size);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint exit);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  }
}
