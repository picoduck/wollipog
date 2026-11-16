import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isProviderProfileId } from "./provider-profile.js";

/**
 * Managed provider profile HOMEs (#3239). An account created through Add Account for a control
 * plane that negotiates provider profiles gets its HOME at `~/.agent-manager/profiles/<profileId>`:
 * one root per SSH account, outside any runner's owner-namespaced data directory, so a replacement
 * runner (a new runner id, hence a new data directory) finds, uses and may retire the same HOME.
 * Existing account homes keep their paths.
 */
export function managedProviderProfileRoot(home = homedir()): string {
  return join(home, ".agent-manager", "profiles");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export type ManagedProfileDirectoryComponent = "manager_root" | "profiles_root" | "profile_home";
export type ManagedProfileDirectoryReason = "symlink" | "not_directory" | "wrong_owner" | "group_or_other_write" | "unavailable";

/** Safe metadata for account setup diagnostics. Never retain a filesystem error as its cause:
 * those errors carry paths. Callers may serialize only this fixed vocabulary. */
export class ManagedProfileDirectoryError extends Error {
  readonly code = "managed_profile_directory";
  constructor(readonly component: ManagedProfileDirectoryComponent, readonly reason: ManagedProfileDirectoryReason) {
    super(reason === "unavailable"
      ? "The managed provider profile directory could not be created."
      : "The managed provider profile directory is not a private directory.");
  }
  toJSON(): { code: string; component: ManagedProfileDirectoryComponent; reason: ManagedProfileDirectoryReason } {
    return { code: this.code, component: this.component, reason: this.reason };
  }
}

function privateDirectoryReason(stat: Stats): ManagedProfileDirectoryReason | undefined {
  if (stat.isSymbolicLink()) return "symlink";
  if (!stat.isDirectory()) return "not_directory";
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "wrong_owner";
  if ((stat.mode & 0o022) !== 0) return "group_or_other_write";
  return undefined;
}

/** A directory this runner may treat as private: a real directory (never a link) owned by this OS
 * account and not writable by group or others. */
function privateDirectory(stat: Stats): boolean {
  return privateDirectoryReason(stat) === undefined;
}

/** How managed profile creation may treat Wollipog's own roots when they are group-writable. */
export interface ManagedProfileRootOptions {
  /**
   * Whether a root owned by `uid` whose group `gid` may write it can be tightened in place
   * (group and other write removed) instead of refused. Return true only when that group grants
   * no one the runner does not already trust: a proven user-private group, or a Machine whose
   * owner chose Personal Machine. A throw counts as false. Absent, such roots are refused.
   */
  groupWriteRepair?: (uid: number, gid: number) => boolean;
}

/**
 * Remove group and other write from a group-writable (never world-writable) root this account
 * owns when `groupWriteRepair` trusts its group. Removing write permission grants nothing; the
 * descriptor is opened without following links and must be the directory just inspected.
 * Returns whether the root was tightened; on any doubt it is left as it was.
 */
function tightenTrustedGroupWrite(path: string, stat: Stats, options: ManagedProfileRootOptions): boolean {
  if (!options.groupWriteRepair || typeof process.getuid !== "function") return false;
  if ((stat.mode & 0o002) !== 0 || (stat.mode & 0o020) === 0) return false;
  try { if (!options.groupWriteRepair(stat.uid, stat.gid)) return false; } catch { return false; }
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== process.getuid() || opened.mode !== stat.mode) return false;
    fchmodSync(fd, opened.mode & 0o7777 & ~0o022);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* the descriptor is already gone */ }
  }
}

function ensurePrivateDirectory(path: string, component: ManagedProfileDirectoryComponent, options: ManagedProfileRootOptions = {}): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if (errorCode(error) !== "EEXIST") throw new ManagedProfileDirectoryError(component, "unavailable");
  }
  let stat: Stats;
  try { stat = lstatSync(path); } catch { throw new ManagedProfileDirectoryError(component, "unavailable"); }
  let reason = privateDirectoryReason(stat);
  if (reason === "group_or_other_write" && tightenTrustedGroupWrite(path, stat, options)) {
    // Judge the directory as it is now, never as the repair intended it to be.
    try { stat = lstatSync(path); } catch { throw new ManagedProfileDirectoryError(component, "unavailable"); }
    reason = privateDirectoryReason(stat);
  }
  if (reason) throw new ManagedProfileDirectoryError(component, reason);
}

/** The two components Wollipog owns, `.agent-manager` and `profiles`, are private real
 * directories; the SSH account's home above them is the operator's. */
function verifiedRoot(root: string): boolean {
  try {
    return privateDirectory(lstatSync(dirname(root))) && privateDirectory(lstatSync(root));
  } catch {
    return false;
  }
}

/**
 * Create the HOME of a new managed profile: `.agent-manager` and `profiles` are created 0700 when
 * missing and must be private real directories, and `<profileId>` itself must not exist yet. POSIX
 * only: profile markers cannot be verified on Windows. Returns the HOME path.
 */
export function createManagedProviderProfileHome(root: string, profileId: string, platform: NodeJS.Platform = process.platform,
  options: ManagedProfileRootOptions = {}): string {
  if (platform === "win32") throw new Error("Managed provider profiles are not supported on this Machine.");
  if (!isAbsolute(root) || !isProviderProfileId(profileId)) throw new Error("The managed provider profile path is invalid.");
  ensurePrivateDirectory(dirname(root), "manager_root", options);
  ensurePrivateDirectory(root, "profiles_root", options);
  const home = join(root, profileId);
  try { mkdirSync(home, { mode: 0o700 }); } catch (error) {
    throw new Error(errorCode(error) === "EEXIST"
      ? "A managed provider profile with this identity already exists."
      : "The managed provider profile directory could not be created.");
  }
  let stat: Stats;
  try { stat = lstatSync(home); } catch { throw new ManagedProfileDirectoryError("profile_home", "unavailable"); }
  const reason = privateDirectoryReason(stat);
  if (reason) throw new ManagedProfileDirectoryError("profile_home", reason);
  return home;
}

/**
 * The identity a managed profile HOME must hold: the account's recorded `profileId` when its
 * directory is exactly `<root>/<profileId>`. Undefined for every other account HOME, including
 * existing (legacy-path) HOMEs that adopted a profile, whose removal is unchanged.
 */
export function managedProviderProfileIdFor(root: string | undefined, account: { directory: string; profileId?: string | undefined }): string | undefined {
  if (root === undefined || !account.profileId || !isProviderProfileId(account.profileId)) return undefined;
  return resolve(account.directory) === join(resolve(root), account.profileId) ? account.profileId : undefined;
}

/**
 * Whether `directory` is exactly the managed profile HOME `<root>/<profileId>` of the account that
 * recorded `profileId`: the path names it, its ancestry is private and link-free, and it resolves
 * to itself. Only such a HOME may be deleted from this root; anything else, including an
 * operator-configured account pointing into the root, is left alone.
 */
export function isManagedProviderProfileHome(root: string, directory: string, profileId: string | undefined): boolean {
  if (!profileId || !isProviderProfileId(profileId)) return false;
  const path = resolve(directory);
  if (dirname(path) !== resolve(root) || basename(path) !== profileId) return false;
  if (!verifiedRoot(resolve(root))) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return realpathSync(path) === join(realpathSync(resolve(root)), profileId);
  } catch {
    return false;
  }
}
