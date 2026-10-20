import { spawnSync } from "node:child_process";
import { windowsLeaseHelperImage } from "./provider-home-lease-assets.js";

const IPC_BYTES = 64 * 1024 * 1024;
let probed = false;

/** PS5 built-ins plus the unchanged trusted assembly; never compiler or temporary output. */
function byteLoader(hash: string, length: number, method: "Probe" | "Run"): string {
  const machine = process.arch === "arm64" ? 0xaa64 : 0x8664;
  const program = String.raw`
$ErrorActionPreference='Stop';
try {
 if($PSVersionTable.PSVersion.Major -ne 5 -or [IntPtr]::Size -ne 8){throw 'native PowerShell5 64-bit required'};
 $stream=[Console]::OpenStandardInput();$reader=[IO.BinaryReader]::new([IO.Stream]$stream,[Text.Encoding]::UTF8,$true);
 if([Text.Encoding]::ASCII.GetString($reader.ReadBytes(5)) -ne 'WPLA1'){throw 'invalid managed helper frame'};
 $n=$reader.ReadUInt32();if($n -ne ${length} -or $n -lt 1 -or $n -gt 65536){throw 'managed helper before-read bound'};
 [byte[]]$bytes=$reader.ReadBytes([int]$n);if($bytes.Length -ne $n){throw 'incomplete managed helper'};$reader.Dispose();
 $sha=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};
 if($actual -cne '${hash}'){throw 'managed helper digest mismatch'};
 $loaded=[Reflection.Assembly]::Load($bytes);if($loaded.Location.Length -ne 0 -or $loaded.GetName().ProcessorArchitecture.ToString() -cne 'MSIL'){throw 'managed byte loading unavailable'};
 $references=$loaded.GetReferencedAssemblies();if($references.Length -ne 3){throw 'managed helper reference count'};$seen=@{};
 foreach($ref in $references){if(@('mscorlib','System','System.Core') -cnotcontains $ref.Name -or $ref.Version.ToString() -cne '4.0.0.0' -or $seen.ContainsKey($ref.Name)){throw 'managed helper reference identity'};$seen[$ref.Name]=$true};
 $modules=[Diagnostics.Process]::GetCurrentProcess().Modules;if($modules.Count -gt 512){throw 'loaded module inventory limit'};
 $clr=@($modules | Where-Object {$_.ModuleName -ieq 'clr.dll'});if($clr.Count -ne 1){throw 'loaded CLR unavailable'};
 $native=[IO.File]::Open($clr[0].FileName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);$pe=[IO.BinaryReader]::new([IO.Stream]$native);
 try{if($pe.ReadUInt16() -ne 23117){throw 'CLR MZ'};[void]$native.Seek(60,[IO.SeekOrigin]::Begin);$offset=$pe.ReadUInt32();if($offset -gt $native.Length-6){throw 'CLR PE bound'};[void]$native.Seek($offset,[IO.SeekOrigin]::Begin);if($pe.ReadUInt32() -ne 17744 -or $pe.ReadUInt16() -ne ${machine}){throw 'loaded native CLR architecture mismatch'}}finally{$pe.Dispose();$native.Dispose()};
 $type=$loaded.GetType('WollipogProviderHomeLeaseIo',$true);$flags=[Reflection.BindingFlags]::NonPublic;
 $rename=$type.GetNestedType('RENAME',$flags);$status=$type.GetNestedType('IO_STATUS_BLOCK',$flags);$pointer=[IntPtr]::Size;
 $sizeOf=@([Runtime.InteropServices.Marshal].GetMethods() | Where-Object {$_.Name -eq 'SizeOf' -and -not $_.IsGenericMethod -and $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType -eq [Type]});
 if($sizeOf.Count -ne 1 -or [Runtime.InteropServices.Marshal]::OffsetOf($rename,'Root').ToInt64() -ne $pointer -or [Runtime.InteropServices.Marshal]::OffsetOf($rename,'Length').ToInt64() -ne 2*$pointer -or [Runtime.InteropServices.Marshal]::OffsetOf($rename,'First').ToInt64() -ne 2*$pointer+4 -or [int]$sizeOf[0].Invoke($null,[object[]]@($status)) -ne 2*$pointer){throw 'native helper ABI unavailable'};
 $type.GetMethod('${method}').Invoke($null,@())|Out-Null;
} catch {[Console]::Error.WriteLine('managed lease helper loading/proof unavailable; preserve all evidence');exit 2}
`;
  if (program.length > 8192) throw new Error("fixed managed loader command bound exceeded");
  return Buffer.from(program, "utf16le").toString("base64");
}
function framed(bytes: Buffer, input?: Buffer): Buffer {
  if (bytes.length < 1 || bytes.length > 65536 || (input && input.length > IPC_BYTES)) throw new Error("managed helper input byte limit exceeded");
  const header = Buffer.alloc(9); header.write("WPLA1"); header.writeUInt32LE(bytes.length, 5);
  return Buffer.concat([header, bytes, ...(input ? [input] : [])], 9 + bytes.length + (input?.length ?? 0));
}
export function windowsLeaseIoCommand(input?: Buffer, providerHome?: string): { command: string; args: string[]; input: Buffer } {
  if (process.platform !== "win32") throw new Error("native Windows lease I/O requires Windows");
  const image = windowsLeaseHelperImage(providerHome);
  const command = (method: "Probe" | "Run") => {
    const encoded = byteLoader(image.tuple.imageSha256, image.tuple.imageBytes, method);
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    if (args.join(" ").length + 128 > 32767) throw new Error("fixed managed loader exceeds native command-line bound");
    return { command: "powershell.exe", args, input: framed(image.bytes, method === "Run" ? input : undefined) };
  };
  if (!probed) {
    const probe = command("Probe");
    const result = spawnSync(probe.command, probe.args, { input: probe.input, timeout: 10000, maxBuffer: 65536, windowsHide: true, killSignal: "SIGKILL" });
    if (result.error || result.status !== 0) throw new Error("fixed managed lease helper probe failed; no fallback");
    probed = true;
  }
  return command("Run");
}
