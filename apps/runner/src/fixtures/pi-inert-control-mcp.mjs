// Fake MCP only. Catalog is a private synthetic snapshot; no handler invokes a provider/network.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.slice(2).join(",") !== "--agent-control-mcp") process.exit(96);
const tools = JSON.parse(Array.from({ length: Number(process.env.WOLLIPOG_INERT_CATALOG_PARTS) }, (_, index) =>
  process.env[`WOLLIPOG_INERT_CATALOG_${index}`]).join(""));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "notifications/cancelled") {
    appendFileSync(process.env.WOLLIPOG_INERT_EVENTS_FILE, "cancelled\n");
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.params.requestId,
      error: { code: -32800, message: "inert request cancelled" } })}\n`); return;
  }
  if (request.id === undefined) return;
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} } });
  else if (request.method === "tools/list") reply(request.id, { tools });
  else if (request.method === "tools/call" && request.params.name !== "wait_pull_request") {
    reply(request.id, { content: [{ type: "text", text: `inert:${request.params.name}` }] });
  }
});
