import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type RunnerMetadata,
  type SessionSnapshot,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

test("an idle session can poll its own in-flight worktree create to completion while unrelated idle routes and new creates remain 401 (#4904)", { timeout: 45_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "worktree-idle-poll-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));

  const runnerToken = "wollipogr_" + "p".repeat(43);
  const deviceToken = "worktree-idle-poll-device-token";
  const agentToken = "worktree-idle-poll-agent-token";
  const runner: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "test", agents: [], workspaces: [] };
  const seed = ControlPlaneDb.open(database);
  try {
    const local = seed.localIdentityContext();
    seed.createDevice({
      id: "device_worktree_idle_poll",
      name: "Idle Poll Device",
      tokenHash: hashToken(deviceToken),
      now: Date.now(),
    });
    seed.registerRunner(runner, Date.now(), PROTOCOL_VERSION);
    seed.issueRunnerCredential({
      credentialId: "rcred_73000000000000000000000000000000",
      runnerId: "r",
      organizationId: local.organizationId,
      ownerKind: "organization",
      ownerId: local.organizationId,
      label: "Idle Poll fixture",
      tokenHash: hashToken(runnerToken),
      createdByUserId: local.userId,
      now: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    seed.createSession({
      id: "s",
      runnerId: "r",
      workspaceId: null,
      agentId: null,
      title: "Idle Poll",
      useWorktree: false,
      driver: "acp",
      config: {},
      scope: { organizationId: local.organizationId, owner: { kind: "user", userId: local.userId } },
      now: Date.now(),
    });
    seed.updateSessionStatus("s", "running", Date.now());
    assert.equal(seed.setAgentControlCredential("s", "r", hashToken(agentToken), Date.now()), true);
  } finally {
    seed.close();
  }

  let logs = "";
  let socket: WebSocket | undefined;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  t.after(async () => {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    try { healthy = (await fetch(url + "/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (healthy) break;
    await delay(50);
  }
  assert.ok(healthy, logs);

  socket = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  const runnerRequests: Array<Record<string, unknown>> = [];
  let activeWaitCleanup: (() => void) | undefined;
  const waitFrame = (type: string) => new Promise<Record<string, unknown>>((done, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`missing ${type}: ${logs}`)); }, 5000);
    const read = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data));
      if (value.type === "session_worktree") runnerRequests.push(value);
      if (value.type === type) { cleanup(); done(value); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket?.removeEventListener("message", read);
      if (activeWaitCleanup === cleanup) activeWaitCleanup = undefined;
    };
    activeWaitCleanup = cleanup;
    socket!.addEventListener("message", read);
  });
  t.after(() => activeWaitCleanup?.());
  await new Promise<void>((done, reject) => {
    socket!.addEventListener("open", () => done(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("runner connection failed")), { once: true });
  });
  const registered = waitFrame("registered");
  socket.send(JSON.stringify({
    type: "register",
    token: runnerToken,
    protocolVersion: PROTOCOL_VERSION,
    runner,
    liveSessions: ["s"],
  }));
  await registered;

  const waitForSessionStatus = async (expected: string) => {
    for (let i = 0; i < 60; i++) {
      const check = await fetch(url + "/api/sessions/s", {
        headers: { authorization: `Bearer ${deviceToken}` },
        signal: AbortSignal.timeout(5000),
      });
      const sessionData = await check.json() as { session?: { status?: string } };
      if (sessionData.session?.status === expected) return;
      await delay(25);
    }
    assert.fail(`session s did not reach status ${expected}`);
  };

  // Mark session running over the live runner channel (startup reconciles persisted rows before attach).
  socket.send(JSON.stringify({ type: "session_status", sessionId: "s", status: "running" }));
  await waitForSessionStatus("running");

  const agentHeaders = {
    authorization: `Bearer ${agentToken}`,
    [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: "s",
    "content-type": "application/json",
  };

  // 1. Live running session starts progress-aware worktree create -> 202 in_progress.
  const forwarded = waitFrame("session_worktree");
  const startRes = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ branch: "fix/idle-poll", progress: true }),
  });
  assert.equal(startRes.status, 202);
  const startBody = await startRes.json() as { operation: { id: string; status: string } };
  assert.equal(startBody.operation.status, "in_progress");
  const runnerReq = await forwarded;
  assert.equal(runnerReq.operation, "create");
  assert.equal(runnerReq.branch, "fix/idle-poll");
  assert.equal(runnerReq.requestedBySession, true);

  // 2. Requesting turn settles to `idle` while setup runs on the runner.
  socket.send(JSON.stringify({ type: "session_status", sessionId: "s", status: "idle" }));
  await waitForSessionStatus("idle");

  // 3. While idle, polling the exact in-flight create succeeds with 202 (no HTTP 401).
  const pollInProgress = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ branch: "fix/idle-poll", progress: true }),
  });
  assert.equal(pollInProgress.status, 202);
  assert.equal(((await pollInProgress.json()) as { operation: { id: string; status: string } }).operation.id,
    startBody.operation.id);

  // 4. While idle, a different branch, non-progress create, or unrelated route STILL fails with 401.
  const wrongBranch = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ branch: "fix/unauthorized-new-branch", progress: true }),
  });
  assert.equal(wrongBranch.status, 401);

  const nonProgress = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ branch: "fix/idle-poll" }),
  });
  assert.equal(nonProgress.status, 401);

  const unrelatedRoute = await fetch(url + "/api/sessions/s/worktrees/select", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ path: "/tmp/wt" }),
  });
  assert.equal(unrelatedRoute.status, 401);

  assert.equal(runnerRequests.length, 1, "rejected idle requests must never start a second runner operation");

  // 5. Runner finishes the create -> idle poller collects 200 completion + isolation notice once.
  const currentRes = await fetch(url + "/api/sessions/s", {
    headers: { authorization: `Bearer ${deviceToken}` },
    signal: AbortSignal.timeout(5000),
  });
  const currentSession = ((await currentRes.json()) as { session: SessionSnapshot }).session;
  const snapshot: SessionSnapshot = {
    ...currentSession,
    status: "idle",
    useWorktree: true,
    worktreePath: "/worktrees/fix-idle-poll",
    config: currentSession.config ?? {},
    costUsd: currentSession.costUsd ?? 0,
    tokensIn: currentSession.tokensIn ?? 0,
    tokensOut: currentSession.tokensOut ?? 0,
    updatedAt: Date.now(),
    seq: (currentSession.seq ?? 0) + 1,
  };
  socket.send(JSON.stringify({
    type: "session_worktree_result",
    requestId: runnerReq.requestId,
    sessionId: "s",
    operation: "create",
    ok: true,
    snapshot,
    worktree: { id: "wt_1", path: "/worktrees/fix-idle-poll", branch: "fix/idle-poll", source: "created" },
    isolation: { writableNow: false, writableAtNextLaunch: true, continuesAfterRelaunch: true },
  }));
  await delay(50);

  const collected = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ branch: "fix/idle-poll", progress: true }),
  });
  const collectedBody = await collected.json() as {
    operation: { id: string; status: string };
    isolation: { writableNow: boolean; writableAtNextLaunch: boolean; continuesAfterRelaunch?: boolean };
    error?: string;
  };
  assert.equal(collected.status, 200, JSON.stringify(collectedBody));
  assert.equal(collectedBody.operation.status, "completed");
  assert.deepEqual(collectedBody.isolation, {
    writableNow: false,
    writableAtNextLaunch: true,
    continuesAfterRelaunch: true,
  });

  // 6. Once consumed, polling again while still idle returns 401 and never starts a new create.
  const afterConsumed = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ branch: "fix/idle-poll", progress: true }),
  });
  assert.equal(afterConsumed.status, 401);

  // 7. A human-started create while the session is idle cannot be polled by the idle agent credential.
  const humanForwarded = waitFrame("session_worktree");
  const humanStart = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ branch: "fix/human-started", progress: true }),
  });
  assert.equal(humanStart.status, 202);
  await humanForwarded;

  const idlePollOfHumanCreate = await fetch(url + "/api/sessions/s/worktrees", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: agentHeaders,
    body: JSON.stringify({ branch: "fix/human-started", progress: true }),
  });
  assert.equal(idlePollOfHumanCreate.status, 401);
});
