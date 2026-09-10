import { spawnSync } from "node:child_process";
import { validWslDistroName } from "./wsl-context.js";

/** Convert an independently probed absolute HOME into the stable Windows UNC view of one distro. */
export function wslHomeToUnc(distro: string, home: string): string {
  if (!validWslDistroName(distro) || home.length > 4096 || (home !== "/" && !/^\/(?:[^/]+)(?:\/[^/]+)*$/u.test(home)) ||
      /[\\\p{Cc}\p{Cf}]/u.test(home) || home.split("/").some((segment) => segment === "." || segment === "..")) throw new Error();
  return `\\\\wsl.localhost\\${distro}${home.replaceAll("/", "\\")}`;
}

/** Resolve HOME inside WSL without a shell. Snapshot traversal itself stays in the fixed native
 * Windows helper, which opens the resulting UNC descendants with no-follow handles. */
export function resolveWslHomeUnc(distro: string): string | null {
  if (!validWslDistroName(distro)) return null;
  const result = spawnSync("wsl.exe", ["-d", distro, "--exec", "printenv", "HOME"], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal) return null;
  try { return wslHomeToUnc(distro, result.stdout.trim()); }
  catch { return null; }
}
