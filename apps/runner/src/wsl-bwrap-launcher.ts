import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAsset, isSea } from "node:sea";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";

export const WSL_BWRAP_LAUNCHER_PROTOCOL = 1 as const;
export const WSL_BWRAP_LAUNCHER_PATH = "/usr/local/lib/wollipog/wsl-bwrap-launcher-v1";
export const WSL_BWRAP_STATE_ROOT = "/var/lib/wollipog-wsl-launcher/runner-instances";
/** Source-checkout provisioning input. Packaged runners must replace this with an SEA asset. */
export const WSL_BWRAP_LAUNCHER_SOURCE_PATH = isSea() ? "" : fileURLToPath(
  new URL("../native/wsl-bwrap-launcher.c", import.meta.url),
);
const WSL_BWRAP_LAUNCHER_SOURCE_ASSET = "wollipog/wsl-bwrap-launcher.c";

function launcherSource(): Buffer {
  if (!isSea()) return readFileSync(WSL_BWRAP_LAUNCHER_SOURCE_PATH);
  try { return Buffer.from(getAsset(WSL_BWRAP_LAUNCHER_SOURCE_ASSET)); }
  catch (cause) { throw new Error("the packaged WSL launcher source asset is missing", { cause }); }
}

const IDENTITY = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/u;
const MAX_BINDS = 64;

function targetDistro(value: string): string {
  if (!value || value.length > 256 || /[\0\r\n]/u.test(value)) throw new Error("WSL distro is invalid");
  return value;
}

export interface WslBwrapPreparedPath {
  path: string;
  identity: string;
}

export interface WslBwrapPreparedBind {
  mode: "ro" | "rw";
  source: WslBwrapPreparedPath;
  target: WslBwrapPreparedPath;
}

export interface WslBwrapPreparation {
  version: typeof WSL_BWRAP_LAUNCHER_PROTOCOL;
  cwd: WslBwrapPreparedPath;
  home: WslBwrapPreparedPath;
  binds: WslBwrapPreparedBind[];
}

export interface WslBwrapPrepareRequest {
  bwrap: string;
  home: string;
  cwd: string;
  ensure?: string[];
  binds?: Array<{ mode: "ro" | "rw"; source: string; target: string }>;
}

export interface WslBwrapLaunchRequest {
  distro: string;
  launcher?: string;
  bwrap: string;
  preparation: WslBwrapPreparation;
  network: "inherit" | "deny";
  pidfile: string;
  command: string;
  args: string[];
}

export interface WslBwrapRelayRequest {
  distro: string;
  launcher?: string;
  directory: WslBwrapPreparedPath;
  node: string;
  helper: string;
  socket: string;
}

/** The source reaches cc on standard input. Every pathname is a fixed program or a positional
 * argument, and publication is an atomic rename of a verified root-owned staging file. */
export const WSL_BWRAP_INSTALL_SCRIPT = `set -eu
target=$1
staged=$2
trap '/usr/bin/rm -f -- "$staged"' EXIT HUP INT TERM
for fixed in /usr /usr/local /usr/local/lib; do
  test -d "$fixed"; test ! -L "$fixed"; test "$(/usr/bin/stat -c %u "$fixed")" = 0
  mode=$(/usr/bin/stat -c %a "$fixed"); test $((0$mode & 022)) = 0
done
dir=/usr/local/lib/wollipog
if test -e "$dir" || test -L "$dir"; then
  test -d "$dir"; test ! -L "$dir"; test "$(/usr/bin/stat -c %u "$dir")" = 0
  mode=$(/usr/bin/stat -c %a "$dir"); test $((0$mode & 022)) = 0
else
  /usr/bin/mkdir -m 0755 -- "$dir"; /usr/bin/chown root:root "$dir"
fi
/usr/bin/chmod 0755 "$dir"
compiler=$(/usr/bin/readlink -f /usr/bin/cc)
case "$compiler" in /usr/bin/*) ;; *) exit 125;; esac
test -x "$compiler"; test ! -L "$compiler"
for component in /usr /usr/bin "$compiler"; do
  test ! -L "$component"
  test "$(/usr/bin/stat -c '%u' "$component")" = 0
  mode=$(/usr/bin/stat -c '%a' "$component"); test $((0$mode & 022)) = 0
done
"$compiler" -O2 -std=c11 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro -Wl,-z,now -Wl,-z,noexecstack -x c -o "$staged" -
/usr/bin/chown root:root "$staged"
/usr/bin/chmod 0555 "$staged"
test "$(/usr/bin/stat -c '%u:%g:%a' "$staged")" = 0:0:555
"$staged" self-test >/dev/null
/usr/bin/mv -T -- "$staged" "$target"
trap - EXIT HUP INT TERM
test "$(/usr/bin/stat -c '%u:%g:%a' "$target")" = 0:0:555
`;

export async function installWslBwrapLauncher(distro: string): Promise<void> {
  targetDistro(distro);
  const source = launcherSource();
  const staged = `${WSL_BWRAP_LAUNCHER_PATH}.pending-${process.pid}-${randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("wsl.exe", [
      "-d", distro, "-u", "root", "--exec", "/bin/sh", "-c", WSL_BWRAP_INSTALL_SCRIPT,
      "wollipog-install-wsl-bwrap-launcher", WSL_BWRAP_LAUNCHER_PATH, staged,
    ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    const diagnostics: Buffer[] = [];
    let diagnosticBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnosticBytes >= 64 * 1024) return;
      const bounded = chunk.subarray(0, 64 * 1024 - diagnosticBytes);
      diagnostics.push(bounded); diagnosticBytes += bounded.length;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`WSL bwrap launcher installation failed${signal ? ` (${signal})` : ` (exit ${code ?? "unknown"})`}: ${Buffer.concat(diagnostics).toString("utf8").trim()}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(source);
  });
}

export async function prepareWslBwrapIsolation(
  context: AgentContext,
  request: WslBwrapPrepareRequest,
): Promise<WslBwrapPreparation> {
  if (context.kind !== "wsl") throw new Error("WSL bwrap isolation requires a WSL context");
  const result = await runContextCommand(
    context,
    WSL_BWRAP_LAUNCHER_PATH,
    buildWslBwrapPrepareArgs(request),
    { cwd: "/", timeoutMs: 15_000, maxBuffer: 256 * 1024 },
  );
  return parseWslBwrapPreparation(result.stdout);
}

const HASH = /^[a-f0-9]{64}$/u;

export function wslBwrapSessionRoot(ownerHash: string, sessionKey: string): string {
  if (!HASH.test(ownerHash) || !HASH.test(sessionKey)) throw new Error("WSL launcher state requires hashed owner and session ids");
  return `${WSL_BWRAP_STATE_ROOT}/${ownerHash}/sessions/${sessionKey}`;
}

async function runRootScript(distro: string, script: string, args: string[]): Promise<void> {
  targetDistro(distro);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("wsl.exe", ["-d", distro, "-u", "root", "--exec", "/bin/sh", "-c", script,
      "wollipog-wsl-state", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const diagnostics: Buffer[] = [];
    let bytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (bytes >= 16 * 1024) return;
      const bounded = chunk.subarray(0, 16 * 1024 - bytes); diagnostics.push(bounded); bytes += bounded.length;
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(
      `target-local WSL state operation failed (exit ${code ?? "unknown"}): ${Buffer.concat(diagnostics).toString("utf8").trim()}`,
    )));
  });
}

/** All variable components are fixed-length lowercase hashes or a numeric uid. The mutable leaves
 * sit below a root-owned, non-writable session directory, so the provider uid cannot rename or
 * substitute them between prepare and launch. */
export async function provisionWslBwrapSessionState(
  distro: string,
  ownerHash: string,
  sessionKey: string,
  uid: number,
): Promise<{ root: string; provider: string; relay: string }> {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("WSL launcher requires a non-root numeric uid");
  const root = wslBwrapSessionRoot(ownerHash, sessionKey);
  const script = `set -eu
root=$1; uid=$2
case "$root" in /var/lib/wollipog-wsl-launcher/runner-instances/[a-f0-9][a-f0-9]*/sessions/[a-f0-9][a-f0-9]*) ;; *) exit 125;; esac
gid=$(/usr/bin/id -g "$uid")
for fixed in /var /var/lib; do
  test -d "$fixed"; test ! -L "$fixed"; test "$(/usr/bin/stat -c '%u' "$fixed")" = 0
  mode=$(/usr/bin/stat -c '%a' "$fixed"); test $((0$mode & 022)) = 0
done
for owned in /var/lib/wollipog-wsl-launcher /var/lib/wollipog-wsl-launcher/runner-instances "\${root%/*/*}" "\${root%/*}" "$root"; do
  if test -e "$owned" || test -L "$owned"; then
    test -d "$owned"; test ! -L "$owned"; test "$(/usr/bin/stat -c '%u' "$owned")" = 0
    mode=$(/usr/bin/stat -c '%a' "$owned"); test $((0$mode & 022)) = 0
  else
    /usr/bin/mkdir -m 0711 -- "$owned"
    /usr/bin/chown root:root "$owned"
  fi
  /usr/bin/chmod 0711 "$owned"
done
for leaf in provider relay; do
  path="$root/$leaf"
  if test -e "$path" || test -L "$path"; then test -d "$path"; test ! -L "$path"; else /usr/bin/mkdir -- "$path"; fi
  /usr/bin/chown "$uid:$gid" "$path"; /usr/bin/chmod 0700 "$path"
done
test "$(/usr/bin/stat -c '%u:%a' "$root")" = 0:711
for stale in control.sock token mcp.json provider.pgid; do
  if test -e "$root/relay/$stale" || test -L "$root/relay/$stale"; then
    test ! -d "$root/relay/$stale"; /usr/bin/rm -f -- "$root/relay/$stale"
  fi
done
for stale in "$root/relay"/provider-*.pgid; do
  if test -e "$stale" || test -L "$stale"; then test ! -d "$stale"; /usr/bin/rm -f -- "$stale"; fi
done
`;
  await runRootScript(distro, script, [root, String(uid)]);
  return { root, provider: `${root}/provider`, relay: `${root}/relay` };
}

export async function cleanupWslBwrapSessionState(
  distro: string,
  ownerHash: string,
  sessionKey: string,
): Promise<void> {
  const root = wslBwrapSessionRoot(ownerHash, sessionKey);
  const script = `set -eu
root=$1; parent=\${root%/*}
for fixed in /var /var/lib /var/lib/wollipog-wsl-launcher /var/lib/wollipog-wsl-launcher/runner-instances "\${root%/*/*}" "$parent"; do
  test -d "$fixed"; test ! -L "$fixed"; test "$(/usr/bin/stat -c '%u' "$fixed")" = 0
  mode=$(/usr/bin/stat -c '%a' "$fixed"); test $((0$mode & 022)) = 0
done
if test -e "$root" || test -L "$root"; then
  test -d "$root" && test ! -L "$root" && test "$(/usr/bin/stat -c '%u' "$root")" = 0
  /usr/bin/rm -rf --one-file-system -- "$root"
fi
`;
  await runRootScript(distro, script, [root]);
}

function absoluteTargetPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length >= 4_096 || value.endsWith("/") ||
      value.includes("\0") || value.split("/").slice(1).some((part) => !part || part === "." || part === "..")) {
    if (value === "/") return value;
    throw new Error(`${label} must be a bounded absolute traversal-free target path`);
  }
  return value;
}

function preparedPath(value: unknown, label: string): WslBwrapPreparedPath {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "identity,path" || typeof candidate.identity !== "string" ||
      !IDENTITY.test(candidate.identity)) throw new Error(`${label} identity is invalid`);
  return { path: absoluteTargetPath(candidate.path, `${label} path`), identity: candidate.identity };
}

/** Decode only the fixed helper schema. Diagnostics and attacker-controlled paths never become an
 * open-ended launch object. */
export function parseWslBwrapPreparation(stdout: string): WslBwrapPreparation {
  if (Buffer.byteLength(stdout) > 256 * 1024) throw new Error("WSL bwrap preparation response is too large");
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new Error("WSL bwrap preparation response is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WSL bwrap preparation response is invalid");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "binds,cwd,home,version" ||
      candidate.version !== WSL_BWRAP_LAUNCHER_PROTOCOL || !Array.isArray(candidate.binds) ||
      candidate.binds.length > MAX_BINDS) throw new Error("WSL bwrap preparation response has an unsupported schema");
  const binds = candidate.binds.map((raw, index): WslBwrapPreparedBind => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`WSL bwrap bind ${index} is invalid`);
    const bind = raw as Record<string, unknown>;
    if (Object.keys(bind).sort().join(",") !== "mode,source,target" || (bind.mode !== "ro" && bind.mode !== "rw")) {
      throw new Error(`WSL bwrap bind ${index} has an unsupported schema`);
    }
    return {
      mode: bind.mode,
      source: preparedPath(bind.source, `WSL bwrap bind ${index} source`),
      target: preparedPath(bind.target, `WSL bwrap bind ${index} target`),
    };
  });
  const targets = new Set<string>();
  for (const bind of binds) {
    if (targets.has(bind.target.path)) throw new Error("WSL bwrap preparation contains duplicate bind targets");
    targets.add(bind.target.path);
  }
  return {
    version: WSL_BWRAP_LAUNCHER_PROTOCOL,
    cwd: preparedPath(candidate.cwd, "WSL bwrap cwd"),
    home: preparedPath(candidate.home, "WSL bwrap HOME"),
    binds,
  };
}

export function buildWslBwrapPrepareArgs(request: WslBwrapPrepareRequest): string[] {
  const binds = request.binds ?? [];
  if (binds.length > MAX_BINDS) throw new Error("WSL bwrap preparation has too many binds");
  const targets = new Set<string>();
  for (const bind of binds) {
    absoluteTargetPath(bind.source, "WSL bwrap bind source");
    const target = absoluteTargetPath(bind.target, "WSL bwrap bind target");
    if (targets.has(target)) throw new Error("WSL bwrap preparation has duplicate bind targets");
    targets.add(target);
  }
  return [
    "prepare",
    "--bwrap", absoluteTargetPath(request.bwrap, "WSL bwrap executable"),
    "--home", absoluteTargetPath(request.home, "WSL provider HOME"),
    "--cwd", absoluteTargetPath(request.cwd, "WSL cwd"),
    ...(request.ensure ?? []).flatMap((path) => ["--ensure", absoluteTargetPath(path, "WSL ensured directory")]),
    ...binds.flatMap((bind) => [`--${bind.mode}`, bind.source, bind.target]),
  ];
}

/** Build the outer Windows launch. The same target-resolved cwd is both wsl.exe's --cd operand and
 * the value retained by SessionManager for every provider protocol request. */
export function buildWslBwrapLaunchArgs(request: WslBwrapLaunchRequest): string[] {
  targetDistro(request.distro);
  const launcher = absoluteTargetPath(request.launcher ?? WSL_BWRAP_LAUNCHER_PATH, "WSL bwrap launcher");
  const prepared = request.preparation;
  return [
    "-d", request.distro,
    "--cd", prepared.cwd.path,
    "--exec", launcher, "launch",
    "--bwrap", absoluteTargetPath(request.bwrap, "WSL bwrap executable"),
    "--home", prepared.home.path, prepared.home.identity,
    "--cwd", prepared.cwd.path, prepared.cwd.identity,
    "--pidfile", absoluteTargetPath(request.pidfile, "WSL pidfile"),
    "--network", request.network,
    ...prepared.binds.flatMap((bind) => [
      `--${bind.mode}`,
      bind.source.path, bind.source.identity,
      bind.target.path, bind.target.identity,
    ]),
    "--", request.command, ...request.args,
  ];
}

/** Build the socket relay launch around the prepared directory identity. The helper receives only
 * a relative socket leaf after the native launcher has entered that directory by descriptor. */
export function buildWslBwrapRelayArgs(request: WslBwrapRelayRequest): string[] {
  targetDistro(request.distro);
  if (!request.socket || request.socket.length > 255 || request.socket.includes("/") ||
      request.socket === "." || request.socket === ".." || request.socket.includes("\0")) {
    throw new Error("WSL relay socket must be one relative filename");
  }
  return [
    "-d", request.distro,
    "--cd", "/",
    "--exec", absoluteTargetPath(request.launcher ?? WSL_BWRAP_LAUNCHER_PATH, "WSL bwrap launcher"),
    "relay", "--dir", request.directory.path, request.directory.identity,
    "--", absoluteTargetPath(request.node, "WSL relay Node"),
    absoluteTargetPath(request.helper, "WSL relay helper"), "serve", request.socket,
  ];
}
