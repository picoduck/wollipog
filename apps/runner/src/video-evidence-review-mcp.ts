import type { McpTool, ToolResult } from "./session-management-mcp.js";
import { reviewVideoEvidenceFrames, submitVideoEvidenceVerdict, type VideoReviewTransport } from "./video-evidence-review-transport.js";
import { mediaOnlyToolSet } from "./evidence-review-namespace.js";

export type ScopedMediaTool = Omit<McpTool, "handler"> & { handler(args: unknown): Promise<ToolResult> };

/** Created only by the managed media Session adapter from its exact server/runner grant.
 * The actual provider must additionally have strict MCP config, disabled generic tools and the
 * narrowed namespace. Listing two tools alone is never an isolation or live-validation proof. */
export function scopedVideoReviewTools(deps: {
  transport: VideoReviewTransport;
  actualSessionId: string;
  /** Current actual Session/admission, provider tool-image capability and enforced namespace.
   * Caller is the trusted runner, never model input or a code-review job receipt. */
  current(): boolean;
}): ScopedMediaTool[] {
  const allowed = () => {
    try { return deps.actualSessionId === deps.transport.grant.reviewerSessionId && deps.current(); }
    catch { return false; }
  };
  const refused = () => ({ content: [{ type: "text" as const, text: "The exact managed media Session grant is unavailable." }] as [{ type: "text"; text: string }], isError: true });
  const tools: ScopedMediaTool[] = [
    {
      name: "review_video_evidence_frame",
      description: "Inspect the next complete consecutive native video-frame window for this exact grant. Every image has its source timestamp and receipt. Continue at nextIndex until frameCount; these receipts alone are not a quality verdict.",
      inputSchema: { type: "object", properties: { index: { type: "integer", minimum: 0, maximum: 899 } },
        required: ["index"], additionalProperties: false },
      handler: async (args) => allowed() ? reviewVideoEvidenceFrames(args, deps.transport) : refused(),
    },
    {
      name: "submit_video_evidence_verdict",
      description: "Record pass/fail/blocked observations for every pinned criterion after inspecting every source frame. This records the actual worker's quality verdict; the authorized owner separately resolves the original typed UI gate.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["report"], properties: {
          report: { type: "object", additionalProperties: false, required: ["outcome", "criteria", "rationale"], properties: {
            outcome: { type: "string", enum: ["accept", "reject"] }, rationale: { type: "string", minLength: 1, maxLength: 8000 },
            criteria: { type: "array", minItems: 1, maxItems: 64, items: {
              type: "object", additionalProperties: false, required: ["criterionId", "outcome", "observedFrameIndices", "observation"],
              properties: { criterionId: { type: "string", minLength: 1, maxLength: 256 },
                outcome: { type: "string", enum: ["pass", "fail", "blocked"] },
                observedFrameIndices: { type: "array", minItems: 1, maxItems: 900, uniqueItems: true,
                  items: { type: "integer", minimum: 0, maximum: 899 } },
                observation: { type: "string", minLength: 1, maxLength: 4000 } },
            } },
          } },
        },
      },
      handler: async (args) => !allowed() ? refused() : args && typeof args === "object" &&
        Object.keys(args).length === 1 && Object.hasOwn(args, "report")
        ? submitVideoEvidenceVerdict((args as { report: unknown }).report, deps.transport) : refused(),
    },
  ];
  if (!mediaOnlyToolSet(tools.map((tool) => tool.name))) throw new Error("Media MCP registry is broader than the allowed namespace.");
  return tools;
}

/** Enforce the allowlist at dispatch as well as discovery; hiding extra names alone is insufficient. */
export function findScopedVideoReviewTool(tools: readonly ScopedMediaTool[], name: string): ScopedMediaTool | null {
  if (!mediaOnlyToolSet(tools.map((tool) => tool.name))) return null;
  return tools.find((tool) => tool.name === name) ?? null;
}

// Only the scoped registry above is exposed by this server. No manager tool dispatcher,
// resources, prompts, filesystem discovery or credential-bearing handler deps are imported.
type MediaRpcReply = { jsonrpc: "2.0"; id: string | number; result?: unknown; error?: { code: number; message: string } };
export async function dispatchScopedVideoReviewRpc(message: unknown, tools: readonly ScopedMediaTool[]): Promise<MediaRpcReply | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (m.id === undefined) return null;
  if (!(typeof m.id === "string" && m.id.length <= 256 || typeof m.id === "number" && Number.isSafeInteger(m.id))) return null;
  const reply = (result: unknown): MediaRpcReply => ({ jsonrpc: "2.0", id: m.id as string | number, result });
  const error = (code: number, message: string): MediaRpcReply => ({ jsonrpc: "2.0", id: m.id as string | number, error: { code, message } });
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string" || !mediaOnlyToolSet(tools.map((t) => t.name))) {
    return error(-32600, "Invalid scoped media request.");
  }
  if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} },
    serverInfo: { name: "wollipog-media-review", version: "1" } });
  if (m.method === "ping") return reply({});
  if (m.method === "tools/list") return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (m.method !== "tools/call") return error(-32601, "Method unavailable in the media-only reviewer namespace.");
  if (!m.params || typeof m.params !== "object" || Array.isArray(m.params) ||
    Object.keys(m.params).some((key) => !["name", "arguments"].includes(key))) return error(-32602, "Exact scoped tool arguments are required.");
  const params = m.params as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== "string") return error(-32602, "A scoped media tool name is required.");
  const tool = findScopedVideoReviewTool(tools, params.name);
  if (!tool) return reply({ content: [{ type: "text", text: "This tool is unavailable in the media-only reviewer namespace." }], isError: true });
  try { return reply(await tool.handler(params.arguments ?? {})); }
  catch { return reply({ content: [{ type: "text", text: "The exact media operation is unavailable." }], isError: true }); }
}

/** Actual bounded stdio endpoint for the narrowed provider MCP configuration. Creating the
 * endpoint grants no authority and does not launch a provider. Generic provider tools must
 * still be disabled and the OS namespace enforced by the actual managed Session adapter. */
export function serveScopedVideoReviewMcp(input: import("node:stream").Readable, output: import("node:stream").Writable,
  deps: Parameters<typeof scopedVideoReviewTools>[0]): void {
  const tools = scopedVideoReviewTools(deps);
  const inboundLimit = 512 * 1024;
  let buffer = "", mediaBusy = false, pending = 0, closed = false, ended = false;
  const stop = () => { closed = true; buffer = ""; input.destroy(); };
  const write = async (reply: MediaRpcReply | null): Promise<void> => {
    if (closed || !reply) return;
    const encoded = JSON.stringify(reply);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024 + 4096) { stop(); return; }
    if (output.write(encoded + "\n")) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); output.off("drain", done); output.off("error", done); resolve(); };
      const timer = setTimeout(() => { stop(); done(); }, 30_000);
      timer.unref?.();
      output.once("drain", done); output.once("error", done);
    });
  };
  const handle = (line: string) => {
    if (closed || Buffer.byteLength(line) > inboundLimit || pending >= 32) { stop(); return; }
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    const m = message as { id?: unknown; method?: unknown };
    const media = m?.method === "tools/call";
    const busy = media && mediaBusy;
    if (media && !busy) mediaBusy = true;
    pending++;
    const response = busy
      ? Promise.resolve(typeof m.id === "string" || typeof m.id === "number"
        ? { jsonrpc: "2.0" as const, id: m.id,
            result: { content: [{ type: "text", text: "Another exact media operation is pending; reconcile before continuing." }], isError: true } }
        : null)
      : dispatchScopedVideoReviewRpc(message, tools);
    void response.then(write).catch(() => { stop(); })
      .finally(() => { pending--; if (media && !busy) mediaBusy = false; if (ended && pending === 0) closed = true; });
  };
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    if (closed) return;
    buffer += chunk;
    let index: number;
    while (!closed && (index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); handle(line);
    }
    if (Buffer.byteLength(buffer) > inboundLimit) stop();
  });
  input.on("end", () => { ended = true; buffer = ""; if (pending === 0) closed = true; });
  input.on("error", stop);
  output.on("error", stop);
}
