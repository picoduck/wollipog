import { lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
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

/** A directory this runner may treat as private: a real directory (never a link) owned by this OS
 * account and not writable by group or others. */
function privateDirectory(stat: Stats): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
  return (stat.mode & 0o022) === 0;
}

function ensurePrivateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if (errorCode(error) !== "EEXIST") throw new Error("The managed provider profile directory could not be created.");
  }
  let stat: Stats;
  try { stat = lstatSync(path); } catch { throw new Error("The managed provider profile directory could not be created."); }
  if (!privateDirectory(stat)) throw new Error("The managed provider profile directory is not a private directory.");
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
export function createManagedProviderProfileHome(root: string, profileId: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") throw new Error("Managed provider profiles are not supported on this Machine.");
  if (!isAbsolute(root) || !isProviderProfileId(profileId)) throw new Error("The managed provider profile path is invalid.");
  ensurePrivateDirectory(dirname(root));
  ensurePrivateDirectory(root);
  const home = join(root, profileId);
  try { mkdirSync(home, { mode: 0o700 }); } catch (error) {
    throw new Error(errorCode(error) === "EEXIST"
      ? "A managed provider profile with this identity already exists."
      : "The managed provider profile directory could not be created.");
  }
  if (!privateDirectory(lstatSync(home))) throw new Error("The managed provider profile directory is not a private directory.");
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
