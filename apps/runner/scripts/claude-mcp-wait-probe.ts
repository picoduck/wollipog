/**
 * Measure whether a Claude Code session can block on one long `wollipog` wait through the exact
 * entry the runner writes into its `--mcp-config` file (#4072), and get the tool's own result back.
 *
 *   pnpm probe:claude-mcp-wait                      # wait_pull_request for 45 minutes and
 *                                                   # wait_session for 60, side by side; needs a
 *                                                   # real `claude` on PATH
 *   pnpm probe:claude-mcp-wait -- --tool wait_pull_request --minutes 45
 *   pnpm probe:claude-mcp-wait -- --minutes 3 --idle-ms 60000 --without-limit
 *                                                   # a quick scaled re-check: a 1-minute global
 *                                                   # idle limit, with and without the entry's limit
 *   CLAUDE_BIN=/path/to/claude pnpm probe:claude-mcp-wait
 *
 * This is NOT part of `pnpm test`: it spawns a real `claude -p` and runs for as long as the waits it
 * measures. It is the evidence behind `CLAUDE_WOLLIPOG_MCP_TIMEOUT_MS` and the per-call limit
 * `skills/using-wollipog/SKILL.md` states for Claude Code sessions, kept runnable so a future
 * Claude Code release can be re-measured instead of re-argued.
 *
 * Nothing here reaches the real network, a real model, GitHub, or the control plane:
 *
 *   - "the model" is a scripted Anthropic Messages API server this script starts, selected with
 *     `ANTHROPIC_BASE_URL` and a placeholder API key in a throwaway `CLAUDE_CONFIG_DIR`, so neither
 *     the user's sign-in nor their settings are read. Its first answer calls the wait tool; every
 *     later answer is a final message. It records the tool result Claude Code delivers back, so the
 *     outcome is what the model would have seen, not what the server meant to send.
 *   - The MCP server is the runner's own `serveSessionManagementMcp`, so the wait handlers run
 *     unmodified with their real clock. Only their reads are stubbed: `gh` reports a pull request
 *     whose one required check never finishes, and the control plane reports a session that stays
 *     `running`. The entry that launches it is built by `claudeWollipogMcpServer`, the function the
 *     runner uses for native and WSL launches, so the per-server limit is exactly what a session
 *     launches with.
 *   - `--without-limit` also runs the same entry without its `timeout`, which is what every other
 *     MCP server gets: Claude Code's idle limit should abort it.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GhRunner } from "../src/campaign-forge-status.js";
import { CLAUDE_WOLLIPOG_MCP_TIMEOUT_MS, claudeWollipogMcpServer } from "../src/claude-wollipog-mcp.js";
import { serveSessionManagementMcp, type McpFetch } from "../src/session-management-mcp.js";

const CLAUDE = process.env.CLAUDE_BIN || "claude";
const KEEP = process.env.CLAUDE_PROBE_KEEP === "1";
const CHILD = "s_probe_child";
const SELF = "s_probe_self";
const REPOSITORY = "probe-owner/probe-repo";
const HEAD = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
const AGGREGATOR = "Probe Required Check";
/** Claude Code's idle limit for a stdio MCP call when nothing configures it. */
const CLAUDE_DEFAULT_STDIO_IDLE_MS = 1_800_000;

type WaitTool = "wait_pull_request" | "wait_session";
type Json = Record<string, unknown>;

const DEFAULT_MINUTES: Record<WaitTool, number> = { wait_pull_request: 45, wait_session: 60 };

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function toolInput(tool: WaitTool, timeoutMs: number): Json {
  return tool === "wait_pull_request"
    ? { pullRequest: `${REPOSITORY}#7`, headSha: HEAD, timeoutMs, intervalMs: 60_000 }
    : { sessionId: CHILD, states: ["completed", "failed", "stopped"], timeoutMs, intervalMs: 5_000 };
}

/** MCP server mode: the runner's real tool table over stdio, with `gh` and the control plane
 * stubbed to report a wait that never finishes. Every read is logged, so the probe can show the
 * handler stayed alive for the whole wait. */
function serve(logPath: string): void {
  const log = (event: string) => appendFileSync(logPath, `${JSON.stringify({ event, at: Date.now() })}\n`);
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch: McpFetch = async (url, init) => {
    if ((init?.method ?? "GET") === "GET" && url.endsWith(`/api/sessions/${CHILD}`)) {
      log("session_read");
      return reply(200, { session: { id: CHILD, title: "Probe child", status: "running", runnerId: "r_probe" } });
    }
    return reply(404, { error: "not stubbed" });
  };
  const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });
  const gh: GhRunner = async (args) => {
    if (args.includes("graphql")) {
      log("pull_request_read");
      return ok({ data: { repository: {
        defaultBranchRef: { name: "main" },
        pullRequest: {
          url: `https://github.com/${REPOSITORY}/pull/7`, state: "OPEN", isDraft: false, headRefOid: HEAD,
          baseRefName: "main", mergeStateStatus: "BLOCKED", mergeCommit: null, mergeQueueEntry: null,
          createdAt: "2026-11-01T10:00:00Z", timelineItems: { nodes: [] },
          commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{
            __typename: "CheckRun", name: AGGREGATOR, status: "IN_PROGRESS", conclusion: null,
            startedAt: "2026-11-01T10:00:00Z", detailsUrl: `https://github.com/${REPOSITORY}/actions/runs/1`, isRequired: true,
          }] } } } }] },
        },
      } } });
    }
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.includes("/rules/branches/")) {
      return ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: AGGREGATOR }] } }]);
    }
    if (path.includes("/branches/")) return ok({ name: "main", protected: false });
    return { stdout: "", stderr: `unexpected gh ${args.join(" ")}`, code: 1, timedOut: false };
  };
  serveSessionManagementMcp(process.stdin, process.stdout, {
    fetch, gh, cpUrl: "http://control-plane.probe.invalid", selfSessionId: SELF, token: "",
  });
}

interface ModelState {
  /** The tool result Claude Code delivered back to the model, and when. */
  result: { text: string; isError: boolean; at: number } | null;
  toolCalled: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: Json) => typeof block?.text === "string" ? block.text : "").join("\n");
}

/** A scripted Anthropic Messages API. The first request that offers the wait tool gets a call to
 * it; the request carrying its result gets a final message; anything else (Claude Code's own side
 * requests) gets a short text answer. */
function modelServer(state: ModelState, toolName: string, input: Json): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Json = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { /* keep {} */ }
      if (!request.url?.startsWith("/v1/messages") || request.method !== "POST") {
        response.writeHead(request.url?.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages as Json[] : [];
      const lastContent = messages.at(-1)?.content;
      const toolResult = Array.isArray(lastContent)
        ? (lastContent as Json[]).find((block) => block?.type === "tool_result" && block.tool_use_id === "toolu_probe_wait")
        : undefined;
      const offersTool = Array.isArray(body.tools) && (body.tools as Json[]).some((tool) => tool?.name === toolName);
      let block: Json;
      if (toolResult) {
        state.result ??= { text: textOf(toolResult.content), isError: toolResult.is_error === true, at: Date.now() };
        block = { type: "text", text: "finished" };
      } else if (offersTool && !state.toolCalled) {
        state.toolCalled = true;
        block = { type: "tool_use", id: "toolu_probe_wait", name: toolName, input };
      } else {
        block = { type: "text", text: "ok" };
      }
      const stopReason = block.type === "tool_use" ? "tool_use" : "end_turn";
      const message = {
        id: "msg_probe", type: "message", role: "assistant", model: String(body.model ?? "probe"),
        content: [block], stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (data: Json) => response.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
      send({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
      if (block.type === "tool_use") {
        send({ type: "content_block_start", index: 0, content_block: { ...block, input: {} } });
        send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      } else {
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: String(block.text) } });
      }
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
      send({ type: "message_stop" });
      response.end();
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

interface RunResult {
  tool: WaitTool;
  entryTimeoutMs: number | null;
  idleLimitMs: number;
  requestedTimeoutMs: number;
  /** Stub reads by the handler: proof it kept polling for the whole wait. */
  reads: number;
  /** From the first read to the result Claude Code delivered to the model. */
  deliveredAfterMs: number | null;
  outcome: string;
  isError: boolean | null;
  harnessAbort: boolean;
  resultExcerpt: string;
  exitCode: number | null;
  expected: "tool_result" | "harness_abort";
  passed: boolean;
}

async function measure(tool: WaitTool, minutes: number, withLimit: boolean, idleMs: number | undefined, dir: string): Promise<RunResult> {
  const runDir = mkdtempSync(join(dir, `${tool}-${withLimit ? "limit" : "nolimit"}-`));
  const readLog = join(runDir, "reads.jsonl");
  writeFileSync(readLog, "");
  const requestedTimeoutMs = Math.round(minutes * 60_000);
  const toolName = `mcp__wollipog__${tool}`;
  const input = toolInput(tool, requestedTimeoutMs);
  const state: ModelState = { result: null, toolCalled: false };
  const model = modelServer(state, toolName, input);
  const port = await listen(model);
  const entry: Json = claudeWollipogMcpServer({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), "--serve", readLog],
  }, {});
  if (!withLimit) delete entry.timeout;
  const mcpConfig = join(runDir, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { wollipog: entry } }));
  const configDir = join(runDir, "claude-config");
  // Only the probe's own variables reach Claude Code: no hosting Wollipog session, no sign-in, and
  // no limits from the caller's environment unless `--idle-ms` sets one deliberately.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("WOLLIPOG_") && !key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE_") &&
      key !== "MCP_TOOL_TIMEOUT" && key !== "MCP_TIMEOUT")),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: "probe-placeholder-not-a-credential",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(idleMs !== undefined ? { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(idleMs) } : {}),
  };
  const killAfterMs = requestedTimeoutMs + 15 * 60_000;
  const exit = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(CLAUDE, [
      "-p", `Call ${toolName} once.`,
      "--output-format", "json",
      "--model", "claude-sonnet-4-5",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", toolName,
      "--no-session-persistence",
    ], { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  model.close();
  const reads = readFileSync(readLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: number });
  const first = reads[0]?.at;
  const text = state.result?.text ?? "";
  // Claude Code may append text after a tool's JSON, so read the summary's leading outcome field.
  const summaryOutcome = /^\s*\{"outcome":"([a-z_]+)"/u.exec(text)?.[1];
  const outcome = summaryOutcome
    ?? (/sent no response or progress/u.test(text) ? "idle_abort"
      : /timed out after/u.test(text) ? "total_timeout_abort"
        : text ? "error_text" : "no_result");
  const harnessAbort = outcome === "idle_abort" || outcome === "total_timeout_abort";
  const deliveredAfterMs = state.result && first !== undefined ? state.result.at - first : null;
  const expected = withLimit ? "tool_result" : "harness_abort";
  const passed = withLimit
    ? outcome === "timeout" && deliveredAfterMs !== null && deliveredAfterMs >= requestedTimeoutMs - 5_000
    : harnessAbort;
  if (!state.result) console.error(exit.stderr.slice(-2_000) || exit.stdout.slice(-2_000));
  if (KEEP) console.error(`kept ${runDir}`);
  return {
    tool, entryTimeoutMs: withLimit ? CLAUDE_WOLLIPOG_MCP_TIMEOUT_MS : null,
    idleLimitMs: idleMs ?? CLAUDE_DEFAULT_STDIO_IDLE_MS, requestedTimeoutMs, reads: reads.length,
    deliveredAfterMs, outcome, isError: state.result?.isError ?? null, harnessAbort,
    resultExcerpt: text.slice(0, 300), exitCode: exit.code, expected, passed,
  };
}

async function main(): Promise<void> {
  const selected = option("--tool");
  const tools: WaitTool[] = selected === "wait_pull_request" || selected === "wait_session"
    ? [selected] : ["wait_pull_request", "wait_session"];
  const minutes = option("--minutes");
  const idle = option("--idle-ms");
  const idleMs = idle === undefined ? undefined : Number(idle);
  if (idleMs !== undefined && !(Number.isInteger(idleMs) && idleMs >= 1_000)) throw new Error("--idle-ms must be an integer of at least 1000");
  const versionOut = await new Promise<string>((resolve) => {
    const child = spawn(CLAUDE, ["--version"], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, DISABLE_AUTOUPDATER: "1" } });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
  const dir = mkdtempSync(join(tmpdir(), "wollipog-claude-mcp-wait-"));
  try {
    const runs: Promise<RunResult>[] = [];
    for (const tool of tools) {
      const length = minutes === undefined ? DEFAULT_MINUTES[tool] : Number(minutes);
      if (!(length > 0)) throw new Error("--minutes must be positive");
      runs.push(measure(tool, length, true, idleMs, dir));
      if (process.argv.includes("--without-limit")) runs.push(measure(tool, length, false, idleMs, dir));
    }
    const results = await Promise.all(runs);
    console.log(JSON.stringify({ claudeVersion: versionOut || null, results }, null, 2));
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } finally {
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--serve" && process.argv[3]) serve(process.argv[3]);
else await main();
