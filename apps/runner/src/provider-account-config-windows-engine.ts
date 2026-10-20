/** Fixed synchronous engine asset. OS/administrator installation trust is a prerequisite, not child self-attestation. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { decodeWindowsReply, encodeWindowsRequest, WACW_LIMITS, WindowsAccountConfigError, type NativeRequest, type NativeCapture } from "./provider-account-config-windows-protocol.js";
declare const __WACW_DLL_SHA__: string;
declare const __WACW_FIXTURE__: boolean;
export const FIXED_WINDOWS_POWERSHELL = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
export const DLL_ASSET = "wollipog/account-config-windows-ntfs-v1";
export const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
export function fixedWindowsEnvironment(): NodeJS.ProcessEnv {
  // Deliberately do not inherit PATH, PS/CLR/DOTNET/COMPLUS/COR or Node command/module hooks.
  // These fixed child values do not modify the host environment or choose a launcher.
  return { SystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`, WINDIR: String.raw`\\?\GLOBALROOT\SystemRoot`,
    PSModuleAnalysisCachePath: "NUL" };
}
function program(expected: string, fixture: boolean): string {
  if (!/^[0-9a-f]{64}$/u.test(expected)) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  return `$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';` +
    `$i=[Console]::OpenStandardInput();$o=[Console]::OpenStandardOutput();` +
    `$l=[Array]::CreateInstance([byte],4);$at=0;while($at -lt 4){$n=$i.Read($l,$at,4-$at);if($n -le 0){throw 'short assembly header'};$at+=$n};` +
    `$size=[BitConverter]::ToInt32($l,0);if($size -le 0 -or $size -gt ${WACW_LIMITS.assembly}){throw 'assembly capacity'};` +
    `$b=[Array]::CreateInstance([byte],$size);$at=0;while($at -lt $size){$n=$i.Read($b,$at,$size-$at);if($n -le 0){throw 'short assembly'};$at+=$n};` +
    `$h=[Security.Cryptography.SHA256]::Create();try{$digest=[BitConverter]::ToString($h.ComputeHash($b)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};` +
    `if($digest -cne '${expected}'){throw 'assembly identity'};` +
    `$a=[Reflection.Assembly]::Load($b);$t=$a.GetType('WollipogAccountConfigWindowsV1',$true);` +
    (fixture ? `$value=$t.GetMethod('Fixture').Invoke($null,@($env:WACW_FIXTURE_PATH,$env:WACW_FIXTURE_MODE));if($value){[Console]::Write($value)};` : `$null=$t.GetMethod('Run').Invoke($null,@($i,$o));`);
}
function assembly(): Buffer {
  if (typeof __WACW_DLL_SHA__ !== "string") throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  const fixture = typeof __WACW_FIXTURE__ === "boolean" && __WACW_FIXTURE__;
  const b = isSea() ? Buffer.from(getAsset(DLL_ASSET)) : readFileSync(join(__dirname, fixture ? "provider-account-config-windows-fixture.dll" : "provider-account-config-windows-v1.dll"));
  if (b.length === 0 || b.length > WACW_LIMITS.assembly || sha256(b) !== __WACW_DLL_SHA__) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE"); return b;
}
function invoke(request: NativeRequest): NativeCapture | undefined {
  if (process.platform !== "win32" || process.arch !== "x64" && process.arch !== "arm64") throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  if (request.fault && !(typeof __WACW_FIXTURE__ === "boolean" && __WACW_FIXTURE__)) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  const dll = assembly(), prefix = Buffer.alloc(4); prefix.writeInt32LE(dll.length);
  const input = Buffer.concat([prefix, dll, encodeWindowsRequest(request)]);
  if (input.length > WACW_LIMITS.frame) throw new WindowsAccountConfigError("not_published", "CAPACITY");
  // Trust derives from the stated protected OS installation prerequisite, never a report from this child.
  const result = spawnSync(FIXED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program(__WACW_DLL_SHA__, false)],
    { input, env: fixedWindowsEnvironment(), shell: false, windowsHide: true, timeout: 10_000, killSignal: "SIGTERM", maxBuffer: WACW_LIMITS.frame });
  if (result.error || result.status !== 0 || result.signal || result.stderr.length !== 0) throw new WindowsAccountConfigError(request.operation === 2 ? "unknown" : "not_published", "IO");
  try { return decodeWindowsReply(result.stdout, request.operation); }
  catch (error) { if (error instanceof WindowsAccountConfigError && error.verifiedTerminal) throw error;
    // A malformed terminal result after a possible publication is not definitely unpublished.
    throw new WindowsAccountConfigError(request.operation === 2 ? "unknown" : "not_published", "STORE_UNVERIFIABLE"); }
}
export function capture(path: string): NativeCapture { return invoke({ operation: 1, path })!; }
export function publish(request: Omit<NativeRequest, "operation">): void { invoke({ ...request, operation: 2 }); }
function fixtureOperation(path: string, mode: "private" | "foreign-write" | "null-dacl" | "full-store" | "owner-path"): string {
  if (!(typeof __WACW_FIXTURE__ === "boolean" && __WACW_FIXTURE__) || isSea()) throw new Error("fixture-only native assembly required");
  const dll = assembly(), prefix = Buffer.alloc(4); prefix.writeInt32LE(dll.length);
  const result = spawnSync(FIXED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program(__WACW_DLL_SHA__, true)],
    { input: Buffer.concat([prefix, dll]), env: { ...fixedWindowsEnvironment(), WACW_FIXTURE_PATH: path, WACW_FIXTURE_MODE: mode }, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 32768 });
  if (result.error || result.status !== 0 || result.signal || result.stderr.length) throw new Error("native synthetic fixture creation failed");
  return result.stdout.toString("utf8");
}
export function createSyntheticFixture(path: string, mode: "private" | "foreign-write" | "null-dacl" | "full-store"): void { if (fixtureOperation(path, mode) !== "") throw new Error("unexpected fixture output"); }
export function foreignOwnerPath(): string { const path = fixtureOperation("", "owner-path"); if (!/^[A-Za-z]:\\/u.test(path) || path.includes("\0")) throw new Error("native owner fixture path missing"); return path; }
