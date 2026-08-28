import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";

/** Complete one compiled-bridge cache write and remove only the caller's temporary artifact. Kept
 * separately executable so Windows tests can force both destination-race branches deterministically. */
export const WINDOWS_JOB_CACHE_HELPERS = String.raw`
function Complete-WollipogJobBridgeCache([string] $CompilePath, [string] $BridgePath) {
  try {
    try { [IO.File]::Move($CompilePath, $BridgePath) }
    catch [IO.IOException] {
      if (-not (Test-Path -LiteralPath $BridgePath -PathType Leaf)) { throw }
    }
  } finally {
    # A real-time scanner can briefly hold a newly compiled DLL. Retry transient cleanup without
    # turning a valid winning bridge into a failed provider launch; the GUID temp is never loaded.
    for ($Attempt = 0; $Attempt -lt 5 -and
        (Test-Path -LiteralPath $CompilePath -PathType Leaf); $Attempt++) {
      Remove-Item -LiteralPath $CompilePath -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $CompilePath -PathType Leaf) { Start-Sleep -Milliseconds 50 }
    }
  }
}
`;

/**
 * Windows Job Object launcher materialized by the runner on native Windows.
 *
 * Node does not expose CreateJobObject/AssignProcessToJobObject. This PowerShell host loads a
 * versioned P/Invoke bridge cached beside the materialized script, creates the requested process
 * suspended with the runner pipes, assigns it to a kill-on-close Job Object, resumes it, and
 * mirrors its exit code. Closing or killing the launcher closes the final job handle and
 * terminates the complete child process tree. This is deliberately a process-lifetime/resource
 * boundary, not a filesystem or network sandbox.
 */
export const WINDOWS_JOB_LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_JOB_CACHE_HELPERS}
function Fail-WollipogJob([string] $Code, [string] $Message) {
  [Console]::Error.WriteLine("[runner] Windows Job isolation failed ($Code): $Message")
  exit 125
}

if (Test-Path Env:WOLLIPOG_WINDOWS_JOB_SPEC) { $Spec = $env:WOLLIPOG_WINDOWS_JOB_SPEC }
else { $Spec = $env:MAM_WINDOWS_JOB_SPEC }
$env:WOLLIPOG_WINDOWS_JOB_SPEC = $null
$env:MAM_WINDOWS_JOB_SPEC = $null
if ([string]::IsNullOrWhiteSpace($Spec)) {
  Fail-WollipogJob 'missing-spec' 'missing Wollipog Windows Job launch specification'
}

try {
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec)) | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string] $decoded.command) -or
      [string]::IsNullOrWhiteSpace([string] $decoded.cwd) -or
      [uint32] $decoded.ownerPid -le 1 -or $null -eq $decoded.args) {
    throw 'required launch field missing'
  }
  $commandArgs = @($decoded.args | ForEach-Object { [string] $_ })
} catch {
  Fail-WollipogJob 'invalid-spec' 'the Windows Job launch specification is malformed'
}

$BridgePath = Join-Path $PSScriptRoot 'WollipogWindowsJob.dll'
$CompilePath = $null
$Mutex = $null
$MutexHeld = $false
try {
  $MutexName = 'Local\WollipogWindowsJobBridge-' + (Split-Path $PSScriptRoot -Leaf)
  $Mutex = [Threading.Mutex]::new($false, $MutexName)
  try { $MutexHeld = $Mutex.WaitOne(30000) }
  catch [Threading.AbandonedMutexException] { $MutexHeld = $true }
  if (-not $MutexHeld) { throw 'bridge cache lock timed out' }
  if (-not (Test-Path -LiteralPath $BridgePath -PathType Leaf)) {
    $CompilePath = Join-Path $PSScriptRoot ('WollipogWindowsJob-' + [Guid]::NewGuid().ToString('N') + '.dll')

    Add-Type -OutputAssembly $CompilePath -TypeDefinition @'
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
  static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

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

  public static int Run(string command, string[] args, string cwd, string rawCommandLine, uint ownerPid) {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    var created = false;
    var completed = false;
    var owner = OpenProcess(0x00100000, false, ownerPid); // SYNCHRONIZE
    if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess runner owner failed");
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
      var wait = WaitForMultipleObjects(2, new [] { process.hProcess, owner }, false, INFINITE);
      if (wait == WAIT_OBJECT_0 + 1) return 1; // runner owner exited; finally closes the kill-on-close Job
      if (wait != WAIT_OBJECT_0)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForMultipleObjects failed");
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
      CloseHandle(owner);
      CloseHandle(job);
    }
  }
}
'@
    Complete-WollipogJobBridgeCache $CompilePath $BridgePath
    $CompilePath = $null
  }
  try { Add-Type -Path $BridgePath }
  catch {
    # Fail closed for this launch, but remove an incomplete/corrupt cache entry so the next launch
    # can rebuild it under the version-scoped mutex.
    Remove-Item -LiteralPath $BridgePath -Force -ErrorAction SilentlyContinue
    throw
  }
} catch {
  Fail-WollipogJob 'bridge-unavailable' 'the native bridge could not be initialized; Windows application-control policy may be blocking it'
} finally {
  if ($CompilePath -and (Test-Path -LiteralPath $CompilePath)) {
    Remove-Item -LiteralPath $CompilePath -Force -ErrorAction SilentlyContinue
  }
  if ($MutexHeld) { $Mutex.ReleaseMutex() }
  if ($Mutex) { $Mutex.Dispose() }
}

try {
  $exitCode = [WollipogWindowsJob]::Run(
    [string] $decoded.command,
    $commandArgs,
    [string] $decoded.cwd,
    [string] $decoded.rawCommandLine,
    [uint32] $decoded.ownerPid)
  exit $exitCode
} catch {
  $Failure = $_.Exception.ToString()
  if ($Failure -match 'AssignProcessToJobObject failed') {
    Fail-WollipogJob 'job-assignment' 'the provider process could not be assigned to its Job Object'
  }
  if ($Failure -match 'CreateJobObject failed|SetInformationJobObject failed') {
    Fail-WollipogJob 'job-initialization' 'the kill-on-close Job Object could not be initialized'
  }
  if ($Failure -match 'CreateProcess failed') {
    Fail-WollipogJob 'provider-create' 'the provider process could not be created inside the Job Object boundary'
  }
  if ($Failure -match 'OpenProcess runner owner failed') {
    Fail-WollipogJob 'runner-owner' 'the launcher could not bind containment to the runner process'
  }
  Fail-WollipogJob 'native-boundary' 'the Windows Job containment boundary failed'
}
`;

export function encodeWindowsJobSpec(command: string, args: string[], cwd: string, ownerPid: number, rawCommandLine?: string): string {
  return Buffer.from(JSON.stringify({ command, args, cwd, ownerPid, ...(rawCommandLine ? { rawCommandLine } : {}) }), "utf8").toString("base64");
}

/** Resolve the launcher cache inside the native Windows user's private application-data tree.
 * Platform-independent callers must inject a private cache root instead of sharing system temp. */
export function windowsJobCacheRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") {
    throw new Error("Windows Job launcher materialization requires an explicit cache root outside native Windows");
  }
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !win32.isAbsolute(localAppData)) {
    throw new Error("Windows Job isolation requires an absolute LOCALAPPDATA directory");
  }
  return win32.join(localAppData, "Wollipog", "cache", "windows-job");
}

/** Materialize and verify the audited launcher. Its content hash versions both the script and
 * compiled bridge cache, while per-call verification repairs cache cleanup or corruption. */
export function materializeWindowsJobLauncher(cacheRoot = windowsJobCacheRoot()): string {
  const digest = createHash("sha256").update(WINDOWS_JOB_LAUNCHER, "utf8").digest("hex").slice(0, 24);
  const versionRoot = join(cacheRoot, digest);
  const scriptPath = join(versionRoot, "launcher.ps1");
  mkdirSync(versionRoot, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700);
  chmodSync(versionRoot, 0o700);
  if (existsSync(scriptPath) && readFileSync(scriptPath, "utf8") !== WINDOWS_JOB_LAUNCHER) {
    rmSync(scriptPath, { force: true });
  }
  if (!existsSync(scriptPath)) {
    const temporaryPath = join(versionRoot, `launcher-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, WINDOWS_JOB_LAUNCHER, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        renameSync(temporaryPath, scriptPath);
      } catch (error) {
        if (!existsSync(scriptPath)) throw error;
      }
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  if (readFileSync(scriptPath, "utf8") !== WINDOWS_JOB_LAUNCHER) {
    throw new Error("Windows Job launcher cache does not match the audited runner source");
  }
  chmodSync(scriptPath, 0o600);
  return scriptPath;
}
