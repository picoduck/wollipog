/** Internal source-preservation transaction. Not registered as a runner/RPC command. Linux runs
 * it in-process through descriptor paths; macOS delegates the same steps to its fixed native helper.
 * The caller must serialize this with reconcile/GC, own the provider-HOME lease, and supply
 * a fresh durable-library/explicit-assignment authorization fence. No preflight report is a grant. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { validSkillName, type AgentDefinition, type MachineSkillCandidate } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { platformSkillAdoptionHelper, type SkillAdoptionPlatformHelper } from "./skill-adoption-platform.js";
import { directoryGeneration, inspectSkillTree, openSkillDirectory } from "./skill-snapshots.js";
import { SKILL_DIRS } from "./skills.js";

type Stage = "intent_durable" | "source_preserved" | "link_created";
export interface SkillAdoptionOptions {
  home: string;
  dataDir: string;
  agents: AgentDefinition[];
  /** Trusted caller resolves the opaque candidate, expiration and approval before calling. */
  candidate: MachineSkillCandidate;
  /** Runner-resolved path beneath `home`; account candidates keep their public harness-relative
   * sourceDirectory while mutating `<credential-home>/skills`. */
  localSourceDirectory?: string;
  digest: string;
  /** Required synchronous guards. Authorization checks durable version, targeting, invocation
   * variant and accepted shared-directory impact. Callers must not pass an async function. */
  acquireProviderHomeLease: () => undefined;
  assertAuthorized: () => undefined;
  platform?: NodeJS.Platform;
  /** Fault-injection seam; not an RPC input. */
  checkpoint?: (stage: Stage) => void;
  /** Test seam replacing the platform's fixed native helper; not an RPC input. */
  helper?: SkillAdoptionPlatformHelper;
}
export type SkillAdoptionResult =
  | { status: "rejected"; error: string }
  | { status: "adopted" | "recovery_required"; operationId: string; backupDirectory: string;
      providerAccountId?: string; error?: string };

const REJECTED = "Adoption authorization, source or stored version could not be validated. No source directory was replaced.";
const RECOVERY = "Adoption stopped. Inspect the private journal and preserved original; no automatic restore or cleanup was attempted.";
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const identity = (fd: number) => { const stat = fstatSync(fd); return `${stat.dev}:${stat.ino}`; };
function guard(action: () => undefined): void {
  const result: unknown = action();
  if (result instanceof Promise) void result.catch(() => {});
  if (result !== undefined) throw new Error("Guard must complete synchronously");
}
function record(parent: number, name: string, value: unknown): void {
  const fd = openSync(`${fdPath(parent)}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncSync(parent);
}

function validRequest(options: SkillAdoptionOptions): boolean {
  const { candidate, digest } = options;
  if (!candidate || !validSkillName(candidate.name) || !/^[0-9a-f]{64}$/.test(digest)) return false;
  const allowed = new Set([".agents/skills", ...options.agents.filter((agent) =>
    (agent.context?.kind ?? "native") === "native").map((agent) => SKILL_DIRS[agent.driver ?? "acp"]).filter(Boolean)]);
  return allowed.has(candidate.sourceDirectory);
}

/** Preserve the original by same-filesystem rename, then exclusively publish an untransformed
 * store-target link. Never unlink, recursively delete, overwrite a source, or auto-restore over
 * a newly occupied path. Interrupted operations leave a private journal and recoverable original.
 * A later serialized reconciler can route harness links through the canonical link as usual. */
export function adoptMachineSkill(options: SkillAdoptionOptions): SkillAdoptionResult {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return adoptLinuxSkill(options);
  const helper = options.helper ?? platformSkillAdoptionHelper(platform);
  if (!helper) return { status: "rejected", error: "Recoverable adoption requires Linux or macOS." };
  return adoptWithHelper(options, helper);
}

/** The helper repeats every source, store, and identity check under its own pinned handles. The
 * runner's guards run first; the synchronous helper call cannot interleave with runner state. */
function adoptWithHelper(options: SkillAdoptionOptions, helper: SkillAdoptionPlatformHelper): SkillAdoptionResult {
  if (!validRequest(options)) return { status: "rejected", error: "Invalid adoption source or digest." };
  const { candidate, digest } = options;
  try {
    guard(options.acquireProviderHomeLease);
    guard(options.assertAuthorized);
  } catch {
    return { status: "rejected", error: REJECTED };
  }
  const operationId = randomUUID();
  const recovery = { operationId, backupDirectory: `${candidate.sourceDirectory}/.wollipog-adoption-${operationId}`,
    ...(candidate.providerAccountId ? { providerAccountId: candidate.providerAccountId } : {}) };
  let outcome;
  try {
    outcome = helper.adopt({
      home: options.home,
      localSourceDirectory: options.localSourceDirectory ?? candidate.sourceDirectory,
      sourceDirectory: candidate.sourceDirectory,
      name: candidate.name,
      generation: candidate.generation,
      digest,
      dataDir: options.dataDir,
      operationId,
      ...(candidate.providerAccountId ? { providerAccountId: candidate.providerAccountId } : {}),
    });
  } catch {
    // An unexpected wrapper failure cannot prove that no journal was created.
    outcome = { journal: true, adopted: false };
  }
  if (outcome.adopted) return { status: "adopted", ...recovery };
  return outcome.journal
    ? { status: "recovery_required", ...recovery, error: RECOVERY }
    : { status: "rejected", error: REJECTED };
}

function adoptLinuxSkill(options: SkillAdoptionOptions): SkillAdoptionResult {
  const { candidate, digest } = options;
  if (!validRequest(options)) return { status: "rejected", error: "Invalid adoption source or digest." };
  const opened: number[] = [];
  const keep = (fd: number) => { opened.push(fd); return fd; };
  let recovery: { operationId: string; backupDirectory: string } | undefined;
  try {
    guard(options.acquireProviderHomeLease);
    guard(options.assertAuthorized);
    const home = realpathSync(options.home);
    const dataDir = realpathSync(options.dataDir);
    const localSourceDirectory = options.localSourceDirectory ?? candidate.sourceDirectory;
    const sourcePath = join(home, localSourceDirectory, candidate.name);
    const targetRelative = `skills/store/${candidate.name}/${digest}`;
    const targetPath = join(dataDir, targetRelative);
    if (targetPath === sourcePath || targetPath.startsWith(sourcePath + sep) || sourcePath.startsWith(targetPath + sep)) throw new Error();
    const parent = keep(openSkillDirectory(home, localSourceDirectory, true));
    const source = keep(openSync(`${fdPath(parent)}/${candidate.name}`, flags));
    const target = keep(openSkillDirectory(dataDir, targetRelative, true));
    const parentIdentity = identity(parent), sourceIdentity = identity(source), targetIdentity = identity(target);
    const checkPath = (root: string, relative: string, expected: string) => {
      const fd = openSkillDirectory(root, relative);
      try { if (identity(fd) !== expected) throw new Error(); } finally { closeSync(fd); }
    };
    const checkContent = (fd: number, rejectExecutable = false) => {
      const generation = directoryGeneration(fd);
      const first = inspectSkillTree(fd, true);
      const second = inspectSkillTree(fd, true);
      if (skillVersionDigest(first.files) !== digest || skillVersionDigest(second.files) !== digest ||
          JSON.stringify(first.executablePaths) !== JSON.stringify(second.executablePaths) ||
          (rejectExecutable && first.executablePaths.length > 0)) throw new Error();
      if (directoryGeneration(fd) !== generation) throw new Error();
    };
    const checkSource = () => {
      checkPath(home, localSourceDirectory, parentIdentity);
      checkPath(home, `${localSourceDirectory}/${candidate.name}`, sourceIdentity);
      if (directoryGeneration(source) !== candidate.generation) throw new Error();
      checkContent(source, true);
      if (directoryGeneration(source) !== candidate.generation) throw new Error();
    };
    checkSource();
    checkContent(target);
    guard(options.assertAuthorized);
    const operationId = randomUUID();
    const backupName = `.wollipog-adoption-${operationId}`;
    mkdirSync(`${fdPath(parent)}/${backupName}`, { mode: 0o700 });
    recovery = { operationId, backupDirectory: `${candidate.sourceDirectory}/${backupName}` };
    const backup = keep(openSync(`${fdPath(parent)}/${backupName}`, flags));
    record(backup, "intent.json", {
      format: candidate.providerAccountId ? 2 : 1,
      operationId,
      sourceDirectory: candidate.sourceDirectory,
      ...(candidate.providerAccountId ? {
        localSourceDirectory,
        providerAccountId: candidate.providerAccountId,
      } : {}),
      name: candidate.name,
      digest,
      generation: candidate.generation,
      sourceIdentity,
      parentIdentity,
      targetIdentity,
      targetRelative,
    });
    fsyncSync(parent);
    options.checkpoint?.("intent_durable");
    // Check again after journal creation. A concurrently renamed parent cannot redirect the
    // actual write: both rename endpoints are anchored to held directory descriptors.
    checkSource();
    checkPath(dataDir, targetRelative, targetIdentity);
    guard(options.assertAuthorized);
    renameSync(`${fdPath(parent)}/${candidate.name}`, `${fdPath(backup)}/original`);
    fsyncSync(backup); fsyncSync(parent);
    options.checkpoint?.("source_preserved");
    const preserved = keep(openSync(`${fdPath(backup)}/original`, flags));
    if (identity(preserved) !== sourceIdentity) throw new Error();
    checkContent(preserved, true);
    record(backup, "preserved.json", { sourceIdentity, digest });
    checkPath(home, localSourceDirectory, parentIdentity);
    checkPath(dataDir, targetRelative, targetIdentity);
    checkContent(target);
    guard(options.assertAuthorized);
    // symlink() fails EEXIST rather than replacing anything created during the rename gap.
    symlinkSync(targetPath, `${fdPath(parent)}/${candidate.name}`, "dir");
    fsyncSync(parent);
    options.checkpoint?.("link_created");
    checkPath(home, localSourceDirectory, parentIdentity);
    checkPath(dataDir, targetRelative, targetIdentity);
    checkContent(target);
    if (readlinkSync(`${fdPath(parent)}/${candidate.name}`) !== targetPath) throw new Error();
    record(backup, "linked.json", { digest });
    return { status: "adopted", ...recovery,
      ...(candidate.providerAccountId ? { providerAccountId: candidate.providerAccountId } : {}) };
  } catch {
    return recovery ? { status: "recovery_required", ...recovery,
      ...(candidate.providerAccountId ? { providerAccountId: candidate.providerAccountId } : {}),
      error: RECOVERY }
      : { status: "rejected", error: REJECTED };
  } finally {
    // A close failure must not discard the recovery receipt; all data safety decisions have
    // already been made and journaled before descriptor cleanup.
    for (const fd of opened.reverse()) try { closeSync(fd); } catch { /* receipt remains authoritative */ }
  }
}
