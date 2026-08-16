import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname as systemHostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentContext, AgentDriverKind } from "@wollipog/protocol";
import { adoptLegacyWslExecutionIsolationState } from "./execution-isolation.js";
import { adoptLegacyCheckpointRefs, withGitExecutionContext } from "./git-ops.js";
import { runContextCommand } from "./context-command.js";
import { CheckpointRefOwnershipLedger } from "./checkpoint-ref-ownership.js";
import { canIgnoreRunnerDataDirDirectorySyncError } from "./runner-data-dir.js";
import type { SessionMeta } from "./session-store.js";
import { WorktreeCleanupJournal, type WorktreeCleanupRecord } from "./worktree.js";

const OWNER_FILE = ".wollipog-runner-owner-v2.json";
const ACTIVE_LEASE = ".wollipog-runner-active-v1.lock";
const MAX_JSON_BYTES = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

type DoctorCommand = "inventory" | "adopt-checkpoints" | "adopt-provider-state" |
  "quarantine-wsl" | "quarantine-conductor";

interface DoctorArgs {
  command: DoctorCommand;
  dataDir: string;
  sessionId?: string;
  distro?: string;
  acknowledged: boolean;
}

export type StateDoctorDurabilityOperation =
  | "maintenance-lease-published"
  | "fsync-file"
  | "fsync-directory"
  | "rename"
  | "checkpoint-refs-adopted"
  | "checkpoint-owner-published"
  | "session-meta-published";

export interface StateDoctorOptions {
  pid?: number;
  hostname?: string;
  beforeDurabilityOperationForTest?: (operation: StateDoctorDurabilityOperation, path: string) => void;
}

interface MaintenanceLeaseRecord {
  version: 2;
  ownerHash: string;
  leaseId: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

function parseDoctorArgs(argv: string[]): DoctorArgs {
  const marker = argv.indexOf("--state-doctor");
  const command = argv[marker + 1] as DoctorCommand | undefined;
  if (!command || !["inventory", "adopt-checkpoints", "adopt-provider-state", "quarantine-wsl", "quarantine-conductor"].includes(command)) {
    throw new Error("usage: --state-doctor <inventory|adopt-checkpoints|adopt-provider-state|quarantine-wsl|quarantine-conductor> --data-dir <path> [--session-id <id>] [--wsl-distro <name>] [--ack-all-legacy-runners-stopped]");
  }
  let dataDir: string | undefined;
  let sessionId: string | undefined;
  let distro: string | undefined;
  let acknowledged = false;
  const seen = new Set<string>();
  for (let i = marker + 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) throw new Error("state-doctor argument is missing");
    if (seen.has(arg)) throw new Error(`duplicate state-doctor argument: ${arg}`);
    seen.add(arg);
    if (arg === "--ack-all-legacy-runners-stopped") acknowledged = true;
    else if (arg === "--data-dir") dataDir = argv[++i];
    else if (arg === "--session-id") sessionId = argv[++i];
    else if (arg === "--wsl-distro") distro = argv[++i];
    else throw new Error(`unknown state-doctor argument: ${arg}`);
    if (arg !== "--ack-all-legacy-runners-stopped" && argv[i] === undefined) {
      throw new Error(`${arg} requires a value`);
    }
  }
  if (!dataDir) throw new Error("--data-dir is required");
  if (sessionId && !SESSION_ID.test(sessionId)) throw new Error("--session-id is invalid");
  if (distro && (distro.trim() !== distro || !distro || distro.includes("\0"))) throw new Error("--wsl-distro is invalid");
  return { command, dataDir: resolve(dataDir), sessionId, distro, acknowledged };
}

function protectedJson<T>(path: string): T {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error(`unsafe state metadata: ${basename(path)}`);
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } finally {
    closeSync(fd);
  }
}

function offlineOwner(dataDir: string): string {
  const owner = protectedJson<{ version?: unknown; ownerHash?: unknown }>(join(dataDir, OWNER_FILE));
  if (owner.version !== 2 || typeof owner.ownerHash !== "string" || !/^[a-f0-9]{64}$/u.test(owner.ownerHash)) {
    throw new Error("runner data directory does not contain stable attested owner metadata");
  }
  return owner.ownerHash;
}

function beforeDurabilityOperation(
  options: StateDoctorOptions,
  operation: StateDoctorDurabilityOperation,
  path: string,
): void {
  options.beforeDurabilityOperationForTest?.(operation, path);
}

export function stateDoctorFileSyncFlags(platform: NodeJS.Platform = process.platform): number {
  const access = platform === "win32" ? constants.O_RDWR : constants.O_RDONLY;
  return access | (constants.O_NOFOLLOW ?? 0);
}

function syncFile(path: string, options: StateDoctorOptions): void {
  beforeDurabilityOperation(options, "fsync-file", path);
  // libuv maps fsync to FlushFileBuffers on Windows, which requires a write-capable handle.
  const fd = openSync(path, stateDoctorFileSyncFlags());
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path: string, options: StateDoctorOptions): void {
  beforeDurabilityOperation(options, "fsync-directory", path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (!canIgnoreRunnerDataDirDirectorySyncError(error as NodeJS.ErrnoException)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function createDurableDirectories(path: string, options: StateDoctorOptions): void {
  const missing: string[] = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(dirname(directory), options);
  }
}

function createDurableFile(path: string, contents: string, options: StateDoctorOptions): void {
  writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  syncFile(path, options);
  syncDirectory(dirname(path), options);
}

function replaceMeta(path: string, meta: SessionMeta, options: StateDoctorOptions): void {
  const temp = `${path}.state-doctor-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    syncFile(temp, options);
    beforeDurabilityOperation(options, "rename", path);
    renameSync(temp, path);
    syncDirectory(dirname(path), options);
    beforeDurabilityOperation(options, "session-meta-published", path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function acquireMaintenanceLease(
  requestedDataDir: string,
  options: StateDoctorOptions,
): { dataDir: string; ownerHash: string; release: () => void } {
  const dataDir = realpathSync(requestedDataDir);
  const ownerHash = offlineOwner(dataDir);
  const leasePath = join(dataDir, ACTIVE_LEASE);
  const leaseId = randomUUID();
  const record: MaintenanceLeaseRecord = {
    version: 2,
    ownerHash,
    leaseId,
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? systemHostname(),
    createdAt: new Date().toISOString(),
  };
  let created = false;
  try {
    writeFileSync(leasePath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    syncFile(leasePath, options);
    syncDirectory(dataDir, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("runner data directory has an active or unrecovered lease; stop every runner and resolve the lease before offline maintenance");
    }
    if (created) {
      try {
        rmSync(leasePath);
        syncDirectory(dataDir, options);
      } catch { /* An uncertain lease publication deliberately remains fail-closed. */ }
    }
    throw error;
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    const current = protectedJson<Partial<MaintenanceLeaseRecord>>(leasePath);
    if (current.leaseId !== leaseId || current.ownerHash !== ownerHash) {
      throw new Error("state-doctor maintenance lease changed before release; refusing to remove replacement ownership");
    }
    rmSync(leasePath);
    syncDirectory(dataDir, options);
    released = true;
  };
  try {
    const confirmedOwner = offlineOwner(dataDir);
    if (confirmedOwner !== ownerHash) {
      throw new Error("runner data directory owner changed during maintenance lease acquisition");
    }
    beforeDurabilityOperation(options, "maintenance-lease-published", leasePath);
    return { dataDir, ownerHash, release };
  } catch (error) {
    try { release(); } catch { /* Preserve the acquisition failure. */ }
    throw error;
  }
}

function sessionMeta(dataDir: string, sessionId: string): { path: string; meta: SessionMeta } {
  const path = join(dataDir, "sessions", sessionId, "meta.json");
  const meta = protectedJson<SessionMeta>(path);
  if (meta.sessionId !== sessionId) throw new Error("session metadata id does not match its directory");
  return { path, meta };
}

function sameContext(left: AgentContext, right: AgentContext): boolean {
  return left.kind === right.kind &&
    (left.kind !== "wsl" || (right.kind === "wsl" && left.distro === right.distro));
}

function deletionMarker(dataDir: string, sessionId: string): string {
  return join(dataDir, "sessions", ".deleted", createHash("sha256").update(sessionId).digest("hex"));
}

function refuseDeletedSession(dataDir: string, sessionId: string): void {
  if (existsSync(deletionMarker(dataDir, sessionId))) {
    throw new Error("checkpoint adoption refuses a deletion-tombstoned session");
  }
}

function retireMatchingLegacyCleanup(dataDir: string, meta: SessionMeta): void {
  if (!meta.worktreePath) throw new Error("checkpoint adoption requires a persisted worktree path");
  const journalPath = join(dataDir, "worktree-cleanup.json");
  if (!existsSync(journalPath)) return;
  const parsed = protectedJson<unknown>(journalPath);
  if (!Array.isArray(parsed)) throw new Error("worktree cleanup journal is invalid; refusing checkpoint adoption");
  const matches = parsed.filter((value): value is WorktreeCleanupRecord =>
    !!value && typeof value === "object" &&
    (value as Partial<WorktreeCleanupRecord>).sessionId === meta.sessionId);
  if (matches.length > 1) {
    throw new Error("multiple worktree cleanup records claim this session; refusing ambiguous checkpoint adoption");
  }
  const cleanup = matches[0];
  if (!cleanup) return;
  if (cleanup.checkpointOwnerHash !== undefined) {
    throw new Error("worktree cleanup record already names an owner-scoped generation; refusing checkpoint adoption");
  }
  if (!cleanup.context || typeof cleanup.context !== "object" ||
      cleanup.repoPath !== meta.repoPath || cleanup.worktreePath !== meta.worktreePath ||
      !sameContext(cleanup.context, meta.context)) {
    throw new Error("worktree cleanup record does not exactly match the live legacy session; refusing checkpoint adoption");
  }
  const journal = new WorktreeCleanupJournal(dataDir);
  journal.remove(meta.sessionId);
  if (new WorktreeCleanupJournal(dataDir).list().some((record) => record.sessionId === meta.sessionId)) {
    throw new Error("worktree cleanup record remained after durable retirement");
  }
}

function requireMutation(args: DoctorArgs): void {
  if (!args.acknowledged) {
    throw new Error("mutation requires --ack-all-legacy-runners-stopped; legacy runners do not honor attested state locks");
  }
}

function legacyConductorFiles(dataDir: string): string[] {
  const dir = join(dataDir, "conductor");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mcp.json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function storedMetas(dataDir: string): { metas: SessionMeta[]; unreadable: number } {
  const root = join(dataDir, "sessions");
  if (!existsSync(root)) return { metas: [], unreadable: 0 };
  const metas: SessionMeta[] = [];
  let unreadable = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    try { metas.push(sessionMeta(dataDir, entry.name).meta); } catch { unreadable++; }
  }
  return { metas, unreadable };
}

async function inventoryWsl(distro: string): Promise<{ available: boolean; legacyRoots: number }> {
  const context = { kind: "wsl" as const, distro };
  try {
    const result = await runContextCommand(context, "sh", ["-c",
      'n=0; for p in "$HOME/.agent-manager/provider-state" "$HOME/.agent-manager/worktrees"; do [ ! -e "$p" ] || n=$((n+1)); done; printf "%s" "$n"',
    ], { cwd: "/", timeoutMs: 8_000, maxBuffer: 1024 });
    return { available: true, legacyRoots: Number.parseInt(result.stdout.trim(), 10) || 0 };
  } catch {
    return { available: false, legacyRoots: 0 };
  }
}

export async function runStateDoctor(
  argv = process.argv,
  writeOutput: (value: string) => unknown = (value) => process.stdout.write(value),
  options: StateDoctorOptions = {},
): Promise<void> {
  const args = parseDoctorArgs(argv);
  const maintenance = acquireMaintenanceLease(args.dataDir, options);
  const dataDir = maintenance.dataDir;
  const ownerHash = maintenance.ownerHash;
  let operationFailure: unknown;
  try {
    if (args.command === "inventory") {
      const { metas, unreadable } = storedMetas(dataDir);
      const wsl = args.distro ? await inventoryWsl(args.distro) : undefined;
      const report = {
        version: 1,
        ownerId: createHash("sha256").update(ownerHash).digest("hex").slice(0, 16),
        legacyCheckpointSessions: metas.filter((meta) => meta.checkpointRefVersion === undefined && meta.worktreePath).length,
        legacyWslWorktrees: metas.filter((meta) => meta.context.kind === "wsl" && meta.worktreePath && !meta.worktreePath.includes("/runner-instances/")).length,
        legacyWslProviderSessions: metas.filter((meta) => meta.context.kind === "wsl" && meta.providerStateVersion !== 3).length,
        legacyConductorConfigs: legacyConductorFiles(dataDir).length,
        unreadableSessionMetadata: unreadable,
        ...(wsl ? { wsl } : {}),
      };
      writeOutput(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    requireMutation(args);
    if (args.command === "quarantine-conductor") {
      const files = legacyConductorFiles(dataDir);
      const quarantineId = randomUUID();
      const sourceDirectory = join(dataDir, "conductor");
      const target = join(dataDir, "state-quarantine", quarantineId, "conductor");
      createDurableDirectories(target, options);
      const manifest = files.map((source, index) => ({
        itemId: createHash("sha256").update(basename(source)).digest("hex"),
        originalName: basename(source),
        storedAs: `${String(index + 1).padStart(4, "0")}.mcp.json`,
      }));
      // Publish and sync the rollback map before the first move. Each cross-directory rename then
      // syncs both directory entries, so every crash prefix remains identifiable and retryable.
      createDurableFile(
        join(target, "manifest.json"),
        `${JSON.stringify({ version: 1, items: manifest }, null, 2)}\n`,
        options,
      );
      for (const [index, source] of files.entries()) {
        const item = manifest[index];
        if (!item) throw new Error("conductor quarantine manifest changed unexpectedly");
        const destination = join(target, item.storedAs);
        beforeDurabilityOperation(options, "rename", destination);
        renameSync(source, destination);
        syncDirectory(sourceDirectory, options);
        syncDirectory(target, options);
      }
      writeOutput(`${JSON.stringify({ quarantined: files.length, quarantineId })}\n`);
      return;
    }
    if (args.command === "quarantine-wsl") {
      if (!args.distro) throw new Error("quarantine-wsl requires --wsl-distro");
      const quarantineId = randomUUID();
      const result = await runContextCommand({ kind: "wsl", distro: args.distro }, "sh", ["-c",
        'set -eu; root="$HOME/.agent-manager"; q="$root/state-quarantine/$1"; umask 077; mkdir -p -- "$q"; sync; n=0; for name in provider-state worktrees; do src="$root/$name"; if [ -e "$src" ]; then mv -- "$src" "$q/$name"; sync; n=$((n+1)); fi; done; printf "%s" "$n"',
        "state-doctor", quarantineId,
      ], { cwd: "/", timeoutMs: 30_000, maxBuffer: 1024 });
      writeOutput(`${JSON.stringify({ quarantinedRoots: Number.parseInt(result.stdout.trim(), 10) || 0, quarantineId })}\n`);
      return;
    }
    if (!args.sessionId) throw new Error(`${args.command} requires --session-id`);
    const { path, meta } = sessionMeta(dataDir, args.sessionId);
    if (args.command === "adopt-checkpoints") {
      if (meta.checkpointRefVersion !== undefined) throw new Error("session checkpoint refs are already owner-scoped");
      refuseDeletedSession(dataDir, meta.sessionId);
      // Retire only an exact legacy cleanup tuple before changing any ownership namespace. A crash
      // from here leaves the live legacy row/worktree intact and makes retry safe.
      retireMatchingLegacyCleanup(dataDir, meta);
      const count = await withGitExecutionContext(meta.context, () =>
        adoptLegacyCheckpointRefs(meta.repoPath, meta.sessionId, ownerHash));
      beforeDurabilityOperation(options, "checkpoint-refs-adopted", meta.sessionId);
      const ledger = new CheckpointRefOwnershipLedger(dataDir);
      ledger.claim({
        sessionId: meta.sessionId,
        repoPath: meta.repoPath,
        context: meta.context,
        ownerHash,
      });
      beforeDurabilityOperation(options, "checkpoint-owner-published", meta.sessionId);
      // Source refs are an explicit rollback copy. Their legacy deletion proof must be durably
      // absent before the metadata switches startup reconciliation to the owner-scoped layout.
      const legacyOwnership = ledger.get({
        sessionId: meta.sessionId,
        repoPath: meta.repoPath,
        context: meta.context,
      });
      if (legacyOwnership) ledger.remove(legacyOwnership);
      refuseDeletedSession(dataDir, meta.sessionId);
      replaceMeta(path, { ...meta, checkpointRefVersion: 2, updatedAt: Date.now() }, options);
      writeOutput(`${JSON.stringify({ adoptedCheckpointEntries: count, sourcePreserved: true })}\n`);
      return;
    }
    if (meta.context.kind !== "wsl") throw new Error("adopt-provider-state requires a WSL session");
    if (meta.providerStateVersion === 3) throw new Error("session provider state is already owner-scoped");
    const outcome = await adoptLegacyWslExecutionIsolationState(
      meta.context,
      meta.driver as AgentDriverKind,
      meta.sessionId,
      ownerHash,
    );
    replaceMeta(path, { ...meta, providerStateVersion: 3, updatedAt: Date.now() }, options);
    writeOutput(`${JSON.stringify({ providerState: outcome, sourcePreserved: true })}\n`);
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    try {
      maintenance.release();
    } catch (error) {
      if (operationFailure === undefined) throw error;
    }
  }
}
