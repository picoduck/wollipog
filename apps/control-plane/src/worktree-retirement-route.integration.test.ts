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
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  runnerCapabilityRequirement,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const LEGACY = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement - 1;
const REFUSAL = "worktree retained: the worktree is still handling a provider turn or queued input";

test("a legacy runner's discard refusal returns the shared sentence and structured versions", { timeout: 45_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "worktree-retirement-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));
  const runnerToken = "wollipogr_" + "w".repeat(43);
  const deviceToken = "worktree-retirement-device-token";
  const runner: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "test", agents: [], workspaces: [] };
  const seed = ControlPlaneDb.open(database);
  try {
    const local = seed.localIdentityContext();
    seed.createDevice({ id: "device_worktree_retirement", name: "Retirement Device",
      tokenHash: hashToken(deviceToken), now: Date.now() });
    seed.registerRunner(runner, Date.now(), LEGACY);
    seed.issueRunnerCredential({
      credentialId: "rcred_72000000000000000000000000000000", runnerId: "r",
      organizationId: local.organizationId, ownerKind: "organization", ownerId: local.organizationId,
      label: "Retirement fixture", tokenHash: hashToken(runnerToken), createdByUserId: local.userId,
      now: Date.now(), expiresAt: Date.now() + 60_000,
    });
    seed.createSession({ id: "s", runnerId: "r", workspaceId: null, agentId: null,
      title: "Retirement", useWorktree: true, driver: "codex", config: {},
      scope: { organizationId: local.organizationId, owner: { kind: "user", userId: local.userId } },
      now: Date.now() });
    seed.updateSessionStatus("s", "idle", Date.now());
  } finally { seed.close(); }
  let logs = "";
  let socket: WebSocket | undefined;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  t.after(async () => {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
        child.kill("SIGKILL"); await exited;
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
  const waitFrame = (type: string) => new Promise<Record<string, unknown>>((done, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`missing ${type}: ${logs}`)); }, 5000);
    const read = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data));
      if (value.type === type) { cleanup(); done(value); }
    };
    const cleanup = () => { clearTimeout(timer); socket!.removeEventListener("message", read); };
    socket!.addEventListener("message", read);
  });
  await new Promise<void>((done, reject) => {
    socket!.addEventListener("open", () => done(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("runner connection failed")), { once: true });
  });
  const registered = waitFrame("registered");
  socket.send(JSON.stringify({ type: "register", token: runnerToken, protocolVersion: LEGACY,
    runner, liveSessions: ["s"] }));
  await registered;

  const forwarded = waitFrame("session_worktree");
  const response = fetch(url + "/api/sessions/s/worktrees/discard", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { authorization: "Bearer " + deviceToken, "content-type": "application/json" },
    body: JSON.stringify({ path: "/worktrees/s" }),
  });
  const request = await forwarded;
  assert.equal(request.operation, "discard");
  socket.send(JSON.stringify({ type: "session_worktree_result", requestId: request.requestId,
    sessionId: "s", operation: "discard", ok: false, error: REFUSAL }));
  const reply = await response;
  assert.equal(reply.status, 409);
  const body = await reply.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    error: `${REFUSAL} — no retirement was recorded, so this refusal will not replay on its own. ` +
      "Retry the discard once the session's provider has exited. " +
      runnerCapabilityRequirement(LEGACY, "sessionWorktreeRetirement", "deferred worktree retirement"),
    retirement: { status: "unsupported", reason: "legacy_runner" },
    requiredRunnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement,
    runnerProtocolVersion: LEGACY,
  }, "the versions travel beside error and retirement instead of inside the sentence");
});
