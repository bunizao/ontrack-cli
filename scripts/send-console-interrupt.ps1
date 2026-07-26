param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$ArgumentsJson
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ConsoleProcess : IDisposable
{
    private const uint CreateNewProcessGroup = 0x00000200;
    private const uint CtrlBreakEvent = 1;
    private const uint Infinite = 0xffffffff;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint CreateAlways = 2;
    private const uint OpenExisting = 3;
    private const uint StartfUseStdHandles = 0x00000100;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public short ShowWindow;
        public short Reserved2Size;
        public IntPtr Reserved2;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SecurityAttributes securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    public uint Id { get; private set; }
    private IntPtr handle;
    private bool exited;

    private ConsoleProcess() { }

    public static ConsoleProcess Start(string executable, string[] arguments, string stdoutPath, string stderrPath)
    {
        var commandLine = new StringBuilder(Quote(executable));
        foreach (var argument in arguments)
        {
            commandLine.Append(' ').Append(Quote(argument));
        }

        var security = new SecurityAttributes {
            Length = Marshal.SizeOf(typeof(SecurityAttributes)),
            InheritHandle = true,
        };
        var standardInput = InvalidHandle;
        var standardOutput = InvalidHandle;
        var standardError = InvalidHandle;
        try
        {
            standardInput = CreateFile("NUL", GenericRead, ShareRead | ShareWrite, ref security, OpenExisting, 0, IntPtr.Zero);
            standardOutput = CreateFile(stdoutPath, GenericWrite, ShareRead | ShareWrite, ref security, CreateAlways, 0, IntPtr.Zero);
            standardError = CreateFile(stderrPath, GenericWrite, ShareRead | ShareWrite, ref security, CreateAlways, 0, IntPtr.Zero);
            if (standardInput == InvalidHandle || standardOutput == InvalidHandle || standardError == InvalidHandle)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the runtime standard streams");
            }

            var startupInfo = new StartupInfo {
                Size = Marshal.SizeOf(typeof(StartupInfo)),
                Flags = StartfUseStdHandles,
                StandardInput = standardInput,
                StandardOutput = standardOutput,
                StandardError = standardError,
            };
            ProcessInformation processInformation;
            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateNewProcessGroup,
                IntPtr.Zero,
                Environment.CurrentDirectory,
                ref startupInfo,
                out processInformation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not launch the runtime");
            }

            CloseHandle(processInformation.Thread);
            return new ConsoleProcess { Id = processInformation.ProcessId, handle = processInformation.Process };
        }
        finally
        {
            if (standardInput != InvalidHandle) CloseHandle(standardInput);
            if (standardOutput != InvalidHandle) CloseHandle(standardOutput);
            if (standardError != InvalidHandle) CloseHandle(standardError);
        }
    }

    public void Interrupt()
    {
        if (!GenerateConsoleCtrlEvent(CtrlBreakEvent, Id))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not send Ctrl+Break");
        }
    }

    public int Wait()
    {
        WaitForSingleObject(handle, Infinite);
        uint exitCode;
        if (!GetExitCodeProcess(handle, out exitCode))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the runtime exit code");
        }
        exited = true;
        return unchecked((int)exitCode);
    }

    public void Dispose()
    {
        if (handle == IntPtr.Zero) return;
        if (!exited) TerminateProcess(handle, 1);
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        return result.Append('\\', backslashes * 2).Append('"').ToString();
    }
}

public static class ConsoleHost
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

    public static void EnsureConsole()
    {
        if (!AllocConsole())
        {
            var error = Marshal.GetLastWin32Error();
            if (error != 5) throw new Win32Exception(error, "Could not allocate a console");
        }
        if (!SetConsoleCtrlHandler(IntPtr.Zero, true))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure the console handler");
        }
    }
}
"@

$arguments = @((ConvertFrom-Json -InputObject $ArgumentsJson))
$parentInput = [Console]::In
$parentOutput = [Console]::Out
$parentError = [Console]::Error
$stdoutPath = $null
$stderrPath = $null
$process = $null
try {
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    [ConsoleHost]::EnsureConsole()
    $process = [ConsoleProcess]::Start($RuntimePath, [string[]]$arguments, $stdoutPath, $stderrPath)
    $parentOutput.WriteLine("ONTRACK_INTERRUPT_READY")
    $parentOutput.Flush()
    if ($parentInput.ReadLine() -ne "interrupt") {
        throw "Console harness did not receive the interrupt command."
    }
    $process.Interrupt()
    $exitCode = $process.Wait()
    $parentOutput.Write([IO.File]::ReadAllText($stdoutPath))
    $parentError.Write([IO.File]::ReadAllText($stderrPath))
}
finally {
    if ($null -ne $process) {
        $process.Dispose()
    }
    if ($null -ne $stdoutPath) {
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $stderrPath) {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}
exit $exitCode
