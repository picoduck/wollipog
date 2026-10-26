/** Optional diagnostic contracts only. Never used by discovery or provider launch eligibility. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedProbeEnv, probeResult, ownProbeProcess } from "./codex-probe-support.js";
import { codexHttpFallbackWarning, codexInferenceConfiguration } from "../src/drivers/codex-inference-transport.js";

type Json = Record<string, any>;
const root = mkdtempSync(join(tmpdir(), "wollipog-codex-diagnostics-"));
const home = join(root, "home");
const repo = join(root, "repo");
const documentation = "docs/DRIVERS.md#openai-inference-transport";
function record(assumption: string, ok: boolean, observed: string): void {
  console.log(JSON.stringify({ event: "codex_assumption", assumption, status: ok ? "unchanged" : "optional drift", observed, documentation, optional: true }));
}

async function main(): Promise<void> {
  mkdirSync(repo);
  mkdirSync(home);
  // Reject WebSocket upgrades so the actual CLI can emit its fallback warning. HTTP is scripted.
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const item = { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "finished" }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [event, value] of [
        ["response.created", { response: { id: "r", status: "in_progress", output: [] } }],
        ["response.output_item.done", { output_index: 0, item }],
        ["response.completed", { response: { id: "r", status: "completed", output: [item] } }],
      ] as const) response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...value })}\n\n`);
      response.end();
    });
  });
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(home, "config.toml"),
    'model = "gpt-6.1-sol"\nmodel_provider = "probe"\n' +
    '[model_providers.probe]\nname = "Probe"\n' +
    `base_url = "http://127.0.0.1:${port}/v1"\n` +
    'wire_api = "responses"\nenv_key = "PROBE_KEY"\nsupports_websockets = true\n');
  const child = ownProbeProcess(spawn(process.env.CODEX_BIN || "codex", ["app-server"], {
    cwd: repo, env: isolatedProbeEnv(home), stdio: ["pipe", "pipe", "pipe"], detached: true,
  }));
  let seq = 0;
  let expired = false;
  let exited = false;
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  let buffer = "";
  let warningShape = false;
  let fallback = false;
  let completed: (() => void) | undefined;
  const send = (payload: Json) => child.stdin.write(JSON.stringify(payload) + "\n");
  const rpc = (method: string, params: Json) => new Promise<Json>((resolve, reject) => {
    if (expired || exited) { reject(new Error("app-server unavailable")); return; }
    const id = ++seq;
    const deadline = setTimeout(() => {
      pending.delete(id); reject(new Error("RPC unavailable"));
    }, method === "config/read" ? 1000 : 15_000);
    pending.set(id, { resolve: value => { clearTimeout(deadline); resolve(value); }, reject: error => { clearTimeout(deadline); reject(error); } });
    send({ jsonrpc: "2.0", id, method, params });
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
    fallback ||= stderr.split("\n").some(codexHttpFallbackWarning);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let frame: Json; try { frame = JSON.parse(line); } catch { continue; }
      if (pending.has(frame.id)) {
        const request = pending.get(frame.id)!; pending.delete(frame.id);
        frame.error ? request.reject(new Error("optional RPC unavailable")) : request.resolve(frame.result);
      }
      if (frame.method === "warning") {
        warningShape ||= typeof frame.params?.message === "string";
        fallback ||= codexHttpFallbackWarning(frame.params?.message);
      }
      if (frame.method === "turn/completed" || frame.method === "turn/failed") completed?.();
    }
  });
  const rejectPending = () => { for (const request of pending.values()) request.reject(new Error("app-server unavailable")); pending.clear(); };
  child.on("error", () => { exited = true; rejectPending(); completed?.(); });
  child.on("close", () => { exited = true; rejectPending(); completed?.(); });
  child.stdin.on("error", rejectPending);
  const timeout = setTimeout(() => { expired = true; rejectPending(); completed?.(); }, 60_000);
  try {
    const identity = await rpc("initialize", { clientInfo: { name: "wollipog", version: "0" } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const started = await rpc("thread/start", { cwd: repo, modelProvider: "probe", ephemeral: true });
    record("optional thread/start.modelProvider", started.modelProvider === "probe",
      started.modelProvider === "probe" ? "scripted custom provider identity present" : "unavailable; provider=unknown, configuredTransport=unknown");
    let config: Json | undefined;
    try { config = (await rpc("config/read", { cwd: repo, includeLayers: false })).config; } catch { /* optional */ }
    const classification = codexInferenceConfiguration(started.modelProvider, config, identity.userAgent ?? "");
    record("optional config/read model_providers.supports_websockets", classification.reason === "custom_provider_opt_in",
      `provider=${classification.provider}; configuredTransport=${classification.configuredTransport}; observedTransport=unverified`);
    const done = new Promise<void>(resolve => { completed = resolve; });
    await rpc("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "finish" }], approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    await done;
    record("optional transport warning payload", warningShape && fallback,
      warningShape && fallback ? "warning.message recognized; HTTP fallback observed" : "fallback warning unavailable or changed; observedTransport=unverified (never WebSocket success)");
  } finally {
    clearTimeout(timeout);
    const closed = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("close", () => resolve()); });
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }
    await closed;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

try { await main(); }
catch { probeResult("optional transport diagnostics", "could not run", "isolated app-server fixture unavailable", documentation); process.exitCode = 2; }
finally { rmSync(root, { recursive: true, force: true }); }
