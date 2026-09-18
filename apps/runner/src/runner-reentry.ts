/**
 * Re-enter the current runner executable in a narrow sidecar mode.
 *
 * The production runner is a Node SEA binary, while development and tests run `cli.ts` through
 * Node/tsx. Keeping that distinction here prevents sidecars from accidentally starting a second
 * daemon whose stdout would corrupt their protocol.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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

/** Node flags whose value is a module specifier the CHILD resolves from ITS OWN cwd. */
const MODULE_SPECIFIER_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);

function resolveModuleSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("://") ||
      /^[A-Za-z]:[\\/]/u.test(specifier)) {
    return null; // already a path or URL: the child resolves it identically
  }
  try {
    const resolver = (import.meta as unknown as { resolve?: (value: string) => string }).resolve;
    if (typeof resolver === "function") return fileURLToPath(resolver(specifier));
  } catch { /* fall through to the CJS resolver */ }
  try {
    const req = typeof require === "function" ? require : createRequire(import.meta.url);
    return req.resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Make bare module specifiers in the runner's own exec argv absolute.
 *
 * A sidecar launched as a Claude hook inherits CLAUDE's working directory, not the runner's, so a
 * development runner started with `--import tsx` would fail with ERR_MODULE_NOT_FOUND and exit 1 —
 * and a hook that exits with anything other than 2 does NOT block the tool call. For a guard whose
 * whole purpose is to block, that is a fail-open hole. Resolving here, in the runner's own module
 * graph, makes the sidecar launchable from any directory.
 */
export function cwdIndependentExecArgv(execArgv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const argument = execArgv[index]!;
    const equals = argument.indexOf("=");
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    if (!MODULE_SPECIFIER_FLAGS.has(flag)) {
      result.push(argument);
      continue;
    }
    const inline = equals >= 0;
    const value = inline ? argument.slice(equals + 1) : execArgv[index + 1];
    if (value === undefined) {
      result.push(argument);
      continue;
    }
    const resolved = resolveModuleSpecifier(value) ?? value;
    if (inline) result.push(`${flag}=${resolved}`);
    else {
      result.push(flag, resolved);
      index += 1;
    }
  }
  return result;
}

export function runnerReentryCommand(
  host: RunnerReentryHost,
  mode: "--policy-hook" | "--agent-control-mcp" | "--wollipog-cli" | "--managed-worktree-guard",
): { command: string; args: string[] } {
  if (host.isSea) return { command: host.execPath, args: [mode] };
  return {
    command: host.execPath,
    args: [...cwdIndependentExecArgv(host.execArgv), rewriteToCliEntry(host.scriptPath ?? ""), mode],
  };
}
