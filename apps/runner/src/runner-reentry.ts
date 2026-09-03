/**
 * Re-enter the current runner executable in a narrow sidecar mode.
 *
 * The production runner is a Node SEA binary, while development and tests run `cli.ts` through
 * Node/tsx. Keeping that distinction here prevents sidecars from accidentally starting a second
 * daemon whose stdout would corrupt their protocol.
 */

import { createRequire } from "node:module";

export interface RunnerReentryHost {
  isSea: boolean;
  execPath: string;
  execArgv: string[];
  scriptPath?: string;
}

export function detectRunnerSea(): boolean {
  try {
    const req = typeof require === "function" ? require : createRequire(import.meta.url);
    return Boolean((req("node:sea") as { isSea?: () => boolean }).isSea?.());
  } catch {
    return false;
  }
}

export function defaultRunnerReentryHost(): RunnerReentryHost {
  return {
    isSea: detectRunnerSea(),
    execPath: process.execPath,
    execArgv: process.execArgv,
    scriptPath: process.argv[1],
  };
}

function rewriteToCliEntry(scriptPath: string): string {
  const match = scriptPath.match(/^(.*[\\/])?index\.(ts|js|mjs|cjs)$/);
  if (!match) return scriptPath;
  const rewritten = `${match[1] ?? ""}cli.${match[2]}`;
  console.error(`[runner-reentry] runner was started via ${scriptPath} — pointing the sidecar at ${rewritten}`);
  return rewritten;
}

export function runnerReentryCommand(
  host: RunnerReentryHost,
  mode: "--conductor-mcp" | "--policy-hook" | "--agent-control-mcp" | "--wollipog-cli",
): { command: string; args: string[] } {
  if (host.isSea) return { command: host.execPath, args: [mode] };
  return {
    command: host.execPath,
    args: [...host.execArgv, rewriteToCliEntry(host.scriptPath ?? ""), mode],
  };
}
