/** Live, opt-in verification of Codex-to-OpenAI inference, separate from the hosting stack.
 * Uses an existing ChatGPT account in a private temporary home; never logs credentials,
 * headers, prompts, tool arguments/results, response text, endpoint URLs, or provider ids.
 * The loopback observer forwards bytes to the fixed official TLS endpoint and records only
 * protocol counts/booleans. Every case launches the actual Wollipog App Server driver.
 *
 *   pnpm probe:codex-inference-transport
 * Requires existing file-backed ChatGPT authentication and network access. No login or grants.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { CodexAppServerDriver, CodexAppServerResumeError } from "../src/drivers/codex-app-server.js";
import type { DriverCallbacks, DriverOptions } from "../src/drivers/driver.js";
import { spawnAgent } from "../src/spawn.js";
import { codexProbeAccessCredentials } from "../src/drivers/codex-probe-auth.js";

const MODEL = process.env.CODEX_PROBE_MODEL || "gpt-6.1-sol";
const CODEX = process.env.CODEX_BIN || "codex";
const forceHttpFallback = process.argv.includes("--force-http-fallback");
const SOURCE_AUTH = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
const SOURCE_DIGEST = () => createHash("sha256").update(readFileSync(SOURCE_AUTH)).digest("hex");
let authBefore: string;
let accessCredentials: ReturnType<typeof codexProbeAccessCredentials>;
try {
  const auth = JSON.parse(readFileSync(SOURCE_AUTH, "utf8"));
  accessCredentials = codexProbeAccessCredentials(auth);
  if (!/^[A-Za-z0-9._:-]+$/.test(MODEL)) throw new Error();
  authBefore = SOURCE_DIGEST();
} catch {
  console.log(JSON.stringify({ event: "codex_inference_probe", passed: false, reason: "existing_auth_or_model_unavailable" }));
  process.exit(1);
}
const root = mkdtempSync(join(tmpdir(), "codex-inference-transport-"));
const codexHome = join(root, "codex");
const cwd = join(root, "project");
// The preset requires a Wollipog MCP inventory entry. Supply an inert, local stdio server with
// no tools so the verifier cannot reach campaign management or grant any new capability.
const inertMcp = join(root, "inert-mcp.mjs");
const inertMcpSource = `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'inert-transport-probe', version: '1' } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`;

interface Observation {
  upstreamWebsocketConnections: number;
  modelRequests: number;
  httpModelRequests: number;
  toolResultRequests: number;
  continuedOnSameSocket: boolean;
  chainedAfterToolResult: boolean;
  completedAfterToolResult: boolean;
  selectedModelPreserved: boolean;
  protocolFailures: number;
}
function emptyObservation(): Observation {
  return { upstreamWebsocketConnections: 0, modelRequests: 0, httpModelRequests: 0,
    toolResultRequests: 0, continuedOnSameSocket: false, chainedAfterToolResult: false,
    completedAfterToolResult: false, selectedModelPreserved: true, protocolFailures: 0 };
}
let current = emptyObservation();
const sockets = new Set<WebSocket>();
const httpRequests = new Set<ReturnType<typeof httpsRequest>>();
const observer = new WebSocketServer({ noServer: true });
const server = createServer((req, res) => {
  if (!req.url?.startsWith("/backend-api/codex/")) { res.writeHead(404).end(); return; }
  const observation = current;
  if (req.url.split("?")[0] === "/backend-api/codex/responses") observation.httpModelRequests++;
  const upstream = httpsRequest({ hostname: "chatgpt.com", path: req.url, method: req.method,
    headers: { ...req.headers, host: "chatgpt.com" } }, reply => {
    reply.on("error", () => upstream.destroy(new Error("upstream_response_error")));
    if (res.destroyed) { reply.destroy(); return; }
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
  });
  httpRequests.add(upstream);
  upstream.on("close", () => httpRequests.delete(upstream));
  upstream.setTimeout(120_000, () => upstream.destroy(new Error("upstream_timeout")));
  upstream.on("error", () => {
    observation.protocolFailures++;
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else res.writeHead(502).end();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
server.on("upgrade", (req, socket, head) => {
  if (req.url?.split("?")[0] !== "/backend-api/codex/responses") { socket.destroy(); return; }
  if (forceHttpFallback) { socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
  const observation = current;
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
    !["host", "connection", "upgrade"].includes(key) && !key.startsWith("sec-websocket-")));
  const upstream = new WebSocket(`wss://chatgpt.com${req.url}`, { headers });
  sockets.add(upstream);
  let downstream: WebSocket | undefined;
  const toolCalls = new Set<string>();
  let toolResultSent = false;
  const fail = () => { observation.protocolFailures++; socket.destroy(); upstream.terminate(); downstream?.terminate(); };
  upstream.on("error", fail);
  upstream.once("open", () => {
    observation.upstreamWebsocketConnections++;
    observer.handleUpgrade(req, socket, head, client => {
      downstream = client;
      sockets.add(client);
      client.on("error", fail);
      client.on("message", (bytes, binary) => {
        if (!binary) {
          try {
            const message = JSON.parse(bytes.toString());
            if (message.type === "response.create" && message.generate !== false) {
              observation.modelRequests++;
              observation.selectedModelPreserved &&= message.model === MODEL;
              if (Array.isArray(message.input) && message.input.some((item: { type?: string; call_id?: string }) =>
                (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
                typeof item.call_id === "string" && toolCalls.has(item.call_id))) {
                observation.toolResultRequests++;
                observation.continuedOnSameSocket = true;
                observation.chainedAfterToolResult ||= typeof message.previous_response_id === "string";
                toolResultSent = true;
              }
            }
          } catch { observation.protocolFailures++; }
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
      });
      upstream.on("message", (bytes, binary) => {
        if (!binary) {
          try {
            const message = JSON.parse(bytes.toString());
            if (message.type === "response.output_item.done" &&
                ["function_call", "custom_tool_call"].includes(message.item?.type) &&
                typeof message.item.call_id === "string") toolCalls.add(message.item.call_id);
            if (message.type === "response.completed" && toolResultSent) observation.completedAfterToolResult = true;
          } catch { observation.protocolFailures++; }
        }
        if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary });
      });
      client.on("close", () => { sockets.delete(client); upstream.close(); });
      upstream.on("close", () => { sockets.delete(upstream); client.close(); });
    });
  });
});

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("probe_timeout")), 120_000);
    })]);
  } finally { clearTimeout(timer!); }
}

const results: unknown[] = [];
try {
  mkdirSync(codexHome, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  // Access-only credentials cannot rotate the shared account's server-side refresh token.
  // Codex's required refresh_token field is empty; failed/expired access needs human recovery.
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify(accessCredentials), { mode: 0o600 });
  writeFileSync(inertMcp, inertMcpSource, { mode: 0o600 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const args = [
    "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
    "--disable", "browser_use", "--disable", "computer_use", "--disable", "multi_agent",
    "--disable", "image_generation", "--disable", "code_mode_host",
    "-c", `openai_base_url="http://127.0.0.1:${port}/backend-api/codex"`,
    "-c", "cli_auth_credentials_store=\"file\"", "-c", "forced_login_method=\"chatgpt\"",
    "-c", "project_doc_max_bytes=0", "-c", `model="${MODEL}"`,
    "-c", "model_reasoning_effort=\"high\"",
  ];
  const roles = forceHttpFallback ? ["standard"] as const : ["standard", "orchestrator", "orchestrator_preset"] as const;
  for (const role of roles) {
    let resumeId: string | undefined;
    const lifecycles = forceHttpFallback ? ["new"] as const : ["new", "resume_relaunch"] as const;
    for (const lifecycle of lifecycles) {
      current = emptyObservation();
      let fallback = false;
      let authenticationRequired = false;
      const transportDiagnostics: unknown[] = [];
      const options: DriverOptions = {
        command: CODEX, args: role === "orchestrator_preset" ? [...args,
          "-c", `mcp_servers.wollipog.command=${JSON.stringify(process.execPath)}`,
          "-c", `mcp_servers.wollipog.args=[${JSON.stringify(inertMcp)}]`,
        ] : args, cwd, env: { CODEX_HOME: codexHome }, context: { kind: "native" }, resumeId,
        config: { model: MODEL, effort: "high", permissionMode: role === "orchestrator_preset" ? "orchestrator" : "auto-review" },
        ...(role === "orchestrator" ? { orchestrator: { strictProjectIsolation: false, integrationIsolation: false } } : {}),
      };
      const callbacks: DriverCallbacks = {
        onEvent: event => {
          // No approval/grant is needed for the harmless probe command. Decline any unexpected
          // request rather than authorizing an action or exposing its contents.
          if (event.kind === "permission_request") driver.resolvePermission(event.requestId, "decline");
        },
        onStderr: line => {
          try {
            const record = JSON.parse(line);
            if (record.event === "codex_inference_transport") {
              // Keep only our bounded diagnostic classifications even if unrelated raw provider
              // stderr imitates the event name. Never forward a whole provider-controlled object.
              if (["configuration", "fallback"].includes(record.phase) &&
                  ["openai", "custom", "unknown"].includes(record.provider) &&
                  ["websocket", "http", "unknown"].includes(record.configuredTransport) &&
                  ["unverified", "http"].includes(record.observedTransport)) {
                transportDiagnostics.push({ phase: record.phase, provider: record.provider,
                  configuredTransport: record.configuredTransport, observedTransport: record.observedTransport });
              }
              if (record.phase === "fallback") fallback = true;
            }
          } catch { /* Raw provider diagnostics are intentionally discarded. */ }
        },
        onExit: () => {},
        onAuthenticationFailure: () => { authenticationRequired = true; },
      };
      let exited: Promise<unknown> = Promise.resolve();
      const driver = new CodexAppServerDriver(options, callbacks, undefined, {
        spawn: launch => {
          const child = spawnAgent(launch);
          exited = once(child, "close").catch(() => undefined);
          return child;
        },
      });
      let phase = "initialize";
      try {
        await bounded(driver.initialize());
        phase = "new_session";
        resumeId = await bounded(driver.newSession(cwd));
        phase = "prompt";
        const stop = await bounded(driver.prompt(
          'Run exec_command once with cmd "printf WS_PROBE_OK". After its tool result, reply with just OK. Do not call any other tool.',
        ));
        const websocketPassed = stop === "end_turn" && current.upstreamWebsocketConnections > 0 &&
          current.modelRequests >= 2 && current.httpModelRequests === 0 && current.toolResultRequests > 0 &&
          current.continuedOnSameSocket && current.completedAfterToolResult && current.selectedModelPreserved &&
          current.protocolFailures === 0 && !fallback && !authenticationRequired;
        const passed = forceHttpFallback
          ? stop === "end_turn" && current.upstreamWebsocketConnections === 0 && current.httpModelRequests >= 2 && fallback && !authenticationRequired
          : websocketPassed;
        const result = { role, lifecycle, passed, stop, ...current, fallback, authenticationRequired, transportDiagnostics };
        results.push(result);
        console.log(JSON.stringify({ event: "codex_inference_probe_case", ...result }));
        if (!passed) throw new Error("live_transport_unverified");
      } catch (error) {
        console.log(JSON.stringify({ event: "codex_inference_probe_error", role, lifecycle, phase,
          resumeConflict: error instanceof CodexAppServerResumeError && error.retryable,
          rpcCode: typeof (error as { code?: unknown })?.code === "number" ? (error as { code: number }).code : undefined,
          ...current, authenticationRequired }));
        throw error;
      } finally {
        driver.dispose();
        // Await process exit before starting the next process over the same persisted thread.
        await bounded(exited);
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        for (const request of httpRequests) request.destroy();
        httpRequests.clear();
      }
    }
  }
  const existingAuthenticationUnchanged = authBefore === SOURCE_DIGEST();
  console.log(JSON.stringify({ event: "codex_inference_probe", passed: existingAuthenticationUnchanged,
    mode: forceHttpFallback ? "http_fallback" : "websocket", cases: results.length, existingAuthenticationUnchanged }));
  if (!existingAuthenticationUnchanged) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ event: "codex_inference_probe", passed: false, completedCases: results.length,
    existingAuthenticationUnchanged: authBefore === SOURCE_DIGEST() }));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  for (const request of httpRequests) request.destroy();
  observer.close();
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
