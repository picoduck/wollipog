/** Runner-owned Pi extension source. It intentionally has no package imports so the generated
 * file can be loaded by any compatible Pi installation, including the single-file runner. */

export const PI_AGENT_CONTROL_PROTOCOL = 1;
export const PI_AGENT_CONTROL_STATUS_KEY = "wollipog-agent-control";
export const PI_AGENT_CONTROL_EXTENSION_SUFFIX = ".pi-agent-control.mjs";
export const PI_AGENT_CONTROL_PROBE_COMMAND = "wollipog-agent-control-probe";
export const PI_AGENT_CONTROL_PROBE_STATUS_KEY = "wollipog-agent-control-probe";
export const PI_AGENT_CONTROL_PROBE_NONCE_ENV = "WOLLIPOG_PI_AGENT_CONTROL_PROBE_NONCE";
export const PI_SECURITY_REQUEST_TITLE = "Wollipog Security Approval";
export const PI_SECURITY_REQUEST_PREFIX = "wollipog-security-v1:";
export const PI_SECURITY_REQUEST_NONCE_ENV = "WOLLIPOG_PI_SECURITY_REQUEST_NONCE";

/** Set only by the coupled Orchestrator preset, which launches Pi with `--exclude-tools bash,edit,write`
 * and the discovery flags off, and therefore restores its own read-only inspection surface. The
 * additive role must NOT set it: that launch keeps whatever tool inventory the user configured, so
 * force-activating tools here would re-enable ones a `--tools` allowlist or an `--exclude-tools`
 * denylist deliberately removed. The role itself is signalled by ORCHESTRATOR_ENV_KEY, which is what
 * selects the orchestration tool catalog in the Agent Control MCP server. */
export const PI_ORCHESTRATOR_PRESET_TOOLS_ENV = "WOLLIPOG_PI_ORCHESTRATOR_PRESET_TOOLS";

export const PI_AGENT_CONTROL_ENV_KEYS = [
  "WOLLIPOG_PI_AGENT_CONTROL_COMMAND",
  "WOLLIPOG_PI_AGENT_CONTROL_ARGS",
  "WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE",
  PI_SECURITY_REQUEST_NONCE_ENV,
  PI_ORCHESTRATOR_PRESET_TOOLS_ENV,
] as const;

export function piAgentControlProbeSource(nonce: string): string {
  return `export default function (pi) {
  let projectTrustObserved = false;
  if (typeof pi.registerCommand !== "function" || typeof pi.registerTool !== "function" ||
      typeof pi.on !== "function" || typeof pi.getActiveTools !== "function" ||
      typeof pi.setActiveTools !== "function") return;
  pi.registerCommand(${JSON.stringify(PI_AGENT_CONTROL_PROBE_COMMAND)}, {
    description: "Wollipog Agent Control compatibility probe",
    handler: async () => {},
  });
  pi.on("project_trust", async () => {
    projectTrustObserved = true;
    return { trusted: "no" };
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!projectTrustObserved) return;
    if (!ctx?.ui || typeof ctx.ui.setStatus !== "function" || typeof ctx.ui.select !== "function" ||
        typeof ctx.ui.input !== "function") return;
    await Promise.resolve();
    pi.registerTool({
      name: ${JSON.stringify(PI_AGENT_CONTROL_PROBE_COMMAND)},
      label: "Wollipog Agent Control Probe",
      description: "Wollipog Agent Control compatibility probe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: "text", text: "ready" }], details: {} }),
    });
    const active = pi.getActiveTools();
    if (!Array.isArray(active) || !active.includes(${JSON.stringify(PI_AGENT_CONTROL_PROBE_COMMAND)})) return;
    pi.setActiveTools(active);
    ctx.ui.setStatus(${JSON.stringify(PI_AGENT_CONTROL_PROBE_STATUS_KEY)}, ${JSON.stringify(nonce)});
  });
}\n`;
}

/** MCP-over-stdio adapter for Pi's dynamic extension tool API. The runner writes this exact source
 * to a session-private 0600 file and supplies the command, args, and one-use readiness nonce only
 * through ephemeral launch environment. */
export function piAgentControlExtensionSource(): string {
  return `import { spawn } from "node:child_process";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_TOOLS = 128;
const HANDSHAKE_TIMEOUT_MS = 35_000;
const STATUS_KEY = ${JSON.stringify(PI_AGENT_CONTROL_STATUS_KEY)};
const SECURITY_TITLE = ${JSON.stringify(PI_SECURITY_REQUEST_TITLE)};
const SECURITY_PREFIX = ${JSON.stringify(PI_SECURITY_REQUEST_PREFIX)};
const APPROVAL_INPUT_LIMIT = 16000;
const APPROVAL_INPUT_TRUNCATED = "\\n… [truncated by Wollipog]";

function approvalInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value ?? {}); } catch { serialized = "{}"; }
  if (serialized.length <= APPROVAL_INPUT_LIMIT) return serialized;
  return serialized.slice(0, APPROVAL_INPUT_LIMIT - APPROVAL_INPUT_TRUNCATED.length) + APPROVAL_INPUT_TRUNCATED;
}

async function securityApproval(ctx, payload) {
  const nonce = process.env.${PI_SECURITY_REQUEST_NONCE_ENV};
  if (!nonce || !ctx?.hasUI || typeof ctx.ui?.confirm !== "function") return undefined;
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return ctx.ui.confirm(SECURITY_TITLE, SECURITY_PREFIX + nonce + "." + encoded);
}

async function securityChoice(ctx, payload, options) {
  const nonce = process.env.${PI_SECURITY_REQUEST_NONCE_ENV};
  if (!nonce || !ctx?.hasUI || typeof ctx.ui?.select !== "function") return undefined;
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return ctx.ui.select(SECURITY_TITLE + "\\n" + SECURITY_PREFIX + nonce + "." + encoded, options);
}

function text(message) {
  return { content: [{ type: "text", text: String(message).slice(0, 16000) }], details: {} };
}

function questionTool(pi) {
  pi.registerTool({
    name: "request_user_input",
    label: "Request User Input",
    description: "Ask one to three short blocking questions and wait for the user's structured response.",
    parameters: {
      type: "object",
      properties: {
        questions: { type: "array", minItems: 1, maxItems: 3, items: {
          type: "object",
          properties: {
            header: { type: "string", maxLength: 12 },
            id: { type: "string" },
            question: { type: "string" },
            options: { type: "array", minItems: 2, maxItems: 3, items: {
              type: "object", properties: {
                label: { type: "string" }, description: { type: "string" },
              }, required: ["label", "description"], additionalProperties: false,
            } },
          }, required: ["header", "id", "question", "options"], additionalProperties: false,
        } },
      }, required: ["questions"], additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      if (!ctx.hasUI) return text("Structured user input is unavailable in this Pi mode.");
      const answers = {};
      for (const question of params.questions) {
        if (signal?.aborted) return text("The user-input request was cancelled.");
        const labels = question.options.map((option) => option.label);
        const other = "Type Another Answer";
        const selected = await ctx.ui.select(question.question, [...labels, other], { signal });
        if (selected === undefined) return text("The user-input request was cancelled.");
        let answer = selected;
        if (selected === other) {
          answer = await ctx.ui.input(question.question, "Enter another answer", { signal });
          if (answer === undefined) return text("The user-input request was cancelled.");
        }
        answers[question.id] = { answers: [answer] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ answers }) }], details: { answers } };
    },
  });
}

export default function (pi) {
  let child;
  let nextId = 1;
  let buffer = "";
  let starting;
  const pending = new Map();

  // This CLI-supplied extension loads before project-local code. Pi persists the returned
  // canonical-directory decision in its own trust store, while Wollipog presents the decision as
  // a security approval instead of an ordinary extension question.
  pi.on("project_trust", async (event, ctx) => {
    const choice = await securityChoice(ctx, {
      kind: "project_trust",
      cwd: typeof event?.cwd === "string" ? event.cwd.slice(0, 4096) : "",
    }, ["Trust This Project", "Skip Project Resources"]);
    if (choice === "Trust This Project") return { trusted: "yes", remember: true };
    if (choice === "Skip Project Resources") return { trusted: "no", remember: true };
    return { trusted: "no" };
  });

  // tool_call is Pi's documented pre-execution interception point. A missing/cancelled bridge
  // blocks rather than falling through to execution; the driver applies the selected live mode.
  pi.on("tool_call", async (event, ctx) => {
    const approved = await securityApproval(ctx, {
      kind: "tool_call",
      toolCallId: typeof event?.toolCallId === "string" ? event.toolCallId.slice(0, 512) : "",
      toolName: typeof event?.toolName === "string" ? event.toolName.slice(0, 256) : "Pi Tool",
      input: approvalInput(event?.input),
    });
    if (approved !== true) return { block: true, reason: "Blocked by Wollipog permission policy." };
  });

  const failPending = (error) => {
    for (const request of pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.signal?.removeEventListener("abort", request.abort);
      request.reject(error);
    }
    pending.clear();
  };

  const send = (method, params, options = {}) => {
    if (!child?.stdin?.writable) return Promise.reject(new Error("Wollipog Agent Control is not running"));
    if (options.notification) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
      return Promise.resolve(undefined);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs === undefined ? HANDSHAKE_TIMEOUT_MS : options.timeoutMs;
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        request.signal?.removeEventListener("abort", request.abort);
        reject(new Error("Wollipog Agent Control request timed out"));
      }, timeoutMs);
      timer?.unref?.();
      const abort = () => {
        if (child?.stdin?.writable) child.stdin.write(JSON.stringify({ jsonrpc: "2.0",
          method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }) + "\\n");
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, { resolve, reject, timer, signal: options.signal, abort });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    });
  };

  const onLine = (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (request.timer) clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    if (message.error) request.reject(new Error(String(message.error.message || "Agent Control error")));
    else request.resolve(message.result);
  };

  const start = async (ctx) => {
    if (starting) return starting;
    starting = (async () => {
      const command = process.env.WOLLIPOG_PI_AGENT_CONTROL_COMMAND;
      const nonce = process.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE;
      let args;
      try { args = JSON.parse(process.env.WOLLIPOG_PI_AGENT_CONTROL_ARGS || "[]"); } catch { args = null; }
      if (!command || !nonce || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
        throw new Error("Wollipog Agent Control launch metadata is invalid");
      }
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true });
      child.stdin.on("error", (error) => failPending(error));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
          child.kill();
          failPending(new Error("Wollipog Agent Control response exceeded its bound"));
          return;
        }
        let newline;
        while ((newline = buffer.indexOf("\\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          onLine(line);
        }
      });
      child.stderr.resume();
      child.once("error", (error) => failPending(error));
      child.once("close", () => failPending(new Error("Wollipog Agent Control exited")));
      await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {
        name: "wollipog-pi-extension", version: ${JSON.stringify(String(PI_AGENT_CONTROL_PROTOCOL))},
      } });
      await send("notifications/initialized", {}, { notification: true });
      const listed = await send("tools/list", {});
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      if (!tools.length || tools.length > MAX_TOOLS) throw new Error("Wollipog Agent Control returned an invalid tool catalog");
      for (const tool of tools) {
        if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" ||
            !tool.inputSchema || typeof tool.inputSchema !== "object") {
          throw new Error("Wollipog Agent Control returned an invalid tool definition");
        }
        pi.registerTool({
          name: tool.name,
          label: tool.name.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" "),
          description: tool.description,
          parameters: tool.inputSchema,
          async execute(_id, params, signal) {
            if (signal?.aborted) return text("The tool call was cancelled.");
            const result = await send("tools/call", { name: tool.name, arguments: params },
              { timeoutMs: null, signal });
            const content = Array.isArray(result?.content)
              ? result.content.filter((item) => item?.type === "text" && typeof item.text === "string")
                .slice(0, 32)
                .map((item) => ({ type: "text", text: item.text.slice(0, 16000) }))
              : [];
            return { content: content.length ? content : [{ type: "text", text: "Tool returned no text." }],
              details: {}, isError: result?.isError === true };
          },
        });
      }
      questionTool(pi);
      if (process.env[${JSON.stringify(PI_ORCHESTRATOR_PRESET_TOOLS_ENV)}] === "1") {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), "read", "grep", "find", "ls"])]);
      }
      ctx.ui.setStatus(STATUS_KEY, nonce);
    })().catch((error) => {
      ctx.ui.notify("Wollipog Agent Control failed to start.", "error");
      throw error;
    });
    return starting;
  };

  pi.on("session_start", async (_event, ctx) => { await start(ctx); });
  pi.on("session_shutdown", async () => {
    failPending(new Error("Pi session closed"));
    child?.kill();
  });
}\n`;
}
