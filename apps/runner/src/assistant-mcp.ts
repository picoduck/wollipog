/**
 * The agent-side half of a Wollipog Assistant thread's MCP proxy (`--assistant-mcp`, #4663).
 *
 * The harness launches this as its `wollipog_assistant` stdio server. It holds no credential:
 * each newline-delimited JSON-RPC message goes, unchanged, through the session's runner relay,
 * which adds the thread credential and forwards it to the control plane's `/assistant/mcp`.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { agentControlRelayFetch } from "./agent-control-relay.js";
import { ASSISTANT_MCP_PATH, ASSISTANT_RELAY_ENDPOINT_ENV, ASSISTANT_RELAY_KEY_ENV } from "./assistant-proxy.js";
import type { McpFetch } from "./session-management-mcp.js";

type JsonRpcId = string | number | null;

function rpcError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function messageId(message: unknown): { id: JsonRpcId; notification: boolean } {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { id: null, notification: false };
  const { id } = message as { id?: unknown };
  if (id === undefined) return { id: null, notification: true };
  return { id: typeof id === "string" || typeof id === "number" ? id : null, notification: false };
}

/** One request through the relay. Returns the line to write, or null for a notification. */
export async function forwardAssistantMessage(fetchImpl: McpFetch, line: string): Promise<string | null> {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return rpcError(null, -32700, "The message is not valid JSON."); }
  const { id, notification } = messageId(parsed);
  try {
    const response = await fetchImpl(`http://wollipog-assistant.invalid${ASSISTANT_MCP_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: line,
    });
    const text = await response.text();
    if (notification) return null;
    if (response.ok && text) {
      // Re-serialize so the response is exactly one line on stdout.
      try { return JSON.stringify(JSON.parse(text)); } catch { return rpcError(id, -32603, "Wollipog returned an unreadable response."); }
    }
    let reason = `Wollipog answered HTTP ${response.status}.`;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body?.error === "string") reason = body.error;
    } catch { /* keep the status */ }
    return rpcError(id, -32001, reason);
  } catch (error) {
    if (notification) return null;
    return rpcError(id, -32603, `The Wollipog Assistant proxy is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runAssistantMcp(env: NodeJS.ProcessEnv, input: Readable = process.stdin,
  output: Writable = process.stdout): Promise<void> {
  const endpoint = env[ASSISTANT_RELAY_ENDPOINT_ENV];
  const key = env[ASSISTANT_RELAY_KEY_ENV];
  if (!endpoint || !key) {
    console.error("[wollipog-assistant-mcp] this session has no Wollipog Assistant proxy");
    process.exitCode = 1;
    return;
  }
  const fetchImpl = agentControlRelayFetch(endpoint, key);
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    // Requests run concurrently; MCP matches responses to requests by id.
    const task = forwardAssistantMessage(fetchImpl, line).then((reply) => { if (reply !== null) output.write(`${reply}\n`); });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.allSettled([...pending]);
}
