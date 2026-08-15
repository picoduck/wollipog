import type { AgentContext, AgentDriverKind } from "@wollipog/protocol";
import { lstat, readdir, rm } from "node:fs/promises";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { runContextCommand } from "./context-command.js";
import { providerStateKey, removeExecutionIsolationState } from "./execution-isolation.js";
import type { RunnerExecutionIsolation } from "./config.js";

const MIN_ORPHAN_AGE_MS = 60 * 60 * 1000;

export interface ProviderStateCleanupRecord {
  sessionId: string;
  driver: AgentDriverKind;
  context: AgentContext;
}

/** Failed exact-session removals survive process restart and are retried before age-based GC. */
export class ProviderStateCleanupJournal {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "provider-state-cleanup");
    mkdirSync(this.dir, { recursive: true });
  }

  list(): ProviderStateCleanupRecord[] {
    const records: ProviderStateCleanupRecord[] = [];
    for (const name of readdirSync(this.dir).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))) {
      try {
        const record = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as ProviderStateCleanupRecord;
        const validContext = record?.context?.kind === "native" || (
          record?.context?.kind === "wsl" && typeof record.context.distro === "string" && record.context.distro.length > 0
        );
        if (record && typeof record.sessionId === "string" && provider(record.driver) && validContext) {
          records.push(record);
        }
      } catch {
        // A corrupt individual record is retained for operator inspection without hiding other work.
      }
    }
    return records;
  }

  add(record: ProviderStateCleanupRecord): void {
    const path = this.recordPath(record.sessionId);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2));
    renameSync(temp, path);
  }

  remove(sessionId: string): void { rmSync(this.recordPath(sessionId), { force: true }); }

  /** The record file itself is the cross-process creation clock. A freshly journaled fork target
   * must not be reaped by a second runner before the creating process can publish its store row. */
  createdAt(sessionId: string): number {
    try { return statSync(this.recordPath(sessionId)).mtimeMs; } catch { return 0; }
  }

  private recordPath(sessionId: string): string { return join(this.dir, `${providerStateKey(sessionId)}.json`); }
}

export interface StateEntry { name: string; mtimeMs: number; bytes: number; ownerKey?: string; }
export interface StateFs {
  list(context: AgentContext, root: string): Promise<StateEntry[]>;
  claim(context: AgentContext, path: string, ownerKey: string): Promise<void>;
  remove(context: AgentContext, path: string): Promise<void>;
  wslHome(context: Extract<AgentContext, { kind: "wsl" }>): Promise<string>;
}

async function nativeBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await nativeBytes(join(path, entry.name));
  }
  return total;
}

const defaultFs: StateFs = {
  list: async (context, root) => {
    if (context.kind === "wsl") {
      const output = await runContextCommand(context, "find", [
        root, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-printf", "%f\\t%T@\\n",
      ], { cwd: "/", timeoutMs: 10_000 }).then((result) => result.stdout, () => "");
      const raw: Array<{ name: string; mtimeMs: number; path: string }> = [];
      for (const line of output.split(/\r?\n/)) {
        const [name, seconds] = line.split("\t");
        if (!name || !Number.isFinite(Number(seconds))) continue;
        raw.push({ name, mtimeMs: Number(seconds) * 1000, path: posix.join(root, name) });
      }
      const bytes = new Map<string, number>();
      const owners = new Map<string, string>();
      for (let i = 0; i < raw.length; i += 128) {
        const paths = raw.slice(i, i + 128).map((entry) => entry.path);
        const du = (await runContextCommand(
          context, "du", ["-sb", "--", ...paths], { cwd: "/", timeoutMs: 60_000 },
        )).stdout;
        for (const line of du.split(/\r?\n/)) {
          const [count, path] = line.split("\t");
          if (path && Number.isFinite(Number(count))) bytes.set(path, Number(count));
        }
        const ownerOutput = (await runContextCommand(context, "sh", [
          "-c",
          'for p do if [ -f "$p/.owner" ]; then printf "%s\\t" "$p"; cat "$p/.owner"; printf "\\n"; fi; done',
          "sh",
          ...paths,
        ], { cwd: "/", timeoutMs: 10_000 })).stdout;
        for (const line of ownerOutput.split(/\r?\n/)) {
          const [path, ownerKey] = line.split("\t");
          if (path && ownerKey) owners.set(path, ownerKey.trim());
        }
      }
      return raw.map((entry) => ({
        name: entry.name,
        mtimeMs: entry.mtimeMs,
        bytes: bytes.get(entry.path) ?? 0,
        ...(owners.has(entry.path) ? { ownerKey: owners.get(entry.path) } : {}),
      }));
    }
    const rootInfo = await lstat(root).catch(() => null);
    if (!rootInfo) return [];
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`refusing provider-state reconciliation through non-directory root ${root}`);
    }
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const listed = await Promise.all(entries.map(async (entry) => {
      const path = join(root, entry.name);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      let ownerKey: string | undefined;
      try { ownerKey = readFileSync(join(path, ".owner"), "utf8").trim() || undefined; } catch { /* unclaimed */ }
      return { name: entry.name, mtimeMs: info.mtimeMs, bytes: await nativeBytes(path), ...(ownerKey ? { ownerKey } : {}) };
    }));
    return listed.filter((entry): entry is StateEntry => entry !== null);
  },
  claim: async (context, path, ownerKey) => {
    if (context.kind === "wsl") {
      await runContextCommand(context, "sh", [
        "-c",
        'if [ -d "$1" ]; then if [ -f "$1/.owner" ] && [ "$(cat "$1/.owner")" != "$2" ]; then exit 42; fi; printf "%s" "$2" > "$1/.owner"; fi',
        "sh",
        path,
        ownerKey,
      ], { cwd: "/", timeoutMs: 5_000 });
      return;
    }
    const info = await lstat(path).catch(() => null);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`refusing to claim non-directory provider state ${path}`);
    let existing: string | undefined;
    try { existing = readFileSync(join(path, ".owner"), "utf8").trim() || undefined; } catch { /* unclaimed */ }
    if (existing && existing !== ownerKey) throw new Error(`provider-state partition ${path} belongs to another runner`);
    writeFileSync(join(path, ".owner"), ownerKey);
  },
  remove: async (context, path) => {
    if (context.kind === "wsl") {
      await runContextCommand(context, "rm", ["-rf", "--", path], { cwd: "/", timeoutMs: 60_000 });
    } else {
      await rm(path, { recursive: true, force: true });
    }
  },
  wslHome: async (context) => {
    const result = await runContextCommand(context, "sh", ["-c", 'printf "%s" "$HOME"'], { cwd: "/", timeoutMs: 5_000 });
    const home = result.stdout.trim();
    if (!home.startsWith("/") || home.includes("\0") || home.split("/").includes("..")) {
      throw new Error(`could not resolve a safe absolute HOME inside WSL distro ${context.distro}`);
    }
    return posix.normalize(home);
  },
};

function provider(driver: AgentDriverKind): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
}

function sameContext(a: AgentContext, b: AgentContext): boolean {
  return a.kind === b.kind && (a.kind !== "wsl" || (b.kind === "wsl" && a.distro === b.distro));
}

export interface ProviderStateSession {
  sessionId: string;
  driver: AgentDriverKind;
  context: AgentContext;
  providerStateVersion?: 2 | 3;
}

export interface ProviderStateReconcileResult { removed: string[]; retainedBytes: number; errors: string[]; }

/** Remove this runner's owned orphan partitions after their retention window and prune oldest
 * eligible state under size pressure. Unowned shared legacy leaves are retained fail-safe. */
export async function reconcileProviderState(
  policy: RunnerExecutionIsolation,
  dataDir: string,
  sessions: ProviderStateSession[],
  ownerKey: string,
  ownedOrphans: ProviderStateCleanupRecord[] = [],
  protectedSessionIds: ReadonlySet<string> = new Set(),
  knownContexts: AgentContext[] = [],
  now = Date.now(),
  fs: StateFs = defaultFs,
  nativeOwnerKey = ownerKey,
): Promise<ProviderStateReconcileResult> {
  const retentionMs = (policy.providerStateRetentionDays ?? 7) * 86_400_000;
  const maxBytes = policy.providerStateMaxBytes ?? 5 * 1024 ** 3;
  const contexts: AgentContext[] = [{ kind: "native" }];
  for (const context of [
    ...sessions.map((session) => session.context),
    ...ownedOrphans.map((record) => record.context),
    ...knownContexts,
  ]) {
    if (context.kind === "wsl" && !contexts.some((item) => sameContext(item, context))) {
      contexts.push(context);
    }
  }
  const removed: string[] = [];
  const errors: string[] = [];
  let retainedBytes = 0;
  for (const context of contexts) {
    try {
      const effectiveOwnerKey = context.kind === "native" ? nativeOwnerKey : ownerKey;
      const base = context.kind === "wsl"
        ? posix.join(await fs.wslHome(context), ".agent-manager", "runner-instances", ownerKey)
        : dataDir;
      for (const providerName of ["claude", "codex"] as const) {
      const root = context.kind === "wsl"
        ? posix.join(base, "provider-state", providerName)
        : join(base, "provider-state", providerName);
      const entries = await fs.list(context, root);
      const matching = sessions.filter((session) => sameContext(session.context, context) && provider(session.driver) === providerName);
      const ownedOrphanRecords = ownedOrphans.filter((record) =>
        sameContext(record.context, context) && provider(record.driver) === providerName
      );
      const claimedKeys = new Set<string>();
      for (const claim of [
        ...matching.map((session) => ({ sessionId: session.sessionId, label: "session" })),
        ...ownedOrphanRecords.map((record) => ({ sessionId: record.sessionId, label: "cleanup" })),
      ]) {
        const key = providerStateKey(claim.sessionId);
        if (claimedKeys.has(key)) continue;
        const path = context.kind === "wsl"
          ? posix.join(root, key)
          : join(root, key);
        try {
          await fs.claim(context, path, effectiveOwnerKey);
          claimedKeys.add(key);
        } catch (error) {
          errors.push(`${context.kind === "wsl" ? `WSL ${context.distro}` : "native"} ${providerName} ${claim.label} ${claim.sessionId}: ${(error as Error).message}`);
        }
      }
      const claimedEntries = entries.map((entry) => claimedKeys.has(entry.name) ? { ...entry, ownerKey: effectiveOwnerKey } : entry);
      const protectedKeys = new Set([
        ...matching.map((session) => providerStateKey(session.sessionId)),
        ...ownedOrphanRecords.map((record) => providerStateKey(record.sessionId)),
        ...[...protectedSessionIds].map(providerStateKey),
      ]);
      const candidates = claimedEntries
        .filter((entry) => /^[a-f0-9]{64}$/.test(entry.name) && entry.ownerKey === effectiveOwnerKey && !protectedKeys.has(entry.name))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      let pressureBytes = candidates
        .filter((entry) => now - entry.mtimeMs >= MIN_ORPHAN_AGE_MS)
        .reduce((sum, entry) => sum + entry.bytes, 0);
      let retainedCandidateBytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of candidates) {
        const age = now - entry.mtimeMs;
        // Reconciliation can run in a second runner process while a fork is copying a child whose
        // metadata is not published yet. A fixed grace prevents age/size GC from treating that
        // fresh partition as an orphan; exact failed cleanup uses the durable journal instead.
        if (age < MIN_ORPHAN_AGE_MS || (age < retentionMs && pressureBytes <= maxBytes)) continue;
        const path = context.kind === "wsl" ? posix.join(root, entry.name) : join(root, entry.name);
        await fs.remove(context, path);
        removed.push(path);
        pressureBytes -= entry.bytes;
        retainedCandidateBytes -= entry.bytes;
      }
      retainedBytes += retainedCandidateBytes;
      // The legacy provider-wide leaf has no per-runner ownership marker and can contain sessions
      // absent from this store. Retain it fail-safe; provider-specific inventory is required before
      // any future retirement can prove that every transcript was migrated.
    }
    } catch (error) {
      errors.push(`${context.kind === "wsl" ? `WSL ${context.distro}` : "native"}: ${(error as Error).message}`);
    }
  }
  return { removed, retainedBytes, errors };
}

export async function retryProviderStateCleanup(
  policy: RunnerExecutionIsolation,
  dataDir: string,
  journal: ProviderStateCleanupJournal,
  protectedSessionIds: ReadonlySet<string>,
  log: (message: string) => void,
  now = Date.now(),
  ownerHash?: string,
): Promise<void> {
  for (const record of journal.list()) {
    if (protectedSessionIds.has(record.sessionId)) continue;
    if (now - journal.createdAt(record.sessionId) < MIN_ORPHAN_AGE_MS) continue;
    try {
      await removeExecutionIsolationState(
        { ...policy, mode: "bwrap" }, record.context, record.driver, dataDir, record.sessionId, {}, ownerHash,
      );
      journal.remove(record.sessionId);
    } catch (error) {
      log(`isolated provider state cleanup for ${record.sessionId} needs retry: ${(error as Error).message}`);
    }
  }
}
