import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { RemoteAccessSetup, RemoteAccessView } from "@wollipog/protocol";
import { validatePublicOrigin } from "./public-origin.js";

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};
interface Configuration {
  provider: "tailscale" | "https";
  origin: string;
  /** Only a listener created by this installation may be removed. */
  owned: boolean;
  port?: number;
  host?: string;
  target?: string;
}
interface SavedState { version: 1; active: Configuration | null; pending: Configuration | null }
interface Challenge { response: string; expiresAt: number }

export interface RemoteAccessDeps {
  statePath: string;
  port: number;
  instanceId: string;
  configuredOrigin: string | null;
  exec?: (args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; ok: boolean }>;
  fetch?: typeof fetch;
  live?: (origin: string, token: string, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (data: { event: string; operationId: string; entryPoint: string; durationMs: number; outcome: string }) => void;
}

class SetupError extends Error {
  constructor(message: string, readonly authorizationUrl?: string) { super(message); }
}

const READ_LIMIT = 512 * 1024;
const PROBE_MS = 8_000;

/** Normal certificate validation and no redirects apply to every verification request. */
async function boundedBody(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new SetupError("The secure address did not answer successfully. Check the proxy and try again.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > READ_LIMIT) throw new SetupError("The secure address returned an unexpected response.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

export function remoteHttpsOrigin(raw: string): string {
  const parsed = validatePublicOrigin(raw.trim());
  if (!parsed.origin || parsed.error || !parsed.origin.startsWith("https://")) {
    throw new SetupError("Enter an https:// address without a path, code, or password.");
  }
  return parsed.origin;
}

/** Tailscale's consent link is external output; only its own HTTPS authorization host is opened. */
export function tailscaleAuthorizationUrl(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s<>"']+/gu)) {
    try {
      const url = new URL(match[0].replace(/[).,;]+$/u, ""));
      if (url.hostname === "login.tailscale.com" && !url.username && !url.password && !url.port) return url.href;
    } catch { /* Ignore malformed external output. */ }
  }
  return undefined;
}

export function runTailscale(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile("tailscale", args, { timeout: PROBE_MS, maxBuffer: READ_LIMIT, windowsHide: true, signal }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function probeRemoteLive(origin: string, token: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // This is a short-lived, read-only verification capability, never a device/startup token.
    const url = new URL("/ui", origin);
    url.protocol = "wss:";
    url.searchParams.set("token", token);
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new SetupError("The live connection did not respond. Allow WebSocket forwarding for /ui and retry.")), PROBE_MS);
    const cancel = () => finish(new SetupError("Setup cancelled."));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "snapshot") finish();
      } catch { finish(new SetupError("The live connection returned an unexpected response.")); }
    });
    socket.addEventListener("error", () => finish(new SetupError("The live connection failed. Allow WebSocket forwarding for /ui and retry.")), { once: true });
    socket.addEventListener("close", () => finish(new SetupError("The live connection closed before it was ready.")), { once: true });
  });
}

/** One host operation at a time; status refreshes never provision or change network exposure. */
export class RemoteAccess {
  private saved: SavedState = { version: 1, active: null, pending: null };
  private verifiedAt: number | null = null;
  private busy = false;
  private checkedAt: number | null = null;
  private stateError = false;
  private abort?: AbortController;
  private operationDone: Promise<void> | null = null;
  private finishOperation?: () => void;
  private failure: string | null = null;
  private authorizationUrl?: string;
  private challenges = new Map<string, Challenge>();
  private probes = new Map<string, number>();
  private readonly now: () => number;
  private readonly exec: NonNullable<RemoteAccessDeps["exec"]>;
  private readonly fetch: typeof fetch;

  constructor(private readonly deps: RemoteAccessDeps) {
    this.now = deps.now ?? Date.now;
    this.exec = deps.exec ?? runTailscale;
    this.fetch = deps.fetch ?? fetch;
    try {
    if (existsSync(deps.statePath)) {
      const stat = lstatSync(deps.statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 ||
          (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
        throw new Error("remote-access configuration must be a private, regular file owned by this account");
      }
      const saved = JSON.parse(readFileSync(deps.statePath, "utf8")) as SavedState;
      if (saved.version !== 1) throw new Error("unsupported remote-access configuration");
      for (const entry of [saved.active, saved.pending]) {
        if (!entry) continue;
        remoteHttpsOrigin(entry.origin);
        if (entry.provider !== "https" && entry.provider !== "tailscale") throw new Error("invalid remote-access provider");
        if (entry.owned && (entry.provider !== "tailscale" || !entry.host || !Number.isInteger(entry.port) || entry.port! < 1 || entry.port! > 65535 ||
            !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(entry.target ?? "") ||
            entry.origin !== `https://${entry.host}${entry.port === 443 ? "" : `:${entry.port}`}`)) {
          throw new Error("invalid owned remote-access listener");
        }
      }
      this.saved = saved;
    }
    } catch {
      this.stateError = true;
      this.failure = "Remote access settings need repair on this host. Restore the private configuration file or correct its ownership and permissions, then restart Wollipog. Local access remains available.";
    }
  }

  private persist(): void {
    if (this.stateError) throw new SetupError("Restore the private remote access configuration on this host and restart Wollipog before changing it.");
    const temp = `${this.deps.statePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, JSON.stringify(this.saved) + "\n");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, this.deps.statePath);
      if (process.platform !== "win32") chmodSync(this.deps.statePath, 0o600);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }

  /** A manually configured origin retains compatibility until adopted by guided setup. */
  publicOrigin(): string | null {
    if (this.stateError) return null;
    return this.saved.active ? (this.verifiedAt === null ? null : this.saved.active.origin) : this.deps.configuredOrigin;
  }

  proof(challenge: string): { response: string; instanceId: string } | null {
    const item = this.challenges.get(challenge);
    if (!item || item.expiresAt < this.now()) return null;
    return { response: item.response, instanceId: this.deps.instanceId };
  }

  /** Capabilities expire in memory and can authenticate only these two read-only endpoints. */
  isProbeRequest(req: { method: string; url: string; headers: { authorization?: string } }): boolean {
    if (req.method !== "GET") return false;
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/api/instance" && url.pathname !== "/ui") return false;
    const token = req.headers.authorization?.replace(/^Bearer /u, "") ??
      (url.pathname === "/ui" ? url.searchParams.get("token") : null);
    return Boolean(token && (this.probes.get(token) ?? 0) > this.now());
  }

  view(canConfigure: boolean): RemoteAccessView {
    const config = this.saved.pending ?? this.saved.active;
    const ready = this.verifiedAt !== null && this.saved.active !== null;
    return {
      canConfigure,
      phase: this.authorizationUrl ? "needs_authorization" : this.failure || (config && !ready) ? "needs_repair" : ready ? "ready" : "not_configured",
      provider: config?.provider ?? null,
      origin: ready ? this.saved.active!.origin : null,
      message: this.failure ?? (ready ? "Your secure dashboard is ready. Pair a device to connect." : "Set up a secure address to use Wollipog from a phone or another computer."),
      ...(canConfigure && this.authorizationUrl ? { authorizationUrl: this.authorizationUrl } : {}),
      canDisable: canConfigure && Boolean(config),
      verifiedAt: this.verifiedAt,
    };
  }

  async status(canConfigure: boolean): Promise<RemoteAccessView> {
    if (this.saved.active && !this.busy && (this.checkedAt === null || this.now() - this.checkedAt > 30_000)) {
      await this.operation("status", async () => {
        this.checkedAt = this.now();
        const active = this.saved.active!;
        if (active.provider === "tailscale") {
          const config = await this.serveConfig();
          if (config.AllowFunnel?.[`${active.host}:${active.port}`]) throw new SetupError("This listener now allows public access. Review it in Tailscale before retrying private remote access.");
        }
        await this.verify(active.origin);
        this.verifiedAt = this.now();
      });
    }
    return this.view(canConfigure);
  }

  private async operation(entryPoint: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) throw new SetupError("Remote access setup is already running. Wait for it to finish and retry.");
    this.busy = true;
    this.abort = new AbortController();
    this.operationDone = new Promise((resolve) => { this.finishOperation = resolve; });
    const operationId = randomUUID();
    const start = this.now();
    if (!this.stateError) this.failure = null;
    this.authorizationUrl = undefined;
    let outcome = "ready";
    try {
      if (this.stateError) throw new SetupError(this.failure!);
      await action();
    }
    catch (error) {
      outcome = error instanceof SetupError && error.authorizationUrl ? "authorization_required" : "failed";
      this.failure = error instanceof SetupError ? error.message : "The secure connection could not be verified. Check that Tailscale or your HTTPS proxy is running, then retry.";
      this.authorizationUrl = error instanceof SetupError ? error.authorizationUrl : undefined;
      if (entryPoint === "status") this.verifiedAt = null;
    } finally {
      this.busy = false;
      this.finishOperation?.();
      this.operationDone = null;
      this.deps.log?.({ event: "remote_access_operation", operationId, entryPoint, durationMs: this.now() - start, outcome });
    }
  }

  private async execute(args: string[]) {
    this.abort?.signal.throwIfAborted();
    const result = await this.exec(args, this.abort?.signal);
    this.abort?.signal.throwIfAborted();
    return result;
  }

  private async serveConfig(): Promise<ServeConfig> {
    const result = await this.execute(["serve", "status", "--json"]);
    if (!result.ok) throw new SetupError("Wollipog cannot read Tailscale settings. Allow this host account to manage Tailscale, then retry.");
    try { return JSON.parse(result.stdout) as ServeConfig; }
    catch { throw new SetupError("Tailscale returned unreadable settings. Update Tailscale and retry."); }
  }

  private async removeOwned(config: Configuration): Promise<void> {
    if (!config.owned || !config.port || !config.host) return;
    const current = await this.serveConfig();
    const key = `${config.host}:${config.port}`;
    const handlers = current.Web?.[key]?.Handlers;
    if (!handlers && !current.TCP?.[String(config.port)]) return;
    if (!current.TCP?.[String(config.port)]?.HTTPS || !handlers || Object.keys(handlers).length !== 1 ||
        handlers["/"]?.Proxy !== config.target || Object.keys(handlers["/"]!).length !== 1 || Object.keys(current.Web![key]!).some((field) => field !== "Handlers") ||
        Object.keys(current.TCP[String(config.port)]!).some((field) => field !== "HTTPS") ||
        Object.keys(current.Web ?? {}).some((other) => other !== key && other.endsWith(`:${config.port}`)) || current.AllowFunnel?.[key]) {
      throw new SetupError("This Tailscale listener has changed outside Wollipog. Keep it intact and review it in Tailscale before removing it.");
    }
    const result = await this.execute(["serve", `--https=${config.port}`, "off"]);
    if (!result.ok) throw new SetupError("Tailscale could not remove Wollipog's listener. Check host permissions and retry.");
  }

  async setup(input: RemoteAccessSetup): Promise<RemoteAccessView> {
    await this.operation("setup", async () => {
      if (this.saved.pending && this.saved.pending.origin !== this.saved.active?.origin) {
        await this.removeOwned(this.saved.pending);
        this.saved.pending = null;
        this.persist();
      }
      let config: Configuration;
      if (input.provider === "https") {
        config = { provider: "https", origin: remoteHttpsOrigin(input.origin), owned: false };
      } else {
        const status = await this.execute(["status", "--json"]);
        if (!status.ok) throw new SetupError("Tailscale is unavailable. Install or open Tailscale on this computer, sign in, and retry.");
        const tailnet = JSON.parse(status.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
        if (tailnet.BackendState !== "Running") throw new SetupError("Open Tailscale on this computer and sign in, then retry setup.");
        const host = tailnet.Self?.DNSName?.replace(/\.$/u, "");
        if (!host || !/^[a-z0-9.-]+\.ts\.net$/iu.test(host)) throw new SetupError("Enable MagicDNS in Tailscale so this computer has a secure hostname, then retry.");
        const target = `http://127.0.0.1:${this.deps.port}`;
        const current = await this.serveConfig();
        const active = this.saved.active;
        const previous = this.saved.pending;
        const port = [443, 8443, 9443].find((candidate) => {
          const key = `${host}:${candidate}`;
          const same = current.TCP?.[String(candidate)]?.HTTPS && current.Web?.[key]?.Handlers?.["/"]?.Proxy === target;
          return !current.AllowFunnel?.[key] && (same || (!current.TCP?.[String(candidate)] && !current.Web?.[key]));
        });
        if (!port) throw new SetupError("Tailscale's HTTPS ports are already in use. Choose Use an Existing HTTPS Address or free a listener in Tailscale.");
        const key = `${host}:${port}`;
        const reuse = current.Web?.[key]?.Handlers?.["/"]?.Proxy === target;
        const owns = (active?.owned && active.port === port && active.host === host) ||
          (previous?.owned && previous.port === port && previous.host === host);
        config = { provider: "tailscale", origin: `https://${host}${port === 443 ? "" : `:${port}`}`, host, port, target, owned: Boolean(owns || !reuse) };
        this.saved.pending = config;
        this.persist(); // Durable intent survives consent, interruption, and verification failures.
        if (!reuse) {
          const result = await this.execute(["serve", "--bg", `--https=${port}`, "--yes", target]);
          const authorizationUrl = tailscaleAuthorizationUrl(`${result.stdout}\n${result.stderr}`);
          if (authorizationUrl) throw new SetupError("Authorize HTTPS in Tailscale, then choose Retry Setup.", authorizationUrl);
          if (!result.ok) throw new SetupError("Tailscale could not enable HTTPS. Allow this host account to manage Tailscale or check for a port conflict, then retry.");
        }
      }
      await this.verify(config.origin);
      this.abort?.signal.throwIfAborted();
      const previous = this.saved.active;
      // Commit only after the replacement works; a failed setup keeps the previous address.
      this.saved.active = config;
      this.saved.pending = previous?.owned && previous.origin !== config.origin ? previous : null;
      this.persist();
      this.verifiedAt = this.now();
      this.checkedAt = this.verifiedAt;
      if (this.saved.pending) {
        await this.removeOwned(this.saved.pending);
        this.saved.pending = null;
        this.persist();
      }
    });
    return this.view(true);
  }

  async cancel(): Promise<RemoteAccessView> {
    const done = this.operationDone;
    if (done) { this.abort?.abort(); await done; }
    await this.operation("cancel", async () => {
      if (this.saved.pending && this.saved.pending.origin !== this.saved.active?.origin) await this.removeOwned(this.saved.pending);
      this.saved.pending = null;
      this.persist();
    });
    return this.view(true);
  }

  async disable(): Promise<RemoteAccessView> {
    await this.operation("disable", async () => {
      for (const config of [this.saved.pending, this.saved.active]) if (config) await this.removeOwned(config);
      this.saved = { version: 1, active: null, pending: null };
      this.persist(); this.verifiedAt = null;
    });
    return this.view(true);
  }

  private async verify(origin: string): Promise<void> {
    remoteHttpsOrigin(origin);
    const challenge = randomBytes(24).toString("hex");
    const response = randomBytes(32).toString("hex");
    const token = randomBytes(32).toString("base64url");
    this.challenges.set(challenge, { response, expiresAt: this.now() + PROBE_MS * 4 });
    const get = async (path: string, headers?: Record<string, string>) => boundedBody(await this.fetch(`${origin}${path}`, {
      headers, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(PROBE_MS), ...(this.abort ? [this.abort.signal] : [])]),
    }));
    try {
      const proof = JSON.parse(await get(`/remote-access-proof/${challenge}`)) as { response?: string; instanceId?: string };
      const actual = Buffer.from(typeof proof.response === "string" ? proof.response : "");
      const expected = Buffer.from(response);
      if (proof.instanceId !== this.deps.instanceId || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new SetupError("This secure address reaches a different server. Check its forwarding address and retry.");
      }
      // Only this exact instance has answered our fresh challenge. No reusable credential is sent.
      const html = await get("/");
      if (!html.includes("__WOLLIPOG_SAME_ORIGIN__") && !html.includes("__MAM_SAME_ORIGIN__")) {
        throw new SetupError("The secure address is not serving the Wollipog dashboard. Install its web bundle and retry.");
      }
      this.probes.set(token, this.now() + PROBE_MS * 3);
      const identity = JSON.parse(await get("/api/instance", { authorization: `Bearer ${token}` })) as { instanceId?: string };
      if (identity.instanceId !== this.deps.instanceId) throw new SetupError("The secure API reaches a different Wollipog instance. Check proxy forwarding and retry.");
      await (this.deps.live ?? probeRemoteLive)(origin, token, this.abort?.signal);
    } finally { this.challenges.delete(challenge); this.probes.delete(token); }
  }
}
