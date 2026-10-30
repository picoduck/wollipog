import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = process.env.WOLLIPOG_FAKE_PI_SCENARIO ?? "normal";
const agentControlProbe = argv.includes("--extension");
const agentControlProbeNonce = process.env.WOLLIPOG_PI_AGENT_CONTROL_PROBE_NONCE;
const verifiedTrustBridge = Boolean(
  process.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE && process.env.WOLLIPOG_PI_SECURITY_REQUEST_NONCE,
);
if (!argv.includes("--mode") || !argv.includes("rpc") ||
    (!argv.includes("--no-approve") && !verifiedTrustBridge && !(agentControlProbe && agentControlProbeNonce))) process.exit(64);
if (scenario === "verified-launch" && argv.includes("--no-approve")) process.exit(65);
if (scenario === "orchestrator-launch" && !argv.includes("--no-approve")) process.exit(67);
if (argv.includes("--approve") && (argv.includes("--no-approve") || !verifiedTrustBridge)) process.exit(68);
if (scenario === "project-trust-relaunch-fails" && argv.includes("--approve")) process.exit(69);
// Real Pi decides project trust while building its runtime, before RPC reads stdin. A command-line
// override skips the project_trust event; otherwise the runner extension declines it (without
// remembering) when the project has protected resources, which these scenarios model.
const trustOverride = argv.includes("--approve") || argv.includes("--no-approve");
const projectTrusted = argv.includes("--approve");
const projectTrustDispatched = !trustOverride && scenario.startsWith("project-trust");

const resumedAt = argv.indexOf("--session");
const forkedAt = argv.indexOf("--fork");
const explicitSessionIdAt = argv.indexOf("--session-id");
const agentControlReadyNonce = process.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE;
const agentControlExtensionPath = argv.find((arg, index) =>
  (argv[index - 1] === "--extension" || argv[index - 1] === "-e") && arg.endsWith(".pi-agent-control.mjs"));
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
const timestamp = "2026-10-30T00:00:00.000Z";
// Pi 1.4.0 records the startup model and thinking level as entries even under --no-session.
const startupEntries = [
  { type: "model_change", id: "pi-startup-model", parentId: null, timestamp, provider: selected.provider, modelId: selected.id },
  { type: "thinking_level_change", id: "pi-startup-thinking", parentId: "pi-startup-model", timestamp, thinkingLevel: "high" },
];
const turnEntries = (assistantContent, userContent = "hello") => [
  ...startupEntries,
  { type: "message", id: "pi-user-1", parentId: "pi-startup-thinking", timestamp, message: { role: "user", content: userContent } },
  { type: "message", id: "pi-entry-1", parentId: "pi-user-1", timestamp, message: { role: "assistant", content: assistantContent } },
];
let entries = forkedAt >= 0 ? turnEntries("Hello from Pi") : scenario === "legacy-null-leaf" ? [] : startupEntries;
let leafId = forkedAt >= 0 ? "pi-entry-1" : scenario === "legacy-null-leaf" ? null : "pi-startup-thinking";
if (scenario === "fork-leaf-mismatch" && forkedAt >= 0) {
  entries = [
    { type: "message", id: "expected-leaf", parentId: null, message: { role: "assistant", content: "Expected" } },
    { type: "message", id: "different-leaf", parentId: "expected-leaf", message: { role: "assistant", content: "Later" } },
  ];
  leafId = "different-leaf";
}

/** Pi reports a command's scope in sourceInfo; `location` was removed before 1.4.0. The
 * legacy-location scenario models those older releases. */
function command(name, description, source, scope, provenance = "auto") {
  if (scenario.startsWith("legacy-location")) return { name, description, source, ...(scope === "temporary" ? {} : { location: scope }) };
  return { name, description, source, sourceInfo: { path: `/fake/${name}`, source: provenance, scope, origin: "top-level" } };
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(command, request, data) {
  send({ type: "response", id: request.id, command, success: true, ...(data === undefined ? {} : { data }) });
}

if (agentControlProbe && agentControlProbeNonce && scenario !== "extension-unsupported" &&
    scenario !== "extension-no-readiness" && scenario !== "project-trust-unsupported") {
  send({ type: "extension_ui_request", method: "setStatus", statusKey: "wollipog-agent-control-probe",
    statusText: agentControlProbeNonce });
}
if (scenario === "user-extension-error") {
  send({ type: "extension_error", extensionPath: "/home/user/.pi/extensions/broken.mjs",
    event: "session_start", error: "private user error" });
}
if (scenario === "agent-control-extension-error" && agentControlExtensionPath) {
  send({ type: "extension_error", extensionPath: agentControlExtensionPath,
    event: "session_start", error: "private bridge error" });
}
// The runner extension's session_start report, emitted before its Agent Control readiness.
const projectTrustNonce = process.env.WOLLIPOG_PI_PROJECT_TRUST_NONCE;
if (projectTrustNonce && verifiedTrustBridge) {
  const reportedCwd = scenario === "project-trust-wrong-cwd" ? "/somewhere/else" : realpathSync(process.cwd());
  const report = (nonce, state, cwd) => send({ type: "extension_ui_request", method: "setStatus",
    statusKey: "wollipog-project-trust", statusText: `${nonce}.${state}.${Buffer.from(cwd).toString("base64url")}` });
  if (scenario === "project-trust-stale-nonce") report("stale-launch-nonce", "declined", reportedCwd);
  else report(projectTrustNonce, projectTrustDispatched ? "declined" : "not_requested", projectTrustDispatched ? reportedCwd : "");
  if (scenario === "project-trust-replayed") report(projectTrustNonce, "declined", reportedCwd);
}
if (agentControlReadyNonce && scenario !== "agent-control-no-readiness" &&
    scenario !== "agent-control-extension-error") {
  send({ type: "extension_ui_request", method: "setStatus", statusKey: "wollipog-agent-control",
    statusText: agentControlReadyNonce });
}

function settleNormal() {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reason\u2028carefully" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello from Pi" } });
  send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "tool-1", toolName: "read" } });
  send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } });
  send({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: [{ type: "text", text: "partial" }] } });
  send({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "done" }] }, isError: false });
  send({ type: "message_end", message: { role: "assistant", model: selected.id, content: [], stopReason: "toolUse",
    usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.02 } } } });
  send({ type: "turn_end", message: {}, toolResults: [] });
  send({ type: "turn_start" });
  send({ type: "turn_end", message: {}, toolResults: [] });
  send({ type: "agent_end", messages: [], willRetry: false });
  entries = turnEntries("Hello from Pi");
  leafId = "pi-entry-1";
  send({ type: "agent_settled" });
}

function settleToolOnly() {
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "tool-only", toolName: "bash" } });
  send({ type: "tool_execution_start", toolCallId: "tool-only", toolName: "bash", args: { command: "true" } });
  send({ type: "tool_execution_end", toolCallId: "tool-only", result: { content: [] }, isError: false });
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-only", name: "bash" }], stopReason: "toolUse" } });
  entries = turnEntries([], "use a tool");
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
        command("skill:review", "Review code", "skill", "user"),
        command("ship", "Ship it", "prompt", "user"),
        // The shared grammar rejects `+`, so discovery never advertises this one (#2602).
        command("deploy+prod", "Deploy to production", "prompt", "user"),
        // Project resources load only for a trusted project.
        ...(projectTrusted || scenario.endsWith("project-commands")
          ? [command("project-review", "Review this project", "prompt", "project"), command("skill:project-skill", "Project skill", "skill", "project")]
          : []),
        ...(agentControlProbe && scenario !== "extension-unsupported"
          ? [command("wollipog-agent-control-probe", "probe", "extension", "temporary", "cli")]
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
      if (scenario === "entries-dangling-leaf") return response("get_entries", request, { entries, leafId: "not-an-entry" });
      if (request.since !== undefined) {
        if (scenario === "entries-cursor-unsupported") {
          return response("get_entries", request, { entries, leafId });
        }
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
