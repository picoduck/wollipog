import { existsSync, mkdirSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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

/** Only the outer HOME regression supplies this sentinel. Registration and frame handling can
 * finish before background discovery starts; keep the real runner alive until the fake provider
 * has recorded its actual environment. The sentinel is never inherited by the runner itself. */
export async function waitForTransportRunnerProbe(child: ChildProcess): Promise<void> {
  const sentinel = process.env.WOLLIPOG_TEST_DISCOVERY_PROBE_READY;
  if (!sentinel) return;
  const deadline = performance.now() + 15_000;
  while (!existsSync(sentinel)) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Runner exited before the synthetic discovery probe was observed");
    if (performance.now() >= deadline) throw new Error("Synthetic discovery probe was not observed within 15 seconds");
    await delay(20);
  }
}
