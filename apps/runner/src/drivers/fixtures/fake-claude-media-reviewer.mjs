#!/usr/bin/env node
// Deterministic stand-in for `claude --bare -p --input-format stream-json ...` as the media-only
// reviewer. It talks MCP to the real runner relay socket (FAKE_MEDIA_SOCKET) and emits the startup,
// tool-use and priced result events the pinned CLI emits. No model or network is involved.
import { appendFileSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";

const args = process.argv.slice(2);
const mode = process.env.FAKE_MEDIA_MODE ?? "ok";
const record = (entry) => process.env.FAKE_MEDIA_RECORD && appendFileSync(process.env.FAKE_MEDIA_RECORD, JSON.stringify(entry) + "\n");
const model = args[args.indexOf("--model") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
record({ argv: args, apiKey: process.env.ANTHROPIC_API_KEY ? "present" : "absent", maxMcp: process.env.MAX_MCP_OUTPUT_TOKENS });

const socket = net.connect(process.env.FAKE_MEDIA_SOCKET);
const lines = readline.createInterface({ input: socket });
let nextId = 1;
const waiting = new Map();
lines.on("line", (line) => { const reply = JSON.parse(line); waiting.get(reply.id)?.(reply); waiting.delete(reply.id); });
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++; waiting.set(id, resolve);
  socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
});

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
const listed = (await rpc("tools/list")).result.tools.map((tool) => `mcp__media__${tool.name}`);
const sessionId = "6b0c3f7e-2d4a-4f1b-9c8e-5a7d1e3b9f20";
// The pinned 2.1.296 CLI under --bare announces one UI render notice before its startup init (#3849).
const preInit = () => args.includes("--bare") && emit(mode === "pre-init-other"
  ? { type: "system", subtype: "status", status: "starting", session_id: sessionId }
  : { type: "system", subtype: "ui_invalidate", event: "ui.render", uuid: "0d5e8c41-7a2b-4c6d-8e9f-1a2b3c4d5e6f", session_id: sessionId });
const init = () => emit({ type: "system", subtype: "init", session_id: sessionId, cwd: "/review",
  tools: mode === "extra-tool" ? [...listed, "Bash"] : listed,
  mcp_servers: [{ name: "media", status: "connected", source: "dynamic" }, ...(mode === "extra-server" ? [{ name: "fs", status: "connected" }] : [])],
  model, permissionMode: "dontAsk", slash_commands: [], skills: [],
  apiKeySource: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none", claude_code_version: "2.1.296",
  plugins: [{ name: "cc-plugin-telemetry", path: "builtin" }] });

let cost = 0, turn = 0, toolId = 0, observed = [];
const call = async (name, input) => {
  const id = `toolu_${++toolId}`;
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "tool_use", id, name: `mcp__media__${name}`, input }] } });
  const reply = await rpc("tools/call", { name, arguments: input });
  return reply.result;
};
const result = (text) => {
  cost += 0.01;
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, result: text, total_cost_usd: cost,
    // unpriced-then-priced: the first result omits per-model usage, a later one is fully priced.
    modelUsage: mode === "unpriced-then-priced" && turn === 1 ? {}
      : { [model]: { inputTokens: 1000 * turn, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } } });
};

const input = readline.createInterface({ input: process.stdin });
let first = 0, end = 0, final = false;
for await (const line of input) {
  const prompt = JSON.parse(line).message.content;
  turn++;
  if (turn === 1) preInit();
  init();
  record({ turn, prompt });
  // The real CLI's first tool call follows a model round trip; the runner proves init meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (turn === 1) {
    first = Number(/with index (\d+)/u.exec(prompt)[1]);
    end = Number(/until nextIndex reaches (\d+)/u.exec(prompt)[1]);
    final = prompt.includes("This is the final window");
    if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 30_000));
    if (mode === "use-bash") {
      emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "cat /etc/passwd" } }] } });
    }
    // skip-overlap: a later window starts after its overlap frame, relying on the earlier receipt.
    let index = mode === "skip-overlap" && first > 0 ? first + 1 : first;
    while (index < end) {
      const reply = await call("review_video_evidence_frame", { index });
      if (reply.isError) { record({ refusedAt: index, text: reply.content[0].text }); break; }
      const header = JSON.parse(reply.content[0].text);
      observed.push(...Array.from({ length: header.nextIndex - header.firstIndex }, (_, i) => header.firstIndex + i));
      index = header.nextIndex;
      if (mode === "skip-frame") break;
    }
  }
  if (final) {
    if (mode === "no-verdict-once" && turn === 1) { result("I inspected everything."); continue; }
    const verdict = await call("submit_video_evidence_verdict", { report: { outcome: "accept", rationale: "No transient defect observed.",
      criteria: [{ criterionId: "transition", outcome: "pass", observedFrameIndices: [...new Set(observed)].slice(0, 900), observation: "Every frame inspected." }] } });
    record({ verdict: verdict.isError ? "refused" : "confirmed" });
    result("Verdict submitted.");
    continue;
  }
  const notes = { window: { firstIndex: first, endIndex: end },
    observations: [{ fromIndex: first, toIndex: end - 1, description: "synthetic frames advance steadily" }],
    transients: [], defects: [] };
  const invalid = mode === "bad-notes" || (mode === "bad-notes-once" || mode === "unpriced-then-priced") && turn === 1;
  result(invalid ? "Notes: everything looked fine." : JSON.stringify(notes));
}
socket.end();
