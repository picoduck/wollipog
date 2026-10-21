import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RUNNER_CAPABILITY_MIN_PROTOCOL, type RunnerMetadata, type SessionSnapshot } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

test("fork route admits an in-place handoff, retains native and protocol gates, and explains legacy runner refusal", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-in-place-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const token = "in-place-handoff-owner-token";
  const runnerToken = `wollipogr_${"h".repeat(43)}`;
  const floor = RUNNER_CAPABILITY_MIN_PROTOCOL.conversationHandoff;
  const runner: RunnerMetadata = {
    runnerId: "handoff-runner", hostname: "handoff-fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "source-workspace", name: "Source", path: "/fixture/source" }],
    agents: ["codex-app-server", "claude-code"].map((driver, index) => ({
      id: index ? "destination" : "source", name: index ? "Destination" : "Source", driver,
      command: "fixture", args: [], env: {}, available: true, authStatus: "authenticated",
      capabilities: { models: [{ id: "test" }], effortLevels: [], permissionModes: [], slashCommands: [],
        supportsImages: true, supportsApprovals: true },
    })) as RunnerMetadata["agents"],
  };
  const source: SessionSnapshot = {
    id: "s_source", workspaceId: "source-workspace", workspacePath: "/fixture/source", agentId: "source",
    title: "In Place", status: "idle", driver: "codex-app-server", useWorktree: false, worktreePath: null,
    config: {}, preview: null, pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
    seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 1,
  };
  const db = ControlPlaneDb.open(database);
  const identity = db.localIdentityContext();
  const now = Date.now();
  db.createDevice({ id: "handoff-device", name: "Handoff", tokenHash: hashToken(token),
    userId: identity.userId, organizationId: identity.organizationId, now });
  db.registerRunner(runner, now, floor - 1);
  db.issueRunnerCredential({ credentialId: `rcred_${"handoff".padEnd(32, "0")}`, runnerId: runner.runnerId,
    organizationId: identity.organizationId, ownerKind: "organization", ownerId: identity.organizationId,
    label: "Handoff fixture", tokenHash: hashToken(runnerToken), createdByUserId: identity.userId,
    now, expiresAt: now + 60_000 });
  db.createSessionFromSnapshot(source, runner.runnerId, now, {
    organizationId: identity.organizationId, owner: { kind: "organization", organizationId: identity.organizationId },
  });
  db.close();
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port), CONTROL_PLANE_DB: database },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture); child.stderr?.on("data", capture);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) {
        child.kill("SIGKILL"); await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) assert.fail(output);
    try { if ((await fetch(`${base}/healthz`)).ok) { healthy = true; break; } } catch { /* starting */ }
    await delay(50);
  }
  assert.equal(healthy, true, output);
  const post = async (body: object) => {
    const response = await fetch(`${base}/api/sessions/${source.id}/fork`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const handoff = { turn: 1, handoff: { agentId: "destination", config: { model: "test" } } };
  const unsupported = await post(handoff);
  assert.equal(unsupported.status, 409);
  assert.match(String(unsupported.body.error), /runner/i);
  let legacyRefusal = true;
  let forks = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  sockets.push(socket);
  let registered!: () => void;
  const ready = new Promise<void>((resolve) => { registered = resolve; });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "registered") registered();
    if (message.type !== "fork_session") return;
    forks++;
    assert.equal(message.sourceSessionId, source.id);
    assert.equal(message.handoff.agentId, "destination");
    if (legacyRefusal) socket.send(JSON.stringify({ type: "fork_result", requestId: message.requestId,
      ok: false, error: "conversation fork requires a worktree session" }));
    else socket.send(JSON.stringify({ type: "fork_result", requestId: message.requestId, ok: true,
      snapshot: { ...source, id: message.targetSessionId, agentId: "destination", driver: "claude-code",
        useWorktree: true, worktreePath: "/fixture/new-worktree", config: handoff.handoff.config },
      events: [], handoffDraft: { text: "Files reflect the repository at hand-off time.", images: [], disclosure: "Current files." },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("runner socket failed")), { once: true });
  });
  socket.send(JSON.stringify({ type: "register", token: runnerToken, protocolVersion: floor, runner, sessionSnapshots: [source] }));
  await ready;
  const native = await post({ turn: 1 });
  assert.equal(native.status, 409);
  assert.match(String(native.body.error), /requires a worktree/);
  assert.equal(forks, 0);
  const legacy = await post(handoff);
  assert.equal(legacy.status, 409);
  assert.match(String(legacy.body.error), /Update the runner to support handoffs from in-place sessions/);
  legacyRefusal = false;
  const result = await post(handoff);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.workspaceId, source.workspaceId);
  assert.equal(result.body.worktreePath, "/fixture/new-worktree");
  assert.equal(result.body.agentId, "destination");
  assert.deepEqual(result.body.handoffDraft, { text: "Files reflect the repository at hand-off time.", images: [], disclosure: "Current files." });
  assert.equal(forks, 2);
});
