using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Josi.Native {
  /// Hosts a vendor command-line program in a private Windows pseudo-console
  /// (ConPTY), for CLIs that only run interactively. The process starts
  /// suspended inside a kill-on-close Job Object, so it and anything it starts
  /// end when this object is disposed or the app exits. Output never reaches a
  /// visible console.
  public sealed class PseudoConsole : IDisposable {
    public event Action<string> Output;
    readonly IntPtr console, job;
    readonly SafeFileHandle process;
    readonly FileStream input;
    readonly TaskCompletionSource<int> exited = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
    int disposed;

    public Task<int> Exited { get { return exited.Task; } }

    PseudoConsole(IntPtr console, IntPtr job, SafeFileHandle process, FileStream input, FileStream output) {
      this.console = console; this.job = job; this.process = process; this.input = input;
      var reader = new Thread(() => Pump(output)) { IsBackground = true, Name = "pseudo-console output" };
      reader.Start();
      var waiter = new Thread(() => {
        WaitForSingleObject(process.DangerousGetHandle(), uint.MaxValue);
        uint code; GetExitCodeProcess(process.DangerousGetHandle(), out code);
        exited.TrySetResult((int)code);
      }) { IsBackground = true, Name = "pseudo-console exit" };
      waiter.Start();
    }

    void Pump(FileStream output) {
      var decoder = new UTF8Encoding(false).GetDecoder();
      var bytes = new byte[8192]; var chars = new char[8192];
      try {
        while (true) {
          var read = output.Read(bytes, 0, bytes.Length);
          if (read <= 0) break;
          var count = decoder.GetChars(bytes, 0, read, chars, 0);
          var handler = Output;
          if (handler != null && count > 0) handler(new string(chars, 0, count));
        }
      } catch (IOException) { } catch (ObjectDisposedException) { }
      finally { output.Dispose(); }
    }

    public void Write(string text) {
      if (Volatile.Read(ref disposed) != 0) return;
      var bytes = Encoding.UTF8.GetBytes(text);
      try { input.Write(bytes, 0, bytes.Length); input.Flush(); }
      catch (IOException) { } catch (ObjectDisposedException) { }
      finally { Array.Clear(bytes, 0, bytes.Length); }
    }

    public void Dispose() {
      if (Interlocked.Exchange(ref disposed, 1) != 0) return;
      TerminateJobObject(job, 1);
      ClosePseudoConsole(console);
      input.Dispose();
      process.Dispose();
      CloseHandle(job);
    }

    public static PseudoConsole Start(string executable, string arguments, IDictionary<string, string> environment, string directory,
      short columns = 120, short rows = 40) {
      IntPtr inputRead, inputWrite, outputRead, outputWrite;
      if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
      if (!CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
      IntPtr console;
      var result = CreatePseudoConsole(new Coord { X = columns, Y = rows }, inputRead, outputWrite, 0, out console);
      // The pseudo-console duplicated these ends; ours must close or reads never finish.
      CloseHandle(inputRead); CloseHandle(outputWrite);
      if (result != 0) { CloseHandle(inputWrite); CloseHandle(outputRead); throw new Win32Exception(result); }

      var job = CreateJobObjectW(IntPtr.Zero, null);
      var limits = new byte[144];
      BitConverter.GetBytes(0x2000u | 0x400u).CopyTo(limits, 16); // KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION
      if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, limits, (uint)limits.Length)) {
        ClosePseudoConsole(console); CloseHandle(inputWrite); CloseHandle(outputRead);
        throw new Win32Exception();
      }

      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      var attributes = Marshal.AllocHGlobal(size);
      var environmentBlock = IntPtr.Zero;
      try {
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception();
        if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020016, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
        var startup = new StartupInfoEx { AttributeList = attributes };
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        // STARTF_USESTDHANDLES with null handles: never inherit this app's own
        // standard handles, so all I/O goes through the pseudo-console.
        startup.StartupInfo.Flags = 0x100;
        var block = new StringBuilder();
        var keys = new List<string>(environment.Keys);
        keys.Sort(StringComparer.OrdinalIgnoreCase);
        foreach (var key in keys) block.Append(key).Append('=').Append(environment[key]).Append('\0');
        block.Append('\0');
        environmentBlock = Marshal.StringToHGlobalUni(block.ToString());
        ProcessInformation info;
        // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED
        const uint flags = 0x00080000 | 0x00000400 | 0x00000004;
        var commandLine = new StringBuilder("\"" + executable + "\" " + arguments);
        if (!CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, environmentBlock, directory, ref startup, out info)) {
          throw new Win32Exception();
        }
        if (!AssignProcessToJobObject(job, info.Process)) {
          TerminateProcess(info.Process, 1); CloseHandle(info.Thread); CloseHandle(info.Process);
          throw new Win32Exception();
        }
        ResumeThread(info.Thread);
        CloseHandle(info.Thread);
        return new PseudoConsole(console, job, new SafeFileHandle(info.Process, true),
          new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write, 1),
          new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 1));
      } catch {
        ClosePseudoConsole(console); CloseHandle(inputWrite); CloseHandle(outputRead); CloseHandle(job);
        throw;
      } finally {
        DeleteProcThreadAttributeList(attributes);
        Marshal.FreeHGlobal(attributes);
        if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
      }
    }

    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
      public int cb; public string Reserved, Desktop, Title;
      public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
      public short ShowWindow, Reserved2; public IntPtr Reserved2Pointer, StdInput, StdOutput, StdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public int ProcessId, ThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, int size);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
      bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, byte[] info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  }
}
