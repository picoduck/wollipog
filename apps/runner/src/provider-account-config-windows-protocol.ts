/** Fixed WACW1 framing; no runtime program/module/operation selector beyond capture/publish. */
export const WACW_LIMITS = Object.freeze({ frame: 8 * 1024 * 1024, config: 2 * 1024 * 1024, assembly: 1024 * 1024 });
export type WindowsPublication = "not_published" | "unknown" | "committed";
export type WindowsCode = "SOURCE_BUSY" | "SOURCE_CHANGED" | "STORE_UNVERIFIABLE" | "CAPACITY" | "IO";
export class WindowsAccountConfigError extends Error {
  constructor(readonly publication: WindowsPublication, readonly code: WindowsCode, readonly verifiedTerminal = false) { super(`Windows account-config ${publication} (${code})`); }
}
export interface NativeCapture {
  path: string; configIdentity: string; configDigest: string; parentIdentity: string;
  storeEpoch: string; storeIdentity: string; revision: number; journalDigest: string; stamp: string; parentBirth: string; raw: Buffer;
}
export interface NativeRequest { operation: 1 | 2; path: string; stamp?: string; parentBirth?: string; beforeAccounts?: string; afterAccounts?: string; bindings?: string[]; next?: Buffer; fault?: number; }
const HASH = /^[0-9a-f]{64}$/u;
const CODES = new Set<WindowsCode>(["SOURCE_BUSY", "SOURCE_CHANGED", "STORE_UNVERIFIABLE", "CAPACITY", "IO"]);
function fail(): never { throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE"); }
function part(raw: Buffer): Buffer { const b = Buffer.alloc(4); b.writeInt32LE(raw.length); return Buffer.concat([b, raw]); }
function text(value: string, max: number): Buffer { const b = Buffer.from(value, "utf8"); if (b.length > max || value.includes("\0")) return fail(); return part(b); }
export function encodeWindowsRequest(request: NativeRequest): Buffer {
  if (request.operation !== 1 && request.operation !== 2 || !Number.isSafeInteger(request.fault ?? 0) || (request.fault ?? 0) < 0 || (request.fault ?? 0) > 6) return fail();
  const bindings = request.bindings ?? []; if (bindings.length > 512 || bindings.some(x => !HASH.test(x))) return fail();
  const next = request.next ?? Buffer.alloc(0); if (next.length > WACW_LIMITS.config) return fail();
  if (request.operation === 2 && (![request.stamp, request.beforeAccounts, request.afterAccounts].every(x => typeof x === "string" && HASH.test(x)) || !/^\d{1,20}$/u.test(request.parentBirth ?? "") || next.length === 0)) return fail();
  const pid = Buffer.alloc(4); pid.writeInt32LE(process.pid);
  const body = Buffer.concat([Buffer.from("WACW1"), Buffer.from([request.operation, request.fault ?? 0]), pid,
    text(request.path, 65536), text(request.stamp ?? "", 64), text(request.parentBirth ?? "", 32),
    text(request.beforeAccounts ?? "", 64), text(request.afterAccounts ?? "", 64), text(bindings.join("\n"), 65536), part(next)]);
  if (body.length + 4 > WACW_LIMITS.frame) return fail(); return part(body);
}
export function decodeWindowsReply(raw: Buffer, operation: 1 | 2): NativeCapture | undefined {
  if (raw.length < 11 || raw.length > WACW_LIMITS.frame || raw.readInt32LE(0) !== raw.length - 4 || raw.subarray(4, 9).toString() !== "WACW1") return fail();
  const kind = raw[9]!, state = raw[10]!; let offset = 11;
  function blob(max: number): Buffer { if (offset + 4 > raw.length) return fail(); const n = raw.readInt32LE(offset); offset += 4; if (n < 0 || n > max || offset + n > raw.length) return fail(); const b = raw.subarray(offset, offset += n); return b; }
  function string(max: number): string { const b = blob(max), s = b.toString("utf8"); if (!Buffer.from(s).equals(b) || s.includes("\0")) return fail(); return s; }
  const code = string(64), fields = Array.from({ length: 10 }, () => string(65536)), config = blob(WACW_LIMITS.config);
  if (offset !== raw.length || state > 2) return fail();
  if (kind === 0) { if (!CODES.has(code as WindowsCode) || fields.some(Boolean) || config.length) return fail(); throw new WindowsAccountConfigError((["not_published", "unknown", "committed"] as const)[state]!, code as WindowsCode, true); }
  if (kind !== operation || state !== 0 || code !== "") return fail();
  if (operation === 2) { if (fields.some(Boolean) || config.length) return fail(); return; }
  const [path, configIdentity, configDigest, parentIdentity, storeEpoch, storeIdentity, revision, journalDigest, stamp, parentBirth] = fields as [string,string,string,string,string,string,string,string,string,string];
  if (!path || !configIdentity || !parentIdentity || !HASH.test(configDigest) || !HASH.test(journalDigest) || !HASH.test(stamp) || !/^\d{1,20}$/u.test(parentBirth) || !/^(?:0|[1-9]\d{0,3})$/u.test(revision) || Number(revision) > 4096 || (storeEpoch === "") !== (storeIdentity === "")) return fail();
  return { path, configIdentity, configDigest, parentIdentity, storeEpoch, storeIdentity, revision: Number(revision), journalDigest, stamp, parentBirth, raw: Buffer.from(config) };
}
