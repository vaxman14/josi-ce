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
  /// Redirected one-shot commands, assigned atomically to a job at creation.
  /// Closing the owner kills detached descendants still inside the job as well.
  static class PcOwnedProcess {
    public static int Run(ProcessStartInfo command,Action<string> stdout,Action<string> stderr,int seconds,CancellationToken cancel,out bool timedOut,out bool cancelled) {
      timedOut=cancelled=false;
      var handles=new List<IntPtr>(); IntPtr job=IntPtr.Zero,attributes=IntPtr.Zero,jobValue=IntPtr.Zero,handleValues=IntPtr.Zero,environment=IntPtr.Zero;
      bool initialized=false; ProcessInfo process=default;
      Task readOutput=null,readError=null;
      try {
        var security=new Security {Size=Marshal.SizeOf<Security>(),Inherit=true};
        IntPtr inRead,inWrite,outRead,outWrite,errorRead,errorWrite;
        Pipe(out inRead,out inWrite,ref security,handles);Pipe(out outRead,out outWrite,ref security,handles);Pipe(out errorRead,out errorWrite,ref security,handles);
        if(!SetHandleInformation(outRead,1,0)||!SetHandleInformation(errorRead,1,0)||!SetHandleInformation(inWrite,1,0))throw new Win32Exception();
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
        var limits=new Limits {Basic=new BasicLimits {Flags=0x2000}};
        if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf<Limits>()))throw new Win32Exception();
        IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);attributes=Marshal.AllocHGlobal(size);
        if(!InitializeProcThreadAttributeList(attributes,2,0,ref size))throw new Win32Exception();initialized=true;
        jobValue=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobValue,job);
        handleValues=Marshal.AllocHGlobal(IntPtr.Size*3);
        Marshal.WriteIntPtr(handleValues,0,inRead);Marshal.WriteIntPtr(handleValues,IntPtr.Size,outWrite);Marshal.WriteIntPtr(handleValues,IntPtr.Size*2,errorWrite);
        if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)
          ||!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handleValues,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
        var block=string.Join("\0",command.Environment.OrderBy(p=>p.Key,StringComparer.OrdinalIgnoreCase).Select(p=>p.Key+"="+p.Value))+"\0\0";
        environment=Marshal.StringToHGlobalUni(block);
        var startup=new StartupEx {Info=new Startup {Size=Marshal.SizeOf<StartupEx>(),Flags=0x100,Input=inRead,Output=outWrite,Error=errorWrite},Attributes=attributes};
        cancel.ThrowIfCancellationRequested();
        if(!CreateProcess(command.FileName,new StringBuilder("\""+command.FileName+"\" "+command.Arguments),IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x08000000,environment,command.WorkingDirectory,ref startup,out process))throw new Win32Exception();
        foreach(var handle in new[]{inRead,inWrite,outWrite,errorWrite}){CloseHandle(handle);handles.Remove(handle);}
        readOutput=Drain(outRead,stdout);handles.Remove(outRead);readError=Drain(errorRead,stderr);handles.Remove(errorRead);
        var clock=Stopwatch.StartNew();
        while(WaitForSingleObject(process.Process,100)==258){
          if(cancel.IsCancellationRequested){cancelled=true;break;}
          if(clock.Elapsed.TotalSeconds>=seconds){timedOut=true;break;}
        }
        uint code;GetExitCodeProcess(process.Process,out code);
        TerminateJobObject(job,1); // Also close descendants after the root exits.
        Task.WaitAll(new[]{readOutput,readError},5000);
        return timedOut||cancelled?-1:(int)code;
      } finally {
        if(job!=IntPtr.Zero){TerminateJobObject(job,1);CloseHandle(job);}
        foreach(var handle in handles)CloseHandle(handle);
        if(process.Thread!=IntPtr.Zero)CloseHandle(process.Thread);if(process.Process!=IntPtr.Zero)CloseHandle(process.Process);
        if(initialized)DeleteProcThreadAttributeList(attributes);
        foreach(var allocation in new[]{attributes,jobValue,handleValues,environment})if(allocation!=IntPtr.Zero)Marshal.FreeHGlobal(allocation);
      }
    }
    static void Pipe(out IntPtr read,out IntPtr write,ref Security security,List<IntPtr> handles){if(!CreatePipe(out read,out write,ref security,0))throw new Win32Exception();handles.Add(read);handles.Add(write);}
    static Task Drain(IntPtr handle,Action<string> append)=>Task.Run(()=>{
      try {using(var stream=new StreamReader(new FileStream(new SafeFileHandle(handle,true),FileAccess.Read),new UTF8Encoding(false,false))){var chars=new char[4096];int count;while((count=stream.Read(chars,0,chars.Length))>0)append(new string(chars,0,count));}}
      catch(IOException){}catch(ObjectDisposedException){}
    });
    [StructLayout(LayoutKind.Sequential)] struct Security {public int Size;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
    [StructLayout(LayoutKind.Sequential)] struct Startup {public int Size;public IntPtr Reserved,Desktop,Title;public int X,Y,Width,Height,CharsX,CharsY,Fill,Flags;public short Show,ReservedSize;public IntPtr ReservedBytes,Input,Output,Error;}
    [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup Info;public IntPtr Attributes;}
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Process,Thread;public int ProcessId,ThreadId;}
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {public long ProcessTime,JobTime;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct Limits {public BasicLimits Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security security,int size);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,int size);
    [DllImport("kernel32.dll")]static extern bool TerminateJobObject(IntPtr job,uint exit);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")]static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  }
}
