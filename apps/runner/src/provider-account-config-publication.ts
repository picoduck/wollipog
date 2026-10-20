/** Local account-config observations; always history-incomplete, never HOME retirement authority. */
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { RunnerProviderAccount } from "./config.js";
import { captureWindowsAccountConfig, publishWindowsAccountConfig, type WindowsPreimage } from "./provider-account-config-windows.js";
import { WindowsAccountConfigError } from "./provider-account-config-windows-protocol.js";

interface Limits { intents: number; records: number; recordBytes: number; totalBytes: number; }
export const ACCOUNT_CONFIG_PUBLICATION_LIMITS: Readonly<Limits> = Object.freeze({
  intents: 4096, records: 8192, recordBytes: 32768, totalBytes: 256 * 1024 * 1024,
});
// Precharged before directory/header/guard/log creation, including directory entries and partial
// controls. Unknown entries or controls exceeding this reservation refuse further growth.
const CONTROL_BYTES = 64 * 1024;
const VERSION = 1;
const HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
type Accounts = readonly RunnerProviderAccount[];
type Normalize = (raw: unknown) => RunnerProviderAccount[];
type Phase = "guard" | "intent" | "temporary" | "before_rename" | "renamed" | "outcome";
/** Internal deterministic seams only; never selected by settings, environment or a wire message. */
export interface AccountConfigPublicationTestHooks {
  boundary?: (phase: Phase) => void;
  limits?: Partial<Limits>;
}
export class AccountConfigPublicationError extends Error {
  constructor(
    readonly publication: "not_published" | "unknown" | "committed",
    readonly code: "SOURCE_BUSY" | "SOURCE_CHANGED" | "STORE_UNVERIFIABLE" | "CAPACITY" | "IO",
  ) {
    super(publication === "committed"
      ? "runner configuration was published, but its durable observation could not be confirmed"
      : publication === "unknown"
        ? "runner configuration publication is unknown; credentials and evidence were retained"
        : `runner configuration account update refused (${code}); credentials were retained`);
    this.name = "AccountConfigPublicationError";
  }
}
/** Sanitized refusal guidance; never include raw I/O messages, config paths or credentials. */
export function accountConfigPublicationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof AccountConfigPublicationError)) return fallback;
  if (error.publication !== "not_published") return error.message;
  if (error.code !== "STORE_UNVERIFIABLE") return fallback;
  return `${fallback} Account publication proof is unavailable. On supported POSIX hosts, an operator must verify that the config and its parent directory are owned by the runner OS account and are not group- or world-writable; private publication evidence must also remain verifiable. Windows requires a supported native proof adapter and its documented trusted OS PowerShell/.NET installation prerequisite; config/store owner SIDs, DACLs and retained evidence must remain verifiable. Preserve the config, credential HOMEs and publication evidence; no automatic permission change or repair is attempted.`;
}
export function accountConfigPublicationMayHaveOccurred(error: unknown): boolean {
  return error instanceof AccountConfigPublicationError && error.publication !== "not_published";
}
interface Location { path: string; parent: string; parentIdentity: string; root: string; anchor: string; key: string; }
interface Tip { epoch: string | null; rootIdentity: string | null; revision: number; records: number; bytes: number; }
export interface AccountConfigPreimage {
  readonly backend?: "windows-wacw1";
  readonly windows?: WindowsPreimage;
  readonly path: string;
  readonly configIdentity: string;
  readonly configDigest: string;
  readonly accountsDigest: string;
  readonly accounts: Accounts;
  readonly parentIdentity: string;
  readonly storeEpoch: string | null;
  readonly storeIdentity: string | null;
  readonly revision: number;
}
interface Intent {
  kind: "intent"; version: 1; epoch: string; revision: number; ticket: string;
  beforeConfig: string; afterConfig: string; beforeAccounts: string; afterAccounts: string;
  bindings: string[]; reservedTemporaryBytes: number; reservedOutcomeBytes: number;
  historyIncomplete: true;
}
function need(ok: unknown, code: AccountConfigPublicationError["code"] = "STORE_UNVERIFIABLE"): asserts ok {
  if (!ok) throw new AccountConfigPublicationError("not_published", code);
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function identity(s: Stats): string { return `${s.dev}:${s.ino}`; }
function fileIdentity(s: Stats): string { return `${identity(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
function owned(path: string, directory: boolean, privateFile = true): Stats {
  need(typeof process.getuid === "function");
  const s = lstatSync(path);
  need(directory ? s.isDirectory() : s.isFile());
  need(s.uid === process.getuid() && (directory || s.nlink === 1));
  need((s.mode & (privateFile ? 0o077 : 0o022)) === 0);
  return s;
}
function location(configPath: string): Location {
  need(typeof process.getuid === "function");
  const parent = realpathSync(dirname(resolve(configPath)));
  const parentStat = owned(parent, true, false);
  const path = join(parent, basename(configPath));
  const key = digest(JSON.stringify([VERSION, path, identity(parentStat)]));
  return { path, parent, parentIdentity: identity(parentStat), root: join(parent, `.${basename(path)}.account-publications-v1`),
    anchor: join(parent, `.${basename(path)}.account-publications-anchor-v1`), key };
}
function checkParent(loc: Location): void { need(identity(owned(loc.parent, true, false)) === loc.parentIdentity); }
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAll(fd: number, b: Buffer): void {
  let offset = 0;
  while (offset < b.length) {
    const written = writeSync(fd, b, offset, b.length - offset);
    if (written < 1) throw new Error("short account-publication write");
    offset += written;
  }
}
function newFile(path: string, b: Buffer): string {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { writeAll(fd, b); fsyncSync(fd); return identity(fstatSync(fd)); } finally { closeSync(fd); }
}
function readExact(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, null);
    need(count > 0); offset += count;
  }
  // Bound observation even when an operator-controlled file grows concurrently.
  need(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, "SOURCE_CHANGED");
  return bytes;
}
function readPrivate(path: string, maxBytes: number): Buffer {
  const before = owned(path, false);
  need(before.size <= maxBytes, "CAPACITY");
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    need(identity(fstatSync(fd)) === identity(before));
    const b = readExact(fd, before.size);
    need(b.length === before.size && fileIdentity(owned(path, false)) === fileIdentity(before));
    return b;
  } finally { closeSync(fd); }
}
function limitsFor(hooks: AccountConfigPublicationTestHooks): Limits {
  const limits = { ...ACCOUNT_CONFIG_PUBLICATION_LIMITS, ...hooks.limits };
  for (const [key, value] of Object.entries(limits)) {
    need(Number.isSafeInteger(value) && value > 0 && value <= ACCOUNT_CONFIG_PUBLICATION_LIMITS[key as keyof Limits], "CAPACITY");
  }
  need(limits.totalBytes > CONTROL_BYTES, "CAPACITY");
  return limits;
}
function accountDigest(accounts: Accounts): string { return digest(JSON.stringify(accounts)); }
function bindings(accounts: Accounts): string[] {
  return accounts.map(a => digest(JSON.stringify(["account-binding-v1", a.id, a.provider, a.directory, a.profileId ?? null])));
}
function readConfig(loc: Location, normalize: Normalize, limits: Limits) {
  checkParent(loc);
  const before = owned(loc.path, false, false);
  need(before.size <= limits.totalBytes - CONTROL_BYTES, "CAPACITY");
  const fd = openSync(loc.path, constants.O_RDONLY | NOFOLLOW);
  try {
    need(fileIdentity(fstatSync(fd)) === fileIdentity(before));
    const raw = readExact(fd, before.size);
    need(raw.length === before.size && fileIdentity(owned(loc.path, false, false)) === fileIdentity(before), "SOURCE_CHANGED");
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    need(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    const object = parsed as Record<string, unknown>;
    return { raw, parsed: object, accounts: normalize(object.providerAccounts ?? []), identity: fileIdentity(before) };
  } finally { closeSync(fd); }
}
function exactKeys(row: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(row).sort().join(",") === [...expected].sort().join(",");
}
function readTip(loc: Location, limits: Limits, ownGuard = false): Tip {
  if (absent(loc.root)) {
    need(absent(loc.anchor));
    return { epoch: null, rootIdentity: null, revision: 0, records: 0, bytes: 0 };
  }
  const rootStat = owned(loc.root, true);
  const entries = opendirSync(loc.root, { bufferSize: 1 });
  try {
    for (let i = 0;; i++) {
      const entry = entries.readSync(); if (!entry) break;
      need(i < 3 && ["store.json", "journal.jsonl", "guard.json"].includes(entry.name));
      need(ownGuard || entry.name !== "guard.json", "SOURCE_BUSY");
    }
  } finally { entries.closeSync(); }
  const headerBytes = readPrivate(join(loc.root, "store.json"), limits.recordBytes);
  const header = JSON.parse(headerBytes.toString("utf8")) as Record<string, unknown>;
  need(exactKeys(header, ["epoch", "historyIncomplete", "key", "version"]) && header.version === VERSION && header.historyIncomplete === true && header.key === loc.key && UUID.test(String(header.epoch)));
  const anchorBytes = readPrivate(loc.anchor, limits.recordBytes);
  const anchor = JSON.parse(anchorBytes.toString("utf8")) as Record<string, unknown>;
  need(exactKeys(anchor, ["epoch", "historyIncomplete", "key", "rootIdentity", "version"])
    && anchor.version === VERSION && anchor.historyIncomplete === true && anchor.key === loc.key
    && anchor.epoch === header.epoch && anchor.rootIdentity === identity(rootStat));
  const guardBytes = ownGuard ? readPrivate(join(loc.root, "guard.json"), 1024).length : 0;
  need(rootStat.size + headerBytes.length + anchorBytes.length + guardBytes <= CONTROL_BYTES, "CAPACITY");
  const logPath = join(loc.root, "journal.jsonl");
  const logStat = owned(logPath, false);
  need(logStat.size + CONTROL_BYTES <= limits.totalBytes, "CAPACITY");
  const fd = openSync(logPath, constants.O_RDONLY | NOFOLLOW);
  let records = 0, revision = 0, pending: Intent | null = null, rest: Buffer = Buffer.alloc(0), consumed = 0;
  try {
    need(identity(fstatSync(fd)) === identity(logStat));
    const block = Buffer.alloc(Math.min(limits.recordBytes, 32768));
    for (;;) {
      const count = readSync(fd, block, 0, block.length, null); if (count === 0) break;
      consumed += count; need(consumed <= logStat.size);
      rest = Buffer.concat([rest, block.subarray(0, count)]);
      for (;;) {
        const newline = rest.indexOf(10); if (newline < 0) break;
        need(newline + 1 <= limits.recordBytes, "CAPACITY");
        const bytes = rest.subarray(0, newline), text = bytes.toString("utf8");
        need(Buffer.from(text, "utf8").equals(bytes));
        const row: unknown = JSON.parse(text);
        need(row && typeof row === "object" && !Array.isArray(row));
        const r = row as Record<string, unknown>;
        need(++records <= limits.records, "CAPACITY");
        need(r.version === VERSION && r.epoch === header.epoch && r.historyIncomplete === true);
        if (r.kind === "intent") {
          need(exactKeys(r, ["kind", "version", "epoch", "revision", "ticket", "beforeConfig", "afterConfig", "beforeAccounts", "afterAccounts", "bindings", "reservedTemporaryBytes", "reservedOutcomeBytes", "historyIncomplete"]));
          need(!pending && r.revision === revision + 1 && Number(r.revision) <= limits.intents, "CAPACITY");
          need(UUID.test(String(r.ticket)) && [r.beforeConfig, r.afterConfig, r.beforeAccounts, r.afterAccounts].every(v => typeof v === "string" && HEX.test(v)));
          need(Array.isArray(r.bindings) && r.bindings.length <= 64 && r.bindings.every(v => typeof v === "string" && HEX.test(v)));
          need(Number.isSafeInteger(r.reservedTemporaryBytes) && Number(r.reservedTemporaryBytes) >= 0 && Number(r.reservedTemporaryBytes) <= limits.totalBytes);
          need(r.reservedOutcomeBytes === limits.recordBytes);
          pending = r as unknown as Intent; revision = Number(r.revision);
        } else {
          need(exactKeys(r, ["kind", "version", "epoch", "revision", "ticket", "configDigest", "historyIncomplete"]));
          need(pending && (r.kind === "published" || r.kind === "aborted") && r.revision === pending.revision && r.ticket === pending.ticket);
          need(r.configDigest === (r.kind === "published" ? pending.afterConfig : pending.beforeConfig));
          pending = null;
        }
        rest = rest.subarray(newline + 1);
      }
      need(rest.length < limits.recordBytes, "CAPACITY");
    }
    need(rest.length === 0 && consumed === logStat.size && !pending);
    need(fileIdentity(owned(logPath, false)) === fileIdentity(logStat));
  } finally { closeSync(fd); }
  checkParent(loc);
  need(identity(owned(loc.root, true)) === identity(rootStat));
  return { epoch: String(header.epoch), rootIdentity: identity(rootStat), revision, records, bytes: logStat.size };
}
/** Capture before an asynchronous caller decision; do not recreate the ticket at commit. */
export function captureAccountConfigPreimage(configPath: string, expectedAccounts: Accounts, normalize: Normalize): AccountConfigPreimage {
  if (process.platform === "win32") {
    try { return captureWindowsAccountConfig(configPath, expectedAccounts, normalize); }
    catch (error) {
      if (error instanceof WindowsAccountConfigError) throw new AccountConfigPublicationError(error.publication, error.code);
      throw new AccountConfigPublicationError("not_published", "STORE_UNVERIFIABLE");
    }
  }
  try {
    const limits = ACCOUNT_CONFIG_PUBLICATION_LIMITS, loc = location(configPath);
    const first = readTip(loc, limits), config = readConfig(loc, normalize, limits), second = readTip(loc, limits);
    need(JSON.stringify(first) === JSON.stringify(second), "SOURCE_CHANGED");
    need(accountDigest(config.accounts) === accountDigest(expectedAccounts), "SOURCE_CHANGED");
    const accounts = Object.freeze(config.accounts.map(a => Object.freeze({ ...a })));
    return Object.freeze({ path: loc.path, configIdentity: config.identity, configDigest: digest(config.raw), accountsDigest: accountDigest(accounts), accounts,
      parentIdentity: loc.parentIdentity, storeEpoch: first.epoch, storeIdentity: first.rootIdentity, revision: first.revision });
  } catch (error) {
    if (error instanceof AccountConfigPublicationError) throw error;
    throw new AccountConfigPublicationError("not_published", "STORE_UNVERIFIABLE");
  }
}
function appendRecord(loc: Location, value: object, limits: Limits, temporaryReservation: number, outcomeReservation: number): void {
  const b = Buffer.from(`${JSON.stringify(value)}\n`);
  need(b.length <= limits.recordBytes, "CAPACITY");
  const path = join(loc.root, "journal.jsonl"), before = owned(path, false);
  need(before.size + b.length + CONTROL_BYTES + temporaryReservation + outcomeReservation <= limits.totalBytes, "CAPACITY");
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
  try { need(identity(fstatSync(fd)) === identity(before)); writeAll(fd, b); fsyncSync(fd); } finally { closeSync(fd); }
}
/** Publish one captured ticket; no source barrier, recovery or physical retirement executor. */
export function publishAccountConfig(
  preimage: AccountConfigPreimage, nextAccounts: RunnerProviderAccount[], normalize: Normalize,
  hooks: AccountConfigPublicationTestHooks = {},
): void {
  if (process.platform === "win32") {
    try {
      need(Object.keys(hooks).length === 0); // Native fault seams exist only in the separately built fixture assembly.
      publishWindowsAccountConfig(preimage, nextAccounts, normalize); return;
    } catch (error) {
      if (error instanceof WindowsAccountConfigError) throw new AccountConfigPublicationError(error.publication, error.code);
      if (error instanceof AccountConfigPublicationError) throw error;
      throw new AccountConfigPublicationError("not_published", "STORE_UNVERIFIABLE");
    }
  }
  need(preimage.backend === undefined && preimage.windows === undefined, "SOURCE_CHANGED");
  let loc: Location | undefined, guardIdentity: string | undefined;
  let intentAttempted = false, renameAttempted = false, committed = false;
  try {
    const limits = limitsFor(hooks), validated = normalize(nextAccounts); loc = location(preimage.path);
    need(loc.parentIdentity === preimage.parentIdentity, "SOURCE_CHANGED");
    const config = readConfig(loc, normalize, limits);
    need(config.identity === preimage.configIdentity && digest(config.raw) === preimage.configDigest && accountDigest(config.accounts) === preimage.accountsDigest, "SOURCE_CHANGED");
    const next = Buffer.from(`${JSON.stringify({ ...config.parsed, providerAccounts: validated }, null, 2)}\n`);
    const initial = readTip(loc, limits);
    need(initial.epoch === preimage.storeEpoch && initial.rootIdentity === preimage.storeIdentity && initial.revision === preimage.revision, "SOURCE_CHANGED");
    need(initial.revision < limits.intents && initial.records + 2 <= limits.records, "CAPACITY");
    need(initial.bytes + CONTROL_BYTES + next.length + 2 * limits.recordBytes <= limits.totalBytes, "CAPACITY");
    let created = false;
    try { mkdirSync(loc.root, { mode: 0o700 }); created = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    owned(loc.root, true);
    const guardPath = join(loc.root, "guard.json");
    try { guardIdentity = newFile(guardPath, Buffer.from(`${JSON.stringify({ version: VERSION, ticket: randomUUID() })}\n`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AccountConfigPublicationError("not_published", "SOURCE_BUSY");
      throw error;
    }
    hooks.boundary?.("guard");
    if (created) {
      need(preimage.storeEpoch === null && preimage.revision === 0, "SOURCE_CHANGED");
      const header = { version: VERSION, key: loc.key, epoch: randomUUID(), historyIncomplete: true };
      // A missing or replaced store cannot silently bootstrap a new epoch. The separate immutable
      // anchor is not a claim against an operator restoring or erasing every piece of evidence.
      newFile(loc.anchor, Buffer.from(`${JSON.stringify({ ...header, rootIdentity: identity(owned(loc.root, true)) })}\n`));
      syncDirectory(loc.parent);
      newFile(join(loc.root, "store.json"), Buffer.from(`${JSON.stringify(header)}\n`));
      newFile(join(loc.root, "journal.jsonl"), Buffer.alloc(0));
      syncDirectory(loc.root); syncDirectory(loc.parent);
    }
    const tip = readTip(loc, limits, true);
    need(tip.revision === preimage.revision && (created || tip.epoch === preimage.storeEpoch && tip.rootIdentity === preimage.storeIdentity), "SOURCE_CHANGED");
    const current = readConfig(loc, normalize, limits);
    need(current.identity === preimage.configIdentity && digest(current.raw) === preimage.configDigest, "SOURCE_CHANGED");
    const ticket = randomUUID();
    const intent: Intent = { kind: "intent", version: VERSION, epoch: tip.epoch!, revision: tip.revision + 1, ticket,
      beforeConfig: preimage.configDigest, afterConfig: digest(next), beforeAccounts: preimage.accountsDigest, afterAccounts: accountDigest(validated),
      bindings: [...bindings(preimage.accounts), ...bindings(validated)], reservedTemporaryBytes: next.length,
      reservedOutcomeBytes: limits.recordBytes, historyIncomplete: true };
    intentAttempted = true;
    appendRecord(loc, intent, limits, next.length, limits.recordBytes);
    hooks.boundary?.("intent");
    const temporary = join(loc.parent, `.${basename(loc.path)}.account-${ticket}.tmp`);
    const temporaryIdentity = newFile(temporary, next);
    hooks.boundary?.("temporary");
    checkParent(loc);
    need(identity(owned(loc.root, true)) === tip.rootIdentity);
    need(identity(owned(guardPath, false)) === guardIdentity);
    const final = readConfig(loc, normalize, limits);
    need(final.identity === preimage.configIdentity && digest(final.raw) === preimage.configDigest, "SOURCE_CHANGED");
    need(identity(owned(temporary, false)) === temporaryIdentity);
    renameAttempted = true;
    hooks.boundary?.("before_rename");
    renameSync(temporary, loc.path); committed = true;
    hooks.boundary?.("renamed");
    syncDirectory(loc.parent);
    need(identity(owned(loc.root, true)) === tip.rootIdentity);
    appendRecord(loc, { kind: "published", version: VERSION, epoch: intent.epoch, revision: intent.revision, ticket,
      configDigest: intent.afterConfig, historyIncomplete: true }, limits, 0, 0);
    hooks.boundary?.("outcome");
    need(identity(owned(guardPath, false)) === guardIdentity);
    unlinkSync(guardPath); guardIdentity = undefined;
    // Publication and outcome are already durable. A crash resurrecting an unflushed guard can
    // only refuse future mutations; it must not turn this committed config into false rollback.
    try { syncDirectory(loc.root); } catch { /* conservative availability only */ }
  } catch (error) {
    // Once intent append starts, keep partials, temporaries and the guard. No automatic recovery
    // infers a publication outcome from today's config bytes or an apparently dead owner.
    if (!intentAttempted && loc && guardIdentity) {
      try {
        const guard = join(loc.root, "guard.json");
        if (identity(owned(guard, false)) === guardIdentity) { unlinkSync(guard); syncDirectory(loc.root); }
      } catch { /* never remove another writer's control */ }
    }
    const code = error instanceof AccountConfigPublicationError ? error.code : "IO";
    if (committed) throw new AccountConfigPublicationError("committed", code);
    if (renameAttempted) throw new AccountConfigPublicationError("unknown", code);
    if (error instanceof AccountConfigPublicationError) throw error;
    throw new AccountConfigPublicationError("not_published", code);
  }
}
