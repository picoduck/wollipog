// Minimal stdio MCP server for the Claude Code assumption probes (#3797). It serves the tools named
// in a JSON fixture, answers each call with that tool's scripted content, and appends every call to
// the fixture's log. No network, no credentials; the probe owns the process.
//
//   node claude-probe-mcp-server.mjs <fixture.json>
//   fixture: { "log": "/abs/calls.jsonl", "tools": [{ "name", "description", "content": [...] }] }
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return; // notifications need no answer
  switch (message.method) {
    case "initialize":
      reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "wollipog-claude-probe", version: "1.0.0" } });
      break;
    case "ping":
      reply(message.id, {});
      break;
    case "tools/list":
      reply(message.id, { tools: fixture.tools.map(({ name, description }) => ({ name, description,
        inputSchema: { type: "object", properties: {}, additionalProperties: true } })) });
      break;
    case "tools/call": {
      const tool = fixture.tools.find((t) => t.name === message.params?.name);
      appendFileSync(fixture.log, JSON.stringify({ name: message.params?.name, arguments: message.params?.arguments ?? null }) + "\n");
      if (tool) reply(message.id, { content: tool.content, isError: false });
      else fail(message.id, -32602, "unknown tool");
      break;
    }
    default:
      fail(message.id, -32601, "method not found");
  }
});
