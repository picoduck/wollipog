// Synthetic, credential-free stand-in for Google's `agy` CLI used by the Antigravity setup and
// session tests. The sign-in half models only the documented shape (an https sign-in link and a
// pasted code): it was never compared with real `agy acp --login` output.
//
// The ACP half models real agy 1.5.14 on Linux as observed on 2026-11-21 (see DRIVERS.md §4.3):
// the initialize capabilities and auth methods (fixtures/acp/antigravity-1.5.14.initialize.json),
// a session/new with session model state plus `model`, `thought_level` and `mode` config options
// and four modes, "Authentication required" as error -32000, text and thought chunks, tool calls
// that carry agy's extra `name`/`args` fields, a command that asks `session/request_permission`
// with a string request id and allow/deny options (a denied command never runs), session/cancel
// ending the turn as `cancelled`, session/resume failing with -32603 for a conversation it cannot
// read, and session/load of such an id returning an EMPTY session instead of an error. Its
// diagnostic log goes to stderr and names the account, as agy's does when it cannot open its log
// file; the name here is a fixture value. No model output, account or token was captured.
//
// FAKE_AGY_STATE: directory holding the fake sign-in marker, persisted sessions and probe output.
// FAKE_AGY_MODE: comma-separated behaviors (see below). Defaults to a working CLI.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const state = process.env.FAKE_AGY_STATE;
const modes = new Set((process.env.FAKE_AGY_MODE ?? "").split(",").filter(Boolean));
const signedInMarker = state ? join(state, "signed-in") : undefined;
const args = process.argv.slice(2);
const AMBIENT = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];

function recordEnvironment(label) {
  if (!state) return;
  const present = [...new Set([...AMBIENT, ...Object.keys(process.env).filter((name) => name.startsWith("GOOGLE_CLOUD_"))])]
    .filter((name) => process.env[name] !== undefined);
  appendFileSync(join(state, "environments.jsonl"), `${JSON.stringify({ label, present, home: process.env.HOME ?? null,
    ...(process.env.FIXTURE_SETUP_VAR ? { setupVariable: process.env.FIXTURE_SETUP_VAR } : {}) })}\n`);
}

if (args[0] === "--version") {
  recordEnvironment("version");
  if (modes.has("version_fail")) process.exit(3);
  process.stdout.write(modes.has("version_garbled") ? "antigravity cli\n" : "agy 1.4.2 (fixture)\n");
  process.exit(0);
}

if (args[0] === "acp" && args[1] === "--login") {
  recordEnvironment("login");
  if (modes.has("login_no_link")) {
    process.stdout.write("Starting sign-in...\n");
    setInterval(() => {}, 1_000);
  } else {
    const link = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-client&state=fixture-state";
    const prompt = () => process.stdout.write(".\nPaste the authorization code: ");
    process.stdout.write("\u001b[1mSign in with Google\u001b[0m\nOpen this link in a browser:\n");
    if (modes.has("login_ansi_split")) {
      // A style reset between the path and the query, with the chunk cut right after its ESC byte.
      const query = link.indexOf("?");
      process.stdout.write(`${link.slice(0, query)}\u001b`);
      setTimeout(() => { process.stdout.write(`[0m${link.slice(query)}`); prompt(); }, 300);
    } else if (modes.has("login_split_url")) {
      // The link arrives in two writes, cut inside its query string.
      process.stdout.write(link.slice(0, 50));
      setTimeout(() => { process.stdout.write(link.slice(50)); prompt(); }, 300);
    } else {
      process.stdout.write(link);
      prompt();
    }
    const lines = createInterface({ input: process.stdin });
    lines.once("line", (code) => {
      lines.close();
      // A diagnostic that echoes the submitted code inside another link.
      if (modes.has("login_echo_code")) process.stdout.write(`Verifying at https://accounts.google.com/debug?code=${code.trim()}\n`);
      if (modes.has("login_exit0_unverified")) { process.stdout.write("Done.\n"); process.exit(0); }
      if (code.trim() === "FIXTURE-GOOD-CODE") {
        if (signedInMarker) writeFileSync(signedInMarker, "fixture");
        process.stdout.write("Signed in.\n");
        // Exit after a pause, so a link printed above has time to be read before the exit settles.
        setTimeout(() => process.exit(0), modes.has("login_echo_code") ? 200 : 0);
        return;
      }
      process.stdout.write("The code was rejected or has expired.\n");
      process.exit(1);
    });
  }
} else if (args[0] === "acp") {
  recordEnvironment("acp");
  if (modes.has("acp_exit")) process.exit(2);
  const lines = createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const record = (entry) => { if (state) appendFileSync(join(state, "calls.jsonl"), `${JSON.stringify(entry)}\n`); };
  const sessionsDir = state ? join(state, "sessions") : undefined;
  // agy's glog line when it cannot open its log file names the signed-in account.
  process.stderr.write("I1121 06:54:38.691638 84 server_oauth.go:226] OAuth: authenticated successfully as fixture-user@example.com\n");
  const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
  const modelState = { currentModelId: "fixture-pro-high", availableModels: [
    { modelId: "fixture-pro-high", name: "Fixture Pro (High)" }, { modelId: "fixture-flash-low", name: "Fixture Flash (Low)" }] };
  const modeState = { currentModeId: "default", availableModes: [
    { id: "default", name: "Default", description: "Ask before edits and commands, per your permission settings." },
    { id: "accept-edits", name: "Accept edits", description: "Approve file edits in the workspace without asking." },
    { id: "auto", name: "Auto", description: "Approve edits and safe commands; ask before irreversible actions." },
    { id: "plan", name: "Plan", description: "Plan carefully before executing a task." }] };
  const config = { model: "fixture-pro", thought_level: "high", mode: "default" };
  const configOptions = () => [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: config.model,
      options: modes.has("session_many_models")
        ? Array.from({ length: 40 }, (_, index) => ({ value: `fixture-model-${index + 1}`, name: `Fixture Model ${index + 1} With a Deliberately Long Display Name for Layout (Experimental Preview)` }))
        : [{ value: "fixture-pro", name: "Fixture Pro" }, { value: "fixture-flash", name: "Fixture Flash" }] },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: config.thought_level,
      options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra" }] },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: config.mode,
      options: modeState.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })) },
  ];
  const sessionState = () => ({ models: modelState, modes: { ...modeState, currentModeId: config.mode }, configOptions: configOptions() });
  /** The prompt in progress: its request id, and how a pending permission or cancel settles it. */
  let turn = null;
  let permissionCounter = 0;
  const endTurn = (stopReason) => {
    if (!turn) return;
    const { id } = turn;
    turn = null;
    send({ id, result: { stopReason } });
  };
  const runCommand = (sessionId, cwd) => {
    const toolCallId = "call_fixture_command";
    const args = { CommandLine: "touch fixture-command-ran", WaitMsBeforeAsync: 5000, toolSummary: "Create a marker file" };
    const tool = { toolCallId, name: "run_command", args, kind: "execute", title: "touch fixture-command-ran", rawInput: args };
    update(sessionId, { sessionUpdate: "tool_call", ...tool, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", ...tool, status: "pending" });
    const permissionId = String(++permissionCounter);
    turn.permission = { id: permissionId, settle: (outcome) => {
      turn.permission = null;
      if (outcome?.outcome === "selected" && outcome.optionId === "allow") {
        writeFileSync(join(cwd, "fixture-command-ran"), "");
        update(sessionId, { sessionUpdate: "tool_call_update", ...tool, status: "completed", rawOutput: { output: "" },
          content: [{ type: "content", content: { type: "text", text: modes.has("long_tool_output") ? "output line ".repeat(2_000) : "" } }] });
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The marker file was created." } });
        return endTurn("end_turn");
      }
      update(sessionId, { sessionUpdate: "tool_call_update", ...tool, status: "failed", rawOutput: { output: "" },
        content: [{ type: "content", content: { type: "text", text: "" } }] });
      if (outcome?.outcome === "cancelled") return endTurn("cancelled");
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The command was denied, so nothing ran." } });
      return endTurn("end_turn");
    } };
    send({ id: permissionId, method: "session/request_permission", params: { sessionId, toolCall: {
      sessionUpdate: "tool_call", ...tool, status: "pending" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
  };
  const sessionCwds = new Map();
  /** Answers awaited for requests the fixture sent the client, by request id. */
  const clientRequests = new Map();
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    // The client's answer to a permission (or other client) request.
    if (request.method === undefined && request.id !== undefined) {
      const answered = clientRequests.get(String(request.id));
      if (answered) {
        clientRequests.delete(String(request.id));
        answered(request);
        return;
      }
      if (turn?.permission && String(request.id) === turn.permission.id) {
        record({ method: "permission_response", outcome: request.result?.outcome ?? null });
        turn.permission.settle(request.result?.outcome);
      }
      return;
    }
    if (request.method === "session/cancel") {
      record({ method: "session/cancel" });
      // A pending permission is settled by the client's cancelled answer (ACP); otherwise the
      // turn ends here.
      if (turn && !turn.permission) endTurn("cancelled");
      return;
    }
    if (request.id === undefined) return;
    record({ method: request.method, ...(request.method === "initialize" ? { clientInfo: request.params?.clientInfo ?? null,
      clientCapabilities: request.params?.clientCapabilities ?? null } : {}),
      ...(request.params?.sessionId ? { sessionId: request.params.sessionId } : {}) });
    if (request.method === "initialize") {
      // Valid JSON that is not a JSON-RPC message.
      if (modes.has("acp_null")) process.stdout.write("null\n5\n[]\n");
      if (modes.has("handshake_hang")) return;
      if (modes.has("handshake_bad")) return send({ id: request.id, result: { protocolVersion: 99 } });
      // agy 1.5.14's capabilities and auth methods, without its `_meta`.
      return send({ id: request.id, result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
          auth: { logout: {} },
        },
        agentInfo: { name: "Antigravity ACP Server", version: "fixture" },
        authMethods: [
          { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
          { id: "oauth-business", name: "Log in with Gemini Enterprise", description: "Log in with your Gemini Enterprise account" },
          { id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
          { id: "agent-platform", name: "Gemini Enterprise Agent Platform", description: "Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials" },
        ],
      } });
    }
    if (request.method === "session/resume" || request.method === "session/load") {
      const sessionId = request.params?.sessionId;
      if (modes.has("resume_hang")) return;
      if (!signedInMarker || !existsSync(signedInMarker)) {
        return send({ id: request.id, error: { code: -32000, message: "Authentication required" } });
      }
      const persisted = typeof sessionId === "string" && sessionsDir && existsSync(join(sessionsDir, sessionId));
      if (request.method === "session/resume" && !persisted) {
        return send({ id: request.id, error: { code: -32603, message: `Failed to read session ${sessionId}; retry, or load it with session/load` } });
      }
      // Real agy loads an unknown id as an empty session rather than failing.
      sessionCwds.set(sessionId, request.params?.cwd);
      return send({ id: request.id, result: { sessionId, ...sessionState() } });
    }
    if ((request.method === "session/set_config_option" || request.method === "session/set_mode") && modes.has("config_hang")) return;
    if (request.method === "session/set_config_option") {
      const { configId, value } = request.params ?? {};
      if (configId in config) config[configId] = value;
      return send({ id: request.id, result: { configOptions: configOptions() } });
    }
    if (request.method === "session/set_mode") {
      config.mode = request.params?.modeId ?? config.mode;
      return send({ id: request.id, result: {} });
    }
    if (request.method === "session/close") return send({ id: request.id, result: {} });
    if (request.method === "session/prompt") {
      const sessionId = request.params?.sessionId;
      const text = (request.params?.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (modes.has("prompt_auth")) return send({ id: request.id, error: { code: -32000, message: "Authentication required" } });
      if (modes.has("prompt_error")) {
        return send({ id: request.id, error: { code: -32603, message: "Quota exhausted for fixture-user@example.com; try again later" } });
      }
      turn = { id: request.id, permission: null };
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading the request." } });
      if (/run (a |the )?command/iu.test(text)) return runCommand(sessionId, sessionCwds.get(sessionId) ?? process.cwd());
      if (/wait/iu.test(text)) return; // Ends only on session/cancel.
      if (/client write/iu.test(text)) {
        // Ask the client to write a file, as an ACP agent may even when the service was not offered.
        const writeId = `write-${++permissionCounter}`;
        turn.permission = { id: writeId, settle: () => {} };
        clientRequests.set(writeId, (message) => {
          record({ method: "fs/write_text_file response", error: message.error ? message.error.message ?? "error" : null });
          turn.permission = null;
          endTurn("end_turn");
        });
        return send({ id: writeId, method: "fs/write_text_file", params: { sessionId,
          path: join(sessionCwds.get(sessionId) ?? process.cwd(), ".git"), content: "gitdir: /tmp/elsewhere\n" } });
      }
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixture " } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply." } });
      update(sessionId, { sessionUpdate: "usage_update", used: 8_764, size: 1_048_576 });
      return endTurn("end_turn");
    }
    if (request.method === "session/new") {
      if (modes.has("session_hang")) return;
      if (modes.has("session_error")) return send({ id: request.id, error: { code: -32603, message: "internal error" } });
      if (!signedInMarker || !existsSync(signedInMarker)) {
        return send({ id: request.id, error: { code: -32000, message: "Authentication required" } });
      }
      if (modes.has("session_no_models")) return send({ id: request.id, result: { sessionId: "fixture-session" } });
      if (modes.has("session_long_model")) {
        return send({ id: request.id, result: { sessionId: "fixture-session", models: {
          currentModelId: "m".repeat(161), availableModels: [{ modelId: "m".repeat(161) }],
        } } });
      }
      if (modes.has("session_model_state")) {
        return send({ id: request.id, result: { sessionId: "fixture-session", models: {
          currentModelId: "fixture-pro",
          availableModels: [{ modelId: "fixture-pro", name: "Fixture Pro" }, { modelId: "fixture-flash", name: "Fixture Flash" }],
        } } });
      }
      const sessionId = `fixture-session-${process.pid}`;
      sessionCwds.set(sessionId, request.params?.cwd);
      // Persisted unless agy's state directory is read-only (runner execution isolation).
      if (sessionsDir && !modes.has("no_persist")) {
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, sessionId), "");
      }
      send({ id: request.id, result: { sessionId, ...sessionState() } });
      update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "plan", description: "Plan carefully before executing a task." }, { name: "compact", description: "Compact the conversation now." }] });
      return;
    }
    send({ id: request.id, error: { code: -32601, message: "method not found" } });
  });
} else {
  process.stderr.write("unknown fixture command\n");
  process.exit(64);
}
