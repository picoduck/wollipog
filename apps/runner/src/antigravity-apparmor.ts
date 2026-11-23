/** The host fix for Antigravity's Auto Mode on AppArmor-restricted Linux (Ubuntu 23.10+ default).
 *
 * agy 1.5.14 offers ACP mode `auto` only where its OS terminal sandbox can create unprivileged user
 * namespaces. With `kernel.apparmor_restrict_unprivileged_userns = 1` it logs "Terminal sandbox
 * unavailable: AppArmor restricts unprivileged user namespaces" and withholds `auto`. Ubuntu's own
 * answer for programs that need user namespaces is a profile that grants `userns` to that program
 * alone, which leaves the restriction in force for everything else (turning the sysctl off would
 * not). */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const ANTIGRAVITY_APPARMOR_PROFILE = "wollipog-antigravity";
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
/** Characters an AppArmor attachment path would read as glob syntax, or that would end its quotes. */
const UNSAFE_PATH = /["*?[\]{}^\n\r\\]/u;

/** The exact shell command that lets `executable` (the agy this session launched) create user
 * namespaces, or undefined where that is not this host's problem or the path cannot be named
 * safely. A managed copy's generation directory is a glob, so the next update keeps Auto Mode. */
export function antigravityAppArmorFix(
  executable: string | undefined,
  deps: { platform?: NodeJS.Platform; readFile?: (path: string) => string } = {},
): string | undefined {
  if ((deps.platform ?? process.platform) !== "linux" || !executable) return undefined;
  if (!isAbsolute(executable) || UNSAFE_PATH.test(executable)) return undefined;
  let restriction: string;
  try {
    restriction = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(USERNS_RESTRICTION).trim();
  } catch {
    return undefined;
  }
  if (restriction !== "1") return undefined;
  const attachment = executable.replace(/\/generations\/[^/]+\/agy$/u, "/generations/*/agy");
  const profile = `/etc/apparmor.d/${ANTIGRAVITY_APPARMOR_PROFILE}`;
  return [
    `sudo tee ${profile} > /dev/null <<'EOF'`,
    "abi <abi/4.0>,",
    "include <tunables/global>",
    `profile ${ANTIGRAVITY_APPARMOR_PROFILE} "${attachment}" flags=(unconfined) {`,
    "  userns,",
    "}",
    "EOF",
    `sudo apparmor_parser -r ${profile}`,
  ].join("\n");
}
