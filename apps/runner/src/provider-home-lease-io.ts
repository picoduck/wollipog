import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import { windowsLeaseIoCommand } from "./provider-home-lease-windows-io.js";
import { leaseHelperParent, LeaseHelperArtifact } from "./provider-home-lease-staging.js";

const ASSET = "wollipog/provider-home-lease-io";
export type LeaseIoWork = { records: number; bytes: number };
let workObserver: ((work: LeaseIoWork) => void) | undefined;
export function observeLeaseIoWorkForTest(observer?: (work: LeaseIoWork) => void): void { workObserver = observer; }
/** One fixed-helper call, so a slow-host deadline is distinguishable from a missing helper. */
export type LeaseIoRun = { durationMs: number; timeoutMs: number; error?: string; signal: NodeJS.Signals | null; status: number | null };
let runObserver: ((run: LeaseIoRun) => void) | undefined;
export function observeLeaseIoRunsForTest(observer?: (run: LeaseIoRun) => void): void { runObserver = observer; }
let rejectProbeForTest: ((path: string) => boolean) | undefined;
/** May only reject an otherwise successful fixed-helper probe; cannot bypass its checks. */
export function refuseLeaseIoProbeForTest(predicate?: (path: string) => boolean): void { rejectProbeForTest = predicate; }
const DEFAULT_BUDGET = { records: 131072, bytes: 268435456 };
const IPC_BYTES = 64 * 1024 * 1024;
const RECORD_BYTES = 2 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 120_000;
const NAME = /^[a-z0-9._-]{1,255}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/u;
let executable: LeaseHelperArtifact | undefined;
let ioOptions: { helperDataDir?: string; fenceWaitMs?: number; providerHome?: string } = {};
export function withLeaseIoOptions<T>(options: typeof ioOptions, action: () => T): T {
  const previous = ioOptions; ioOptions = { ...previous, ...options };
  try { return action(); } finally { ioOptions = previous; }
}
const HELPER_UNAVAILABLE = "provider-HOME lease helper unavailable; restore the packaged fixed helper and an executable temporary or configured runner data directory; preserve all lease evidence and retry";
function stagingRoots(): string[] {
  return [...new Set([tmpdir(), ...(ioOptions.helperDataDir ? [ioOptions.helperDataDir] : [])].flatMap(root => {
    try { return [leaseHelperParent(root, ioOptions.providerHome)]; } catch { return []; }
  }))];
}

export interface LeaseIoIdentity { device: string; inode: string }
export interface LeaseIoEntry extends LeaseIoIdentity {
  directory: "root" | "lock";
  name: string;
  stamp: string;
  mode: number;
  links: number;
  uid: number;
  raw: Buffer;
  optional?: boolean;
}
export interface LeaseIoSnapshot {
  root: string;
  rootIdentity: LeaseIoIdentity;
  lockIdentity?: LeaseIoIdentity;
  entries: LeaseIoEntry[];
  work: { records: number; bytes: number };
}
export interface LeaseIoJob {
  /** Empty for retirement of the already selected checkpoint; otherwise one of the two slots. */
  name: string;
  raw: Buffer;
  copiesOwner: boolean;
  retire: number[];
}
export interface LeaseIoPlan {
  snapshot: LeaseIoSnapshot;
  guard: Buffer;
  guardTemp: string;
  tipIndex: number;
  future: string;
  jobs: LeaseIoJob[];
  barrier?: { boundary: string; marker: string };
}

/** Fixed bootstrap artifacts have independent immutable identity and bounded byte checks. */
function nativeExecutable(): string {
  if (executable) {
    try {
      leaseHelperParent(executable.root, ioOptions.providerHome);
      executable.verify();
      return executable.path;
    } catch { throw new LeaseIoError("unavailable", HELPER_UNAVAILABLE); }
  }
  for (const parent of stagingRoots()) {
    let artifact: LeaseHelperArtifact | undefined;
    try {
      artifact = new LeaseHelperArtifact(parent, "lease-io");
      const path = artifact.path;
      if (isSea()) {
        let bytes: Uint8Array;
        try { bytes = new Uint8Array(getAsset(ASSET)); } catch { throw new Error("the packaged provider-HOME lease helper is unavailable"); }
        writeFileSync(path, bytes, { flag: "wx", mode: 0o700 });
      } else {
        const source = fileURLToPath(new URL("../native/provider-home-lease-io.c", import.meta.url ?? pathToFileURL(__filename).href));
        const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
        const args = ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", ...(process.platform === "linux" ? ["-static"] : []), source, "-o", path];
        const compiled = spawnSync(compiler, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
        if (compiled.error || compiled.status !== 0) throw new Error("the fixed provider-HOME lease helper could not be compiled", { cause: new Error((compiled.stderr ?? "").slice(0, 2_048)) });
        chmodSync(path, 0o700);
      }
      artifact.capture();
      const probe = spawnSync(path, ["--probe"], { timeout: 10_000, maxBuffer: 1024, env: {} });
      artifact.verify();
      if (probe.error || probe.status !== 0 || rejectProbeForTest?.(path)) throw new Error("helper execution probe failed");
      executable = artifact;
      process.once("exit", artifact.cleanup);
      return path;
    } catch { artifact?.cleanup(); }
  }
  throw new LeaseIoError("unavailable", HELPER_UNAVAILABLE);
}

/** Prove availability before creating any HOME lease publication. */
export function ensureLeaseIoAvailable(): void {
  try { if (process.platform === "win32") windowsLeaseIoCommand(stagingRoots(), ioOptions.providerHome); else nativeExecutable(); }
  catch { throw new LeaseIoError("unavailable", HELPER_UNAVAILABLE); }
}

class Writer {
  private chunks: Buffer[] = [];
  private size = 0;
  bytes(value: Uint8Array): void {
    this.size += value.length;
    if (this.size > IPC_BYTES) throw new Error("provider-HOME lease IPC byte limit exceeded");
    this.chunks.push(Buffer.from(value));
  }
  u8(value: number): void { this.bytes(Buffer.from([value])); }
  u64(value: number): void { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); this.bytes(bytes); }
  u32(value: number): void { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); this.bytes(bytes); }
  blob(value: Uint8Array): void { this.u32(value.length); this.bytes(value); }
  text(value: string): void { if (value.includes("\0")) throw new Error("invalid lease I/O text"); this.blob(Buffer.from(value)); }
  finish(): Buffer { return Buffer.concat(this.chunks); }
}
class Reader {
  private offset = 0;
  constructor(private value: Buffer) { if (value.length > IPC_BYTES) throw new Error("lease I/O response byte limit exceeded"); }
  take(size: number): Buffer {
    if (size < 0 || this.offset + size > this.value.length) throw new Error("truncated lease I/O response");
    const result = this.value.subarray(this.offset, this.offset + size); this.offset += size; return result;
  }
  u8(): number { return this.take(1)[0]!; }
  u32(): number { return this.take(4).readUInt32LE(); }
  u64(): number { const result = this.take(8).readBigUInt64LE(); if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid lease work count"); return Number(result); }
  blob(maximum: number): Buffer { const size = this.u32(); if (size > maximum) throw new Error("lease I/O field limit exceeded"); return this.take(size); }
  text(maximum: number): string { const bytes = this.blob(maximum); const result = bytes.toString("utf8"); if (!Buffer.from(result).equals(bytes) || result.includes("\0")) throw new Error("invalid lease I/O encoding"); return result; }
  identity(): LeaseIoIdentity {
    const device = this.text(20); const inode = this.text(20);
    if (!DECIMAL.test(device) || !DECIMAL.test(inode) || inode === "0" ||
        BigInt(device) > 18_446_744_073_709_551_615n || BigInt(inode) > 18_446_744_073_709_551_615n) throw new Error("invalid exact lease identity");
    return { device, inode };
  }
  end(): void { if (this.offset !== this.value.length) throw new Error("extra lease I/O response"); }
}

function header(operation: number, root: string, budget: LeaseIoWork): Writer {
  if (!Number.isSafeInteger(budget.records) || !Number.isSafeInteger(budget.bytes) || budget.records < 0 || budget.bytes < 0 || budget.records > DEFAULT_BUDGET.records || budget.bytes > DEFAULT_BUDGET.bytes) throw new Error("invalid remaining lease work budget");
  const writer = new Writer(); writer.bytes(Buffer.from("WPLL4")); writer.u8(operation); writer.u32(process.pid); writer.u32(budget.records); writer.u64(budget.bytes); writer.u32(ioOptions.fenceWaitMs ?? 0); writer.text(root); return writer;
}
export class LeaseIoError extends Error {
  constructor(readonly kind: "busy" | "refusal" | "unavailable", message: string) { super(message); }
}
function run(input: Buffer): Reader {
  let command: { command: string; args: string[] };
  try { command = process.platform === "win32" ? windowsLeaseIoCommand(stagingRoots(), ioOptions.providerHome) : { command: nativeExecutable(), args: [] }; }
  catch { throw new LeaseIoError("unavailable", HELPER_UNAVAILABLE); }
  const started = performance.now();
  const result = spawnSync(command.command, command.args, { input, timeout: HELPER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: IPC_BYTES, windowsHide: true });
  runObserver?.({ durationMs: performance.now() - started, timeoutMs: HELPER_TIMEOUT_MS, error: (result.error as NodeJS.ErrnoException | undefined)?.code, signal: result.signal, status: result.status });
  if (result.error) throw new LeaseIoError("unavailable", HELPER_UNAVAILABLE);
  const reader = new Reader(result.stdout ?? Buffer.alloc(0));
  const tag = reader.u8();
  if (tag === 69) { const code = reader.u8(); const message = reader.text(512); reader.end(); throw new LeaseIoError(code === 2 ? "busy" : "refusal", message); }
  if (result.status !== 0 || (tag !== 83 && tag !== 68)) throw new LeaseIoError("refusal", "provider-HOME lease I/O helper failed; preserve all evidence");
  // The caller knows which successful frame is expected; preserve its tag as the first byte.
  return new Reader(result.stdout);
}

export function readLeaseIoSnapshot(root: string, budget = DEFAULT_BUDGET): LeaseIoSnapshot {
  const reader = run(header(0, root, budget).finish());
  if (reader.u8() !== 83) throw new Error("invalid lease snapshot response");
  const rootIdentity = reader.identity(); const hasLock = reader.u8();
  if (hasLock > 1) throw new Error("invalid lease directory response");
  const lockIdentity = hasLock ? reader.identity() : undefined;
  const count = reader.u32(); if (count > 8192) throw new Error("lease snapshot entry limit exceeded");
  const entries: LeaseIoEntry[] = []; const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const directory = reader.u8(); const name = reader.text(255); const identity = reader.identity(); const stamp = reader.text(160);
    if (directory > 1 || !NAME.test(name) || name === "." || name === ".." || seen.has(`${directory}/${name}`)) throw new Error("invalid lease snapshot entry");
    seen.add(`${directory}/${name}`);
    const mode = reader.u32(); const links = reader.u32(); const uid = reader.u32(); const raw = reader.blob(RECORD_BYTES);
    if (links < 1 || links > 3 || (directory === 1 && !hasLock)) throw new Error("unsafe lease snapshot entry");
    entries.push({ directory: directory ? "lock" : "root", name, ...identity, stamp, mode, links, uid, raw });
  }
  const work = { records: reader.u32(), bytes: reader.u64() }; reader.end();
  if (work.records > 131072 || work.bytes > 268435456) throw new Error("lease helper verification work limit exceeded");
  workObserver?.(work);
  return { root, rootIdentity, lockIdentity, entries, work };
}

export function applyLeaseIoPlan(plan: LeaseIoPlan, operation = 1, budget = DEFAULT_BUDGET): { records: number; bytes: number } {
  if (!plan.snapshot.lockIdentity || plan.snapshot.entries.length > 16384 || plan.jobs.length > 4) throw new Error("invalid lease I/O plan");
  const writer = header(operation, plan.snapshot.root, budget);
  for (const identity of [plan.snapshot.rootIdentity, plan.snapshot.lockIdentity]) { writer.text(identity.device); writer.text(identity.inode); }
  writer.text(plan.barrier?.boundary ?? ""); writer.text(plan.barrier?.marker ?? ""); writer.blob(plan.guard); writer.text(plan.guardTemp);
  writer.u32(plan.snapshot.entries.length);
  for (const entry of plan.snapshot.entries) {
    writer.u8(entry.directory === "root" ? 0 : 1); writer.u8(entry.optional ? 1 : 0); writer.text(entry.name); writer.text(entry.device); writer.text(entry.inode); writer.text(entry.stamp);
    writer.u32(entry.mode); writer.u32(entry.links); writer.u32(entry.uid); writer.blob(entry.raw);
  }
  writer.u32(plan.tipIndex); writer.text(plan.future); writer.u32(plan.jobs.length);
  for (const job of plan.jobs) { writer.text(job.name); writer.blob(job.raw); writer.u8(job.copiesOwner ? 1 : 0); writer.u32(job.retire.length); for (const index of job.retire) writer.u32(index); }
  const reader = run(writer.finish()); if (reader.u8() !== 68) throw new Error("invalid lease publication response");
  const work = { records: reader.u32(), bytes: reader.u64() }; reader.end();
  if (work.records > 131072 || work.bytes > 268435456) throw new Error("lease helper verification work limit exceeded");
  workObserver?.(work);
  return work;
}
