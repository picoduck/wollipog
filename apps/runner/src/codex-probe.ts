import type { spawn as spawnProcess, ChildProcess } from "node:child_process";
import { killTree, provenProcessTreeExit, spawnAgent, type AgentProcess } from "./spawn.js";

/** Registered at spawn, and resolved only after the probe's bounded tree cleanup. */
export interface CodexProbeObserver {
  onProcess?(proof: Promise<boolean>): void;
}

/** Ownerless boundaries participate in runner shutdown too. Probe completion always ends their
 * descendants, even when the root exited or a helper left its process group. Injected spawners
 * have no trusted boundary and must never authorize HOME release. */
export function startCodexProbe(
  options: CodexProbeObserver & { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv },
  spawn?: typeof spawnProcess,
): { child: ChildProcess; finish(): Promise<boolean> } {
  let complete!: (proof: boolean) => void;
  const proof = new Promise<boolean>((resolve) => { complete = resolve; });
  options.onProcess?.(proof);
  let child: ChildProcess;
  try {
    child = spawn
      ? spawn(options.command, options.args, {
        cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true,
      })
      : spawnAgent({
        command: options.command, args: options.args, cwd: options.cwd,
        env: options.env as Record<string, string>, windowsShell: false, trackDescendants: true,
        // spawnAgent normally overlays the daemon environment. Probes must preserve the exact
        // environment supplied by their caller, including discovery's replaceEnv mode.
        scrubInheritedEnv: Object.keys(process.env).filter((name) => !(name in options.env)),
      });
  } catch (error) {
    // No returned boundary can establish what happened before a spawn failure.
    complete(false);
    throw error;
  }
  let finishing: Promise<boolean> | undefined;
  return {
    child,
    finish: () => finishing ??= (async () => {
      let proven = false;
      try {
        if (spawn) child.kill("SIGKILL");
        else {
          const agent = child as AgentProcess;
          if (!agent.posixBoundary) killTree(agent);
          proven = await provenProcessTreeExit(agent);
        }
      } catch { /* Unproven cleanup retains ownership. */ }
      complete(proven);
      return proven;
    })(),
  };
}
