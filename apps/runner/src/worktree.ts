/** Context-native, externally stored per-session git worktrees. */

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { mkdir, rm, rmdir, statfs } from "node:fs/promises";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type {
  AgentContext,
  AgentDriverKind,
  ExecutionHandoffReceipt,
  ExecutionTargetRef,
  ForgeProvider,
  SessionWorktreeProgressPhase,
  WorktreePortBlock,
  WorktreeTeardownState,
} from "@wollipog/protocol";
import type { WorktreeHookSnapshot } from "./worktree-setup.js";
import { runContextCommand } from "./context-command.js";
import {
  captureWorktreeTree,
  isMissingGitRepositoryError,
  restoreWorktreeToTree,
  withGitExecutionContext,
} from "./git-ops.js";
import { canIgnoreRunnerDataDirDirectorySyncError } from "./runner-data-dir.js";

const MIN_FREE_BYTES = 512 * 1024 * 1024;
const nativeContext: AgentContext = { kind: "native" };
type StatfsResult = Awaited<ReturnType<typeof statfs>>;
let statfsRunner: (path: string) => Promise<StatfsResult> = statfs;

/** A native cleanup target that cannot be a repository is terminal. A present non-directory path
 * is conclusive. ENOENT/ENOTDIR is conclusive only while its immediate parent is reachable: UNC
 * shares, mapped drives, and mounted filesystems can report those codes while their root is
 * transiently offline. Ambiguous roots and all other filesystem failures remain retryable. */
export function nativeRepositoryPathIsUnavailable(context: AgentContext, repoPath: string): boolean {
  if (context.kind !== "native") return false;
  try {
    return !statSync(repoPath).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return false;
    const parent = dirname(repoPath);
    if (parent === repoPath) return false;
    try {
      // A reachable parent proves the final path is absent or unusable. If the parent itself is a
      // regular file, the original ENOTDIR is equally terminal. Do not walk beyond this boundary:
      // an accessible local ancestor (for example C:\ or /mnt) does not prove its child share is
      // currently reachable.
      statSync(parent);
      return true;
    } catch {
      return false;
    }
  }
}

export function setStatfsForTests(runner?: (path: string) => Promise<StatfsResult>): void {
  statfsRunner = runner ?? statfs;
}

export interface WorktreeOptions {
  context?: AgentContext;
  /** Runner data directory. Native worktrees live below `<dataDir>/worktrees`. */
  dataDir?: string;
  /** Stable attested owner for WSL paths and repository-global branch names. */
  ownerHash?: string;
  /** Cleanup-only compatibility boundary for a persisted pre-attestation WSL worktree path. */
  legacyWslRoot?: boolean;
  /** Persisted pre-attestation WSL worktree. Creation may reuse this exact registered path, but
   * must never silently replace or abandon it. */
  legacyWslWorktreePath?: string;
  /** Content-free progress for independently bounded worktree preparation phases. */
  onProgress?: (phase: SessionWorktreeProgressPhase) => void;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  /** True only when this create call materialized the linked worktree. A healthy registered
   * worktree is returned with false so a losing launch cannot reap durable user changes. */
  created?: boolean;
}

/** A session-requested worktree keeps its user-selected Git identity instead of deriving either
 * coordinate from the session id. `baseRef` is the exact caller-selected ref used at creation;
 * `baseCommit` makes the result stable and auditable even when that ref moves later. */
export interface SessionWorktreeHandle extends WorktreeHandle {
  baseRef: string;
  baseCommit: string;
  attached: boolean;
}

export interface RequestedWorktreeOptions extends WorktreeOptions {
  /** Exact configured Project Location roots. An existing worktree may be attached when one of
   * these roots contains the repository that registers it, when the worktree itself sits inside
   * one of them, or when it sits inside the runner-owned worktree root. */
  allowedProjectPaths?: string[];
}

export interface WorktreeCleanupRecord {
  sessionId: string;
  /** Stable per-worktree identity. Absent records are the singular legacy session worktree. */
  worktreeId?: string;
  /** Unique durable cleanup occurrence; added lazily when replaying legacy rows. */
  cleanupId?: string;
  repoPath: string;
  worktreePath: string;
  context: AgentContext;
  /** Exact branch recorded when this generation was created or attached. Legacy records derive
   * `agent/<sessionId>` during cleanup. */
  branch?: string;
  source?: "legacy" | "created";
  baseRef?: string;
  /** Exact checkpoint namespace owned by this worktree generation. Absent means legacy refs. */
  checkpointOwnerHash?: string;
  /** Durable proof that rollback owns the session's current checkpoint generation, not merely an
   * auxiliary worktree created for an otherwise-live session. */
  checkpointGenerationDisposable?: boolean;
  /** Durable proof that creation rollback targets only an auxiliary requested worktree while the
   * session and its checkpoint generation remain live. */
  auxiliaryWorktreeRollback?: boolean;
  /** Exact initiating lifecycle. Startup replay preserves rather than replaces this value. */
  trigger?: "explicit_discard" | "pull_request_reconciliation" | "session_delete" | "creation_rollback";
  /** Explicit discard/reconciliation retains Git safety checks; deletion/rollback keeps legacy force cleanup. */
  removalMode?: "safe" | "force";
  /** Exact approved teardown material. Runner-private and never projected to the control plane. */
  hooks?: WorktreeHookSnapshot;
  /** Minimal runner-private launch identity needed to recreate the approved execution boundary
   * after the session row has been deleted. Adapter secret values are never stored here. */
  execution?: {
    agentId: string | null;
    driver: AgentDriverKind;
    command: string;
    args: string[];
    permissionMode?: string;
    executionTarget?: ExecutionTargetRef;
    executionHandoff?: ExecutionHandoffReceipt;
    /** Opaque runner-local reconnect identity, not an adapter credential or environment value. */
    cloudAdapterHandoffKey?: string;
  };
  /** Stable allocation retained until worktree removal succeeds. */
  portBlock?: WorktreePortBlock;
  /** Durable bounded teardown progress/output, including crash-uncertain steps. */
  teardown?: WorktreeTeardownState;
  /** Set before termination begins so an interrupted attempt remains replayable. */
  processTerminationStartedAt?: number;
  /** Runner-private random marker inherited by worktree-owned native POSIX descendants. */
  processMarker?: string;
  processesTerminatedAt?: number;
  /** Durable proof that removal completed even if port/history finalization must retry. */
  worktreeRemovedAt?: number;
  createdAt?: number;
  completedAt?: number;
  /** Forge-verified head used only for safe cleanup when the branch upstream disappeared. */
  verifiedMergedHead?: string;
}

export type RetainedWorktreeRefReason =
  | "recorded_branch"
  | "shared_checkout"
  | "default_branch"
  | "default_unknown";

export type RetainedWorktreeRefPendingReason =
  | "checked_out"
  | "default_unknown"
  | "git_unavailable";

export type RetainedWorktreeRefTerminalReason =
  | "deleted"
  | "already_missing"
  | "default_branch"
  | "default_unproved_at_handoff"
  | "ref_changed_or_recreated"
  | "identity_unproved"
  | "delivery_unproved";

/** Durable ownership of one local branch deliberately left behind by safe worktree removal. */
export interface RetainedWorktreeRefRecord {
  sessionId: string;
  worktreeId?: string;
  /** Binds ownership to one cleanup occurrence even when a requested slot is reused later. */
  cleanupId?: string;
  repoPath: string;
  context: AgentContext;
  branch: string;
  expectedOid: string;
  /** Hash of the latest reflog entry and its file identity; distinguishes same-OID recreation. */
  identityToken?: string;
  reasons: RetainedWorktreeRefReason[];
  /** Exact merged-head proof already accepted by worktree cleanup, when one exists. */
  verifiedMergedHead?: string;
  state: "pending" | "completed" | "retained";
  pendingReason?: RetainedWorktreeRefPendingReason;
  terminalReason?: RetainedWorktreeRefTerminalReason;
  /** Set only after the associated worktree was successfully removed. */
  armedAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** Captured before the worktree is removed; the caller must persist every candidate durably. */
export interface RetainedWorktreeRefCandidate {
  branch: string;
  expectedOid: string;
  identityToken?: string;
  reasons: RetainedWorktreeRefReason[];
  verifiedMergedHead?: string;
}

/** Native-host cleanup journal. Session rows can be deleted immediately while failed context
 * cleanup remains durable and is retried on the next runner start. */
export class WorktreeCleanupJournal {
  private readonly path: string;
  private readonly historyPath: string;
  private readonly retainedRefPath: string;
  private readonly retainedRefHistoryPath: string;
  private records = new Map<string, WorktreeCleanupRecord>();
  private completedRecords = new Map<string, WorktreeCleanupRecord>();
  private retainedRefs = new Map<string, RetainedWorktreeRefRecord>();
  private completedRetainedRefs = new Map<string, RetainedWorktreeRefRecord>();

  constructor(dataDir = join(homedir(), ".agent-manager")) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "worktree-cleanup.json");
    this.historyPath = join(dataDir, "worktree-cleanup-history.json");
    this.retainedRefPath = join(dataDir, "worktree-retained-refs.json");
    this.retainedRefHistoryPath = join(dataDir, "worktree-retained-ref-history.json");
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as WorktreeCleanupRecord[];
      if (Array.isArray(parsed)) for (const record of parsed) this.records.set(this.key(record), record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`could not read worktree cleanup journal ${this.path}: ${(error as Error).message}`);
      }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.historyPath, "utf8")) as WorktreeCleanupRecord[];
      if (Array.isArray(parsed)) for (const record of parsed) this.completedRecords.set(this.key(record), record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`could not read worktree cleanup history ${this.historyPath}: ${(error as Error).message}`);
      }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.retainedRefPath, "utf8")) as RetainedWorktreeRefRecord[];
      if (Array.isArray(parsed)) for (const record of parsed) this.retainedRefs.set(this.retainedRefKey(record), record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`could not read retained worktree refs ${this.retainedRefPath}: ${(error as Error).message}`);
      }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.retainedRefHistoryPath, "utf8")) as RetainedWorktreeRefRecord[];
      if (Array.isArray(parsed)) {
        for (const record of parsed) this.completedRetainedRefs.set(this.retainedRefKey(record), record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`could not read retained worktree ref history ${this.retainedRefHistoryPath}: ${(error as Error).message}`);
      }
    }
    // A terminal receipt is written before its pending row is removed. If the runner crashes
    // between those atomic writes, the receipt wins: replaying the stale row could otherwise
    // delete a same-name ref recreated after reclamation completed.
    let removedTerminalPending = false;
    for (const key of this.completedRetainedRefs.keys()) {
      removedTerminalPending = this.retainedRefs.delete(key) || removedTerminalPending;
    }
    if (removedTerminalPending) this.flushRetainedRefs();
  }

  list(): WorktreeCleanupRecord[] { return [...this.records.values()]; }

  history(): WorktreeCleanupRecord[] { return [...this.completedRecords.values()]; }

  listRetainedRefs(): RetainedWorktreeRefRecord[] { return [...this.retainedRefs.values()]; }

  retainedRefHistory(): RetainedWorktreeRefRecord[] { return [...this.completedRetainedRefs.values()]; }

  add(record: WorktreeCleanupRecord): void {
    this.records.set(this.key(record), record);
    this.flush();
  }

  remove(sessionId: string, worktreeId?: string): void {
    let removed = false;
    if (worktreeId !== undefined) {
      removed = this.records.delete(`${sessionId}\0${worktreeId}`);
    } else {
      for (const [key, record] of this.records) {
        if (record.sessionId !== sessionId) continue;
        this.records.delete(key);
        removed = true;
      }
    }
    if (!removed) return;
    this.flush();
  }

  /** Persist a bounded durable receipt before removing the retry record. A crash between the two
   * writes is idempotent: replay replaces the same receipt key before retry-state removal. */
  complete(record: WorktreeCleanupRecord): void {
    const completed = { ...structuredClone(record), completedAt: record.completedAt ?? Date.now() };
    this.completedRecords.set(this.key(completed), completed);
    while (this.completedRecords.size > 256) {
      const oldest = this.completedRecords.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completedRecords.delete(oldest);
    }
    this.flushFile(this.historyPath, this.history());
    this.remove(record.sessionId, record.worktreeId ?? "legacy");
  }

  /** First ownership wins. A retry must never bless a ref that advanced or was recreated under
   * the same name, and a terminal receipt must never be re-armed by stale cleanup replay. */
  addRetainedRef(record: RetainedWorktreeRefRecord): RetainedWorktreeRefRecord {
    const key = this.retainedRefKey(record);
    const existing = this.retainedRefs.get(key) ?? this.completedRetainedRefs.get(key);
    if (existing) return existing;
    this.retainedRefs.set(key, structuredClone(record));
    this.flushRetainedRefs();
    return record;
  }

  updateRetainedRef(record: RetainedWorktreeRefRecord): void {
    const key = this.retainedRefKey(record);
    if (!this.retainedRefs.has(key)) return;
    this.retainedRefs.set(key, structuredClone(record));
    this.flushRetainedRefs();
  }

  armRetainedRefs(sessionId: string, worktreeId?: string, cleanupId?: string): void {
    const now = Date.now();
    let changed = false;
    for (const [key, record] of this.retainedRefs) {
      if (record.sessionId !== sessionId ||
          (record.worktreeId ?? "legacy") !== (worktreeId ?? "legacy") ||
          (record.cleanupId ?? "legacy-cleanup") !== (cleanupId ?? "legacy-cleanup") || record.armedAt) continue;
      this.retainedRefs.set(key, { ...record, armedAt: now, updatedAt: now });
      changed = true;
    }
    if (changed) this.flushRetainedRefs();
  }

  removeUnarmedRetainedRefs(
    sessionId: string,
    worktreeId?: string,
    cleanupId?: string,
    beforeWrite?: () => void,
  ): void {
    const keys: string[] = [];
    for (const [key, record] of this.retainedRefs) {
      if (record.sessionId !== sessionId || record.armedAt ||
          (record.worktreeId ?? "legacy") !== (worktreeId ?? "legacy") ||
          (record.cleanupId ?? "legacy-cleanup") !== (cleanupId ?? "legacy-cleanup")) continue;
      keys.push(key);
    }
    if (!keys.length) return;
    beforeWrite?.();
    for (const key of keys) this.retainedRefs.delete(key);
    this.flushRetainedRefs();
  }

  finishRetainedRef(
    record: RetainedWorktreeRefRecord,
    state: "completed" | "retained",
    terminalReason: RetainedWorktreeRefTerminalReason,
  ): void {
    const key = this.retainedRefKey(record);
    // Concurrent startup/periodic/post-cleanup sweeps can all hold the same pending snapshot.
    // The first terminal receipt is authoritative: a later stale sweep that observes the ref
    // already missing must not replace an exact `deleted` receipt with `already_missing`.
    if (this.completedRetainedRefs.has(key)) return;
    const completed = {
      ...structuredClone(record),
      state,
      pendingReason: undefined,
      terminalReason,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    } satisfies RetainedWorktreeRefRecord;
    this.completedRetainedRefs.set(key, completed);
    while (this.completedRetainedRefs.size > 256) {
      const oldest = this.completedRetainedRefs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completedRetainedRefs.delete(oldest);
    }
    this.flushFile(this.retainedRefHistoryPath, this.retainedRefHistory());
    if (this.retainedRefs.delete(key)) this.flushRetainedRefs();
  }

  private key(record: WorktreeCleanupRecord): string {
    return `${record.sessionId}\0${record.worktreeId ?? "legacy"}`;
  }

  private retainedRefKey(
    record: Pick<RetainedWorktreeRefRecord, "sessionId" | "worktreeId" | "cleanupId" | "branch">,
  ): string {
    return `${record.sessionId}\0${record.worktreeId ?? "legacy"}\0${record.cleanupId ?? "legacy-cleanup"}\0${record.branch}`;
  }

  private flush(): void {
    this.flushFile(this.path, this.list());
  }

  private flushRetainedRefs(): void {
    this.flushFile(this.retainedRefPath, this.listRetainedRefs());
  }

  private flushFile<T>(path: string, records: T[]): void {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(records, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, path);
      let directoryFd: number | undefined;
      try {
        directoryFd = openSync(dirname(this.path), constants.O_RDONLY);
        fsyncSync(directoryFd);
      } catch (error) {
        if (!canIgnoreRunnerDataDirDirectorySyncError(error as NodeJS.ErrnoException)) throw error;
      } finally {
        if (directoryFd !== undefined) closeSync(directoryFd);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
}

function repoKey(repoPath: string): string {
  const name = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, "-") || "repo";
  return `${name}-${createHash("sha256").update(repoPath).digest("hex").slice(0, 12)}`;
}

async function command(context: AgentContext, cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return (await runContextCommand(context, "git", args, { cwd, timeoutMs })).stdout;
}

async function wslHome(context: Extract<AgentContext, { kind: "wsl" }>): Promise<string> {
  const result = await runContextCommand(context, "sh", ["-c", 'printf "%s" "$HOME"'], { cwd: "/", timeoutMs: 8_000 });
  const home = result.stdout.trim();
  if (!home.startsWith("/")) throw new Error(`could not resolve HOME inside WSL distro ${context.distro}`);
  return home;
}

/** Resolve/create the external root without a capacity gate (cleanup must work on a full disk). */
async function worktreeRootPath(options: WorktreeOptions = {}): Promise<string> {
  const context = options.context ?? nativeContext;
  if (context.kind === "wsl") {
    if (options.legacyWslRoot) {
      const root = `${await wslHome(context)}/.agent-manager/worktrees`;
      await runContextCommand(context, "mkdir", ["-p", "--", root], { cwd: "/", timeoutMs: 8_000 });
      return root;
    }
    if (!options.ownerHash || !/^[a-f0-9]{64}$/u.test(options.ownerHash)) {
      throw new Error("WSL worktrees require a valid attested runner owner hash");
    }
    const root = `${await wslHome(context)}/.agent-manager/runner-instances/${options.ownerHash}/worktrees`;
    await runContextCommand(context, "mkdir", ["-p", "--", root], { cwd: "/", timeoutMs: 8_000 });
    return root;
  }
  const root = join(options.dataDir ?? join(homedir(), ".agent-manager"), "worktrees");
  await mkdir(root, { recursive: true });
  return root;
}

/** Resolve and capacity-preflight the external worktree root before creation. */
export async function resolveWorktreeRoot(options: WorktreeOptions = {}): Promise<string> {
  const context = options.context ?? nativeContext;
  const root = await worktreeRootPath(options);
  if (context.kind === "wsl") {
    const disk = await runContextCommand(context, "df", ["-Pk", root], { cwd: "/", timeoutMs: 8_000 });
    const fields = disk.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
    const available = Number(fields[3]) * 1024;
    if (Number.isFinite(available) && available < MIN_FREE_BYTES) {
      throw new Error(`worktree storage has only ${Math.floor(available / 1024 / 1024)} MiB free (512 MiB required)`);
    }
    return root;
  }
  const disk = await statfsRunner(root);
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (available < MIN_FREE_BYTES) {
    throw new Error(`worktree storage has only ${Math.floor(available / 1024 / 1024)} MiB free (512 MiB required)`);
  }
  return root;
}

async function sessionPath(
  repoPath: string,
  sessionId: string,
  options: WorktreeOptions,
  capacityPreflight = true,
): Promise<string> {
  validateSessionId(sessionId);
  const root = capacityPreflight ? await resolveWorktreeRoot(options) : await worktreeRootPath(options);
  const context = options.context ?? nativeContext;
  const parent = context.kind === "wsl" ? `${root}/${repoKey(repoPath)}` : join(root, repoKey(repoPath));
  if (capacityPreflight) {
    if (context.kind === "wsl") await runContextCommand(context, "mkdir", ["-p", "--", parent], { cwd: "/", timeoutMs: 8_000 });
    else await mkdir(parent, { recursive: true });
  }
  return context.kind === "wsl" ? `${parent}/${sessionId}` : join(parent, sessionId);
}

function requestedSlot(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error("session id is not safe for a worktree path/branch");
  }
}

/** Stable session-private directory used by platform isolation before a requested worktree exists.
 * Binding this directory writable is narrower than exposing the runner's shared worktree root. */
export async function requestedWorktreeBoundary(
  repoPath: string,
  sessionId: string,
  options: WorktreeOptions = {},
  capacityPreflight = true,
): Promise<string> {
  const boundary = await requestedWorktreeBoundaryPath(repoPath, sessionId, options, capacityPreflight);
  const context = options.context ?? nativeContext;
  if (context.kind === "wsl") {
    await runContextCommand(context, "mkdir", ["-p", "--", boundary], { cwd: "/", timeoutMs: 8_000 });
  } else {
    await mkdir(boundary, { recursive: true });
  }
  return boundary;
}

async function requestedWorktreeBoundaryPath(
  repoPath: string,
  sessionId: string,
  options: WorktreeOptions,
  capacityPreflight: boolean,
): Promise<string> {
  validateSessionId(sessionId);
  const context = options.context ?? nativeContext;
  const root = capacityPreflight ? await resolveWorktreeRoot(options) : await worktreeRootPath(options);
  const parent = context.kind === "wsl" ? `${root}/${repoKey(repoPath)}` : join(root, repoKey(repoPath));
  return context.kind === "wsl"
    ? `${parent}/${sessionId}.requested`
    : join(parent, `${sessionId}.requested`);
}

/** Remove only an empty runner-owned session boundary. A retained attached worktree or any
 * unexpected content makes the non-recursive removal fail closed and leaves the boundary intact. */
export async function removeRequestedWorktreeBoundary(
  repoPath: string,
  sessionId: string,
  options: WorktreeOptions = {},
): Promise<boolean> {
  const context = options.context ?? nativeContext;
  const boundary = await requestedWorktreeBoundaryPath(repoPath, sessionId, options, false);
  try {
    if (context.kind === "wsl") {
      await runContextCommand(context, "rmdir", ["--", boundary], { cwd: "/", timeoutMs: 8_000 });
    } else {
      await rmdir(boundary);
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = `${(error as { stderr?: string }).stderr ?? ""}\n${(error as Error).message}`;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || /not empty|no such file/i.test(detail)) {
      return false;
    }
    throw error;
  }
}

function safeGitArgument(value: string, label: string): string {
  if (!value || value.startsWith("-") || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} is not a safe Git argument`);
  }
  return value;
}

async function validateBranch(context: AgentContext, repoPath: string, branch: string): Promise<string> {
  safeGitArgument(branch, "worktree branch");
  const validated = (await command(context, repoPath, ["check-ref-format", "--branch", branch])).trim();
  if (validated !== branch) throw new Error("worktree branch did not round-trip through Git validation");
  return branch;
}

/** Create a distinct session-owned worktree from an explicit ref without consulting the primary
 * checkout's HEAD. The branch is created, never reset: a pre-existing branch fails closed instead
 * of moving an unrelated ref. */
export async function createRequestedWorktree(
  repoPath: string,
  sessionId: string,
  request: { baseRef: string; branch: string },
  options: RequestedWorktreeOptions = {},
): Promise<SessionWorktreeHandle> {
  const context = options.context ?? nativeContext;
  options.onProgress?.("validating");
  const baseRef = safeGitArgument(request.baseRef, "worktree base ref");
  const branch = await validateBranch(context, repoPath, request.branch);
  options.onProgress?.("validating");
  const baseCommit = (await command(
    context,
    repoPath,
    ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
  )).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) throw new Error("worktree base did not resolve to a commit");
  const boundary = await requestedWorktreeBoundary(repoPath, sessionId, options);
  const path = context.kind === "wsl"
    ? `${boundary}/${requestedSlot(branch)}`
    : join(boundary, requestedSlot(branch));
  options.onProgress?.("validating");
  const listed = await command(context, repoPath, ["worktree", "list", "--porcelain", "-z"]);
  const matching = parseWorktreePorcelain(listed).find((entry) => sameWorktreePath(context, entry.path, path));
  if (matching) {
    if (matching.branch === branch) {
      return { path: matching.path, branch, baseRef, baseCommit, attached: false, created: false };
    }
    throw new Error("requested worktree slot is already registered with different Git coordinates");
  }
  // Never delete the deterministic leaf while the requested branch exists. Git may have
  // canonicalized a symlinked path differently from the runner; a branch/registration collision is
  // therefore ambiguity, not proof that the leaf is an abandoned session directory.
  if (parseWorktreePorcelain(listed).some((entry) => entry.branch === branch)) {
    throw new Error("requested worktree branch is already registered at a different path");
  }
  const branchRef = `refs/heads/${branch}`;
  options.onProgress?.("validating");
  const existingBranch = (await command(
    context,
    repoPath,
    ["for-each-ref", "--format=%(refname)", branchRef],
  )).trim();
  if (existingBranch === branchRef) throw new Error("requested worktree branch already exists");
  options.onProgress?.("materializing");
  await removeExternalDirectory(context, path, options);
  await command(context, repoPath, ["worktree", "add", "-b", branch, path, baseCommit], 120_000);
  return { path, branch, baseRef, baseCommit, attached: false, created: true };
}

/** Resolve and fetch the remote's advertised default branch. No primary-checkout HEAD or current
 * branch participates in the result. */
export async function fetchRemoteDefaultBase(
  repoPath: string,
  options: WorktreeOptions = {},
  remote = "origin",
): Promise<{ ref: string; branch: string }> {
  const context = options.context ?? nativeContext;
  safeGitArgument(remote, "Git remote");
  options.onProgress?.("resolving_remote");
  const advertised = await command(context, repoPath, ["ls-remote", "--symref", remote, "HEAD"], 120_000);
  const headRef = advertised.split("\n")
    .map((line) => /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/u.exec(line)?.[1])
    .find((value): value is string => !!value);
  if (!headRef) throw new Error(`remote ${remote} did not advertise a default branch`);
  const branch = headRef.slice("refs/heads/".length);
  safeGitArgument(branch, "remote default branch");
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  options.onProgress?.("fetching_remote");
  await command(context, repoPath, ["fetch", "--no-tags", remote, `+${headRef}:${trackingRef}`], 120_000);
  // The branch is returned alongside the ref because this call just asked the remote itself, which
  // makes it the only authoritative answer available without a second round trip.
  return { ref: `${remote}/${branch}`, branch };
}

/**
 * The repository's default branch, read from the remote HEAD Git already tracks locally.
 *
 * Deliberately network-free, unlike `fetchRemoteDefaultBase` above: this rides along with every
 * worktree record purely so the UI can tell a routine base from a deliberate one, and that is not
 * worth a round trip on the worktree-creation path. `refs/remotes/<remote>/HEAD` is written by
 * `git clone` and by `git remote set-head`; where it is absent the repository has no locally known
 * default and callers get `undefined`, which they must treat as unknown rather than as a guess.
 *
 * KNOWN STALE WINDOW, measured: `git fetch` — including `--all` — never refreshes this ref. A
 * remote that changes its default after clone leaves it pointing at the old branch until someone
 * runs `git remote set-head`. Callers that have just spoken to the remote must therefore prefer
 * what it advertised; this is the fallback for callers that have not. The dangling case is handled
 * here: if the recorded default no longer has a tracking ref, the answer is `undefined` rather than
 * a branch name nothing backs.
 */
export async function readRepositoryDefaultBranch(
  repoPath: string,
  options: WorktreeOptions = {},
  remote = "origin",
): Promise<string | undefined> {
  const context = options.context ?? nativeContext;
  safeGitArgument(remote, "Git remote");
  let head: string;
  try {
    head = (await command(context, repoPath, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`])).trim();
  } catch {
    // `symbolic-ref` exits non-zero when the remote HEAD has never been recorded. That is an
    // ordinary state for a repository added by path rather than cloned, not a failure worth
    // propagating into worktree creation.
    return undefined;
  }
  if (!head) return undefined;
  const prefix = `${remote}/`;
  const branch = head.startsWith(prefix) ? head.slice(prefix.length) : head;
  if (!branch) return undefined;
  try {
    await command(context, repoPath, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/remotes/${remote}/${branch}`]);
  } catch {
    // The symbolic ref outlived the branch it names — a pruned or renamed default. Reporting it
    // would have the Inbox hide a base ref on the strength of a branch that no longer exists.
    return undefined;
  }
  return branch;
}

interface ListedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  /** Git documents the main worktree as the first porcelain record, including for bare repos. */
  primary: boolean;
  bare: boolean;
}

function parseWorktreePorcelain(value: string): ListedWorktree[] {
  return value.split("\0\0").flatMap((block, index) => {
    const fields = block.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? null;
    const branchRef = fields.find((field) => field.startsWith("branch "))?.slice(7);
    if (!path) return [];
    const bare = fields.includes("bare");
    return [{
      path,
      head,
      branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice(11) : null,
      primary: index === 0 || bare,
      bare,
    }];
  });
}

export function pathWithin(context: AgentContext, candidate: string, root: string): boolean {
  if (sameWorktreePath(context, candidate, root)) return true;
  if (context.kind === "wsl") return candidate.startsWith(root.replace(/\/$/u, "") + "/");
  const normalizedCandidate = canonicalNativePath(candidate).replace(/\\/gu, "/");
  const normalizedRoot = canonicalNativePath(root).replace(/\\/gu, "/");
  const insensitive = process.platform === "win32";
  return (insensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate)
    .startsWith((insensitive ? normalizedRoot.toLowerCase() : normalizedRoot) + "/");
}

/** Attach only a Git-registered linked worktree of the session's own repository. Merely existing on
 * disk is insufficient — and so is living inside a configured Project Location, which is not what
 * ties a worktree to a project. The repository's worktree list is that authoritative link, so the
 * Location boundary is applied to the REPOSITORY rather than to the worktree's own directory: a
 * worktree a configured project registers may live anywhere, which the common
 * `../<repo>-worktrees/<slug>` layout beside the checkout routinely does. This never widens what a
 * session may reach beyond its own repository's worktrees, because registration is still required.
 * Callers re-verifying an already-attributed coordinate keep passing that exact path, and the
 * runner-owned session boundary stays accepted on its own. */
export async function attachRequestedWorktree(
  repoPath: string,
  sessionId: string,
  requestedPath: string,
  options: RequestedWorktreeOptions = {},
): Promise<SessionWorktreeHandle> {
  const context = options.context ?? nativeContext;
  const path = safeGitArgument(requestedPath, "worktree path");
  const listed = parseWorktreePorcelain(await command(context, repoPath, ["worktree", "list", "--porcelain", "-z"]));
  // Git documents the main worktree first, so this is the repository every listed entry belongs
  // to. It is named in both refusals below: a caller has to be able to tell "this repository does
  // not know that path" from "no Project Location covers this repository".
  const repository = listed.find((entry) => entry.primary)?.path ?? repoPath;
  if (!listed.some((entry) => sameWorktreePath(context, entry.path, path))) {
    throw new Error(`worktree path is not registered by the repository it was matched against (${repository})`);
  }
  const allowedRoots = options.allowedProjectPaths ?? [];
  const runnerBoundary = await requestedWorktreeBoundary(repoPath, sessionId, options, false);
  const registeringRepositoryIsConfigured = allowedRoots.some((root) =>
    pathWithin(context, repository, root) || pathWithin(context, repoPath, root));
  const pathIsInsideAnAllowedRoot = pathWithin(context, path, runnerBoundary) ||
    allowedRoots.some((root) => pathWithin(context, path, root));
  if (!registeringRepositoryIsConfigured && !pathIsInsideAnAllowedRoot) {
    throw new Error(
      `worktree path matched none of the runner's configured Project Locations: the repository that registers it (${repository}) is outside every configured Location`,
    );
  }
  return registeredSessionWorktree(repoPath, path, options);
}

/** Prove a path is still a usable linked worktree of `repoPath`: registered, not the primary
 * workspace, not detached, and healthy. Split out of attachRequestedWorktree() so callers that
 * already hold a runner-persisted coordinate can re-prove it without the Project Locations boundary
 * check — and, more importantly, without the boundary's `mkdir`, which has no business running on a
 * read path such as a file listing. */
export async function registeredSessionWorktree(
  repoPath: string,
  requestedPath: string,
  options: WorktreeOptions = {},
): Promise<SessionWorktreeHandle> {
  const context = options.context ?? nativeContext;
  const path = safeGitArgument(requestedPath, "worktree path");
  const listed = parseWorktreePorcelain(await command(context, repoPath, ["worktree", "list", "--porcelain", "-z"]));
  const repository = listed.find((entry) => entry.primary)?.path ?? repoPath;
  const match = listed.find((entry) => sameWorktreePath(context, entry.path, path));
  if (!match) {
    throw new Error(`worktree path is not registered by the repository it was matched against (${repository})`);
  }
  if (match.primary) {
    throw new Error("the repository's primary workspace cannot be attached as a session worktree");
  }
  if (!match.branch || !match.head) throw new Error("a detached worktree cannot be attached to a session");
  const healthy = (await command(context, match.path, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  if (!healthy) throw new Error("registered worktree is not healthy");
  // Registration proves only that the repository once recorded this path, and the health check
  // proves only that *some* work tree is there now. A stale or tampered record whose directory has
  // since become — or come to symlink to — a different repository would otherwise be accepted, and
  // bound writable at the next launch, handing the session a repository it never had. Registration
  // is what bounds reach here, so compare the repository each side actually resolves to rather than
  // trusting the path that named it.
  const [attachedRepository, sessionRepository] = await Promise.all([
    command(context, match.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    command(context, repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  if (!sameWorktreePath(context, attachedRepository.trim(), sessionRepository.trim())) {
    throw new Error(`registered worktree belongs to a different repository than the session (${repository})`);
  }
  return {
    path: match.path,
    branch: match.branch,
    baseRef: match.head,
    baseCommit: match.head,
    attached: true,
    created: false,
  };
}

/** True if `repoPath` is inside a git work tree in the requested context. */
export async function isGitRepo(repoPath: string, options: WorktreeOptions = {}): Promise<boolean> {
  try {
    return (await command(options.context ?? nativeContext, repoPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch (error) {
    const detail = `${(error as { stderr?: string }).stderr ?? ""}\n${(error as Error).message}`;
    if (/not a git repository/i.test(detail)) return false;
    throw new Error(`git preflight failed in the selected runner context: ${(error as Error).message}`);
  }
}

/** Reuse a persisted pre-attestation WSL worktree only when its exact expected path remains
 * registered and healthy. Kept independent from WSL command execution so every fail-closed
 * decision is covered on all CI hosts. */
export async function reuseRegisteredLegacyWslWorktree(
  persistedPath: string,
  expectedPath: string,
  sessionId: string,
  porcelain: string,
  isHealthy: () => Promise<boolean>,
): Promise<WorktreeHandle> {
  if (persistedPath.replace(/\/$/u, "") !== expectedPath.replace(/\/$/u, "")) {
    throw new Error("persisted WSL worktree is outside the expected legacy session path");
  }
  const registered = porcelain
    .split(/\n\s*\n/u)
    .map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice(9).trim())
    .filter((candidate): candidate is string => !!candidate)
    .some((candidate) => candidate.replace(/\/$/u, "") === expectedPath.replace(/\/$/u, ""));
  if (!registered) {
    throw new Error("persisted legacy WSL worktree is no longer registered; recover it manually before restarting this session");
  }
  try {
    if (await isHealthy()) {
      return { path: expectedPath, branch: `agent/${sessionId}`, created: false };
    }
  } catch {
    // Fail closed below so user changes are never replaced.
  }
  throw new Error("persisted legacy WSL worktree is not healthy; recover it manually before restarting this session");
}

/** The branch `createWorktree` gives a session its own worktree under `path`. Session metadata that
 * predates `worktreeBranch` records no identity of its own, so verification derives it here instead
 * of inventing one. The owner-instance root is the only layout that carries the hash prefix: a
 * pre-attestation worktree under the legacy home root keeps the plain name even on an owner-hashed
 * runner, because that is the branch `createWorktree` reuses it under. Matching the owner root
 * positively — rather than ruling the legacy root out — keeps an unusual WSL `$HOME` from
 * misclassifying a real owner-rooted path. Deliberately free of WSL command execution so every case
 * is covered on any CI host. */
/** True when `path` is exactly this session's pre-attestation legacy WSL worktree: the root
 * `worktreeRootPath({ legacyWslRoot: true })` builds, followed by this repository's key and session
 * id. Deciding it by that whole suffix rather than by a bare `/.agent-manager/worktrees/` substring
 * is what keeps an owner-instance path out: its own `worktrees` segment sits under
 * `runner-instances/<ownerHash>`, so it can never end this way, however unusual the distro user's
 * `$HOME` is. `$HOME` is deliberately not consulted — resolving it costs a round trip into the
 * distro, and `reuseRegisteredLegacyWslWorktree()` re-proves the whole path before reusing
 * anything, so a wrong guess here fails closed rather than adopting a foreign tree. */
export function isLegacyWslSessionWorktreePath(
  path: string,
  repoPath: string,
  sessionId: string,
): boolean {
  return path.replace(/\/$/u, "")
    .endsWith(`/.agent-manager/worktrees/${repoKey(repoPath)}/${sessionId}`);
}

export function sessionWorktreeBranch(
  sessionId: string,
  path: string,
  context: AgentContext,
  ownerHash?: string,
): string {
  return context.kind === "wsl" && ownerHash &&
    path.includes(`/.agent-manager/runner-instances/${ownerHash}/worktrees/`)
    ? `agent/${ownerHash.slice(0, 16)}/${sessionId}`
    : `agent/${sessionId}`;
}

export async function createWorktree(repoPath: string, sessionId: string, options: WorktreeOptions = {}): Promise<WorktreeHandle> {
  const context = options.context ?? nativeContext;
  const branch = context.kind === "wsl" && options.ownerHash
    ? `agent/${options.ownerHash.slice(0, 16)}/${sessionId}`
    : `agent/${sessionId}`;
  const listed = await command(context, repoPath, ["worktree", "list", "--porcelain"]);
  if (context.kind === "wsl" && options.legacyWslWorktreePath) {
    // Reusing an already registered worktree neither allocates storage nor needs the new owner's
    // root. Avoid rejecting recovery solely because creation capacity is currently unavailable.
    const legacyPath = await sessionPath(repoPath, sessionId, { ...options, legacyWslRoot: true }, false);
    return reuseRegisteredLegacyWslWorktree(
      options.legacyWslWorktreePath, legacyPath, sessionId, listed,
      async () => (await command(context, legacyPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true",
    );
  }
  const path = await sessionPath(repoPath, sessionId, options);
  const registered = listed
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice(9).trim())
    .filter((candidate): candidate is string => !!candidate)
    .some((candidate) => sameWorktreePath(context, candidate, path));
  if (registered) {
    try {
      if ((await command(context, path, ["rev-parse", "--is-inside-work-tree"])).trim() === "true") {
        return { path, branch, created: false };
      }
    } catch { /* stale registration: remove below */ }
    await command(context, repoPath, ["worktree", "remove", "--force", path], 120_000).catch(() => {});
    await command(context, repoPath, ["worktree", "prune"]).catch(() => {});
  } else {
    // A crash can leave an unregistered directory at the deterministic path. It is owned by this
    // exact session root, so clear it before `git worktree add` rather than failing every restart.
    await removeExternalDirectory(context, path, options);
  }
  await command(context, repoPath, ["worktree", "add", "-B", branch, path, "HEAD"], 120_000);
  return { path, branch, created: true };
}

export function sameWorktreePath(context: AgentContext, left: string, right: string): boolean {
  if (context.kind === "wsl") return left.replace(/\/$/, "") === right.replace(/\/$/, "");
  const normalize = (value: string) => {
    const normalized = canonicalNativePath(value).replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function canonicalNativePath(value: string): string {
  const absolute = resolve(value);
  let cursor = absolute;
  const suffix: string[] = [];
  try {
    while (true) {
      try {
        return join(realpathSync.native(cursor), ...suffix.reverse());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const parent = dirname(cursor);
        if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === cursor) return absolute;
        suffix.push(basename(cursor));
        cursor = parent;
      }
    }
  } catch {
    return absolute;
  }
}

export async function createWorktreeFromTree(
  repoPath: string,
  sessionId: string,
  tree: string,
  baseRef: string,
  options: WorktreeOptions = {},
): Promise<WorktreeHandle> {
  const context = options.context ?? nativeContext;
  const path = await sessionPath(repoPath, sessionId, options);
  const branch = context.kind === "wsl" && options.ownerHash
    ? `agent/${options.ownerHash.slice(0, 16)}/${sessionId}`
    : `agent/${sessionId}`;
  await command(context, repoPath, ["worktree", "add", "-B", branch, path, baseRef], 120_000);
  const handle = { path, branch, created: true };
  try {
    await withGitExecutionContext(context, () => restoreWorktreeToTree(path, tree));
    return handle;
  } catch (error) {
    await removeWorktree(repoPath, handle, options);
    throw error;
  }
}

export async function worktreeHead(worktreePath: string, options: WorktreeOptions = {}): Promise<string> {
  return (await command(options.context ?? nativeContext, worktreePath, ["rev-parse", "HEAD"])).trim();
}

/** Return the branch Git currently has checked out, or no value for a detached/unavailable tree. */
export async function worktreeBranch(
  worktreePath: string,
  options: WorktreeOptions & { timeoutMs?: number } = {},
): Promise<string | undefined> {
  const context = options.context ?? nativeContext;
  try {
    // Git can only point HEAD at a valid ref, so one bounded symbolic-ref probe supplies both the
    // detached check and the already-validated short branch name.
    const branch = (await command(
      context,
      worktreePath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      options.timeoutMs,
    )).trim();
    return branch ? safeGitArgument(branch, "worktree branch") : undefined;
  } catch {
    return undefined;
  }
}

export type PullRequestLifecycleState = "open" | "merged" | "closed";
export type PullRequestLifecycleProof = {
  state: PullRequestLifecycleState;
  headOid?: string;
};
export type DiscoveredMergedPullRequest = {
  url: string;
  state: "merged";
  headOid: string;
  provider: "github";
  kind: "pull_request";
};

export type MissingUpstreamPullRequestIdentity = {
  remote: string;
  merge: string;
  headOid: string;
};

export interface MergedWorktreePullRequestDiscoveryOptions extends WorktreeOptions {
  /** Test-only subprocess seam. Production resolves the forge command exactly as before. */
  runForgeCommand?: typeof runContextCommand;
  /** Periodic reconciliation shortens local probes; explicit operations retain the default. */
  preflightTimeoutMs?: number;
  /** Admission hook used by periodic reconciliation after all cheap fail-closed Git gates pass. */
  onForgeAttempt?: (identity: MissingUpstreamPullRequestIdentity) => boolean;
  /** Clears a prior negative when Git proves this branch no longer has the cached eligibility. */
  onIneligible?: () => void;
  /** Distinguishes transport/auth/tool failure from an authoritative empty forge response. */
  onForgeUnavailable?: () => void;
}
type LinkedChangeRequest = {
  provider: ForgeProvider;
  host: string;
  project: string;
  number: number;
};

function linkedChangeRequest(value: string): LinkedChangeRequest | null {
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const github = url.pathname.match(/^\/([^/\s]+\/[^/\s]+)\/pull\/([1-9]\d*)$/u);
    if (url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && !url.port && github) {
      return { provider: "github", host: "github.com", project: github[1]!, number: Number(github[2]) };
    }
    const gitlab = url.pathname.match(/^\/(.+)\/-\/merge_requests\/([1-9]\d*)$/u);
    const project = gitlab?.[1] ?? "";
    if (!gitlab || /[\0\r\n\\]/u.test(project) || project.length > 512 ||
        project.split("/").some((part) => !part || part === "." || part === "..")) return null;
    return { provider: "gitlab", host: url.host.toLowerCase(), project, number: Number(gitlab[2]) };
  } catch {
    return null;
  }
}

export function parseWorktreePullRequestState(
  raw: string,
  expectedUrl: string,
): PullRequestLifecycleProof | null {
  const expected = linkedChangeRequest(expectedUrl);
  if (!expected) return null;
  try {
    const parsed = JSON.parse(raw) as {
      url?: unknown;
      web_url?: unknown;
      state?: unknown;
      headRefOid?: unknown;
      sha?: unknown;
    };
    const headOid = expected.provider === "github" ? parsed.headRefOid : parsed.sha;
    if ((expected.provider === "github" ? parsed.url : parsed.web_url) !== expectedUrl ||
        typeof parsed.state !== "string") return null;
    const proof = typeof headOid === "string" && /^[a-f0-9]{40,64}$/iu.test(headOid)
      ? { headOid: headOid.toLowerCase() }
      : {};
    const state = parsed.state.toUpperCase();
    if (state === "OPEN" || state === "OPENED") return { state: "open", ...proof };
    if (state === "MERGED") return { state: "merged", ...proof };
    if (state === "CLOSED") return { state: "closed", ...proof };
    return null;
  } catch {
    return null;
  }
}

/** Accept branch discovery only when GitHub reports a merged pull request for the exact local
 * branch head. Any matching merged request is sufficient delivery proof; malformed or stale
 * results remain indistinguishable from no proof. */
export function parseMergedWorktreePullRequestForBranch(
  raw: string,
  expectedBranch: string,
  expectedHead: string,
): DiscoveredMergedPullRequest | null {
  if (!/^[a-f0-9]{40,64}$/iu.test(expectedHead)) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      if (item.state !== "MERGED" || item.headRefName !== expectedBranch ||
          typeof item.headRefOid !== "string" || item.headRefOid.toLowerCase() !== expectedHead.toLowerCase() ||
          typeof item.url !== "string") continue;
      const request = linkedChangeRequest(item.url);
      if (request?.provider !== "github") continue;
      return {
        url: item.url,
        state: "merged",
        headOid: item.headRefOid.toLowerCase(),
        provider: "github",
        kind: "pull_request",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Read one exact linked GitHub pull request. Network/auth/shape failures are deliberately
 * indistinguishable from unavailable state: absence of proof is never permission to delete. */
export async function worktreePullRequestState(
  worktreePath: string,
  pullRequestUrl: string,
  options: WorktreeOptions & { provider?: ForgeProvider } = {},
): Promise<PullRequestLifecycleProof | null> {
  const request = linkedChangeRequest(pullRequestUrl);
  if (!request || (request.provider === "gitlab" && options.provider !== "gitlab")) return null;
  try {
    const result = await runContextCommand(
      options.context ?? nativeContext,
      request.provider === "github" ? "gh" : "glab",
      request.provider === "github"
        ? ["pr", "view", pullRequestUrl, "--json", "url,state,headRefOid"]
        : [
          "api", `projects/${encodeURIComponent(request.project)}/merge_requests/${request.number}`,
          "--hostname", request.host,
        ],
      { cwd: worktreePath, timeoutMs: 30_000, maxBuffer: 1024 * 1024 },
    );
    return parseWorktreePullRequestState(result.stdout, pullRequestUrl);
  } catch {
    return null;
  }
}

/** Recover the merged change-request link for a branch pushed by an external workflow. Discovery
 * is deliberately limited to a configured same-name remote upstream whose tracking ref vanished;
 * a branch that was never pushed must not gain deletion permission from an unrelated PR. */
export async function mergedWorktreePullRequestForBranch(
  worktreePath: string,
  branch: string,
  options: MergedWorktreePullRequestDiscoveryOptions = {},
): Promise<DiscoveredMergedPullRequest | null> {
  const context = options.context ?? nativeContext;
  const preflightTimeoutMs = options.preflightTimeoutMs ?? 30_000;
  try {
    const remote = (await command(
      context, worktreePath,
      ["config", "--get", "--default", "", `branch.${branch}.remote`],
      preflightTimeoutMs,
    )).trim();
    const merge = (await command(
      context, worktreePath,
      ["config", "--get", "--default", "", `branch.${branch}.merge`],
      preflightTimeoutMs,
    )).trim();
    if (!remote || remote === "." || merge !== `refs/heads/${branch}`) {
      options.onIneligible?.();
      return null;
    }
    try {
      await command(context, worktreePath, ["rev-parse", "--verify", `${branch}@{upstream}`], preflightTimeoutMs);
      options.onIneligible?.();
      return null;
    } catch {
      // A configured upstream whose ref disappeared is the only state eligible for forge recovery.
    }
    const head = (await command(
      context, worktreePath, ["rev-parse", "--verify", "HEAD"], preflightTimeoutMs,
    )).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(head)) {
      options.onIneligible?.();
      return null;
    }
    const identity = { remote, merge, headOid: head };
    if (options.onForgeAttempt && !options.onForgeAttempt(identity)) return null;
    try {
      const result = await (options.runForgeCommand ?? runContextCommand)(
        context,
        "gh",
        [
          "pr", "list", "--head", branch, "--state", "merged", "--limit", "100",
          "--json", "url,state,headRefOid,headRefName",
        ],
        { cwd: worktreePath, timeoutMs: 30_000, maxBuffer: 1024 * 1024 },
      );
      return parseMergedWorktreePullRequestForBranch(result.stdout, branch, head);
    } catch {
      options.onForgeUnavailable?.();
      return null;
    }
  } catch {
    // A failed Git preflight is unavailable evidence, not proof that the candidate became
    // ineligible. Preserve any authoritative negative so a transient timeout cannot defeat
    // the reconciliation backoff.
    return null;
  }
}

export type SafeWorktreeDiscardResult =
  | { removed: true }
  | {
      removed: false;
      reason: "branch_changed";
      checkedOutBranch: string;
    }
  | {
      removed: false;
      reason: "detached_head" | "not_runner_owned" | "dirty" | "no_upstream" | "unpushed" | "unavailable";
    };

export type RetainedWorktreeRefReclaimResult =
  | { state: "pending"; reason: RetainedWorktreeRefPendingReason }
  | { state: "completed"; reason: "deleted" | "already_missing" }
  | {
      state: "retained";
      reason: "default_branch" | "default_unproved_at_handoff" | "ref_changed_or_recreated" |
        "identity_unproved" | "delivery_unproved";
    };

async function localBranchOid(
  context: AgentContext,
  repoPath: string,
  ref: string,
): Promise<string | undefined> {
  const refs = await command(
    context,
    repoPath,
    ["for-each-ref", "--format=%(refname)%09%(objectname)", ref],
  );
  const oid = refs.split(/\r?\n/u).map((line) => line.split("\t", 2))
    .find(([candidate]) => candidate === ref)?.[1]?.trim();
  if (!oid) return undefined;
  if (!/^[a-f0-9]{40,64}$/u.test(oid)) throw new Error("local branch has an invalid object id");
  return oid;
}

async function localBranchIdentity(
  context: AgentContext,
  repoPath: string,
  ref: string,
): Promise<{ oid: string; identityToken?: string } | undefined> {
  const oid = await localBranchOid(context, repoPath, ref);
  if (!oid) return undefined;
  let identityToken: string | undefined;
  try {
    const reflog = await command(context, repoPath, [
      "reflog", "show", "--max-count=1", "--date=raw",
      "--format=%H%x00%gD%x00%gs",
      ref,
    ]);
    const commonDir = (await command(
      context,
      repoPath,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )).trim().replace(/[\\/]+$/u, "");
    const reflogPath = context.kind === "wsl"
      ? `${commonDir}/logs/${ref}`
      : join(commonDir, "logs", ...ref.split("/"));
    const fileIdentity = context.kind === "wsl"
      ? (await runContextCommand(
          context,
          "stat",
          ["-c", "%d:%i:%w:%z:%s", "--", reflogPath],
          { cwd: "/", timeoutMs: 8_000 },
        )).stdout.trim()
      : (() => {
          const stat = statSync(reflogPath);
          return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.size}`;
        })();
    if (reflog && fileIdentity) {
      identityToken = createHash("sha256").update(reflog).update("\0").update(fileIdentity).digest("hex");
    }
  } catch {
    // A missing reflog is not permission to delete. Persist the OID-only ownership record and
    // let reclamation terminally retain it as identity_unproved.
  }
  const confirmedOid = await localBranchOid(context, repoPath, ref);
  if (confirmedOid !== oid) throw new Error("local branch changed while its identity was captured");
  return { oid, ...(identityToken ? { identityToken } : {}) };
}

async function retainedRefDeliveryProven(
  record: RetainedWorktreeRefRecord,
  context: AgentContext,
  ref: string,
  defaultBranch: string,
): Promise<boolean> {
  if (record.verifiedMergedHead === record.expectedOid) return true;
  try {
    await command(context, record.repoPath, ["rev-parse", "--verify", `${record.branch}@{upstream}`]);
    const ahead = (await command(
      context,
      record.repoPath,
      ["rev-list", "--count", `${record.branch}@{upstream}..${ref}`],
    )).trim();
    if (/^\d+$/u.test(ahead) && ahead === "0") return true;
  } catch {
    // A missing or unreadable upstream may still be replaced by default-branch containment.
  }
  try {
    const validatedDefault = await validateBranch(context, record.repoPath, defaultBranch);
    const defaultRef = `refs/remotes/origin/${validatedDefault}`;
    const ahead = (await command(
      context,
      record.repoPath,
      ["rev-list", "--count", `${defaultRef}..${ref}`],
    )).trim();
    return /^\d+$/u.test(ahead) && ahead === "0";
  } catch {
    return false;
  }
}

/** Reclaim one retained local branch only after re-proving every safety property. The final
 * update-ref is compare-and-delete against the captured object id after a generation check, so an
 * advance or same-OID recreation is retained. A crash after deletion is idempotent: the next pass
 * observes an already-missing ref. */
export async function reclaimRetainedWorktreeRef(
  record: RetainedWorktreeRefRecord,
  options: WorktreeOptions & { beforeDelete?: () => Promise<void> } = {},
): Promise<RetainedWorktreeRefReclaimResult> {
  const context = options.context ?? record.context;
  if (JSON.stringify(context) !== JSON.stringify(record.context) ||
      !/^[a-f0-9]{40,64}$/u.test(record.expectedOid)) {
    return { state: "pending", reason: "git_unavailable" };
  }
  let branch: string;
  try {
    branch = await validateBranch(context, record.repoPath, record.branch);
  } catch {
    return { state: "pending", reason: "git_unavailable" };
  }
  const ref = `refs/heads/${branch}`;
  try {
    if (record.reasons.includes("default_branch")) {
      return { state: "retained", reason: "default_branch" };
    }
    if (record.reasons.includes("default_unknown")) {
      return { state: "retained", reason: "default_unproved_at_handoff" };
    }
    const defaultBranch = await readRepositoryDefaultBranch(record.repoPath, { ...options, context });
    if (!defaultBranch) return { state: "pending", reason: "default_unknown" };
    if (defaultBranch === branch) return { state: "retained", reason: "default_branch" };

    const checkedOut = parseWorktreePorcelain(
      await command(context, record.repoPath, ["worktree", "list", "--porcelain", "-z"]),
    ).some((entry) => entry.branch === branch);
    if (checkedOut) return { state: "pending", reason: "checked_out" };

    const currentIdentity = await localBranchIdentity(context, record.repoPath, ref);
    if (!currentIdentity) return { state: "completed", reason: "already_missing" };
    if (currentIdentity.oid !== record.expectedOid) {
      return { state: "retained", reason: "ref_changed_or_recreated" };
    }
    if (!record.identityToken || !currentIdentity.identityToken) {
      return { state: "retained", reason: "identity_unproved" };
    }
    if (currentIdentity.identityToken !== record.identityToken) {
      return { state: "retained", reason: "ref_changed_or_recreated" };
    }
    if (!await retainedRefDeliveryProven(record, context, ref, defaultBranch)) {
      return { state: "retained", reason: "delivery_unproved" };
    }

    await options.beforeDelete?.();

    // Re-read the mutable global facts immediately before the compare-and-delete. A default-branch
    // change or a newly shared checkout is never treated as permission inherited from an old scan.
    const finalDefault = await readRepositoryDefaultBranch(record.repoPath, { ...options, context });
    if (!finalDefault) return { state: "pending", reason: "default_unknown" };
    if (finalDefault === branch) return { state: "retained", reason: "default_branch" };
    const finallyCheckedOut = parseWorktreePorcelain(
      await command(context, record.repoPath, ["worktree", "list", "--porcelain", "-z"]),
    ).some((entry) => entry.branch === branch);
    if (finallyCheckedOut) return { state: "pending", reason: "checked_out" };
    const finalIdentity = await localBranchIdentity(context, record.repoPath, ref);
    if (!finalIdentity) return { state: "completed", reason: "already_missing" };
    if (finalIdentity.oid !== record.expectedOid || finalIdentity.identityToken !== record.identityToken) {
      return { state: "retained", reason: "ref_changed_or_recreated" };
    }
    try {
      await command(context, record.repoPath, ["update-ref", "-d", ref, record.expectedOid]);
      return { state: "completed", reason: "deleted" };
    } catch {
      const after = await localBranchOid(context, record.repoPath, ref);
      if (!after) return { state: "completed", reason: "already_missing" };
      if (after !== record.expectedOid) {
        return { state: "retained", reason: "ref_changed_or_recreated" };
      }
      return { state: "pending", reason: "git_unavailable" };
    }
  } catch {
    return { state: "pending", reason: "git_unavailable" };
  }
}

/** Remove one inactive runner-owned worktree only after proving it has no local-only state.
 * The worktree removal is intentionally non-force, so a concurrent file write fails closed. The
 * branch delete is compare-and-delete against the exact inspected OID, so a concurrent commit is
 * retained even if it lands after the final status check. */
export async function discardWorktreeIfSafe(
  repoPath: string,
  sessionId: string,
  handle: WorktreeHandle & { source: "legacy" | "created" },
  options: WorktreeOptions & {
    verifiedMergedHead?: string;
    beforeRemove?: () => Promise<void>;
    retainRefs?: (refs: RetainedWorktreeRefCandidate[]) => Promise<void>;
  } = {},
): Promise<SafeWorktreeDiscardResult> {
  const context = options.context ?? nativeContext;
  const recordedBranch = await validateBranch(context, repoPath, handle.branch);
  const requestedBoundary = await requestedWorktreeBoundaryPath(repoPath, sessionId, options, false);
  const currentLegacyPath = await sessionPath(repoPath, sessionId, options, false);
  const legacyPaths = [currentLegacyPath];
  if (context.kind === "wsl") {
    legacyPaths.push(await sessionPath(repoPath, sessionId, { ...options, legacyWslRoot: true }, false));
  }
  const runnerOwned = handle.source === "created"
    ? pathWithin(context, handle.path, requestedBoundary) && !sameWorktreePath(context, handle.path, requestedBoundary)
    : legacyPaths.some((path) => sameWorktreePath(context, handle.path, path));
  if (!runnerOwned) {
    return { removed: false, reason: "not_runner_owned" };
  }

  try {
    const listed = parseWorktreePorcelain(
      await command(context, repoPath, ["worktree", "list", "--porcelain", "-z"]),
    );
    const registered = listed.find((entry) => sameWorktreePath(context, entry.path, handle.path));
    // The runner-owned path remains the ownership boundary after an issue workflow switches its
    // branch. Use the checkout's real branch for safety and deletion, never the stale recorded ref.
    let branch = recordedBranch;
    let branchChanged = false;
    if (registered && registered.branch !== recordedBranch) {
      if (!registered.branch) {
        return { removed: false, reason: "detached_head" };
      }
      branch = await validateBranch(context, repoPath, registered.branch);
      branchChanged = true;
    }
    const branchCheckedOutElsewhere = listed.some((entry) =>
      !sameWorktreePath(context, entry.path, handle.path) && entry.branch === branch);
    const ref = `refs/heads/${branch}`;
    if (!registered) {
      // A missing registration is not proof that the on-disk directory is disposable. Native can
      // distinguish a missing leaf below the already-attested root; WSL transport errors cannot
      // distinguish absence from an unavailable distro, so retain there.
      if (context.kind === "wsl") return { removed: false, reason: "unavailable" };
      try {
        statSync(handle.path);
        return { removed: false, reason: "unavailable" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return { removed: false, reason: "unavailable" };
        }
      }
      // Once Git no longer registers the worktree, no current branch identity links an arbitrary
      // local ref to this cleanup occurrence. Treat removal as complete and let any candidate
      // durably captured by the original pass flow through the retained-ref reclaimer. Process
      // retirement and teardown still run: the missing directory does not prove its descendants
      // exited, and their port allocation must not be released while they remain live.
      await options.beforeRemove?.();
      return { removed: true };
    }

    if (await command(context, handle.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
      return { removed: false, reason: "dirty" };
    }
    const head = (await command(context, handle.path, ["rev-parse", "--verify", "HEAD"])).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(head)) return { removed: false, reason: "unavailable" };

    // Git permits another worktree to deliberately share this branch via
    // --ignore-other-worktrees. Removing this worktree must not detach that sibling from its ref,
    // whether this checkout still uses the recorded branch or switched to a replacement.
    let preserveCheckedOutRef = branchCheckedOutElsewhere;
    const checkedOutRefReasons: RetainedWorktreeRefReason[] = branchCheckedOutElsewhere
      ? ["shared_checkout"]
      : [];
    let checkedOutVerifiedMergedHead: string | undefined;
    if (branchChanged) {
      // A pushed-but-unmerged replacement is not enough: unlike the recorded branch, its upstream
      // was never part of the ownership record. Require delivery proof or no work beyond default.
      const mergedHead = options.verifiedMergedHead;
      let safeChangedHead = typeof mergedHead === "string" && /^[a-f0-9]{40,64}$/u.test(mergedHead) &&
        mergedHead === head;
      if (safeChangedHead) checkedOutVerifiedMergedHead = mergedHead;
      const defaultBranch = await readRepositoryDefaultBranch(repoPath, options);
      // Removing a runner-owned worktree must not remove the repository's conventional local base
      // ref when an agent temporarily checked it out for inspection. An unknown default cannot
      // prove the checked-out ref is disposable, and another worktree may deliberately share the
      // ref via --ignore-other-worktrees, so retain the ref while still removing this tree.
      if (!defaultBranch) checkedOutRefReasons.push("default_unknown");
      else if (defaultBranch === branch) checkedOutRefReasons.push("default_branch");
      preserveCheckedOutRef ||= !defaultBranch || defaultBranch === branch;
      if (!safeChangedHead) {
        if (defaultBranch) {
          try {
            const defaultRef = `refs/remotes/origin/${await validateBranch(context, repoPath, defaultBranch)}`;
            const ahead = (await command(
              context,
              repoPath,
              ["rev-list", "--count", `${defaultRef}..${ref}`],
            )).trim();
            safeChangedHead = ahead === "0";
          } catch {
            // An unreadable default cannot replace exact merged-head proof.
          }
        }
      }
      if (!safeChangedHead) {
        return { removed: false, reason: "branch_changed", checkedOutBranch: branch };
      }
    } else {
      let hasUpstream = true;
      try {
        await command(context, repoPath, ["rev-parse", "--verify", `${branch}@{upstream}`]);
      } catch {
        hasUpstream = false;
      }
      if (hasUpstream) {
        const ahead = (await command(
          context,
          repoPath,
          ["rev-list", "--count", `${branch}@{upstream}..${ref}`],
        )).trim();
        if (!/^\d+$/u.test(ahead)) return { removed: false, reason: "unavailable" };
        if (ahead !== "0") return { removed: false, reason: "unpushed" };
      } else {
        const mergedHead = options.verifiedMergedHead;
        if (typeof mergedHead !== "string" || !/^[a-f0-9]{40,64}$/u.test(mergedHead)) {
          return { removed: false, reason: "no_upstream" };
        }
        if (mergedHead !== head) return { removed: false, reason: "unpushed" };
        checkedOutVerifiedMergedHead = mergedHead;
      }
    }

    const retainedRefs: RetainedWorktreeRefCandidate[] = [];
    if (branchChanged) {
      const recordedRef = `refs/heads/${recordedBranch}`;
      const recordedIdentity = await localBranchIdentity(context, repoPath, recordedRef);
      if (recordedIdentity) {
        retainedRefs.push({
          branch: recordedBranch,
          expectedOid: recordedIdentity.oid,
          ...(recordedIdentity.identityToken ? { identityToken: recordedIdentity.identityToken } : {}),
          reasons: ["recorded_branch"],
        });
      }
    }
    if (preserveCheckedOutRef) {
      const checkedOutIdentity = await localBranchIdentity(context, repoPath, ref);
      if (!checkedOutIdentity || checkedOutIdentity.oid !== head) {
        return { removed: false, reason: "unavailable" };
      }
      retainedRefs.push({
        branch,
        expectedOid: head,
        ...(checkedOutIdentity.identityToken ? { identityToken: checkedOutIdentity.identityToken } : {}),
        reasons: checkedOutRefReasons,
        ...(checkedOutVerifiedMergedHead ? { verifiedMergedHead: checkedOutVerifiedMergedHead } : {}),
      });
    }
    if (retainedRefs.length) await options.retainRefs?.(retainedRefs);

    // Hooks/process retirement are intentionally after the first complete safety proof and before
    // the final race-closing status/head checks. A failure here retains the worktree.
    await options.beforeRemove?.();

    // Close the widest observable race before the non-force removal. Git independently rejects
    // a dirty tree, and update-ref below rejects a branch that advanced after this comparison.
    if (await command(context, handle.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
      return { removed: false, reason: "dirty" };
    }
    const finalHead = (await command(context, handle.path, ["rev-parse", "--verify", "HEAD"])).trim();
    if (finalHead !== head) return { removed: false, reason: "unpushed" };
    await command(context, repoPath, ["worktree", "remove", handle.path], 120_000);
    // For a changed checkout `ref` is the branch actually removed with the worktree; the recorded
    // branch is deliberately untouched, whether its ref still exists or has already disappeared.
    if (!preserveCheckedOutRef) {
      await command(context, repoPath, ["update-ref", "-d", ref, head]);
    }
    await command(context, repoPath, ["worktree", "prune"]);
    return { removed: true };
  } catch {
    return { removed: false, reason: "unavailable" };
  }
}

/** Remove the linked worktree, its branch, and stale administrative records. */
export async function removeWorktree(repoPath: string, handle: WorktreeHandle, options: WorktreeOptions = {}): Promise<void> {
  const context = options.context ?? nativeContext;
  const failures: string[] = [];
  let repositoryUnavailable = false;
  try {
    await command(context, repoPath, ["worktree", "remove", "--force", handle.path], 120_000);
  } catch (error) {
    repositoryUnavailable = nativeRepositoryPathIsUnavailable(context, repoPath) ||
      isMissingGitRepositoryError(error);
    // A crash can remove the directory before metadata/admin cleanup. Prune, then accept the
    // desired end state when git no longer lists the path; cleanup must be safely retryable.
    if (repositoryUnavailable) {
      try { await removeExternalDirectory(context, handle.path, options); }
      catch (removeError) { failures.push(`external remove: ${(removeError as Error).message}`); }
    } else {
      await command(context, repoPath, ["worktree", "prune"]).catch(() => {});
      try {
        const listed = await command(context, repoPath, ["worktree", "list", "--porcelain"]);
        const paths = listed.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9).trim());
        if (paths.includes(handle.path)) failures.push(`remove: ${(error as Error).message}`);
        else await removeExternalDirectory(context, handle.path, options);
      } catch (verifyError) {
        try { await removeExternalDirectory(context, handle.path, options); }
        catch { failures.push(`remove verification: ${(verifyError as Error).message}`); }
      }
    }
  }
  if (!repositoryUnavailable) {
    try { await command(context, repoPath, ["branch", "-D", handle.branch]); }
    catch { /* branch may already be absent */ }
    try { await command(context, repoPath, ["worktree", "prune"]); }
    catch (error) { failures.push(`prune: ${(error as Error).message}`); }
  }
  if (failures.length) throw new Error(`worktree cleanup incomplete (${failures.join("; ")})`);
}

async function removeExternalDirectory(context: AgentContext, path: string, options: WorktreeOptions): Promise<void> {
  const root = await worktreeRootPath(options);
  if (context.kind === "wsl") {
    const prefix = root.replace(/\/$/, "") + "/";
    if (!path.startsWith(prefix) || path === root) throw new Error("refusing to remove a path outside the WSL worktree root");
    const marker = await runContextCommand(
      context,
      "sh",
      [
        "-c",
        'marker="$1/.git"; if [ -d "$marker" ] || [ -L "$marker" ]; then printf registered; ' +
          'elif [ -f "$marker" ]; then gitdir=$(sed -n "s/^gitdir: //p" "$marker"); ' +
          'if [ -z "$gitdir" ]; then printf registered; else case "$gitdir" in /*) ;; *) gitdir="$1/$gitdir" ;; esac; ' +
          'if [ -e "$gitdir" ] || [ -L "$gitdir" ]; then printf registered; fi; fi; fi',
        "sh",
        path,
      ],
      { cwd: "/", timeoutMs: 8_000 },
    );
    if (marker.stdout === "registered") {
      throw new Error("refusing to recursively remove a path that may still be a registered worktree");
    }
    await runContextCommand(context, "rm", ["-rf", "--", path], { cwd: "/", timeoutMs: 120_000 });
    return;
  }
  const absoluteRoot = canonicalNativePath(root);
  const absolutePath = canonicalNativePath(path);
  if (!absolutePath.startsWith(absoluteRoot + sep) || absolutePath === absoluteRoot) {
    throw new Error("refusing to remove a path outside the native worktree root");
  }
  const markerPath = join(absolutePath, ".git");
  try {
    const marker = lstatSync(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink()) {
      throw new Error("refusing to recursively remove a path that may still be a registered worktree");
    }
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(readFileSync(markerPath, "utf8"));
    if (!match) throw new Error("refusing to recursively remove a path with an unrecognized Git marker");
    const gitDir = resolve(absolutePath, match[1]!);
    try {
      lstatSync(gitDir);
      throw new Error("refusing to recursively remove a path that may still be a registered worktree");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(absolutePath, { recursive: true, force: true });
}

export async function worktreeDiff(worktreePath: string, options: WorktreeOptions = {}): Promise<string> {
  const context = options.context ?? nativeContext;
  try {
    const tree = await withGitExecutionContext(context, () => captureWorktreeTree(worktreePath));
    return await command(context, worktreePath, ["diff", "HEAD", tree, "--"]);
  } catch {
    return "";
  }
}

export async function captureTurnDiff(
  worktreePath: string,
  baseTree: string,
  options: WorktreeOptions = {},
): Promise<{ diff: string; tree: string } | null> {
  const context = options.context ?? nativeContext;
  try {
    const tree = await withGitExecutionContext(context, () => captureWorktreeTree(worktreePath));
    return { diff: await command(context, worktreePath, ["diff", baseTree, tree, "--"]), tree };
  } catch {
    return null;
  }
}
