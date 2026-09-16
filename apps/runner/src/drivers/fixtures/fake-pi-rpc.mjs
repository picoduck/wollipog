import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (!argv.includes("--mode") || !argv.includes("rpc") || !argv.includes("--no-approve")) process.exit(64);

const scenario = process.env.WOLLIPOG_FAKE_PI_SCENARIO ?? "normal";
const resumedAt = argv.indexOf("--session");
const forkedAt = argv.indexOf("--fork");
const explicitSessionIdAt = argv.indexOf("--session-id");
const agentControlProbe = argv.includes("--extension");
const sessionId = scenario === "fork-ignores-session-id" && forkedAt >= 0
  ? "pi-generated-fork-id"
  : explicitSessionIdAt >= 0
  ? argv[explicitSessionIdAt + 1]
  : forkedAt >= 0 ? "pi-fork-session-1" : resumedAt >= 0 ? argv[resumedAt + 1] : "pi-session-1";
const fakeSessionRoot = process.env.WOLLIPOG_FAKE_PI_SESSION_ROOT;
const sessionFile = fakeSessionRoot
  ? join(fakeSessionRoot, `${sessionId}.jsonl`)
  : `/tmp/.pi/agent/sessions/fake-project/${sessionId}.jsonl`;
if (forkedAt >= 0 && fakeSessionRoot) {
  mkdirSync(fakeSessionRoot, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`, { flag: "wx" });
}
if (!process.env.WOLLIPOG_FAKE_PI_SCENARIO && !argv.includes("--no-session")) process.exit(64);
if (resumedAt >= 0 && sessionId !== "persisted-pi-session") process.exit(66);
const models = [
  { provider: "anthropic", id: "sonnet", name: "Sonnet", reasoning: true, input: ["text", "image"], contextWindow: 200000 },
  { provider: "openai", id: "mini", name: "Mini", reasoning: false, input: ["text"], contextWindow: 128000 },
];
let selected = models[0];
let buffer = Buffer.alloc(0);
let entries = forkedAt >= 0 ? [
  { type: "message", id: "pi-user-1", parentId: null, message: { role: "user", content: "hello" } },
  { type: "message", id: "pi-entry-1", parentId: "pi-user-1", message: { role: "assistant", content: "Hello from Pi" } },
] : [];
let leafId = forkedAt >= 0 ? "pi-entry-1" : null;
if (scenario === "fork-leaf-mismatch" && forkedAt >= 0) {
  entries = [
    { type: "message", id: "expected-leaf", parentId: null, message: { role: "assistant", content: "Expected" } },
    { type: "message", id: "different-leaf", parentId: "expected-leaf", message: { role: "assistant", content: "Later" } },
  ];
  leafId = "different-leaf";
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(command, request, data) {
  send({ type: "response", id: request.id, command, success: true, ...(data === undefined ? {} : { data }) });
}

function settleNormal() {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reason\u2028carefully" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello from Pi" } });
  send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "tool-1", toolName: "read" } });
  send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } });
  send({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: "partial" } });
  send({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: "done" }, isError: false });
  send({ type: "message_end", message: { role: "assistant", model: selected.id, content: [], stopReason: "toolUse",
    usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.02 } } } });
  send({ type: "turn_end", message: {}, toolResults: [] });
  send({ type: "turn_start" });
  send({ type: "turn_end", message: {}, toolResults: [] });
  send({ type: "agent_end", messages: [], willRetry: false });
  entries = [
    { type: "message", id: "pi-user-1", parentId: null, message: { role: "user", content: "hello" } },
    { type: "message", id: "pi-entry-1", parentId: "pi-user-1", message: { role: "assistant", content: "Hello from Pi" } },
  ];
  leafId = "pi-entry-1";
  send({ type: "agent_settled" });
}

function settleToolOnly() {
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "tool-only", toolName: "bash" } });
  send({ type: "tool_execution_start", toolCallId: "tool-only", toolName: "bash", args: { command: "true" } });
  send({ type: "tool_execution_end", toolCallId: "tool-only", result: { content: "" }, isError: false });
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-only", name: "bash" }], stopReason: "toolUse" } });
  entries = [
    { type: "message", id: "pi-user-1", parentId: null, message: { role: "user", content: "use a tool" } },
    { type: "message", id: "pi-entry-1", parentId: "pi-user-1", message: { role: "assistant", content: [] } },
  ];
  leafId = "pi-entry-1";
  send({ type: "agent_settled" });
}

function handle(request) {
  switch (request.type) {
    case "get_state":
      return response("get_state", request, { sessionId, sessionFile, model: selected,
        thinkingLevel: selected.id === "sonnet" ? "high" : "off", isStreaming: false });
    case "get_available_models":
      return response("get_available_models", request, { models });
    case "set_model":
      selected = models.find((model) => model.provider === request.provider && model.id === request.modelId) ?? selected;
      if (scenario === "slow-discovery") {
        setTimeout(() => response("set_model", request, selected), 40);
        return;
      }
      return response("set_model", request, selected);
    case "get_available_thinking_levels":
      return response("get_available_thinking_levels", request, { levels: selected.id === "sonnet" ? ["off", "low", "high"] : ["off"] });
    case "set_thinking_level":
      return response("set_thinking_level", request);
    case "get_commands":
      return response("get_commands", request, { commands: [
        { name: "skill:review", description: "Review code", source: "skill", location: "user" },
        { name: "ship", description: "Ship it", source: "prompt", location: "user" },
        ...(agentControlProbe && scenario !== "extension-unsupported"
          ? [{ name: "wollipog-agent-control-probe", description: "probe", source: "extension" }]
          : []),
      ] });
    case "get_entries":
      if (scenario === "legacy-no-entries") {
        send({ type: "response", id: request.id, command: request.type, success: false, error: "unsupported" });
        return;
      }
      if (scenario === "legacy-hanging-entries") return;
      if (scenario === "oversized-entries") {
        return response("get_entries", request, {
          entries: [{ type: "custom", id: "huge-entry", data: "x".repeat(4 * 1024 * 1024 + 1024) }],
          leafId: "huge-entry",
        });
      }
      if (request.since !== undefined) {
        const sinceIndex = entries.findIndex((entry) => entry.id === request.since);
        if (sinceIndex < 0) {
          send({ type: "response", id: request.id, command: request.type, success: false, error: `Entry not found: ${request.since}` });
          return;
        }
        return response("get_entries", request, { entries: entries.slice(sinceIndex + 1), leafId });
      }
      return response("get_entries", request, { entries, leafId });
    case "get_session_stats":
      return response("get_session_stats", request, { sessionId, tokens: { input: 12, output: 4 }, cost: 0.02,
        contextUsage: { tokens: 16, contextWindow: selected.contextWindow, percent: 1 } });
    case "prompt":
      if (scenario === "uncertain") return process.exit(9);
      response("prompt", request);
      if (scenario === "dialog") {
        send({ type: "agent_start" });
        send({ type: "extension_ui_request", id: "dialog-1", method: "select", title: "Release channel", options: ["Stable", "Beta"] });
      } else if (scenario === "steer") {
        send({ type: "agent_start" });
      } else if (scenario === "tool-only") {
        settleToolOnly();
      } else {
        settleNormal();
      }
      return;
    case "steer":
      return response("steer", request);
    case "abort":
      response("abort", request);
      send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
      send({ type: "agent_settled" });
      return;
    case "extension_ui_response":
      send({ type: "message_start", message: { role: "assistant" } });
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Selected ${request.value}` }], stopReason: "stop" } });
      send({ type: "agent_settled" });
      return;
    default:
      send({ type: "response", id: request.id, command: request.type, success: false, error: "unsupported" });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  while (true) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) break;
    let line = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    if (line.length) handle(JSON.parse(line.toString("utf8")));
  }
});
