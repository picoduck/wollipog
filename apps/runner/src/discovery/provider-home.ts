import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Discovery must never initialize another runner's sign-in or user extensions. This is probe
 * state only: it is not an account and must never replace a recorded session binding. */
export function isolatedDiscoveryEnvironment(dataDir: string): Record<string, string> {
  const home = join(dataDir, "discovery-home");
  for (const directory of [home, join(home, "claude"), join(home, "codex"), join(home, "pi")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o022) !== 0) ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("The discovery HOME is not a private directory.");
    }
  }
  return {
    HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  };
}
