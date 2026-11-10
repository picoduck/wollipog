import { lstatSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isProviderProfileId } from "./provider-profile.js";
import { runManagedProfileCreationHelper, withLeaseIoOptions, type ProfileCreationComponent, type ProfileCreationReason } from "./provider-home-lease-io.js";

/**
 * Managed provider profile HOMEs (#3239). An account created through Add Account for a control
 * plane that negotiates provider profiles gets its HOME at `~/.agent-manager/profiles/<profileId>`:
 * one root per SSH account, outside any runner's owner-namespaced data directory, so a replacement
 * runner (a new runner id, hence a new data directory) finds, uses and may retire the same HOME.
 * Existing account homes keep their paths.
 */
export function managedProviderProfileRoot(home = homedir()): string {
  // Canonicalize only the trusted OS-home context, before appending the owned components.
  // Do not resolve .agent-manager/profiles: their links must still be refused by the helper.
  try { home = realpathSync(home); } catch { /* Missing/unavailable OS home is diagnosed by creation. */ }
  return join(home, ".agent-manager", "profiles");
}

export type ManagedProfileDirectoryComponent = ProfileCreationComponent;
export type ManagedProfileDirectoryReason = Exclude<ProfileCreationReason, "created">;

/** Safe metadata for account setup diagnostics. Never retain a filesystem error as its cause:
 * those errors carry paths. Callers may serialize only this fixed vocabulary. */
export class ManagedProfileDirectoryError extends Error {
  readonly code = "managed_profile_directory";
  constructor(readonly component: ManagedProfileDirectoryComponent, readonly reason: ManagedProfileDirectoryReason,
    readonly failureReason?: ProfileCreationReason) {
    super(reason === "already_exists" ? "A managed provider profile with this identity already exists."
      : reason === "may_have_changed" ? "Managed profile directories may have been created. Preserve them and request operator guidance; do not retry automatically."
      : reason.startsWith("unsupported_") ? "Managed provider profile creation could not be verified on this Machine. Preserve the directories and request operator guidance."
      : reason === "unavailable" ? "The managed provider profile directory could not be created."
      : "The managed provider profile directory is not a private directory.");
  }
  toJSON(): { code: string; component: ManagedProfileDirectoryComponent; reason: ManagedProfileDirectoryReason; failureReason?: ProfileCreationReason } {
    return { code: this.code, component: this.component, reason: this.reason, ...(this.failureReason ? { failureReason: this.failureReason } : {}) };
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
 * only after a capability-checked, descriptor-relative helper operation. Linux is the currently
 * validated platform. `root` is trusted runner context (production constructs it from homedir),
 * never a wire/CLI path: even in synthetic contexts it must have the exact fixed layout.
 * Options carry the trusted runner staging directory; `create` is an in-process test seam.
 */
export function createManagedProviderProfileHome(root: string, profileId: string, platform: NodeJS.Platform = process.platform,
  options: { helperDataDir?: string; create?: typeof runManagedProfileCreationHelper } = {}): string {
  if (platform !== "linux") throw new ManagedProfileDirectoryError("profile_home", "unsupported_platform");
  const osHome = dirname(dirname(root));
  if (!isAbsolute(root) || root !== resolve(root) || root !== managedProviderProfileRoot(osHome) || !isProviderProfileId(profileId))
    throw new ManagedProfileDirectoryError("profile_home", "unsupported_layout");
  const result = withLeaseIoOptions({ ...(options.helperDataDir === undefined ? {} : { helperDataDir: options.helperDataDir }),
    providerHome: join(root, profileId) }, () => (options.create ?? runManagedProfileCreationHelper)(osHome, profileId));
  if (!result.ok) throw new ManagedProfileDirectoryError(result.component, result.reason === "created" ? "may_have_changed" : result.reason, result.failureReason);
  return join(root, profileId);
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
