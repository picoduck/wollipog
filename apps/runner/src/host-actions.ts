/**
 * Host actions: open a session's working directory in a local editor, or reveal it in the
 * OS file manager. Editor discovery reuses the agent-discovery PATH resolution. The pure
 * spec builders (editorLaunchSpec / revealSpec) are exported and unit-tested; launching is
 * fire-and-forget (detached spawn — an editor is a GUI app, not a child we wait on).
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  parseSourceLocation,
  type AgentContext,
  type EditorInfo,
  type EditorLocationPrecision,
  type EditorSourceLocation,
  type HostAction,
} from "@wollipog/protocol";
import { resolveNative, run } from "./discovery/resolve.js";

interface KnownEditor extends EditorInfo {
  /** Binary name to resolve on PATH. */
  bin: string;
  /** Supports VS Code-style `--remote wsl+<distro>` for WSL session roots. */
  remoteWsl?: boolean;
  locationStyle?: "vscode" | "path" | "idea";
}

/** Catalog order is display order. */
export const KNOWN_EDITORS: KnownEditor[] = [
  { id: "code", name: "VS Code", bin: "code", remoteWsl: true, locationStyle: "vscode", locations: { native: "column", wsl: "column" } },
  { id: "cursor", name: "Cursor", bin: "cursor", remoteWsl: true, locationStyle: "vscode", locations: { native: "column" } },
  // Devin Desktop is the presentation name for the existing Windsurf installation and CLI.
  // Keep the stable id/bin so upgrades retain discovery, launch, and browser preference state.
  { id: "windsurf", name: "Devin Desktop", bin: "windsurf", remoteWsl: true },
  { id: "zed", name: "Zed", bin: "zed", locationStyle: "path", locations: { native: "column" } },
  { id: "subl", name: "Sublime Text", bin: "subl", locationStyle: "path", locations: { native: "column" } },
  { id: "idea", name: "IntelliJ IDEA", bin: "idea", locationStyle: "idea", locations: { native: "column" } },
];

/** Probe the host for known editor CLIs (catalog order preserved). */
export async function discoverEditors(): Promise<EditorInfo[]> {
  const found = await Promise.all(KNOWN_EDITORS.map(async (e) => ((await resolveEditorBin(e.bin)) ? e : null)));
  return found.filter((e): e is KnownEditor => e !== null).map(({ id, name, locations }) => ({
    id,
    name,
    ...(locations ? { locations: { ...locations } } : {}),
  }));
}

/**
 * Pick the Windows-executable hit out of a `where.exe` listing. Editor bin dirs ship a
 * POSIX shell script FIRST (`...\bin\code`) with the real `.cmd`/`.exe` beside it —
 * spawning the extension-less script fails on Windows, so prefer a real executable.
 */
export function pickWindowsExecutable(whereStdout: string): string | null {
  const lines = whereStdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0] ?? null;
}

/** Resolve an editor CLI to a spawnable path (null = not installed). */
async function resolveEditorBin(bin: string): Promise<string | null> {
  if (process.platform === "win32") {
    const r = await run("where.exe", [bin], { timeoutMs: 4000 });
    if (r.code !== 0) return null;
    return pickWindowsExecutable(r.stdout);
  }
  const hit = await resolveNative(bin);
  return hit?.path ?? null;
}

export interface LaunchSpec {
  bin: string;
  args: string[];
}

const LOCATION_PRECISION_RANK: Record<EditorLocationPrecision, number> = { file: 0, line: 1, column: 2 };

function sourceTarget(root: string, context: AgentContext, path: string): string {
  if (context.kind === "wsl" || root.startsWith("/")) return `${root.replace(/\/+$/, "")}/${path}`;
  return join(root, ...path.split("/"));
}

export function wslSourceFileCheckArgs(distro: string, root: string, path: string): string[] {
  return ["-d", distro, "--exec", "sh", "-c", 'cd "$1" 2>/dev/null && test -f "./$2"', "sh", root, path];
}

async function sourceFileExists(root: string, context: AgentContext, path: string): Promise<boolean> {
  if (context.kind === "wsl") {
    const result = await run("wsl.exe", wslSourceFileCheckArgs(context.distro, root, path), { timeoutMs: 5000 });
    return result.code === 0;
  }
  try {
    return statSync(sourceTarget(root, context, path)).isFile();
  } catch {
    return false;
  }
}

function requestedPrecision(location: EditorSourceLocation): EditorLocationPrecision {
  if (location.column !== undefined) return "column";
  if (location.line !== undefined) return "line";
  return "file";
}

function targetWithPosition(target: string, location: EditorSourceLocation): string {
  if (location.line === undefined) return target;
  return `${target}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
}

/**
 * Argv to open `root` in an editor. WSL roots use the VS Code-family remote flag — an
 * editor without it gets a clear error instead of opening a nonsense path.
 */
export function editorLaunchSpec(
  editorId: string,
  root: string,
  context: AgentContext,
  location?: EditorSourceLocation,
): LaunchSpec | { error: string } {
  const e = KNOWN_EDITORS.find((x) => x.id === editorId);
  if (!e) return { error: `unknown editor: ${editorId}` };
  if (location) {
    const parsed = parseSourceLocation(location, false);
    if (!parsed) return { error: "invalid source location" };
    const precision = context.kind === "wsl" ? e.locations?.wsl : e.locations?.native;
    if (!precision || !e.locationStyle) {
      return { error: `${e.name} does not expose verified source-location support in ${context.kind === "wsl" ? context.distro : "the native host"}` };
    }
    const requested = requestedPrecision(parsed);
    if (LOCATION_PRECISION_RANK[requested] > LOCATION_PRECISION_RANK[precision]) {
      return { error: `${e.name} supports ${precision} locations, not ${requested} locations` };
    }
    const target = sourceTarget(root, context, parsed.path);
    if (e.locationStyle === "idea") {
      return {
        bin: e.bin,
        args: [
          ...(parsed.line === undefined ? [] : ["--line", String(parsed.line)]),
          ...(parsed.column === undefined ? [] : ["--column", String(parsed.column)]),
          target,
        ],
      };
    }
    const positioned = targetWithPosition(target, parsed);
    if (context.kind === "wsl") {
      return { bin: e.bin, args: ["--remote", `wsl+${context.distro}`, "--goto", positioned] };
    }
    return { bin: e.bin, args: e.locationStyle === "vscode" ? ["--goto", positioned] : [positioned] };
  }
  if (context.kind === "wsl") {
    if (!e.remoteWsl) return { error: `${e.name} cannot open a WSL path — use VS Code, Cursor, or Devin Desktop` };
    return { bin: e.bin, args: ["--remote", `wsl+${context.distro}`, root] };
  }
  return { bin: e.bin, args: [root] };
}

/** Argv to reveal `root` in the OS file manager. WSL roots open through \\wsl.localhost. */
export function revealSpec(root: string, context: AgentContext, platform: NodeJS.Platform): LaunchSpec {
  if (context.kind === "wsl") {
    return { bin: "explorer.exe", args: [`\\\\wsl.localhost\\${context.distro}${root.replace(/\//g, "\\")}`] };
  }
  if (platform === "win32") return { bin: "explorer.exe", args: [root] };
  if (platform === "darwin") return { bin: "open", args: [root] };
  return { bin: "xdg-open", args: [root] };
}

export interface DetachedLaunchSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** Quote one token in the complete balanced `/s /c` tail. Inside these quotes cmd metacharacters,
 * including `^`, are data; adding carets here survives `%*` expansion in the batch shim and
 * corrupts the editor argv. Delayed expansion is disabled separately below. */
function cmdShimToken(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("Windows editor shim arguments cannot contain CR/LF");
  if (value.includes("%")) throw new Error("Windows editor shim arguments cannot contain %, which cmd.exe would expand");
  if (value.includes('"')) throw new Error("Windows editor shim arguments cannot contain a double quote");
  return `"${value}"`;
}

/** Build a shell-free launch. Windows editor `.cmd` shims still require cmd.exe, but every token
 * receives the same CR/LF/percent/metacharacter treatment as the real ConPTY TUI path. */
export function detachedLaunchSpec(
  command: string,
  args: string[],
  host: { platform: NodeJS.Platform; comspec?: string } = { platform: process.platform, comspec: process.env.ComSpec },
): DetachedLaunchSpec {
  if (host.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    // Every token is individually quoted. Metacharacters inside those balanced quotes are data;
    // careting them would survive through a batch shim as literal `^` characters.
    const tail = [command, ...args].map(cmdShimToken).join(" ");
    return {
      command: host.comspec || "cmd.exe",
      // Host policy can default delayed expansion on; force it off so a legitimate `!` in a
      // repository path remains data instead of becoming an environment expansion boundary.
      args: ["/d", "/v:off", "/s", "/c", `"${tail}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, windowsVerbatimArguments: false };
}

/** Spawn a GUI process detached; resolves ok unless the spawn itself fails to start. */
function launchDetached(command: string, args: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      const spec = detachedLaunchSpec(command, args);
      const child = spawn(spec.command, spec.args, {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: process.platform === "win32",
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      // If no error fires in the same tick window, consider the launch started.
      child.unref();
      setTimeout(() => resolve({ ok: true }), 150);
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
    }
  });
}

/** Execute a host action against a resolved session root. */
export async function runHostAction(
  action: HostAction,
  root: string,
  context: AgentContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (action.kind === "reveal") {
    const spec = revealSpec(root, context, process.platform);
    return launchDetached(spec.bin, spec.args);
  }
  const location = action.kind === "open_editor_location" ? parseSourceLocation(action.location, false) : undefined;
  if (action.kind === "open_editor_location" && !location) return { ok: false, error: "invalid source location" };
  if (location && !(await sourceFileExists(root, context, location.path))) {
    return { ok: false, error: `source file does not exist: ${location.path}` };
  }
  const spec = editorLaunchSpec(action.editorId, root, context, location ?? undefined);
  if ("error" in spec) return { ok: false, error: spec.error };
  // Resolve the actual binary — `code` and friends are shims, and the first `where` hit on
  // Windows is a POSIX script the OS can't execute (pickWindowsExecutable handles that).
  const resolved = await resolveEditorBin(spec.bin);
  if (!resolved) return { ok: false, error: `${spec.bin} is not installed (or not on PATH) on the runner host` };
  return launchDetached(resolved, spec.args);
}
