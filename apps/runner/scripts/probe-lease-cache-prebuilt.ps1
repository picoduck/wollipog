# Opt-in #2316 experiment; no runtime compilation and no canonical HOME access.
param(
  [ValidateSet('Describe', 'Metadata', 'Snapshot', 'Hold', 'Malformed', 'ProbeFailure')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Assembly,
  [string]$Digest
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5 is required; no fallback' }
$env:TEMP = $Root
$env:TMP = $Root
function Read-Machine($path) {
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  $reader = New-Object IO.BinaryReader($stream)
  try {
    if ($reader.ReadUInt16() -ne 23117) { throw 'invalid native module MZ header' }
    [void]$stream.Seek(60, [IO.SeekOrigin]::Begin)
    $offset = $reader.ReadUInt32()
    if ($offset -gt $stream.Length - 6) { throw 'native PE header unavailable' }
    [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
    if ($reader.ReadUInt32() -ne 17744) { throw 'invalid native module PE header' }
    return ('0x{0:x4}' -f $reader.ReadUInt16())
  } finally { $reader.Dispose(); $stream.Dispose() }
}
function Runtime-Metadata {
  $process = [Diagnostics.Process]::GetCurrentProcess()
  $clr = @($process.Modules | Where-Object { $_.ModuleName -ieq 'clr.dll' })
  if ($clr.Count -ne 1) { throw 'exact loaded Framework CLR module unavailable' }
  return @{
    powerShellVersion = $PSVersionTable.PSVersion.ToString()
    edition = $PSVersionTable.PSEdition
    clrVersion = [Environment]::Version.ToString()
    loadedClrMachine = Read-Machine $clr[0].FileName
    pointerBytes = [IntPtr]::Size
    processId = $PID
    processStartUtcTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
    compiler = [IO.Path]::Combine([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(), 'csc.exe')
  }
}
if ($Mode -eq 'Describe') {
  Runtime-Metadata | ConvertTo-Json -Compress
  exit 0
}
if ($Digest -notmatch '^[0-9a-f]{64}$') { throw 'invalid expected fixture DLL digest' }
# Deny concurrent write/delete sharing and read only the bounded image from the same handle.
$stream = [IO.File]::Open($Assembly, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$reader = New-Object IO.BinaryReader($stream)
try {
  $length = $stream.Length
  if ($length -lt 1 -or $length -gt 65536) { throw 'fixture DLL exceeds before-read cap' }
  [byte[]]$bytes = $reader.ReadBytes([int]$length)
  if ($bytes.Length -ne $length -or $stream.ReadByte() -ne -1) { throw 'fixture DLL changed during read' }
} finally { $reader.Dispose(); $stream.Dispose() }
$sha = [Security.Cryptography.SHA256]::Create()
try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
if ($actual -ne $Digest) { throw 'fixture DLL digest mismatch' }
if ($Mode -eq 'Malformed') {
  $bytes[0] = 0; $bytes[1] = 0
  try { [void][Reflection.Assembly]::Load($bytes); throw 'malformed DLL unexpectedly loaded' }
  catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    if ($failure -isnot [BadImageFormatException]) { throw }
    @{ expectedFailure = $true; exceptionType = $failure.GetType().FullName; bytes = $bytes.Length } | ConvertTo-Json -Compress
    exit 0
  }
}
$loaded = [Reflection.Assembly]::Load($bytes)
$type = $loaded.GetType('WollipogProviderHomeLeaseIo', $true)
if ($Mode -eq 'Metadata') {
  $rename = $type.GetNestedType('RENAME', [Reflection.BindingFlags]::NonPublic)
  $status = $type.GetNestedType('IO_STATUS_BLOCK', [Reflection.BindingFlags]::NonPublic)
  $pointer = [IntPtr]::Size
  $rootOffset = [Runtime.InteropServices.Marshal]::OffsetOf($rename, 'Root').ToInt64()
  $lengthOffset = [Runtime.InteropServices.Marshal]::OffsetOf($rename, 'Length').ToInt64()
  $firstOffset = [Runtime.InteropServices.Marshal]::OffsetOf($rename, 'First').ToInt64()
  $statusBytes = [Runtime.InteropServices.Marshal]::SizeOf($status)
  if ($rootOffset -ne $pointer -or $lengthOffset -ne 2 * $pointer -or $firstOffset -ne $lengthOffset + 4 -or $statusBytes -ne 2 * $pointer) { throw 'native rename ABI layout incompatible' }
  $runtime = Runtime-Metadata
  $runtime['assemblyArchitecture'] = $loaded.GetName().ProcessorArchitecture.ToString()
  $runtime['references'] = @($loaded.GetReferencedAssemblies() | ForEach-Object { @{ name = $_.Name; version = $_.Version.ToString() } })
  $runtime['renameRootOffset'] = $rootOffset
  $runtime['renameLengthOffset'] = $lengthOffset
  $runtime['renameFirstOffset'] = $firstOffset
  $runtime['ioStatusBytes'] = $statusBytes
  $runtime['loadedFromBytes'] = ($loaded.Location.Length -eq 0)
  $runtime | ConvertTo-Json -Depth 5 -Compress
} elseif ($Mode -eq 'Snapshot') {
  # Binary input supplies an owned empty/small NTFS fixture, not a provider HOME.
  [void]$type.GetMethod('Run').Invoke($null, @())
} elseif ($Mode -eq 'ProbeFailure') {
  # Injection after real image loading, without changing or recompiling the fixed helper.
  if ($null -eq $type.GetMethod('DeliberatelyMissingProbe')) { throw 'injected execution-probe failure after verified image load' }
  throw 'unexpected method appeared'
} elseif ($Mode -eq 'Hold') {
  [void]$type.GetMethod('Probe').Invoke($null, @())
  $runtime = Runtime-Metadata
  $runtime['ready'] = $true
  [Console]::Out.WriteLine(($runtime | ConvertTo-Json -Compress)); [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'stop') { throw 'owned user control ended without normal stop' }
  @{ stopped = $true; processId = $PID } | ConvertTo-Json -Compress
}
