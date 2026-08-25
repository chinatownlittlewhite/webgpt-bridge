using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace LocalProjectCoding.WindowsHostPrep;

internal static class Program
{
    private const string CapabilityName = "com.localagenthost.desktop.null-device";
    private const string TargetName = "NUL";
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint SeKernelObject = 6;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const int AclSizeInformation = 2;
    private static readonly IntPtr InvalidHandleValue = new(-1);
    private static readonly int NullDeviceAccessMask = unchecked((int)(GenericRead | GenericWrite));

    public static int Main(string[] args)
    {
        var operation = ParseOperation(args);
        if (operation is null)
        {
            Console.Error.WriteLine("usage: lpc-windows-host-prep --check --json | --apply | --remove");
            return 2;
        }

        try
        {
            var result = operation switch
            {
                "check" => CheckPreparation(),
                "apply" => ApplyPreparation(),
                "remove" => RemovePreparation(),
                _ => throw new InvalidOperationException("unsupported operation"),
            };
            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Win32Exception win32)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                status = "error",
                operation,
                capabilityName = CapabilityName,
                target = TargetName,
                api = ExtractApi(win32.Message),
                win32 = win32.NativeErrorCode,
                elevated = IsAdministrator(),
                integrityLevel = GetIntegrityLevel(),
            }));
            return 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                status = "error",
                operation,
                capabilityName = CapabilityName,
                target = TargetName,
                error = error.GetType().Name,
                message = error.Message,
                elevated = IsAdministrator(),
                integrityLevel = GetIntegrityLevel(),
            }));
            return 1;
        }
    }

    private static string? ParseOperation(string[] args)
    {
        if (args.Length == 2 && args[0] == "--check" && args[1] == "--json") return "check";
        if (args.Length == 1 && args[0] == "--apply") return "apply";
        if (args.Length == 1 && args[0] == "--remove") return "remove";
        return null;
    }

    private static object CheckPreparation()
    {
        using var preparation = OpenPreparation(writeDacl: false);
        var dacl = ReadDacl(preparation.Handle);
        var present = HasOwnedAce(dacl, preparation.CapabilitySid);
        return new
        {
            status = present ? "ready" : "capability_ace_missing",
            capabilityName = CapabilityName,
            capabilitySid = preparation.CapabilitySid.Value,
            target = TargetName,
            accessMask = $"0x{unchecked((uint)NullDeviceAccessMask):X8}",
            elevated = IsAdministrator(),
            integrityLevel = GetIntegrityLevel(),
            remediation = present ? null : "Run WebGPT Bridge installer repair as administrator to restore Windows host preparation.",
        };
    }

    private static object ApplyPreparation()
    {
        using var preparation = OpenPreparation(writeDacl: true);
        var dacl = ReadDacl(preparation.Handle);
        if (!HasOwnedAce(dacl, preparation.CapabilitySid))
        {
            var updated = CloneAcl(dacl, extraCapacity: 1, skipOwnedAce: false, preparation.CapabilitySid);
            updated.InsertAce(updated.Count, new CommonAce(
                AceFlags.None,
                AceQualifier.AccessAllowed,
                NullDeviceAccessMask,
                preparation.CapabilitySid,
                false,
                null));
            WriteDacl(preparation.Handle, updated);
        }
        return CheckPreparation();
    }

    private static object RemovePreparation()
    {
        using var preparation = OpenPreparation(writeDacl: true);
        var dacl = ReadDacl(preparation.Handle);
        if (HasOwnedAce(dacl, preparation.CapabilitySid))
        {
            var updated = CloneAcl(dacl, extraCapacity: 0, skipOwnedAce: true, preparation.CapabilitySid);
            WriteDacl(preparation.Handle, updated);
        }
        var remaining = ReadDacl(preparation.Handle);
        return new
        {
            status = HasOwnedAce(remaining, preparation.CapabilitySid) ? "remove_failed" : "not_provisioned",
            capabilityName = CapabilityName,
            capabilitySid = preparation.CapabilitySid.Value,
            target = TargetName,
            accessMask = $"0x{unchecked((uint)NullDeviceAccessMask):X8}",
            elevated = IsAdministrator(),
            integrityLevel = GetIntegrityLevel(),
        };
    }

    private static PreparationHandle OpenPreparation(bool writeDacl)
    {
        var desiredAccess = ReadControl | (writeDacl ? WriteDac : 0);
        var handle = Native.CreateFileW(
            "NUL",
            desiredAccess,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileAttributeNormal,
            IntPtr.Zero);
        if (handle == InvalidHandleValue)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW(NUL) failed");
        }

        try
        {
            var capabilityPointer = DeriveCapabilitySid(CapabilityName);
            try
            {
                return new PreparationHandle(handle, new SecurityIdentifier(capabilityPointer));
            }
            finally
            {
                Native.LocalFree(capabilityPointer);
            }
        }
        catch
        {
            Native.CloseHandle(handle);
            throw;
        }
    }

    private static RawAcl ReadDacl(IntPtr handle)
    {
        IntPtr securityDescriptor = IntPtr.Zero;
        var result = Native.GetSecurityInfo(
            handle,
            SeKernelObject,
            DaclSecurityInformation,
            IntPtr.Zero,
            IntPtr.Zero,
            out var dacl,
            IntPtr.Zero,
            out securityDescriptor);
        if (result != 0)
        {
            throw new Win32Exception(unchecked((int)result), "GetSecurityInfo(SE_KERNEL_OBJECT) failed");
        }
        try
        {
            if (dacl == IntPtr.Zero)
            {
                throw new InvalidOperationException("NUL has a null DACL; refusing to replace machine-wide security policy");
            }
            var sizeInfo = new Native.AclSizeInformation();
            if (!Native.GetAclInformation(
                    dacl,
                    ref sizeInfo,
                    (uint)Marshal.SizeOf<Native.AclSizeInformation>(),
                    AclSizeInformation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetAclInformation failed");
            }
            if (sizeInfo.AclBytesInUse < 8 || sizeInfo.AclBytesInUse > 1024 * 1024)
            {
                throw new InvalidOperationException($"unexpected NUL DACL size: {sizeInfo.AclBytesInUse}");
            }
            var bytes = new byte[sizeInfo.AclBytesInUse];
            Marshal.Copy(dacl, bytes, 0, bytes.Length);
            return new RawAcl(bytes, 0);
        }
        finally
        {
            if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor);
        }
    }

    private static RawAcl CloneAcl(RawAcl source, int extraCapacity, bool skipOwnedAce, SecurityIdentifier capabilitySid)
    {
        var clone = new RawAcl(source.Revision, source.Count + extraCapacity);
        for (var index = 0; index < source.Count; index += 1)
        {
            var ace = source[index];
            if (skipOwnedAce && IsOwnedAce(ace, capabilitySid)) continue;
            clone.InsertAce(clone.Count, ace);
        }
        return clone;
    }

    private static bool HasOwnedAce(RawAcl dacl, SecurityIdentifier capabilitySid)
    {
        for (var index = 0; index < dacl.Count; index += 1)
        {
            if (IsOwnedAce(dacl[index], capabilitySid)) return true;
        }
        return false;
    }

    private static bool IsOwnedAce(GenericAce ace, SecurityIdentifier capabilitySid)
    {
        return ace is CommonAce common
            && common.AceQualifier == AceQualifier.AccessAllowed
            && common.AceFlags == AceFlags.None
            && common.AccessMask == NullDeviceAccessMask
            && common.SecurityIdentifier == capabilitySid;
    }

    private static void WriteDacl(IntPtr handle, RawAcl dacl)
    {
        var bytes = new byte[dacl.BinaryLength];
        dacl.GetBinaryForm(bytes, 0);
        var pointer = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            var result = Native.SetSecurityInfo(
                handle,
                SeKernelObject,
                DaclSecurityInformation,
                IntPtr.Zero,
                IntPtr.Zero,
                pointer,
                IntPtr.Zero);
            if (result != 0)
            {
                throw new Win32Exception(unchecked((int)result), "SetSecurityInfo(SE_KERNEL_OBJECT) failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static IntPtr DeriveCapabilitySid(string capabilityName)
    {
        IntPtr groupSidArray = IntPtr.Zero;
        IntPtr capabilitySidArray = IntPtr.Zero;
        uint groupSidCount = 0;
        uint capabilitySidCount = 0;
        try
        {
            if (!Native.DeriveCapabilitySidsFromName(
                    capabilityName,
                    out groupSidArray,
                    out groupSidCount,
                    out capabilitySidArray,
                    out capabilitySidCount))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DeriveCapabilitySidsFromName failed");
            }
            if (capabilitySidCount != 1 || capabilitySidArray == IntPtr.Zero)
            {
                throw new InvalidOperationException($"expected exactly one capability SID for '{capabilityName}'");
            }
            var capabilitySid = Marshal.ReadIntPtr(capabilitySidArray);
            Native.LocalFree(capabilitySidArray);
            capabilitySidArray = IntPtr.Zero;
            return capabilitySid;
        }
        finally
        {
            if (groupSidArray != IntPtr.Zero)
            {
                for (var index = 0; index < groupSidCount; index += 1)
                {
                    var sid = Marshal.ReadIntPtr(groupSidArray, index * IntPtr.Size);
                    if (sid != IntPtr.Zero) Native.LocalFree(sid);
                }
                Native.LocalFree(groupSidArray);
            }
            if (capabilitySidArray != IntPtr.Zero)
            {
                for (var index = 0; index < capabilitySidCount; index += 1)
                {
                    var sid = Marshal.ReadIntPtr(capabilitySidArray, index * IntPtr.Size);
                    if (sid != IntPtr.Zero) Native.LocalFree(sid);
                }
                Native.LocalFree(capabilitySidArray);
            }
        }
    }

    private static bool IsAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static string GetIntegrityLevel()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var token = identity.AccessToken.DangerousGetHandle();
        Native.GetTokenInformation(token, 25, IntPtr.Zero, 0, out var required);
        if (required == 0) return "unknown";
        var buffer = Marshal.AllocHGlobal((int)required);
        try
        {
            if (!Native.GetTokenInformation(token, 25, buffer, required, out _)) return "unknown";
            var label = Marshal.PtrToStructure<Native.TokenMandatoryLabel>(buffer);
            if (label.Label.Sid == IntPtr.Zero) return "unknown";
            var sid = new SecurityIdentifier(label.Label.Sid);
            var value = sid.Value ?? string.Empty;
            var separator = value.LastIndexOf('-');
            if (separator < 0 || !int.TryParse(value[(separator + 1)..], out var rid)) return "unknown";
            if (rid >= 16384) return "system";
            if (rid >= 12288) return "high";
            if (rid >= 8192) return "medium";
            if (rid >= 4096) return "low";
            return "untrusted";
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string ExtractApi(string message)
    {
        var index = message.IndexOf(" failed", StringComparison.Ordinal);
        return index > 0 ? message[..index] : "win32";
    }

    private sealed class PreparationHandle : IDisposable
    {
        public IntPtr Handle { get; }
        public SecurityIdentifier CapabilitySid { get; }

        public PreparationHandle(IntPtr handle, SecurityIdentifier capabilitySid)
        {
            Handle = handle;
            CapabilitySid = capabilitySid;
        }

        public void Dispose()
        {
            if (Handle != IntPtr.Zero && Handle != InvalidHandleValue) Native.CloseHandle(Handle);
        }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct AclSizeInformation
        {
            public uint AceCount;
            public uint AclBytesInUse;
            public uint AclBytesFree;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SidAndAttributes
        {
            public IntPtr Sid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct TokenMandatoryLabel
        {
            public SidAndAttributes Label;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint GetSecurityInfo(
            IntPtr handle,
            uint objectType,
            uint securityInfo,
            IntPtr owner,
            IntPtr group,
            out IntPtr dacl,
            IntPtr sacl,
            out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint SetSecurityInfo(
            IntPtr handle,
            uint objectType,
            uint securityInfo,
            IntPtr owner,
            IntPtr group,
            IntPtr dacl,
            IntPtr sacl);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetAclInformation(
            IntPtr acl,
            ref AclSizeInformation aclInformation,
            uint aclInformationLength,
            int aclInformationClass);

        [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DeriveCapabilitySidsFromName(
            string capabilityName,
            out IntPtr capabilityGroupSids,
            out uint capabilityGroupSidCount,
            out IntPtr capabilitySids,
            out uint capabilitySidCount);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetTokenInformation(
            IntPtr tokenHandle,
            int tokenInformationClass,
            IntPtr tokenInformation,
            uint tokenInformationLength,
            out uint returnLength);

        [DllImport("kernel32.dll")]
        internal static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
    }
}
