using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace LocalProjectCoding.WindowsHostPrep;

internal static class Program
{
    private const string CapabilityName = "com.localagenthost.desktop.null-device";
    private const string AllApplicationPackagesSid = "S-1-15-2-1";
    private const string TargetName = "NUL";
    private const uint FileGenericRead = 0x00120089;
    private const uint FileGenericWrite = 0x00120116;
    private const uint FileGenericExecute = 0x001200A0;
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const uint WriteOwner = 0x00080000;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint LabelSecurityInformation = 0x00000010;
    private const uint SddlRevision1 = 1;
    private const string LowIntegrityLabelSddl = "S:(ML;;NW;;;LW)";
    private const uint SeKernelObject = 6;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const int AclSizeInformation = 2;
    private static readonly IntPtr InvalidHandleValue = new(-1);
    private static readonly int NullDeviceAccessMask = unchecked((int)(FileGenericRead | FileGenericWrite | FileGenericExecute));

    public static int Main(string[] args)
    {
        var operation = ParseOperation(args);
        if (operation is null)
        {
            Console.Error.WriteLine("usage: lpc-windows-host-prep --check --json | --apply | --remove");
            return 2;
        }
        if ((operation is "apply" or "remove") && !IsAdministrator())
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                status = "elevation_required",
                operation,
                capabilityName = CapabilityName,
                target = TargetName,
                elevated = false,
                integrityLevel = GetIntegrityLevel(),
                remediation = "Run this host-preparation mutation from the elevated installer, repair flow, or SYSTEM startup task.",
            }));
            return 65;
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
        using var preparation = OpenPreparation(writeDacl: false, writeLabel: false);
        var dacl = ReadDacl(preparation.Handle);
        var present = HasOwnedAce(dacl, preparation.CapabilitySid);
        var appContainerPresent = HasOwnedAce(dacl, preparation.AppContainerSid);
        var lowIntegrity = HasLowIntegrityLabel(preparation.Handle);
        return new
        {
            status = present && appContainerPresent && lowIntegrity
                ? "ready"
                : !present
                    ? "capability_ace_missing"
                    : !appContainerPresent ? "appcontainer_ace_missing" : "integrity_label_missing",
            capabilityName = CapabilityName,
            capabilitySid = preparation.CapabilitySid.Value,
            appContainerSid = preparation.AppContainerSid.Value,
            appContainerPackageAccess = appContainerPresent,
            target = TargetName,
            accessMask = $"0x{unchecked((uint)NullDeviceAccessMask):X8}",
            lowIntegrityLabel = lowIntegrity,
            elevated = IsAdministrator(),
            integrityLevel = GetIntegrityLevel(),
            remediation = present && appContainerPresent && lowIntegrity
                ? null
                : "Run WebGPT Bridge installer repair as administrator to restore Windows host preparation.",
        };
    }

    private static object ApplyPreparation()
    {
        using var preparation = OpenPreparation(writeDacl: true, writeLabel: true);
        var dacl = ReadDacl(preparation.Handle);
        var capabilityPresent = HasOwnedAce(dacl, preparation.CapabilitySid);
        var appContainerPresent = HasOwnedAce(dacl, preparation.AppContainerSid);
        var missingAceCount = (capabilityPresent ? 0 : 1) + (appContainerPresent ? 0 : 1);
        if (missingAceCount > 0)
        {
            var updated = CloneAcl(
                dacl,
                extraCapacity: missingAceCount,
                skipOwnedAce: false,
                preparation.CapabilitySid,
                preparation.AppContainerSid);
            if (!capabilityPresent)
            {
                updated.InsertAce(updated.Count, new CommonAce(
                    AceFlags.None,
                    AceQualifier.AccessAllowed,
                    NullDeviceAccessMask,
                    preparation.CapabilitySid,
                    false,
                    null));
            }
            if (!appContainerPresent)
            {
                updated.InsertAce(updated.Count, new CommonAce(
                    AceFlags.None,
                    AceQualifier.AccessAllowed,
                    NullDeviceAccessMask,
                    preparation.AppContainerSid,
                    false,
                    null));
            }
            WriteDacl(preparation.Handle, updated);
            var persisted = ReadDacl(preparation.Handle);
            if (!HasOwnedAce(persisted, preparation.CapabilitySid))
            {
                throw new InvalidOperationException("SetKernelObjectSecurity returned success but the product capability ACE was not persisted on NUL");
            }
            if (!HasOwnedAce(persisted, preparation.AppContainerSid))
            {
                throw new InvalidOperationException("SetKernelObjectSecurity returned success but the AppContainer package ACE was not persisted on NUL");
            }
        }
        if (!HasLowIntegrityLabel(preparation.Handle))
        {
            EnsureLowIntegrityLabel(preparation.Handle);
        }
        return CheckPreparation();
    }

    private static object RemovePreparation()
    {
        using var preparation = OpenPreparation(writeDacl: true, writeLabel: false);
        var dacl = ReadDacl(preparation.Handle);
        if (HasOwnedAce(dacl, preparation.CapabilitySid) || HasOwnedAce(dacl, preparation.AppContainerSid))
        {
            var updated = CloneAcl(
                dacl,
                extraCapacity: 0,
                skipOwnedAce: true,
                preparation.CapabilitySid,
                preparation.AppContainerSid);
            WriteDacl(preparation.Handle, updated);
        }
        var remaining = ReadDacl(preparation.Handle);
        return new
        {
            status = HasOwnedAce(remaining, preparation.CapabilitySid) || HasOwnedAce(remaining, preparation.AppContainerSid)
                ? "remove_failed"
                : "not_provisioned",
            capabilityName = CapabilityName,
            capabilitySid = preparation.CapabilitySid.Value,
            target = TargetName,
            accessMask = $"0x{unchecked((uint)NullDeviceAccessMask):X8}",
            elevated = IsAdministrator(),
            integrityLevel = GetIntegrityLevel(),
        };
    }

    private static PreparationHandle OpenPreparation(bool writeDacl, bool writeLabel)
    {
        var desiredAccess = ReadControl
            | (writeDacl ? WriteDac : 0)
            | (writeLabel ? WriteOwner : 0);
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
                return new PreparationHandle(
                    handle,
                    new SecurityIdentifier(capabilityPointer),
                    new SecurityIdentifier(AllApplicationPackagesSid));
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

    private static bool HasLowIntegrityLabel(IntPtr handle)
    {
        IntPtr securityDescriptor = IntPtr.Zero;
        IntPtr sddl = IntPtr.Zero;
        var result = Native.GetSecurityInfoWithSacl(
            handle,
            SeKernelObject,
            LabelSecurityInformation,
            IntPtr.Zero,
            IntPtr.Zero,
            out _,
            out _,
            out securityDescriptor);
        if (result != 0)
        {
            throw new Win32Exception(unchecked((int)result), "GetSecurityInfo(LABEL_SECURITY_INFORMATION) failed");
        }
        try
        {
            if (!Native.ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    securityDescriptor,
                    SddlRevision1,
                    LabelSecurityInformation,
                    out sddl,
                    out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertSecurityDescriptorToStringSecurityDescriptorW failed");
            }
            var text = Marshal.PtrToStringUni(sddl) ?? string.Empty;
            return text.Contains("(ML;;NW;;;LW)", StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            if (sddl != IntPtr.Zero) Native.LocalFree(sddl);
            if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor);
        }
    }

    private static void EnsureLowIntegrityLabel(IntPtr handle)
    {
        IntPtr securityDescriptor = IntPtr.Zero;
        try
        {
            if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    LowIntegrityLabelSddl,
                    SddlRevision1,
                    out securityDescriptor,
                    out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSecurityDescriptorToSecurityDescriptorW failed");
            }
            if (!Native.GetSecurityDescriptorSacl(
                    securityDescriptor,
                    out var saclPresent,
                    out var sacl,
                    out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetSecurityDescriptorSacl failed");
            }
            if (!saclPresent || sacl == IntPtr.Zero)
            {
                throw new InvalidOperationException("low-integrity SDDL did not produce a mandatory label ACL");
            }
            var result = Native.SetSecurityInfo(
                handle,
                SeKernelObject,
                LabelSecurityInformation,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                sacl);
            if (result != 0)
            {
                throw new Win32Exception(unchecked((int)result), "SetSecurityInfo(LABEL_SECURITY_INFORMATION) failed");
            }
        }
        finally
        {
            if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor);
        }
    }

    private static RawAcl CloneAcl(
        RawAcl source,
        int extraCapacity,
        bool skipOwnedAce,
        SecurityIdentifier capabilitySid,
        SecurityIdentifier appContainerSid)
    {
        var clone = new RawAcl(source.Revision, source.Count + extraCapacity);
        for (var index = 0; index < source.Count; index += 1)
        {
            var ace = source[index];
            if (skipOwnedAce && (IsOwnedAce(ace, capabilitySid) || IsOwnedAce(ace, appContainerSid))) continue;
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
        var aclPointer = Marshal.AllocHGlobal(bytes.Length);
        var descriptorPointer = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SecurityDescriptor>());
        try
        {
            Marshal.Copy(bytes, 0, aclPointer, bytes.Length);
            if (!Native.InitializeSecurityDescriptor(descriptorPointer, SddlRevision1))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeSecurityDescriptor failed");
            }
            if (!Native.SetSecurityDescriptorDacl(descriptorPointer, true, aclPointer, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetSecurityDescriptorDacl failed");
            }
            if (!Native.SetKernelObjectSecurity(handle, DaclSecurityInformation, descriptorPointer))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetKernelObjectSecurity(DACL_SECURITY_INFORMATION) failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(descriptorPointer);
            Marshal.FreeHGlobal(aclPointer);
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
        public SecurityIdentifier AppContainerSid { get; }

        public PreparationHandle(
            IntPtr handle,
            SecurityIdentifier capabilitySid,
            SecurityIdentifier appContainerSid)
        {
            Handle = handle;
            CapabilitySid = capabilitySid;
            AppContainerSid = appContainerSid;
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

        [StructLayout(LayoutKind.Sequential)]
        internal struct SecurityDescriptor
        {
            public byte Revision;
            public byte Sbz1;
            public ushort Control;
            public IntPtr Owner;
            public IntPtr Group;
            public IntPtr Sacl;
            public IntPtr Dacl;
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

        [DllImport("advapi32.dll", EntryPoint = "GetSecurityInfo", SetLastError = true)]
        internal static extern uint GetSecurityInfoWithSacl(
            IntPtr handle,
            uint objectType,
            uint securityInfo,
            IntPtr owner,
            IntPtr group,
            out IntPtr dacl,
            out IntPtr sacl,
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
        internal static extern bool InitializeSecurityDescriptor(
            IntPtr securityDescriptor,
            uint revision);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetSecurityDescriptorDacl(
            IntPtr securityDescriptor,
            [MarshalAs(UnmanagedType.Bool)] bool daclPresent,
            IntPtr dacl,
            [MarshalAs(UnmanagedType.Bool)] bool daclDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetKernelObjectSecurity(
            IntPtr handle,
            uint securityInformation,
            IntPtr securityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
            IntPtr securityDescriptor,
            uint requestedStringSdRevision,
            uint securityInformation,
            out IntPtr stringSecurityDescriptor,
            out uint stringSecurityDescriptorLength);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string stringSecurityDescriptor,
            uint stringSdRevision,
            out IntPtr securityDescriptor,
            out uint securityDescriptorSize);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetSecurityDescriptorSacl(
            IntPtr securityDescriptor,
            [MarshalAs(UnmanagedType.Bool)] out bool saclPresent,
            out IntPtr sacl,
            [MarshalAs(UnmanagedType.Bool)] out bool saclDefaulted);

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
