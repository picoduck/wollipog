/**
 * Cross-platform resolution of agent CLI binaries — on the native host and inside
 * WSL distros. The runner daemon usually runs non-login, so version-manager PATHs
 * (nvm/fnm) are invisible; we layer PATH → common install dirs → a version-manager
 * directory scan → a login-shell fallback to find them anyway. The login shell is NOT
 * enough for nvm on stock Ubuntu: the installer appends its init to ~/.bashrc BELOW
 * the interactive-only early return, so `bash -lc` never sees it — hence the explicit
 * ~/.nvm/versions scan. All probes use execFile (no shell) with a timeout so one hung
 * lookup can't stall discovery.
 */

import { execFile, execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { windowsCommandSpec } from "../windows-cmd.js";

const isWindows = platform() === "win32";

/** How to actually exec a resolved binary. npm shims under a version manager are node
 * scripts (`#!/usr/bin/env node`) — dead on arrival in the daemon's non-login PATH, and
 * env never crosses the wsl.exe boundary — so those launch as `<version>/bin/node <shim>`
 * with absolute paths (PATH-independent everywhere, native and WSL alike). */
export interface ResolvedLaunch {
  command: string;
  args: string[];
}

export interface ResolvedBinary {
  /** Absolute path to the resolved binary. */
  path: string;
  /** How it was found (for diagnostics). */
  via: "path" | "common-dir" | "version-manager" | "login-shell";
  /** How to exec it (equals {command: path, args: []} except for version-manager node shims). */
  launch: ResolvedLaunch;
  /** Canonical effective launch, computed in the execution context when host realpath cannot. */
  identity?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** String error from execFile (ENOENT, max-buffer, etc.); numeric exit codes omit it. */
  errorCode?: string;
}

/** Promise wrapper over execFile that never rejects — resolves with code/stdout/stderr. */
export function run(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let spec;
    try {
      spec = windowsCommandSpec(file, args);
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: (error as Error).message, errorCode: "EINVAL" });
      return;
    }
    execFile(
      spec.file,
      spec.args,
      {
        timeout: opts.timeoutMs ?? 5000,
        windowsHide: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        // Default execFile maxBuffer is 1 MB — way too small for catting agent transcripts; let
        // callers raise it so large reads don't silently fail with ENOBUFS.
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true, argv0: spec.argv0 } : {}),
      },
      (err, stdout, stderr) => {
        const detail = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const stringErrorCode = typeof detail?.code === "string" ? detail.code : undefined;
        const timedOut = detail?.code === "ETIMEDOUT" || (detail?.killed === true && !stringErrorCode);
        const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(timedOut ? { timedOut: true } : {}),
          ...(stringErrorCode && stringErrorCode !== "ETIMEDOUT" ? { errorCode: stringErrorCode } : {}),
        });
      },
    );
  });
}

/** Like run(), but returns raw stdout bytes (for UTF-16LE output like `wsl --list`). */
function runBuffer(file: string, args: string[], timeoutMs = 6000): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "buffer" }, (err, stdout) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: (stdout as unknown as Buffer) ?? Buffer.alloc(0) });
    });
  });
}

/** First non-empty line of text (trimmed), or "". */
function firstLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** Prefer a Win32-executable result from `where.exe`. npm/editor directories can put a POSIX
 * extensionless shell script before the adjacent .cmd shim, which CreateProcess cannot launch. */
export function pickWindowsExecutable(whereStdout: string): string | null {
  const lines = whereStdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /\.(?:exe|cmd|bat)$/i.test(line)) ?? lines[0] ?? null;
}

/** Candidate install dirs to scan when PATH/login-shell miss (per-OS). */
function commonDirs(): string[] {
  const home = homedir();
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(localAppData, "npm"), join(home, ".local", "bin"), join(home, ".bun", "bin")];
  }
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

/** Binary basenames to try for a logical name (Windows adds shim extensions). */
function candidateNames(name: string): string[] {
  return isWindows ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`] : [name];
}

/** Sort version-dir names newest-first ("v25.2.1" > "v9.0.0" — numeric, not lexicographic).
 * Non-semver names sink to the end. Pure; exported for tests. */
export function sortVersionsDesc(names: string[]): string[] {
  const key = (n: string): number[] | null => {
    const m = n.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  return [...names].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (!ka && !kb) return a.localeCompare(b);
    if (!ka) return 1;
    if (!kb) return -1;
    return kb[0]! - ka[0]! || kb[1]! - ka[1]! || kb[2]! - ka[2]!;
  });
}

/** Node-version-manager bin dirs on the native host, newest version first. nvm keeps
 * `~/.nvm/versions/node/<v>/bin`; fnm keeps `~/.local/share/fnm/node-versions/<v>/installation/bin`.
 * Newest-first is a heuristic (nvm's `default` alias can point elsewhere) but matches where a
 * recent `npm i -g` actually landed. */
function versionManagerBinDirs(): string[] {
  const home = homedir();
  const out: string[] = [];
  const bases: { root: string; sub: string[] }[] = [
    { root: join(home, ".nvm", "versions", "node"), sub: ["bin"] },
    { root: join(home, ".local", "share", "fnm", "node-versions"), sub: ["installation", "bin"] },
  ];
  for (const { root, sub } of bases) {
    let versions: string[];
    try {
      versions = readdirSync(root);
    } catch {
      continue;
    }
    for (const v of sortVersionsDesc(versions)) out.push(join(root, v, ...sub));
  }
  return out;
}

/** Decide how to exec a hit in a version-manager bin dir: node scripts (npm shims — a `.js`
 * realpath or a node shebang) run as `<nodePath> <script>`; real binaries run directly. The
 * caller supplies nodePath with the right separators (POSIX for WSL) or null when the sibling
 * node is absent. Pure; exported for tests. */
export function launchForVersionManagerHit(
  shimPath: string,
  realPath: string,
  firstLine: string,
  nodePath: string | null,
): ResolvedLaunch {
  const isNodeScript = /\.(c|m)?js$/i.test(realPath) || /^#!.*\bnode\b/.test(firstLine);
  if (isNodeScript && nodePath) return { command: nodePath, args: [shimPath] };
  return { command: shimPath, args: [] };
}

/** First 128 bytes of a file as utf8 (bounded — the target may be a large native binary). */
function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, 128, 0);
    return buf.subarray(0, Math.max(0, n)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** POSIX-only scan of nvm/fnm bin dirs (invisible to non-login AND `-lc` shells on stock
 * Ubuntu — see the module docstring). */
function resolveInVersionManagers(name: string): ResolvedBinary[] {
  const found: ResolvedBinary[] = [];
  for (const dir of versionManagerBinDirs()) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    let real = p;
    let firstLine = "";
    try {
      real = realpathSync(p);
      firstLine = readHead(real).split("\n")[0] ?? "";
    } catch {
      /* unreadable — treat as a plain binary */
    }
    const node = join(dir, "node");
    const launch = launchForVersionManagerHit(p, real, firstLine, existsSync(node) ? node : null);
    found.push({ path: p, via: "version-manager", launch });
  }
  return found;
}

/** {command: path, args: []} — the launch shape for a directly-executable hit. */
function directLaunch(path: string): ResolvedLaunch {
  return { command: path, args: [] };
}

/** Resolve an agent binary on the NATIVE host. Returns null if not found. */
/** An executable's canonical launch identity. Aliases collapse, while a node shim launched by
 * different version-manager runtimes remains distinct. */
export function resolvedLaunchIdentity(binary: ResolvedBinary): string {
  if (binary.identity) return binary.identity;
  const canonical = (path: string): string => {
    try { return realpathSync(path); } catch { return path; }
  };
  return JSON.stringify([canonical(binary.launch.command), ...binary.launch.args.map(canonical)]);
}

/** Recheck the entry point immediately before a session spawn. A package manager may replace a
 * symlink between discovery and launch; that needs rediscovery, not an implicit target change. */
export function launchTargetStillMatches(
  launch: ResolvedLaunch,
  context: AgentContext,
  expectedIdentity: string,
): boolean {
  try {
    if (context.kind === "wsl") {
      const paths = [launch.command, ...launch.args.filter((arg) => arg.startsWith("/"))];
      const output = execFileSync("wsl.exe", ["-d", context.distro, "--exec", "sh", "-c",
        'for p do readlink -e -- "$p" || exit 3; done', "sh", ...paths],
      { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8192 });
      const resolved = output.trimEnd().split(/\r?\n/);
      if (resolved.length !== paths.length || resolved.some((path) => !path.startsWith("/"))) return false;
      let index = 0;
      return JSON.stringify([resolved[index++], ...launch.args.map((arg) => arg.startsWith("/")
        ? resolved[index++] : arg)]) === expectedIdentity;
    }
    const canonical = (path: string) => isAbsolute(path) ? realpathSync(path) : path;
    return JSON.stringify([canonical(launch.command), ...launch.args.map(canonical)]) === expectedIdentity;
  } catch { return false; }
}

/** A runner started by SSH commonly has $HOME as its cwd. Treat that as an installation
 * root, not as a project whose descendants are all untrusted PATH wrappers. */
export function isProjectLocalExecutable(path: string, realPath: string, cwd: string, home: string): boolean {
  const current = resolve(cwd);
  if (path.includes(`${sep}node_modules${sep}.bin${sep}`)) return true;
  if (current === resolve(home)) return false;
  return [path, realPath].some((candidate) => candidate === current || candidate.startsWith(`${current}${sep}`));
}

/** Enumerate every plausible native installation, including user-local copies hidden by an SSH
 * runner's non-login PATH. No project-local PATH entry is executed during discovery. */
export async function resolveNativeCandidates(name: string): Promise<ResolvedBinary[]> {
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) return [];
  const hits: ResolvedBinary[] = [];
  const add = (path: string, via: ResolvedBinary["via"]) => {
    if (!isAbsolute(path)) return;
    try {
      const real = realpathSync(path);
      if (isProjectLocalExecutable(path, real, process.cwd(), homedir())) return;
      if (!statSync(real).isFile()) return;
      accessSync(path, constants.X_OK);
    } catch { return; }
    // Keep the stable installation entry point. Launch authorization revalidates its resolved
    // target before spawn, so an upgrade can retain the selection after rediscovery.
    let launch = directLaunch(path);
    if (!isWindows && isVersionManagerPath(path)) {
      const node = join(dirname(path), "node");
      try {
        launch = launchForVersionManagerHit(path, realpathSync(path),
          readHead(realpathSync(path)).split("\n")[0] ?? "", existsSync(node) ? realpathSync(node) : null);
        if (launch.command === path) launch = directLaunch(path);
      } catch { /* The executable check above still lets a native binary launch directly. */ }
    }
    hits.push({ path, via, launch });
  };

  // The runner's PATH order determines only the default, never the complete candidate set.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const candidate of candidateNames(name)) add(join(dir, candidate), "path");
  }

  // Windows can resolve executables through its own search rules beyond the literal PATH scan.
  if (isWindows) {
    const r = await run("where.exe", [name], { timeoutMs: 4000 });
    if (r.code === 0) for (const path of r.stdout.split(/\r?\n/)) {
      if (/\.(?:exe|cmd|bat)$/i.test(path.trim())) add(path.trim(), "path");
    }
  }

  // User-local and system installation directories may hold another version even when PATH hits.
  for (const dir of commonDirs()) {
    for (const candidate of candidateNames(name)) add(join(dir, candidate), "common-dir");
  }
  if (!isWindows) for (const binary of resolveInVersionManagers(name)) add(binary.path, binary.via);

  // A login shell may reveal a custom install directory absent from the runner's PATH.
  if (!isWindows) {
    const r = await run("/bin/sh", ["-lc", `command -v ${name}`], { timeoutMs: 6000 });
    const hit = firstLine(r.stdout);
    if (r.code === 0) add(hit, "login-shell");
  }
  const unique = new Map<string, ResolvedBinary>();
  for (const hit of hits) {
    const identity = resolvedLaunchIdentity(hit);
    const prior = unique.get(identity);
    // Alias selection must not change when PATH order changes. Map insertion order still keeps
    // the first distinct installation as the default.
    if (!prior || hit.path.localeCompare(prior.path) < 0) unique.set(identity, hit);
  }
  return [...unique.values()];
}

/** Legacy first-choice resolution used where the caller needs one executable. */
export async function resolveNative(name: string): Promise<ResolvedBinary | null> {
  return (await resolveNativeCandidates(name))[0] ?? null;
}

/** Enumerate installed WSL distros (Windows only). Empty on other OSes / if WSL absent. */
export async function listWslDistros(): Promise<string[]> {
  if (!isWindows) return [];
  // `wsl.exe --list --quiet` emits one distro name per line as UTF-16LE (with a BOM).
  // Decode the raw bytes losslessly — names can be non-ASCII or contain spaces.
  const r = await runBuffer("wsl.exe", ["--list", "--quiet"], 6000);
  if (r.code !== 0) return [];
  const text = r.stdout.toString("utf16le").replace(/^﻿/, "");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim()) // trim only — do NOT strip internal spaces
    .filter((l) => l.length > 0 && !/docker-desktop/i.test(l));
}

/** In-distro version-manager scan. The name rides as a POSITIONAL arg ($1), never interpolated
 * (same stance as fs-browse). Prints three lines on a hit: bin dir, realpath, first line of the
 * target (for node-shebang detection). `sort -rV` = newest version first (GNU coreutils — present
 * on every WSL distro). Exported for argv-shape tests. */
export function wslVersionManagerArgs(distro: string, name: string): string[] {
  const script =
    'for base in "$HOME/.nvm/versions/node" "$HOME/.local/share/fnm/node-versions"; do ' +
    '[ -d "$base" ] || continue; ' +
    'for v in $(ls -1 "$base" 2>/dev/null | sort -rV); do ' +
    'for sub in bin installation/bin; do d="$base/$v/$sub"; ' +
    '[ -x "$d/$1" ] || continue; ' +
    'printf "%s\\n" "$d"; rp=$(readlink -f "$d/$1"); printf "%s\\n" "$rp"; ' +
    'head -c 128 "$rp" 2>/dev/null | tr -d "\\0" | head -n 1; exit 0; ' +
    "done; done; done; exit 3";
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", name];
}

/** True when a resolved path lives under a node version manager's install tree — a hit there
 * is (almost always) a node-script shim that can't exec without that version's node. */
function isVersionManagerPath(p: string): boolean {
  return /\/\.nvm\/versions\/node\/[^/]+\/bin\//.test(p) || /\/fnm\/node-versions\/[^/]+\/installation\/bin\//.test(p);
}

/** wsl.exe argv for inspecting one specific path (positional $1 — never interpolated): prints
 * its realpath, then the target's first line (for node-shebang detection). Exported for tests. */
export function wslInspectArgs(distro: string, path: string): string[] {
  const script = 'rp=$(readlink -f "$1") || exit 3; printf "%s\\n" "$rp"; head -c 128 "$rp" 2>/dev/null | tr -d "\\0" | head -n 1; printf "\\n"; np=$(readlink -f "$(dirname "$1")/node" 2>/dev/null) || np=; [ -n "$np" ] && printf "NODE:%s\\n" "$np"; true';
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", path];
}

/** Resolve an agent binary INSIDE a WSL distro: login shell first, then the nvm/fnm dir scan
 * (stock Ubuntu's ~/.bashrc early-returns for non-interactive shells before the nvm init the
 * installer appends, so `bash -lc` alone misses nvm installs). A login-shell hit that itself
 * lives under nvm/fnm is node-wrapped IN PLACE — exec'ing such a shim directly dies on
 * `#!/usr/bin/env node` (no version manager on wsl.exe's default PATH), and rerouting to the
 * scan could silently launch a DIFFERENT node version's copy than the shell selected. Null if
 * not found. */
export async function resolveInWsl(distro: string, name: string): Promise<ResolvedBinary | null> {
  return (await resolveInWslCandidates(distro, name))[0] ?? null;
}

/** Enumerate a WSL distribution independently of the non-interactive SSH/runner PATH. Each
 * candidate is inspected inside that distribution before deriving its exact launch shape. */
export function wslCandidateScanArgs(distro: string, name: string): string[] {
  const script = [
    'oldIFS=$IFS; IFS=:; for d in $PATH; do case "$d" in /*) [ -x "$d/$1" ] && printf "path\\t%s\\n" "$d/$1";; esac; done; IFS=$oldIFS',
    'for d in "$HOME/.local/bin" "$HOME/.bun/bin" /usr/local/bin /usr/bin; do [ -x "$d/$1" ] && printf "common-dir\\t%s\\n" "$d/$1"; done',
    'for base in "$HOME/.nvm/versions/node" "$HOME/.local/share/fnm/node-versions"; do [ -d "$base" ] || continue; for v in $(ls -1 "$base" 2>/dev/null | sort -rV); do for sub in bin installation/bin; do d="$base/$v/$sub"; [ -x "$d/$1" ] && printf "version-manager\\t%s\\n" "$d/$1"; done; done; done',
  ].join("; ") + "; true";
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", name];
}

export async function resolveInWslCandidates(distro: string, name: string): Promise<ResolvedBinary[]> {
  if (!isWindows || !/^[a-z][a-z0-9-]*$/i.test(name)) return [];
  const found: Array<{ path: string; via: ResolvedBinary["via"] }> = [];
  const add = (path: string, via: ResolvedBinary["via"]) => {
    if (path.startsWith("/") && !/[\0\r\n\t]/.test(path)) found.push({ path, via });
  };
  // Preserve the legacy login-shell default. A plain WSL PATH may expose an older /usr/bin
  // executable while the user's profile intentionally selects a newer manager installation.
  const login = await run("wsl.exe", ["-d", distro, "--exec", "bash", "-lc", `command -v ${name}`], { timeoutMs: 8000 });
  if (login.code === 0) add(firstLine(login.stdout), "login-shell");
  const scan = await run("wsl.exe", wslCandidateScanArgs(distro, name), { timeoutMs: 8000 });
  if (scan.code === 0) {
    for (const line of scan.stdout.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const via = line.slice(0, tab);
      if (via === "path" || via === "common-dir" || via === "version-manager") add(line.slice(tab + 1), via);
    }
  }
  // The old fallback tried version-manager releases newest-first before the system PATH.
  const rank = (via: ResolvedBinary["via"]) => via === "login-shell" ? 0 : via === "version-manager" ? 1 : via === "path" ? 2 : 3;
  found.sort((a, b) => rank(a.via) - rank(b.via));

  const unique = new Map<string, ResolvedBinary>();
  for (const hit of found) {
    const inspected = await run("wsl.exe", wslInspectArgs(distro, hit.path), { timeoutMs: 8000 });
    if (inspected.code !== 0) continue;
    const lines = inspected.stdout.split(/\r?\n/).map((line) => line.trim());
    const [realPath, shebang] = lines;
    const nodePath = lines.find((line) => line.startsWith("NODE:"))?.slice(5);
    if (!realPath?.startsWith("/")) continue;
    const launch = isVersionManagerPath(hit.path)
      ? launchForVersionManagerHit(hit.path, realPath, shebang ?? "", nodePath?.startsWith("/") ? nodePath : null)
      : directLaunch(hit.path);
    const identity = JSON.stringify([launch.command === hit.path ? realPath : launch.command,
      ...launch.args.map((arg) => arg === hit.path ? realPath : arg)]);
    const binary = { path: hit.path, via: hit.via, launch, identity };
    const prior = unique.get(identity);
    if (!prior || hit.path.localeCompare(prior.path) < 0) unique.set(identity, binary);
  }
  return [...unique.values()];
}
