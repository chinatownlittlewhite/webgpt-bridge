using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace LocalProjectCoding.WindowsSandbox;

internal static class Program
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateSuspended = 0x00000004;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint GenericExecute = 0x20000000;
    private const uint Delete = 0x00010000;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint SeFileObject = 1;
    private const uint GrantAccess = 1;
    private const uint TrusteeIsSid = 0;
    private const uint TrusteeIsUnknown = 0;
    private const uint NoInheritance = 0;
    private const uint SubContainersAndObjectsInherit = 0x00000003;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint DuplicateSameAccess = 0x00000002;
    private const uint ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitFailed = 0xFFFFFFFF;
    private const uint Synchronize = 0x00100000;
    private const uint SeGroupEnabled = 0x00000004;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int ErrorAlreadyExists = 183;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private const string InternetClientCapabilitySid = "S-1-15-3-1";

    public static int Main(string[] args)
    {
        try
        {
            var options = Options.Parse(args);
            var workspace = Path.GetFullPath(options.Workspace);
            var cwd = Path.GetFullPath(options.Cwd);
            if (!IsInside(workspace, cwd))
            {
                throw new InvalidOperationException("cwd escapes the configured workspace");
            }

            var executable = Path.GetFullPath(options.Command[0]);
            if (!File.Exists(executable))
            {
                throw new FileNotFoundException("sandbox executable does not exist", executable);
            }

            var profileName = BuildProfileName(options.ProfilePrefix, workspace);
            var profile = EnsureAppContainerProfile(profileName);
            var appContainerSid = profile.Sid;
            try
            {
                if (profile.Created)
                {
                    GrantAcl(workspace, appContainerSid, modify: true);
                }
                GrantAcl(executable, appContainerSid, modify: false);
                foreach (var readPath in options.ReadPaths)
                {
                    var resolved = Path.GetFullPath(readPath);
                    if (Directory.Exists(resolved) || File.Exists(resolved))
                    {
                        GrantAcl(resolved, appContainerSid, modify: false);
                    }
                }
                foreach (var writePath in options.WritePaths)
                {
                    var resolved = Path.GetFullPath(writePath);
                    if (Directory.Exists(resolved) || File.Exists(resolved))
                    {
                        GrantAcl(resolved, appContainerSid, modify: true);
                    }
                }

                return LaunchInAppContainer(
                    appContainerSid,
                    executable,
                    options.Command,
                    cwd,
                    options.ParentPid,
                    options.AllowNetwork
                );
            }
            finally
            {
                Native.FreeSid(appContainerSid);
            }
        }
        catch (Win32Exception win32)
        {
            Console.Error.WriteLine($"lpc-windows-sandbox: win32={win32.NativeErrorCode} (0x{win32.NativeErrorCode:X8}) {win32.Message}");
            return 125;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"lpc-windows-sandbox: {error.GetType().Name}: {error.Message}");
            return 125;
        }
    }

    private static bool IsInside(string root, string candidate)
    {
        var rootFull = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var candidateFull = Path.TrimEndingDirectorySeparator(Path.GetFullPath(candidate));
        if (string.Equals(rootFull, candidateFull, StringComparison.OrdinalIgnoreCase)) return true;
        return candidateFull.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildProfileName(string prefix, string workspace)
    {
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(workspace))).ToLowerInvariant();
        return $"{prefix}.{digest[..20]}";
    }

    private static (IntPtr Sid, bool Created) EnsureAppContainerProfile(string profileName)
    {
        var result = Native.CreateAppContainerProfile(
            profileName,
            profileName,
            "Local Project Coding workspace sandbox",
            IntPtr.Zero,
            0,
            out var sid
        );
        if (result >= 0) return (sid, true);

        var win32 = result & 0xFFFF;
        if (win32 != ErrorAlreadyExists)
        {
            Marshal.ThrowExceptionForHR(result);
        }

        result = Native.DeriveAppContainerSidFromAppContainerName(profileName, out sid);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        return (sid, false);
    }

    private static void GrantAcl(string target, IntPtr sid, bool modify)
    {
        ApplyAcl(target, sid, modify, inherit: Directory.Exists(target));
    }

    private static void ApplyAcl(string target, IntPtr sid, bool modify, bool inherit)
    {
        IntPtr oldDacl = IntPtr.Zero;
        IntPtr securityDescriptor = IntPtr.Zero;
        IntPtr newDacl = IntPtr.Zero;
        try
        {
            var status = Native.GetNamedSecurityInfoW(
                target,
                SeFileObject,
                DaclSecurityInformation,
                out _,
                out _,
                out oldDacl,
                out _,
                out securityDescriptor
            );
            if (status != 0)
            {
                throw new Win32Exception(unchecked((int)status), $"GetNamedSecurityInfoW failed for '{target}'");
            }

            var access = new Native.ExplicitAccess
            {
                grfAccessPermissions = modify
                    ? GenericRead | GenericWrite | GenericExecute | Delete
                    : GenericRead | GenericExecute,
                grfAccessMode = GrantAccess,
                grfInheritance = inherit ? SubContainersAndObjectsInherit : NoInheritance,
                Trustee = new Native.Trustee
                {
                    pMultipleTrustee = IntPtr.Zero,
                    MultipleTrusteeOperation = 0,
                    TrusteeForm = TrusteeIsSid,
                    TrusteeType = TrusteeIsUnknown,
                    ptstrName = sid,
                },
            };

            status = Native.SetEntriesInAclW(1, new[] { access }, oldDacl, out newDacl);
            if (status != 0)
            {
                throw new Win32Exception(unchecked((int)status), $"SetEntriesInAclW failed for '{target}'");
            }

            status = Native.SetNamedSecurityInfoW(
                target,
                SeFileObject,
                DaclSecurityInformation,
                IntPtr.Zero,
                IntPtr.Zero,
                newDacl,
                IntPtr.Zero
            );
            if (status != 0)
            {
                throw new Win32Exception(unchecked((int)status), $"SetNamedSecurityInfoW failed for '{target}'");
            }
        }
        finally
        {
            if (newDacl != IntPtr.Zero) Native.LocalFree(newDacl);
            if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor);
        }
    }

    private static int LaunchInAppContainer(
        IntPtr appContainerSid,
        string executable,
        IReadOnlyList<string> command,
        string cwd,
        int parentPid,
        bool allowNetwork)
    {
        var stdHandles = PrepareInheritableStdHandles();
        var startup = new Native.StartupInfoEx();
        startup.StartupInfo.cb = Marshal.SizeOf<Native.StartupInfoEx>();
        startup.StartupInfo.dwFlags = StartfUseStdHandles;
        startup.StartupInfo.hStdInput = stdHandles.Input;
        startup.StartupInfo.hStdOutput = stdHandles.Output;
        startup.StartupInfo.hStdError = stdHandles.Error;

        var attributeListSize = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
        startup.lpAttributeList = Marshal.AllocHGlobal(attributeListSize);
        if (!Native.InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref attributeListSize))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
        }

        IntPtr capabilitySid = IntPtr.Zero;
        IntPtr sidAndAttributes = IntPtr.Zero;
        IntPtr securityCapabilities = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        try
        {
            uint capabilityCount = 0;
            if (allowNetwork)
            {
                capabilitySid = AllocateSid(InternetClientCapabilitySid);
                var capability = new Native.SidAndAttributes
                {
                    Sid = capabilitySid,
                    Attributes = SeGroupEnabled,
                };
                sidAndAttributes = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SidAndAttributes>());
                Marshal.StructureToPtr(capability, sidAndAttributes, false);
                capabilityCount = 1;
            }

            var capabilities = new Native.SecurityCapabilities
            {
                AppContainerSid = appContainerSid,
                Capabilities = sidAndAttributes,
                CapabilityCount = capabilityCount,
                Reserved = 0,
            };
            securityCapabilities = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SecurityCapabilities>());
            Marshal.StructureToPtr(capabilities, securityCapabilities, false);

            if (!Native.UpdateProcThreadAttribute(
                    startup.lpAttributeList,
                    0,
                    (IntPtr)ProcThreadAttributeSecurityCapabilities,
                    securityCapabilities,
                    (IntPtr)Marshal.SizeOf<Native.SecurityCapabilities>(),
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed");
            }

            var commandLine = new StringBuilder(BuildWindowsCommandLine(command));
            // lpEnvironment is NULL, so CreateProcessW inherits the caller's environment.
            // Do not set CREATE_UNICODE_ENVIRONMENT unless we actually supply a Unicode environment block.
            var flags = ExtendedStartupInfoPresent | CreateSuspended;
            if (!Native.CreateProcessW(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    flags,
                    IntPtr.Zero,
                    // The helper itself is already spawned with cwd set to the requested workspace.
                    // Inherit it here instead of restating a drive-qualified path, which avoids
                    // depending on hidden per-drive current-directory environment entries on Windows.
                    null,
                    ref startup,
                    out var processInfo))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
            }

            try
            {
                job = Native.CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
                }
                ConfigureKillOnClose(job);
                if (!Native.AssignProcessToJobObject(job, processInfo.hProcess))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
                }
                var parentHandle = Native.OpenProcess(Synchronize, false, unchecked((uint)parentPid));
                if (parentHandle == IntPtr.Zero)
                {
                    Native.TerminateJobObject(job, 137);
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess(parent) failed");
                }
                try
                {
                    if (Native.ResumeThread(processInfo.hThread) == uint.MaxValue)
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
                    }

                    var wait = Native.WaitForMultipleObjects(
                        2,
                        new[] { processInfo.hProcess, parentHandle },
                        false,
                        Infinite
                    );
                    if (wait == WaitObject0 + 1)
                    {
                        Native.TerminateJobObject(job, 137);
                        Native.WaitForSingleObject(processInfo.hProcess, 5_000);
                        return 137;
                    }
                    if (wait == WaitFailed)
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForMultipleObjects failed");
                    }
                    if (wait != WaitObject0)
                    {
                        Native.TerminateJobObject(job, 137);
                        throw new InvalidOperationException($"unexpected wait result: {wait}");
                    }
                    if (!Native.GetExitCodeProcess(processInfo.hProcess, out var exitCode))
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
                    }
                    return unchecked((int)exitCode);
                }
                finally
                {
                    Native.CloseHandle(parentHandle);
                }
            }
            finally
            {
                Native.CloseHandle(processInfo.hThread);
                Native.CloseHandle(processInfo.hProcess);
            }
        }
        finally
        {
            if (job != IntPtr.Zero) Native.CloseHandle(job);
            if (securityCapabilities != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilities);
            if (sidAndAttributes != IntPtr.Zero) Marshal.FreeHGlobal(sidAndAttributes);
            if (capabilitySid != IntPtr.Zero) Marshal.FreeHGlobal(capabilitySid);
            if (startup.lpAttributeList != IntPtr.Zero)
            {
                Native.DeleteProcThreadAttributeList(startup.lpAttributeList);
                Marshal.FreeHGlobal(startup.lpAttributeList);
            }
            Native.CloseHandle(stdHandles.Input);
            Native.CloseHandle(stdHandles.Output);
            Native.CloseHandle(stdHandles.Error);
        }
    }

    private static (IntPtr Input, IntPtr Output, IntPtr Error) PrepareInheritableStdHandles()
    {
        var input = IntPtr.Zero;
        var output = IntPtr.Zero;
        var error = IntPtr.Zero;
        try
        {
            input = PrepareInheritableStdHandle(StdInputHandle, input: true);
            output = PrepareInheritableStdHandle(StdOutputHandle, input: false);
            error = PrepareInheritableStdHandle(StdErrorHandle, input: false);
            return (input, output, error);
        }
        catch
        {
            if (input != IntPtr.Zero) Native.CloseHandle(input);
            if (output != IntPtr.Zero) Native.CloseHandle(output);
            if (error != IntPtr.Zero) Native.CloseHandle(error);
            throw;
        }
    }

    private static IntPtr PrepareInheritableStdHandle(int stdHandle, bool input)
    {
        var source = Native.GetStdHandle(stdHandle);
        var fallback = IntPtr.Zero;
        if (source == IntPtr.Zero || source == new IntPtr(-1))
        {
            fallback = Native.CreateFileW("NUL",
                input ? GenericRead : GenericWrite,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                OpenExisting,
                FileAttributeNormal,
                IntPtr.Zero);
            if (fallback == new IntPtr(-1))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW(NUL) failed");
            }
            source = fallback;
        }

        try
        {
            var currentProcess = Native.GetCurrentProcess();
            if (!Native.DuplicateHandle(
                    currentProcess,
                    source,
                    currentProcess,
                    out var duplicate,
                    0,
                    true,
                    DuplicateSameAccess))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateHandle(stdio) failed");
            }
            return duplicate;
        }
        finally
        {
            if (fallback != IntPtr.Zero) Native.CloseHandle(fallback);
        }
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        var info = new Native.JobObjectExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var size = Marshal.SizeOf<Native.JobObjectExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!Native.SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static IntPtr AllocateSid(string sidText)
    {
        var sid = new SecurityIdentifier(sidText);
        var bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        var pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    private static string BuildWindowsCommandLine(IReadOnlyList<string> args)
    {
        return string.Join(" ", args.Select(QuoteWindowsArgument));
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (!value.Any(ch => char.IsWhiteSpace(ch) || ch == '"')) return value;

        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (ch == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(ch);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private sealed record Options(
        string ProfilePrefix,
        string Workspace,
        string Cwd,
        int ParentPid,
        bool AllowNetwork,
        IReadOnlyList<string> ReadPaths,
        IReadOnlyList<string> WritePaths,
        IReadOnlyList<string> Command)
    {
        public static Options Parse(string[] args)
        {
            string? profilePrefix = null;
            string? workspace = null;
            string? cwd = null;
            int? parentPid = null;
            var allowNetwork = false;
            var readPaths = new List<string>();
            var writePaths = new List<string>();
            var command = new List<string>();

            for (var index = 0; index < args.Length; index += 1)
            {
                var arg = args[index];
                if (arg == "--")
                {
                    command.AddRange(args[(index + 1)..]);
                    break;
                }
                string Next()
                {
                    index += 1;
                    if (index >= args.Length) throw new ArgumentException($"missing value after {arg}");
                    return args[index];
                }

                switch (arg)
                {
                    case "--profile-prefix": profilePrefix = Next(); break;
                    case "--workspace": workspace = Next(); break;
                    case "--cwd": cwd = Next(); break;
                    case "--parent-pid":
                        var parentText = Next();
                        if (!int.TryParse(parentText, out var parsedParent) || parsedParent < 1) throw new ArgumentException("--parent-pid must be a positive integer");
                        parentPid = parsedParent;
                        break;
                    case "--read-path": readPaths.Add(Next()); break;
                    case "--write-path": writePaths.Add(Next()); break;
                    case "--network":
                        var network = Next();
                        allowNetwork = network switch
                        {
                            "allow" => true,
                            "deny" => false,
                            _ => throw new ArgumentException("--network must be 'allow' or 'deny'"),
                        };
                        break;
                    default: throw new ArgumentException($"unknown argument: {arg}");
                }
            }

            if (string.IsNullOrWhiteSpace(profilePrefix)) throw new ArgumentException("--profile-prefix is required");
            if (string.IsNullOrWhiteSpace(workspace)) throw new ArgumentException("--workspace is required");
            if (string.IsNullOrWhiteSpace(cwd)) throw new ArgumentException("--cwd is required");
            if (parentPid is null) throw new ArgumentException("--parent-pid is required");
            if (command.Count == 0) throw new ArgumentException("a command is required after --");
            return new Options(profilePrefix, workspace, cwd, parentPid.Value, allowNetwork, readPaths, writePaths, command);
        }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfo
        {
            public int cb;
            public string? lpReserved;
            public string? lpDesktop;
            public string? lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SecurityCapabilities
        {
            public IntPtr AppContainerSid;
            public IntPtr Capabilities;
            public uint CapabilityCount;
            public uint Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SidAndAttributes
        {
            public IntPtr Sid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct Trustee
        {
            public IntPtr pMultipleTrustee;
            public uint MultipleTrusteeOperation;
            public uint TrusteeForm;
            public uint TrusteeType;
            public IntPtr ptstrName;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct ExplicitAccess
        {
            public uint grfAccessPermissions;
            public uint grfAccessMode;
            public uint grfInheritance;
            public Trustee Trustee;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int CreateAppContainerProfile(
            string pszAppContainerName,
            string pszDisplayName,
            string pszDescription,
            IntPtr pCapabilities,
            uint dwCapabilityCount,
            out IntPtr ppSidAppContainerSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int DeriveAppContainerSidFromAppContainerName(
            string pszAppContainerName,
            out IntPtr ppsidAppContainerSid);

        [DllImport("advapi32.dll")]
        internal static extern IntPtr FreeSid(IntPtr pSid);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint GetNamedSecurityInfoW(
            string pObjectName,
            uint objectType,
            uint securityInfo,
            out IntPtr ppsidOwner,
            out IntPtr ppsidGroup,
            out IntPtr ppDacl,
            out IntPtr ppSacl,
            out IntPtr ppSecurityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint SetNamedSecurityInfoW(
            string pObjectName,
            uint objectType,
            uint securityInfo,
            IntPtr psidOwner,
            IntPtr psidGroup,
            IntPtr pDacl,
            IntPtr pSacl);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint SetEntriesInAclW(
            uint countOfExplicitEntries,
            [In] ExplicitAccess[] listOfExplicitEntries,
            IntPtr oldAcl,
            out IntPtr newAcl);

        [DllImport("kernel32.dll")]
        internal static extern IntPtr LocalFree(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool InitializeProcThreadAttributeList(
            IntPtr lpAttributeList,
            int dwAttributeCount,
            int dwFlags,
            ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool UpdateProcThreadAttribute(
            IntPtr lpAttributeList,
            uint dwFlags,
            IntPtr attribute,
            IntPtr lpValue,
            IntPtr cbSize,
            IntPtr lpPreviousValue,
            IntPtr lpReturnSize);

        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateProcessW(
            string? lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string? lpCurrentDirectory,
            ref StartupInfoEx lpStartupInfo,
            out ProcessInformation lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetInformationJobObject(
            IntPtr hJob,
            int jobObjectInformationClass,
            IntPtr lpJobObjectInformation,
            uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForMultipleObjects(
            uint nCount,
            [In] IntPtr[] lpHandles,
            bool bWaitAll,
            uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll")]
        internal static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool DuplicateHandle(
            IntPtr hSourceProcessHandle,
            IntPtr hSourceHandle,
            IntPtr hTargetProcessHandle,
            out IntPtr lpTargetHandle,
            uint dwDesiredAccess,
            bool bInheritHandle,
            uint dwOptions);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);
    }
}
