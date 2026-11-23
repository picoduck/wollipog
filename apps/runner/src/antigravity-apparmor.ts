/** The host fix for Antigravity's Auto Mode on AppArmor-restricted Linux (Ubuntu 23.10+ default).
 *
 * agy 1.5.14 offers ACP mode `auto` only where its OS terminal sandbox can create unprivileged user
 * namespaces. With `kernel.apparmor_restrict_unprivileged_userns = 1` it logs "Terminal sandbox
 * unavailable: AppArmor restricts unprivileged user namespaces" and withholds `auto`. Ubuntu's
 * answer for a program that needs user namespaces is a profile granting `userns` to that program
 * alone. Setting the sysctl to 0 instead would lift the restriction for everything.
 *
 * A profile attaches to the file the kernel executes. The granted file must be one no unprivileged
 * program can replace: on a user-writable path, any program running as the user could write itself
 * there and gain user namespaces. An agy the user can replace is therefore first installed as a
 * root-owned copy. Its old path becomes a symlink to that copy, so the same launch reaches it, and
 * only the copy is granted. `flags=(unconfined)` keeps agy's own behaviour unchanged, as Ubuntu's
 * profiles for programs that need user namespaces do. */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const ANTIGRAVITY_APPARMOR_PROFILE = "wollipog-antigravity";
/** Where a user-replaceable agy is installed root-owned before it is granted. */
export const ANTIGRAVITY_ROOT_OWNED_COPY = "/usr/local/lib/wollipog-antigravity/agy";
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
/** Characters that AppArmor would read as glob syntax or that would end a quoted path, in the
 * profile's double quotes or the shell's single quotes. */
const UNSAFE_PATH = /["'*?[\]{}^\n\r\\]/u;
/** A Wollipog-managed copy (`<install root>/generations/<id>/agy`): updates replace it in a
 * user-owned directory, so neither granting it nor swapping it for a root-owned copy is safe. */
const MANAGED_GENERATION = /\/generations\/[^/]+\/agy$/u;

interface HostDeps {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  stat?: (path: string) => { uid: number; mode: number };
}

/** Whether only root can replace `path`: root owns it and every directory above it, and none is
 * group- or world-writable. */
function rootOwned(path: string, stat: NonNullable<HostDeps["stat"]>): boolean {
  for (let current = path; ; current = dirname(current)) {
    const status = stat(current);
    if (status.uid !== 0 || (status.mode & 0o022) !== 0) return false;
    if (current === dirname(current)) return true;
  }
}

/** The exact shell command that gives `executable` (the agy this session launched) user
 * namespaces without letting another program claim them, or undefined where that is not this
 * host's problem or cannot be done safely. */
export function antigravityAppArmorFix(executable: string | undefined, deps: HostDeps = {}): string | undefined {
  if ((deps.platform ?? process.platform) !== "linux" || !executable) return undefined;
  if (!isAbsolute(executable) || UNSAFE_PATH.test(executable)) return undefined;
  try {
    const restriction = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(USERNS_RESTRICTION).trim();
    if (restriction !== "1") return undefined;
    const granted = rootOwned(executable, deps.stat ?? ((path) => statSync(path)));
    if (!granted && MANAGED_GENERATION.test(executable)) return undefined;
    const target = granted ? executable : ANTIGRAVITY_ROOT_OWNED_COPY;
    const profile = `/etc/apparmor.d/${ANTIGRAVITY_APPARMOR_PROFILE}`;
    return [
      ...(granted ? [] : [
        `sudo install -D -o root -g root -m 0755 '${executable}' ${ANTIGRAVITY_ROOT_OWNED_COPY}`,
        `ln -sfn ${ANTIGRAVITY_ROOT_OWNED_COPY} '${executable}'`,
      ]),
      `sudo tee ${profile} > /dev/null <<'EOF'`,
      "abi <abi/4.0>,",
      "include <tunables/global>",
      `profile ${ANTIGRAVITY_APPARMOR_PROFILE} "${target}" flags=(unconfined) {`,
      "  userns,",
      "}",
      "EOF",
      `sudo apparmor_parser -r ${profile}`,
    ].join("\n");
  } catch {
    return undefined;
  }
}
