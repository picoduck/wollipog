import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "resume";
const threadId = scenario === "fresh" ? "fixture-fresh" : "fixture-resume";

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  if (message.method === "initialize") {
    if (message.params?.clientInfo?.name !== "wollipog") {
      send({ id: message.id, error: { code: -32602, message: "expected Wollipog client identity" } });
      return;
    }
    send({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/read" && scenario === "resume") {
    send({ id: message.id, result: { thread: { id: threadId, status: { type: "idle" }, turns: [{ id: "historical" }] } } });
    return;
  }
  if (message.method === "thread/resume" && scenario === "resume") {
    send({ id: message.id, result: { thread: { id: threadId, turns: [{ id: "historical" }] } } });
    return;
  }
  if (message.method === "thread/start" && scenario === "fresh") {
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "fixture-turn" } } });
    send({ method: "turn/started", params: { threadId, turn: { id: "fixture-turn" } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "fixture-turn", itemId: "m1", delta: "continued" } });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId: "fixture-turn",
        tokenUsage: {
          total: { inputTokens: 999, outputTokens: 999 },
          last: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
        },
      },
    });
    send({ method: "turn/completed", params: { threadId, turn: { id: "fixture-turn", status: "completed" } } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unexpected method ${message.method} in ${scenario}` } });
});
