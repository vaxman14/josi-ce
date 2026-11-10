using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Josi.Native {
  /// Keep ancestors from being renamed/replaced while a mediated file operation
  /// resolves its target. Open the final file before comparing its actual path.
  sealed class PcFileGuard : IDisposable {
    readonly List<SafeFileHandle> parents = new List<SafeFileHandle>();
    public PcFileGuard(string folder) {
      try {
        var absolute=Path.GetFullPath(folder);
        foreach(var protectedRoot in new[]{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Josi"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"Josi")})
          if(PcWork.Within(absolute,protectedRoot))throw new UnauthorizedAccessException("Josi authority storage is protected.");
        var chain=new Stack<string>();for(var current=new DirectoryInfo(absolute);current!=null;current=current.Parent)chain.Push(current.FullName);
        foreach(var path in chain){
          var handle=CreateFile(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
          if(handle.IsInvalid){handle.Dispose();throw new Win32Exception();}
          parents.Add(handle);
          Verify(handle,path,false);
        }
      } catch {Dispose();throw;}
    }
    public static void Verify(SafeFileHandle handle,string expected,bool regular=true){
      Info info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception();
      if((info.Attributes&0x400)!=0||regular&&((info.Attributes&0x10)!=0||info.Links>1))throw new UnauthorizedAccessException("Links and non-regular files are not supported.");
      var name=new StringBuilder(32768);if(GetFinalPathNameByHandle(handle,name,name.Capacity,0)==0)throw new Win32Exception();
      var actual=name.ToString();if(actual.StartsWith(@"\\?\",StringComparison.Ordinal))actual=actual.Substring(4);
      if(!string.Equals(actual.TrimEnd('\\'),Path.GetFullPath(expected).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException("The resolved file changed.");
    }
    public void Dispose(){foreach(var parent in parents)parent.Dispose();parents.Clear();}
    [StructLayout(LayoutKind.Sequential)]struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,int length,uint flags);
  }
}
