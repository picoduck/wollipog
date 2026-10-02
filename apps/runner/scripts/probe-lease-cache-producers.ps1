# Opt-in #2316 experiment. All output is inside a caller-created synthetic private fixture.
# DeleteOnClose and observations intentionally confer neither a quota nor cleanup authority.
param(
  [ValidateSet('Describe', 'DeleteOnClose', 'AddType', 'Sharing', 'PipeSink')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$PipeName
)
$ErrorActionPreference = 'Stop'
$env:TEMP = $Root
$env:TMP = $Root
function Describe-Files {
  $files = @(Get-ChildItem -LiteralPath $Root -File)
  if ($files.Count -gt 128) { throw 'owned inventory exceeded 128 entries' }
  return @($files | ForEach-Object { @{ name = $_.Name; bytes = $_.Length } })
}
function Safe-Message($exception) {
  $text = [regex]::Replace($exception.Message, [regex]::Escape($Root), '<OwnedScratch>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  return $text.Substring(0, [Math]::Min(2048, $text.Length))
}
if ($Mode -eq 'Describe') {
  $runtime = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  @{ compiler = [IO.Path]::Combine($runtime, 'csc.exe'); runtime = [Environment]::Version.ToString() } | ConvertTo-Json -Compress
} elseif ($Mode -eq 'DeleteOnClose') {
  $path = [IO.Path]::Combine($Root, 'delete-on-close.bin')
  $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite,
    ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete), 4096, [IO.FileOptions]::DeleteOnClose)
  try {
    $block = New-Object byte[] 65536
    for ($index = 0; $index -lt 40; $index++) { $stream.Write($block, 0, $block.Length) }
    $bytes = $stream.Length
  } finally { $stream.Dispose() }
  @{ configuredComparisonLimit = 2097152; actualBytes = $bytes; deletedAfterClose = -not [IO.File]::Exists($path);
    scope = 'finite controlled counterexample: DeleteOnClose supplies no file-size quota' } | ConvertTo-Json -Compress
} elseif ($Mode -eq 'AddType' -or $Mode -eq 'Sharing') {
  $path = [IO.Path]::Combine($Root, $(if ($Mode -eq 'Sharing') { 'held.dll' } else { 'baseline.dll' }))
  $stream = $null
  if ($Mode -eq 'Sharing') {
    $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite,
      ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete), 4096, [IO.FileOptions]::DeleteOnClose)
  }
  $success = $false; $failure = $null; $bytes = 0
  try {
    $source = [IO.File]::ReadAllText([IO.Path]::Combine($Root, 'lease.cs'))
    Add-Type -TypeDefinition $source -OutputAssembly $path | Out-Null
    $success = $true
    $bytes = (Get-Item -LiteralPath $path).Length
  } catch { $failure = Safe-Message $_.Exception }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
  @{ success = $success; bytes = $bytes; failure = $failure; retained = Describe-Files;
    scope = 'normal compiler return observed; byte checks after Add-Type cannot bound earlier disk writes' } | ConvertTo-Json -Depth 5 -Compress
} elseif ($Mode -eq 'PipeSink') {
  if ($PipeName -notmatch '^wollipog-lease-probe-[0-9]+-[0-9]+$') { throw 'invalid owned pipe name' }
  $stream = New-Object IO.Pipes.NamedPipeServerStream($PipeName, [IO.Pipes.PipeDirection]::In, 1,
    [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 65536, 65536)
  $bytes = 0; $prefix = New-Object byte[] 2
  try {
    [Console]::Out.WriteLine('pipe-ready'); [Console]::Out.Flush()
    $stream.WaitForConnection()
    $buffer = New-Object byte[] 65536
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if ($bytes + $count -gt 2097152) { throw 'bounded pipe exceeded 2 MiB; refuse output' }
      for ($index = 0; $index -lt [Math]::Min($count, 2 - [Math]::Min($bytes, 2)); $index++) { $prefix[$bytes + $index] = $buffer[$index] }
      $bytes += $count
    }
    @{ bytes = $bytes; peHeader = ($prefix[0] -eq 77 -and $prefix[1] -eq 90);
      scope = 'pipe byte counter only; compiler intermediate writes require separate proof' } | ConvertTo-Json -Compress
  } finally { $stream.Dispose() }
}
