import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, opendirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  validSkillName, type AgentDefinition, type SkillAdoptionRecoveryOperation,
  type SkillAdoptionRecoveryResultMessage,
} from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { inspectSkillTree, openSkillDirectory } from "./skill-snapshots.js";
import type { RunnerProviderAccount } from "./config.js";
import {
  platformSkillAdoptionHelper,
  recoveryState,
  type RecoverySourceFacts,
  type SkillAdoptionPlatformHelper,
} from "./skill-adoption-platform.js";
import { SKILL_DIRS } from "./skills.js";

const JOURNAL_PREFIX = ".wollipog-adoption-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IDENTITY = /^\d+:\d+$/;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const identity = (fd: number) => { const stat = fstatSync(fd); return `${stat.dev}:${stat.ino}`; };

interface Intent {
  format: 1 | 2;
  operationId: string;
  sourceDirectory: string;
  localSourceDirectory: string;
  providerAccountId?: string;
  name: string;
  digest: string;
  generation: string;
  sourceIdentity: string;
  parentIdentity: string;
  targetIdentity: string;
  targetRelative: string;
}

type RestoreStage = "restore_intent_durable" | "managed_link_preserved" | "recovery_link_created";

export const SKILL_RECOVERY_SCAN_LIMITS = {
  rawEntriesPerDirectory: 4096,
  operations: 64,
  journalBytes: 8192,
} as const;

function directories(agents: AgentDefinition[]): string[] {
  const result = new Set([".agents/skills"]);
  for (const agent of agents) {
    if ((agent.context?.kind ?? "native") !== "native") continue;
    const directory = SKILL_DIRS[agent.driver ?? "acp"];
    if (directory) result.add(directory);
  }
  return [...result];
}

interface RecoveryScope {
  home: string;
  sourceDirectory: string;
  localSourceDirectory: string;
  providerAccountId?: string;
}

function recoveryScopes(home: string, agents: AgentDefinition[],
  providerAccounts: RunnerProviderAccount[] = []): RecoveryScope[] {
  return [
    ...directories(agents).map((sourceDirectory) => ({
      home, sourceDirectory, localSourceDirectory: sourceDirectory,
    })),
    ...providerAccounts.map((account) => ({
      home: account.directory,
      sourceDirectory: account.provider === "claude" ? ".claude/skills" : ".codex/skills",
      localSourceDirectory: "skills",
      providerAccountId: account.id,
    })),
  ];
}

function readJsonFile(parent: number, name: string): unknown {
  const fd = openSync(`${fdPath(parent)}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SKILL_RECOVERY_SCAN_LIMITS.journalBytes) throw new Error();
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

function parseIntent(value: unknown, operationId: string, scope: RecoveryScope): Intent | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const legacy = entry.format === 1 && scope.providerAccountId === undefined;
  const accountScoped = entry.format === 2 && scope.providerAccountId !== undefined &&
    entry.providerAccountId === scope.providerAccountId;
  const localSourceDirectory = typeof entry.localSourceDirectory === "string"
    ? entry.localSourceDirectory
    : entry.sourceDirectory;
  if ((!legacy && !accountScoped) || entry.operationId !== operationId ||
      entry.sourceDirectory !== scope.sourceDirectory || localSourceDirectory !== scope.localSourceDirectory ||
      typeof entry.name !== "string" || !validSkillName(entry.name) ||
      typeof entry.digest !== "string" || !DIGEST.test(entry.digest) ||
      typeof entry.generation !== "string" || !DIGEST.test(entry.generation) ||
      typeof entry.sourceIdentity !== "string" || !IDENTITY.test(entry.sourceIdentity) ||
      typeof entry.parentIdentity !== "string" || !IDENTITY.test(entry.parentIdentity) ||
      typeof entry.targetIdentity !== "string" || !IDENTITY.test(entry.targetIdentity) ||
      entry.targetRelative !== `skills/store/${entry.name}/${entry.digest}`) return null;
  return { ...(entry as unknown as Intent), localSourceDirectory };
}

function openOptionalDirectory(parent: number, name: string): number | null {
  try { return openSync(`${fdPath(parent)}/${name}`, directoryFlags); } catch { return null; }
}

function pathKind(parent: number, name: string): "absent" | "directory" | "symlink" | "other" {
  try {
    const stat = lstatSync(`${fdPath(parent)}/${name}`);
    return stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function recordMatches(parent: number, name: string, expected: unknown): boolean {
  try { return JSON.stringify(readJsonFile(parent, name)) === JSON.stringify(expected); } catch { return false; }
}

/** Write-once, retry-safe checkpoint. Existing state is accepted only when its exact bounded
 * payload matches; malformed or conflicting state fails closed. */
function writeRecord(parent: number, name: string, value: unknown): void {
  let fd: number;
  try {
    fd = openSync(`${fdPath(parent)}/${name}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && recordMatches(parent, name, value)) return;
    throw error;
  }
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncSync(parent);
}

function recoveryBase(scope: RecoveryScope, parsed: Intent) {
  return { operationId: parsed.operationId,
    backupDirectory: `${scope.sourceDirectory}/${JOURNAL_PREFIX}${parsed.operationId}`,
    sourceDirectory: scope.sourceDirectory, name: parsed.name, digest: parsed.digest,
    ...(scope.providerAccountId ? { providerAccountId: scope.providerAccountId } : {}) };
}

interface HelperView {
  view: SkillAdoptionRecoveryOperation;
  parsed: Intent;
}

/** Project native helper observations through the same journal validation and state machine as
 * Linux. A journal whose probe does not match its parsed name and digest is never restorable. */
function helperViews(helper: SkillAdoptionPlatformHelper, scope: RecoveryScope, dataDir: string,
  operationId?: string): { views: HelperView[]; truncated: boolean } {
  let facts;
  try {
    facts = helper.inspect({ home: scope.home, localSourceDirectory: scope.localSourceDirectory, dataDir,
      ...(operationId ? { operationId } : {}) });
  } catch { return { views: [], truncated: false }; }
  const parentIdentity = facts.parentIdentity;
  if (parentIdentity === null) return { views: [], truncated: facts.truncated };
  const views = facts.journals.flatMap((journal): HelperView[] => {
    let parsed: Intent | null;
    try { parsed = parseIntent(JSON.parse(journal.intent), journal.operationId, scope); }
    catch { parsed = null; }
    if (!parsed) return [];
    const view: SkillAdoptionRecoveryOperation = journal.name !== parsed.name || journal.digest !== parsed.digest
      ? { ...recoveryBase(scope, parsed), state: "blocked", detail: "The journal could not be inspected safely." }
      : { ...recoveryBase(scope, parsed),
          ...recoveryState(parsed, parentIdentity, journal.originalIdentity, journal.source) };
    return [{ view, parsed }];
  });
  return { views, truncated: facts.truncated };
}

function operationView(scope: RecoveryScope, dataDir: string,
  operationId: string): SkillAdoptionRecoveryOperation | null {
  let parent: number | undefined;
  let backup: number | undefined;
  let original: number | null = null;
  try {
    parent = openSkillDirectory(scope.home, scope.localSourceDirectory);
    backup = openSync(`${fdPath(parent)}/${JOURNAL_PREFIX}${operationId}`, directoryFlags);
    const parsed = parseIntent(readJsonFile(backup, "intent.json"), operationId, scope);
    if (!parsed) return null;
    original = openOptionalDirectory(backup, "original");
    const kind = pathKind(parent, parsed.name);
    let source: RecoverySourceFacts;
    if (kind === "directory") {
      const opened = openOptionalDirectory(parent, parsed.name);
      try { source = { kind, identity: opened === null ? null : identity(opened) }; }
      finally { if (opened !== null) closeSync(opened); }
    } else if (kind === "symlink") {
      const linkTarget = readlinkSync(`${fdPath(parent)}/${parsed.name}`);
      const originalTarget = join(realpathSync(scope.home), scope.localSourceDirectory,
        `${JOURNAL_PREFIX}${operationId}`, "original");
      source = { kind: "link", role: linkTarget === join(realpathSync(dataDir), parsed.targetRelative) ? "managed"
        : linkTarget === originalTarget ? "recovery" : "foreign" };
    } else source = { kind };
    return { ...recoveryBase(scope, parsed),
      ...recoveryState(parsed, identity(parent), original === null ? null : identity(original), source) };
  } catch { return null; }
  finally {
    if (original !== null) closeSync(original);
    if (backup !== undefined) closeSync(backup);
    if (parent !== undefined) closeSync(parent);
  }
}

export interface SkillAdoptionRecoveryPlatformOptions {
  platform?: NodeJS.Platform;
  /** Test seam replacing the platform's fixed native helper; not an RPC input. */
  helper?: SkillAdoptionPlatformHelper;
}

export function listSkillAdoptionRecovery(home: string, dataDir: string,
  agents: AgentDefinition[], providerAccounts: RunnerProviderAccount[] = [],
  platformOptions: SkillAdoptionRecoveryPlatformOptions = {}): {
    operations: SkillAdoptionRecoveryOperation[];
    truncated: boolean;
  } {
  const operations: SkillAdoptionRecoveryOperation[] = [];
  let truncated = false;
  const platform = platformOptions.platform ?? process.platform;
  const helper = platform === "linux" ? null : platformOptions.helper ?? platformSkillAdoptionHelper(platform);
  if (platform !== "linux" && !helper) return { operations, truncated };
  for (const scope of recoveryScopes(home, agents, providerAccounts)) {
    if (helper) {
      const found = helperViews(helper, scope, dataDir);
      truncated ||= found.truncated;
      for (const { view } of found.views) {
        if (operations.length >= SKILL_RECOVERY_SCAN_LIMITS.operations) { truncated = true; break; }
        operations.push(view);
      }
      continue;
    }
    let parent: number | undefined;
    try {
      parent = openSkillDirectory(scope.home, scope.localSourceDirectory);
      const dir = opendirSync(fdPath(parent));
      try {
        let raw = 0;
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++raw > SKILL_RECOVERY_SCAN_LIMITS.rawEntriesPerDirectory) { truncated = true; break; }
          if (!entry.isDirectory() || !entry.name.startsWith(JOURNAL_PREFIX)) continue;
          const operationId = entry.name.slice(JOURNAL_PREFIX.length);
          if (!UUID.test(operationId)) continue;
          if (operations.length >= SKILL_RECOVERY_SCAN_LIMITS.operations) { truncated = true; break; }
          const view = operationView(scope, dataDir, operationId);
          if (view) operations.push(view);
        }
      } finally { dir.closeSync(); }
    } catch { /* unavailable harness directories have no inspectable recovery operations */ }
    finally { if (parent !== undefined) closeSync(parent); }
  }
  // A copied journal can otherwise make the control plane reject the entire bounded response for
  // duplicate operation IDs. Keep one visible, explicitly blocked representative so the operator
  // can identify the collision; restore independently requires the ID to resolve uniquely.
  const unique = new Map<string, SkillAdoptionRecoveryOperation>();
  const duplicateIds = new Set<string>();
  for (const operation of operations) {
    if (unique.has(operation.operationId)) duplicateIds.add(operation.operationId);
    else unique.set(operation.operationId, operation);
  }
  return {
    operations: [...unique.values()].map((operation) => duplicateIds.has(operation.operationId)
      ? { ...operation, state: "blocked" as const,
          detail: "This operation ID appears in more than one recovery journal. Resolve the duplicate journals manually." }
      : operation),
    truncated,
  };
}

export interface RestoreSkillAdoptionRecoveryOptions {
  home: string;
  dataDir: string;
  agents: AgentDefinition[];
  providerAccounts?: RunnerProviderAccount[];
  operationId: string;
  acquireProviderHomeLease: (home: string) => void;
  platform?: NodeJS.Platform;
  checkpoint?: (stage: RestoreStage) => void;
  /** Test seam replacing the platform's fixed native helper; not an RPC input. */
  helper?: SkillAdoptionPlatformHelper;
}

type RestoreResult = {
  status: "restored" | "not_needed" | "blocked" | "recovery_required";
  operation?: SkillAdoptionRecoveryOperation;
  error?: string;
};

/** The helper repeats every identity, digest, and no-replace check under its own pinned handles;
 * the runner only selects the unique journal, holds the lease, and reports the resulting state. */
function restoreWithHelper(options: RestoreSkillAdoptionRecoveryOptions,
  helper: SkillAdoptionPlatformHelper): RestoreResult {
  const matches = recoveryScopes(options.home, options.agents, options.providerAccounts).flatMap((scope) =>
    helperViews(helper, scope, options.dataDir, options.operationId).views
      .filter(({ view }) => view.operationId === options.operationId)
      .map((found) => ({ scope, ...found })));
  if (matches.length !== 1) return { status: "blocked", error: "The recovery operation was not found uniquely." };
  const { scope, view: initial, parsed } = matches[0]!;
  try { options.acquireProviderHomeLease(scope.home); }
  catch { return { status: "blocked", error: "The provider home is currently in use." }; }
  if (initial.state === "intent_only" || initial.state === "restored") {
    return { status: "not_needed", operation: initial };
  }
  if (initial.state !== "source_preserved" && initial.state !== "managed_linked") {
    return { status: "blocked", operation: initial, error: initial.detail };
  }
  let restored = false;
  try {
    restored = helper.restore({ home: scope.home, localSourceDirectory: scope.localSourceDirectory,
      dataDir: options.dataDir, operationId: options.operationId, name: parsed.name, digest: parsed.digest,
      parentIdentity: parsed.parentIdentity, sourceIdentity: parsed.sourceIdentity });
  } catch { restored = false; }
  const operation = helperViews(helper, scope, options.dataDir, options.operationId).views
    .find(({ view }) => view.operationId === options.operationId)?.view ?? initial;
  return restored
    ? { status: "restored", operation }
    : { status: "recovery_required", operation,
        error: "Restore stopped safely. Inspect the journal and source path before retrying." };
}

/** Restore access only to the exact inode/content preserved by a validated journal. The managed
 * link is first moved into the journal, then an exclusive recovery link exposes `original` at the
 * source name. Nothing at that name is unlinked or overwritten; every boundary can be retried. */
export function restoreSkillAdoptionRecovery(options: RestoreSkillAdoptionRecoveryOptions): RestoreResult {
  const platform = options.platform ?? process.platform;
  const helper = platform === "linux" ? null : options.helper ?? platformSkillAdoptionHelper(platform);
  if ((platform !== "linux" && !helper) || !UUID.test(options.operationId)) {
    return { status: "blocked", error: "Invalid or unsupported recovery operation." };
  }
  if (helper) return restoreWithHelper(options, helper);
  const matches = recoveryScopes(options.home, options.agents, options.providerAccounts).map((scope) => ({ scope,
    view: operationView(scope, options.dataDir, options.operationId) }))
    .filter((entry) => entry.view);
  if (matches.length !== 1) return { status: "blocked", error: "The recovery operation was not found uniquely." };
  try { options.acquireProviderHomeLease(matches[0]!.scope.home); }
  catch { return { status: "blocked", error: "The provider home is currently in use." }; }
  const initial = matches[0]!.view!;
  if (initial.state === "intent_only" || initial.state === "restored") {
    return { status: "not_needed", operation: initial };
  }
  if (initial.state !== "source_preserved" && initial.state !== "managed_linked") {
    return { status: "blocked", operation: initial, error: initial.detail };
  }

  let parent: number | undefined;
  let backup: number | undefined;
  let original: number | undefined;
  try {
    const scope = matches[0]!.scope;
    const home = realpathSync(scope.home);
    const dataDir = realpathSync(options.dataDir);
    parent = openSkillDirectory(home, scope.localSourceDirectory, true);
    backup = openSync(`${fdPath(parent)}/${JOURNAL_PREFIX}${options.operationId}`, directoryFlags);
    const parsed = parseIntent(readJsonFile(backup, "intent.json"), options.operationId, scope);
    if (!parsed || identity(parent) !== parsed.parentIdentity) throw new Error();
    original = openSync(`${fdPath(backup)}/original`, directoryFlags);
    if (identity(original) !== parsed.sourceIdentity ||
        skillVersionDigest(inspectSkillTree(original, true).files) !== parsed.digest) throw new Error();
    writeRecord(backup, "restore-intent.json", { operationId: options.operationId,
      sourceIdentity: parsed.sourceIdentity });
    options.checkpoint?.("restore_intent_durable");

    const sourcePath = `${fdPath(parent)}/${parsed.name}`;
    const managedLinkPath = `${fdPath(backup)}/managed-link`;
    const target = join(dataDir, parsed.targetRelative);
    let sourceKind = pathKind(parent, parsed.name);
    let preservedLinkKind = pathKind(backup, "managed-link");
    if (sourceKind === "symlink") {
      if (preservedLinkKind !== "absent" || readlinkSync(sourcePath) !== target) throw new Error();
      renameSync(sourcePath, managedLinkPath);
      fsyncSync(parent); fsyncSync(backup);
      sourceKind = "absent";
      preservedLinkKind = "symlink";
    }
    if (preservedLinkKind === "symlink") {
      if (readlinkSync(managedLinkPath) !== target) throw new Error();
      writeRecord(backup, "managed-link-preserved.json", { target });
      options.checkpoint?.("managed_link_preserved");
    } else if (preservedLinkKind !== "absent") throw new Error();
    if (sourceKind !== "absent") throw new Error();
    const originalPath = join(home, scope.localSourceDirectory,
      `${JOURNAL_PREFIX}${options.operationId}`, "original");
    // symlink() is the portable Node primitive with no-replace semantics: any last-instant file,
    // link, or directory at the source name makes it fail with EEXIST and remains untouched.
    symlinkSync(originalPath, sourcePath, "dir");
    fsyncSync(parent);
    options.checkpoint?.("recovery_link_created");
    if (readlinkSync(sourcePath) !== originalPath || identity(original) !== parsed.sourceIdentity ||
        skillVersionDigest(inspectSkillTree(original, true).files) !== parsed.digest) throw new Error();
    writeRecord(backup, "restored.json", { sourceIdentity: parsed.sourceIdentity, digest: parsed.digest });
    return { status: "restored",
      operation: operationView(scope, dataDir, options.operationId) ?? initial };
  } catch {
    const operation = operationView(matches[0]!.scope, options.dataDir, options.operationId) ?? initial;
    return { status: "recovery_required", operation,
      error: "Restore stopped safely. Inspect the journal and source path before retrying." };
  } finally {
    if (original !== undefined) try { closeSync(original); } catch { /* best effort */ }
    if (backup !== undefined) try { closeSync(backup); } catch { /* best effort */ }
    if (parent !== undefined) try { closeSync(parent); } catch { /* best effort */ }
  }
}

export function recoveryResult(runnerId: string, requestId: string,
  value: Omit<SkillAdoptionRecoveryResultMessage, "type" | "runnerId" | "requestId">):
  SkillAdoptionRecoveryResultMessage {
  return { type: "skill_adoption_recovery_result", runnerId, requestId, ...value };
}
