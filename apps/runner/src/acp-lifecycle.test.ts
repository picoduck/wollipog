import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acp.js";
import { AcpDriver } from "./drivers/acp-driver.js";
import type { DriverOptions } from "./drivers/driver.js";
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

test("ACP passthrough and native slash commands stay exact before the next task's artifact guidance", async () => {
  const child = fakeAgentProcess();
  const writes: string[] = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => writes.push(chunk));
  const client = new AcpClient({ command: "agent", args: [], cwd: process.cwd(), env: {},
    initialCommands: [{ name: "review", source: "builtin" }], artifactGuidance: "Manual awareness" },
    { onEvent: () => {}, onStderr: () => {}, onExit: () => {} }, { spawn: () => child, kill: () => {} });
  for (const [text, command, expected] of [["focus", "review", "/review focus"], [" /cost", undefined, " /cost"],
    ["normal task", undefined, "normal task"]] as const) {
    const pending = client.prompt(text, [], command);
    await nextTask();
    const request = JSON.parse(writes.join("").trim().split("\n").at(-1)!);
    assert.equal(request.method, "session/prompt");
    assert.deepEqual(request.params.prompt, expected.trimStart().startsWith("/")
      ? [{ type: "text", text: expected }] : [{ type: "text", text: expected }, { type: "text", text: "Manual awareness" }]);
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }) + "\n");
    assert.equal(await pending, "end_turn");
  }
  client.dispose();
});

const driverOptions: DriverOptions = {
  command: "agent",
  args: [],
  cwd: process.cwd(),
  env: {},
  config: {} as DriverOptions["config"],
  context: { kind: "native" },
};
const quietCallbacks = { onEvent: () => {}, onStderr: () => {}, onExit: () => {} };

/** An agent whose own boundary has no owner, as spawnAgent gives it: survivors are terminated
 * when it closes, so the ACP ledger proves it on its own. */
function agentWithBoundary(proven: boolean): { child: AgentProcess; terminations: () => number } {
  let terminations = 0;
  const child = Object.assign(fakeAgentProcess(), {
    posixBoundary: { owner: undefined, terminate: async () => { terminations += 1; return proven; } },
  }) as unknown as AgentProcess;
  return { child, terminations: () => terminations };
}

test("an ACP agent is proven gone through its own POSIX boundary", async () => {
  for (const [label, child, expected] of [
    ["an agent whose boundary found no survivor", agentWithBoundary(true).child, true],
    ["an agent whose boundary found survivors", agentWithBoundary(false).child, false],
    ["an agent without a boundary (Windows, WSL, no pid)", fakeAgentProcess(), false],
  ] as const) {
    const spawnOptions: Array<{ descendantOwner?: object }> = [];
    const driver = new AcpDriver(driverOptions, quietCallbacks, {
      spawn: ((options: { descendantOwner?: object }) => { spawnOptions.push(options); return child; }) as any,
      kill: () => {},
    });
    assert.equal(spawnOptions[0]?.descendantOwner, undefined, "the agent keeps its close-time survivor termination");
    driver.dispose();
    assert.equal(await driver.proveProcessTreeExit({ terminate: true }), expected, label);
  }
});

test("an ACP agent that exited on its own is proven without killing anything", async () => {
  const { child, terminations } = agentWithBoundary(true);
  const kills: unknown[] = [];
  const driver = new AcpDriver(driverOptions, quietCallbacks, { spawn: (() => child) as any, kill: (process) => { kills.push(process); } });
  assert.equal(await driver.proveProcessTreeExit({ terminate: false }), false, "a live agent is not proven gone");
  assert.equal(terminations(), 0, "the non-killing proof does not end a live agent's boundary");
  const exited = new AcpDriver(driverOptions, quietCallbacks, {
    spawn: (() => agentWithBoundary(true).child) as any, kill: (process) => { kills.push(process); },
  });
  const exitedChild = (exited as unknown as { client: { child: AgentProcess } }).client.child;
  exitedChild.emit("close", 0, null);
  assert.equal(await exited.proveProcessTreeExit({ terminate: false }), true, "transport close disposed the terminals");
  assert.deepEqual(kills, [], "the non-killing proof never kills");
  driver.dispose();
  exited.dispose();
});

test("an ACP proof needs both the agent and every client terminal proven gone", async () => {
  const driver = new AcpDriver(driverOptions, quietCallbacks, { spawn: (() => agentWithBoundary(true).child) as any, kill: () => {} });
  const client = (driver as unknown as { client: { proveTerminalTreesGone: () => Promise<boolean> } }).client;
  client.proveTerminalTreesGone = async () => false;
  driver.dispose();
  assert.equal(await driver.proveProcessTreeExit({ terminate: true }), false);
});

test("a real ACP agent and the terminal it ran are proven gone after disposal", {
  skip: process.platform === "win32", timeout: 20_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wollipog-acp-proof-"));
  const driver = new AcpDriver({
    ...driverOptions,
    command: process.execPath,
    args: [fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url))],
    cwd,
    env: { WOLLIPOG_MOCK_TERMINAL: "1" },
  }, quietCallbacks);
  try {
    await driver.initialize();
    await driver.newSession(cwd);
    assert.equal(await driver.prompt("exercise terminal services"), "end_turn");
    driver.dispose();
    assert.equal(await driver.proveProcessTreeExit({ terminate: true }), true);
    assert.equal(await driver.proveProcessTreeExit({ terminate: true }), true, "memoized");
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
