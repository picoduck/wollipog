import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { campaignCodeOperationTargets, type ApprovalContext } from "@wollipog/protocol";

/** A `..` segment is resolved by the kernel after the symlinks before it, so lexically collapsing
 * it would attest a different file than the provider opens (#2940). Such paths are never evidence. */
function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some((segment) => segment === "..");
}

/** Kernel pseudo-filesystems: magic links (`/proc/self/fd/*`, `/dev/fd/*`) and device nodes have
 * no stable regular-file identity, so they never count as resolved targets. */
const PSEUDO_FILESYSTEM = /^\/(?:proc|dev|sys)(?:\/|$)/u;

/** One resolved target: its real path, and the identity (`dev:ino`) the recheck must find again. */
interface CanonicalTarget { resolvedPath: string; identity: string; dev: number }

/** Metadata only: never opens file contents. Reads require an existing regular file with exactly
 * one link (a hard link is an alias the real path cannot reveal). Only native mutations may place
 * missing targets from a proved directory; dangling links, inaccessible ancestors, `..` segments,
 * pseudo-filesystems, FIFOs, sockets, devices and excessive depth cannot supply evidence. */
function canonicalTarget(path: string, allowMissing: boolean): CanonicalTarget | null {
  if (!isAbsolute(path) || hasParentSegment(path) || PSEUDO_FILESYSTEM.test(path)) return null;
  let current = path;
  const missing: string[] = [];
  for (let depth = 0; depth < 16; depth++) {
    try {
      const resolved = realpathSync.native(current);
      if (PSEUDO_FILESYSTEM.test(resolved)) return null;
      const stats = statSync(resolved);
      if (missing.length ? !stats.isDirectory() : !stats.isFile() || stats.nlink !== 1) return null;
      return { resolvedPath: join(resolved, ...missing), identity: `${stats.dev}:${stats.ino}${missing.length ? ":missing" : ""}`, dev: stats.dev };
    }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try { if (lstatSync(current).isSymbolicLink()) return null; }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return null; }
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current)); current = parent;
    }
  }
  return null;
}

/** Mount points strictly inside `root` (Linux `/proc/self/mountinfo`). A bind mount on the same
 * device keeps the worktree's `st_dev`, so the mount table is the only witness. Null when the table
 * cannot be read, which callers treat as "cannot attest". */
export function mountPointsWithin(root: string): string[] | null {
  if (process.platform !== "linux") return [];
  let table: string;
  try { table = readFileSync("/proc/self/mountinfo", "utf8"); } catch { return null; }
  const unescape = (value: string) => value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  return table.split("\n").flatMap((line) => {
    const mountPoint = line.split(" ")[4];
    if (!mountPoint) return [];
    const path = unescape(mountPoint);
    return path !== root && within(path, root) ? [path] : [];
  });
}

/** Absolute directories this runner knows hold credentials (#2940): its data directory (session
 * credentials, agent-control files, provider-account homes), managed profile homes, configured
 * account homes and agents' provider config directories. `except` carves out subtrees that hold
 * ordinary repository files, such as the managed worktree root inside the data directory. */
export interface CampaignCredentialRoots { roots: readonly string[]; except: readonly string[] }
let credentialRoots: () => CampaignCredentialRoots = () => ({ roots: [], except: [] });

/** Registered once at runner startup; read on every evidence construction so account and profile
 * changes apply immediately. Tests may install synthetic roots. */
export function setCampaignCredentialRoots(provider: () => CampaignCredentialRoots): void {
  credentialRoots = provider;
}

/** The credential directories a runner configuration implies. A configured agent HOME is screened
 * whole only when it is a dedicated provider home: the person's own home or any home that contains
 * a workspace keeps just its provider config directories, so repository files stay decidable. */
export function runnerCredentialRoots(input: {
  dataDir: string; worktreeRoot: string; profileRoot: string; providerAccountDirectories: readonly string[];
  /** Resolved environments: the runner process's own, each agent's (indirections already read), and
   * each session's launch environment. Unresolvable values are simply absent. */
  agentEnvs: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>; workspacePaths: readonly string[]; userHome: string;
  /** Per-session provider credential homes the runner assigned, current or pending. */
  credentialHomes?: ReadonlyArray<string | undefined>;
}): CampaignCredentialRoots {
  // An agent with no configured home uses the person's own provider homes, so those are always in.
  const roots = [input.dataDir, input.profileRoot, ...input.providerAccountDirectories,
    ...[".claude", ".claude.json", ".codex", ".pi"].map((name) => join(input.userHome, name)),
    ...(input.credentialHomes ?? []).filter((home): home is string => typeof home === "string" && isAbsolute(home))];
  for (const env of input.agentEnvs) {
    const value = (key: string) => typeof env?.[key] === "string" && isAbsolute(env[key] as string) ? env[key] as string : undefined;
    for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) { const dir = value(key); if (dir) roots.push(dir); }
    const home = value("HOME");
    if (!home) continue;
    const shared = within(input.userHome, home) || input.workspacePaths.some((path) => within(path, home));
    roots.push(...(shared ? [".claude", ".codex", ".pi"].map((name) => join(home, name)) : [home]));
  }
  return { roots, except: [input.worktreeRoot] };
}

function canonicalDirectory(path: string): string | null {
  if (!isAbsolute(path)) return null;
  try { return realpathSync.native(path); } catch { return path; }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Whether a runner-resolved real path is inside a known credential directory. Metadata only. */
export function campaignCredentialTarget(resolvedPath: string): boolean {
  const { roots, except } = credentialRoots();
  const excluded = except.flatMap((path) => canonicalDirectory(path) ?? []);
  return roots.some((root) => {
    const canonical = canonicalDirectory(root);
    return canonical !== null && within(resolvedPath, canonical) &&
      !excluded.some((carved) => within(resolvedPath, carved) && within(carved, canonical) && carved !== canonical);
  });
}

/** Provider input can name an operation but cannot attest its physical effect. Only the runner
 * constructs filesystem evidence; unknown selectors and resolution errors keep it absent.
 * `sessionRoot` is the session's worktree (its launch cwd): containment is attested only when every
 * canonical target and the canonical cwd lie inside its real path (#2940). */
export function campaignOperationEvidence(toolName: string, operation: NonNullable<ApprovalContext["operation"]>,
  sessionRoot?: string): NonNullable<ApprovalContext["operation"]> {
  const evidence = operationEvidence(toolName, operation);
  // Windows junctions, reparse points and 8.3 short names are not modelled: never attested there.
  if (!evidence.filesystem || !sessionRoot || !isAbsolute(sessionRoot) || process.platform === "win32" ||
      hasParentSegment(sessionRoot)) return evidence;
  let root: string;
  let rootDev: number;
  try {
    root = realpathSync.native(sessionRoot);
    const stats = statSync(root);
    if (!stats.isDirectory() || PSEUDO_FILESYSTEM.test(root)) return evidence;
    rootDev = stats.dev;
  } catch { return evidence; }
  const mounts = mountPointsWithin(root);
  if (!mounts) return evidence;
  // Inside the real worktree path, on the worktree's own device, and below no other mount point:
  // a bind mount or mounted filesystem inside the worktree is another filesystem's file.
  const contained = (path: string, dev: number) => within(path, root) && dev === rootDev && !mounts.some((mount) => within(path, mount));
  const devOf = (identity: string | undefined) => Number(identity?.split(":")[0]);
  if (!evidence.filesystem.targets.every((target) => contained(target.resolvedPath, devOf(target.identity)))) return evidence;
  if (evidence.filesystem.cwd !== undefined) {
    try { if (!contained(evidence.filesystem.cwd, statSync(evidence.filesystem.cwd).dev)) return evidence; } catch { return evidence; }
  }
  return { ...evidence, filesystem: { ...evidence.filesystem, containment: { version: 1, root, sessionRoot } } };
}

function operationEvidence(toolName: string, operation: NonNullable<ApprovalContext["operation"]>): NonNullable<ApprovalContext["operation"]> {
  const { filesystem: _untrusted, ...concrete } = operation;
  const selectors = campaignCodeOperationTargets(toolName, concrete);
  if (!selectors) return concrete;
  let cwd: string | undefined;
  if (selectors.cwd) {
    if (hasParentSegment(selectors.cwd)) return concrete;
    try { if (isAbsolute(selectors.cwd) && statSync(selectors.cwd).isDirectory()) cwd = realpathSync.native(selectors.cwd); }
    catch { return concrete; }
    if (cwd && PSEUDO_FILESYSTEM.test(cwd)) return concrete;
  }
  if (selectors.cwd && !cwd) return concrete;
  const targets: Array<{ path: string; resolvedPath: string; identity: string; credentialStore?: true }> = [];
  const allowMissing = concrete.kind === "file" && ["Write", "Edit", "MultiEdit", "applyPatch", "fileChange"].includes(toolName);
  for (const path of selectors.paths) {
    // Never normalize lexically: `jump/..` must reach the kernel's resolution, so it is refused here.
    if (hasParentSegment(path)) return concrete;
    const located = isAbsolute(path) ? path : selectors.cwd ? `${selectors.cwd.replace(/[\\/]+$/u, "")}/${path}` : null;
    const resolved = located ? canonicalTarget(located, allowMissing) : null;
    if (!resolved) return concrete;
    targets.push({ path, resolvedPath: resolved.resolvedPath, identity: resolved.identity,
      ...(campaignCredentialTarget(resolved.resolvedPath) ? { credentialStore: true as const } : {}) });
  }
  return { ...concrete, filesystem: { ...(cwd ? { cwd } : {}), targets } };
}

/** Recheck before a parked callback is granted: the same resolver runs again, so a replaced link,
 * a swapped inode (`dev:ino`), a new hard link or a new mount cannot reuse the old evidence. */
export function campaignOperationEvidenceCurrent(toolName: string, operation: NonNullable<ApprovalContext["operation"]>): boolean {
  return !operation.filesystem || JSON.stringify(campaignOperationEvidence(toolName, operation,
    operation.filesystem.containment?.sessionRoot).filesystem) === JSON.stringify(operation.filesystem);
}
