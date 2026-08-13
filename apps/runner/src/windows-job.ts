/**
 * Windows Job Object launcher materialized by the runner on native Windows.
 *
 * Node does not expose CreateJobObject/AssignProcessToJobObject. This PowerShell host compiles a
 * small in-memory P/Invoke bridge, creates the requested process suspended with the runner pipes,
 * assigns it to a kill-on-close Job Object, resumes it, and mirrors its exit code. Closing or
 * killing the launcher closes the final job handle and terminates the complete child process tree.
 * This is deliberately a process-lifetime/resource boundary, not a filesystem or network sandbox.
 */
export const WINDOWS_JOB_LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
if (Test-Path Env:WOLLIPOG_WINDOWS_JOB_SPEC) { $Spec = $env:WOLLIPOG_WINDOWS_JOB_SPEC }
else { $Spec = $env:MAM_WINDOWS_JOB_SPEC }
$env:WOLLIPOG_WINDOWS_JOB_SPEC = $null
$env:MAM_WINDOWS_JOB_SPEC = $null
if ([string]::IsNullOrWhiteSpace($Spec)) { throw 'missing Wollipog Windows Job launch specification' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class WollipogWindowsJob {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;
  const uint INFINITE = 0xFFFFFFFF;
  const uint WAIT_OBJECT_0 = 0x00000000;
  const int STD_INPUT_HANDLE = -10;
  const int STD_OUTPUT_HANDLE = -11;
  const int STD_ERROR_HANDLE = -12;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
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
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFOEX startupInfo,
    out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(
    IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(
    IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
    IntPtr previousValue, IntPtr returnSize);

  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int handle);

  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new [] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
    var output = new StringBuilder("\"");
    var slashes = 0;
    foreach (var ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') {
        output.Append('\\', slashes * 2 + 1);
        output.Append('"');
      } else {
        output.Append('\\', slashes);
        output.Append(ch);
      }
      slashes = 0;
    }
    output.Append('\\', slashes * 2);
    output.Append('"');
    return output.ToString();
  }

  public static int Run(string command, string[] args, string cwd, string rawCommandLine) {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    var created = false;
    var completed = false;
    try {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      var pointer = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, pointer, false);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
      } finally { Marshal.FreeHGlobal(pointer); }

      var startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
      startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
      startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
      var inheritedHandles = new [] {
        startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError
      };
      foreach (var handle in inheritedHandles) {
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "SetHandleInformation failed");
      }
      var attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      var line = new StringBuilder(Quote(command));
      if (!String.IsNullOrEmpty(rawCommandLine)) {
        line.Append(" /d /s /c \"").Append(rawCommandLine).Append('"');
      } else {
        foreach (var arg in args) line.Append(' ').Append(Quote(arg));
      }
      IntPtr handleList = IntPtr.Zero;
      var attributesInitialized = false;
      try {
        startup.lpAttributeList = Marshal.AllocHGlobal(attributeSize);
        handleList = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Length);
        for (var index = 0; index < inheritedHandles.Length; index++)
          Marshal.WriteIntPtr(handleList, index * IntPtr.Size, inheritedHandles[index]);
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref attributeSize))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
        attributesInitialized = true;
        if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handleList, new IntPtr(IntPtr.Size * inheritedHandles.Length), IntPtr.Zero, IntPtr.Zero))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed");
        if (!CreateProcessW(command, line, IntPtr.Zero, IntPtr.Zero, true,
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref startup, out process))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
      } finally {
        if (attributesInitialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
        if (startup.lpAttributeList != IntPtr.Zero) Marshal.FreeHGlobal(startup.lpAttributeList);
        if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      }
      created = true;
      if (!AssignProcessToJobObject(job, process.hProcess))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
      if (ResumeThread(process.hThread) != 1)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
      if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
      uint exitCode;
      if (!GetExitCodeProcess(process.hProcess, out exitCode))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
      completed = true;
      return unchecked((int)exitCode);
    } finally {
      if (created) {
        if (!completed && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      }
      CloseHandle(job);
    }
  }
}
'@

$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec)) | ConvertFrom-Json
$commandArgs = @($decoded.args | ForEach-Object { [string] $_ })
exit [WollipogWindowsJob]::Run([string] $decoded.command, $commandArgs, [string] $decoded.cwd, [string] $decoded.rawCommandLine)
`;

export function encodeWindowsJobSpec(command: string, args: string[], cwd: string, rawCommandLine?: string): string {
  return Buffer.from(JSON.stringify({ command, args, cwd, ...(rawCommandLine ? { rawCommandLine } : {}) }), "utf8").toString("base64");
}

export const WINDOWS_JOB_ENCODED_COMMAND = Buffer.from(WINDOWS_JOB_LAUNCHER, "utf16le").toString("base64");
