import { mkdirSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

const owned = new Map<ChildProcess, boolean>();
let cancelled = false;
let signalsInstalled = false;
export function ownProbeProcess<T extends ChildProcess>(child: T, group = true): T {
  if (!signalsInstalled) {
    signalsInstalled = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
      cancelled = true;
      for (const [process, group] of owned) stop(process, group);
    });
  }
  owned.set(child, group);
  child.once("close", () => owned.delete(child));
  if (cancelled) stop(child, group);
  return child;
}
function stop(child: ChildProcess, group: boolean): void {
  if (group && child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  child.kill(group ? "SIGKILL" : "SIGTERM");
}

/** Intentionally do not spread process.env: provider credentials, endpoints and user config stay out. */
export function isolatedProbeEnv(home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    PROBE_KEY: "scripted-local-provider", TERM: "xterm-256color", LANG: "C.UTF-8",
    // Pin the shell's home too; login shells otherwise consult the account's actual home.
    BASH_ENV: "/dev/null", ENV: "/dev/null",
  };
}

export type ProbeStatus = "unchanged" | "changed" | "could not run";

export function unavailableProbeOutput(output: string): boolean {
  return /TIMED OUT|SPAWN FAILED|STDIN FAILED|No permissions to create new namespace|bwrap:|sandbox.*(?:unavailable|failed to)|operation not permitted.*(?:namespace|sandbox)/iu.test(output) ||
    output === "no command ran";
}

export function probeResult(assumption: string, status: ProbeStatus, observed: string, documentation: string): void {
  console.log(JSON.stringify({ event: "codex_assumption", assumption, status, observed, documentation }));
}

export function probeExit(statuses: ProbeStatus[]): number {
  return cancelled || statuses.includes("could not run") ? 2 : statuses.includes("changed") ? 1 : 0;
}

export const GUARD_DOCUMENTATION = "docs/adr/0012-managed-worktree-guard-hook.md";
