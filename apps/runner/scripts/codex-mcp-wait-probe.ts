/**
 * Measure whether a Codex session can block on one `wait_pull_request` MCP call for a whole CI run
 * without a model request, through the exact `wollipog` entry the runner injects (#3123).
 *
 *   pnpm probe:codex-mcp-wait                       # 31-minute wait; needs a real `codex` on PATH
 *   pnpm probe:codex-mcp-wait -- --seconds 60       # a quick re-check
 *   pnpm probe:codex-mcp-wait -- --seconds 400 --default-limit --without-approval
 *                                                   # also measure the entry without its limit
 *                                                   # (cut off) and without its per-tool approval
 *                                                   # (one Guardian model request first)
 *   pnpm probe:codex-mcp-wait -- --entry orchestrator
 *                                                   # the additive Orchestrator's entry instead
 *   CODEX_BIN=/path/to/codex pnpm probe:codex-mcp-wait
 *
 * This is NOT part of `pnpm test`: it spawns a real `codex app-server` and runs for as long as the
 * wait it measures. It is the evidence behind `CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC` and the per-call
 * limit `skills/using-wollipog/SKILL.md` states for Codex sessions, kept runnable so a future
 * codex-cli can be re-measured instead of re-argued.
 *
 * Nothing here reaches the real network, a real model, or GitHub:
 *
 *   - "the model" is a scripted OpenAI Responses-API server this script starts, selected through a
 *     throwaway `CODEX_HOME`. Its first answer calls `wait_pull_request`; every later answer is a
 *     final message. It records the time of every request, including Codex's own Guardian
 *     requests (`isGuardianRequest`), so "no model request while the call blocks" is counted, not
 *     inferred.
 *   - `wait_pull_request` is a stub stdio MCP server that sleeps for `--seconds` and answers. The
 *     entry that launches it is built by `sessionCodexMcpServerArg`, the function the runner uses,
 *     so the tool-call limit and the per-tool approval are exactly what a session launches with.
 *   - The turn runs under `approval_policy = "on-request"` with Guardian review, the setting in which
 *     an unapproved MCP call would ask a reviewer (a model request) before it starts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC,
  ORCHESTRATOR_ENV_KEY,
  SESSION_CODEX_MCP_MARKER,
  additiveCodexMcpServerArg,
  sessionCodexMcpServerArg,
} from "../src/orchestrator-preset.js";
import { isGuardianRequest, isolatedProbeEnv, unavailableProbeOutput, probeResult, ownProbeProcess } from "./codex-probe-support.js";

const CODEX = process.env.CODEX_BIN || "codex";

export function withoutMcpApproval(entry: string): string {
  const unapproved = entry
    .replace(/, "tools" = \{ "wait_pull_request" = \{ "approval_mode" = "approve" \} \}/u, "")
    .replace(/, "default_tools_approval_mode" = "approve"/u, "");
  if (unapproved === entry) throw new Error("MCP approval control could not remove the grant");
  return unapproved;
}

type Json = Record<string, unknown>;

interface ModelState {
  requests: Array<{ at: number; guardian: boolean }>;
  toolCall: { name: string; namespace?: string } | null;
  agentCalls: number;
}

interface Measurement {
  toolStarted: number | null;
  toolCompleted: number | null;
  toolStatus: string;
  toolOutput: string;
  approvalRequests: number;
  turnEnded: string;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function message(text: string): Json {
  return { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}

/** The function call that reaches the stub's tool. codex-cli 0.162.1 offers MCP tools inside a
 * `namespace` tool named `mcp__<server>`; a call names both. A flat `mcp__<server>__<tool>` function
 * is accepted too, for a codex-cli that offers that form. */
function waitToolCall(body: Json): { name: string; namespace?: string } | null {
  for (const tool of Array.isArray(body.tools) ? body.tools as Json[] : []) {
    if (tool.type === "namespace" && tool.name === "mcp__wollipog" && Array.isArray(tool.tools) &&
        (tool.tools as Json[]).some((inner) => inner.name === "wait_pull_request")) {
      return { namespace: "mcp__wollipog", name: "wait_pull_request" };
    }
    if (tool.name === "mcp__wollipog__wait_pull_request") return { name: tool.name };
  }
  return null;
}

function modelServer(state: ModelState, seconds: number): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Json = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { /* keep {} */ }
      const guardian = isGuardianRequest(request.headers, body);
      state.requests.push({ at: Date.now(), guardian });
      if (!guardian && state.toolCall === null) state.toolCall = waitToolCall(body);
      const step = guardian ? -1 : state.agentCalls++;
      const item: Json = guardian
        ? message(JSON.stringify({ outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "scripted" }))
        : step === 0 && state.toolCall
          ? { type: "function_call", id: "fc", call_id: "call", ...state.toolCall,
              arguments: JSON.stringify({ seconds }), status: "completed" }
          : message("finished");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event: string, data: Json) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("response.created", { type: "response.created", response: { id: "r", status: "in_progress", output: [] } });
      send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      send("response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item] } });
      response.end();
    });
  });
}

/** A stdio MCP server with one tool, `wait_pull_request`, that answers after `seconds`. */
const STUB_SOURCE = `
const { createInterface } = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: {
    protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",
    capabilities: { tools: {} }, serverInfo: { name: "wollipog-probe", version: "0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{
    name: "wait_pull_request", description: "Wait for a pull request.",
    inputSchema: { type: "object", properties: { seconds: { type: "number" } } } }] } });
  else if (m.method === "tools/call") {
    const started = Date.now();
    const seconds = Number((m.params && m.params.arguments && m.params.arguments.seconds) || 1);
    setTimeout(() => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text",
      text: "waited " + Math.round((Date.now() - started) / 1000) + "s" }] } }), seconds * 1000);
  } else if (m.id !== undefined && m.method) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

function killTree(child: ChildProcess): void {
  if (typeof child.pid === "number") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is already gone */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
}

function runTurn(entry: string, root: string, timeoutMs: number): Promise<Measurement> {
  const result: Measurement = {
    toolStarted: null, toolCompleted: null, toolStatus: "never started", toolOutput: "",
    approvalRequests: 0, turnEnded: "no turn",
  };
  const child = ownProbeProcess(spawn(CODEX, ["-c", entry, "app-server"], {
    cwd: join(root, "repo"),
    env: isolatedProbeEnv(join(root, "codex-home")),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  }));
  return new Promise<Measurement>((resolve) => {
    let settled = false;
    const finish = (ended: string) => {
      if (settled) return;
      settled = true;
      result.turnEnded = ended;
      clearTimeout(timer);
      killTree(child);
      resolve(result);
    };
    const timer = setTimeout(() => finish("TIMED OUT"), timeoutMs);
    child.stdin.on("error", (error: Error) => finish(`STDIN FAILED: ${error.message}`));
    const send = (payload: Json) => {
      if (!settled && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* not a frame */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (process.env.PROBE_DEBUG) process.stderr.write(chunk); });
    child.on("error", (error) => finish(`SPAWN FAILED: ${error.message}`));
    child.on("close", () => finish("codex exited"));

    const handle = (msg: Json & { id?: unknown; method?: string; params?: Json; result?: Json }) => {
      if (msg.method && /requestApproval|elicitation/iu.test(msg.method) && msg.id !== undefined) {
        // Any approval the call needs is a human (or reviewer) in the loop; count it and decline.
        result.approvalRequests++;
        send({ jsonrpc: "2.0", id: msg.id, result: { decision: "decline", action: "decline" } });
        return;
      }
      const item = (msg.params?.item ?? {}) as Json;
      if (msg.method === "item/started" && item.type === "mcpToolCall") {
        result.toolStarted = Date.now();
        result.toolStatus = "in progress";
        return;
      }
      if (msg.method === "item/completed" && item.type === "mcpToolCall") {
        result.toolCompleted = Date.now();
        result.toolStatus = String(item.status ?? "unknown");
        result.toolOutput = JSON.stringify(item.result ?? item.error ?? null).slice(0, 200);
        return;
      }
      if (msg.method === "turn/completed" || msg.method === "turn/failed") return finish(msg.method);
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: join(root, "repo") } });
        return;
      }
      if (msg.id === 2) {
        const threadId = ((msg.result?.thread ?? {}) as Json).id;
        send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: {
          threadId, input: [{ type: "text", text: "wait for the pull request" }],
          approvalPolicy: "on-request", approvalsReviewer: "auto_review", cwd: join(root, "repo"),
        } });
      }
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "wollipog-mcp-wait-probe", version: "0" } } });
  });
}

async function measure(name: string, entry: string, seconds: number, root: string, port: number,
  state: ModelState, expect: { completed: boolean; reviewed: boolean }): Promise<boolean> {
  state.requests = [];
  state.toolCall = null;
  state.agentCalls = 0;
  const started = Date.now();
  const result = await runTurn(entry, root, (seconds + 180) * 1000);
  const during = result.toolStarted === null ? [] : state.requests.filter((request) =>
    request.at > result.toolStarted! && request.at < (result.toolCompleted ?? Number.POSITIVE_INFINITY));
  const blocked = result.toolStarted !== null && result.toolCompleted !== null
    ? Math.round((result.toolCompleted - result.toolStarted) / 1000) : null;
  const completed = result.toolStatus === "completed" && result.toolOutput.includes(`waited ${seconds}s`);
  const guardian = state.requests.filter((request) => request.guardian).length;
  const ok = state.toolCall !== null && result.approvalRequests === 0 && completed === expect.completed &&
    (expect.reviewed ? guardian > 0 : guardian === 0 && during.length === 0);
  probeResult(`MCP wait: ${name}`, unavailableProbeOutput(result.turnEnded) || result.toolStarted === null
    ? "could not run" : ok ? "unchanged" : "changed",
    `blocked=${blocked ?? "unknown"}s; completed=${completed}; modelRequestsDuringWait=${during.length}; guardianRequests=${guardian}; clientApprovals=${result.approvalRequests}`,
    "docs/DRIVERS.md; skills/using-wollipog/SKILL.md");
  process.stdout.write([
    `${ok ? "ok  " : "FAIL"}  ${name}`,
    `      tool called as: ${state.toolCall ? JSON.stringify(state.toolCall) : "(not offered in the model request)"}`,
    `      call blocked for: ${blocked ?? "?"}s (asked ${seconds}s); status ${result.toolStatus}; ${result.toolOutput}`,
    `      model requests: ${state.requests.length} in total, ${during.length} after the call started ` +
      `and before it returned, ${guardian} Guardian`,
    `      approval requests to the client: ${result.approvalRequests}; turn: ${result.turnEnded}; ` +
      `elapsed ${Math.round((Date.now() - started) / 1000)}s; model port ${port}`,
    "",
  ].join("\n"));
  return ok;
}

async function main(): Promise<number> {
  const seconds = Number(option("--seconds") ?? 1860);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds * 1000 > CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC * 1000) {
    process.stderr.write(`--seconds must be an integer from 1 to ${CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC}\n`);
    return 2;
  }
  const root = mkdtempSync(join(tmpdir(), "wollipog-mcp-wait-probe-"));
  const state: ModelState = { requests: [], toolCall: null, agentCalls: 0 };
  const models = modelServer(state, seconds);
  let failures = 0;
  try {
    mkdirSync(join(root, "repo"), { recursive: true });
    mkdirSync(join(root, "codex-home"), { recursive: true });
    const stub = join(root, "stub.cjs");
    writeFileSync(stub, STUB_SOURCE);
    const port = await listen(models);
    writeFileSync(join(root, "codex-home", "config.toml"),
      'model = "probe-model"\nmodel_provider = "probe"\n\n' +
      '[model_providers.probe]\nname = "Probe"\n' +
      `base_url = "http://127.0.0.1:${port}/v1"\n` +
      'wire_api = "responses"\nenv_key = "PROBE_KEY"\n');
    const orchestrator = option("--entry") === "orchestrator";
    const entry = orchestrator
      ? additiveCodexMcpServerArg({ command: process.execPath, args: [stub], env: { [ORCHESTRATOR_ENV_KEY]: "orchestrator" } })
      : sessionCodexMcpServerArg({ command: process.execPath, args: [stub], env: { [SESSION_CODEX_MCP_MARKER]: "1" } });
    const cases: Array<[string, string, { completed: boolean; reviewed: boolean }]> = [
      [`runner ${orchestrator ? "Orchestrator" : "session"} entry · ${seconds}s wait`, entry,
        { completed: true, reviewed: false }],
    ];
    if (process.argv.includes("--without-approval")) {
      // Measured on codex-cli 0.162.1: without the per-tool approval, Guardian reviews the call
      // with one model request before it starts (and `on-request` without Guardian asks the human).
      const unapproved = withoutMcpApproval(entry);
      cases.push([`same entry without the per-tool approval · ${seconds}s wait`, unapproved,
        { completed: true, reviewed: true }]);
    }
    if (process.argv.includes("--default-limit")) {
      // Measured on codex-cli 0.162.1: without the limit, Codex cuts the call off at 300 seconds.
      const unbounded = entry.replace(`, "tool_timeout_sec" = ${CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC}`, "");
      cases.push([`same entry without tool_timeout_sec · ${seconds}s wait`, unbounded,
        { completed: seconds < 300, reviewed: false }]);
    }
    for (const [name, candidate, expected] of cases) {
      if (!await measure(name, candidate, seconds, root, port, state, expected)) failures++;
    }
  } finally {
    models.close();
    rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(failures === 0
    ? "All cases matched the recorded measurement.\n"
    : `${failures} case(s) did NOT match. Codex's behaviour has moved; re-measure before changing ` +
      "CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC or the skill's stated limit.\n");
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  probeResult("MCP wait matrix", "could not run", "fixture or compatible app-server unavailable", "docs/DRIVERS.md; skills/using-wollipog/SKILL.md");
  process.exitCode = 2;
});
