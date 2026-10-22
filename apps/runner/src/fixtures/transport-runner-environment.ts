import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Transport tests start a real runner and deliberately kill it. Never let its background
 * discovery acquire the developer's credential HOME or inherit provider credentials/config. */
export function transportRunnerEnvironment(temp: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = join(temp, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  // Preserve only OS/tool lookup prerequisites. In particular, neither provider HOME overrides,
  // API keys, runner credentials, nor NODE_OPTIONS may cross into this synthetic runner.
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "TEMP", "TMP", "TMPDIR"]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    RUNNER_DATA_DIR: join(temp, "runner-data"),
  };
}
