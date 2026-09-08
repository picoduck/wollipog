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
import { SKILL_DIRS } from "./skills.js";

const JOURNAL_PREFIX = ".wollipog-adoption-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IDENTITY = /^\d+:\d+$/;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const identity = (fd: number) => { const stat = fstatSync(fd); return `${stat.dev}:${stat.ino}`; };

interface Intent {
  format: 1;
  operationId: string;
  sourceDirectory: string;
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
    if (agent.id === "conductor" || (agent.context?.kind ?? "native") !== "native") continue;
    const directory = SKILL_DIRS[agent.driver ?? "acp"];
    if (directory) result.add(directory);
  }
  return [...result];
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

function parseIntent(value: unknown, operationId: string, sourceDirectory: string): Intent | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.format !== 1 || entry.operationId !== operationId || entry.sourceDirectory !== sourceDirectory ||
      typeof entry.name !== "string" || !validSkillName(entry.name) ||
      typeof entry.digest !== "string" || !DIGEST.test(entry.digest) ||
      typeof entry.generation !== "string" || !DIGEST.test(entry.generation) ||
      typeof entry.sourceIdentity !== "string" || !IDENTITY.test(entry.sourceIdentity) ||
      typeof entry.parentIdentity !== "string" || !IDENTITY.test(entry.parentIdentity) ||
      typeof entry.targetIdentity !== "string" || !IDENTITY.test(entry.targetIdentity) ||
      entry.targetRelative !== `skills/store/${entry.name}/${entry.digest}`) return null;
  return entry as unknown as Intent;
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

function operationView(home: string, dataDir: string, sourceDirectory: string,
  operationId: string): SkillAdoptionRecoveryOperation | null {
  let parent: number | undefined;
  let backup: number | undefined;
  let original: number | null = null;
  try {
    parent = openSkillDirectory(home, sourceDirectory);
    backup = openSync(`${fdPath(parent)}/${JOURNAL_PREFIX}${operationId}`, directoryFlags);
    const parsed = parseIntent(readJsonFile(backup, "intent.json"), operationId, sourceDirectory);
    if (!parsed) return null;
    const base = { operationId, backupDirectory: `${sourceDirectory}/${JOURNAL_PREFIX}${operationId}`,
      sourceDirectory, name: parsed.name, digest: parsed.digest };
    if (identity(parent) !== parsed.parentIdentity) {
      return { ...base, state: "blocked", detail: "The source parent identity changed." };
    }
    original = openOptionalDirectory(backup, "original");
    const kind = pathKind(parent, parsed.name);
    if (kind === "directory" && original === null) {
      const source = openOptionalDirectory(parent, parsed.name);
      try {
        if (source !== null && identity(source) === parsed.sourceIdentity) {
          return { ...base, state: "intent_only", detail: "The original source is still in place; no restore is needed." };
        }
      } finally { if (source !== null) closeSync(source); }
    }
    if (original !== null && identity(original) === parsed.sourceIdentity) {
      if (kind === "absent") {
        return { ...base, state: "source_preserved", detail: "The original is preserved and the source path is empty." };
      }
      if (kind === "symlink") {
        const target = join(realpathSync(dataDir), parsed.targetRelative);
        const linkTarget = readlinkSync(`${fdPath(parent)}/${parsed.name}`);
        if (linkTarget === target) {
          return { ...base, state: "managed_linked", detail: "The managed link is active and the original is preserved." };
        }
        const originalTarget = join(realpathSync(home), sourceDirectory,
          `${JOURNAL_PREFIX}${operationId}`, "original");
        if (linkTarget === originalTarget) {
          return { ...base, state: "restored", detail: "A recovery link exposes the preserved original at its source path." };
        }
      }
    }
    if (original === null && kind === "directory") {
      const source = openOptionalDirectory(parent, parsed.name);
      try {
        if (source !== null && identity(source) === parsed.sourceIdentity) {
          return { ...base, state: "restored", detail: "The preserved original has been restored." };
        }
      } finally { if (source !== null) closeSync(source); }
    }
    return { ...base, state: "blocked",
      detail: "The journal or source path does not match a safe automatic recovery state." };
  } catch { return null; }
  finally {
    if (original !== null) closeSync(original);
    if (backup !== undefined) closeSync(backup);
    if (parent !== undefined) closeSync(parent);
  }
}

export function listSkillAdoptionRecovery(home: string, dataDir: string,
  agents: AgentDefinition[]): { operations: SkillAdoptionRecoveryOperation[]; truncated: boolean } {
  const operations: SkillAdoptionRecoveryOperation[] = [];
  let truncated = false;
  for (const sourceDirectory of directories(agents)) {
    let parent: number | undefined;
    try {
      parent = openSkillDirectory(home, sourceDirectory);
      const dir = opendirSync(fdPath(parent));
      try {
        let raw = 0;
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++raw > SKILL_RECOVERY_SCAN_LIMITS.rawEntriesPerDirectory) { truncated = true; break; }
          if (!entry.isDirectory() || !entry.name.startsWith(JOURNAL_PREFIX)) continue;
          const operationId = entry.name.slice(JOURNAL_PREFIX.length);
          if (!UUID.test(operationId)) continue;
          if (operations.length >= SKILL_RECOVERY_SCAN_LIMITS.operations) { truncated = true; break; }
          const view = operationView(home, dataDir, sourceDirectory, operationId);
          if (view) operations.push(view);
        }
      } finally { dir.closeSync(); }
    } catch { /* unavailable harness directories have no inspectable recovery operations */ }
    finally { if (parent !== undefined) closeSync(parent); }
  }
  return { operations, truncated };
}

export interface RestoreSkillAdoptionRecoveryOptions {
  home: string;
  dataDir: string;
  agents: AgentDefinition[];
  operationId: string;
  acquireProviderHomeLease: () => void;
  platform?: NodeJS.Platform;
  checkpoint?: (stage: RestoreStage) => void;
}

/** Restore access only to the exact inode/content preserved by a validated journal. The managed
 * link is first moved into the journal, then an exclusive recovery link exposes `original` at the
 * source name. Nothing at that name is unlinked or overwritten; every boundary can be retried. */
export function restoreSkillAdoptionRecovery(options: RestoreSkillAdoptionRecoveryOptions): {
  status: "restored" | "not_needed" | "blocked" | "recovery_required";
  operation?: SkillAdoptionRecoveryOperation;
  error?: string;
} {
  if ((options.platform ?? process.platform) !== "linux" || !UUID.test(options.operationId)) {
    return { status: "blocked", error: "Invalid or unsupported recovery operation." };
  }
  try { options.acquireProviderHomeLease(); }
  catch { return { status: "blocked", error: "The provider home is currently in use." }; }
  const matches = directories(options.agents).map((sourceDirectory) => ({ sourceDirectory,
    view: operationView(options.home, options.dataDir, sourceDirectory, options.operationId) }))
    .filter((entry) => entry.view);
  if (matches.length !== 1) return { status: "blocked", error: "The recovery operation was not found uniquely." };
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
    const home = realpathSync(options.home);
    const dataDir = realpathSync(options.dataDir);
    parent = openSkillDirectory(home, initial.sourceDirectory, true);
    backup = openSync(`${fdPath(parent)}/${JOURNAL_PREFIX}${options.operationId}`, directoryFlags);
    const parsed = parseIntent(readJsonFile(backup, "intent.json"), options.operationId, initial.sourceDirectory);
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
    const originalPath = join(home, initial.sourceDirectory,
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
      operation: operationView(home, dataDir, initial.sourceDirectory, options.operationId) ?? initial };
  } catch {
    const operation = operationView(options.home, options.dataDir, initial.sourceDirectory,
      options.operationId) ?? initial;
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
