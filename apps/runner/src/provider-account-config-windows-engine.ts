/** Fixed synchronous engine asset. OS/administrator installation trust is a prerequisite, not child self-attestation. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { decodeWindowsReply, encodeWindowsRequest, WACW_LIMITS, WindowsAccountConfigError, type NativeRequest, type NativeCapture } from "./provider-account-config-windows-protocol.js";
declare const __WACW_DLL_SHA__: string;
declare const __WACW_FIXTURE__: boolean;
export const FIXED_WINDOWS_POWERSHELL = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const OS_ANCHOR = String.raw`\\?\GLOBALROOT\SystemRoot`, OS_IMAGE = String.raw`System32\WindowsPowerShell\v1.0\powershell.exe`;
export const DLL_ASSET = "wollipog/account-config-windows-ntfs-v1";
export const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
export function validateWindowsPlatform(systemRoot: string, executable: string): Readonly<{ systemRoot: string; executable: string }> {
  const parts = systemRoot.slice(3).split("\\");
  if (!/^[A-Za-z]:\\/u.test(systemRoot) || systemRoot.length > 200 ||
      parts.some(p => !p || p === "." || p === ".." || /[ .]$/u.test(p) || /[\x00-\x1f<>:"|?*]/u.test(p)) ||
      executable.length > 259 || executable.toLowerCase() !== (systemRoot + "\\" + OS_IMAGE).toLowerCase())
    throw new Error("unproved canonical Windows OS launcher");
  return Object.freeze({ systemRoot, executable });
}
export function resolveWindowsPlatform(): Readonly<{ systemRoot: string; executable: string }> {
  if (process.platform !== "win32") throw new Error("Windows OS required");
  return validateWindowsPlatform(realpathSync.native(OS_ANCHOR), realpathSync.native(FIXED_WINDOWS_POWERSHELL));
}
export function fixedWindowsEnvironment(systemRoot: string): NodeJS.ProcessEnv {
  // Startup hooks stay absent; explicit empty PATH prevents libuv's parent-PATH refill.
  // libuv still supplies other Windows compatibility fields; this is not the full effective env.
  return { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: "", PSModuleAnalysisCachePath: "NUL" };
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
    (fixture ? `$value=$t.GetMethod('Fixture').Invoke($null,@($env:WACW_FIXTURE_PATH,$env:WACW_FIXTURE_MODE));if($value){$v=[System.Text.Encoding]::UTF8.GetBytes($value);if($v.Length -gt 32768){throw 'fixture output capacity'};$o.Write($v,0,$v.Length);$o.Flush()};` : `$null=$t.GetMethod('Run').Invoke($null,@($i,$o));`);
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
  // Same protected OS image, resolved read-only; never PATH/env selection or child self-attestation.
  let platform: Readonly<{ systemRoot: string; executable: string }>;
  try { platform = resolveWindowsPlatform(); }
  catch { throw new WindowsAccountConfigError(request.operation === 2 ? "unknown" : "not_published", "IO"); }
  const result = spawnSync(platform.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program(__WACW_DLL_SHA__, false)],
    { input, env: fixedWindowsEnvironment(platform.systemRoot), shell: false, windowsHide: true, timeout: 10_000, killSignal: "SIGTERM", maxBuffer: WACW_LIMITS.frame });
  if (result.error || result.status !== 0 || result.signal || result.stderr.length !== 0) throw new WindowsAccountConfigError(request.operation === 2 ? "unknown" : "not_published", "IO");
  try { return decodeWindowsReply(result.stdout, request.operation); }
  catch (error) {
    // Only a strict, verified failure frame may expose its finite native diagnostic tag.
    if (error instanceof WindowsAccountConfigError && error.verifiedTerminal) throw error;
    // A malformed terminal result after a possible publication is not definitely unpublished.
    throw new WindowsAccountConfigError(request.operation === 2 ? "unknown" : "not_published", "STORE_UNVERIFIABLE"); }
}
export function capture(path: string): NativeCapture { return invoke({ operation: 1, path })!; }
export function publish(request: Omit<NativeRequest, "operation">): void { invoke({ ...request, operation: 2 }); }
function fixtureOperation(path: string, mode: "private" | "foreign-write" | "null-dacl" | "full-store" | "owner-path" | "directory-alias-path"): string {
  if (!(typeof __WACW_FIXTURE__ === "boolean" && __WACW_FIXTURE__) || isSea()) throw new Error("fixture-only native assembly required");
  const dll = assembly(), prefix = Buffer.alloc(4); prefix.writeInt32LE(dll.length);
  const platform = resolveWindowsPlatform();
  const result = spawnSync(platform.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program(__WACW_DLL_SHA__, true)],
    { input: Buffer.concat([prefix, dll]), env: { ...fixedWindowsEnvironment(platform.systemRoot), WACW_FIXTURE_PATH: path, WACW_FIXTURE_MODE: mode }, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 32768 });
  if (result.error || result.status !== 0 || result.signal || result.stderr.length) throw new Error("native synthetic fixture creation failed");
  const value = result.stdout.toString("utf8");
  if (!Buffer.from(value).equals(result.stdout)) throw new Error("invalid synthetic fixture output");
  return value;
}
export function createSyntheticFixture(path: string, mode: "private" | "foreign-write" | "null-dacl" | "full-store"): void { if (fixtureOperation(path, mode) !== "") throw new Error("unexpected fixture output"); }
export function foreignOwnerPath(): string { const path = fixtureOperation("", "owner-path"); if (!/^[A-Za-z]:\\/u.test(path) || path.includes("\0")) throw new Error("native owner fixture path missing"); return path; }

/** Source fixture only: no retry/fallback or fabricated alias when proof is unavailable. */
export function directoryAliasPath(path: string): string {
  let alias: string;
  try { alias = fixtureOperation(path, "directory-alias-path"); }
  catch { throw new Error("genuine directory alias proof was not established"); }
  if (!/^[A-Za-z]:\\/u.test(alias) || alias.includes("\0")) throw new Error("genuine directory alias proof was not established");
  return alias;
}
