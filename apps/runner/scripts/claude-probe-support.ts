/**
 * Shared harness for the credential-free Claude Code assumption probes (#3797).
 *
 * Every probe drives a real `claude` against a scripted loopback Anthropic Messages API, inside a
 * throwaway HOME and CLAUDE_CONFIG_DIR, with a dummy key that exists only in that environment.
 * Nothing here reads the account's real Claude home, keychain or environment: the child
 * environment is built from an allowlist, never by spreading `process.env`.
 *
 * Network silence is measured, not assumed. Every CLI run is wrapped in `strace -f`, which records
 * each connect/sendto/sendmsg the CLI and all its descendants issue, and a refusing proxy logs any
 * proxy-respecting request. A host without a working strace cannot measure silence: callers
 * report that assumption as "could not run", never as a pass.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";

export const DUMMY_API_KEY = "sk-ant-api03-wollipog-probe-dummy-key-not-a-credential";
/** Variables that switch off every request Claude Code makes besides the Messages API. */
export const QUIET_TRAFFIC_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
});

export type ProbeStatus = "unchanged" | "changed" | "could not run";

export function probeResult(assumption: string, status: ProbeStatus, observed: string, documentation: string): void {
  console.log(JSON.stringify({ event: "claude_assumption", assumption, status, observed, documentation }));
}

/** A recorded behaviour no longer holds. Thrown inside a case; the case reports "changed". */
export class AssumptionChanged extends Error {}
/** The case could not be measured (spawn failure, timeout, incomplete output, stub misuse). */
export class CouldNotRun extends Error {}

export interface IsolatedHome { root: string; home: string; configDir: string; tmp: string; work: string }

/** Create a throwaway HOME, CLAUDE_CONFIG_DIR, XDG tree, TMPDIR and working directory under `root`.
 * The config dir is deliberately not `HOME/.claude`, so a write that ignores CLAUDE_CONFIG_DIR
 * shows up as a stray `HOME/.claude`. */
export function isolatedHome(root: string): IsolatedHome {
  const home = join(root, "home");
  const paths = { root, home, configDir: join(root, "claude-config"), tmp: join(root, "tmp"), work: join(root, "work") };
  for (const dir of [paths.configDir, paths.tmp, paths.work, join(home, ".config"), join(home, ".cache"), join(home, ".local", "share"), join(home, ".local", "state")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

/** The complete child environment. Intentionally does not spread process.env: provider keys,
 * base URLs, OAuth tokens, a real CLAUDE_CONFIG_DIR and hosting-session variables stay out. */
export function isolatedClaudeEnv(paths: IsolatedHome, baseUrl: string, proxyUrl: string, quiet = true): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: paths.home, CLAUDE_CONFIG_DIR: paths.configDir, SHELL: "/bin/bash",
    XDG_CONFIG_HOME: join(paths.home, ".config"), XDG_CACHE_HOME: join(paths.home, ".cache"),
    XDG_DATA_HOME: join(paths.home, ".local", "share"), XDG_STATE_HOME: join(paths.home, ".local", "state"),
    TMPDIR: paths.tmp, LANG: "C.UTF-8", TERM: "dumb",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", BASH_ENV: "/dev/null", ENV: "/dev/null",
    HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
    ANTHROPIC_API_KEY: DUMMY_API_KEY, ANTHROPIC_BASE_URL: baseUrl,
    ...(quiet ? QUIET_TRAFFIC_ENV : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Scripted loopback Messages API

export type Block = Record<string, unknown>;
export interface StubRequest { n: number; method: string; path: string; body: Record<string, unknown> | null }
export type StubReply = { content: Block[]; stop?: "end_turn" | "tool_use" } | { status: number; error: string };
export type Responder = (request: StubRequest) => StubReply;

export function messagesOf(body: StubRequest["body"]): Array<{ role: string; content: unknown }> {
  return Array.isArray(body?.messages) ? body.messages as Array<{ role: string; content: unknown }> : [];
}
function blocksOf(content: unknown): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as Block[] : [];
}
/** Concatenated text of the first user message: the conversation's prompt (or a subagent's task). */
export function firstUserText(body: StubRequest["body"]): string {
  const first = messagesOf(body).find((m) => m.role === "user");
  return blocksOf(first?.content).map((b) => typeof b.text === "string" ? b.text : "").join("\n");
}
export function lastMessageBlocks(body: StubRequest["body"]): Block[] {
  return blocksOf(messagesOf(body).at(-1)?.content);
}
/** tool_result blocks the CLI sent back in this request's final user message. */
export function toolResults(body: StubRequest["body"]): Block[] {
  return lastMessageBlocks(body).filter((b) => b.type === "tool_result");
}
export function toolNames(body: StubRequest["body"]): string[] {
  return Array.isArray(body?.tools) ? (body.tools as Array<{ name?: unknown }>).map((t) => String(t.name)) : [];
}
export function toolResultText(block: Block): string {
  return blocksOf(block.content).map((b) => typeof b.text === "string" ? b.text : "").join("\n");
}
/** Every message the model would see, flattened, so a probe can find a marker anywhere in it. */
export function requestText(body: StubRequest["body"]): string {
  return JSON.stringify(body?.messages ?? []);
}

function sse(id: string, model: string, content: Block[], stop: string): string {
  const events: Array<[string, unknown]> = [["message_start", { type: "message_start", message: {
    id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

export interface MessagesStub { url: string; port: number; requests: StubRequest[]; close(): Promise<void> }

/** Loopback Messages API. Unknown routes answer 404 and are still recorded, so a probe can see
 * every path the CLI asked for. A responder that throws answers 500 and marks the run unusable. */
export async function startMessagesStub(respond: Responder): Promise<MessagesStub & { faults: string[] }> {
  const requests: StubRequest[] = [];
  const faults: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* non-JSON */ }
      const request: StubRequest = { n: requests.length + 1, method: req.method ?? "", path: req.url ?? "", body };
      requests.push(request);
      const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (request.method !== "POST" || !/^\/v1\/messages(?:\?|$)/.test(request.path)) {
        json(404, { type: "error", error: { type: "not_found_error", message: "not scripted" } });
        return;
      }
      let reply: StubReply;
      try { reply = respond(request); } catch (error) {
        faults.push((error as Error).message);
        json(500, { type: "error", error: { type: "api_error", message: "stub responder failed" } });
        return;
      }
      if ("status" in reply) { json(reply.status, { type: "error", error: { type: "invalid_request_error", message: reply.error } }); return; }
      const id = `msg_probe_${request.n}`;
      const model = typeof body?.model === "string" ? body.model : "probe";
      const stop = reply.stop ?? (reply.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
      if (body?.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(sse(id, model, reply.content, stop));
      } else {
        json(200, { id, type: "message", role: "assistant", model, content: reply.content, stop_reason: stop, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      }
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, requests, faults, close: () => close(server) };
}

/** Proxy that answers 403 to everything and records the requested destination. */
export async function startRefusingProxy(): Promise<{ url: string; port: number; destinations: string[]; close(): Promise<void> }> {
  const destinations: string[] = [];
  const server = createServer((req, res) => { destinations.push(`${req.method} ${req.url}`); res.writeHead(403); res.end(); });
  server.on("connect", (req: IncomingMessage, socket: Socket) => {
    socket.on("error", () => {});
    destinations.push(`CONNECT ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, destinations, close: () => close(server) };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------------------------
// Network detector

export interface TraceAttempt { family: string; address: string; port: number | null; line: string }

/** A loopback port with nothing listening: connecting to it fails at once and sends nothing off-host. */
export async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

/**
 * Positive control for the detector, run in every probe process before it measures anything: a
 * traced shell connects to a closed loopback port, and strace must report that attempt. A detector
 * that cannot see this would also miss real traffic, so silence measured through it is "could not
 * run", never a pass.
 */
export async function detectorSeesCanary(scratch: string): Promise<{ ok: boolean; observed: string }> {
  if (!straceAvailable()) return { ok: false, observed: "strace is not installed or cannot trace a child (ptrace denied)" };
  const port = await closedLoopbackPort();
  const traceFile = join(scratch, `canary-${process.pid}.trace`);
  spawnSync("strace", ["-f", "-qq", "-e", "trace=connect", "-o", traceFile, "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: "ignore", timeout: 15_000 });
  let log = "";
  try { log = readFileSync(traceFile, "utf8"); } catch { /* reported below */ }
  const seen = foreignTraceAttempts(log, []).some((attempt) => attempt.port === port);
  return { ok: seen, observed: seen ? `strace recorded the canary connect to 127.0.0.1:${port}` : "strace did not record a canary connect from a traced child" };
}

/** True when strace can trace a child on this host (installed, and ptrace permitted). */
export function straceAvailable(): boolean {
  const result = spawnSync("strace", ["-f", "-qq", "-e", "trace=connect", "-o", "/dev/null", "true"], { stdio: "ignore", timeout: 10_000 });
  return result.status === 0 && !result.error;
}

/**
 * Network destinations in an strace log, other than the allowed loopback ports. Local Unix sockets
 * (for example the nscd user-lookup socket) are not network traffic and are skipped. A loopback
 * address on any other port still counts: a local DNS resolver (127.0.0.53:53) is an outbound
 * lookup, and an unexpected local listener would be a destination the record does not name.
 */
export function foreignTraceAttempts(log: string, allowedPorts: number[]): TraceAttempt[] {
  const out: TraceAttempt[] = [];
  for (const line of log.split("\n")) {
    if (!/\b(?:connect|sendto|sendmsg)\(/.test(line)) continue;
    const family = line.match(/sa_family=(AF_[A-Z0-9]+)/)?.[1];
    if (!family || family === "AF_UNIX" || family === "AF_NETLINK") continue;
    const port = Number(line.match(/sin6?_port=htons\((\d+)\)/)?.[1] ?? NaN);
    const address = line.match(/inet_addr\("([^"]+)"\)/)?.[1] ?? line.match(/inet_pton\(AF_INET6, "([^"]+)"/)?.[1] ?? "";
    if (family === "AF_UNSPEC") continue; // connect(AF_UNSPEC) dissolves a UDP association
    const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
    if (loopback && allowedPorts.includes(port)) continue;
    out.push({ family, address, port: Number.isFinite(port) ? port : null, line: line.replace(/^\d+\s+/, "").slice(0, 200) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running the CLI

export interface ClaudeRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  events: Array<Record<string, unknown>>;
  /** Raw strace log, or null when the run was not traced. */
  trace: string | null;
}

export interface RunOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** strace output path; omitted when the host cannot trace (the caller then reports could not run). */
  traceFile?: string;
  /** Lines written to stdin before any output; stdin then stays open until `closeStdin` or exit. */
  stdin?: string[];
  /** Called for each stdout JSON event; may write to stdin (control responses, steering). */
  onEvent?: (event: Record<string, unknown>, write: (line: string) => void, closeStdin: () => void) => void;
  /**
   * Who handles SIGINT/SIGTERM. "process" (probe processes) kills every owned CLI group and exits 2.
   * "caller" (the suite, which must still stop its own probe and write an interrupted report)
   * installs nothing and cancels through `abort` instead.
   */
  signals?: "process" | "caller";
  abort?: AbortSignal;
}

const owned = new Set<ChildProcess>();
let signalsInstalled = false;
function own(child: ChildProcess): void {
  if (!signalsInstalled) {
    signalsInstalled = true;
    // Cancellation is never a measurement: kill every owned group and exit "could not run".
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      for (const running of owned) killGroup(running);
      process.exit(2);
    });
  }
  owned.add(child);
  child.once("close", () => owned.delete(child));
}
function killGroup(child: ChildProcess): void {
  if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  child.kill("SIGKILL");
}

export function runClaude(options: RunOptions): Promise<ClaudeRun> {
  const argv = options.traceFile
    ? ["strace", "-f", "-qq", "-s", "160", "-e", "trace=connect,sendto,sendmsg", "-o", options.traceFile, options.bin, ...options.args]
    : [options.bin, ...options.args];
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    if (options.signals !== "caller") own(child);
    const cancel = () => killGroup(child);
    if (options.abort?.aborted) cancel();
    options.abort?.addEventListener("abort", cancel, { once: true });
    let stdout = "";
    let pending = "";
    let timedOut = false;
    let spawnError: string | undefined;
    const events: Array<Record<string, unknown>> = [];
    const write = (line: string) => { if (!child.stdin.destroyed) child.stdin.write(line.endsWith("\n") ? line : line + "\n"); };
    const closeStdin = () => { if (!child.stdin.destroyed) child.stdin.end(); };
    child.stdin.on("error", () => {});
    for (const line of options.stdin ?? []) write(line);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (stdout.length > 32 * 1024 * 1024) { timedOut = true; killGroup(child); return; }
      pending += text;
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        events.push(event);
        options.onEvent?.(event, write, closeStdin);
      }
    });
    // Provider stderr is diagnostic only and never persisted in a report.
    child.stderr.resume();
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, options.timeoutMs);
    child.on("error", (error) => { spawnError = error.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.abort?.removeEventListener("abort", cancel);
      let trace: string | null = null;
      if (options.traceFile) { try { trace = readFileSync(options.traceFile, "utf8"); } catch { trace = null; } }
      resolve({ code, signal, timedOut, spawnError, stdout, events, trace });
    });
  });
}

/**
 * The result event of a run that completed cleanly: exit 0, no signal, and a final `success`
 * result that is not an error. Anything else is a CouldNotRun, because a turn that failed after
 * the measured step is not evidence that the measured behaviour held.
 */
export function finalResult(run: ClaudeRun): Record<string, unknown> {
  if (run.spawnError) throw new CouldNotRun(`claude could not start: ${run.spawnError}`);
  if (run.timedOut) throw new CouldNotRun("claude timed out or exceeded the output bound");
  const result = [...run.events].reverse().find((e) => e.type === "result");
  if (!result) throw new CouldNotRun(`claude produced no result event (exit ${run.code ?? run.signal})`);
  if (run.code !== 0 || run.signal) throw new CouldNotRun(`claude exited ${run.code ?? run.signal} after its result event`);
  if (result.is_error === true || result.subtype !== "success") {
    throw new CouldNotRun(`claude's turn ended in ${String(result.subtype)}${result.is_error === true ? " (is_error)" : ""}`);
  }
  return result;
}
