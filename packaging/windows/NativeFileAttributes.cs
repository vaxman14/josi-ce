using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Josi.NativeSetup
{
    public static class FileAttributes
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct AttributeTag { public uint Attributes; public uint Tag; }
        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
                WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access,
            uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,
            int informationClass, out AttributeTag information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);

        public static bool IsSingleRegularFile(string path)
        {
            using (var file = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
            {
                FileInformation value;
                return !file.IsInvalid && GetFileInformationByHandle(file, out value)
                    && (value.Attributes & (0x400 | 0x10)) == 0 && value.Links == 1;
            }
        }

        // A cloud placeholder is a reparse point but does not redirect a name.
        // This permits the user's OneDrive development ancestor. Junctions,
        // symbolic links and every unreviewed reparse provider still fail closed.
        public static bool IsNonRedirecting(string path)
        {
            using (var file = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
            {
                AttributeTag value;
                if (file.IsInvalid || !GetFileInformationByHandleEx(file, 9, out value, 8))
                    return false;
                if ((value.Attributes & 0x400) == 0) return true;
                return (value.Tag & 0xFFFF0FFFU) == 0x9000001AU;
            }
        }
    }

    public static class PrivateDirectory
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public uint Length;
            public IntPtr Descriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string value, uint revision, out IntPtr descriptor, IntPtr size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);

        // Atomic create with the final protected DACL. An existing path is an
        // error, even if another process creates it between preflight and here.
        public static void Create(string path, string sddl)
        {
            IntPtr descriptor;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero))
                throw new InvalidOperationException("Private directory policy is invalid");
            try
            {
                var attributes = new SecurityAttributes { Length = (uint)Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = false };
                if (!CreateDirectoryW(path, ref attributes))
                    throw new InvalidOperationException("Private directory could not be created; the path may already exist or be inaccessible");
            }
            finally { LocalFree(descriptor); }
        }
    }

    public static class DurableFile
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileExW(string existing, string destination, uint flags);

        // Destination must not exist. The caller first flushes all file bytes;
        // MOVEFILE_WRITE_THROUGH makes the publication durable before proceeding.
        public static void Publish(string existing, string destination)
        {
            if (!MoveFileExW(existing, destination, 8))
                throw new InvalidOperationException("The recovery record could not be published");
        }

        // PowerShell 5.1 converts its $null string argument to an empty path.
        // Keep the null backup argument inside managed code, preserving atomic
        // replacement and the existing configuration's security descriptor.
        public static void Replace(string existing, string destination)
        {
            System.IO.File.Replace(existing, destination, null);
        }
    }

    public static class ServiceRegistration
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateServiceW(IntPtr manager, string name, string displayName,
            uint access, uint type, uint start, uint errorControl, string binary,
            string group, IntPtr tag, string dependencies, string account, string password);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ChangeServiceConfigW(IntPtr service, uint type, uint start, uint errorControl,
            string binary, string group, IntPtr tag, string dependencies, string account, string password, string displayName);
        [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr value);

        // Virtual accounts require a NULL password, not a PSCredential containing
        // an empty SecureString. This is only an SCM API bridge for the fixed
        // product identities; SCM/WinSW remain the manager and service hosts.
        public static void Create(string name, string displayName, string binary, string[] depends)
        {
            var allowed = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal) {
                "JosiDatabase", "JosiWeb", "JosiWorker", "JosiVoice", "JosiVoiceControl", "JosiProxy"
            };
            if (!allowed.Contains(name) || String.IsNullOrEmpty(binary) || binary[0] != '"' || binary.IndexOf('\0') >= 0)
                throw new InvalidOperationException("Invalid fixed service definition");
            foreach (string dependency in depends)
                if (!allowed.Contains(dependency)) throw new InvalidOperationException("Unknown service dependency");
            IntPtr manager = OpenSCManagerW(null, null, 3);
            if (manager == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                string dependencies = depends.Length == 0 ? null : String.Join("\0", depends) + "\0\0";
                IntPtr service = CreateServiceW(manager, name, displayName, 0xF01FF, 16, 3, 1,
                    binary, null, IntPtr.Zero, dependencies, "NT SERVICE\\" + name, null);
                if (service == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                CloseServiceHandle(service);
            }
            finally { CloseServiceHandle(manager); }
        }

        public static void SetDatabaseBinary(string binary)
        {
            if (String.IsNullOrEmpty(binary) || binary[0] != '"' || binary.IndexOf('\0') >= 0)
                throw new InvalidOperationException("Invalid database service definition");
            IntPtr manager = OpenSCManagerW(null, null, 1);
            if (manager == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                IntPtr service = OpenServiceW(manager, "JosiDatabase", 2);
                if (service == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    if (!ChangeServiceConfigW(service, UInt32.MaxValue, UInt32.MaxValue, UInt32.MaxValue,
                        binary, null, IntPtr.Zero, null, null, null, null))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                finally { CloseServiceHandle(service); }
            }
            finally { CloseServiceHandle(manager); }
        }
    }
}
