/**
 * `wollipog service`: install, inspect, restart, tail, and remove the control plane and colocated
 * runner as durable Linux systemd services (user or system mode). Other platforms are reported as
 * unsupported explicitly. Every side effect goes through `ServiceHost` so the flows are testable.
 */

import { spawn } from "node:child_process";
import {
  chmodSync, constants, closeSync, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { hostname as osHostname, homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execCapture } from "./exec-capture.js";
import type { McpFetch } from "./session-management-mcp.js";
import { runHostAdminCli, type HostAdminIo } from "./host-admin-cli.js";
import {
  CHECKSUM_MANIFEST_NAME,
  WEB_BUNDLE_ASSET_NAME,
  controlPlaneAssetName,
  downloadToFile,
  downloadVerifiedAsset,
  findAsset,
  hostTargetTriple,
  parseChecksumManifest,
  resolveRelease,
  runnerAssetName,
  sha256File,
  type Downloader,
  type JsonFetch,
} from "./release-assets.js";
import { VERSION } from "./version.js";
import {
  CONTROL_PLANE_UNIT,
  DEFAULT_PORT,
  RUNNER_UNIT,
  SYSTEMCTL_SHOW_PROPERTIES,
  parseComponent,
  parseSystemctlShow,
  renderControlPlaneEnv,
  renderControlPlaneUnit,
  renderRunnerConfig,
  renderRunnerUnit,
  parseEnvFile,
  readInstalledControlPlaneEnv,
  serviceLayout,
  type ServiceComponent,
  type ServiceLayout,
  type ServiceMode,
  type UnitState,
  unitFor,
} from "./systemd-service.js";

const VALUE_OPTIONS = new Set([
  "--control-plane-bin", "--runner-bin", "--web-dist", "--host", "--port", "--public-origin", "--runner-id",
  "--workspace", "--account", "--lines", "--release",
]);
const LOOPBACK_HOST_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/u;
const RUNNER_ID_REJECT_RE = /[\u0000-\u0020\u007f/\\?#]/u;

export interface ServiceHost {
  platform: NodeJS.Platform;
  uid: number | null;
  user: string;
  home: string;
  hostname: string;
  execPath: string;
  isSea: boolean;
  env: NodeJS.ProcessEnv;
  cwd(): string;
  exec(command: string, args: string[], options?: { timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Run with inherited stdio (for `logs --follow`); resolves with the exit code. */
  spawnInherit(command: string, args: string[]): Promise<number>;
  fetch: McpFetch;
  /** GitHub REST metadata requests (JSON). */
  fetchJson: JsonFetch;
  /** Stream a release asset to a file. */
  download: Downloader;
  arch: string;
  sleep(ms: number): Promise<void>;
  now(): number;
  exists(path: string): boolean;
  readFile(path: string): string;
  /** Create a directory with `mode` if it does not exist; never changes an existing one. Returns true when created. */
  ensureDir(path: string, mode: number): boolean;
  /** Replace-capable atomic write (units, configs); mode applies to the new file. */
  writeFile(path: string, contents: string, mode: number): void;
  removeFile(path: string): void;
  removeTree(path: string): void;
  /** Replace-capable move; falls back to copy + remove across filesystems. */
  move(from: string, to: string): void;
  /** Recursive copy (directories). */
  copyTree(from: string, to: string): void;
  chmod(path: string, mode: number): void;
}

function detectSea(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return Boolean((require("node:sea") as { isSea?: () => boolean }).isSea?.());
  } catch {
    return false;
  }
}

export function defaultServiceHost(fetchImpl: McpFetch = globalThis.fetch): ServiceHost {
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    user: (() => { try { return userInfo().username; } catch { return process.env.USER ?? ""; } })(),
    home: homedir(),
    hostname: osHostname(),
    execPath: process.execPath,
    isSea: detectSea(),
    env: process.env,
    cwd: () => process.cwd(),
    exec: (command, args, options) => execCapture(command, args, options),
    spawnInherit: (command, args) => new Promise((resolvePromise) => {
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("error", () => resolvePromise(1));
      child.on("close", (code) => resolvePromise(code ?? 1));
    }),
    fetch: fetchImpl,
    fetchJson: async (url, headers) => {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      return { ok: response.ok, status: response.status, text: () => response.text() };
    },
    download: downloadToFile,
    arch: process.arch,
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    now: () => Date.now(),
    exists: (path) => { try { lstatSync(path); return true; } catch { return false; } },
    readFile: (path) => readFileSync(path, "utf8"),
    ensureDir: (path, mode) => {
      try {
        if (lstatSync(path).isDirectory()) return false;
        throw new Error(`${path} exists and is not a directory`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      mkdirSync(path, { recursive: true, mode });
      try { chmodSync(path, mode); } catch { /* best effort on the new directory only */ }
      return true;
    },
    writeFile: (path, contents, mode) => {
      const staged = `${path}.tmp-${process.pid}`;
      const fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
      try {
        writeFileSync(fd, contents, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try { chmodSync(staged, mode); } catch { /* best effort */ }
      renameSync(staged, path);
    },
    removeFile: (path) => rmSync(path, { force: true }),
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    move: (from, to) => {
      try {
        renameSync(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        // Across filesystems, copy beside the destination first so the destination itself is only
        // ever created by a rename and can never be observed half-written.
        const staged = `${to}.tmp-${process.pid}`;
        rmSync(staged, { recursive: true, force: true });
        cpSync(from, staged, { recursive: true, force: true });
        renameSync(staged, to);
        rmSync(from, { recursive: true, force: true });
      }
    },
    copyTree: (from, to) => cpSync(from, to, { recursive: true }),
    chmod: (path, mode) => chmodSync(path, mode),
  };
}

class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2 = 1) {
    super(message);
  }
}

function option(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new CliError(`${name} requires a value`, 2);
      return value;
    }
    if (args[i]?.startsWith(`${name}=`)) {
      const value = args[i]!.slice(name.length + 1);
      if (value === "") throw new CliError(`${name} requires a value`, 2);
      return value;
    }
  }
  return undefined;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (VALUE_OPTIONS.has(arg)) { i++; continue; }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

export function serviceUsage(): string {
  return [
    "Usage: wollipog service <command> [options]",
    "  service install [--user | --system] [--control-plane] [--runner] [--control-plane-bin <path>] [--runner-bin <path>]",
    "                  [--web-dist <dir>] [--host <bind>] [--port <n>] [--public-origin <https-origin>] [--tailnet-only]",
    "                  [--runner-id <id>] [--workspace <dir>] [--account <name>] [--no-start] [--no-linger] [--json]",
    "  service status [--user | --system] [--json]",
    "  service restart <control-plane | runner> [--user | --system] [--json]",
    "  service logs <control-plane | runner> [--user | --system] [--follow] [--lines <n>]",
    "  service uninstall [--user | --system] [--purge] [--yes] [--yes-purge] [--json]",
    "  service upgrade [--user | --system] [--release <vX.Y.Z>] [--force] [--yes] [--json]",
    "Linux systemd only. Without --control-plane/--runner, install sets up both (a colocated runner over loopback).",
    "Mode defaults to --system when run as root and --user otherwise; user services need lingering to survive logout.",
  ].join("\n");
}

export interface ServiceIo {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  confirm(question: string): Promise<boolean>;
}

function resolveMode(args: string[], host: ServiceHost): ServiceMode {
  const user = flag(args, "--user");
  const system = flag(args, "--system");
  if (user && system) throw new CliError("pass either --user or --system, not both", 2);
  if (system) return "system";
  if (user) return "user";
  return host.uid === 0 ? "system" : "user";
}

function systemctlArgs(mode: ServiceMode, args: string[]): string[] {
  return mode === "user" ? ["--user", ...args] : args;
}

async function systemctl(host: ServiceHost, mode: ServiceMode, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return host.exec("systemctl", systemctlArgs(mode, args), { timeoutMs: 120_000 });
}

async function requireSystemd(host: ServiceHost, mode: ServiceMode): Promise<void> {
  if (host.platform !== "linux") {
    throw new CliError(`wollipog service supports Linux systemd only; ${host.platform} is not supported yet (macOS launchd and Windows services are tracked separately)`, 2);
  }
  const probe = await host.exec("systemctl", systemctlArgs(mode, ["--version"]), { timeoutMs: 15_000 });
  if (probe.code !== 0) {
    throw new CliError(`systemctl is not available (${probe.stderr.trim() || `exit ${probe.code}`}); wollipog service requires systemd`, 2);
  }
  if (mode === "system" && host.uid !== 0) {
    throw new CliError("--system requires root (run with sudo) to write /etc/systemd/system and /var/lib/wollipog", 2);
  }
}

function layoutFor(args: string[], mode: ServiceMode, host: ServiceHost): ServiceLayout {
  const account = option(args, "--account");
  if (account !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/u.test(account)) throw new CliError("--account must be a valid Unix account name", 2);
  return serviceLayout(mode, { home: host.home, user: host.user, env: host.env, account, workspaceDir: option(args, "--workspace") });
}

async function unitState(host: ServiceHost, mode: ServiceMode, unit: string): Promise<UnitState> {
  const result = await systemctl(host, mode, ["show", "-p", SYSTEMCTL_SHOW_PROPERTIES.join(","), unit]);
  return parseSystemctlShow(unit, result.stdout);
}

async function probeHealth(host: ServiceHost, port: number): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await host.fetch(`http://127.0.0.1:${port}/healthz`, { method: "GET", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = JSON.parse(await response.text()) as { ok?: unknown; service?: unknown };
    return body.ok === true ? { ok: true, detail: String(body.service ?? "ok") } : { ok: false, detail: "unexpected health body" };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

async function waitFor(host: ServiceHost, timeoutMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = host.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (host.now() >= deadline) return false;
    await host.sleep(1_000);
  }
}

/** Coordinates the installed control plane actually runs with (preserved env wins over layout). */
interface Effective {
  port: number;
  db: string;
  localTokenFile: string;
  /** Owner of the protected credential file: the service account in system mode. */
  uid: number | null;
}

/** Run an `admin` command in-process against the installed control plane, capturing output. */
async function adminJson<T>(host: ServiceHost, effective: Effective, args: string[]): Promise<{ code: number; data: T | null; text: string }> {
  let stdout = "";
  let stderr = "";
  const io: HostAdminIo = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    stdoutIsTTY: false,
    stdinIsTTY: false,
    confirm: async () => false,
  };
  const env: NodeJS.ProcessEnv = {
    CONTROL_PLANE_DB: effective.db,
    CONTROL_PLANE_PORT: String(effective.port),
    CONTROL_PLANE_LOCAL_TOKEN_FILE: effective.localTokenFile,
  };
  const code = await runHostAdminCli(["admin", ...args, "--json"], env, io, host.fetch, {
    platform: host.platform,
    uid: effective.uid,
    cwd: () => host.cwd(),
  });
  let data: T | null = null;
  try { data = JSON.parse(stdout) as T; } catch { data = null; }
  return { code, data, text: stdout + stderr };
}

async function accountUid(host: ServiceHost, layout: ServiceLayout): Promise<number | null> {
  if (layout.mode !== "system") return host.uid;
  const result = await host.exec("id", ["-u", layout.account], { timeoutMs: 10_000 });
  const uid = Number(result.stdout.trim());
  // System mode always has a service account; without its uid the credential owner check would be
  // skipped, so root could consume a 0600 credential owned by an unexpected account. Fail closed.
  if (result.code !== 0 || !Number.isInteger(uid)) {
    throw new CliError(`could not resolve the uid of service account ${layout.account}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return uid;
}

/** Read the preserved env file (if any) so admin calls use the paths the service really runs with. */
function effectiveFromEnv(host: ServiceHost, layout: ServiceLayout, fallbackPort: number, uid: number | null): Effective {
  let db = layout.controlPlaneDb;
  let localTokenFile = layout.controlPlaneLocalTokenFile;
  let port = fallbackPort;
  if (host.exists(layout.controlPlaneEnvFile)) {
    const existing = parseEnvFile(host.readFile(layout.controlPlaneEnvFile));
    // The control plane resolves relative paths from its unit WorkingDirectory, not from wherever
    // the operator happens to run this command.
    const fromUnitCwd = (value: string) => resolve(layout.controlPlaneDataDir, value);
    if (existing.CONTROL_PLANE_DB) db = fromUnitCwd(existing.CONTROL_PLANE_DB);
    if (existing.CONTROL_PLANE_LOCAL_TOKEN_FILE) localTokenFile = fromUnitCwd(existing.CONTROL_PLANE_LOCAL_TOKEN_FILE);
    else if (existing.CONTROL_PLANE_DB) localTokenFile = `${db}.local-device-token`;
    const existingPort = Number(existing.CONTROL_PLANE_PORT);
    if (Number.isInteger(existingPort) && existingPort > 0) port = existingPort;
  }
  return { port, db, localTokenFile, uid };
}

function validatePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new CliError(`--port must be 1-65535, got ${raw}`, 2);
  return port;
}

function validatePublicOrigin(raw: string | undefined): { origin: string | null; warning: string | null } {
  if (raw === undefined) return { origin: null, warning: null };
  let url: URL;
  try { url = new URL(raw); } catch { throw new CliError(`--public-origin must be an absolute http(s) origin, got ${raw}`, 2); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CliError("--public-origin must use http or https", 2);
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new CliError("--public-origin must be a bare origin without path, query, fragment, or credentials", 2);
  }
  return {
    origin: url.origin,
    warning: url.protocol === "http:" && !LOOPBACK_HOST_RE.test(url.hostname)
      ? `${url.origin} is plain HTTP beyond loopback: pairing tokens and session data travel unencrypted. Put the dashboard behind Tailscale HTTPS or an HTTPS reverse proxy.`
      : null,
  };
}

function validateRunnerId(raw: string | undefined, fallback: string): string {
  const id = raw ?? fallback;
  if (!id || id.length > 128 || RUNNER_ID_REJECT_RE.test(id) || id === "." || id === "..") {
    throw new CliError("--runner-id must be 1-128 characters without whitespace, control characters, dot segments, or / \\ ? #", 2);
  }
  return id;
}

function resolveExecutable(label: "runner" | "control-plane", explicit: string | undefined, fallback: string | null, host: ServiceHost): string {
  const candidate = explicit ? resolve(host.cwd(), explicit) : fallback;
  if (!candidate) {
    throw new CliError(
      label === "runner"
        ? "pass --runner-bin <path>: the running executable is not a standalone wollipog-runner binary"
        : "pass --control-plane-bin <path>: no wollipog-control-plane executable was found beside this CLI (install one with `install-runner.sh --control-plane`)",
      2,
    );
  }
  if (!host.exists(candidate)) throw new CliError(`${label} executable not found: ${candidate}`, 2);
  return candidate;
}

/** A sibling executable published by the installer next to the standalone CLI. */
function siblingExecutable(host: ServiceHost, baseName: string): string | null {
  if (!host.isSea) return null;
  const name = basename(host.execPath);
  const exe = /\.exe$/iu.test(name) ? ".exe" : "";
  const sibling = join(dirname(host.execPath), `${baseName}${exe}`);
  return sibling !== host.execPath && host.exists(sibling) ? sibling : null;
}

function defaultRunnerExecutable(host: ServiceHost): string | null {
  if (host.isSea && /^wollipog-runner/iu.test(basename(host.execPath))) return host.execPath;
  return siblingExecutable(host, "wollipog-runner");
}

function defaultControlPlaneExecutable(host: ServiceHost): string | null {
  return siblingExecutable(host, "wollipog-control-plane");
}

/** The installer extracts the web bundle to `<bindir>/../share/wollipog/web`; a `web/` directory
 * beside the executable is the packaged layout the control plane also finds on its own. */
function defaultWebDist(host: ServiceHost, controlPlaneBin: string | null): string | null {
  if (!controlPlaneBin) return null;
  for (const candidate of [join(dirname(controlPlaneBin), "web"), resolve(dirname(controlPlaneBin), "..", "share", "wollipog", "web")]) {
    if (host.exists(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

interface InstallReport {
  mode: ServiceMode;
  account: string;
  components: ServiceComponent[];
  layout: ServiceLayout;
  units: string[];
  written: string[];
  preserved: string[];
  started: string[];
  health: { controlPlane: { ok: boolean; detail: string } | null; runnerOnline: boolean | null };
  lingering: "enabled" | "already" | "failed" | "skipped" | "not-applicable";
  warnings: string[];
}

async function install(args: string[], host: ServiceHost, io: ServiceIo, emit: (data: unknown, text: string) => void): Promise<number> {
  const mode = resolveMode(args, host);
  await requireSystemd(host, mode);
  const wantControlPlane = flag(args, "--control-plane") || !flag(args, "--runner");
  const wantRunner = flag(args, "--runner") || !flag(args, "--control-plane");
  const components: ServiceComponent[] = [...(wantControlPlane ? ["control-plane" as const] : []), ...(wantRunner ? ["runner" as const] : [])];
  const layout = layoutFor(args, mode, host);
  let port = validatePort(option(args, "--port"));
  let bindHost = option(args, "--host") ?? "127.0.0.1";
  const publicOrigin = validatePublicOrigin(option(args, "--public-origin"));
  const tailnetOnly = flag(args, "--tailnet-only");
  let runnerId = validateRunnerId(option(args, "--runner-id"), host.hostname);
  const warnings: string[] = [];
  if (publicOrigin.warning) warnings.push(publicOrigin.warning);
  // Existing settings win over flags and defaults: the env file and runner config are never
  // rewritten, so health checks and registration waits must use what the services actually run
  // with. A conflicting flag is reported rather than silently ignored.
  if (host.exists(layout.controlPlaneEnvFile)) {
    const existing = parseEnvFile(host.readFile(layout.controlPlaneEnvFile));
    const existingPort = Number(existing.CONTROL_PLANE_PORT);
    if (Number.isInteger(existingPort) && existingPort > 0) {
      if (option(args, "--port") !== undefined && existingPort !== port) warnings.push(`--port ${port} ignored: ${layout.controlPlaneEnvFile} already sets CONTROL_PLANE_PORT=${existingPort}; edit the file and restart to change it`);
      port = existingPort;
    }
    if (existing.CONTROL_PLANE_HOST) {
      if (option(args, "--host") !== undefined && existing.CONTROL_PLANE_HOST !== bindHost) warnings.push(`--host ${bindHost} ignored: ${layout.controlPlaneEnvFile} already sets CONTROL_PLANE_HOST=${existing.CONTROL_PLANE_HOST}`);
      bindHost = existing.CONTROL_PLANE_HOST;
    }
    for (const [name, value] of [["--public-origin", publicOrigin.origin], ["--web-dist", option(args, "--web-dist")]] as const) {
      if (value !== undefined && value !== null) warnings.push(`${name} ignored: ${layout.controlPlaneEnvFile} already exists; edit it and restart to change settings`);
    }
  }
  if (host.exists(layout.runnerConfigFile)) {
    try {
      const existing = JSON.parse(host.readFile(layout.runnerConfigFile)) as { runnerId?: unknown };
      if (typeof existing.runnerId === "string" && existing.runnerId) {
        if (option(args, "--runner-id") !== undefined && existing.runnerId !== runnerId) warnings.push(`--runner-id ${runnerId} ignored: ${layout.runnerConfigFile} already sets runnerId ${existing.runnerId}`);
        runnerId = existing.runnerId;
      }
    } catch (error) {
      throw new CliError(`existing ${layout.runnerConfigFile} is not valid JSON (${(error as Error).message}); fix or remove it before reinstalling`);
    }
  }
  if (!LOOPBACK_HOST_RE.test(bindHost) && !publicOrigin.origin?.startsWith("https://")) {
    warnings.push(`the control plane will listen on ${bindHost}:${port} over plain HTTP; remote browsers and the desktop app should reach it through Tailscale HTTPS or an HTTPS reverse proxy, and pairing links need --public-origin https://...`);
  }
  const controlPlaneBin = wantControlPlane ? resolveExecutable("control-plane", option(args, "--control-plane-bin"), defaultControlPlaneExecutable(host), host) : null;
  const runnerBin = wantRunner ? resolveExecutable("runner", option(args, "--runner-bin"), defaultRunnerExecutable(host), host) : null;
  const webDist = option(args, "--web-dist") ?? defaultWebDist(host, controlPlaneBin) ?? undefined;
  if (controlPlaneBin && option(args, "--control-plane-bin") === undefined && webDist === undefined && !host.exists(layout.controlPlaneEnvFile)) {
    // The installer's layout always carries a dashboard bundle; a control plane found by default but
    // without one would start API-only and serve 404 for the dashboard, which nobody asked for.
    throw new CliError(
      `no dashboard bundle found for ${controlPlaneBin} (looked for web/index.html in ${dirname(controlPlaneBin)} and ${resolve(dirname(controlPlaneBin), "..", "share", "wollipog", "web")}); ` +
      "reinstall with `install-runner.sh --control-plane`, or pass --web-dist <dir>", 2);
  }
  if (wantRunner && !wantControlPlane && !host.exists(layout.controlPlaneEnvFile) && !host.exists(layout.runnerTokenFile)) {
    // A colocated runner gets its credential from the local control plane. Without one here and
    // without a token already in place there is nothing to connect to.
    throw new CliError(
      `--runner alone needs a control plane installed on this host (${layout.controlPlaneEnvFile} not found) or an existing ${layout.runnerTokenFile}. ` +
        "Install both with `wollipog service install`, or for a remote control plane issue a credential there with `wollipog admin runner-credential issue --output`, place it at that token path, and set controlPlaneUrl in runner.config.json.",
      2,
    );
  }
  if (mode === "system") {
    const exists = await host.exec("id", ["-u", layout.account], { timeoutMs: 10_000 });
    if (exists.code !== 0) {
      const created = await host.exec("useradd", ["--system", "--home-dir", layout.dataDir, "--create-home", "--shell", "/usr/sbin/nologin", layout.account], { timeoutMs: 30_000 });
      if (created.code !== 0) throw new CliError(`could not create service account ${layout.account}: ${created.stderr.trim()}`);
    }
  }
  const serviceUid = await accountUid(host, layout);

  const written: string[] = [];
  const preserved: string[] = [];
  const dirs = [layout.dataDir, layout.configDir, layout.unitDir];
  if (wantControlPlane) dirs.push(layout.controlPlaneDataDir);
  if (wantRunner) dirs.push(layout.runnerDataDir, layout.workspaceDir);
  // Existing directories (notably a private home used as the workspace) keep their permissions;
  // only directories created here get a mode.
  const createdDirs: string[] = [];
  for (const dir of dirs) {
    if (host.ensureDir(dir, dir === layout.unitDir || dir === layout.workspaceDir ? 0o755 : 0o700)) createdDirs.push(dir);
  }

  const cpOptions = { executable: controlPlaneBin ?? "", host: bindHost, port, publicOrigin: publicOrigin.origin, tailnetOnly, webDist: webDist ? resolve(host.cwd(), webDist) : null };
  if (wantControlPlane) {
    // Settings and credentials survive reinstall: an existing env file is never rewritten, so
    // upgrading the unit definition cannot rotate the local credential or move the database.
    if (host.exists(layout.controlPlaneEnvFile)) preserved.push(layout.controlPlaneEnvFile);
    else { host.writeFile(layout.controlPlaneEnvFile, renderControlPlaneEnv(layout, cpOptions), 0o600); written.push(layout.controlPlaneEnvFile); }
    const unitPath = join(layout.unitDir, CONTROL_PLANE_UNIT);
    host.writeFile(unitPath, renderControlPlaneUnit(layout, cpOptions), 0o644);
    written.push(unitPath);
  }
  if (wantRunner) {
    if (host.exists(layout.runnerConfigFile)) preserved.push(layout.runnerConfigFile);
    else { host.writeFile(layout.runnerConfigFile, renderRunnerConfig(layout, { runnerId, port }), 0o600); written.push(layout.runnerConfigFile); }
    const unitPath = join(layout.unitDir, RUNNER_UNIT);
    host.writeFile(unitPath, renderRunnerUnit(layout, { executable: runnerBin! }), 0o644);
    written.push(unitPath);
  }
  if (mode === "system") {
    const owned = [layout.dataDir, layout.configDir, ...(createdDirs.includes(layout.workspaceDir) ? [layout.workspaceDir] : [])];
    const chown = await host.exec("chown", ["-R", `${layout.account}:${layout.account}`, ...owned], { timeoutMs: 60_000 });
    if (chown.code !== 0) warnings.push(`could not chown ${owned.join(", ")} to ${layout.account}: ${chown.stderr.trim()}`);
  }
  const effective = effectiveFromEnv(host, layout, port, serviceUid);

  const reload = await systemctl(host, mode, ["daemon-reload"]);
  if (reload.code !== 0) throw new CliError(`systemctl daemon-reload failed: ${reload.stderr.trim()}`);
  const noStart = flag(args, "--no-start");
  // With --no-start the runner credential cannot be minted (the control plane is not running), so
  // an enabled runner unit would only crash-loop at boot. It stays disabled until a token exists.
  const runnerDeferred = wantRunner && noStart && !host.exists(layout.runnerTokenFile);
  const units = components.map(unitFor);
  const toEnable = units.filter((unit) => !(runnerDeferred && unit === RUNNER_UNIT));
  if (toEnable.length > 0) {
    const enable = await systemctl(host, mode, ["enable", ...toEnable]);
    if (enable.code !== 0) throw new CliError(`systemctl enable failed: ${enable.stderr.trim()}`);
  }
  if (runnerDeferred) {
    // A previous install may have enabled the runner; a tokenless unit must not crash-loop at boot.
    const disable = await systemctl(host, mode, ["disable", RUNNER_UNIT]);
    const remedy = `Run \`wollipog service install\` again without --no-start, or issue a credential to ${layout.runnerTokenFile} and then \`systemctl${mode === "user" ? " --user" : ""} enable --now ${RUNNER_UNIT}\`.`;
    if (disable.code === 0) {
      warnings.push(`${RUNNER_UNIT} was written but left disabled: no ${layout.runnerTokenFile} exists yet and --no-start skips minting it. ${remedy}`);
    } else {
      // Say what actually happened: an earlier enablement may still start a tokenless runner at boot.
      warnings.push(`${RUNNER_UNIT} was written without a credential (no ${layout.runnerTokenFile}) and could NOT be disabled (${disable.stderr.trim() || `exit ${disable.code}`}); if it was enabled before, it will crash-loop at boot until a token exists. Disable it with \`systemctl${mode === "user" ? " --user" : ""} disable ${RUNNER_UNIT}\` or ${remedy}`);
    }
  }

  let lingering: InstallReport["lingering"] = "not-applicable";
  if (mode === "user" && flag(args, "--no-linger")) {
    lingering = "skipped";
    warnings.push(`lingering was not enabled (--no-linger); user services stop at logout until you run: loginctl enable-linger ${host.user}`);
  } else if (mode === "user") {
    const show = await host.exec("loginctl", ["show-user", host.user, "-p", "Linger", "--value"], { timeoutMs: 10_000 });
    if (show.code === 0 && show.stdout.trim() === "yes") lingering = "already";
    else {
      const linger = await host.exec("loginctl", ["enable-linger", host.user], { timeoutMs: 10_000 });
      lingering = linger.code === 0 ? "enabled" : "failed";
      if (linger.code !== 0) warnings.push(`could not enable lingering for ${host.user} (${linger.stderr.trim() || `exit ${linger.code}`}); user services stop at logout until an administrator runs: loginctl enable-linger ${host.user}`);
    }
  }

  const started: string[] = [];
  const health: InstallReport["health"] = { controlPlane: null, runnerOnline: null };
  if (!noStart) {
    if (wantControlPlane) {
      const start = await systemctl(host, mode, ["restart", CONTROL_PLANE_UNIT]);
      if (start.code !== 0) throw new CliError(`could not start ${CONTROL_PLANE_UNIT}: ${start.stderr.trim()}`);
      started.push(CONTROL_PLANE_UNIT);
      const healthy = await waitFor(host, 60_000, async () => (await probeHealth(host, port)).ok);
      health.controlPlane = await probeHealth(host, port);
      if (!healthy) {
        throw new CliError(`${CONTROL_PLANE_UNIT} did not become healthy on http://127.0.0.1:${port}/healthz within 60s (${health.controlPlane.detail}); inspect it with: wollipog service logs control-plane${mode === "system" ? " --system" : ""}`);
      }
    }
    if (wantRunner) {
      if (!host.exists(layout.runnerTokenFile)) {
        // First install of a colocated runner: mint its credential through the loopback admin
        // API using the control plane's own protected credential. An existing token file is never
        // replaced, so reinstalling does not rotate the runner credential.
        const issued = await adminJson<{ outputPath?: string; error?: string }>(host, effective, ["runner-credential", "issue", "--runner", runnerId, "--output", layout.runnerTokenFile]);
        if (issued.code !== 0) {
          throw new CliError(`could not issue the colocated runner credential: ${issued.data?.error ?? issued.text.trim()}; issue it manually with: wollipog admin runner-credential issue --runner ${runnerId} --output ${layout.runnerTokenFile}`);
        }
        written.push(layout.runnerTokenFile);
        if (mode === "system") await host.exec("chown", [`${layout.account}:${layout.account}`, layout.runnerTokenFile], { timeoutMs: 10_000 });
      } else {
        preserved.push(layout.runnerTokenFile);
      }
      const start = await systemctl(host, mode, ["restart", RUNNER_UNIT]);
      if (start.code !== 0) throw new CliError(`could not start ${RUNNER_UNIT}: ${start.stderr.trim()}`);
      started.push(RUNNER_UNIT);
      let lastStatusError: string | null = null;
      const online = await waitFor(host, 90_000, async () => {
        const status = await adminJson<{ runners?: { items?: Array<{ runnerId: string; status: string }> }; error?: string }>(host, effective, ["status"]);
        lastStatusError = status.code === 0 ? null : (status.data?.error ?? status.text.trim());
        return status.data?.runners?.items?.some((runner) => runner.runnerId === runnerId && runner.status === "online") === true;
      });
      health.runnerOnline = online;
      if (!online) {
        warnings.push(`${RUNNER_UNIT} started but runner ${runnerId} has not registered as online within 90s${lastStatusError ? ` (admin status failed: ${lastStatusError})` : ""}; inspect it with: wollipog service logs runner${mode === "system" ? " --system" : ""}`);
      }
    }
  }

  const report: InstallReport = { mode, account: layout.account, components, layout, units, written, preserved, started, health, lingering, warnings };
  for (const warning of warnings) io.stderr(`warning: ${warning}\n`);
  const lines = [
    `Installed Wollipog ${components.join(" + ")} as ${mode} systemd service${components.length > 1 ? "s" : ""} (${units.join(", ")}) for account ${layout.account}.`,
    `Data:    ${layout.dataDir}`,
    `Config:  ${layout.configDir}`,
    `Units:   ${layout.unitDir}`,
    ...(written.length ? [`Written: ${written.join(", ")}`] : []),
    ...(preserved.length ? [`Kept:    ${preserved.join(", ")} (existing settings and credentials are never rewritten)`] : []),
    ...(health.controlPlane ? [`Control plane: ${health.controlPlane.ok ? "healthy" : "NOT healthy"} on http://127.0.0.1:${port}`] : []),
    ...(health.runnerOnline !== null ? [`Runner:  ${runnerId} ${health.runnerOnline ? "online" : "not yet online"}`] : []),
    ...(mode === "user" ? [`Linger:  ${lingering === "failed" || lingering === "skipped" ? "NOT enabled" : "enabled"} (user services survive logout only with lingering)`] : []),
    `Next:    wollipog service status${mode === "system" ? " --system" : ""}; pair a browser with: wollipog admin device create --name <name>`,
  ];
  emit(report, lines.join("\n"));
  return 0;
}

async function status(args: string[], host: ServiceHost, emit: (data: unknown, text: string) => void): Promise<number> {
  const mode = resolveMode(args, host);
  await requireSystemd(host, mode);
  const layout = layoutFor(args, mode, host);
  const installed = readInstalledControlPlaneEnv({ home: host.home, env: host.env, platform: host.platform, uid: host.uid, mode });
  const port = installed?.port ?? DEFAULT_PORT;
  const units = await Promise.all([unitState(host, mode, CONTROL_PLANE_UNIT), unitState(host, mode, RUNNER_UNIT)]);
  const health = units[0]!.loadState === "loaded" ? await probeHealth(host, port) : null;
  let runners: Array<{ runnerId: string; status: string; version: string }> | null = null;
  if (health?.ok) {
    const effective = effectiveFromEnv(host, layout, port, await accountUid(host, layout));
    const admin = await adminJson<{ runners?: { items?: Array<{ runnerId: string; status: string; version: string }> } }>(host, effective, ["status"]);
    runners = admin.data?.runners?.items ?? null;
  }
  const data = { mode, cliVersion: VERSION, envFile: installed?.file ?? null, port, units, health, runners, layout: { dataDir: layout.dataDir, configDir: layout.configDir, unitDir: layout.unitDir } };
  const row = (u: UnitState) => `${u.unit.padEnd(32)} ${u.loadState.padEnd(10)} ${`${u.activeState}/${u.subState}`.padEnd(18)} ${u.unitFileState.padEnd(9)} ${u.mainPid !== null ? `pid ${u.mainPid}` : "-"}${u.restarts ? `  restarts ${u.restarts}` : ""}`;
  const lines = [
    `Mode:          ${mode}${installed ? ` (settings from ${installed.file})` : " (no installed control-plane.env found)"}`,
    `${"UNIT".padEnd(32)} ${"LOADED".padEnd(10)} ${"ACTIVE".padEnd(18)} ${"ENABLED".padEnd(9)} MAIN PID`,
    ...units.map(row),
    `Health:        ${health ? (health.ok ? `ok (${health.detail})` : `NOT healthy (${health.detail})`) : "not installed"} on http://127.0.0.1:${port}/healthz`,
    ...(runners ? [`Runners:       ${runners.length ? runners.map((r) => `${r.runnerId} ${r.status} ${r.version}`).join(", ") : "none registered"}`] : []),
    `Data / Config: ${layout.dataDir} / ${layout.configDir}`,
  ];
  emit(data, lines.join("\n"));
  const loaded = units.filter((u) => u.loadState === "loaded");
  // Nothing installed is not "healthy"; automation must see a non-zero exit.
  const ok = loaded.length > 0 && loaded.every((u) => u.activeState === "active") && (health === null || health.ok);
  return ok ? 0 : 1;
}

async function restart(args: string[], words: string[], host: ServiceHost, emit: (data: unknown, text: string) => void): Promise<number> {
  const component = parseComponent(words[2]);
  if (!component) throw new CliError("service restart requires <control-plane | runner>", 2);
  const mode = resolveMode(args, host);
  await requireSystemd(host, mode);
  const unit = unitFor(component);
  const result = await systemctl(host, mode, ["restart", unit]);
  if (result.code !== 0) throw new CliError(`systemctl restart ${unit} failed: ${result.stderr.trim()}`);
  const installed = readInstalledControlPlaneEnv({ home: host.home, env: host.env, platform: host.platform, uid: host.uid, mode });
  const port = installed?.port ?? DEFAULT_PORT;
  let health: { ok: boolean; detail: string } | null = null;
  if (component === "control-plane") {
    await waitFor(host, 60_000, async () => (await probeHealth(host, port)).ok);
    health = await probeHealth(host, port);
  }
  const state = await unitState(host, mode, unit);
  emit({ unit, state, health }, `restarted ${unit}: ${state.activeState}/${state.subState}${health ? `, health ${health.ok ? "ok" : `NOT ok (${health.detail})`}` : ""}`);
  return state.activeState === "active" && (health?.ok ?? true) ? 0 : 1;
}

async function logs(args: string[], words: string[], host: ServiceHost): Promise<number> {
  const component = parseComponent(words[2]);
  if (!component) throw new CliError("service logs requires <control-plane | runner>", 2);
  const mode = resolveMode(args, host);
  await requireSystemd(host, mode);
  const lines = option(args, "--lines");
  if (lines !== undefined && !/^\d{1,6}$/u.test(lines)) throw new CliError("--lines must be a number", 2);
  const journalArgs = [...(mode === "user" ? ["--user"] : []), "-u", unitFor(component), "-n", lines ?? "200", "--no-pager", ...(flag(args, "--follow") ? ["-f"] : [])];
  return host.spawnInherit("journalctl", journalArgs);
}

async function uninstall(args: string[], host: ServiceHost, io: ServiceIo, emit: (data: unknown, text: string) => void): Promise<number> {
  const mode = resolveMode(args, host);
  await requireSystemd(host, mode);
  const layout = layoutFor(args, mode, host);
  const purge = flag(args, "--purge");
  if (!flag(args, "--yes")) {
    if (!io.stdinIsTTY) throw new CliError("refusing to uninstall without confirmation; pass --yes in non-interactive use", 2);
    if (!(await io.confirm(`Stop and remove the Wollipog ${mode} services (${CONTROL_PLANE_UNIT}, ${RUNNER_UNIT})? Data and configuration are kept.`))) {
      emit({ uninstalled: false }, "nothing was changed");
      return 1;
    }
  }
  if (purge && !flag(args, "--yes-purge")) {
    if (!io.stdinIsTTY) throw new CliError("--purge deletes the database, artifacts, configuration, and credentials; pass --yes-purge in non-interactive use to acknowledge", 2);
    if (!(await io.confirm(`Also PERMANENTLY delete ${layout.dataDir} and ${layout.configDir} (database, artifacts, configuration, credentials)? This cannot be undone.`))) {
      emit({ uninstalled: false }, "nothing was changed");
      return 1;
    }
  }
  const removed: string[] = [];
  const units = [RUNNER_UNIT, CONTROL_PLANE_UNIT];
  const states = await Promise.all(units.map((unit) => unitState(host, mode, unit)));
  const present = units.filter((unit, index) => states[index]!.loadState === "loaded" || host.exists(join(layout.unitDir, unit)));
  if (present.length > 0) {
    // Stopping must succeed before anything is removed: deleting a unit file or purging data
    // underneath a still-running control plane would corrupt live state.
    const disable = await systemctl(host, mode, ["disable", "--now", ...present]);
    if (disable.code !== 0) throw new CliError(`systemctl disable --now ${present.join(" ")} failed: ${disable.stderr.trim() || `exit ${disable.code}`}; nothing was removed`);
  }
  for (const unit of units) {
    const path = join(layout.unitDir, unit);
    if (host.exists(path)) { host.removeFile(path); removed.push(path); }
  }
  await systemctl(host, mode, ["daemon-reload"]);
  if (present.length > 0) await systemctl(host, mode, ["reset-failed", ...present]);
  const preserved: string[] = [];
  if (purge) {
    for (const dir of [layout.dataDir, layout.configDir]) {
      if (host.exists(dir)) { host.removeTree(dir); removed.push(dir); }
    }
  } else {
    for (const dir of [layout.dataDir, layout.configDir]) if (host.exists(dir)) preserved.push(dir);
  }
  emit({ uninstalled: true, mode, removed, preserved, purged: purge },
    `Removed ${units.join(" and ")}${removed.length ? ` (${removed.join(", ")})` : ""}.` +
      (purge ? " Data and configuration were purged." : preserved.length ? ` Kept ${preserved.join(" and ")}; run again with --purge to delete them.` : ""));
  return 0;
}

/** Parse the executable path out of an installed unit's ExecStart (first quoted or bare word). */
export function executableFromUnit(unitText: string): string | null {
  const line = unitText.split(/\r?\n/u).find((entry) => entry.startsWith("ExecStart="));
  if (!line) return null;
  const value = line.slice("ExecStart=".length).trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"/u.exec(value);
  const word = quoted ? quoted[1]!.replace(/\\(.)/gu, "$1") : value.split(/\s+/u)[0] ?? "";
  return word ? word.replace(/%%/gu, "%").replace(/\$\$/gu, "$") : null;
}

interface UpgradeTarget {
  component: ServiceComponent;
  unit: string;
  path: string;
  assetName: string;
}

/**
 * `service upgrade`: download the release's executables and web bundle, prove their digests and
 * versions, swap them in while keeping the previous generation, restart, confirm health, and roll
 * back automatically when the new control plane does not become ready or the runner does not
 * re-register. Configuration, credentials, and data are never touched.
 */
async function upgrade(args: string[], host: ServiceHost, io: ServiceIo, emit: (data: unknown, text: string) => void): Promise<number> {
  const mode = resolveMode(args, host);
  await requireSystemd(host, mode);
  const layout = layoutFor(args, mode, host);
  const triple = hostTargetTriple(host.platform, host.arch);
  if (!triple) throw new CliError(`no release assets exist for ${host.platform}/${host.arch}`, 2);
  const targets: UpgradeTarget[] = [];
  for (const component of ["control-plane", "runner"] as const) {
    const unitPath = join(layout.unitDir, unitFor(component));
    if (!host.exists(unitPath)) continue;
    const executable = executableFromUnit(host.readFile(unitPath));
    if (!executable) throw new CliError(`${unitFor(component)} has no ExecStart; reinstall with \`wollipog service install\``);
    targets.push({ component, unit: unitFor(component), path: executable, assetName: component === "control-plane" ? controlPlaneAssetName(triple) : runnerAssetName(triple) });
  }
  if (targets.length === 0) throw new CliError(`no Wollipog units are installed in ${layout.unitDir}; run \`wollipog service install\` first`, 2);
  const serviceUid = await accountUid(host, layout);
  const effective = effectiveFromEnv(host, layout, DEFAULT_PORT, serviceUid);
  const envValues = host.exists(layout.controlPlaneEnvFile) ? parseEnvFile(host.readFile(layout.controlPlaneEnvFile)) : {};
  const webDist = envValues.WOLLIPOG_WEB_DIST ? resolve(layout.controlPlaneDataDir, envValues.WOLLIPOG_WEB_DIST) : null;
  const token = host.env.GH_TOKEN ?? host.env.GITHUB_TOKEN ?? null;

  const release = await resolveRelease(host.fetchJson, { tag: option(args, "--release") ?? null, token });
  const currentVersions = new Map<string, string | null>();
  for (const target of targets) {
    const probe = await host.exec(target.path, ["--version"], { timeoutMs: 30_000 });
    currentVersions.set(target.component, probe.code === 0 ? probe.stdout.trim().split(/\s+/u)[0] ?? null : null);
  }
  const alreadyCurrent = targets.every((target) => currentVersions.get(target.component) === release.version);
  if (alreadyCurrent && !flag(args, "--force")) {
    emit({ upgraded: false, release: release.tag, current: Object.fromEntries(currentVersions) }, `already at ${release.tag}; pass --force to reinstall the same release`);
    return 0;
  }
  if (!flag(args, "--yes")) {
    if (!io.stdinIsTTY) throw new CliError(`refusing to upgrade to ${release.tag} without confirmation; pass --yes in non-interactive use`, 2);
    const summary = targets.map((target) => `${target.component} ${currentVersions.get(target.component) ?? "unknown"} → ${release.version}`).join(", ");
    if (!(await io.confirm(`Upgrade ${summary}${webDist ? " and the web bundle" : ""} (services restart; the previous executables are kept for rollback)?`))) {
      emit({ upgraded: false }, "nothing was changed");
      return 1;
    }
  }

  // The installer publishes the CLI (`wollipog`) and the legacy name as hard links or copies of the
  // runner executable. Refresh every sibling that is byte-identical to the runner being replaced, so
  // the operator's `wollipog` command does not stay behind at the old version.
  const runnerTarget = targets.find((target) => target.component === "runner");
  const aliases: string[] = [];
  if (runnerTarget && host.exists(runnerTarget.path)) {
    const exe = /\.exe$/iu.test(runnerTarget.path) ? ".exe" : "";
    const currentDigest = await sha256File(runnerTarget.path);
    for (const name of ["wollipog", "agent-manager-runner"]) {
      const candidate = join(dirname(runnerTarget.path), `${name}${exe}`);
      if (candidate === runnerTarget.path || !host.exists(candidate)) continue;
      if ((await sha256File(candidate)) === currentDigest) aliases.push(candidate);
    }
  }

  // Stage every byte under the data directory before touching anything live.
  const staging = join(layout.dataDir, "upgrades", release.tag);
  host.removeTree(staging);
  host.ensureDir(join(layout.dataDir, "upgrades"), 0o700);
  host.ensureDir(staging, 0o700);
  const manifestAsset = release.assets.find((asset) => asset.name === CHECKSUM_MANIFEST_NAME);
  if (!manifestAsset) throw new CliError(`${release.tag} has no ${CHECKSUM_MANIFEST_NAME}; refusing to upgrade from a release that cannot be verified`);
  const manifestPath = join(staging, CHECKSUM_MANIFEST_NAME);
  await downloadVerifiedAsset(host.download, manifestAsset, manifestPath, { token });
  const manifest = parseChecksumManifest(host.readFile(manifestPath));
  const staged = new Map<string, string>();
  for (const target of targets) {
    const destination = join(staging, target.assetName);
    await downloadVerifiedAsset(host.download, findAsset(release, target.assetName), destination, { manifest, token });
    host.chmod(destination, 0o755);
    const probe = await host.exec(destination, ["--version"], { timeoutMs: 60_000 });
    const reported = probe.code === 0 ? probe.stdout.trim().split(/\s+/u)[0] ?? "" : "";
    if (reported !== release.version) {
      throw new CliError(`downloaded ${target.assetName} reports version "${reported}" (exit ${probe.code}) instead of ${release.version}; nothing was installed`);
    }
    staged.set(target.component, destination);
  }
  let stagedWeb: string | null = null;
  if (webDist) {
    // A control plane that serves the dashboard is upgraded together with its bundle or not at all.
    const webAsset = release.assets.find((asset) => asset.name === WEB_BUNDLE_ASSET_NAME);
    if (!webAsset) throw new CliError(`${release.tag} has no ${WEB_BUNDLE_ASSET_NAME}, but this control plane serves the dashboard from ${webDist}; nothing was installed`);
    const tarball = join(staging, WEB_BUNDLE_ASSET_NAME);
    await downloadVerifiedAsset(host.download, webAsset, tarball, { manifest, token });
    const extracted = await host.exec("tar", ["-xzf", tarball, "-C", staging], { timeoutMs: 120_000 });
    if (extracted.code !== 0 || !host.exists(join(staging, "web", "index.html"))) {
      throw new CliError(`could not extract ${WEB_BUNDLE_ASSET_NAME}: ${extracted.stderr.trim() || "no web/index.html in the archive"}; nothing was installed`);
    }
    stagedWeb = join(staging, "web");
  }

  const controlPlane = targets.find((target) => target.component === "control-plane");
  const runner = targets.find((target) => target.component === "runner");

  // Swap: keep exactly one previous generation of each executable and of the web bundle. Every path
  // is recorded before its first mutation, so a swap that fails midway is undone as well.
  const previous = (path: string) => `${path}.previous`;
  const swapped: Array<{ path: string; hadPrevious: boolean; movedAside: boolean; tree: boolean }> = [];
  const replace = (path: string, source: string, tree: boolean) => {
    const entry = { path, hadPrevious: host.exists(path), movedAside: false, tree };
    swapped.push(entry);
    if (tree) host.removeTree(previous(path)); else host.removeFile(previous(path));
    if (entry.hadPrevious) {
      host.move(path, previous(path));
      entry.movedAside = true;
    }
    host.move(source, path);
    if (!tree) host.chmod(path, 0o755);
  };
  const aliasPartial = (alias: string) => `${alias}.upgrade-${release.tag}`;
  const rollBack = async (reason: string): Promise<CliError> => {
    const problems: string[] = [];
    for (const entry of [...swapped].reverse()) {
      try {
        // A live generation that was never moved aside is still in place: leave it alone.
        if (entry.hadPrevious && !entry.movedAside) continue;
        if (entry.tree) host.removeTree(entry.path); else host.removeFile(entry.path);
        if (entry.movedAside && host.exists(previous(entry.path))) host.move(previous(entry.path), entry.path);
      } catch (error) {
        problems.push(`could not restore ${entry.path}: ${(error as Error).message}`);
      }
    }
    for (const alias of aliases) host.removeFile(aliasPartial(alias));
    for (const target of targets) {
      const restarted = await systemctl(host, mode, ["restart", target.unit]);
      if (restarted.code !== 0) problems.push(`could not restart ${target.unit}: ${restarted.stderr.trim()}`);
    }
    const healthy = controlPlane ? await waitFor(host, 60_000, async () => (await probeHealth(host, effective.port)).ok) : true;
    if (!healthy) problems.push("the control plane is still not healthy: inspect with `wollipog service logs control-plane`");
    return new CliError(`${reason}; rolled back to the previous executables${problems.length ? `, with problems: ${problems.join("; ")}` : controlPlane ? " (control plane healthy again)" : ""}`);
  };

  try {
    for (const target of targets) replace(target.path, staged.get(target.component)!, false);
    for (const alias of aliases) {
      host.removeFile(aliasPartial(alias));
      host.copyTree(runnerTarget!.path, aliasPartial(alias));
      replace(alias, aliasPartial(alias), false);
    }
    if (stagedWeb && webDist) replace(webDist, stagedWeb, true);
    if (mode === "system") {
      const owned = await host.exec("chown", ["-R", `${layout.account}:${layout.account}`, ...targets.map((target) => target.path), ...aliases, ...(stagedWeb && webDist ? [webDist] : [])], { timeoutMs: 60_000 });
      if (owned.code !== 0) throw new Error(`chown to ${layout.account} failed: ${owned.stderr.trim()}`);
    }
  } catch (error) {
    throw await rollBack(`installing the new executables failed (${(error as Error).message})`);
  }

  if (controlPlane) {
    const restart = await systemctl(host, mode, ["restart", controlPlane.unit]);
    if (restart.code !== 0) throw await rollBack(`could not restart ${controlPlane.unit}: ${restart.stderr.trim()}`);
    const healthy = await waitFor(host, 60_000, async () => (await probeHealth(host, effective.port)).ok);
    if (!healthy) throw await rollBack(`${controlPlane.unit} did not become healthy within 60s after the upgrade`);
    const status = await adminJson<{ appVersion?: string }>(host, effective, ["status"]);
    if (status.data?.appVersion !== release.version) {
      throw await rollBack(`the restarted control plane reports version ${status.data?.appVersion ?? "unknown"}, not ${release.version}`);
    }
  }
  if (runner) {
    const restart = await systemctl(host, mode, ["restart", runner.unit]);
    if (restart.code !== 0) throw await rollBack(`could not restart ${runner.unit}: ${restart.stderr.trim()}`);
    const runnerId = (() => { try { return (JSON.parse(host.readFile(layout.runnerConfigFile)) as { runnerId?: string }).runnerId ?? null; } catch { return null; } })();
    if (controlPlane && runnerId) {
      const online = await waitFor(host, 90_000, async () => {
        const status = await adminJson<{ runners?: { items?: Array<{ runnerId: string; status: string; version?: string }> } }>(host, effective, ["status"]);
        return status.data?.runners?.items?.some((item) => item.runnerId === runnerId && item.status === "online") === true;
      });
      if (!online) throw await rollBack(`runner ${runnerId} did not register as online within 90s after the upgrade`);
    } else {
      // A runner-only host reports to a remote control plane this command cannot query; the unit
      // staying active is the readiness signal here.
      const active = await waitFor(host, 30_000, async () => (await unitState(host, mode, runner.unit)).activeState === "active");
      if (!active) throw await rollBack(`${runner.unit} did not become active within 30s after the upgrade`);
    }
  }
  host.removeTree(staging);
  const report = {
    upgraded: true,
    release: release.tag,
    previous: Object.fromEntries(currentVersions),
    components: targets.map((target) => ({ component: target.component, path: target.path, previousKept: host.exists(previous(target.path)) ? previous(target.path) : null })),
    aliases,
    webDist: stagedWeb ? webDist : null,
  };
  emit(report, [
    `Upgraded to ${release.tag}: ${targets.map((target) => `${target.component} ${currentVersions.get(target.component) ?? "unknown"} → ${release.version}`).join(", ")}${aliases.length ? `, ${aliases.map((alias) => basename(alias)).join(" and ")} refreshed` : ""}${stagedWeb ? ", web bundle refreshed" : ""}.`,
    `Previous executables kept as ${targets.map((target) => previous(target.path)).join(" and ")}; the next upgrade replaces them.`,
    controlPlane ? `Control plane healthy${runner ? " and runner online." : "."}` : "Runner active.",
  ].join("\n"));
  return 0;
}

export function defaultServiceIo(): ServiceIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinIsTTY: process.stdin.isTTY === true,
    confirm: async (question) => {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    },
  };
}

export async function runServiceCli(
  args: string[],
  host: ServiceHost = defaultServiceHost(),
  io: ServiceIo = defaultServiceIo(),
): Promise<number> {
  const json = flag(args, "--json");
  const emit = (data: unknown, text: string) => io.stdout(json ? `${JSON.stringify(data)}\n` : `${text}\n`);
  try {
    const words = positional(args);
    switch (words[1]) {
      case "install": return await install(args, host, io, emit);
      case "status": return await status(args, host, emit);
      case "restart": return await restart(args, words, host, emit);
      case "logs": return await logs(args, words, host);
      case "uninstall": return await uninstall(args, host, io, emit);
      case "upgrade": return await upgrade(args, host, io, emit);
      default: throw new CliError(serviceUsage(), 2);
    }
  } catch (error) {
    const cli = error instanceof CliError ? error : new CliError((error as Error).message ?? String(error));
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: cli.message })}\n` : `${cli.message}\n`);
    return cli.exitCode;
  }
}
