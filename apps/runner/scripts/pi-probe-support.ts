import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import dns from "node:dns";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { ownProbeProcess } from "./codex-probe-support.js";

export type Json = Record<string, any>;
export type PiProbeStatus = "unchanged" | "changed" | "could not run";
export const PI_ASSUMPTION_EVENT = "pi_assumption";
export const PI_PROBE_DOCUMENTATION = "docs/pi-assumption-probes.md";
export const PI_PROBE_MODEL = { provider: "probe", id: "probe-model" } as const;
const OBSERVER = new URL("./pi-net-observer.mjs", import.meta.url);

/** The measured result must be one of the three contract statuses; the suite rejects anything else. */
export function piResult(assumption: string, status: PiProbeStatus, observed: string, documentation = PI_PROBE_DOCUMENTATION): PiProbeStatus {
  console.log(JSON.stringify({ event: PI_ASSUMPTION_EVENT, assumption, status, observed, documentation }));
  return status;
}

export function piProbeExit(statuses: PiProbeStatus[]): number {
  return statuses.includes("could not run") || !statuses.length ? 2 : statuses.includes("changed") ? 1 : 0;
}

export interface PiSandbox {
  root: string;
  home: string;
  agentDir: string;
  project: string;
  netLog: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** A fresh HOME, agent directory and project per run. process.env is deliberately not spread, so no
 * provider credential, endpoint or user configuration reaches Pi; the only key is the dummy one the
 * scripted loopback provider accepts. */
export function createPiSandbox(label: string): PiSandbox {
  const root = mkdtempSync(join(tmpdir(), `wollipog-pi-${label}-`));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const project = join(root, "project");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true });
  const netLog = join(root, "net.jsonl");
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", BASH_ENV: "/dev/null", ENV: "/dev/null",
    LANG: "C.UTF-8", TERM: "dumb", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    NODE_OPTIONS: `--import=${OBSERVER.href}`, PI_PROBE_NET_LOG: netLog,
  };
  return { root, home, agentDir, project, netLog, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeProbeModels(sandbox: PiSandbox, port: number): void {
  writeFileSync(join(sandbox.agentDir, "models.json"), JSON.stringify({ providers: { [PI_PROBE_MODEL.provider]: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "scripted-local-provider",
    models: [{ id: PI_PROBE_MODEL.id, name: "Probe Model", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }, null, 2));
  writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify({
    defaultProvider: PI_PROBE_MODEL.provider, defaultModel: PI_PROBE_MODEL.id, defaultThinkingLevel: "off",
  }));
}

/** Non-loopback attempts the observer recorded in Node processes of this sandbox. */
export function observedExternalAttempts(sandbox: PiSandbox): Json[] {
  let text = "";
  try { text = readFileSync(sandbox.netLog, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Json).filter(entry => entry.allowed === false);
}

export function observerLoaded(sandbox: PiSandbox): boolean {
  try { return readFileSync(sandbox.netLog, "utf8").includes('"observer_loaded"'); } catch { return false; }
}

export interface ScriptedTurn { text?: string; reasoning?: string; toolCalls?: { name: string; arguments: Json }[]; holdMs?: number }
export interface ScriptedProvider { port: number; requests: Json[]; close(): Promise<void> }

/** OpenAI-compatible chat-completions stream served on 127.0.0.1 only. */
export async function startScriptedProvider(reply: (body: Json, index: number) => ScriptedTurn): Promise<ScriptedProvider> {
  const requests: Json[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
      let parsed: Json = {};
      try { parsed = JSON.parse(body); } catch { /* recorded as empty */ }
      requests.push(parsed);
      const turn = reply(parsed, requests.length - 1);
      const chunk = (delta: Json, finish: string | null) => `data: ${JSON.stringify({ id: `probe-${requests.length}`, object: "chat.completion.chunk",
        created: 0, model: PI_PROBE_MODEL.id, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const finish = () => {
        if (response.destroyed) return;
        if (turn.reasoning) response.write(chunk({ role: "assistant", reasoning_content: turn.reasoning }, null));
        if (turn.text) response.write(chunk({ role: "assistant", content: turn.text }, null));
        if (turn.toolCalls?.length) response.write(chunk({ tool_calls: turn.toolCalls.map((call, index) => ({ index, id: `call_probe_${index + 1}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, null));
        response.write(chunk({}, turn.toolCalls?.length ? "tool_calls" : "stop"));
        response.write(`data: ${JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: 0, model: PI_PROBE_MODEL.id, choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      };
      if (turn.holdMs) setTimeout(finish, turn.holdMs).unref(); else finish();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: (server.address() as net.AddressInfo).port,
    requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export function systemPromptOf(body: Json): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.filter((m: Json) => m?.role === "system" || m?.role === "developer")
    .map((m: Json) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: Json) => p?.text ?? "").join("") : "")
    .join("\n");
}

/** Strict LF-framed JSONL client for a Pi-compatible RPC process (real Pi or fake-pi-rpc.mjs). */
export class PiRpcClient {
  readonly events: Json[] = [];
  stderr = "";
  exitCode: number | null | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters = new Set<(event: Json) => void>();
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private readonly closed: Promise<void>;

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = ownProbeProcess(spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }));
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let newline: number;
      while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
        let line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (!line.length) continue;
        let event: Json;
        try { event = JSON.parse(line.toString("utf8")); } catch { event = { type: "__unparsed__" }; }
        this.events.push(event);
        for (const waiter of [...this.waiters]) waiter(event);
      }
    });
    this.closed = new Promise(resolve => {
      this.child.once("error", () => { this.exitCode = null; resolve(); });
      this.child.once("close", code => { this.exitCode = code; resolve(); });
    });
  }

  send(record: Json): void { if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(record) + "\n"); }

  /** Observe every later record, e.g. to answer extension UI requests as the driver would. */
  listen(listener: (event: Json) => void): void { this.waiters.add(listener); }

  /** Resolve with the matching response, or reject on timeout or process exit. */
  request(command: Json, timeoutMs = 20_000): Promise<Json> {
    const id = `probe-${++this.seq}`;
    const response = this.waitFor(event => event.type === "response" && event.id === id, timeoutMs, `response to ${command.type}`);
    this.send({ ...command, id });
    return response;
  }

  waitFor(predicate: (event: Json) => boolean, timeoutMs: number, label = "event"): Promise<Json> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const done = (error?: Error, event?: Json) => {
        clearTimeout(timer); this.waiters.delete(waiter);
        if (error) reject(error); else resolve(event!);
      };
      const waiter = (event: Json) => { if (predicate(event)) done(undefined, event); };
      const timer = setTimeout(() => done(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.add(waiter);
      void this.closed.then(() => { if (this.waiters.has(waiter)) done(new Error(`process exited (${this.exitCode}) before ${label}`)); });
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.pid && process.platform !== "win32") { try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* gone */ } }
      this.child.kill("SIGKILL");
    }, 5000);
    await this.closed;
    clearTimeout(timer);
    if (this.child.pid && process.platform !== "win32") { try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* group already gone */ } }
  }
}

export function piCommand(): string { return process.env.PI_BIN || "pi"; }

export interface IsolationResult { verified: boolean; observed: string }

/** Negative control run inside the probe's own process before any Pi launch: a distinct network
 * namespace containing only loopback, where a TEST-NET connect and a DNS lookup fail at once while
 * loopback still works. Without a launcher-provided namespace this always reports unverified. */
export async function verifyNetworkIsolation(env: NodeJS.ProcessEnv = process.env): Promise<IsolationResult> {
  const mechanism = env.PI_PROBE_ISOLATION;
  if (!mechanism) return { verified: false, observed: `no network namespace is available (${env.PI_PROBE_ISOLATION_UNAVAILABLE || "suite did not provide one"}); the Node observer alone is not isolation` };
  const facts: string[] = [];
  let ok = true;
  const fail = (fact: string) => { ok = false; facts.push(fact); };
  let namespace = "";
  try { namespace = readlinkSync("/proc/self/ns/net"); } catch { /* checked below */ }
  if (!namespace || namespace === env.PI_PROBE_OUTER_NETNS) fail(`network namespace ${namespace || "unreadable"} is the suite's own`);
  else facts.push(`namespace ${namespace} differs from the suite's ${env.PI_PROBE_OUTER_NETNS}`);
  let interfaces: string[] = [];
  try {
    interfaces = readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).map(line => line.split(":")[0]!.trim()).filter(Boolean);
  } catch { /* checked below */ }
  if (interfaces.length !== 1 || interfaces[0] !== "lo") fail(`interfaces ${JSON.stringify(interfaces)} are not loopback-only`);
  else facts.push("interfaces: lo only");
  // Never send the external controls from a namespace already shown to have real interfaces.
  if (!ok) return { verified: false, observed: `${mechanism}: ${facts.join("; ")}` };
  const external = await new Promise<string>(resolve => {
    const socket = net.connect({ host: "192.0.2.1", port: 9 });
    const timer = setTimeout(() => { socket.destroy(); resolve("no failure within 3 s"); }, 3000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code ?? error.message); });
  });
  if (external !== "ENETUNREACH" && external !== "EHOSTUNREACH") fail(`TEST-NET connect: ${external}`);
  else facts.push(`TEST-NET 192.0.2.1:9 connect refused with ${external}`);
  const lookup = await Promise.race([
    dns.promises.lookup("example.com").then(() => "resolved", (error: NodeJS.ErrnoException) => error.code ?? "failed"),
    new Promise<string>(resolve => setTimeout(() => resolve("no answer within 5 s"), 5000).unref()),
  ]);
  if (lookup === "resolved") fail("DNS lookup of example.com resolved");
  else facts.push(`DNS lookup failed (${lookup})`);
  const loopback = await new Promise<boolean>(resolve => {
    const server = net.createServer(socket => socket.end()).listen(0, "127.0.0.1", () => {
      const socket = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); server.close(); resolve(true); });
      socket.once("error", () => { server.close(); resolve(false); });
    });
    server.once("error", () => resolve(false));
  });
  if (!loopback) fail("loopback is unusable"); else facts.push("loopback reachable");
  return { verified: ok, observed: `${mechanism}: ${facts.join("; ")}` };
}

export function writeFixtureFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}
