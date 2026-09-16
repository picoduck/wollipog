/** Runner-owned Pi extension source. It intentionally has no package imports so the generated
 * file can be loaded by any compatible Pi installation, including the single-file runner. */

export const PI_AGENT_CONTROL_PROTOCOL = 1;
export const PI_AGENT_CONTROL_STATUS_KEY = "wollipog-agent-control";
export const PI_AGENT_CONTROL_EXTENSION_SUFFIX = ".pi-agent-control.mjs";
export const PI_AGENT_CONTROL_PROBE_COMMAND = "wollipog-agent-control-probe";

export const PI_AGENT_CONTROL_ENV_KEYS = [
  "WOLLIPOG_PI_AGENT_CONTROL_COMMAND",
  "WOLLIPOG_PI_AGENT_CONTROL_ARGS",
  "WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE",
] as const;

export function piAgentControlProbeSource(): string {
  return `export default function (pi) {
  pi.registerCommand(${JSON.stringify(PI_AGENT_CONTROL_PROBE_COMMAND)}, {
    description: "Wollipog Agent Control compatibility probe",
    handler: async () => {},
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
const REQUEST_TIMEOUT_MS = 35_000;
const STATUS_KEY = ${JSON.stringify(PI_AGENT_CONTROL_STATUS_KEY)};

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

  const failPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const send = (method, params, notification = false) => {
    if (!child?.stdin?.writable) return Promise.reject(new Error("Wollipog Agent Control is not running"));
    if (notification) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
      return Promise.resolve(undefined);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Wollipog Agent Control request timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
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
    clearTimeout(request.timer);
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
      await send("notifications/initialized", {}, true);
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
            const result = await send("tools/call", { name: tool.name, arguments: params });
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
      if (process.env.WOLLIPOG_PERMISSION_PRESET === "orchestrator") {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), "read", "grep", "find", "ls"])]);
      }
      ctx.ui.setStatus(STATUS_KEY, nonce);
    })().catch((error) => {
      ctx.ui.notify("Wollipog Agent Control failed to start: " + String(error?.message || error), "error");
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
