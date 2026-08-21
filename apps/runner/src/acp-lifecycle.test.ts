import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AcpClient } from "./acp.js";
import type { AgentProcess } from "./spawn.js";

function fakeAgentProcess(): AgentProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
  }) as unknown as AgentProcess;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("ACP accepts a final JSON-RPC response delivered between exit and close", async () => {
  const child = fakeAgentProcess();
  const writes: string[] = [];
  const exits: Array<number | null> = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => writes.push(chunk));
  const client = new AcpClient({
    command: "agent",
    args: [],
    cwd: process.cwd(),
    env: {},
  }, {
    onEvent: () => {},
    onStderr: () => {},
    onExit: (code) => exits.push(code),
  }, {
    spawn: () => child,
    kill: () => {},
  });

  const initialized = client.initialize();
  const request = JSON.parse(writes.join("").trim()) as { id: number };
  let settled = false;
  void initialized.then(() => { settled = true; }, () => { settled = true; });
  child.emit("exit", 0, null);
  await nextTask();
  assert.equal(settled, false, "exit must not dispose an RPC response still buffered in stdout");
  assert.deepEqual(exits, []);

  child.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: { protocolVersion: 1, agentCapabilities: {} },
  }) + "\n");
  child.emit("close", 0, null);

  await initialized;
  assert.equal(client.negotiatedCapabilities()?.protocolVersion, 1);
  assert.deepEqual(exits, [0]);
  client.dispose();
});
