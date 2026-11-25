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

test("ACP tracks unsolicited post-end_turn wakeup activity as a provider-initiated turn and holds settlement while tools or permissions stay open (#4905)", async () => {
  const child = fakeAgentProcess();
  const writes: string[] = [];
  const log: string[] = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => writes.push(chunk));
  const client = new AcpClient({
    command: "agent",
    args: [],
    cwd: process.cwd(),
    env: {},
  }, {
    onEvent: (event) => log.push(`event:${event.kind}`),
    onStderr: () => {},
    onExit: () => {},
    onProviderInitiatedTurn: (state, turnId) => log.push(`provider:${state}:${turnId}`),
  }, {
    spawn: () => child,
    kill: () => {},
    providerTurnSettleMs: 60,
    providerTurnResponseSettleMs: 30,
  });
  try {
    (client as unknown as { sessionId: string }).sessionId = "s_wakeup";
    const sendNotification = (update: Record<string, unknown>) => {
      child.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s_wakeup", update },
      }) + "\n");
    };

    // Normal prompt turn owns its own updates and never opens a provider-initiated turn.
    const promptPromise = client.prompt("launch background task");
    await nextTask();
    const promptReq = JSON.parse(writes.join("").trim().split("\n").at(-1)!) as { id: number };
    sendNotification({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "starting" } });
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } }) + "\n");
    assert.equal(await promptPromise, "end_turn");
    assert.equal(log.some((entry) => entry.startsWith("provider:")), false);

    // Runtime-state and trailing cancelled tool updates while idle must NOT start a wakeup turn.
    sendNotification({ sessionUpdate: "usage_update", size: 1000, used: 100 });
    sendNotification({ sessionUpdate: "session_info_update", title: "Background work" });
    sendNotification({ sessionUpdate: "tool_call_update", toolCallId: "tc_cancelled", status: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(log.some((entry) => entry.startsWith("provider:")), false);

    // Background task finishes after end_turn -> unsolicited tool_call_update starts wakeup turn.
    log.length = 0;
    sendNotification({ sessionUpdate: "tool_call_update", toolCallId: "tc_bg", status: "completed" });
    sendNotification({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "inspecting result" } });
    sendNotification({ sessionUpdate: "tool_call", toolCallId: "tc_followup", title: "check", status: "in_progress" });
    await nextTask();
    assert.equal(log[0], "provider:started:acp-provider:1",
      "provider-initiated turn must start before forwarding the first wakeup event");

    // While tc_followup stays in_progress, the wakeup must NOT settle even past providerTurnSettleMs.
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(log.some((entry) => entry.startsWith("provider:settled:")), false,
      "an open tool call must hold the wakeup turn active");

    // Complete the tool call and stream a reply; settlement emits agent_response_completed first.
    sendNotification({ sessionUpdate: "tool_call_update", toolCallId: "tc_followup", status: "completed" });
    sendNotification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.deepEqual(log.slice(-2), ["event:agent_response_completed", "provider:settled:acp-provider:1"]);

    // Unsolicited permission request after end_turn opens a wakeup and stays open until resolved.
    log.length = 0;
    let permRequestId = "";
    const client2 = new AcpClient({
      command: "agent",
      args: [],
      cwd: process.cwd(),
      env: {},
    }, {
      onEvent: (event) => {
        log.push(`event:${event.kind}`);
        if (event.kind === "permission_request") permRequestId = event.requestId;
      },
      onStderr: () => {},
      onExit: () => {},
      onProviderInitiatedTurn: (state, turnId) => log.push(`provider:${state}:${turnId}`),
    }, {
      spawn: () => fakeAgentProcess(),
      kill: () => {},
      providerTurnSettleMs: 50,
      providerTurnResponseSettleMs: 25,
    });
    try {
      const child2 = (client2 as unknown as { child: AgentProcess }).child;
      (client2 as unknown as { sessionId: string }).sessionId = "s_perm";
      child2.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "session/request_permission",
        params: {
          sessionId: "s_perm",
          toolCall: { toolCallId: "tc_p", title: "run test" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      }) + "\n");
      await nextTask();
      assert.deepEqual(log, ["provider:started:acp-provider:1", "event:permission_request"]);
      await new Promise((resolve) => setTimeout(resolve, 90));
      assert.equal(log.some((entry) => entry.startsWith("provider:settled:")), false,
        "a pending permission request must hold the wakeup turn active");
      assert.equal(client2.resolvePermission(permRequestId, "allow"), true);
      await new Promise((resolve) => setTimeout(resolve, 90));
      assert.equal(log.at(-1), "provider:settled:acp-provider:1");
    } finally {
      client2.dispose();
    }
  } finally {
    client.dispose();
  }
});

test("ACP wakeup turn settles cleanly on synchronous cancel during started, prompt(), and dispose() (#4905)", async () => {
  const child = fakeAgentProcess();
  const lifecycle: string[] = [];
  let client!: AcpClient;
  client = new AcpClient({
    command: "agent",
    args: [],
    cwd: process.cwd(),
    env: {},
  }, {
    onEvent: () => {},
    onStderr: () => {},
    onExit: () => {},
    onProviderInitiatedTurn: (state, turnId) => {
      lifecycle.push(`${state}:${turnId}`);
      // Mirror SessionManager Active Turn Capacity rejection calling client.cancel() synchronously
      // inside onProviderInitiatedTurn("started").
      if (state === "started" && turnId === "acp-provider:1") client.cancel();
    },
  }, {
    spawn: () => child,
    kill: () => {},
    providerTurnSettleMs: 500,
    providerTurnResponseSettleMs: 500,
  });
  try {
    (client as unknown as { sessionId: string }).sessionId = "s_cancel";
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s_cancel", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "wake" } } },
    }) + "\n");
    await nextTask();
    await nextTask();
    assert.deepEqual(lifecycle, ["started:acp-provider:1", "settled:acp-provider:1"]);

    // Starting a new prompt() settles an active wakeup turn first.
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s_cancel", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "wake 2" } } },
    }) + "\n");
    await nextTask();
    assert.deepEqual(lifecycle, ["started:acp-provider:1", "settled:acp-provider:1", "started:acp-provider:2"]);
    (client as unknown as { peer: { request: () => Promise<{ stopReason: string }> } }).peer.request = async () => ({ stopReason: "end_turn" });
    assert.equal(await client.prompt("next user turn"), "end_turn");
    assert.deepEqual(lifecycle, [
      "started:acp-provider:1",
      "settled:acp-provider:1",
      "started:acp-provider:2",
      "settled:acp-provider:2",
    ]);
  } finally {
    client.dispose();
  }
});

test("ACP synchronous capacity cancel on opening permission_request cancels its RPC without emitting a card (#4905)", async () => {
  for (const mode of ["default", "antigravity-full"] as const) {
    const child = fakeAgentProcess();
    const writes: string[] = [];
    const events: string[] = [];
    const lifecycle: string[] = [];
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => writes.push(chunk));
    let client!: AcpClient;
    client = new AcpClient({
      command: "agent",
      args: [],
      cwd: process.cwd(),
      env: {},
      ...(mode === "antigravity-full"
        ? { compatibility: { profile: "antigravity", resumable: false }, initialPermissionMode: "full_permissions" }
        : {}),
    }, {
      onEvent: (event) => events.push(event.kind),
      onStderr: () => {},
      onExit: () => {},
      onProviderInitiatedTurn: (state, turnId) => {
        lifecycle.push(`${state}:${turnId}`);
        if (state === "started") client.cancel();
      },
    }, {
      spawn: () => child,
      kill: () => {},
      providerTurnSettleMs: 50,
      providerTurnResponseSettleMs: 25,
    });
    try {
      (client as unknown as { sessionId: string }).sessionId = "s_cap_perm";
      child.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "session/request_permission",
        params: {
          sessionId: "s_cap_perm",
          toolCall: { toolCallId: "tc_cap", title: "run command" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      }) + "\n");
      await nextTask();
      await nextTask();
      const responses = writes
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
        .filter((msg) => msg.id === 91);
      assert.equal(responses.length, 1, mode);
      assert.deepEqual(responses[0]!.result, { outcome: { outcome: "cancelled" } }, mode);
      assert.deepEqual(events, [], `${mode}: capacity-cancelled wakeup must emit no permission card`);
      assert.equal((client as unknown as { permPending: Map<string, unknown> }).permPending.size, 0, mode);
      assert.deepEqual(lifecycle, ["started:acp-provider:1", "settled:acp-provider:1"], mode);
    } finally {
      client.dispose();
    }
  }
});

test("ACP stale client request from a cancelled wakeup cannot settle a newer wakeup prematurely, and terminal/release tracks wakeups (#4905)", async () => {
  const child = fakeAgentProcess();
  const lifecycle: string[] = [];
  const client = new AcpClient({
    command: "agent",
    args: [],
    cwd: process.cwd(),
    env: {},
  }, {
    onEvent: () => {},
    onStderr: () => {},
    onExit: () => {},
    onProviderInitiatedTurn: (state, turnId) => lifecycle.push(`${state}:${turnId}`),
  }, {
    spawn: () => child,
    kill: () => {},
    providerTurnSettleMs: 60,
    providerTurnResponseSettleMs: 30,
  });
  try {
    (client as unknown as { sessionId: string }).sessionId = "s_term";
    let resolveWaitA!: (value: { exitCode: number }) => void;
    let resolveWaitB!: (value: { exitCode: number }) => void;
    let releasedOrder: string[] = [];
    const terminals = (client as unknown as {
      terminals: {
        wait: (sid: string, tid: string) => Promise<{ exitCode: number }>;
        release: (sid: string, tid: string) => void;
      };
    }).terminals;
    terminals.wait = (_sid, tid) => new Promise((resolve) => {
      if (tid === "term_a") resolveWaitA = resolve;
      else resolveWaitB = resolve;
    });
    terminals.release = (_sid, tid) => {
      releasedOrder.push(`release:${tid}:${lifecycle.at(-1) ?? "none"}`);
    };

    // Wakeup A opens terminal/wait_for_exit, then is cancelled while wait A is still open.
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 101,
      method: "terminal/wait_for_exit",
      params: { sessionId: "s_term", terminalId: "term_a" },
    }) + "\n");
    await nextTask();
    assert.deepEqual(lifecycle, ["started:acp-provider:1"]);
    client.cancel();
    await nextTask();
    await nextTask();
    assert.deepEqual(lifecycle, ["started:acp-provider:1", "settled:acp-provider:1"]);

    // Wakeup B opens its own terminal/wait_for_exit.
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 102,
      method: "terminal/wait_for_exit",
      params: { sessionId: "s_term", terminalId: "term_b" },
    }) + "\n");
    await nextTask();
    assert.deepEqual(lifecycle, ["started:acp-provider:1", "settled:acp-provider:1", "started:acp-provider:2"]);

    // Resolving old wait A must NOT decrement B's in-flight request set or let B settle early.
    resolveWaitA({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.deepEqual(lifecycle, ["started:acp-provider:1", "settled:acp-provider:1", "started:acp-provider:2"],
      "old wakeup wait resolution must not settle wakeup B while wait B is still open");

    // Once wait B resolves, wakeup B settles after its quiet window.
    resolveWaitB({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.deepEqual(lifecycle, [
      "started:acp-provider:1",
      "settled:acp-provider:1",
      "started:acp-provider:2",
      "settled:acp-provider:2",
    ]);

    // terminal/release while idle starts a wakeup before running release() and settles after quiet window.
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 103,
      method: "terminal/release",
      params: { sessionId: "s_term", terminalId: "term_b" },
    }) + "\n");
    await nextTask();
    assert.deepEqual(releasedOrder, ["release:term_b:started:acp-provider:3"]);
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(lifecycle.at(-1), "settled:acp-provider:3");
  } finally {
    client.dispose();
  }
});
