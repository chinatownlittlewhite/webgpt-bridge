using LocalProjectCoding.WindowsHostPrep;
using LocalProjectCoding.WindowsSandbox;

namespace LocalProjectCoding.WindowsHost;

internal static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: lpc-windows-host sandbox <args...> | host-prep <args...>");
            return 2;
        }

        var command = args[0];
        var forwarded = args.Skip(1).ToArray();
        return command switch
        {
            "sandbox" => SandboxProgram.Run(forwarded),
            "host-prep" => HostPreparationProgram.Run(forwarded),
            _ => Unknown(command),
        };
    }

    private static int Unknown(string command)
    {
        Console.Error.WriteLine($"lpc-windows-host: unsupported subcommand '{command}'");
        return 2;
    }
}
