import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { transportRunnerEnvironment, waitForTransportRunnerProbe } from "./fixtures/transport-runner-environment.js";
import { startFakeControlPlane } from "./fixtures/fake-control-plane.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { SessionStore } from "./session-store.js";
import { RUNNER_WINDOW_FRAMES } from "./processing-window.js";
import { acquireRunnerDataDirLease } from "./runner-data-dir.js";
import { DurableCommandStore, durableCommandPayloadDigest } from "./durable-command-store.js";
import { SessionCommandReceiptStore, sessionCommandInvocationPayloadDigest } from "./session-command-receipt-store.js";
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

test("real runner dispatches processing ACKs, cancels republish on reconnect and falls back for old peers", { timeout: 60_000 }, async (t) => {
  const rows: string[][] = [];
  const queues: string[][] = [];
  const barriers: number[][] = [];
  const receipts: string[][] = [];
  const cp = await startFakeControlPlane({ pongAfterPingCount: 1,
    protocolVersion: (connection) => connection < 2 ? PROTOCOL_VERSION : 269,
    onMessage: (_socket, message, connection) => {
      if (message.type === "session_runtime_updated") (rows[connection] ??= []).push(message.snapshot!.id);
      if (message.type === "session_queue") (queues[connection] ??= []).push(message.sessionId!);
      if (message.type === "runner_processing_barrier") (barriers[connection] ??= []).push(message.barrierId!);
      if (message.type === "durable_session_command_update" || message.type === "session_command_invocation_update")
        (receipts[connection] ??= []).push(message.type);
    },
  });
  const temp = mkdtempSync(join(tmpdir(), "wollipog-republish-wiring-"));
  // Observe the actual daemon's cancellation call. Socket row counts alone cannot distinguish
  // a cancelled producer from one still blocked forever on an unanswered processing barrier.
  const observer = join(temp, "observe-republish-close.mjs");
  writeFileSync(observer, `
import { ProcessingWindow } from ${JSON.stringify(new URL("./processing-window.ts", import.meta.url).href)};
const close = ProcessingWindow.prototype.close;
ProcessingWindow.prototype.close = function() {
  if (Reflect.get(this, 'waiting')) console.error('TEST_PENDING_REPUBLISH_CLOSED');
  return Reflect.apply(close, this, []);
};
`);
  // Seed only this test's owned data directory, with the same attested identity as the child.
  acquireRunnerDataDirLease(join(temp, "runner-data"), { runnerId: "runner-republish-wiring",
    controlPlaneUrl: `ws://127.0.0.1:${cp.port}/runner`, controlPlaneInstanceId: cp.instanceId }).release();
  const store = new SessionStore(join(temp, "runner-data", "sessions"));
  const ids = Array.from({ length: RUNNER_WINDOW_FRAMES + 1 }, (_, i) => `synthetic-${i}`);
  for (const [i, id] of ids.entries()) store.create({ sessionId: id, agentId: "synthetic", workspaceId: "synthetic",
    repoPath: temp, worktreePath: null, driver: "claude-code", command: "synthetic", args: [], env: {},
    context: { kind: "native" }, agentSessionId: null, status: "completed", title: "Synthetic", config: {}, tokensIn: 0,
    tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1000 + i, updatedAt: 1000 + i });
  const durable = new DurableCommandStore(join(temp, "runner-data", "command-receipts"), { now: () => Date.now() });
  const command = { type: "prompt_session" as const, sessionId: ids[0]!, text: "Synthetic" };
  const claimed = durable.claim({ type: "durable_session_command", requestId: "request", commandId: "command",
    executionId: "execution", command, payloadDigest: durableCommandPayloadDigest(command), expiresAt: Date.now() + 600_000 });
  assert.equal(claimed.kind, "new");
  if (claimed.kind === "new") claimed.handle.completed();
  const invocations = new SessionCommandReceiptStore(join(temp, "runner-data", "session-command-receipts"), { now: () => Date.now() });
  const envelope = { type: "invoke_session_command" as const, requestId: "request", invocationId: "invocation",
    submissionId: "submission", sessionId: ids[0]!, providerCommandId: "provider", catalogRevision: "catalog",
    expectedExecutionMode: "passthrough" as const, argumentText: "", expiresAt: Date.now() + 600_000, payloadDigest: "" };
  envelope.payloadDigest = sessionCommandInvocationPayloadDigest(envelope);
  const invoked = invocations.claim(envelope);
  assert.equal(invoked.kind, "new");
  if (invoked.kind === "new") invoked.handle.completed();
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "--import", observer, "apps/runner/src/cli.ts"], {
    cwd: REPO_ROOT, env: { ...transportRunnerEnvironment(temp), RUNNER_ID: "runner-republish-wiring",
      RUNNER_TOKEN: "synthetic-runner", CONTROL_PLANE_URL: `ws://127.0.0.1:${cp.port}/runner` },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-65_536); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  t.after(async () => {
    try { await waitForTransportRunnerProbe(child, join(temp, "runner-data")); }
    finally { await stopChild(child); await cp.close(); rmSync(temp, { recursive: true, force: true }); }
  });
  const until = async (condition: () => boolean, message: string) => {
    const deadline = performance.now() + 10_000;
    while (!condition()) {
      assert.equal(child.exitCode, null, output);
      assert.equal(child.signalCode, null, output);
      if (performance.now() >= deadline) throw new Error(`${message}\n${output}`);
      await delay(20);
    }
  };
  const first = await cp.waitForConnection(0, 30_000, () => output);
  await until(() => barriers[0]?.length === 1, "first processing barrier never arrived");
  assert.equal(rows[0]?.length, RUNNER_WINDOW_FRAMES);
  assert.equal(queues[0]?.length ?? 0, 0, "queue inventory must share credits rather than publish ahead of runtime processing");
  assert.equal(receipts[0]?.length ?? 0, 0, "receipt replay must share processing credits");
  first.send(JSON.stringify({ type: "runner_processing_ack", barrierId: 999 }));
  await delay(100);
  assert.equal(rows[0]?.length, RUNNER_WINDOW_FRAMES, "an unrelated ACK must not advance the producer");
  first.send(JSON.stringify({ type: "runner_processing_ack", barrierId: barriers[0]![0] }));
  await until(() => queues[0]?.length === RUNNER_WINDOW_FRAMES, "the actual ACK dispatcher did not release the queue window");
  assert.equal(rows[0]?.length, RUNNER_WINDOW_FRAMES);
  await until(() => barriers[0]?.length === 2, "queue processing barrier never arrived");
  first.send(JSON.stringify({ type: "runner_processing_ack", barrierId: barriers[0]![1] }));
  await until(() => queues[0]?.length === ids.length, "the queue inventory did not use the actual ACK dispatcher");
  await until(() => barriers[0]?.length === 3, "final queue processing barrier never arrived");
  assert.deepEqual(receipts[0], ["durable_session_command_update", "session_command_invocation_update"]);
  first.send(JSON.stringify({ type: "runner_processing_ack", barrierId: barriers[0]![2] }));
  assert.deepEqual(queues[0], ids);
  assert.deepEqual(rows[0], ids);
  first.close();

  const second = await cp.waitForConnection(1, 10_000, () => output);
  await until(() => barriers[1]?.length === 1, "replacement did not begin a fresh inventory");
  assert.deepEqual(rows[1], ids.slice(0, RUNNER_WINDOW_FRAMES));
  assert.equal(queues[1]?.length ?? 0, 0);
  assert.equal(receipts[1]?.length ?? 0, 0, "a replacement regenerates unsent receipts without an outbox burst");
  second.close(); // an outstanding barrier must not leave its producer running on a new socket

  await cp.waitForConnection(2, 10_000, () => output);
  await until(() => rows[2]?.length === ids.length, "legacy peer did not receive the unpaced inventory");
  assert.deepEqual(rows[2], ids);
  await until(() => queues[2]?.length === ids.length, "legacy queue inventory was lost");
  assert.deepEqual(queues[2], ids);
  await until(() => receipts[2]?.length === 2, "legacy immediate receipt replay was lost");
  assert.deepEqual(receipts[2], ["durable_session_command_update", "session_command_invocation_update"]);
  assert.equal(barriers[2]?.length ?? 0, 0, "an old peer must never receive processing barriers");
  await until(() => output.includes("TEST_PENDING_REPUBLISH_CLOSED"),
    "the real daemon never closed the producer with an outstanding processing barrier");
  assert.equal(cp.connections.length, 3, output);
});

