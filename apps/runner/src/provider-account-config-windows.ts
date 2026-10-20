/** Windows wrapper; the installed OS is trusted, configuration paths/bytes are not. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { runInThisContext } from "node:vm";
import { WindowsAccountConfigError, type NativeCapture, type NativeRequest } from "./provider-account-config-windows-protocol.js";
import type { RunnerProviderAccount } from "./config.js";
import type { AccountConfigPreimage } from "./provider-account-config-publication.js";
declare const __WACW_ENGINE_SHA__: string;
export const WINDOWS_ENGINE_ASSET = "wollipog/account-config-windows-engine-wacw1";
export interface WindowsPreimage { readonly captured: NativeCapture; readonly source: string; }
interface Engine { capture(path: string): NativeCapture; publish(request: Omit<NativeRequest, "operation">): void; }
function call<T>(operation: 1 | 2, action: () => T): T {
  try { return action(); } catch (error) {
    // The fixed CJS engine contains its own class instance. Validate its finite error values
    // rather than relying on instanceof across separately bundled modules.
    if (error && typeof error === "object" && "publication" in error && "code" in error &&
      ["not_published","unknown","committed"].includes(String(error.publication)) &&
      ["SOURCE_BUSY","SOURCE_CHANGED","STORE_UNVERIFIABLE","CAPACITY","IO"].includes(String(error.code)))
      throw new WindowsAccountConfigError(error.publication as WindowsAccountConfigError["publication"], error.code as WindowsAccountConfigError["code"]);
    throw new WindowsAccountConfigError(operation === 2 ? "unknown" : "not_published", "IO");
  }
}
const hash = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
let fixedEngine: Engine | undefined;
function engine(): Engine {
  if (fixedEngine) return fixedEngine;
  if (typeof __WACW_ENGINE_SHA__ !== "string" || !/^[0-9a-f]{64}$/u.test(__WACW_ENGINE_SHA__)) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  const filename = typeof __filename === "string" ? __filename : "";
  if (!filename && !isSea()) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  const base = dirname(filename || process.execPath), artifact = join(base, "provider-account-config-windows-engine.cjs");
  const code = isSea() ? Buffer.from(getAsset(WINDOWS_ENGINE_ASSET)) : readFileSync(artifact);
  if (code.length > 1024 * 1024 || hash(code) !== __WACW_ENGINE_SHA__) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  const require = createRequire(filename || process.execPath), target = { exports: {} as Engine };
  const load = runInThisContext(`(function(exports,require,module,__filename,__dirname){${code.toString("utf8")}\n})`, { filename: artifact });
  load(target.exports, (name: string) => { if (!name.startsWith("node:")) throw new Error("fixed engine may import only builtins"); return require(name); }, target, artifact, base);
  if (typeof target.exports.capture !== "function" || typeof target.exports.publish !== "function") throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  fixedEngine = target.exports; return fixedEngine;
}
export function captureWindowsAccountConfig(path: string, expected: readonly RunnerProviderAccount[], normalize: (v: unknown) => RunnerProviderAccount[]): AccountConfigPreimage {
  const fixed = engine(), captured = call(1, () => fixed.capture(path)), source = captured.raw.toString("utf8");
  if (!Buffer.from(source).equals(captured.raw) || hash(captured.raw) !== captured.configDigest) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  const parsed: unknown = JSON.parse(source); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WindowsAccountConfigError("not_published", "STORE_UNVERIFIABLE");
  const accounts = normalize((parsed as Record<string, unknown>).providerAccounts);
  if (hash(JSON.stringify(accounts)) !== hash(JSON.stringify(expected))) throw new WindowsAccountConfigError("not_published", "SOURCE_CHANGED");
  const frozen = Object.freeze(accounts.map(a => Object.freeze({ ...a })));
  return Object.freeze({ backend: "windows-wacw1" as const, path: captured.path, configIdentity: captured.configIdentity, configDigest: captured.configDigest,
    accountsDigest: hash(JSON.stringify(frozen)), accounts: frozen, parentIdentity: captured.parentIdentity, storeEpoch: captured.storeEpoch || null,
    storeIdentity: captured.storeIdentity || null, revision: captured.revision, windows: Object.freeze({ captured: Object.freeze({ ...captured, raw: Buffer.alloc(0) }), source }) });
}
export function publishWindowsAccountConfig(preimage: AccountConfigPreimage, accounts: RunnerProviderAccount[], normalize: (v: unknown) => RunnerProviderAccount[]): void {
  if (preimage.backend !== "windows-wacw1" || !preimage.windows) throw new WindowsAccountConfigError("not_published", "SOURCE_CHANGED");
  const next = normalize(accounts), payload = preimage.windows;
  if (hash(payload.source) !== preimage.configDigest || hash(JSON.stringify(preimage.accounts)) !== preimage.accountsDigest) throw new WindowsAccountConfigError("not_published", "SOURCE_CHANGED");
  const parsed = JSON.parse(payload.source) as Record<string, unknown>;
  const bindings = [...preimage.accounts, ...next].map(a => hash(JSON.stringify(["account-binding-v1", a.id, a.provider, a.directory, a.profileId ?? null])));
  const fixed = engine(); call(2, () => fixed.publish({ path: preimage.path, stamp: payload.captured.stamp, parentBirth: payload.captured.parentBirth, beforeAccounts: preimage.accountsDigest,
    afterAccounts: hash(JSON.stringify(next)), bindings, next: Buffer.from(`${JSON.stringify({ ...parsed, providerAccounts: next }, null, 2)}\n`) }));
}
