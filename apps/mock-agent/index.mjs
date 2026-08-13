#!/usr/bin/env node
/**
 * Mock ACP agent — the AGENT side of the Agent Client Protocol (protocolVersion 1),
 * over newline-delimited JSON-RPC on stdio. It lets us exercise the whole
 * runner -> ACP pipeline (streaming messages, thoughts, plans, tool calls, file
 * edits via fs/write_text_file, and permission requests) without installing a
 * real agent like Codex or Claude Code.
 *
 * Behaviour per prompt turn:
 *   - streams a thought + a 3-step plan + agent message chunks
 *   - if the prompt mentions "approve"/"permission"/"deploy", asks for permission
 *     and waits for the client's decision
 *   - writes MOCK_NOTES.md into the session cwd via fs/write_text_file
 *   - emits a tool_call + diff, then finishes with stopReason "end_turn"
 *   - honours session/cancel (resolves the turn with stopReason "cancelled")
 *
 * Logs go to stderr only — stdout is reserved for the JSON-RPC stream.
 */

let buf = "";
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }
const sessions = new Map(); // sessionId -> { cwd, cancelled }
const authRequired = process.env.WOLLIPOG_MOCK_AUTH_REQUIRED === "1";
const sessionLifecycle = process.env.WOLLIPOG_MOCK_SESSION_LIFECYCLE || "";
const supportsResume = sessionLifecycle.startsWith("resume");
const supportsLoad = sessionLifecycle.startsWith("load") || supportsResume;
const supportsList = process.env.WOLLIPOG_MOCK_SESSION_LIST === "1";
const supportsControls = process.env.WOLLIPOG_MOCK_SESSION_CONTROLS === "1";
const supportsMcpContext = process.env.WOLLIPOG_MOCK_MCP_CONTEXT === "1";
let currentModeId = "default";
let currentModel = "mock-fast";
let currentEffort = "medium";
let authenticated = !authRequired;

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });
}
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function replyErr(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handleLine(line);
  }
});

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.method) return void onRequest(msg);
  if (msg.method) return onNotification(msg);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    }
  }
}

async function onRequest(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: 1,
        ...(authRequired && process.env.WOLLIPOG_MOCK_OMIT_AUTH_METHODS !== "1" ? {
          authMethods: [
            { id: "mock-browser-broken", name: "Browser sign-in (fails once)", description: "Agent-hosted browser flow" },
            { id: "mock-device-good", name: "Device sign-in", description: "Agent-hosted device flow" },
          ],
        } : {}),
        agentCapabilities: {
          loadSession: supportsLoad,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          ...(supportsMcpContext ? {
            mcpCapabilities: { http: true, sse: true },
          } : {}),
          ...(authRequired ? { auth: { logout: {} } } : {}),
          ...(sessionLifecycle ? {
            sessionCapabilities: {
              ...(supportsResume ? { resume: {} } : {}),
              ...(supportsList ? { list: {} } : {}),
              close: {},
              ...(supportsMcpContext ? { additionalDirectories: {} } : {}),
            },
          } : {}),
          ...(!sessionLifecycle && (supportsList || supportsMcpContext) ? { sessionCapabilities: {
            ...(supportsList ? { list: {} } : {}),
            ...(supportsMcpContext ? { additionalDirectories: {} } : {}),
          } } : {}),
        },
        agentInfo: { name: "mock-acp-agent", version: "0.1.0" },
      });
      if (process.env.WOLLIPOG_MOCK_EXIT_AFTER_INITIALIZE === "1") setImmediate(() => process.exit(23));
      return;
    }
    if (method === "authenticate") {
      if (params?.methodId === "mock-browser-broken") {
        replyErr(id, -32001, "provider rejected fake-secret-sentinel");
      } else if (params?.methodId === "mock-device-good") {
        authenticated = true;
        reply(id, {});
      } else {
        replyErr(id, -32602, "unknown auth method");
      }
      return;
    }
    if (method === "logout") {
      if (!authRequired) {
        replyErr(id, -32601, "logout not supported");
      } else if (process.env.WOLLIPOG_MOCK_LOGOUT_FAIL === "1") {
        replyErr(id, -32002, "logout rejected fake-logout-secret-sentinel");
      } else {
        authenticated = false;
        reply(id, {});
      }
      return;
    }
    if (method === "session/new") {
      if (!authenticated) {
        replyErr(id, -32000, "authentication required");
        return;
      }
      if (!contextMatches(params)) {
        replyErr(id, -32602, "session context mismatch");
        return;
      }
      const sessionId = "mock_" + Math.random().toString(36).slice(2, 10);
      sessions.set(sessionId, { cwd: params?.cwd ?? process.cwd(), cancelled: false });
      const commandsUpdate = {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review the current changes", input: { hint: "optional focus" } },
          { name: "bad command", description: "must be filtered" },
        ],
      };
      if (supportsControls && process.env.WOLLIPOG_MOCK_EARLY_SESSION_UPDATE === "1") {
        notify("session/update", { sessionId, update: commandsUpdate });
        notify("session/update", {
          sessionId: `${sessionId}_foreign`,
          update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
        });
      }
      reply(id, {
        sessionId,
        ...(supportsControls ? { modes: modeState(), configOptions: controlOptions() } : {}),
      });
      if (supportsControls && process.env.WOLLIPOG_MOCK_EARLY_SESSION_UPDATE !== "1") setImmediate(() => notify("session/update", {
        sessionId,
        update: commandsUpdate,
      }));
      if (supportsControls && process.env.WOLLIPOG_MOCK_FOREIGN_SESSION_UPDATE === "1") {
        setImmediate(() => notify("session/update", {
          sessionId: `${sessionId}_foreign`,
          update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
        }));
      }
      if (process.env.WOLLIPOG_MOCK_RUNTIME_METADATA === "1") {
        setImmediate(() => {
          notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: 12_345,
              size: 200_000,
              cost: { amount: 1.25, currency: "USD", _meta: { secret: "usage-secret" } },
              _meta: { secret: "usage-update-secret" },
            },
          });
          notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "session_info_update",
              title: "  Provider\n title  ",
              updatedAt: "2026-07-11T00:00:00Z",
              _meta: { secret: "title-secret" },
            },
          });
        });
      }
      return;
    }
    if (method === "session/set_mode") {
      if (!supportsControls) {
        replyErr(id, -32601, "session/set_mode not supported");
      } else if (process.env.WOLLIPOG_MOCK_CONFIG_FAIL === "1") {
        replyErr(id, -32006, "mode rejected fake-config-secret-sentinel");
      } else {
        if (process.env.WOLLIPOG_MOCK_STALE_MODE_UPDATE === "1") notify("session/update", {
          sessionId: params?.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId },
        });
        currentModeId = params?.modeId;
        reply(id, {});
        notify("session/update", {
          sessionId: params?.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId },
        });
      }
      return;
    }
    if (method === "session/set_config_option") {
      if (!supportsControls) {
        replyErr(id, -32601, "session/set_config_option not supported");
      } else if (process.env.WOLLIPOG_MOCK_CONFIG_FAIL === "1") {
        replyErr(id, -32007, "config rejected fake-config-secret-sentinel");
      } else {
        if (params?.configId === "model") currentModel = params?.value;
        if (params?.configId === "effort") currentEffort = params?.value;
        reply(id, { configOptions: controlOptions() });
        if (process.env.WOLLIPOG_MOCK_OMIT_CONFIG_CONFIRMATION !== "1") {
          notify("session/update", {
            sessionId: params?.sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: controlOptions() },
          });
        }
        if (process.env.WOLLIPOG_MOCK_AUTONOMOUS_CONFIG_UPDATE === "1") {
          setImmediate(() => {
            currentModel = "mock-fast";
            notify("session/update", {
              sessionId: params?.sessionId,
              update: { sessionUpdate: "config_option_update", configOptions: controlOptions() },
            });
          });
        }
      }
      return;
    }
    if (method === "session/resume") {
      if (!contextMatches(params)) {
        replyErr(id, -32602, "session context mismatch");
      } else if (!supportsResume) {
        replyErr(id, -32601, "session/resume not supported");
      } else if (sessionLifecycle === "resume-fail") {
        replyErr(id, -32003, "resume rejected fake-resume-secret-sentinel");
      } else {
        sessions.set(params?.sessionId, { cwd: params?.cwd ?? process.cwd(), cancelled: false });
        reply(id, {});
      }
      return;
    }
    if (method === "session/list") {
      if (!supportsList) {
        replyErr(id, -32601, "session/list not supported");
      } else if (process.env.WOLLIPOG_MOCK_SESSION_LIST_FAIL === "1") {
        replyErr(id, -32005, "list rejected fake-list-secret-sentinel");
      } else {
        const ids = (process.env.WOLLIPOG_MOCK_SESSION_LIST_IDS || "mock-listed-1,mock-listed-2").split(",").filter(Boolean);
        const index = params?.cursor ? Number(params.cursor) : 0;
        const sessionId = ids[index];
        reply(id, {
          sessions: sessionId ? [{
            sessionId,
            cwd: process.env.WOLLIPOG_MOCK_SESSION_CWD || process.cwd(),
            title: `${process.env.WOLLIPOG_MOCK_SESSION_TITLE || "Mock listed"}\n${sessionId}`,
            updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            _meta: { providerSecret: "fake-list-meta-secret-sentinel" },
          }] : [],
          ...(index + 1 < ids.length ? { nextCursor: String(index + 1) } : {}),
          _meta: { providerSecret: "fake-list-response-secret-sentinel" },
        });
      }
      return;
    }
    if (method === "session/load") {
      if (!contextMatches(params)) {
        replyErr(id, -32602, "session context mismatch");
      } else if (!sessionLifecycle.startsWith("load")) {
        replyErr(id, -32601, "session/load must not be called when resume is available");
      } else if (sessionLifecycle === "load-fail") {
        replyErr(id, -32004, "load rejected fake-load-secret-sentinel");
      } else {
        sessions.set(params?.sessionId, { cwd: params?.cwd ?? process.cwd(), cancelled: false });
        notify("session/update", {
          sessionId: params?.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "historical-load-replay" } },
        });
        if (process.env.WOLLIPOG_MOCK_LOAD_STATE_UPDATES === "1") {
          notify("session/update", {
            sessionId: params?.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "loaded", description: "Current command after load" }],
            },
          });
          notify("session/update", {
            sessionId: params?.sessionId,
            update: { sessionUpdate: "usage_update", used: 77, size: 1_000 },
          });
        }
        reply(id, {});
      }
      return;
    }
    if (method === "session/close") {
      if (!sessionLifecycle) {
        replyErr(id, -32601, "session/close not supported");
      } else {
        sessions.delete(params?.sessionId);
        reply(id, {});
      }
      return;
    }
    if (method === "session/prompt") {
      const stopReason = await runTurn(params);
      reply(id, { stopReason });
      return;
    }
    replyErr(id, -32601, "method not found: " + method);
  } catch (e) {
    replyErr(id, -32000, String((e && e.message) || e));
  }
}

function contextMatches(params) {
  if (!process.env.WOLLIPOG_MOCK_EXPECT_CONTEXT) return true;
  try {
    const expected = JSON.parse(process.env.WOLLIPOG_MOCK_EXPECT_CONTEXT);
    return JSON.stringify({
      mcpServers: params?.mcpServers ?? [],
      additionalDirectories: params?.additionalDirectories ?? [],
    }) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function onNotification(msg) {
  if (msg.method === "session/cancel") {
    const s = sessions.get(msg.params?.sessionId);
    if (s) s.cancelled = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(params) {
  const sessionId = params.sessionId;
  const s = sessions.get(sessionId) || { cwd: process.cwd(), cancelled: false };
  s.cancelled = false;
  const promptText = (params.prompt || [])
    .map((b) => (b && b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
  const imageCount = (params.prompt || []).filter((b) => b && b.type === "image").length;
  const u = (update) => notify("session/update", { sessionId, update });

  u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Planning a response to: "${promptText.slice(0, 80)}"` } });
  await sleep(150);
  if (s.cancelled) return "cancelled";

  if (imageCount > 0) {
    u({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `I can see ${imageCount} attached image${imageCount === 1 ? "" : "s"}. ` },
    });
    await sleep(120);
    if (s.cancelled) return "cancelled";
  }

  const plan = [
    { content: "Understand the request", status: "in_progress", priority: "high" },
    { content: "Make an edit", status: "pending", priority: "medium" },
    { content: "Summarize", status: "pending", priority: "low" },
  ];
  u({ sessionUpdate: "plan", entries: plan });
  await sleep(120);

  for (const chunk of ["Sure — ", "I can help with that. ", "Let me make a small change.\n"]) {
    u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
    await sleep(120);
    if (s.cancelled) return "cancelled";
  }

  if (/approve|permission|deploy/i.test(promptText)) {
    u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "This action needs your approval first.\n" } });
    let res;
    try {
      res = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tc_perm", title: "Run a potentially destructive command", kind: "execute", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
    } catch {
      res = null;
    }
    const selected = res && res.outcome && res.outcome.outcome === "selected" ? res.outcome.optionId : null;
    if (selected !== "allow") {
      u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Understood — I will not proceed.\n" } });
      return "end_turn";
    }
    u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Approved — proceeding.\n" } });
  }

  const toolCallId = "tc_" + Math.random().toString(36).slice(2, 8);
  u({ sessionUpdate: "tool_call", toolCallId, title: "Write MOCK_NOTES.md", kind: "edit", status: "in_progress" });
  plan[0].status = "completed";
  plan[1].status = "in_progress";
  u({ sessionUpdate: "plan", entries: plan });

  const filePath = joinPath(s.cwd, "MOCK_NOTES.md");
  const newText = `# Mock agent notes\n\nPrompt: ${promptText}\n\nGenerated at ${new Date().toISOString()}\n`;
  try {
    await request("fs/write_text_file", { sessionId, path: filePath, content: newText });
  } catch {
    /* client may not support fs; the diff below still surfaces the change */
  }
  if (process.env.WOLLIPOG_MOCK_TERMINAL === "1" || process.env.WOLLIPOG_MOCK_TERMINAL_EMBED === "1") {
    const terminal = await request("terminal/create", {
      sessionId,
      command: process.execPath,
      args: ["-e", "process.stdout.write('mock-terminal-ok')"],
      cwd: s.cwd,
      outputByteLimit: 1024,
    });
    await request("terminal/wait_for_exit", { sessionId, terminalId: terminal.terminalId });
    const terminalOutput = await request("terminal/output", { sessionId, terminalId: terminal.terminalId });
    u({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "in_progress",
      content: [
        ...(process.env.WOLLIPOG_MOCK_TERMINAL_EMBED === "1"
          ? [{ type: "content", content: { type: "text", text: terminalOutput.output } }]
          : []),
        { type: "terminal", terminalId: terminal.terminalId },
      ],
    });
    await request("terminal/release", { sessionId, terminalId: terminal.terminalId });
  }
  u({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "diff", path: filePath, oldText: null, newText }] });
  await sleep(120);
  if (s.cancelled) return "cancelled";

  plan[1].status = "completed";
  plan[2].status = "completed";
  u({ sessionUpdate: "plan", entries: plan });
  u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done. I wrote MOCK_NOTES.md in the workspace." } });
  return "end_turn";
}

function joinPath(cwd, name) {
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + name;
}

function modeState() {
  return {
    currentModeId,
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan", description: "Research without editing" },
    ],
  };
}

function controlOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "mock-fast", name: "Mock Fast" },
        { value: "mock-smart", name: "Mock Smart", description: "More capable" },
      ],
    },
    {
      id: "effort",
      name: "Thought level",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    { id: "boolean-preview", name: "Preview", type: "boolean", currentValue: false },
  ];
}

process.stderr.write("[mock-acp-agent] ready\n");
