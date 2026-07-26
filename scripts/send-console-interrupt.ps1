param([Parameter(Mandatory = $true)][int]$TargetPid)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ConsoleSignal
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
}
"@

[ConsoleSignal]::FreeConsole() | Out-Null
if (-not [ConsoleSignal]::AttachConsole([uint32]$TargetPid)) {
    Write-Error "AttachConsole failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    exit 1
}
[ConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
if (-not [ConsoleSignal]::GenerateConsoleCtrlEvent(1, [uint32]$TargetPid)) {
    Write-Error "GenerateConsoleCtrlEvent failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    exit 1
}
Start-Sleep -Milliseconds 100
