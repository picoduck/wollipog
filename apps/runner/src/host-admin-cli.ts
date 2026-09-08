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
  type HostAdminStatusView,
  type IdentityAdministrationView,
} from "@wollipog/protocol";
import type { McpFetch } from "./session-management-mcp.js";
import { VERSION } from "./version.js";

export const LOCAL_TOKEN_FILE_ENV = "CONTROL_PLANE_LOCAL_TOKEN_FILE";
export const LOCAL_TOKEN_SUFFIX = ".local-device-token";
const DEFAULT_DB_PATH = "data/control-plane.db";
const DEFAULT_PORT = 4317;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;
const PAIR_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/u;
const VALUE_OPTIONS = new Set(["--url", "--token-file", "--name", "--user", "--origin", "--output"]);

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
}

export const DEFAULT_HOST: HostAdminHost = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  cwd: () => process.cwd(),
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

function option(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i]?.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
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

export function hostAdminUsage(): string {
  return [
    "Usage: wollipog admin <command> [options]",
    "  admin pairing-url [--json]",
    "  admin status [--json]",
    "  admin user list [--json]",
    "  admin device list [--json]",
    "  admin device create --name <name> [--user <user-id>] [--origin <public-origin>] [--output <file>] [--json]",
    "  admin device revoke <device-id> [--yes] [--json]",
    "Options: --url <http://127.0.0.1:4317>, --token-file <path to the protected local credential>",
    `Credential lookup: --token-file, ${LOCAL_TOKEN_FILE_ENV}, CONTROL_PLANE_DB${LOCAL_TOKEN_SUFFIX}, then ${DEFAULT_DB_PATH}${LOCAL_TOKEN_SUFFIX}.`,
    "Runs only on the control-plane host over loopback; one-time secrets print only to a terminal or --output.",
  ].join("\n");
}

/** Where the control plane keeps its protected bootstrap credential, mirroring its own defaults. */
export function resolveLocalTokenPath(args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const explicit = option(args, "--token-file") ?? env[LOCAL_TOKEN_FILE_ENV]?.trim();
  if (explicit) return resolve(cwd, explicit);
  const database = env.CONTROL_PLANE_DB?.trim() || DEFAULT_DB_PATH;
  return `${resolve(cwd, database)}${LOCAL_TOKEN_SUFFIX}`;
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

/** The loopback control-plane origin; anything else fails closed because the bootstrap credential is loopback-only. */
export function resolveLoopbackUrl(args: string[], env: NodeJS.ProcessEnv): { url: string; port: number } {
  const raw = option(args, "--url") ?? `http://127.0.0.1:${env.CONTROL_PLANE_PORT?.trim() || DEFAULT_PORT}`;
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
        published = true;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new CliError(`refusing to overwrite existing output file ${live}`);
        }
        throw new CliError(`could not write ${live}: ${(fallbackError as Error).message}`);
      } finally {
        if (liveFd !== null) closeSync(liveFd);
        if (createdLive && !published) rmSync(live, { force: true });
      }
    }
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(staged, { force: true });
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
  const emit = (data: unknown, text: string) => io.stdout(json ? `${JSON.stringify(data)}\n` : `${text}\n`);
  const warn = (message: string) => io.stderr(`warning: ${message}\n`);
  try {
    const command = words[1];
    const target = resolveLoopbackUrl(args, env);
    const tokenPath = resolveLocalTokenPath(args, env, host.cwd());

    if (command === "pairing-url") {
      // Read-only recovery of the persistent loopback credential, the supported equivalent of
      // the control plane's `--print-pair-url` flag. It reveals a durable credential rather than
      // minting a one-time secret, so it follows that flag's explicit-invocation contract.
      const token = readProtectedLocalToken(tokenPath, host);
      const url = `http://127.0.0.1:${target.port}/#pair=${token}`;
      emit({ pairingUrl: url, tokenFile: tokenPath }, url);
      return 0;
    }

    if (command !== "status" && command !== "user" && command !== "device") throw new CliError(hostAdminUsage(), 2);
    const token = readProtectedLocalToken(tokenPath, host);
    const client = makeClient(fetchImpl, target.url, token);
    await ensureCompatible(client, target.url);

    if (command === "status") {
      const status = await client.get<HostAdminStatusView>("/api/admin/status");
      emit(status, formatStatus(status));
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
        if (!reply.pairing.webServed) warn("this control plane serves no web dashboard bundle; the desktop app can still use the link via Connections → Instances → Add Remote Instance.");
        const pairingUrl = `${origin}/#pair=${reply.token}`;
        try {
          new URL(pairingUrl);
        } catch {
          // A scoped or otherwise unlinkable bind address (fe80::1%eth0) cannot become a link.
          throw new CliError(`${origin} cannot form a valid pairing link; set CONTROL_PLANE_PUBLIC_ORIGIN or pass --origin <public-origin>`);
        }
        const summary = { device: reply.device, origin, originSource };
        if (outputPath) {
          writeProtectedSecretFile(outputPath, `${pairingUrl}\n`);
          delivered = true;
          emit({ ...summary, outputPath },
            `Paired device ${reply.device.deviceId} (${reply.device.name}) for ${reply.device.userName}.\n` +
              `Pairing link written once to ${outputPath} (mode 0600). Open it in a browser or paste it into Connections → Instances → Add Remote Instance.`);
        } else {
          delivered = true;
          emit({ ...summary, pairingUrl },
            `Paired device ${reply.device.deviceId} (${reply.device.name}) for ${reply.device.userName}.\n` +
              "This link is shown once; open it in a browser or paste it into Connections → Instances → Add Remote Instance:\n" +
              pairingUrl);
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
