# Opt-in #2316 experiment; no runtime compilation and no canonical HOME access.
param(
  [ValidateSet('Describe', 'Metadata', 'Snapshot', 'Hold', 'Malformed', 'ProbeFailure')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Assembly,
  [string]$Digest
)
# First observable entry marker avoids cmdlet serialization and stays off binary stdout.
[Console]::Error.WriteLine('{"probePhase":true,"stage":"script-entry"}')
[Console]::Error.Flush()
$script:phaseClock = [Diagnostics.Stopwatch]::StartNew()
$script:phaseCount = 1
function Write-ProbePhase([string]$stage) {
  if ($stage -notmatch '^[a-z0-9-]{1,64}$' -or $script:phaseCount -ge 48) { throw 'phase diagnostic bound exceeded' }
  $script:phaseCount++
  $line = '{"probePhase":true,"stage":"' + $stage + '","elapsedMs":' + $script:phaseClock.ElapsedMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture) + '}'
  if ([Text.Encoding]::UTF8.GetByteCount($line) + 2 -gt 256) { throw 'phase diagnostic byte bound exceeded' }
  [Console]::Error.WriteLine($line)
  [Console]::Error.Flush()
}
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5 is required; no fallback' }
$env:TEMP = $Root
$env:TMP = $Root
Write-ProbePhase 'script-initialized'
function Read-Machine($path) {
  Write-ProbePhase 'native-module-open-before'
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  Write-ProbePhase 'native-module-open-after'
  $reader = [IO.BinaryReader]::new([IO.Stream]$stream)
  try {
    Write-ProbePhase 'native-mz-read-before'
    if ($reader.ReadUInt16() -ne 23117) { throw 'invalid native module MZ header' }
    Write-ProbePhase 'native-mz-read-after'
    Write-ProbePhase 'native-pe-offset-before'
    [void]$stream.Seek(60, [IO.SeekOrigin]::Begin)
    $offset = $reader.ReadUInt32()
    Write-ProbePhase 'native-pe-offset-after'
    if ($offset -gt $stream.Length - 6) { throw 'native PE header unavailable' }
    Write-ProbePhase 'native-pe-header-before'
    [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
    if ($reader.ReadUInt32() -ne 17744) { throw 'invalid native module PE header' }
    $machine = ('0x{0:x4}' -f $reader.ReadUInt16())
    Write-ProbePhase 'native-pe-header-after'
    return $machine
  } finally { $reader.Dispose(); $stream.Dispose() }
}
function Runtime-Metadata {
  Write-ProbePhase 'current-process-before'
  $process = [Diagnostics.Process]::GetCurrentProcess()
  Write-ProbePhase 'current-process-after'
  Write-ProbePhase 'modules-enumeration-before'
  $modules = $process.Modules
  Write-ProbePhase 'modules-enumeration-after'
  Write-ProbePhase 'clr-selection-before'
  $clr = @($modules | Where-Object { $_.ModuleName -ieq 'clr.dll' })
  Write-ProbePhase 'clr-selection-after'
  if ($clr.Count -ne 1) { throw 'exact loaded Framework CLR module unavailable' }
  Write-ProbePhase 'clr-path-before'
  $clrPath = $clr[0].FileName
  Write-ProbePhase 'clr-path-after'
  $machine = Read-Machine $clrPath
  Write-ProbePhase 'runtime-fields-before'
  $metadata = @{
    powerShellVersion = $PSVersionTable.PSVersion.ToString()
    edition = $PSVersionTable.PSEdition
    clrVersion = [Environment]::Version.ToString()
    loadedClrMachine = $machine
    pointerBytes = [IntPtr]::Size
    processId = $PID
    processStartUtcTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
    compiler = [IO.Path]::Combine([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(), 'csc.exe')
  }
  Write-ProbePhase 'runtime-fields-after'
  return $metadata
}
if ($Mode -eq 'Describe') {
  $metadata = Runtime-Metadata
  Write-ProbePhase 'describe-output-before'
  $metadata | ConvertTo-Json -Compress
  Write-ProbePhase 'describe-output-after'
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
Write-ProbePhase 'assembly-load-before'
$loaded = [Reflection.Assembly]::Load($bytes)
Write-ProbePhase 'assembly-load-after'
$type = $loaded.GetType('WollipogProviderHomeLeaseIo', $true)
if ($Mode -eq 'Metadata') {
  $rename = $type.GetNestedType('RENAME', [Reflection.BindingFlags]::NonPublic)
  $status = $type.GetNestedType('IO_STATUS_BLOCK', [Reflection.BindingFlags]::NonPublic)
  $pointer = [IntPtr]::Size
  $rootOffset = [Runtime.InteropServices.Marshal]::OffsetOf($rename, 'Root').ToInt64()
  $lengthOffset = [Runtime.InteropServices.Marshal]::OffsetOf($rename, 'Length').ToInt64()
  $firstOffset = [Runtime.InteropServices.Marshal]::OffsetOf($rename, 'First').ToInt64()
  # Select the exact non-generic Type signature; do not marshal the RuntimeType object.
  Write-ProbePhase 'marshal-sizeof-before'
  $sizeOfType = @([Runtime.InteropServices.Marshal].GetMethods([Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static) | Where-Object {
    $_.Name -eq 'SizeOf' -and -not $_.IsGenericMethod -and $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType -eq [Type]
  })
  if ($sizeOfType.Count -ne 1) { throw 'unambiguous Marshal.SizeOf(Type) unavailable' }
  $statusBytes = [int]$sizeOfType[0].Invoke($null, [object[]]@($status))
  Write-ProbePhase 'marshal-sizeof-after'
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
