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

import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

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
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 5000,
        windowsHide: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        // Default execFile maxBuffer is 1 MB — way too small for catting agent transcripts; let
        // callers raise it so large reads don't silently fail with ENOBUFS.
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
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
  return isWindows ? [`${name}.cmd`, `${name}.exe`, `${name}.ps1`, name] : [name];
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
  if (isNodeScript && nodePath) return { command: nodePath, args: [realPath] };
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
function resolveInVersionManagers(name: string): ResolvedBinary | null {
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
    return { path: p, via: "version-manager", launch };
  }
  return null;
}

/** {command: path, args: []} — the launch shape for a directly-executable hit. */
function directLaunch(path: string): ResolvedLaunch {
  return { command: path, args: [] };
}

/** Resolve an agent binary on the NATIVE host. Returns null if not found. */
export async function resolveNative(name: string): Promise<ResolvedBinary | null> {
  // 1. PATH lookup — `where.exe` (Windows) / `command -v` (POSIX).
  if (isWindows) {
    const r = await run("where.exe", [name], { timeoutMs: 4000 });
    const hit = firstLine(r.stdout);
    if (r.code === 0 && hit && existsSync(hit)) return { path: hit, via: "path", launch: directLaunch(hit) };
  } else {
    const r = await run("/bin/sh", ["-c", `command -v ${name}`], { timeoutMs: 4000 });
    const hit = firstLine(r.stdout);
    // `command -v` can print an alias/function/builtin name (not a path) — require a real path.
    if (r.code === 0 && hit.startsWith("/")) return { path: hit, via: "path", launch: directLaunch(hit) };
  }

  // 2. Common install dirs.
  for (const dir of commonDirs()) {
    for (const cand of candidateNames(name)) {
      const p = join(dir, cand);
      if (existsSync(p)) return { path: p, via: "common-dir", launch: directLaunch(p) };
    }
  }

  // 3. Version-manager dirs (nvm/fnm) — POSIX only; npm-shim hits launch via that version's node.
  if (!isWindows) {
    const vm = resolveInVersionManagers(name);
    if (vm) return vm;
  }

  // 4. Login-shell fallback (sources ~/.profile etc.) — POSIX only. A hit that itself lives
  //    under nvm/fnm (possible when the scan missed an unusual layout) still gets the node
  //    wrap — exec'ing the shim directly dies on `#!/usr/bin/env node` in the daemon's PATH.
  if (!isWindows) {
    const r = await run("/bin/sh", ["-lc", `command -v ${name}`], { timeoutMs: 6000 });
    const hit = firstLine(r.stdout);
    if (r.code === 0 && hit.startsWith("/")) {
      if (isVersionManagerPath(hit)) {
        try {
          const real = realpathSync(hit);
          const first = readHead(real).split("\n")[0] ?? "";
          const node = join(dirname(hit), "node");
          const launch = launchForVersionManagerHit(hit, real, first, existsSync(node) ? node : null);
          return { path: hit, via: "login-shell", launch };
        } catch {
          /* unreadable — fall through to direct */
        }
      }
      return { path: hit, via: "login-shell", launch: directLaunch(hit) };
    }
  }

  return null;
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
  const script = 'rp=$(readlink -f "$1") || exit 3; printf "%s\\n" "$rp"; head -c 128 "$rp" 2>/dev/null | tr -d "\\0" | head -n 1';
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
  if (!isWindows) return null;
  const r = await run("wsl.exe", ["-d", distro, "--exec", "bash", "-lc", `command -v ${name}`], { timeoutMs: 8000 });
  const hit = firstLine(r.stdout);
  const loginHit =
    r.code === 0 && hit.startsWith("/")
      ? ({ path: hit, via: "login-shell", launch: directLaunch(hit) } as const)
      : null;
  if (loginHit) {
    if (!isVersionManagerPath(loginHit.path)) return loginHit;
    // Wrap THIS hit (the version the user's shell actually selects), not a scan result.
    const insp = await run("wsl.exe", wslInspectArgs(distro, loginHit.path), { timeoutMs: 8000 });
    if (insp.code === 0) {
      const [realPath, shebang] = insp.stdout.split(/\r?\n/).map((l) => l.trim());
      if (realPath?.startsWith("/")) {
        const binDir = loginHit.path.slice(0, loginHit.path.lastIndexOf("/"));
        const launch = launchForVersionManagerHit(loginHit.path, realPath, shebang ?? "", `${binDir}/node`);
        return { path: loginHit.path, via: "login-shell", launch };
      }
    }
    return loginHit; // inspection failed — direct launch as best effort
  }

  const vm = await run("wsl.exe", wslVersionManagerArgs(distro, name), { timeoutMs: 8000 });
  if (vm.code === 0) {
    const [binDir, realPath, shebang] = vm.stdout.split(/\r?\n/).map((l) => l.trim());
    if (binDir?.startsWith("/") && realPath?.startsWith("/")) {
      const shimPath = `${binDir}/${name}`;
      // node exists beside every nvm/fnm shim by construction (it IS that version dir's node).
      const launch = launchForVersionManagerHit(shimPath, realPath, shebang ?? "", `${binDir}/node`);
      return { path: shimPath, via: "version-manager", launch };
    }
  }
  return null;
}
