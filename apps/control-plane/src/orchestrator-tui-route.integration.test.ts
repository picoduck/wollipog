import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

test("HTTP orchestrator TUI authentication follows the online runner's live shell lifecycle", { timeout: 45_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-tui-route-"));
  const database = join(root, "control-plane.db");
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));
  const runnerToken = "wollipogr_" + "t".repeat(43);
  const runner = { runnerId: "r", hostname: "fixture", os: "linux", version: "test", agents: [], workspaces: [] };
  const seed = ControlPlaneDb.open(database);
  try {
    const local = seed.localIdentityContext();
    seed.registerRunner(runner, Date.now(), PROTOCOL_VERSION);
    seed.issueRunnerCredential({
      credentialId: "rcred_71000000000000000000000000000000", runnerId: "r",
      organizationId: local.organizationId, ownerKind: "organization", ownerId: local.organizationId,
      label: "TUI fixture", tokenHash: hashToken(runnerToken), createdByUserId: local.userId,
      now: Date.now(), expiresAt: Date.now() + 60_000,
    });
    for (const mode of ["normal", "orchestrator", "stopped-orchestrator"]) {
      seed.createSession({ id: mode, runnerId: "r", workspaceId: null, agentId: null,
        title: mode, useWorktree: false, driver: "codex",
        config: mode !== "normal" ? { permissionMode: "orchestrator" } : {},
        scope: { organizationId: local.organizationId, owner: { kind: "user", userId: local.userId } },
        now: Date.now() });
      seed.updateSessionStatus(mode, "idle", Date.now());
    }
  } finally { seed.close(); }
  let logs = "";
  let socket: WebSocket | undefined;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database, CONTROL_PLANE_TOKEN: "tui-fixture-device-token" },
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
  const waitFrame = (type: string, sessionId?: string) => new Promise<Record<string, unknown>>((done, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`missing ${type}: ${logs}`)); }, 5000);
    const read = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data));
      if (value.type === type && (!sessionId || value.sessionId === sessionId)) { cleanup(); done(value); }
    };
    const cleanup = () => { clearTimeout(timer); socket!.removeEventListener("message", read); };
    socket!.addEventListener("message", read);
  });
  await new Promise<void>((done, reject) => {
    socket!.addEventListener("open", () => done(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("runner connection failed")), { once: true });
  });
  const registered = waitFrame("registered");
  socket.send(JSON.stringify({ type: "register", token: runnerToken, protocolVersion: PROTOCOL_VERSION,
    runner, liveSessions: ["normal", "orchestrator", "stopped-orchestrator"] }));
  await registered;
  // A positive binding ack also fences all earlier frames on this ordered runner socket.
  const barrier = async (mode = "orchestrator") => {
    const bound = waitFrame("agent_control_credential_registered", mode);
    socket!.send(JSON.stringify({ type: "agent_control_credential", sessionId: mode, tokenHash: hashToken("token-" + mode) }));
    assert.equal((await bound).accepted, true);
  };
  const request = (mode = "orchestrator", path = "/api/sessions", method = "GET", token = "token-" + mode) =>
    fetch(url + path, { method, signal: AbortSignal.timeout(3000),
      headers: { authorization: "Bearer " + token, [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: mode } });
  const shell = (shellId: string, sessionId: string, kind: "shell" | "agent_tui") => socket!.send(JSON.stringify({
    type: "shell_snapshot", shellId, sessionId, kind, name: "Fixture", createdAt: 1, pty: true,
    status: "running", exitCode: null, outputStartSeq: 1, outputEndSeq: 0, outputTruncated: false, chunks: [],
  }));
  await barrier("normal"); await barrier();
  assert.equal((await request()).status, 401, "idle without TUI is not live");
  shell("plain", "orchestrator", "shell"); await barrier();
  assert.equal((await request()).status, 401, "ordinary shell does not extend authority");
  shell("tui", "orchestrator", "agent_tui");
  shell("normal-tui", "normal", "agent_tui"); await barrier();
  assert.equal((await request()).status, 200);
  assert.equal((await request("normal")).status, 401, "ordinary idle credentials stay invalid");
  assert.equal((await request("orchestrator", "/api/sessions", "GET", "wrong")).status, 401);
  assert.equal((await request("orchestrator", "/api/sessions/orchestrator/shells", "POST")).status, 401,
    "closed command route is not authenticated");
  assert.equal((await request("orchestrator", "/api/sessions/normal/stop", "POST")).status, 404,
    "live TUI retains the descendant mutation fence");
  shell("stopped-tui", "stopped-orchestrator", "agent_tui"); await barrier("stopped-orchestrator");
  assert.equal((await request("stopped-orchestrator")).status, 200);
  socket.send(JSON.stringify({ type: "session_event", sessionId: "stopped-orchestrator", seq: 1,
    payload: { kind: "status", status: "stopped" } })); await barrier("stopped-orchestrator");
  assert.equal((await request("stopped-orchestrator")).status, 401, "live TUI cannot revive a stopped credential");
  socket.send(JSON.stringify({ type: "shell_exit", sessionId: "orchestrator", shellId: "tui", code: 0 })); await barrier();
  assert.equal((await request()).status, 401, "TUI exit revokes idle authority");
  shell("tui-again", "orchestrator", "agent_tui"); await barrier();
  assert.equal((await request()).status, 200);
  socket.close();
  for (let i = 0; i < 100 && (await request()).status === 200; i++) await delay(20);
  assert.equal((await request()).status, 401, "offline runner does not extend idle authority");
});
