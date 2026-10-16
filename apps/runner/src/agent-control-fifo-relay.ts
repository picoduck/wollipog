/**
 * FIFO transport for the provider-mode Agent Control relay (#3270).
 *
 * Codex's Linux sandbox with network access off runs each command in its own network namespace
 * under a seccomp filter that refuses connect() for every socket family. Measured on codex-cli
 * 0.162.1: `connect EPERM` for 127.0.0.1 and for a Unix socket path alike. The loopback relay in
 * agent-control-relay.ts is therefore unreachable from a sandboxed shell command, and so is any
 * socket the runner could offer instead. Opening a FIFO is not a socket operation, and the kernel
 * opens FIFOs for writing on a read-only mount, so this channel carries the same relay frame
 * through FIFOs the runner creates. It adds no authority: the runner authenticates the relay key,
 * pins the destination and supplies its memory-held bearer exactly as it does for the loopback
 * relay, and the sandbox gains no socket, port, or writable path.
 *
 * Every other session's sandboxed commands run as the same user and can read the whole disk, so a
 * channel must not be findable: each session's directory has a random 128-bit name that only its
 * own environment carries, inside a base that cannot be listed. The directory itself is mode 0300,
 * so a process can open a name it knows but cannot list it to learn anyone else's:
 *
 *   doorbell      The runner holds it open read-write, then makes it write-only (0200), so no other
 *                 process can read the nonces posted to it. A client writes one
 *                 `{"nonce":"<32 hex>"}` line in a single write, well under PIPE_BUF, so concurrent
 *                 clients never interleave.
 *   <nonce>.res   Created for that nonce first; the client opens it for reading.
 *   <nonce>.req   Created second; the client opens it for writing, sends one newline-terminated
 *                 frame, and keeps it open until the response ends. Its end-of-file is the client
 *                 going away, which cancels the relayed request just as a closed socket does.
 *
 * The runner unlinks both names when the first request byte arrives, and abandons any exchange
 * whose client does not arrive, finish, or read the response within the limits below.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  parseRequest,
  parseResponse,
  relayFetchThrough,
  type AgentControlRelayHandler,
  type AgentControlRelayRequest,
  type AgentControlRelayResponse,
} from "./agent-control-relay.js";
import type { McpFetch } from "./session-management-mcp.js";
import { isSafeSessionFileId } from "./session-file-id.js";

export const AGENT_CONTROL_RELAY_FIFO_ENV = "WOLLIPOG_AGENT_CONTROL_RELAY_FIFO";

const DOORBELL = "doorbell";
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_DOORBELL_LINE_BYTES = 256;
/** How long a client waits for the runner to answer its doorbell with a channel. */
const CLIENT_CHANNEL_WAIT_MS = 10_000;
const MKFIFO_CANDIDATES = ["/usr/bin/mkfifo", "/bin/mkfifo"];

export interface FifoRelayLimits {
  /** Exchanges one session may have open at once. A nonce beyond it is ignored, and its client
   * gives up after its own wait, so a flood cannot make the runner create FIFOs without bound. */
  maxPendingExchanges: number;
  /** From the nonce to the client's first request byte. */
  arrivalMs: number;
  /** From the first request byte to the end of the frame. Even the largest frame takes far less,
   * so a client cannot hold a slot for the whole exchange by sending a single byte. */
  requestMs: number;
  /** From the nonce to the end of the response, whatever the relayed request is doing. The slowest
   * relayed calls are bounded at 180 seconds by their own control-plane timeouts. */
  exchangeMs: number;
  /** The loopback relay's request bound, including the terminating newline. */
  maxRequestFrameBytes: number;
}

export const DEFAULT_FIFO_RELAY_LIMITS: FifoRelayLimits = {
  maxPendingExchanges: 16,
  arrivalMs: 10_000,
  requestMs: 60_000,
  exchangeMs: 300_000,
  maxRequestFrameBytes: MAX_REQUEST_FRAME_BYTES,
};

/** Where a runner keeps every session's channel directory. */
export function agentControlFifoRelayBase(configDir: string): string {
  return join(configDir, "fifo-relay");
}

function makeFifos(paths: readonly string[]): Promise<void> {
  const command = MKFIFO_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!command) return Promise.reject(new Error("mkfifo is not available on this host"));
  return new Promise((resolvePromise, reject) => {
    // Node has no mkfifo(3). The fixed system binary creates the names in argument order.
    execFile(command, ["-m", "600", "--", ...paths], { timeout: 5_000 }, (error) => {
      if (error) reject(new Error(`mkfifo failed: ${error.message}`));
      else resolvePromise();
    });
  });
}

/** Non-blocking, never through a link, and only ever a FIFO. */
function openFifo(path: string, mode: number): number {
  const fd = openSync(path, mode | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFIFO()) throw new Error("Agent Control FIFO relay path is not a FIFO");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

function isFifo(path: string): boolean {
  try {
    return lstatSync(path).isFIFO();
  } catch {
    return false;
  }
}

function unlinkQuietly(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* Already gone, or its directory is. */ }
}

function removeChannelDirectory(directory: string): void {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    return;
  }
  // A 0300 directory cannot be listed, so it could not be emptied. Never chmod through a link.
  if (stat.isDirectory()) chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
}

/** The base holds every session's channel; 0300, so no session can list it to find another's. */
function prepareBase(base: string): void {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Agent Control FIFO relay base is not a directory");
  }
  chmodSync(base, 0o300);
}

/** Startup cleanup: no channel survives a runner restart. A provider still holding an old path
 * finds no doorbell and gets a named error rather than a hang. */
export function sweepAgentControlFifoRelays(base: string): number {
  let entries;
  try {
    const stat = lstatSync(base);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 0;
    chmodSync(base, 0o700);
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) removeChannelDirectory(join(base, entry.name));
  chmodSync(base, 0o300);
  return entries.length;
}

interface Exchange {
  finish: () => void;
}

interface Channel {
  directory: string;
  doorbell: Socket;
  exchanges: Map<string, Exchange>;
}

/** One FIFO channel per live session, beside its loopback relay. Like that listener, the channel
 * itself grants no control-plane authority: every frame must carry the session's relay key. */
export class AgentControlFifoRelays {
  private readonly channels = new Map<string, Channel>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly base: string,
    private readonly handler: AgentControlRelayHandler,
    private readonly limits: FifoRelayLimits = DEFAULT_FIFO_RELAY_LIMITS,
  ) {}

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(sessionId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.pending.set(sessionId, settled);
    void settled.then(() => { if (this.pending.get(sessionId) === settled) this.pending.delete(sessionId); });
    return next;
  }

  /** The session's channel directory, created on first use. */
  ensure(sessionId: string): Promise<string> {
    return this.serialized(sessionId, async () => {
      if (!isSafeSessionFileId(sessionId)) throw new Error("unsafe session id for the Agent Control FIFO relay");
      const existing = this.channels.get(sessionId);
      if (existing && !existing.doorbell.destroyed) return existing.directory;
      this.closeNow(sessionId);
      prepareBase(this.base);
      // Unguessable, so a process that knows only the session id cannot find the doorbell.
      const directory = join(this.base, `${sessionId}.${randomBytes(16).toString("hex")}`);
      mkdirSync(directory, { mode: 0o700 });
      const doorbellPath = join(directory, DOORBELL);
      let doorbell: Socket | undefined;
      try {
        await makeFifos([doorbellPath]);
        // Read-write, so the runner is always a writer too: the doorbell never reports end-of-file
        // and opening it never waits for a client.
        const fd = openFifo(doorbellPath, constants.O_RDWR);
        doorbell = new Socket({ fd, readable: true, writable: false });
        chmodSync(doorbellPath, 0o200);
        chmodSync(directory, 0o300);
      } catch (error) {
        doorbell?.destroy();
        removeChannelDirectory(directory);
        throw error;
      }
      const channel: Channel = { directory, doorbell, exchanges: new Map() };
      this.channels.set(sessionId, channel);
      this.listen(sessionId, channel);
      return directory;
    });
  }

  close(sessionId: string): Promise<void> {
    return this.serialized(sessionId, async () => this.closeNow(sessionId));
  }

  async closeAll(): Promise<void> {
    // A channel still being created is only in `pending`; its close queues behind that creation.
    const sessionIds = new Set([...this.channels.keys(), ...this.pending.keys()]);
    await Promise.all([...sessionIds].map((sessionId) => this.close(sessionId)));
  }

  private closeNow(sessionId: string): void {
    const channel = this.channels.get(sessionId);
    this.channels.delete(sessionId);
    if (!channel) return;
    for (const exchange of [...channel.exchanges.values()]) exchange.finish();
    channel.doorbell.destroy();
    removeChannelDirectory(channel.directory);
  }

  private listen(sessionId: string, channel: Channel): void {
    let partial = Buffer.alloc(0);
    // A failed doorbell leaves the channel unusable; the next launch's ensure() rebuilds it.
    channel.doorbell.on("error", () => channel.doorbell.destroy());
    channel.doorbell.on("data", (chunk: Buffer) => {
      let buffer = partial.length > 0 ? Buffer.concat([partial, chunk]) : chunk;
      for (let newline = buffer.indexOf(0x0a); newline >= 0; newline = buffer.indexOf(0x0a)) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length <= MAX_DOORBELL_LINE_BYTES) this.ring(sessionId, channel, line);
      }
      // No valid line is this long; drop it rather than buffer junk without bound.
      partial = buffer.length > MAX_DOORBELL_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(buffer);
    });
  }

  private ring(sessionId: string, channel: Channel, line: Buffer): void {
    if (this.channels.get(sessionId) !== channel) return;
    let nonce: unknown;
    try {
      nonce = (JSON.parse(line.toString("utf8")) as { nonce?: unknown } | null)?.nonce;
    } catch {
      return;
    }
    if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce) || channel.exchanges.has(nonce) ||
        channel.exchanges.size >= this.limits.maxPendingExchanges) {
      return;
    }
    this.exchange(sessionId, channel, nonce);
  }

  private exchange(sessionId: string, channel: Channel, nonce: string): void {
    const responsePath = join(channel.directory, `${nonce}.res`);
    const requestPath = join(channel.directory, `${nonce}.req`);
    const abort = new AbortController();
    let request: Socket | undefined;
    let response: Socket | undefined;
    let requestTimer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(arrival);
      clearTimeout(requestTimer);
      clearTimeout(deadline);
      abort.abort();
      request?.destroy();
      response?.destroy();
      unlinkQuietly(requestPath);
      unlinkQuietly(responsePath);
      channel.exchanges.delete(nonce);
    };
    const arrival = setTimeout(finish, this.limits.arrivalMs);
    const deadline = setTimeout(finish, this.limits.exchangeMs);
    channel.exchanges.set(nonce, { finish });

    const reply = (result: AgentControlRelayResponse) => {
      if (finished || !response) return;
      const frame = JSON.stringify(result);
      if (Buffer.byteLength(frame, "utf8") > MAX_RESPONSE_FRAME_BYTES) {
        finish();
        return;
      }
      // Closing the writer once the kernel holds every byte is the end-of-response marker; the
      // client still reads what is buffered.
      response.write(frame, () => finish());
    };

    const serve = (stream: Socket) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let handling = false;
      stream.on("error", finish);
      // Before the response, end-of-file means the client went away, like a closed socket.
      stream.on("end", finish);
      stream.on("data", (chunk: Buffer) => {
        if (finished || handling) return;
        if (!response) {
          clearTimeout(arrival);
          requestTimer = setTimeout(finish, this.limits.requestMs);
          try {
            // The client opened the response FIFO before writing, so a reader exists unless it
            // broke the protocol, in which case this open fails and the exchange ends.
            response = new Socket({ fd: openFifo(responsePath, constants.O_WRONLY), readable: false, writable: true });
          } catch {
            finish();
            return;
          }
          response.on("error", finish);
          unlinkQuietly(requestPath);
          unlinkQuietly(responsePath);
        }
        total += chunk.length;
        if (total > this.limits.maxRequestFrameBytes) {
          finish();
          return;
        }
        chunks.push(chunk);
        if (!chunk.includes(0x0a)) return;
        clearTimeout(requestTimer);
        const received = Buffer.concat(chunks);
        handling = true;
        let parsed: AgentControlRelayRequest;
        try {
          parsed = parseRequest(JSON.parse(received.subarray(0, received.indexOf(0x0a)).toString("utf8")));
        } catch {
          finish();
          return;
        }
        this.handler(sessionId, parsed, abort.signal).then(
          reply,
          // Name the runner-side cause (#1841), as the loopback relay does.
          (error: unknown) => reply({
            status: 503,
            body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          }),
        );
      });
    };

    // The response FIFO first: once the request FIFO exists, a client may rely on both.
    makeFifos([responsePath, requestPath]).then(() => {
      if (finished) {
        // Ended while mkfifo ran; its names appeared after finish() looked for them.
        unlinkQuietly(requestPath);
        unlinkQuietly(responsePath);
        return;
      }
      request = new Socket({ fd: openFifo(requestPath, constants.O_RDONLY), readable: true, writable: false });
      serve(request);
    }).catch(() => {
      finish();
      unlinkQuietly(requestPath);
      unlinkQuietly(responsePath);
    });
  }
}

/** Fetch through a session's FIFO channel, for a CLI that may run where no socket can connect. */
export function agentControlFifoRelayFetch(
  directory: string,
  key: string,
  options: { channelWaitMs?: number } = {},
): McpFetch {
  if (!isAbsolute(directory)) throw new Error("invalid Agent Control FIFO relay directory");
  const channelWaitMs = options.channelWaitMs ?? CLIENT_CHANNEL_WAIT_MS;
  return relayFetchThrough(key, (request, signal) => fifoRoundTrip(directory, request, channelWaitMs, signal));
}

function ringDoorbell(path: string, nonce: string): void {
  let fd: number;
  try {
    fd = openFifo(path, constants.O_WRONLY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === "ENXIO" || code === "ENOENT"
      ? "the runner's Agent Control relay is not running for this session"
      : `could not reach the runner's Agent Control relay: ${(error as Error).message}`);
  }
  try {
    const line = Buffer.from(`${JSON.stringify({ nonce })}\n`, "utf8");
    // A single write under PIPE_BUF is atomic, so concurrent calls cannot interleave their lines.
    if (writeSync(fd, line) !== line.length) throw new Error("short write");
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "EAGAIN"
      ? "the runner's Agent Control relay is not reading requests"
      : `could not reach the runner's Agent Control relay: ${(error as Error).message}`);
  } finally {
    closeSync(fd);
  }
}

async function fifoRoundTrip(
  directory: string,
  request: AgentControlRelayRequest,
  channelWaitMs: number,
  signal?: AbortSignal,
): Promise<AgentControlRelayResponse> {
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_REQUEST_FRAME_BYTES) {
    throw new Error("Agent Control relay request is too large");
  }
  if (signal?.aborted) throw new Error("Agent Control relay request aborted");
  const nonce = randomBytes(16).toString("hex");
  ringDoorbell(join(directory, DOORBELL), nonce);
  const requestPath = join(directory, `${nonce}.req`);
  const responsePath = join(directory, `${nonce}.res`);
  const deadline = Date.now() + channelWaitMs;
  const unavailable = () => new Error(
    `the runner did not open an Agent Control relay channel within ${channelWaitMs / 1000} seconds`);
  while (!isFifo(requestPath)) {
    if (signal?.aborted) throw new Error("Agent Control relay request aborted");
    if (Date.now() >= deadline) throw unavailable();
    await sleep(5);
  }
  // Reader first: the runner opens the response's write end when the first request byte arrives.
  const response = new Socket({ fd: openFifo(responsePath, constants.O_RDONLY), readable: true, writable: false });
  let requestFd: number | undefined;
  while (requestFd === undefined) {
    try {
      requestFd = openFifo(requestPath, constants.O_WRONLY);
    } catch (error) {
      // ENXIO: the runner has created the FIFO but not opened its read end yet.
      if ((error as NodeJS.ErrnoException).code !== "ENXIO" || Date.now() >= deadline || signal?.aborted) {
        response.destroy();
        throw (error as NodeJS.ErrnoException).code === "ENXIO" ? unavailable() : error;
      }
      await sleep(5);
    }
  }
  const outbound = new Socket({ fd: requestFd, readable: false, writable: true });
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const finish = (error: Error | null, result?: AgentControlRelayResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      response.destroy();
      outbound.destroy();
      if (error) reject(error);
      else resolvePromise(result!);
    };
    const aborted = () => finish(new Error("Agent Control relay request aborted"));
    // An abort during channel setup has already fired and is not replayed: refuse before the frame
    // is written, or a cancelled request would still reach the control plane. Closing both ends
    // unsent tells the runner the client went away.
    if (signal?.aborted) {
      aborted();
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
    response.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_FRAME_BYTES) finish(new Error("Agent Control relay response is too large"));
      else chunks.push(chunk);
    });
    response.on("end", () => {
      // The runner ends an exchange it abandons (a timeout, a malformed frame) without writing.
      if (total === 0) {
        finish(new Error("Agent Control relay closed without a response"));
        return;
      }
      try {
        finish(null, parseResponse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch (error) {
        finish(new Error(`invalid Agent Control relay response: ${(error as Error).message}`));
      }
    });
    response.on("error", (error) => finish(error));
    response.on("close", () => finish(new Error("Agent Control relay closed without a response")));
    // The request stays open until the response ends: closing it early would cancel the request.
    outbound.on("error", (error) => finish(error));
    outbound.write(frame);
  });
}
