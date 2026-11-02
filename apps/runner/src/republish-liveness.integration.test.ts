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
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

test("real runner dispatches processing ACKs, cancels republish on reconnect and falls back for old peers", { timeout: 60_000 }, async (t) => {
  const rows: string[][] = [];
  const barriers: number[][] = [];
  const cp = await startFakeControlPlane({ pongAfterPingCount: 1,
    protocolVersion: (connection) => connection < 2 ? PROTOCOL_VERSION : 269,
    onMessage: (_socket, message, connection) => {
      if (message.type === "session_runtime_updated") (rows[connection] ??= []).push(message.snapshot!.id);
      if (message.type === "runner_processing_barrier") (barriers[connection] ??= []).push(message.barrierId!);
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
  first.send(JSON.stringify({ type: "runner_processing_ack", barrierId: 999 }));
  await delay(100);
  assert.equal(rows[0]?.length, RUNNER_WINDOW_FRAMES, "an unrelated ACK must not advance the producer");
  first.send(JSON.stringify({ type: "runner_processing_ack", barrierId: barriers[0]![0] }));
  await until(() => rows[0]?.length === ids.length, "the actual ACK dispatcher did not release the next window");
  await until(() => barriers[0]?.length === 2, "final processing barrier never arrived");
  first.send(JSON.stringify({ type: "runner_processing_ack", barrierId: barriers[0]![1] }));
  assert.deepEqual(rows[0], ids);
  first.close();

  const second = await cp.waitForConnection(1, 10_000, () => output);
  await until(() => barriers[1]?.length === 1, "replacement did not begin a fresh inventory");
  assert.deepEqual(rows[1], ids.slice(0, RUNNER_WINDOW_FRAMES));
  second.close(); // an outstanding barrier must not leave its producer running on a new socket

  await cp.waitForConnection(2, 10_000, () => output);
  await until(() => rows[2]?.length === ids.length, "legacy peer did not receive the unpaced inventory");
  assert.deepEqual(rows[2], ids);
  assert.equal(barriers[2]?.length ?? 0, 0, "an old peer must never receive processing barriers");
  await until(() => output.includes("TEST_PENDING_REPUBLISH_CLOSED"),
    "the real daemon never closed the producer with an outstanding processing barrier");
  assert.equal(cp.connections.length, 3, output);
});

