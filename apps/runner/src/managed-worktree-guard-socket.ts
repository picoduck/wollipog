/**
 * The runner side of the managed-worktree guard's verdict socket (#1336).
 *
 * Inside a runner-owned sandbox (`bwrap` on Linux, Seatbelt on macOS) the runner's hook state
 * directory is hidden from the provider and from everything it spawns: its tools, its MCP servers,
 * and the guard sidecar itself, which is a re-entry the provider starts. The sidecar therefore
 * cannot read the protection list. It hands the hook payload to a per-session Unix socket instead,
 * and the runner — outside the sandbox — judges it with the very function a file-mode sidecar runs,
 * against the list of the session that owns that socket.
 *
 * The socket is session-bound by construction: one server per session, created in that session's
 * owner-only directory, holding only that session's protections path. A request carries no session
 * identity, so there is nothing a caller could name to reach another session's list, and the
 * sandbox binds only this session's socket directory back into view. Every failure on the sidecar's
 * side is exit 2 (managed-worktree-guard.ts), so a socket that is gone refuses rather than passes.
 */

import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { quote } from "shell-quote";
import { claudeHookSessionProtectionsPath } from "./hook-settings.js";
import {
  MANAGED_WORKTREE_GUARD_SOCKET_FLAG,
  runManagedWorktreeGuardDecision,
} from "./managed-worktree-guard.js";
import { GUARD_STATE_REFUSAL } from "./managed-worktree-protection.js";
import { isSafeSessionFileId } from "./session-file-id.js";
import { buildBwrapArgs, type SpawnIsolation } from "./spawn.js";

const GUARD_SOCKET_DIRECTORY_SUFFIX = ".guard";
const GUARD_SOCKET_NAME = "sock";
/** `sun_path` is 108 bytes on Linux and 104 on macOS, both including the terminator. A path that
 * does not fit cannot be bound at all, so the guard is not provisioned rather than half-working. */
export const MAX_GUARD_SOCKET_PATH_BYTES = 100;
const MAX_REQUEST_BYTES = 1_000_000 + 1;
const REQUEST_TIMEOUT_MS = 30_000;

export function managedWorktreeGuardSocketDirectory(configDir: string, sessionId: string): string {
  if (!isSafeSessionFileId(sessionId)) throw new Error("unsafe session id for the guard socket");
  return join(configDir, `${sessionId}${GUARD_SOCKET_DIRECTORY_SUFFIX}`);
}

export function managedWorktreeGuardSocketPath(configDir: string, sessionId: string): string {
  return join(managedWorktreeGuardSocketDirectory(configDir, sessionId), GUARD_SOCKET_NAME);
}

/** Owner-only, a real directory, and ours. Anything else in its place is removed, not trusted:
 * a planted symlink would move the socket somewhere the sandbox cannot hide. */
function ensurePrivateDirectory(directory: string): void {
  try {
    const existing = lstatSync(directory);
    const foreign = !existing.isDirectory() || existing.isSymbolicLink() ||
      (process.getuid !== undefined && existing.uid !== process.getuid());
    if (foreign) rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

/** Device and inode of the socket at `path`, or null when nothing (or not a socket) is there. */
function socketIdentity(path: string): string | null {
  try {
    const entry = lstatSync(path, { bigint: true });
    return entry.isSocket() ? `${entry.dev}:${entry.ino}` : null;
  } catch {
    return null;
  }
}

function serveVerdict(socket: Socket, protectionsFile: string): void {
  const chunks: Buffer[] = [];
  let total = 0;
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    total += chunk.length;
    // An oversized payload gets no verdict at all; the sidecar reads that as a refusal.
    if (total > MAX_REQUEST_BYTES) socket.destroy();
    else chunks.push(chunk);
  });
  socket.on("end", () => {
    if (socket.destroyed) return;
    const outcome = runManagedWorktreeGuardDecision(Buffer.concat(chunks).toString("utf8"), protectionsFile);
    socket.end(JSON.stringify(outcome));
  });
}

/**
 * One verdict server per session, alive for as long as the runner may launch that session inside
 * a sandbox. The protections file itself is unchanged: written, refreshed, tripwired, and removed
 * exactly as in provider mode, so an invalidated guard (its list removed) blocks here as well.
 */
export class ManagedWorktreeGuardSockets {
  private readonly servers = new Map<string, { server: Server; path: string; identity: string }>();

  /** Per-session tail of in-flight `ensure`/`close` work. Two launch preparations of one session
   * can overlap (an older generation being superseded), and a deletion can race both; each
   * operation runs only after the previous one for that session has settled. */
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly configDir: string) {}

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(sessionId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.pending.set(sessionId, settled);
    void settled.then(() => { if (this.pending.get(sessionId) === settled) this.pending.delete(sessionId); });
    return next;
  }

  /** Listen for this session (idempotent) and return the socket path, or throw when it cannot. */
  ensure(sessionId: string): Promise<string> {
    return this.serialized(sessionId, () => this.ensureNow(sessionId));
  }

  close(sessionId: string): Promise<void> {
    return this.serialized(sessionId, () => this.closeNow(sessionId));
  }

  private async ensureNow(sessionId: string): Promise<string> {
    const path = managedWorktreeGuardSocketPath(this.configDir, sessionId);
    if (Buffer.byteLength(path, "utf8") > MAX_GUARD_SOCKET_PATH_BYTES) {
      throw new Error(`guard socket path is longer than ${MAX_GUARD_SOCKET_PATH_BYTES} bytes: ${path}`);
    }
    const existing = this.servers.get(sessionId);
    // Still ours only while the path on disk is the very socket this server bound. A removed entry
    // reaches nothing, and a replaced one — any other socket at the same path — would answer for
    // this session without being the runner, so either way the runner listens afresh.
    if (existing?.server.listening && socketIdentity(path) === existing.identity) return path;
    await this.closeNow(sessionId);
    const protectionsFile = claudeHookSessionProtectionsPath(this.configDir, sessionId);
    const directory = managedWorktreeGuardSocketDirectory(this.configDir, sessionId);
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    ensurePrivateDirectory(directory);
    rmSync(path, { force: true });
    const server = createServer((socket) => serveVerdict(socket, protectionsFile));
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    server.on("error", () => { /* a per-connection failure never takes the server down */ });
    chmodSync(path, 0o600);
    const identity = socketIdentity(path);
    if (!identity) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      throw new Error("the guard socket was replaced while it was being created");
    }
    this.servers.set(sessionId, { server, path, identity });
    return path;
  }

  private async closeNow(sessionId: string): Promise<void> {
    const entry = this.servers.get(sessionId);
    this.servers.delete(sessionId);
    if (entry) await new Promise<void>((resolvePromise) => entry.server.close(() => resolvePromise()));
    try {
      rmSync(managedWorktreeGuardSocketDirectory(this.configDir, sessionId), { recursive: true, force: true });
    } catch { /* best effort: a stale directory is re-verified before the next listen */ }
  }

  async closeAll(): Promise<void> {
    const sessions = new Set([...this.servers.keys(), ...this.pending.keys()]);
    await Promise.all([...sessions].map((sessionId) => this.close(sessionId)));
  }
}

/** The hidden directory and what the provider must still read inside it (#1336). */
export interface GuardStateMask {
  /** The runner's hook state directory. */
  directory: string;
  /** Entries re-exposed read-only: the session's own settings documents, which the provider reads
   * at start, and the session's socket directory. Missing entries are skipped. */
  readable: string[];
  /** The verdict socket, inside one of the `readable` directories; Seatbelt needs it named to
   * allow the connection when the network is denied. */
  socket?: string;
  /** The manager policy hook's own state for this session, which that hook (a provider-spawned
   * re-entry, like the guard) reads and rewrites on every call. Seatbelt grants exactly these
   * paths back; bwrap cannot grant a write inside its read-only data root at all. */
  managerTransport?: {
    /** Read only: the credential and its acknowledgement. */
    readable: string[];
    /** Rewritten through `protectedWrite` (temp sibling, then rename): the circuit. */
    atomicWritable: string[];
    /** Created and removed in place: the circuit lock. */
    writable: string[];
  };
}

export interface GuardSandboxProbe {
  launch: { command: string; args: string[] };
  protectionsFile: string;
  socketPath: string;
}

/**
 * Prove, in the launch's OWN sandbox shape, that the guard sidecar still gets a verdict (#1336).
 *
 * The host-side self-test (`verifyManagedWorktreeGuardLaunch`) proves the sidecar starts and
 * judges; it runs outside the sandbox, so it cannot notice that the mask hides the socket or that
 * the sidecar cannot start in there. This probe runs the real sidecar through the real sandbox
 * wrapper with a payload that names the session's own protections file, which the guard refuses
 * whatever the list says — but only after loading that list, so a refusal also proves the runner
 * could read it. Anything else fails the launch: a mask that blocked the guard must stop the
 * session before it starts, not fail every tool call it makes.
 */
export async function verifyManagedWorktreeGuardInSandbox(
  probe: GuardSandboxProbe,
  isolation: SpawnIsolation | undefined,
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sidecarArgs = [
    ...probe.launch.args,
    "--protections", probe.protectionsFile,
    MANAGED_WORKTREE_GUARD_SOCKET_FLAG, probe.socketPath,
  ];
  let file: string;
  let args: string[];
  if (isolation?.backend === "bwrap") {
    file = isolation.command;
    args = buildBwrapArgs({ command: probe.launch.command, args: sidecarArgs, cwd }, isolation);
  } else if (isolation?.backend === "seatbelt") {
    file = isolation.command;
    args = [...isolation.args, "-p", isolation.profile, probe.launch.command, ...sidecarArgs];
  } else {
    return { ok: false, reason: `no runner-owned sandbox to probe (${isolation?.backend ?? "provider"})` };
  }
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd,
    tool_input: { command: quote(["cat", probe.protectionsFile]) },
  });
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (verdict: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(verdict);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      done({ ok: false, reason: `sandboxed guard probe could not start: ${(error as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, reason: "sandboxed guard probe timed out" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 65_536) stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 65_536) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => done({ ok: false, reason: `sandboxed guard probe failed: ${error.message}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        done({ ok: false, reason: `sandboxed guard probe exited ${String(code)}: ${stderr.trim().slice(0, 300)}` });
      } else if (!stdout.includes('"permissionDecision":"deny"') || !stdout.includes(GUARD_STATE_REFUSAL)) {
        done({ ok: false, reason: "sandboxed guard probe did not produce the guard-state refusal" });
      } else {
        done({ ok: true });
      }
    });
    child.stdin?.on("error", () => { /* the close handler reports the outcome */ });
    child.stdin?.end(payload);
  });
}
