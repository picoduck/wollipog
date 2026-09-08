/**
 * `wollipog admin`: host administration for an SSH operator on the control-plane machine.
 *
 * Every server-backed command authenticates with the protected local bootstrap credential file
 * over a direct loopback connection, which the control plane already treats as local owner
 * access. The CLI therefore fails closed before any request when the target URL is not loopback,
 * when the credential file is a symlink, group/other readable, or foreign-owned, or when the
 * control plane predates the host-administration protocol. One-time secrets are shown only on an
 * interactive terminal or written atomically to an explicitly requested 0600 file; they never
 * appear in process arguments or ordinary logs.
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type DeviceView,
  type HostAdminCheck,
  type HostAdminDoctorView,
  type HostAdminStatusView,
  type IdentityAdministrationView,
  type RunnerCredentialSecret,
  type RunnerCredentialView,
} from "@wollipog/protocol";
import { homedir, userInfo } from "node:os";
import { readFileSync as readTextFileSync } from "node:fs";
import { execCapture, type ExecResult } from "./exec-capture.js";
import type { McpFetch } from "./session-management-mcp.js";
import {
  CONTROL_PLANE_UNIT,
  RUNNER_UNIT,
  SYSTEMCTL_SHOW_PROPERTIES,
  parseSystemctlShow,
  readInstalledControlPlaneEnv,
  serviceLayout,
} from "./systemd-service.js";
import { VERSION } from "./version.js";

export const LOCAL_TOKEN_FILE_ENV = "CONTROL_PLANE_LOCAL_TOKEN_FILE";
export const LOCAL_TOKEN_SUFFIX = ".local-device-token";
const DEFAULT_DB_PATH = "data/control-plane.db";
const DEFAULT_PORT = 4317;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;
const PAIR_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/u;
const VALUE_OPTIONS = new Set(["--url", "--token-file", "--name", "--user", "--origin", "--output", "--runner", "--label"]);
// Current `wollipogr_` and legacy `mamr_` producers both emit exactly 43 base64url characters.
const RUNNER_TOKEN_RE = /^(?:wollipogr_|mamr_)[A-Za-z0-9_-]{43}$/u;

export interface HostAdminIo {
  stdout(text: string): void;
  stderr(text: string): void;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  /** Interactive yes/no prompt; only called when stdin is a terminal. */
  confirm(question: string): Promise<boolean>;
}

export interface HostAdminHost {
  platform: NodeJS.Platform;
  uid: number | null;
  cwd(): string;
  /** Coordinates recorded by `wollipog service install`, when such a deployment exists. */
  installedControlPlaneEnv?(): { file?: string; db?: string; port?: number; localTokenFile?: string } | null;
  /** Doctor inputs for the local (client-side) checks; absent means those checks are skipped. */
  home?: string;
  user?: string;
  env?: NodeJS.ProcessEnv;
  exec?(command: string, args: string[], options?: { timeoutMs?: number }): Promise<ExecResult>;
}

export const DEFAULT_HOST: HostAdminHost = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  cwd: () => process.cwd(),
  installedControlPlaneEnv: () => readInstalledControlPlaneEnv({
    home: homedir(),
    env: process.env,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  }),
  home: homedir(),
  user: (() => { try { return userInfo().username; } catch { return process.env.USER ?? ""; } })(),
  env: process.env,
  exec: execCapture,
};

export function defaultHostAdminIo(): HostAdminIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdoutIsTTY: process.stdout.isTTY === true,
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

class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 2 = 1) {
    super(message);
  }
}

/**
 * `--name value` or `--name=value`. An option that is present but followed by another option
 * (`--runner --yes`, `--output --json`) or by nothing has an omitted value: that is a usage error,
 * never "absent", so an optional option can never silently fall back to its default. Only the `=`
 * form can supply a value that starts with `--`.
 */
function option(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new CliError(`${name} requires a value`, 2);
      return value;
    }
    if (args[i]?.startsWith(`${name}=`)) {
      const value = args[i]!.slice(name.length + 1);
      // `--output="$OUT"` with OUT unset must not silently become "no --output".
      if (value === "") throw new CliError(`${name} requires a value`, 2);
      return value;
    }
  }
  return undefined;
}

/** Single-quote a value for copy-paste into a POSIX shell; runner ids may contain metacharacters. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
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

export function hostAdminUsage(): string {
  return [
    "Usage: wollipog admin <command> [options]",
    "  admin pairing-url [--json]",
    "  admin status [--json]",
    "  admin doctor [--json]",
    "  admin user list [--json]",
    "  admin device list [--json]",
    "  admin device create --name <name> [--user <user-id>] [--origin <public-origin>] [--output <file>] [--json]",
    "  admin device revoke <device-id> [--yes] [--json]",
    "  admin runner-credential list [--json]",
    "  admin runner-credential issue --runner <runner-id> [--label <label>] [--output <token-file>] [--json]",
    "  admin runner-credential rotate --runner <runner-id> [--label <label>] [--output <token-file>] [--json]",
    "  admin runner-credential revoke --runner <runner-id> [--yes] [--json]",
    "Options: --url <http://127.0.0.1:4317>, --token-file <path to the protected local credential>",
    `Credential lookup: --token-file, ${LOCAL_TOKEN_FILE_ENV}, CONTROL_PLANE_DB${LOCAL_TOKEN_SUFFIX}, then ${DEFAULT_DB_PATH}${LOCAL_TOKEN_SUFFIX}.`,
    "Runs only on the control-plane host over loopback; one-time secrets print only to a terminal or --output.",
  ].join("\n");
}

/** Where the control plane keeps its protected bootstrap credential, mirroring its own defaults. */
export function resolveLocalTokenPath(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  installed: { db?: string; localTokenFile?: string } | null = null,
): string {
  const explicit = option(args, "--token-file") ?? env[LOCAL_TOKEN_FILE_ENV]?.trim();
  if (explicit) return resolve(cwd, explicit);
  const fromEnv = env.CONTROL_PLANE_DB?.trim();
  if (fromEnv) return `${resolve(cwd, fromEnv)}${LOCAL_TOKEN_SUFFIX}`;
  // A `wollipog service install` deployment records its coordinates in control-plane.env, so the
  // operator does not have to export anything after an SSH login.
  if (installed?.localTokenFile) return resolve(installed.localTokenFile);
  if (installed?.db) return `${resolve(installed.db)}${LOCAL_TOKEN_SUFFIX}`;
  return `${resolve(cwd, DEFAULT_DB_PATH)}${LOCAL_TOKEN_SUFFIX}`;
}

/**
 * Only literal loopback targets. DNS names are refused even when they look local (`127.evil.example`,
 * `foo.localhost`) because the bootstrap credential would be sent to whatever they resolve to.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "").replace(/%.*$/u, "");
  if (h === "localhost" || h === "::1") return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(h);
  return v4 !== null && v4.slice(1).every((octet) => Number(octet) <= 255);
}

/** Literal Tailscale IPv4 (100.64.0.0/10), the only non-loopback host the desktop app accepts over plain HTTP. */
export function isTailnetIpv4Literal(hostname: string): boolean {
  const v4 = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname.trim());
  if (!v4) return false;
  const second = Number(v4[1]);
  return second >= 64 && second <= 127 && v4.slice(2).every((octet) => Number(octet) <= 255);
}

/**
 * Which advertised consumers can open a pairing link. A browser needs the control plane to serve
 * the dashboard bundle. The desktop app's Add Remote Instance dialog accepts plain HTTP only for
 * loopback or a literal Tailscale address (apps/web/src/instance-pairing.ts); everything else must
 * be HTTPS. A link usable by neither must never be handed out as a success.
 */
export function pairingLinkConsumers(origin: string, webServed: boolean): { browser: boolean; desktop: boolean } {
  const url = new URL(origin);
  const desktop = url.protocol === "https:" || isDesktopCleartextHost(url.hostname);
  return { browser: webServed, desktop };
}

/**
 * Hosts the desktop app accepts over plain HTTP (apps/web/src/instance-pairing.ts
 * `cleartextHostPolicy`): `localhost`, any `*.localhost` name, `[::1]`, 127/8, and literal
 * Tailscale addresses. Wider than `isLoopbackHostname` on purpose: that predicate decides where
 * the bootstrap credential is sent and must stay literal-only, while this one only classifies who
 * can open an already-minted link.
 */
export function isDesktopCleartextHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/u, "");
  return host === "localhost" || host.endsWith(".localhost") || isLoopbackHostname(host) || isTailnetIpv4Literal(host);
}

/** The loopback control-plane origin; anything else fails closed because the bootstrap credential is loopback-only. */
export function resolveLoopbackUrl(
  args: string[],
  env: NodeJS.ProcessEnv,
  installed: { port?: number } | null = null,
): { url: string; port: number } {
  const raw = option(args, "--url") ?? `http://127.0.0.1:${env.CONTROL_PLANE_PORT?.trim() || installed?.port || DEFAULT_PORT}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`--url must be an absolute http URL, got ${raw}`, 2);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`--url must use http or https, got ${url.protocol.replace(/:$/u, "")}`, 2);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new CliError(
      `host administration runs only on the control-plane host over loopback; ${url.origin} is not a loopback address. ` +
        "Open an SSH session on that machine instead of administering it remotely.",
      2,
    );
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { url: url.origin, port };
}

/**
 * Read the protected credential without following symlinks and refuse anything a service account
 * would not have produced: non-regular files, symlinks, group/other-accessible modes, or files
 * owned by another account. A leak-prone file must not become a working owner credential.
 */
export function readProtectedLocalToken(path: string, host: HostAdminHost = DEFAULT_HOST): string {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(code === "ENOENT"
      ? `local credential file not found at ${path}; start the control plane once with the same coordinates, or pass --token-file`
      : `could not inspect local credential file ${path}: ${(error as Error).message}`);
  }
  if (before.isSymbolicLink()) throw new CliError(`refusing local credential file ${path}: it is a symbolic link`);
  if (!before.isFile()) throw new CliError(`refusing local credential file ${path}: it is not a regular file`);
  if (host.platform !== "win32") {
    const mode = before.mode & 0o777;
    if (mode & 0o077) {
      throw new CliError(`refusing local credential file ${path}: mode 0${mode.toString(8)} grants group or other access; expected 0600`);
    }
    if (host.uid !== null && before.uid !== host.uid) {
      throw new CliError(`refusing local credential file ${path}: owned by uid ${before.uid}, not the current account (uid ${host.uid})`);
    }
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new CliError(`refusing local credential file ${path}: it changed while opening`);
    }
    const raw = readFileSync(fd, "utf8");
    const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!TOKEN_RE.test(token)) throw new CliError(`local credential file ${path} has invalid contents`);
    return token;
  } finally {
    closeSync(fd);
  }
}

export interface SecretFileHost {
  link(staged: string, live: string): void;
  write(fd: number, contents: string): void;
}

const DEFAULT_SECRET_FILE_HOST: SecretFileHost = {
  link: linkSync,
  write: (fd, contents) => writeFileSync(fd, contents, "utf8"),
};

/** True when something already occupies the path (a file, directory, or dangling symlink). */
export function pathOccupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Create a new 0600 file holding a one-time secret. A same-directory staged file plus a no-replace
 * hard link publishes the complete contents atomically; an existing path is never overwritten. On
 * filesystems without hard links the fallback is an exclusive create that still never replaces an
 * existing file, and a failed write removes the partial file instead of leaving it behind.
 * Contract: if this throws, nothing was published at `path`; once the live file exists the call
 * returns normally even if removing the staged hard link fails (both are the same 0600 inode).
 */
export function writeProtectedSecretFile(
  path: string,
  contents: string,
  fsHost: SecretFileHost = DEFAULT_SECRET_FILE_HOST,
): void {
  const live = resolve(path);
  const staged = `${live}.pending-${process.pid}-${randomUUID()}`;
  let fd: number | null = null;
  try {
    try {
      fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      throw new CliError(`could not create ${live} in ${dirname(live)}: ${(error as Error).message}`);
    }
    fsHost.write(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      fsHost.link(staged, live);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new CliError(`refusing to overwrite existing output file ${live}`);
      // Filesystems without hard links: an exclusive create still never replaces an existing file.
      let liveFd: number | null = null;
      let createdLive = false;
      let published = false;
      try {
        liveFd = openSync(live, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        createdLive = true;
        fsHost.write(liveFd, contents);
        fsyncSync(liveFd);
        const closing = liveFd;
        liveFd = null;
        closeSync(closing);
        // Only a fully written, synced, and closed file counts as published; a close failure above
        // still removes the file so a throw from this helper never leaves a delivered secret behind.
        published = true;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new CliError(`refusing to overwrite existing output file ${live}`);
        }
        throw new CliError(`could not write ${live}: ${(fallbackError as Error).message}`);
      } finally {
        // Cleanup must never replace the real error with a second one from an already-failed fd.
        if (liveFd !== null) try { closeSync(liveFd); } catch { /* already closed or failed */ }
        if (createdLive && !published) rmSync(live, { force: true });
      }
    }
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed or failed */ }
    try {
      rmSync(staged, { force: true });
    } catch {
      /* The live file is already published; a leftover staged link is the same protected inode. */
    }
  }
}

interface Client {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

async function readBody(response: { status: number; text(): Promise<string> }): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
}

function makeClient(fetchImpl: McpFetch, cpUrl: string, token: string): Client {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Awaited<ReturnType<McpFetch>>;
    try {
      response = await fetchImpl(`${cpUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new CliError(`control plane at ${cpUrl} is unreachable: ${(error as Error).message}. Is the control-plane service running?`);
    }
    const data = await readBody(response);
    if (!response.ok) {
      const detail = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${response.status}`;
      throw new CliError(`${method} ${path} failed: ${detail}`);
    }
    return data as T;
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    del: async (path) => { await request("DELETE", path); },
  };
}

async function ensureCompatible(client: Client, cpUrl: string): Promise<void> {
  const body = await client.get<{ protocolVersion?: unknown }>("/api/compatibility");
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdministration;
  if (typeof body.protocolVersion !== "number" || body.protocolVersion < required) {
    throw new CliError(
      `control plane at ${cpUrl} speaks protocol v${String(body.protocolVersion ?? "unknown")}; ` +
        `wollipog admin ${VERSION} requires v${required} or newer. Upgrade the control plane or use a matching CLI.`,
    );
  }
}

function validateOrigin(value: string): { origin: string; warning: string | null } {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError(`--origin must be an absolute http(s) origin, got ${value}`, 2); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CliError(`--origin must use http or https, got ${value}`, 2);
  if (url.username || url.password) throw new CliError("--origin must not embed credentials", 2);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new CliError("--origin must be a bare origin without path, query, or fragment", 2);
  }
  return {
    origin: url.origin,
    warning: url.protocol === "http:" && !isLoopbackHostname(url.hostname)
      ? `${url.origin} uses plain HTTP beyond loopback; the pairing token and session data travel unencrypted. Prefer HTTPS or a Tailscale HTTPS origin.`
      : null,
  };
}

function formatWhen(value: number | null): string {
  return value === null ? "never" : new Date(value).toISOString();
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export function formatStatus(status: HostAdminStatusView): string {
  const lines = [
    `Control Plane     ${status.service} ${status.appVersion} (protocol v${status.protocolVersion}, api v${status.apiVersion})`,
    `Health            ${status.health.ok ? "ok" : "unhealthy"}, up ${formatDuration(status.health.uptimeMs)}`,
    `Bind              ${status.bind.host}:${status.bind.port} (${status.bind.mode}${status.bind.tailnetOnly ? ", tailnet only" : ""})`,
    `Public Origin     ${status.publicOrigin ?? "(not configured; set CONTROL_PLANE_PUBLIC_ORIGIN)"}`,
    `Dashboard         ${status.dashboard.webServed ? "web bundle served" : "web bundle not served"}` +
      (status.dashboard.pairingHosts.length ? ` via ${status.dashboard.pairingHosts.join(", ")}` : ""),
    `Database          ${status.database.ready ? "ready" : "NOT READY"}  ${status.database.path}`,
    `Artifact Store    ${status.artifactStore.ready ? "ready" : "NOT READY"}  ${status.artifactStore.path}`,
    `Local Credential  ${status.localCredential.safe ? "safe" : "UNSAFE"}  ${status.localCredential.path}`,
    ...status.localCredential.issues.map((issue) => `  ! ${issue}`),
    `Runners           ${status.runners.registered} registered, ${status.runners.online} online`,
    ...status.runners.items.map((runner) =>
      `  ${runner.runnerId}  ${runner.status}  ${runner.version}  ${runner.protocolVersion === null ? "protocol unknown" : `v${runner.protocolVersion}`}`),
    `Devices           ${status.devices.paired} paired`,
  ];
  lines.push(status.warnings.length ? "Warnings" : "Warnings          none");
  lines.push(...status.warnings.map((warning) => `  - ${warning}`));
  return lines.join("\n");
}

/**
 * A minted device whose one-time secret could not be delivered must not stay active. Returns the
 * error to throw: the original failure plus what happened to the device.
 */
async function abandonMintedDevice(client: Client, deviceId: string | undefined, failure: Error): Promise<CliError> {
  const detail = failure.message;
  const exitCode = failure instanceof CliError ? failure.exitCode : 1;
  if (!deviceId) return new CliError(`${detail}; the control plane response named no device to revoke`, exitCode);
  try {
    await client.del(`/api/devices/${encodeURIComponent(deviceId)}`);
    return new CliError(`${detail}; the newly minted device ${deviceId} was revoked`, exitCode);
  } catch (revokeError) {
    return new CliError(
      `${detail}; the newly minted device ${deviceId} could not be revoked (${(revokeError as Error).message}); run: wollipog admin device revoke ${deviceId} --yes`,
      exitCode,
    );
  }
}

function formatCredentialStatus(credential: RunnerCredentialView): string {
  return credential.legacy ? `${credential.status} (legacy)` : credential.status;
}

/**
 * `admin runner-credential list|issue|rotate|revoke`, reusing the owner/admin routes with their
 * existing activation and cutover semantics: an issued or rotated credential is pending until the
 * runner's first registration with that exact id; rotation keeps the current credential active
 * until the replacement registers; revoke closes the runner socket immediately.
 */
async function runnerCredentialCommand(
  args: string[],
  words: string[],
  client: Client,
  io: HostAdminIo,
  host: HostAdminHost,
  emit: (data: unknown, text: string) => void,
): Promise<number> {
  const verb = words[2];
  if (verb === "list") {
    const { credentials } = await client.get<{ credentials: RunnerCredentialView[] }>("/api/runner-credentials");
    emit({ credentials }, credentials.length
      ? table([["RUNNER ID", "CREDENTIAL", "STATUS", "LABEL", "CREATED", "ACTIVATED", "LAST USED", "EXPIRES"],
        ...credentials.map((credential) => [
          credential.runnerId, credential.credentialId, formatCredentialStatus(credential), credential.label,
          formatWhen(credential.createdAt), formatWhen(credential.activatedAt), formatWhen(credential.lastUsedAt), formatWhen(credential.expiresAt),
        ])])
      : "no runner credentials");
    return 0;
  }
  // The raw value is validated, never normalized: trimming "prod " into "prod" would silently
  // retarget a destructive command at a different runner (server-side normalization also rejects it).
  const runnerId = option(args, "--runner");
  if (verb !== "issue" && verb !== "rotate" && verb !== "revoke") throw new CliError(hostAdminUsage(), 2);
  if (runnerId === undefined || runnerId === "") throw new CliError(`admin runner-credential ${verb} requires --runner <runner-id>`, 2);
  // Mirrors the runner's own attestation rules: dot segments would also be rewritten by URL
  // canonicalization (`/api/runner-credentials/../rotate`), so they must never reach a request.
  if (/[\u0000-\u0020\u007f/\\?#]/u.test(runnerId) || runnerId.length > 128 || runnerId === "." || runnerId === "..") {
    throw new CliError("--runner must be an exact runner id without whitespace, control characters, dot segments, or / \\ ? #", 2);
  }
  const encodedRunner = encodeURIComponent(runnerId);

  if (verb === "revoke") {
    if (!flag(args, "--yes")) {
      if (!io.stdinIsTTY) throw new CliError(`refusing to revoke the credential of runner ${runnerId} without confirmation; pass --yes in non-interactive use`, 2);
      if (!(await io.confirm(`Revoke the active and pending credentials of runner ${runnerId}? Its connection closes immediately and it cannot reconnect until a new credential is issued.`))) {
        emit({ revoked: false, runnerId }, `credential of runner ${runnerId} was not revoked`);
        return 1;
      }
    }
    await client.del(`/api/runner-credentials/${encodedRunner}`);
    emit({ revoked: true, runnerId }, `revoked the credentials of runner ${runnerId}; its socket was closed and it needs a newly issued credential to reconnect`);
    return 0;
  }

  const output = option(args, "--output");
  if (!output && !io.stdoutIsTTY) {
    throw new CliError("refusing to print a one-time runner credential to a non-interactive stdout; pass --output <token-file> to write it to a new 0600 file", 2);
  }
  const outputPath = output ? resolve(host.cwd(), output) : null;
  if (outputPath && pathOccupied(outputPath)) throw new CliError(`refusing to overwrite existing output file ${outputPath}`);
  const label = option(args, "--label")?.trim();
  const body = label ? { label } : {};
  const secret = verb === "issue"
    ? await client.post<RunnerCredentialSecret>("/api/runner-credentials", { runnerId, ...body })
    : await client.post<RunnerCredentialSecret>(`/api/runner-credentials/${encodedRunner}/rotate`, body);
  let delivered = false;
  let deliveryAttempted = false;
  try {
    if (typeof secret.credential?.credentialId !== "string") throw new CliError("control plane returned no credential record");
    if (typeof secret.token !== "string" || !RUNNER_TOKEN_RE.test(secret.token)) throw new CliError("control plane returned an unusable runner token");
    const summary = { credential: secret.credential, runnerId, operation: verb };
    const heading = verb === "issue"
      ? `Issued a pending credential ${secret.credential.credentialId} for runner ${runnerId}; it activates on the runner's first registration and expires if unused for 24 hours.\n`
      : `Rotated runner ${runnerId}: pending credential ${secret.credential.credentialId} replaces the current one when the runner registers with it; the current credential stays active until then.\n`;
    const usage = "Start the runner with --token-file <file> or RUNNER_TOKEN_FILE; the token never belongs in argv, unit files, or logs.";
    if (outputPath) {
      // The helper either publishes the complete file or throws having published nothing.
      writeProtectedSecretFile(outputPath, `${secret.token}\n`);
      delivered = true;
      emit({ ...summary, outputPath }, `${heading}Token written once to ${outputPath} (mode 0600). ${usage}`);
    } else {
      deliveryAttempted = true;
      emit({ ...summary, token: secret.token }, `${heading}This token is shown once. ${usage}\n${secret.token}`);
      delivered = true;
    }
    return 0;
  } catch (error) {
    if (delivered) throw error;
    // A pending runner credential nobody holds is inert: it expires unused in 24 hours and issuing
    // or rotating again supersedes it. It is deliberately not revoked: a revoke also closes the
    // runner socket, which after a failed `issue` for a legacy runner without a credential (or a
    // failed `rotate` with a still-active credential) would disconnect a working runner. A failure
    // after output began is different: the plaintext may have reached the terminal or file, so the
    // operator is told the credential stays usable and how to supersede or revoke it.
    const detail = (error as Error).message;
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    if (deliveryAttempted) {
      throw new CliError(
        `${detail}; the token for runner ${runnerId} may have been partially delivered and the pending credential ${secret.credential.credentialId} stays usable until it expires in 24 hours: ` +
          `run the ${verb} command again to supersede it, or revoke it with: wollipog admin runner-credential revoke --runner ${shellQuote(runnerId)} --yes`,
        exitCode,
      );
    }
    throw new CliError(`${detail}; the pending credential for runner ${runnerId} was not delivered, expires unused in 24 hours, and is replaced by running the ${verb} command again`, exitCode);
  }
}

/** Non-reading safety audit of a protected file: type, symlink, mode, and owner. */
export function auditProtectedFile(path: string, host: HostAdminHost): { exists: boolean; issues: string[] } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return { exists: false, issues: (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [`could not inspect: ${(error as Error).message}`] };
  }
  const issues: string[] = [];
  if (stat.isSymbolicLink()) issues.push("is a symbolic link");
  else if (!stat.isFile()) issues.push("is not a regular file");
  if (host.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode & 0o077) issues.push(`mode 0${mode.toString(8)} grants group or other access; expected 0600`);
    if (host.uid !== null && stat.uid !== host.uid) issues.push(`owned by uid ${stat.uid}, not the current account (uid ${host.uid})`);
  }
  return { exists: true, issues };
}

function mark(status: HostAdminCheck["status"]): string {
  return status === "pass" ? "ok  " : status === "warn" ? "warn" : "FAIL";
}

/** Terminal output never carries control characters, whatever a remote peer put in a message. */
function printable(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "?").replace(/\r?\n/gu, " ");
}

export function formatChecks(checks: HostAdminCheck[]): string {
  const lines = checks.map((item) => {
    const head = `${mark(item.status)}  ${printable(item.id).padEnd(28)} ${printable(item.summary)}`;
    const extra = [item.detail ? `        detail: ${printable(item.detail)}` : null, item.remedy ? `        remedy: ${printable(item.remedy)}` : null].filter(Boolean);
    return [head, ...extra].join("\n");
  });
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const item of checks) counts[item.status] += 1;
  lines.push(`${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);
  return lines.join("\n");
}

/**
 * `admin doctor`: local checks first (they need no running control plane), then the control
 * plane's own doctor route. Exit 1 when any check fails; warnings alone exit 0.
 */
async function doctorCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: HostAdminIo,
  fetchImpl: McpFetch,
  host: HostAdminHost,
  installed: { file?: string; db?: string; port?: number; localTokenFile?: string } | null,
  target: { url: string; port: number },
  tokenPath: string,
  emit: (data: unknown, text: string | (() => string)) => void,
): Promise<number> {
  const checks: HostAdminCheck[] = [];
  const add = (id: string, status: HostAdminCheck["status"], summary: string, extra: { detail?: string; remedy?: string } = {}) =>
    checks.push({ id, status, summary, ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.remedy ? { remedy: extra.remedy } : {}) });

  add("cli", "pass", `wollipog CLI ${VERSION} (protocol v${RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdminDoctor}+ required for doctor)`);

  // Installed systemd deployment (Linux only, only when `wollipog service install` left its env file).
  // In system mode the service account owns the credential files, so owner checks (including the
  // control plane's own credential below) expect that account's uid, exactly as `wollipog service` does.
  let expectedOwner = host.uid;
  if (host.platform === "linux" && installed?.file && host.exec && host.home !== undefined) {
    const mode = installed.file.startsWith("/etc/") ? "system" : "user";
    const layout = serviceLayout(mode, { home: host.home, user: host.user ?? "", env: host.env ?? {} });
    if (mode === "system") {
      const unitPath = `${layout.unitDir}/${CONTROL_PLANE_UNIT}`;
      let account = layout.account;
      try {
        const match = /^User=([A-Za-z_][A-Za-z0-9_-]{0,31})$/mu.exec(readTextFileSync(unitPath, "utf8"));
        if (match) account = match[1]!;
      } catch {
        /* unit missing or unreadable: fall back to the default account */
      }
      const result = await host.exec("id", ["-u", account], { timeoutMs: 10_000 });
      const uid = Number(result.stdout.trim());
      if (result.code === 0 && Number.isInteger(uid)) expectedOwner = uid;
      else add("service-account", "fail", `could not resolve the uid of service account ${account}`, { detail: result.stderr.trim() || `exit ${result.code}`, remedy: "recreate the account or reinstall with `wollipog service install --system`" });
    }
    for (const unit of [CONTROL_PLANE_UNIT, RUNNER_UNIT]) {
      const shown = await host.exec("systemctl", [...(mode === "user" ? ["--user"] : []), "show", "-p", SYSTEMCTL_SHOW_PROPERTIES.join(","), unit], { timeoutMs: 15_000 });
      const state = parseSystemctlShow(unit, shown.stdout);
      if (shown.code !== 0) add(`service:${unit}`, "warn", `could not query ${unit}`, { detail: shown.stderr.trim() || `exit ${shown.code}` });
      else if (state.loadState !== "loaded") add(`service:${unit}`, unit === RUNNER_UNIT ? "warn" : "fail", `${unit} is not installed`, { remedy: "run `wollipog service install`" });
      else if (state.activeState !== "active") add(`service:${unit}`, "fail", `${unit} is ${state.activeState}/${state.subState}${state.unitFileState ? ` (${state.unitFileState})` : ""}`, { remedy: `wollipog service logs ${unit === RUNNER_UNIT ? "runner" : "control-plane"}${mode === "system" ? " --system" : ""}` });
      else add(`service:${unit}`, "pass", `${unit} active/${state.subState}${state.mainPid ? ` (pid ${state.mainPid})` : ""}${state.restarts ? `, ${state.restarts} restart(s)` : ""}`);
    }
    if (mode === "user" && host.user) {
      const linger = await host.exec("loginctl", ["show-user", host.user, "-p", "Linger", "--value"], { timeoutMs: 10_000 });
      if (linger.code === 0 && linger.stdout.trim() === "yes") add("lingering", "pass", `lingering enabled for ${host.user}; user services survive logout`);
      else add("lingering", "warn", `lingering is not enabled for ${host.user}; user services stop at logout`, { remedy: `loginctl enable-linger ${host.user}` });
    }
    for (const [id, path] of [["control-plane-env", layout.controlPlaneEnvFile], ["runner-token", layout.runnerTokenFile]] as const) {
      const audit = auditProtectedFile(path, { ...host, uid: expectedOwner });
      if (!audit.exists) { if (id === "runner-token") add(id, "warn", `no runner token at ${path}`, { remedy: "run `wollipog service install` again to mint it, or `wollipog admin runner-credential issue --output`" }); continue; }
      add(id, audit.issues.length ? "fail" : "pass", audit.issues.length ? `${path} ${audit.issues.join("; ")}` : `${path} is private`, audit.issues.length ? { remedy: `chmod 0600 ${path}` } : {});
    }
  } else if (host.platform === "linux") {
    add("service", "pass", "no `wollipog service` deployment found on this host", { detail: "install one with `wollipog service install` for a durable control plane and runner" });
  }

  // Local bootstrap credential file (the doctor's own access path).
  const ownerHost = { ...host, uid: expectedOwner };
  const credentialAudit = auditProtectedFile(tokenPath, ownerHost);
  if (!credentialAudit.exists) add("local-credential-file", "fail", `no local credential file at ${tokenPath}`, { remedy: "start the control plane once with the same coordinates, or pass --token-file" });
  else if (credentialAudit.issues.length) add("local-credential-file", "fail", `${tokenPath} ${credentialAudit.issues.join("; ")}`, { remedy: `chmod 0600 ${tokenPath} and make sure it is owned by the ${expectedOwner === host.uid ? "account running this command" : "service account"}` });
  else add("local-credential-file", "pass", `${tokenPath} is private`);

  let server: HostAdminDoctorView | null = null;
  if (credentialAudit.exists && credentialAudit.issues.length === 0) {
    let client: Client | null = null;
    let protocol: number | null = null;
    try {
      const token = readProtectedLocalToken(tokenPath, ownerHost);
      client = makeClient(fetchImpl, target.url, token);
      const compatibility = await client.get<{ protocolVersion?: unknown }>("/api/compatibility");
      protocol = typeof compatibility.protocolVersion === "number" ? compatibility.protocolVersion : null;
    } catch (error) {
      add("control-plane-reachable", "fail", `control plane at ${target.url} is not reachable`, { detail: (error as Error).message, remedy: "wollipog service status" });
      client = null;
    }
    if (client && (protocol === null || protocol < RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdminDoctor)) {
      add("control-plane-reachable", protocol === null ? "fail" : "warn", `control plane at ${target.url} speaks protocol v${String(protocol ?? "unknown")}; doctor needs v${RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdminDoctor}+`, { remedy: "upgrade the control plane to run its server-side checks; `wollipog admin status` may still work" });
    } else if (client) {
      // Reachability and the doctor route are separate facts: a reachable control plane whose
      // doctor route fails must not be reported as unreachable, nor as fully healthy.
      add("control-plane-reachable", "pass", `control plane at ${target.url} reachable (protocol v${protocol})`);
      try {
        server = await client.get<HostAdminDoctorView>("/api/admin/doctor");
        checks.push(...server.checks);
        if (server.status.appVersion !== VERSION) add("version-skew", "warn", `CLI ${VERSION} differs from control plane ${server.status.appVersion}`, { remedy: "upgrade both to the same release" });
      } catch (error) {
        add("control-plane-doctor", "fail", "the control plane's doctor route failed", { detail: (error as Error).message, remedy: "wollipog service logs control-plane" });
      }
    }
  }

  const ok = checks.every((item) => item.status !== "fail");
  emit({ ok, generatedAt: server?.generatedAt ?? Date.now(), checks, controlPlane: server?.status ?? null }, () => formatChecks(checks));
  return ok ? 0 : 1;
}

interface DeviceCreateReply {
  device: DeviceView;
  token: string;
  pairing: { hosts: string[]; port: number; webServed: boolean; boundBeyondLoopback: boolean; publicOrigin?: string | null };
}

export async function runHostAdminCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: HostAdminIo = defaultHostAdminIo(),
  fetchImpl: McpFetch = globalThis.fetch,
  host: HostAdminHost = DEFAULT_HOST,
): Promise<number> {
  const json = flag(args, "--json");
  const words = positional(args);
  // Text rendering is lazy so `--json` never depends on the readable formatter (a control plane of
  // another version may omit fields the formatter expects; the JSON caller still gets the data).
  const emit = (data: unknown, text: string | (() => string)) =>
    io.stdout(json ? `${JSON.stringify(data)}\n` : `${typeof text === "function" ? text() : text}\n`);
  const warn = (message: string) => io.stderr(`warning: ${message}\n`);
  try {
    const command = words[1];
    const installed = host.installedControlPlaneEnv?.() ?? null;
    const target = resolveLoopbackUrl(args, env, installed);
    const tokenPath = resolveLocalTokenPath(args, env, host.cwd(), installed);

    if (command === "pairing-url") {
      // Read-only recovery of the persistent loopback credential, the supported equivalent of
      // the control plane's `--print-pair-url` flag. It reveals a durable credential rather than
      // minting a one-time secret, so it follows that flag's explicit-invocation contract.
      const token = readProtectedLocalToken(tokenPath, host);
      const url = `http://127.0.0.1:${target.port}/#pair=${token}`;
      emit({ pairingUrl: url, tokenFile: tokenPath }, url);
      return 0;
    }

    if (command === "doctor") return await doctorCommand(args, env, io, fetchImpl, host, installed, target, tokenPath, emit);

    if (command !== "status" && command !== "user" && command !== "device" && command !== "runner-credential") {
      throw new CliError(hostAdminUsage(), 2);
    }
    const token = readProtectedLocalToken(tokenPath, host);
    const client = makeClient(fetchImpl, target.url, token);
    await ensureCompatible(client, target.url);

    if (command === "status") {
      const status = await client.get<HostAdminStatusView>("/api/admin/status");
      emit(status, () => formatStatus(status));
      return 0;
    }

    if (command === "user") {
      if (words[2] !== "list") throw new CliError(hostAdminUsage(), 2);
      const identity = await client.get<IdentityAdministrationView>("/api/identity");
      const users = identity.memberships.map((member) => ({
        userId: member.userId,
        userName: member.userName,
        role: member.role,
        status: member.userStatus,
        organizationId: member.organizationId,
        createdAt: member.createdAt,
      }));
      emit({ users }, users.length
        ? table([["USER ID", "NAME", "ROLE", "STATUS", "CREATED"],
          ...users.map((user) => [user.userId, user.userName, user.role, user.status, formatWhen(user.createdAt)])])
        : "no users");
      return 0;
    }

    // `await` keeps rejections inside this try so they reach the shared error formatting.
    if (command === "runner-credential") return await runnerCredentialCommand(args, words, client, io, host, emit);

    const verb = words[2];
    if (verb === "list") {
      const { devices } = await client.get<{ devices: DeviceView[] }>("/api/devices");
      emit({ devices }, devices.length
        ? table([["DEVICE ID", "NAME", "USER", "ROLE", "CREATED", "LAST SEEN"],
          ...devices.map((device) => [device.deviceId, device.name, device.userName, device.role, formatWhen(device.createdAt), formatWhen(device.lastSeenAt)])])
        : "no paired devices");
      return 0;
    }

    if (verb === "create") {
      const name = option(args, "--name")?.trim();
      if (!name) throw new CliError("admin device create requires --name <name>", 2);
      const output = option(args, "--output");
      if (!output && !io.stdoutIsTTY) {
        throw new CliError("refusing to print a one-time pairing secret to a non-interactive stdout; pass --output <file> to write it to a new 0600 file", 2);
      }
      const explicitOrigin = option(args, "--origin") ? validateOrigin(option(args, "--origin")!) : null;
      const userId = option(args, "--user")?.trim();
      // Reserve the delivery path before minting: a token that cannot be delivered would otherwise
      // leave an active device whose only plaintext was lost.
      const outputPath = output ? resolve(host.cwd(), output) : null;
      if (outputPath && pathOccupied(outputPath)) throw new CliError(`refusing to overwrite existing output file ${outputPath}`);
      const reply = await client.post<DeviceCreateReply>("/api/devices", { name, ...(userId ? { userId } : {}) });
      // From here until the secret is delivered, any failure revokes the device: its only
      // plaintext would otherwise be lost while the credential stayed active.
      let delivered = false;
      try {
        if (typeof reply.device?.deviceId !== "string" || typeof reply.device.name !== "string") {
          throw new CliError("control plane returned no device record");
        }
        if (typeof reply.token !== "string" || !PAIR_TOKEN_RE.test(reply.token)) {
          throw new CliError("control plane returned an unusable device token");
        }
        let origin: string;
        let originSource: "flag" | "public-origin" | "bind-host" | "loopback";
        if (explicitOrigin) {
          origin = explicitOrigin.origin;
          originSource = "flag";
          if (explicitOrigin.warning) warn(explicitOrigin.warning);
        } else if (reply.pairing.publicOrigin) {
          origin = reply.pairing.publicOrigin;
          originSource = "public-origin";
        } else if (reply.pairing.hosts.length > 0) {
          const bindHost = reply.pairing.hosts[0]!;
          origin = `http://${bindHost.includes(":") ? `[${bindHost}]` : bindHost}:${reply.pairing.port}`;
          originSource = "bind-host";
          warn(`no CONTROL_PLANE_PUBLIC_ORIGIN is configured; the link uses plain HTTP to bind address ${bindHost} and is not encrypted. Set CONTROL_PLANE_PUBLIC_ORIGIN or pass --origin.`);
        } else {
          origin = `http://127.0.0.1:${reply.pairing.port}`;
          originSource = "loopback";
          warn("control plane is bound to loopback only and no CONTROL_PLANE_PUBLIC_ORIGIN is configured; this link only works on this machine. Set CONTROL_PLANE_PUBLIC_ORIGIN or pass --origin for a remote client.");
        }
        const pairingUrl = `${origin}/#pair=${reply.token}`;
        try {
          new URL(pairingUrl);
        } catch {
          // A scoped or otherwise unlinkable bind address (fe80::1%eth0) cannot become a link.
          throw new CliError(`${origin} cannot form a valid pairing link; set CONTROL_PLANE_PUBLIC_ORIGIN or pass --origin <public-origin>`);
        }
        const consumers = pairingLinkConsumers(origin, reply.pairing.webServed);
        if (!consumers.browser && !consumers.desktop) {
          throw new CliError(
            `${origin} is plain HTTP to a host that is neither loopback nor a Tailscale address, and this control plane serves no web dashboard bundle, ` +
              "so neither a browser nor the desktop app can use the link; set CONTROL_PLANE_PUBLIC_ORIGIN to an HTTPS origin or pass --origin <https-origin>",
          );
        }
        if (!consumers.desktop) warn(`the desktop app refuses plain HTTP to ${new URL(origin).hostname}; this link works only in a browser. Use an HTTPS or Tailscale origin for Connections → Instances → Add Remote Instance.`);
        if (!consumers.browser) warn("this control plane serves no web dashboard bundle; this link works only in the desktop app via Connections → Instances → Add Remote Instance.");
        const howToUse = consumers.browser && consumers.desktop
          ? "Open it in a browser or paste it into Connections → Instances → Add Remote Instance"
          : consumers.browser ? "Open it in a browser" : "Paste it into Connections → Instances → Add Remote Instance";
        const summary = { device: reply.device, origin, originSource, consumers };
        const heading = `Paired device ${reply.device.deviceId} (${reply.device.name}) for ${reply.device.userName}.\n`;
        if (outputPath) {
          writeProtectedSecretFile(outputPath, `${pairingUrl}\n`);
          // The file is the delivery; a later stdout failure must not revoke a delivered secret.
          delivered = true;
          emit({ ...summary, outputPath }, `${heading}Pairing link written once to ${outputPath} (mode 0600). ${howToUse}.`);
        } else {
          const text = `${heading}This link is shown once; ${howToUse.charAt(0).toLowerCase()}${howToUse.slice(1)}:\n${pairingUrl}`;
          // Terminal delivery is the write itself: if stdout fails the secret may be lost or
          // partially shown, so the device is revoked and the operator re-runs the command.
          emit({ ...summary, pairingUrl }, text);
          delivered = true;
        }
        return 0;
      } catch (error) {
        if (delivered) throw error;
        throw await abandonMintedDevice(client, reply.device?.deviceId, error as Error);
      }
    }

    if (verb === "revoke") {
      const deviceId = words[3];
      if (!deviceId) throw new CliError("admin device revoke requires a device id", 2);
      if (!flag(args, "--yes")) {
        if (!io.stdinIsTTY) throw new CliError(`refusing to revoke device ${deviceId} without confirmation; pass --yes in non-interactive use`, 2);
        if (!(await io.confirm(`Revoke device ${deviceId}? Its live dashboard connections close immediately.`))) {
          emit({ revoked: false, deviceId }, `device ${deviceId} was not revoked`);
          return 1;
        }
      }
      await client.del(`/api/devices/${encodeURIComponent(deviceId)}`);
      emit({ revoked: true, deviceId }, `revoked device ${deviceId}; its live connections were closed and its token no longer works`);
      return 0;
    }

    throw new CliError(hostAdminUsage(), 2);
  } catch (error) {
    const cli = error instanceof CliError ? error : new CliError((error as Error).message ?? String(error));
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: cli.message })}\n` : `${cli.message}\n`);
    return cli.exitCode;
  }
}
