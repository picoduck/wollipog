/**
 * Filesystem browsing for the workspace picker: list the sub-directories of a path on the runner
 * machine (native host or a WSL distro), so a dashboard can choose a working directory on a remote
 * box instead of relying on a preconfigured workspace. Directories only; best-effort.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentContext, DirectoryEntry } from "@wollipog/protocol";
import { run } from "./discovery/resolve.js";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

/** List sub-directories of `reqPath` (empty ⇒ $HOME) in the given context. Throws on an unreadable path. */
export async function listDirectory(context: AgentContext, reqPath: string): Promise<DirectoryListing> {
  return context.kind === "wsl" ? wslList(context.distro, reqPath) : nativeList(reqPath);
}

function nativeList(reqPath: string): DirectoryListing {
  const abs = reqPath && reqPath.trim() ? resolve(reqPath) : homedir();
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    throw new Error(`cannot read directory: ${abs}`);
  }
  const entries: DirectoryEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // hide dotfiles — a workspace is almost never one
    const full = join(abs, name);
    try {
      if (statSync(full).isDirectory()) entries.push({ name, path: full, isDir: true });
    } catch {
      /* unreadable entry — skip */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries };
}

/** wsl.exe argv for listing `reqPath`. The path is passed as a POSITIONAL arg (`$1`), NEVER
 * interpolated into the script, so a path containing `$(...)`, backticks, or `$VAR` cannot execute
 * on the box (variable-expansion results are not re-scanned for command substitution in POSIX sh).
 * Shell tokens like `${e%/}` stay literal via string concatenation (a template literal would
 * interpolate them). Exported for injection tests. */
export function wslListArgs(distro: string, reqPath: string): string[] {
  const script =
    'p="$1"; [ -n "$p" ] || p="$HOME"; cd "$p" 2>/dev/null || exit 3; pwd; ' +
    'for e in */; do [ -d "$e" ] && printf "%s\\n" "${e%/}"; done';
  const argv = ["-d", distro, "--exec", "sh", "-c", script, "sh"];
  // Only pass the path as a positional when non-empty: wsl.exe rejects a trailing EMPTY argument
  // with Wsl/Service/E_INVALIDARG, which would break the picker's initial $HOME load. With no
  // positional, `$1` is unset and the script falls back to $HOME on its own.
  if (reqPath) argv.push(reqPath);
  return argv;
}

async function wslList(distro: string, reqPath: string): Promise<DirectoryListing> {
  const r = await run("wsl.exe", wslListArgs(distro, reqPath), { timeoutMs: 8000 });
  if (r.code !== 0) throw new Error(`cannot read directory in ${distro}: ${reqPath || "$HOME"}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const abs = lines.shift() ?? "/";
  const entries: DirectoryEntry[] = lines
    .filter((name) => !name.startsWith("."))
    .map((name) => ({ name, path: abs === "/" ? `/${name}` : `${abs}/${name}`, isDir: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = abs === "/" ? null : abs.replace(/\/[^/]+$/, "") || "/";
  return { path: abs, parent, entries };
}
