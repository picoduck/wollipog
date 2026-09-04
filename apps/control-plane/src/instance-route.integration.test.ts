import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CONTROL_PLANE_API_VERSION,
  PROTOCOL_VERSION,
  WOLLIPOG_CONTROL_PLANE_SERVICE,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type ControlPlaneInstanceInfo,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CONTROL_PLANE_TOKEN = "instance-route-integration-token";
const SHARED_RUNNER_ID = "runner_shared";
const SHARED_WORKSPACE_ID = "workspace_shared";
const SHARED_SESSION_ID = "session_shared";

interface SeededControlPlane {
  hostname: string;
  workspaceName: string;
  sessionTitle: string;
  deviceToken: string;
  operatorToken: string;
  agentToken: string;
}

function seedControlPlane(database: string, seed: SeededControlPlane, includeBox = false): void {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    if (includeBox) {
      db.createBox({
        boxId: "box_shared",
        runnerId: SHARED_RUNNER_ID,
        sshTarget: "test@shared-host",
        sshPort: 22,
        workspaces: [{ id: SHARED_WORKSPACE_ID, name: seed.workspaceName, path: `/workspaces/${seed.workspaceName}` }],
        autoReconnect: false,
        runnerDataDir: null,
        now: now - 1,
      });
    }
    db.registerRunner({
      runnerId: SHARED_RUNNER_ID,
      hostname: seed.hostname,
      os: "linux",
      version: "test",
      agents: [],
      workspaces: [{
        id: SHARED_WORKSPACE_ID,
        name: seed.workspaceName,
        path: `/workspaces/${seed.workspaceName}`,
      }],
    }, now);
    const identity = db.localIdentityContext();
    const operatorUserId = `operator_${seed.hostname}`;
    db.createIdentityMember({
      userId: operatorUserId,
      displayName: `${seed.hostname} Operator`,
      organizationId: identity.organizationId,
      role: "operator",
      now: now + 1,
    });
    db.createSession({
      id: SHARED_SESSION_ID,
      runnerId: SHARED_RUNNER_ID,
      workspaceId: SHARED_WORKSPACE_ID,
      agentId: null,
      title: seed.sessionTitle,
      titleSource: "user",
      useWorktree: false,
      driver: "acp",
      config: {},
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: operatorUserId } },
      now: now + 2,
    });
    assert.equal(db.setAgentControlCredential(
      SHARED_SESSION_ID,
      SHARED_RUNNER_ID,
      hashToken(seed.agentToken),
      now + 3,
    ), true);
    db.createDevice({
      id: `device_${seed.hostname}`,
      name: `${seed.hostname} Test Device`,
      tokenHash: hashToken(seed.deviceToken),
      now: now + 4,
    });
    db.createDevice({
      id: `operator_device_${seed.hostname}`,
      name: `${seed.hostname} Operator Device`,
      tokenHash: hashToken(seed.operatorToken),
      userId: operatorUserId,
      organizationId: identity.organizationId,
      now: now + 5,
    });
  } finally {
    db.close();
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(3_000)]);
}

function startControlPlane(port: number, database: string): { child: ChildProcess; logs: () => string } {
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database,
      CONTROL_PLANE_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs: () => output };
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise)),
    delay(timeoutMs).then(() => { throw new Error("child did not exit in time"); }),
  ]);
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`websocket failed to open: ${url}`)), { once: true });
  });
  return socket;
}

function waitForSocketMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for websocket message"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !predicate(parsed as Record<string, unknown>)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolvePromise(parsed as Record<string, unknown>);
    };
    socket.addEventListener("message", onMessage);
  });
}

function sessionSnapshot(status: "running" | "idle" = "running") {
  return {
    id: SHARED_SESSION_ID,
    workspaceId: SHARED_WORKSPACE_ID,
    agentId: null,
    title: "Live Shared Session",
    status,
    driver: "acp",
    useWorktree: false,
    worktreePath: null,
    config: {},
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    seq: 0,
    historyEpoch: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function sharedRows(
  database: string,
): Record<"runners" | "boxes" | "sessions" | "session_shells", Array<Record<string, unknown>>> {
  const raw = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = (table: "runners" | "boxes" | "sessions" | "session_shells", orderBy: string) =>
      (raw.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Array<Record<string, unknown>>)
        .map((row) => ({ ...row }));
    return {
      runners: rows("runners", "runner_id"),
      boxes: rows("boxes", "box_id"),
      sessions: rows("sessions", "id"),
      session_shells: rows("session_shells", "shell_id"),
    };
  } finally {
    raw.close();
  }
}

async function waitForLiveSharedRows(database: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = sharedRows(database);
    if (state.runners[0]?.status === "online" && state.boxes[0]?.status === "online" &&
        state.sessions[0]?.status === "running") return;
    await delay(25);
  }
  throw new Error(`shared state did not become live: ${JSON.stringify(sharedRows(database))}`);
}

async function printPairingUrl(
  port: number,
  database: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/control-plane/src/index.ts", "--print-pair-url"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Keep captured CLI streams deterministic when the parent test runner forces ANSI output.
        // This also prevents Node's FORCE_COLOR/NO_COLOR conflict warning from becoming CLI stderr.
        FORCE_COLOR: undefined,
        NO_COLOR: "1",
        CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: database,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", resolvePromise);
  });
  return { code, stdout, stderr };
}

async function waitForInstance(
  port: number,
  token: string,
  child: ChildProcess,
  logs: () => string,
): Promise<ControlPlaneInstanceInfo> {
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      const health = await fetch(`${origin}/healthz`);
      if (health.ok) {
        const response = await fetch(`${origin}/api/instance`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.ok) return await response.json() as ControlPlaneInstanceInfo;
      }
    } catch {
      /* process is still starting */
    }
    await delay(50);
  }
  throw new Error(`control plane did not become ready\n${logs()}`);
}

async function fetchAsPairedDevice<T>(port: number, path: string, token: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      // The production auth gate treats any proxy-forwarding header as non-loopback. This lets
      // the real spawned server exercise paired-device authentication without relying on a host
      // machine's particular LAN adapters or firewall configuration.
      "x-forwarded-for": "203.0.113.42",
    },
  });
  if (response.status !== 200) {
    const body = await response.text();
    assert.equal(response.status, 200, body);
  }
  return await response.json() as T;
}

async function assertSeededPayload(port: number, seed: SeededControlPlane): Promise<void> {
  const runners = await fetchAsPairedDevice<{ runners: RunnerView[] }>(
    port,
    "/api/runners",
    seed.deviceToken,
  );
  assert.deepEqual(runners.runners.map((runner) => runner.runnerId), [SHARED_RUNNER_ID]);
  assert.equal(runners.runners[0]?.hostname, seed.hostname);
  assert.equal(runners.runners[0]?.workspaces[0]?.id, SHARED_WORKSPACE_ID);
  assert.equal(runners.runners[0]?.workspaces[0]?.name, seed.workspaceName);

  const listed = await fetchAsPairedDevice<{ sessions: SessionView[] }>(
    port,
    "/api/sessions",
    seed.deviceToken,
  );
  assert.deepEqual(listed.sessions.map((session) => session.id), [SHARED_SESSION_ID]);
  assert.equal(listed.sessions[0]?.runnerId, SHARED_RUNNER_ID);
  assert.equal(listed.sessions[0]?.workspaceId, SHARED_WORKSPACE_ID);
  assert.equal(listed.sessions[0]?.workspaceName, seed.workspaceName);
  assert.equal(listed.sessions[0]?.title, seed.sessionTitle);

  const exact = await fetchAsPairedDevice<{ session: SessionView }>(
    port,
    `/api/sessions/lookup/by-id?id=${encodeURIComponent(SHARED_SESSION_ID)}`,
    seed.deviceToken,
  );
  assert.equal(exact.session.id, SHARED_SESSION_ID);
  assert.equal(exact.session.runnerId, SHARED_RUNNER_ID);
  assert.equal(exact.session.workspaceId, SHARED_WORKSPACE_ID);
  assert.equal(exact.session.workspaceName, seed.workspaceName);
  assert.equal(exact.session.title, seed.sessionTitle);
}

test("two real control planes isolate identical ids and persist identity and data", { timeout: 60_000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-instance-pair-"));
  const firstPort = await reservePort();
  let secondPort = await reservePort();
  while (secondPort === firstPort) secondPort = await reservePort();
  const firstDb = join(temp, "first.db");
  const secondDb = join(temp, "second.db");
  const firstSeed: SeededControlPlane = {
    hostname: "first-host",
    workspaceName: "First Workspace",
    sessionTitle: "First Control Plane Session",
    deviceToken: "first-device-token",
    operatorToken: "first-operator-token",
    agentToken: "first-agent-token",
  };
  const secondSeed: SeededControlPlane = {
    hostname: "second-host",
    workspaceName: "Second Workspace",
    sessionTitle: "Second Control Plane Session",
    deviceToken: "second-device-token",
    operatorToken: "second-operator-token",
    agentToken: "second-agent-token",
  };
  const children = new Set<ChildProcess>();
  t.after(async () => {
    await Promise.all([...children].map(stopChild));
    rmSync(temp, { recursive: true, force: true });
  });

  const missingDb = join(temp, "missing.db");
  const missingPrint = await printPairingUrl(firstPort, missingDb);
  assert.notEqual(missingPrint.code, 0);
  assert.equal(missingPrint.stdout, "");
  assert.match(missingPrint.stderr, /Start the control plane once/);
  assert.equal(existsSync(`${missingDb}.local-device-token`), false);

  // Seed through the production database API before either process opens its database. Both
  // stores deliberately reuse every entity id, so any accidental cross-instance cache or client
  // state bleed is visible in the host/workspace/title assertions below.
  seedControlPlane(firstDb, firstSeed);
  seedControlPlane(secondDb, secondSeed);

  const first = startControlPlane(firstPort, firstDb);
  const second = startControlPlane(secondPort, secondDb);
  children.add(first.child);
  children.add(second.child);
  const [firstInfo, secondInfo] = await Promise.all([
    waitForInstance(firstPort, firstSeed.deviceToken, first.child, first.logs),
    waitForInstance(secondPort, secondSeed.deviceToken, second.child, second.logs),
  ]);

  for (const port of [firstPort, secondPort]) {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    const health = await response.json() as { service?: unknown; protocolVersion?: unknown };
    assert.equal(health.service, WOLLIPOG_CONTROL_PLANE_SERVICE);
    assert.equal(health.protocolVersion, undefined, "the unauthenticated health probe does not fingerprint protocol support");
  }
  for (const info of [firstInfo, secondInfo]) {
    assert.equal(info.service, WOLLIPOG_CONTROL_PLANE_SERVICE);
    assert.equal(info.apiVersion, CONTROL_PLANE_API_VERSION);
    assert.match(info.instanceId, /^[0-9a-f-]{36}$/u);
  }
  assert.notEqual(firstInfo.instanceId, secondInfo.instanceId);
  assert.doesNotMatch(first.logs(), /#pair=|local-device-token/u,
    "ordinary piped startup must not put its durable credential into captured logs");

  const directLoopbackAnonymous = await fetch(`http://127.0.0.1:${firstPort}/api/instance`);
  assert.equal(directLoopbackAnonymous.status, 401, "loopback no longer substitutes for authentication");
  const anonymousCompatibility = await fetch(`http://127.0.0.1:${firstPort}/api/compatibility`);
  assert.equal(anonymousCompatibility.status, 401);
  const compatibility = await fetch(`http://127.0.0.1:${firstPort}/api/compatibility`, {
    headers: { authorization: `Bearer ${firstSeed.deviceToken}` },
  });
  assert.equal(compatibility.status, 200);
  assert.equal((await compatibility.json() as { protocolVersion?: unknown }).protocolVersion, PROTOCOL_VERSION);
  const operatorCompatibility = await fetch(`http://127.0.0.1:${firstPort}/api/compatibility`, {
    headers: { authorization: `Bearer ${firstSeed.operatorToken}` },
  });
  assert.equal(operatorCompatibility.status, 200, "an organization member can read compatibility metadata");
  const liveDb = ControlPlaneDb.open(firstDb);
  try {
    liveDb.updateSessionStatus(SHARED_SESSION_ID, "running", Date.now());
    assert.equal(liveDb.setAgentControlCredential(
      SHARED_SESSION_ID,
      SHARED_RUNNER_ID,
      hashToken(firstSeed.agentToken),
      Date.now(),
    ), true);
  } finally {
    liveDb.close();
  }
  const scopedAgentCompatibility = await fetch(`http://127.0.0.1:${firstPort}/api/compatibility`, {
    headers: {
      authorization: `Bearer ${firstSeed.agentToken}`,
      [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: SHARED_SESSION_ID,
    },
  });
  assert.equal(scopedAgentCompatibility.status, 200, "a user-scoped session credential can preflight its CLI");
  const unauthenticated = await fetch(`http://127.0.0.1:${firstPort}/api/instance`, {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
  assert.equal(unauthenticated.status, 401);
  const crossInstanceCredential = await fetch(`http://127.0.0.1:${secondPort}/api/instance`, {
    headers: {
      authorization: `Bearer ${firstSeed.deviceToken}`,
      "x-forwarded-for": "203.0.113.42",
    },
  });
  assert.equal(crossInstanceCredential.status, 401);

  const printed = await printPairingUrl(firstPort, firstDb);
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(printed.stderr, "");
  const match = /^http:\/\/127\.0\.0\.1:\d+\/#pair=([A-Za-z0-9_-]{43})\r?\n$/u.exec(printed.stdout);
  assert.ok(match, `unexpected --print-pair-url output: ${JSON.stringify(printed.stdout)}`);
  const bootstrapResponse = await fetch(`http://127.0.0.1:${firstPort}/api/instance`, {
    headers: { authorization: `Bearer ${match[1]}` },
  });
  assert.equal(bootstrapResponse.status, 200, "the reprinted local startup credential authenticates on loopback");
  const forwardedBootstrap = await fetch(`http://127.0.0.1:${firstPort}/api/instance`, {
    headers: {
      authorization: `Bearer ${match[1]}`,
      "x-forwarded-for": "203.0.113.42",
    },
  });
  assert.equal(forwardedBootstrap.status, 401, "the startup credential is never a remote owner credential");
  const [firstAuthedInfo, secondAuthedInfo] = await Promise.all([
    fetchAsPairedDevice<ControlPlaneInstanceInfo>(firstPort, "/api/instance", firstSeed.deviceToken),
    fetchAsPairedDevice<ControlPlaneInstanceInfo>(secondPort, "/api/instance", secondSeed.deviceToken),
  ]);
  assert.equal(firstAuthedInfo.instanceId, firstInfo.instanceId);
  assert.equal(secondAuthedInfo.instanceId, secondInfo.instanceId);

  await Promise.all([
    assertSeededPayload(firstPort, firstSeed),
    assertSeededPayload(secondPort, secondSeed),
  ]);

  await stopChild(first.child);
  children.delete(first.child);
  const restarted = startControlPlane(firstPort, firstDb);
  children.add(restarted.child);
  const restartedInfo = await waitForInstance(firstPort, firstSeed.deviceToken, restarted.child, restarted.logs);
  assert.equal(restartedInfo.instanceId, firstInfo.instanceId);
  assert.notEqual(restartedInfo.instanceId, secondInfo.instanceId);
  await assertSeededPayload(firstPort, firstSeed);

  // The untouched second process still resolves the same shared ids to its own distinct data.
  await assertSeededPayload(secondPort, secondSeed);
});

test("a duplicate start leaves the live control plane's runner, box, session, and shells untouched", { timeout: 60_000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-duplicate-start-"));
  const port = await reservePort();
  const database = join(temp, "control-plane.db");
  const seed: SeededControlPlane = {
    hostname: "shared-host",
    workspaceName: "Shared Workspace",
    sessionTitle: "Live Shared Session",
    deviceToken: "duplicate-start-device-token",
    operatorToken: "duplicate-start-operator-token",
    agentToken: "duplicate-start-agent-token",
  };
  seedControlPlane(database, seed, true);

  const children = new Set<ChildProcess>();
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
    await Promise.all([...children].map(stopChild));
    rmSync(temp, { recursive: true, force: true });
  });

  const first = startControlPlane(port, database);
  children.add(first.child);
  await waitForInstance(port, seed.deviceToken, first.child, first.logs);

  const runner = await openWebSocket(`ws://127.0.0.1:${port}/runner`);
  sockets.add(runner);
  const registered = waitForSocketMessage(runner, (message) => message.type === "registered");
  runner.send(JSON.stringify({
    type: "register",
    token: CONTROL_PLANE_TOKEN,
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId: SHARED_RUNNER_ID,
      hostname: seed.hostname,
      os: "linux",
      version: "integration",
      agents: [],
      workspaces: [{
        id: SHARED_WORKSPACE_ID,
        name: seed.workspaceName,
        path: `/workspaces/${seed.workspaceName}`,
      }],
    },
    sessionSnapshots: [sessionSnapshot()],
  }));
  await registered;
  await waitForLiveSharedRows(database);

  // A running shell is connection-owned state too: the duplicate's startup shell reconciliation
  // must not flip it to `reconnecting`.
  const rawDb = new DatabaseSync(database);
  try {
    rawDb.prepare(
      `INSERT INTO session_shells (shell_id, session_id, runner_id, name, created_at, updated_at)
       VALUES ('shell_shared', ?, ?, 'Shell 1', 1, 1)`,
    ).run(SHARED_SESSION_ID, SHARED_RUNNER_ID);
  } finally {
    rawDb.close();
  }

  const beforeDuplicate = sharedRows(database);
  assert.equal(beforeDuplicate.session_shells[0]?.status, "running");
  const duplicate = startControlPlane(port, database);
  children.add(duplicate.child);
  const duplicateExit = await waitForChildExit(duplicate.child);
  children.delete(duplicate.child);
  assert.notEqual(duplicateExit, 0, duplicate.logs());
  assert.match(duplicate.logs(), /EADDRINUSE/);

  assert.deepEqual(
    sharedRows(database),
    beforeDuplicate,
    "a process that never acquired the port must not mutate shared live-state rows",
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);

  const promptDelivery = waitForSocketMessage(
    runner,
    (message) => message.type === "prompt_session" && message.sessionId === SHARED_SESSION_ID,
  );
  const promptResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${SHARED_SESSION_ID}/prompt`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${seed.deviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Still connected after duplicate start" }),
  });
  const promptBody = await promptResponse.text();
  assert.equal(promptResponse.status, 200, promptBody);
  assert.doesNotMatch(promptBody, /runner is offline/i);
  assert.equal((await promptDelivery).text, "Still connected after duplicate start");
});
