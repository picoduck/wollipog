import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type ResourceScope, type RunnerMetadata } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "./local-device-credential.js";
import { MAX_UI_CLIENT_MESSAGE_BYTES } from "./ui-channel.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CONTROL_PLANE_TOKEN = "ui-route-integration-token";

type JsonObject = Record<string, unknown>;
interface StrictSocket {
  readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  once(event: "open", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

// Use the same `ws` implementation @fastify/websocket depends on for exact close-frame codes.
const testRequire = createRequire(import.meta.url);
const websocketPluginRequire = createRequire(testRequire.resolve("@fastify/websocket"));
const StrictWebSocket = websocketPluginRequire("ws").WebSocket as new (
  url: string,
  options?: { headers?: Record<string, string> },
) => StrictSocket;

class JsonInbox {
  private readonly queued: JsonObject[] = [];
  private readonly waiters = new Set<{
    predicate: (message: JsonObject) => boolean;
    resolve: (message: JsonObject) => void;
  }>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const object = message as JsonObject;
      for (const waiter of this.waiters) {
        if (!waiter.predicate(object)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(object);
        return;
      }
      this.queued.push(object);
    });
  }

  take(predicate: (message: JsonObject) => boolean, timeoutMs = 5_000): Promise<JsonObject> {
    const existing = this.queued.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(this.queued.splice(existing, 1)[0]!);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonObject) => {
          clearTimeout(timer);
          resolvePromise(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timed out waiting for websocket message"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  has(predicate: (message: JsonObject) => boolean): boolean {
    return this.queued.some(predicate);
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
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function openSocketWithInbox(url: string): Promise<{ socket: WebSocket; inbox: JsonInbox }> {
  const socket = new WebSocket(url);
  // Attach before awaiting `open`: the /ui route sends its snapshot immediately and a fast local
  // server can deliver it before code resumed from the open event installs another listener.
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolvePromise, reject) => {
    const onOpen = () => {
      socket.removeEventListener("error", onError);
      resolvePromise();
    };
    const onError = () => {
      socket.removeEventListener("open", onOpen);
      reject(new Error(`websocket failed to open: ${url}`));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
  return { socket, inbox };
}

async function openStrictSocket(url: string): Promise<StrictSocket> {
  const socket = new StrictWebSocket(url);
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  return socket;
}

function fetchWithBearer(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

async function waitForValue<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(10);
    value = await read();
  }
  return value;
}

function authenticatedUiUrl(wsBase: string, token: string): string {
  return `${wsBase}/ui?token=${encodeURIComponent(token)}`;
}

async function closeAfter(socket: StrictSocket, sendInvalid: () => void): Promise<{ code: number; reason: string }> {
  const closed = new Promise<{ code: number; reason: string }>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket close")), 5_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolvePromise({ code, reason: reason.toString("utf8") });
    });
  });
  sendInvalid();
  return closed;
}

async function rejectedSocket(
  url: string,
  options?: { headers?: Record<string, string> },
): Promise<{ code: number; reason: string }> {
  const socket = new StrictWebSocket(url, options);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket rejection")), 5_000);
    socket.once("error", () => {
      /* The authoritative policy close below carries the reason. */
    });
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolvePromise({ code, reason: reason.toString("utf8") });
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(3_000)]);
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  // The repository suite starts every test file concurrently. On a busy Windows host the tsx
  // child can spend several seconds waiting for CPU before it reaches Fastify.listen(), so this
  // readiness budget must cover suite contention rather than only the focused-test fast path.
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      /* listen has not completed */
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

function sessionSnapshot(id: string) {
  return {
    id,
    workspaceId: "workspace-1",
    agentId: "agent-1",
    title: id,
    status: "idle",
    driver: "claude-code",
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

function runnerRegistration(runnerId: string, token: string) {
  return {
    type: "register",
    token,
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId,
      hostname: "legacy-credential-host",
      os: "linux",
      version: "integration",
      workspaces: [],
      agents: [],
    },
    sessionSnapshots: [],
  };
}

test("real /ui route advertises and acknowledges targeted bounded subscriptions", { timeout: 45_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-ui-route-"));
  const databasePath = join(temp, "control-plane.db");
  const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
  const operatorToken = "ui-route-project-operator-token";
  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  seed.createIdentityMember({
    userId: "usr_ui_route_operator",
    displayName: "UI Route Operator",
    organizationId: identity.organizationId,
    role: "operator",
    now: 1,
  });
  seed.createIdentityMember({
    userId: "usr_ui_route_alice",
    displayName: "UI Route Alice",
    organizationId: identity.organizationId,
    role: "operator",
    now: 1,
  });
  seed.createIdentityMember({
    userId: "usr_ui_route_bob",
    displayName: "UI Route Bob",
    organizationId: identity.organizationId,
    role: "operator",
    now: 1,
  });
  const scopeTeam = seed.createIdentityTeam({
    teamId: "team_ui_route_scope",
    organizationId: identity.organizationId,
    name: "UI Route Scope Team",
    memberUserIds: ["usr_ui_route_operator", "usr_ui_route_alice"],
    now: 1,
  });
  const alicePrivateProject = seed.createProject({
    name: "Alice Private Project",
    scope: {
      organizationId: identity.organizationId,
      owner: { kind: "user", userId: "usr_ui_route_alice" },
    },
    now: 1,
  });
  const secondAlicePrivateProject = seed.createProject({
    name: "Second Alice Private Project",
    scope: {
      organizationId: identity.organizationId,
      owner: { kind: "user", userId: "usr_ui_route_alice" },
    },
    now: 1,
  });
  const bobPrivateProject = seed.createProject({
    name: "Bob Private Project",
    scope: {
      organizationId: identity.organizationId,
      owner: { kind: "user", userId: "usr_ui_route_bob" },
    },
    now: 1,
  });
  seed.createDevice({
    id: "dev_ui_route_operator",
    name: "UI Route Operator Device",
    tokenHash: hashToken(operatorToken),
    userId: "usr_ui_route_operator",
    organizationId: identity.organizationId,
    now: 2,
  });
  const legacyRunnerToken = `mamr_${"a".repeat(43)}`;
  const legacyCredentialNow = Date.now();
  seed.issueRunnerCredential({
    credentialId: "rcred_11111111111111111111111111111111",
    runnerId: "runner-legacy-warning",
    organizationId: identity.organizationId,
    ownerKind: "organization",
    ownerId: identity.organizationId,
    label: "Legacy warning fixture",
    tokenHash: hashToken(legacyRunnerToken),
    createdByUserId: identity.userId,
    now: legacyCredentialNow,
    expiresAt: legacyCredentialNow + 60_000,
  });
  seed.close();
  let output = "";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/control-plane/src/index.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath,
        CONTROL_PLANE_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const capture = (chunk: unknown) => {
    output = (output + String(chunk)).slice(-32_768);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const sockets = new Set<WebSocket>();
  const strictSockets = new Set<StrictSocket>();
  t.after(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    for (const socket of strictSockets) {
      if (socket.readyState < 2) socket.close();
    }
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  const httpBase = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  await waitForHealth(httpBase, child, () => output);

  const invalidLegacy = await openSocketWithInbox(`${wsBase}/runner`);
  sockets.add(invalidLegacy.socket);
  invalidLegacy.socket.send(JSON.stringify(runnerRegistration(
    "runner-legacy-rejected",
    `mamr_${"b".repeat(43)}`,
  )));
  await invalidLegacy.inbox.take((message) => message.type === "register_rejected");

  const firstLegacy = await openSocketWithInbox(`${wsBase}/runner`);
  sockets.add(firstLegacy.socket);
  firstLegacy.socket.send(JSON.stringify(runnerRegistration("runner-legacy-warning", legacyRunnerToken)));
  await firstLegacy.inbox.take((message) => message.type === "registered");
  const onlineLegacyRunnerLineCount = () => output
    .split(/\r?\n/u)
    .filter((line) => line.includes("runner online: runner-legacy-warning")).length;
  await waitForValue(
    onlineLegacyRunnerLineCount,
    (count) => count >= 1,
    "the log sentinel after the first legacy runner registration",
  );

  const repeatedLegacy = await openSocketWithInbox(`${wsBase}/runner`);
  sockets.add(repeatedLegacy.socket);
  repeatedLegacy.socket.send(JSON.stringify(runnerRegistration("runner-legacy-warning", legacyRunnerToken)));
  await repeatedLegacy.inbox.take((message) => message.type === "registered");
  await waitForValue(
    onlineLegacyRunnerLineCount,
    (count) => count >= 2,
    "the log sentinel after the repeated legacy runner registration",
  );
  const legacyWarningLines = output
    .split(/\r?\n/u)
    .filter((line) => line.includes("a runner authenticated with a legacy credential"));
  assert.equal(
    legacyWarningLines.length,
    1,
    "only successful authentication warns, at most once per runner process",
  );
  assert.equal(legacyWarningLines[0]!.includes("runner-legacy-warning"), false);
  assert.equal(legacyWarningLines[0]!.includes("mamr_"), false);
  assert.equal(legacyWarningLines[0]!.includes("wollipogr_"), false);
  assert.equal(legacyWarningLines[0]!.includes(legacyRunnerToken), false);

  const credentialResponse = await fetch(`${httpBase}/api/runner-credentials`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ runnerId: "runner-ui-route", label: "UI route integration" }),
  });
  assert.equal(credentialResponse.status, 201);
  const credential = await credentialResponse.json() as { token: string };
  assert.match(credential.token, /^wollipogr_[A-Za-z0-9_-]{43}$/u);

  const { socket: runner, inbox: runnerInbox } = await openSocketWithInbox(`${wsBase}/runner`);
  sockets.add(runner);
  runner.send(JSON.stringify({
    type: "register",
    token: credential.token,
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId: "runner-ui-route",
      hostname: "integration-host",
      os: "linux",
      version: "integration",
      workspaces: [{ id: "workspace-1", name: "Workspace", path: "/workspace" }],
      agents: [{
        id: "agent-1",
        name: "Agent",
        command: "agent",
        args: [],
        env: {},
        driver: "claude-code",
        context: { kind: "native" },
      }],
    },
    sessionSnapshots: [
      sessionSnapshot("session-target"),
      sessionSnapshot("session-other"),
      { ...sessionSnapshot("session-history"), status: "stopped", seq: 3, historyEpoch: 9 },
    ],
  }));
  await runnerInbox.take((message) => message.type === "registered");

  const memberSearch = await fetch(`${httpBase}/api/search?q=session`, {
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  assert.equal(memberSearch.status, 200, "an authorized scoped member can search accessible transcripts");

  const scopedReveal = fetch(`${httpBase}/api/runners/runner-ui-route/host-action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind: "reveal", path: "/workspace" }),
  });
  const revealRequest = await runnerInbox.take((message) => message.type === "host_action");
  runner.send(JSON.stringify({
    type: "host_action_result",
    requestId: revealRequest.requestId,
    ok: true,
  }));
  assert.equal((await scopedReveal).status, 200, "an authorized scoped member can reveal an exact workspace root");
  const invalidScopedReveal = await fetch(`${httpBase}/api/runners/runner-ui-route/host-action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind: "reveal", path: "/not-a-workspace" }),
  });
  assert.equal(invalidScopedReveal.status, 400, "member scope does not bypass the exact workspace-root gate");

  const ownerFetch = (path: string, init?: RequestInit) =>
    fetchWithBearer(`${httpBase}${path}`, ownerToken, init);

  for (const body of [
    { action: "commit", message: "must stay isolated" },
    { action: "diff", scope: "uncommitted" },
    { action: "github_review_sync" },
    { action: "forge_review_sync" },
  ]) {
    const response = await ownerFetch("/api/sessions/session-target/git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 409);
    assert.match(
      (await response.json() as { error: string }).error,
      /requires a linked worktree session/,
    );
  }
  assert.equal(
    runnerInbox.has((message) => message.type === "git_action" && message.sessionId === "session-target"),
    false,
    "primary-checkout mutation and diff requests are rejected before runner dispatch",
  );

  for (const action of ["status", "summary"] as const) {
    const pending = ownerFetch("/api/sessions/session-target/git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const request = await runnerInbox.take((message) =>
      message.type === "git_action" &&
      message.sessionId === "session-target" &&
      (message.action as { kind?: string } | undefined)?.kind === action);
    assert.equal("worktreePath" in request, false, "primary reads omit caller-selected paths on the wire");
    runner.send(JSON.stringify({
      type: "git_result",
      requestId: request.requestId,
      ok: true,
      data: action === "summary"
        ? {
            summary: {
              branch: "main",
              ahead: 0,
              behind: 0,
              hasChanges: false,
              addedLines: 0,
              deletedLines: 0,
              remoteUrl: null,
              pr: null,
              checks: null,
            },
          }
        : { status: { branch: "main", ahead: 0, behind: 0, files: [] } },
    }));
    assert.equal((await pending).status, 200);
  }

  const invalidSurface = await ownerFetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: "runner-ui-route",
      workspaceId: "workspace-1",
      projectId: null,
      projectLocationId: null,
      agentId: "agent-1",
      useWorktree: false,
      launchSurface: "future_surface",
    }),
  });
  assert.equal(invalidSurface.status, 400);
  assert.match((await invalidSurface.json() as { error: string }).error, /launchSurface/);

  const nativeCreate = ownerFetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: "runner-ui-route",
      workspaceId: "workspace-1",
      projectId: null,
      projectLocationId: null,
      agentId: "agent-1",
      useWorktree: false,
      launchSurface: "native_tui",
    }),
  });
  const startRequest = await runnerInbox.take((message) => message.type === "start_session");
  const createdSessionId = (startRequest.spec as { sessionId: string }).sessionId;
  const shellRequest = await runnerInbox.take((message) =>
    message.type === "shell_open" && message.sessionId === createdSessionId);
  assert.equal(shellRequest.kind, "agent_tui", "start_session is observed before the initial Agent TUI open");
  assert.equal(shellRequest.fenceStart, true, "create-time Native TUI explicitly consumes the start fence");
  runner.send(JSON.stringify({
    type: "shell_open_result",
    requestId: shellRequest.requestId,
    ok: true,
    pty: true,
  }));
  const nativeResponse = await nativeCreate;
  assert.equal(nativeResponse.status, 201);
  assert.equal((await nativeResponse.json() as { id: string }).id, createdSessionId);
  const retainedShells = await (await ownerFetch(`/api/sessions/${createdSessionId}/shells`)).json() as {
    shells: Array<{ shellId: string; kind: string; status: string }>;
  };
  assert.equal(retainedShells.shells.some((shell) => shell.kind === "agent_tui" && shell.status === "running"), true);

  const initialTui = retainedShells.shells.find((shell) => shell.kind === "agent_tui")!;
  assert.equal((await ownerFetch(
    `/api/sessions/${createdSessionId}/shells/${initialTui.shellId}`,
    { method: "DELETE" },
  )).status, 204);
  const manualOpen = ownerFetch(`/api/sessions/${createdSessionId}/shells`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "agent_tui" }),
  });
  const manualShellRequest = await runnerInbox.take((message) =>
    message.type === "shell_open" && message.sessionId === createdSessionId &&
    message.shellId !== initialTui.shellId);
  assert.equal(manualShellRequest.kind, "agent_tui");
  assert.equal(manualShellRequest.fenceStart, undefined, "manual attachment retains pre-v67 wire behavior");
  runner.send(JSON.stringify({
    type: "shell_open_result",
    requestId: manualShellRequest.requestId,
    ok: true,
    pty: true,
  }));
  assert.equal((await manualOpen).status, 200);

  assert.deepEqual(await rejectedSocket(`${wsBase}/ui`), {
    code: 1008,
    reason: "unauthorized — open the startup pairing URL or pair this device",
  });
  const forwardedStartupCredential = await rejectedSocket(authenticatedUiUrl(wsBase, ownerToken), {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
  assert.equal(forwardedStartupCredential.code, 1008);
  assert.match(
    forwardedStartupCredential.reason,
    /unauthorized/u,
    "the local startup credential is rejected when proxy headers make the request non-local",
  );
  const { socket: ui, inbox: uiInbox } = await openSocketWithInbox(authenticatedUiUrl(wsBase, ownerToken));
  sockets.add(ui);
  const snapshot = await uiInbox.take((message) => message.type === "snapshot");
  assert.deepEqual(snapshot.capabilities, {
    sessionSubscriptions: true,
    boundedDelivery: true,
    paginatedSessionHistory: true,
    projects: true,
    createProjectLocations: true,
    accessScopeManagement: true,
    nativeTuiLaunch: true,
    stopFailureRecovery: true,
    stopBeforeArchive: true,
    sessionReminders: true,
  });
  const initialProjects = snapshot.projects as Array<{
    id: string;
    name: string;
    locations: Array<{ id: string; runnerId: string; workspaceId: string }>;
  }>;
  assert.deepEqual(initialProjects.map((project) => project.name), [
    "Alice Private Project",
    "Bob Private Project",
    "Second Alice Private Project",
    "Workspace",
  ]);
  assert.deepEqual(
    (snapshot.sessions as Array<{ id: string }>).map((session) => session.id).sort(),
    [createdSessionId, "session-history", "session-other", "session-target"].sort(),
  );
  const { socket: operatorUi, inbox: operatorUiInbox } = await openSocketWithInbox(
    authenticatedUiUrl(wsBase, operatorToken),
  );
  sockets.add(operatorUi);
  assert.equal(
    (await operatorUiInbox.take((message) => message.type === "snapshot")).type,
    "snapshot",
    "a paired device can authenticate the real /ui WebSocket route",
  );

  const plainStopResponse = await ownerFetch("/api/sessions/session-other/stop", { method: "POST" });
  assert.equal(plainStopResponse.status, 200);
  const plainStopPayload = await plainStopResponse.json() as {
    archived: boolean;
    archiveStatus?: string;
    stopOperation: {
      operationId: string;
      status: string;
      attemptCount: number;
      capacityReleased: boolean;
    };
  };
  assert.equal(plainStopPayload.archived, false);
  assert.equal(plainStopPayload.archiveStatus, undefined);
  assert.equal(plainStopPayload.stopOperation.status, "stop_pending");
  assert.equal(plainStopPayload.stopOperation.capacityReleased, false);
  const plainStopCommand = await runnerInbox.take((message) =>
    message.type === "stop_session" && message.sessionId === "session-other");
  assert.equal(
    plainStopCommand.type === "stop_session" ? plainStopCommand.operationId : undefined,
    plainStopPayload.stopOperation.operationId,
  );
  assert.ok(plainStopCommand.type === "stop_session" && plainStopCommand.deliveryAttemptId);
  for (const inbox of [uiInbox, operatorUiInbox]) {
    await inbox.take((message) => message.type === "session_upsert" &&
      (message.session as { id?: string; stopOperation?: { status?: string } } | undefined)?.id === "session-other" &&
      (message.session as { stopOperation?: { status?: string } } | undefined)
        ?.stopOperation?.status === "stop_pending");
  }

  runner.send(JSON.stringify({
    type: "stop_session_result",
    sessionId: "session-other",
    operationId: plainStopPayload.stopOperation.operationId,
    deliveryAttemptId: plainStopCommand.type === "stop_session"
      ? plainStopCommand.deliveryAttemptId
      : undefined,
    accepted: false,
    error: "/private/provider/path and runtime output",
  }));
  for (const inbox of [uiInbox, operatorUiInbox]) {
    const failedUpsert = await inbox.take((message) => message.type === "session_upsert" &&
      (message.session as { id?: string; stopOperation?: { status?: string } } | undefined)?.id === "session-other" &&
      (message.session as { stopOperation?: { status?: string } } | undefined)
        ?.stopOperation?.status === "stop_failed");
    const failedSession = failedUpsert.session as {
      archived: boolean;
      archiveStatus?: string;
      stopOperation: { capacityReleased: boolean; failure?: { message?: string } };
    };
    assert.equal(failedSession.archived, false);
    assert.equal(failedSession.archiveStatus, undefined);
    assert.equal(failedSession.stopOperation.capacityReleased, false);
    assert.doesNotMatch(failedSession.stopOperation.failure?.message ?? "", /private|provider\/path/u);
  }

  assert.equal(
    (await fetch(`${httpBase}/api/sessions/session-other/retry-stop`, { method: "POST" })).status,
    401,
    "an unauthenticated caller cannot recover a failed Stop",
  );
  const authorizedRetryResponse = await fetchWithBearer(
    `${httpBase}/api/sessions/session-other/retry-stop`,
    operatorToken,
    { method: "POST" },
  );
  assert.equal(authorizedRetryResponse.status, 202);
  const authorizedRetry = await authorizedRetryResponse.json() as {
    stopOperation: { operationId: string; status: string; attemptCount: number };
  };
  assert.equal(authorizedRetry.stopOperation.operationId, plainStopPayload.stopOperation.operationId);
  assert.equal(authorizedRetry.stopOperation.status, "stop_pending");
  assert.equal(authorizedRetry.stopOperation.attemptCount, 1);
  const authorizedRetryCommand = await runnerInbox.take((message) =>
    message.type === "stop_session" && message.sessionId === "session-other");
  assert.equal(
    authorizedRetryCommand.type === "stop_session" ? authorizedRetryCommand.operationId : undefined,
    plainStopPayload.stopOperation.operationId,
  );
  assert.ok(authorizedRetryCommand.type === "stop_session" && authorizedRetryCommand.deliveryAttemptId);
  assert.notEqual(authorizedRetryCommand.deliveryAttemptId, plainStopCommand.deliveryAttemptId);
  const duplicateRetryResponse = await ownerFetch(
    "/api/sessions/session-other/retry-stop",
    { method: "POST" },
  );
  assert.equal(duplicateRetryResponse.status, 202);
  const duplicateRetry = await duplicateRetryResponse.json() as {
    stopOperation: { operationId: string; attemptCount: number };
  };
  assert.equal(duplicateRetry.stopOperation.operationId, authorizedRetry.stopOperation.operationId);
  assert.equal(duplicateRetry.stopOperation.attemptCount, authorizedRetry.stopOperation.attemptCount);
  const duplicateRetryCommand = await runnerInbox.take((message) =>
    message.type === "stop_session" && message.sessionId === "session-other");
  assert.equal(
    duplicateRetryCommand.type === "stop_session" ? duplicateRetryCommand.operationId : undefined,
    plainStopPayload.stopOperation.operationId,
  );
  assert.equal(
    duplicateRetryCommand.type === "stop_session" ? duplicateRetryCommand.deliveryAttemptId : undefined,
    authorizedRetryCommand.deliveryAttemptId,
  );
  for (const inbox of [uiInbox, operatorUiInbox]) {
    await inbox.take((message) => message.type === "session_upsert" &&
      (message.session as { id?: string; stopOperation?: { status?: string } } | undefined)?.id === "session-other" &&
      (message.session as { stopOperation?: { status?: string } } | undefined)
        ?.stopOperation?.status === "stop_pending");
  }

  runner.send(JSON.stringify({
    type: "session_status",
    sessionId: "session-other",
    status: "stopped",
  }));
  for (const inbox of [uiInbox, operatorUiInbox]) {
    const settledUpsert = await inbox.take((message) => message.type === "session_upsert" &&
      (message.session as { id?: string; stopOperation?: unknown } | undefined)?.id === "session-other" &&
      (message.session as { stopOperation?: unknown } | undefined)?.stopOperation === undefined);
    assert.equal((settledUpsert.session as { archived?: boolean }).archived, false);
  }

  const renameResponse = await ownerFetch("/api/sessions/session-target/title", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "  Renamed\n target  " }),
  });
  assert.equal(renameResponse.status, 200);
  const renamed = await renameResponse.json() as { title: string; titleSource: string };
  assert.deepEqual([renamed.title, renamed.titleSource], ["Renamed target", "user"]);
  const renameUpsert = await uiInbox.take((message) =>
    message.type === "session_upsert" && (message.session as { id?: string })?.id === "session-target",
  );
  assert.equal((renameUpsert.session as { title?: string }).title, "Renamed target");

  const invalidRename = await ownerFetch("/api/sessions/session-target/title", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   " }),
  });
  assert.equal(invalidRename.status, 400);
  const afterInvalid = await (await ownerFetch("/api/sessions/session-target")).json() as {
    session: { title: string; titleSource: string };
  };
  assert.deepEqual([afterInvalid.session.title, afterInvalid.session.titleSource], ["Renamed target", "user"]);

  const coldPage = await (await ownerFetch(
    "/api/sessions/session-history/events?after=0&limit=2&eventEpoch=0",
  )).json() as { events: unknown[]; cacheComplete: boolean };
  assert.deepEqual(coldPage.events, [], "the bounded route returns the cache before runner I/O completes");
  assert.equal(coldPage.cacheComplete, false);
  const historyRequest1 = await runnerInbox.take((message) => message.type === "session_history_page");
  assert.equal(historyRequest1.afterSeq, 0);
  runner.send(JSON.stringify({
    type: "session_history_page_result",
    requestId: historyRequest1.requestId,
    sessionId: "session-history",
    ok: true,
    events: [
      { seq: 1, ts: 21, payload: { kind: "user_message", text: "one" } },
      { seq: 2, ts: 22, payload: { kind: "agent_message", text: "two" } },
    ],
    page: { logEpoch: 9, throughSeq: 3, nextAfterSeq: 2, hasMore: true },
  }));
  const historyRequest2 = await runnerInbox.take((message) =>
    message.type === "session_history_page" && message.afterSeq === 2,
  );
  assert.equal(historyRequest2.logEpoch, 9);
  assert.equal(historyRequest2.throughSeq, 3);
  runner.send(JSON.stringify({
    type: "session_history_page_result",
    requestId: historyRequest2.requestId,
    sessionId: "session-history",
    ok: true,
    events: [{ seq: 3, ts: 23, payload: { kind: "agent_message", text: "three" } }],
    page: { logEpoch: 9, throughSeq: 3, nextAfterSeq: 3, hasMore: false },
  }));
  type HydratedHistoryPage = {
    events: Array<{ seq: number }>;
    nextAfter: number;
    hasMoreCached: boolean;
    cacheComplete: boolean;
  };
  const hydratedPage = await waitForValue(
    async () => await (await ownerFetch(
      "/api/sessions/session-history/events?after=0&limit=2&eventEpoch=0",
    )).json() as HydratedHistoryPage,
    (page) => page.cacheComplete,
    "session history ingest to complete",
  );
  assert.deepEqual(hydratedPage.events.map((event) => event.seq), [1, 2]);
  assert.equal(hydratedPage.nextAfter, 2);
  assert.equal(hydratedPage.hasMoreCached, true);
  assert.equal(hydratedPage.cacheComplete, true);

  ui.send(JSON.stringify({
    type: "session_subscriptions",
    revision: 7,
    sessionIds: ["session-target"],
    podIds: [],
  }));
  assert.deepEqual(
    await uiInbox.take((message) => message.type === "session_subscriptions_applied"),
    {
      type: "session_subscriptions_applied",
      revision: 7,
      sessionIds: ["session-target"],
      podIds: [],
    },
  );

  runner.send(JSON.stringify({
    type: "session_event",
    sessionId: "session-other",
    seq: 1,
    ts: 10,
    payload: { kind: "agent_message", text: "must not be delivered" },
  }));
  runner.send(JSON.stringify({
    type: "session_event",
    sessionId: "session-target",
    seq: 1,
    ts: 11,
    payload: { kind: "agent_message", text: "targeted delivery" },
  }));
  const targeted = await uiInbox.take((message) =>
    message.type === "session_event" &&
    (message.event as { sessionId?: string } | undefined)?.sessionId === "session-target",
  );
  assert.equal(((targeted.event as { payload: { text: string } }).payload).text, "targeted delivery");
  assert.equal(uiInbox.has((message) =>
    message.type === "session_event" &&
    (message.event as { sessionId?: string } | undefined)?.sessionId === "session-other"), false);

  const largeRunnerMessage = "r".repeat(MAX_UI_CLIENT_MESSAGE_BYTES + 4_096);
  runner.send(JSON.stringify({
    type: "session_event",
    sessionId: "session-target",
    seq: 2,
    ts: 12,
    payload: { kind: "agent_message", text: largeRunnerMessage },
  }));
  const largeTargeted = await uiInbox.take((message) =>
    message.type === "session_event" &&
    (message.event as { sessionId?: string; seq?: number } | undefined)?.sessionId === "session-target" &&
    (message.event as { seq?: number } | undefined)?.seq === 2,
  );
  assert.equal(
    ((largeTargeted.event as { payload: { text: string } }).payload).text,
    largeRunnerMessage,
    "the UI inbound maxPayload limit must not reject larger runner events",
  );

  const firstPageResponse = await ownerFetch(
    "/api/sessions/session-target/events?after=0&limit=1&eventEpoch=0",
  );
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json() as {
    events: Array<{ seq: number }>;
    eventEpoch: number;
    nextAfter: number;
    hasMoreCached: boolean;
    cacheComplete: boolean;
  };
  assert.deepEqual(firstPage, {
    events: [{
      id: (firstPage.events[0] as { id?: number }).id,
      sessionId: "session-target",
      seq: 1,
      ts: 11,
      payload: { kind: "agent_message", text: "targeted delivery" },
    }],
    eventEpoch: 0,
    nextAfter: 1,
    hasMoreCached: true,
    cacheComplete: true,
  });
  const secondPage = await (await ownerFetch(
    `/api/sessions/session-target/events?after=${firstPage.nextAfter}&limit=1&eventEpoch=0`,
  )).json() as { events: Array<{ seq: number }>; nextAfter: number; hasMoreCached: boolean; cacheComplete: boolean };
  assert.deepEqual(secondPage.events.map((event) => event.seq), [2]);
  assert.equal(secondPage.nextAfter, 2);
  assert.equal(secondPage.hasMoreCached, false);
  assert.equal(secondPage.cacheComplete, true);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?after=0&limit=1&eventEpoch=99",
  )).status, 409);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?after=0&limit=201&eventEpoch=0",
  )).status, 400);

  // The bounded opening window reads backwards: the newest rows first, then older pages below an
  // explicit cursor. Opening a session must never start at the oldest cached event.
  const windowPage = await (await ownerFetch(
    "/api/sessions/session-target/events?direction=backward&limit=1&eventEpoch=0",
  )).json() as {
    events: Array<{ seq: number }>;
    eventEpoch: number;
    nextBefore: number;
    hasMoreOlder: boolean;
    cacheComplete: boolean;
  };
  assert.deepEqual(windowPage.events.map((event) => event.seq), [2]);
  assert.equal(windowPage.eventEpoch, 0);
  assert.equal(windowPage.nextBefore, 2);
  assert.equal(windowPage.hasMoreOlder, true);
  assert.equal(windowPage.cacheComplete, true);
  const olderPage = await (await ownerFetch(
    `/api/sessions/session-target/events?direction=backward&before=${windowPage.nextBefore}&limit=1&eventEpoch=0`,
  )).json() as { events: Array<{ seq: number }>; nextBefore: number; hasMoreOlder: boolean };
  assert.deepEqual(olderPage.events.map((event) => event.seq), [1]);
  assert.equal(olderPage.nextBefore, 1);
  assert.equal(olderPage.hasMoreOlder, false);
  // A page whose window covers the whole log reports no older rows rather than a cursor to nowhere.
  const wholeLog = await (await ownerFetch(
    "/api/sessions/session-target/events?direction=backward&limit=200&eventEpoch=0",
  )).json() as { events: Array<{ seq: number }>; hasMoreOlder: boolean };
  assert.deepEqual(wholeLog.events.map((event) => event.seq), [1, 2]);
  assert.equal(wholeLog.hasMoreOlder, false);
  // Cursor directions are mutually exclusive, and an unknown direction fails closed rather than
  // silently answering with a forward page from the start of the log.
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?direction=backward&after=0&limit=1&eventEpoch=0",
  )).status, 400);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?before=1&limit=1&eventEpoch=0",
  )).status, 400);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?direction=forward&limit=1&eventEpoch=0",
  )).status, 400);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?direction=backward&before=-1&limit=1&eventEpoch=0",
  )).status, 400);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?direction=backward&limit=1&eventEpoch=99",
  )).status, 409);
  // Turn alignment is opt-in and belongs to backward reads. This session's cache holds no user
  // message, so the page keeps its count boundary and says it is unaligned rather than guessing.
  const alignedPage = await (await ownerFetch(
    "/api/sessions/session-target/events?direction=backward&align=turn&limit=1&eventEpoch=0",
  )).json() as { events: Array<{ seq: number }>; hasMoreOlder: boolean; turnAligned: boolean };
  assert.deepEqual(alignedPage.events.map((event) => event.seq), [2]);
  assert.equal(alignedPage.turnAligned, false);
  assert.equal(alignedPage.hasMoreOlder, true);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?direction=backward&align=sentence&limit=1&eventEpoch=0",
  )).status, 400);
  assert.equal((await ownerFetch(
    "/api/sessions/session-target/events?align=turn&after=0&limit=1&eventEpoch=0",
  )).status, 400);

  const createProjectResponse = await ownerFetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Durable Project" }),
  });
  assert.equal(createProjectResponse.status, 201);
  const createdProject = (await createProjectResponse.json() as {
    project: { id: string; name: string; canManage?: boolean };
  }).project;
  assert.equal(createdProject.canManage, true);
  await uiInbox.take((message) => message.type === "project_upsert" && message.project.id === createdProject.id);

  const deniedOperatorOrganizationProject = await fetch(`${httpBase}/api/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Unauthorized Shared Project",
      owner: { kind: "organization", organizationId: identity.organizationId },
    }),
  });
  assert.equal(deniedOperatorOrganizationProject.status, 403,
    "ordinary members cannot create organization-visible Projects");
  const deniedCrossUserProject = await fetch(`${httpBase}/api/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Cross-User Project",
      owner: { kind: "user", userId: identity.userId },
    }),
  });
  assert.equal(deniedCrossUserProject.status, 403, "private scope cannot be assigned across users");
  const operatorPrivateProjectResponse = await fetch(`${httpBase}/api/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Operator Private Project",
      owner: { kind: "user", userId: "usr_ui_route_operator" },
    }),
  });
  assert.equal(operatorPrivateProjectResponse.status, 201);
  const operatorPrivateProject = (await operatorPrivateProjectResponse.json() as {
    project: { id: string; audience?: string; scope?: ResourceScope };
  }).project;
  assert.equal(operatorPrivateProject.audience, "user");
  assert.deepEqual(operatorPrivateProject.scope?.owner, { kind: "user", userId: "usr_ui_route_operator" });
  const deniedOperatorScopeChange = await fetch(
    `${httpBase}/api/projects/${operatorPrivateProject.id}/access-scope?ownerKind=organization&ownerId=${identity.organizationId}`,
    { headers: { authorization: `Bearer ${operatorToken}` } },
  );
  assert.equal(deniedOperatorScopeChange.status, 403,
    "ordinary members cannot broaden a private Project to organization access");

  const teamProjectResponse = await ownerFetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Operator Team Project",
      owner: { kind: "team", teamId: scopeTeam.teamId },
    }),
  });
  assert.equal(teamProjectResponse.status, 201);
  const teamProject = (await teamProjectResponse.json() as { project: { id: string } }).project;
  const operatorNarrowPreviewResponse = await fetch(
    `${httpBase}/api/projects/${teamProject.id}/access-scope?ownerKind=user&ownerId=usr_ui_route_operator`,
    { headers: { authorization: `Bearer ${operatorToken}` } },
  );
  assert.equal(operatorNarrowPreviewResponse.status, 200);
  const operatorNarrowPreview = (await operatorNarrowPreviewResponse.json() as {
    preview: { confirmationToken?: string };
  }).preview;
  const operatorNarrowResponse = await fetch(`${httpBase}/api/projects/${teamProject.id}/access-scope`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      owner: { kind: "user", userId: "usr_ui_route_operator" },
      confirmationToken: operatorNarrowPreview.confirmationToken,
    }),
  });
  assert.equal(operatorNarrowResponse.status, 200, "a team member may safely narrow a managed Project to themselves");
  assert.deepEqual((await operatorNarrowResponse.json() as { project: { scope?: ResourceScope } }).project.scope?.owner,
    { kind: "user", userId: "usr_ui_route_operator" });

  const managedScopeProjectResponse = await ownerFetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Managed Scope Project",
      owner: { kind: "organization", organizationId: identity.organizationId },
    }),
  });
  assert.equal(managedScopeProjectResponse.status, 201);
  const managedScopeProject = (await managedScopeProjectResponse.json() as {
    project: { id: string; scope?: ResourceScope };
  }).project;
  const scopePreviewResponse = await ownerFetch(
    `/api/projects/${managedScopeProject.id}/access-scope?ownerKind=user&ownerId=${identity.userId}`,
  );
  assert.equal(scopePreviewResponse.status, 200);
  const scopePreview = (await scopePreviewResponse.json() as {
    preview: { confirmationToken?: string; compatible: boolean };
  }).preview;
  assert.equal(scopePreview.compatible, true);
  assert.match(scopePreview.confirmationToken ?? "", /^[a-f0-9]{64}$/u);
  const appliedScopeResponse = await ownerFetch(`/api/projects/${managedScopeProject.id}/access-scope`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner: { kind: "user", userId: identity.userId },
      confirmationToken: scopePreview.confirmationToken,
    }),
  });
  assert.equal(appliedScopeResponse.status, 200);
  const appliedScopeProject = (await appliedScopeResponse.json() as {
    project: { scope?: ResourceScope };
  }).project;
  assert.deepEqual(appliedScopeProject.scope?.owner, { kind: "user", userId: identity.userId });
  const scopeAudit = (await (await ownerFetch("/api/identity/mutation-audit?limit=100")).json() as {
    audit: Array<{ auditId: string; method: string; route: string; targetId?: string; statusCode: number }>;
  }).audit;
  assert.equal(scopeAudit.some((entry) =>
    entry.method === "PUT" && entry.route === "/api/projects/:id/access-scope" &&
    entry.targetId === managedScopeProject.id && entry.statusCode === 200), true,
    "successful access-scope changes are attributed in the mutation audit");
  const exactScopeAudit = (await (await ownerFetch("/api/identity/access-scope-audit?limit=100")).json() as {
    audit: Array<{
      mutationAuditId?: string;
      actorId: string;
      resource: string;
      resourceId: string;
      currentScope: ResourceScope;
      targetScope: ResourceScope;
      affectedProjectIds: string[];
      activeSessionIds: string[];
      sessionIds: string[];
      narrowedSessionIds: string[];
    }>;
  }).audit;
  const ownerScopeAudit = exactScopeAudit.find((entry) => entry.resourceId === managedScopeProject.id)!;
  assert.equal(ownerScopeAudit.actorId, identity.userId);
  assert.equal(ownerScopeAudit.resource, "project");
  assert.deepEqual(ownerScopeAudit.currentScope.owner,
    { kind: "organization", organizationId: identity.organizationId });
  assert.deepEqual(ownerScopeAudit.targetScope.owner, { kind: "user", userId: identity.userId });
  assert.deepEqual(ownerScopeAudit.affectedProjectIds, [managedScopeProject.id]);
  assert.deepEqual(ownerScopeAudit.activeSessionIds, []);
  assert.deepEqual(ownerScopeAudit.sessionIds, []);
  assert.deepEqual(ownerScopeAudit.narrowedSessionIds, []);
  assert.equal(scopeAudit.some((entry) => entry.auditId === ownerScopeAudit.mutationAuditId), true,
    "the exact scope evidence links to the generic mutation attribution row");

  const rejectedRawWorkspaceScope = await ownerFetch(
    "/api/identity/ownership/workspace/workspace-ui-route",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-ui-route",
        owner: { kind: "user", userId: "usr_ui_route_alice" },
      }),
    },
  );
  assert.equal(rejectedRawWorkspaceScope.status, 400,
    "the legacy raw ownership API cannot mutate Location access");

  const rejectedImplicitCrossUserLocation = await ownerFetch(
    `/api/projects/${alicePrivateProject.id}/locations/new`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-ui-route",
        name: "Implicit Alice Location",
        path: "/repos/implicit-alice-location",
      }),
    },
  );
  assert.equal(rejectedImplicitCrossUserLocation.status, 403,
    "an omitted owner cannot bypass cross-user private assignment validation");

  const memberTeamLocationRequest = ownerFetch(
    `/api/projects/${alicePrivateProject.id}/locations/new`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-ui-route",
        name: "Alice Team Location",
        path: "/repos/alice-team-location",
        owner: { kind: "team", teamId: scopeTeam.teamId },
      }),
    },
  );
  const memberTeamBrowse = await runnerInbox.take((message) =>
    message.type === "list_directory" && message.path === "/repos/alice-team-location");
  runner.send(JSON.stringify({
    type: "list_directory_result",
    requestId: memberTeamBrowse.requestId,
    ok: true,
    path: "/repos/alice-team-location",
    parent: "/repos",
    entries: [],
  }));
  const memberTeamLocationResponse = await memberTeamLocationRequest;
  assert.equal(memberTeamLocationResponse.status, 201,
    "Alice's private Project may create a team Location when Alice is a member");
  const memberTeamLocation = (await memberTeamLocationResponse.json() as {
    project: { locations: Array<{ id: string; runnerId: string; workspaceId: string; path: string }> };
  }).project.locations.find((location) => location.path === "/repos/alice-team-location")!;
  assert.ok(memberTeamLocation);

  const memberTeamLinkResponse = await ownerFetch(`/api/projects/${secondAlicePrivateProject.id}/locations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: memberTeamLocation.runnerId,
      workspaceId: memberTeamLocation.workspaceId,
    }),
  });
  assert.equal(memberTeamLinkResponse.status, 200,
    "the same membership-aware rule permits linking an existing team Location");
  const privateProjectPreviewResponse = await fetch(
    `${httpBase}/api/runners/${memberTeamLocation.runnerId}/workspaces/${memberTeamLocation.workspaceId}` +
      `/access-scope?ownerKind=team&ownerId=${scopeTeam.teamId}`,
    { headers: { authorization: `Bearer ${operatorToken}` } },
  );
  assert.equal(privateProjectPreviewResponse.status, 200);
  const privateProjectPreview = (await privateProjectPreviewResponse.json() as {
    preview: { affectedProjects: Array<{ projectId: string; name: string }> };
  }).preview;
  assert.deepEqual(privateProjectPreview.affectedProjects, [],
    "a Location manager cannot discover another member's private attached Projects through preflight");
  const nonmemberTeamLinkResponse = await ownerFetch(`/api/projects/${bobPrivateProject.id}/locations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: memberTeamLocation.runnerId,
      workspaceId: memberTeamLocation.workspaceId,
    }),
  });
  assert.equal(nonmemberTeamLinkResponse.status, 400,
    "a nonmember's private Project cannot link the team Location");
  assert.match((await nonmemberTeamLinkResponse.json() as { error: string }).error,
    /must not expose a private workspace/);

  const deniedOperatorLocation = await fetch(`${httpBase}/api/projects/${createdProject.id}/locations/new`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runnerId: "runner-ui-route",
      name: "Operator Host Path",
      path: "/repos/operator-host-path",
    }),
  });
  assert.equal(deniedOperatorLocation.status, 403);

  const createLocationRequest = ownerFetch(`/api/projects/${createdProject.id}/locations/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: "runner-ui-route",
      name: "Browsed Location",
      path: "/repos/browsed-location",
    }),
  });
  const browseRequest = await runnerInbox.take((message) =>
    message.type === "list_directory" && message.path === "/repos/browsed-location");
  assert.equal(
    runnerInbox.has((message) =>
      message.type === "list_directory" && message.path === "/repos/operator-host-path"),
    false,
    "a non-admin Project member must not reach the runner with an arbitrary host path",
  );
  assert.deepEqual(
    { context: browseRequest.context, path: browseRequest.path },
    { context: { kind: "native" }, path: "/repos/browsed-location" },
  );
  runner.send(JSON.stringify({
    type: "list_directory_result",
    requestId: browseRequest.requestId,
    ok: true,
    path: "/repos/browsed-location",
    parent: "/repos",
    entries: [],
  }));
  const createLocationResponse = await createLocationRequest;
  assert.equal(createLocationResponse.status, 201);
  const projectWithBrowsedLocation = (await createLocationResponse.json() as {
    project: {
      id: string;
      locations: Array<{ name: string; path: string; source: string; isDefault: boolean }>;
    };
  }).project;
  assert.deepEqual(
    projectWithBrowsedLocation.locations.map(({ name, path, source, isDefault }) => ({
      name, path, source, isDefault,
    })),
    [{ name: "Browsed Location", path: "/repos/browsed-location", source: "managed", isDefault: true }],
  );
  await uiInbox.take((message) => message.type === "project_upsert" && message.project.id === createdProject.id &&
    message.project.locations.some((location) => location.path === "/repos/browsed-location"));

  const missingLocationRequest = ownerFetch(`/api/projects/${createdProject.id}/locations/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: "runner-ui-route",
      name: "Missing Location",
      path: "/repos/missing-location",
    }),
  });
  const missingBrowseRequest = await runnerInbox.take((message) =>
    message.type === "list_directory" && message.path === "/repos/missing-location");
  runner.send(JSON.stringify({
    type: "list_directory_result",
    requestId: missingBrowseRequest.requestId,
    ok: false,
    error: "ENOENT: no such file or directory",
  }));
  const missingLocationResponse = await missingLocationRequest;
  assert.equal(missingLocationResponse.status, 404);
  assert.match(
    (await missingLocationResponse.json() as { error: string }).error,
    /browse for the folder again/i,
  );

  const invalidPatch = await ownerFetch(`/api/projects/${createdProject.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Must Not Persist", hidden: "invalid" }),
  });
  assert.equal(invalidPatch.status, 400);
  const unchangedProject = await (await ownerFetch(`/api/projects/${createdProject.id}`)).json() as {
    project: { name: string };
  };
  assert.equal(unchangedProject.project.name, "Durable Project");

  const initialWorkspaceProject = initialProjects.find((project) => project.name === "Workspace")!;
  const sharedLocation = initialWorkspaceProject.locations[0]!;
  const addLocationResponse = await ownerFetch(`/api/projects/${createdProject.id}/locations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerId: sharedLocation.runnerId, workspaceId: sharedLocation.workspaceId }),
  });
  assert.equal(addLocationResponse.status, 200);
  const sharedProject = (await addLocationResponse.json() as {
    project: { locations: Array<{ id: string; runnerId: string; workspaceId: string }> };
  }).project;
  const addedLink = sharedProject.locations.find((location) =>
    location.runnerId === sharedLocation.runnerId && location.workspaceId === sharedLocation.workspaceId);
  assert.ok(addedLink);
  assert.notEqual(addedLink.id, sharedLocation.id, "each Project has an independent Location membership");
  const sourceAfterSharing = await (await ownerFetch(`/api/projects/${initialWorkspaceProject.id}`)).json() as {
    project: { locations: Array<{ id: string }> };
  };
  assert.equal(sourceAfterSharing.project.locations.some((location) => location.id === sharedLocation.id), true);

  const noProjectResponse = await ownerFetch("/api/sessions/session-target/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: null }),
  });
  assert.equal(noProjectResponse.status, 200);
  assert.equal(((await noProjectResponse.json()) as { projectId: string | null }).projectId, null);
  const restoreProjectResponse = await ownerFetch("/api/sessions/session-target/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: createdProject.id }),
  });
  assert.equal(restoreProjectResponse.status, 200);
  assert.equal(((await restoreProjectResponse.json()) as { projectId: string | null }).projectId, createdProject.id);

  const preArchiveResponse = await ownerFetch("/api/sessions/session-history/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(preArchiveResponse.status, 200);
  const preArchivedUpdatedAt = ((await preArchiveResponse.json()) as { updatedAt: number }).updatedAt;
  await uiInbox.take((message) => message.type === "session_upsert" &&
    (message.session as { id?: string; archived?: boolean } | undefined)?.id === "session-history" &&
    (message.session as { archived?: boolean } | undefined)?.archived === true);
  await delay(5);

  const archiveResponse = await ownerFetch(`/api/projects/${createdProject.id}/archive-sessions`, {
    method: "POST",
  });
  assert.equal(archiveResponse.status, 200);
  const archivePayload = (await archiveResponse.json() as {
    project: { id: string; unarchivedSessionCount: number; totalSessionCount: number };
    archivedSessionIds: string[];
    pendingSessionIds: string[];
  });
  const archivedProject = archivePayload.project;
  assert.deepEqual(
    [archivedProject.id, archivedProject.unarchivedSessionCount, archivedProject.totalSessionCount],
    [createdProject.id, 1, 1],
    "a Project session remains visible while its Stop is pending",
  );
  assert.deepEqual(
    archivePayload.archivedSessionIds,
    [],
    "active sessions are not reported as archived before Stop evidence",
  );
  assert.deepEqual(archivePayload.pendingSessionIds, ["session-target"]);
  const stopRequest = await runnerInbox.take((message) =>
    message.type === "stop_session" && message.sessionId === "session-target");
  assert.ok(stopRequest.type === "stop_session" && stopRequest.operationId && stopRequest.deliveryAttemptId);
  await uiInbox.take((message) => message.type === "session_upsert" &&
    (message.session as { id?: string; archived?: boolean; archiveStatus?: string } | undefined)?.id === "session-target" &&
    (message.session as { archived?: boolean } | undefined)?.archived === false &&
    (message.session as { archiveStatus?: string } | undefined)?.archiveStatus === "stop_pending");
  runner.send(JSON.stringify({
    type: "stop_session_result",
    sessionId: "session-target",
    operationId: stopRequest.operationId,
    deliveryAttemptId: stopRequest.deliveryAttemptId,
    accepted: false,
    error: "private runner detail",
  }));
  await uiInbox.take((message) => message.type === "session_upsert" &&
    (message.session as { id?: string; archiveStatus?: string } | undefined)?.id === "session-target" &&
    (message.session as { archiveStatus?: string } | undefined)?.archiveStatus === "stop_failed");
  const retryStopResponse = await ownerFetch("/api/sessions/session-target/retry-stop", { method: "POST" });
  assert.equal(retryStopResponse.status, 202);
  const retryPayload = await retryStopResponse.json() as {
    archived: boolean;
    archiveStatus: string;
    archiveOperation: { operationId: string; capacityReleased: boolean };
  };
  assert.equal(retryPayload.archived, false);
  assert.equal(retryPayload.archiveStatus, "stop_pending");
  assert.equal(retryPayload.archiveOperation.operationId, stopRequest.operationId);
  assert.equal(retryPayload.archiveOperation.capacityReleased, false);
  const retryCommand = await runnerInbox.take((message) =>
    message.type === "stop_session" && message.sessionId === "session-target");
  assert.equal(retryCommand.type === "stop_session" ? retryCommand.operationId : undefined, stopRequest.operationId);
  assert.equal(
    uiInbox.has((message) => message.type === "session_upsert" &&
      (message.session as { id?: string; archived?: boolean } | undefined)?.id === "session-history" &&
      (message.session as { archived?: boolean } | undefined)?.archived === true),
    false,
    "already-archived sessions are not rebroadcast by bulk archive",
  );
  const unchangedArchived = await (await ownerFetch("/api/sessions/session-history")).json() as {
    session: { archived: boolean; updatedAt: number };
  };
  assert.equal(unchangedArchived.session.archived, true);
  assert.equal(
    unchangedArchived.session.updatedAt,
    preArchivedUpdatedAt,
    "bulk archive preserves already-archived session timestamps",
  );

  const deleteProjectResponse = await ownerFetch(`/api/projects/${createdProject.id}`, { method: "DELETE" });
  assert.equal(deleteProjectResponse.status, 200);
  await uiInbox.take((message) => message.type === "project_removed" && message.projectId === createdProject.id);

  const preV76 = await openSocketWithInbox(`${wsBase}/runner`);
  sockets.add(preV76.socket);
  preV76.socket.send(JSON.stringify({
    ...runnerRegistration("runner-legacy-warning", legacyRunnerToken),
    protocolVersion: 75,
    sessionSnapshots: [{
      ...sessionSnapshot("session-pre-v76"),
      workspaceId: null,
      workspacePath: "/legacy",
      agentId: null,
    }],
  }));
  await preV76.inbox.take((message) => message.type === "registered");
  const unsupportedPrimary = await ownerFetch("/api/sessions/session-pre-v76/git", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "status" }),
  });
  assert.equal(unsupportedPrimary.status, 409);
  assert.match(
    (await unsupportedPrimary.json() as { error: string }).error,
    /Primary-checkout Git visibility requires protocol v76/,
  );

  const malformed = await openStrictSocket(authenticatedUiUrl(wsBase, ownerToken));
  strictSockets.add(malformed);
  assert.deepEqual(await closeAfter(malformed, () => malformed.send("not-json")), {
    code: 1007,
    reason: "invalid UI subscription message",
  });

  const binary = await openStrictSocket(authenticatedUiUrl(wsBase, ownerToken));
  strictSockets.add(binary);
  assert.deepEqual(await closeAfter(binary, () => binary.send(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))), {
    code: 1003,
    reason: "UI subscription messages must be text",
  });

  const oversized = await openStrictSocket(authenticatedUiUrl(wsBase, ownerToken));
  strictSockets.add(oversized);
  const oversizedClose = await closeAfter(
    oversized,
    () => oversized.send("x".repeat(MAX_UI_CLIENT_MESSAGE_BYTES + 1)),
  );
  assert.equal(oversizedClose.code, 1009, "transport-level maxPayload enforcement must close oversized frames");
});

test("legacy workspace rename cannot bypass durable Project management authority", { timeout: 30_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-project-rename-auth-"));
  const databasePath = join(temp, "control-plane.db");
  const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
  const operatorToken = "operator-project-rename-token";
  const runner: RunnerMetadata = {
    runnerId: "runner-project-auth",
    hostname: "project-auth-host",
    os: "linux",
    version: "integration",
    workspaces: [{ id: "workspace-project-auth", name: "Organization Workspace", path: "/workspace" }],
    agents: [],
  };
  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  seed.createIdentityMember({
    userId: "usr_project_operator",
    displayName: "Project Operator",
    organizationId: identity.organizationId,
    role: "operator",
    now: 1,
  });
  seed.createDevice({
    id: "dev_project_operator",
    name: "Project Operator Device",
    tokenHash: hashToken(operatorToken),
    userId: "usr_project_operator",
    organizationId: identity.organizationId,
    now: 2,
  });
  seed.registerRunner(runner, 3);
  const project = seed.listProjects(true)[0]!;
  assert.equal(project.name, "Organization Workspace");
  const location = project.locations[0]!;
  const personalScope = {
    organizationId: identity.organizationId,
    owner: { kind: "user" as const, userId: "usr_project_operator" },
  };
  seed.createSession({
    id: "organization-project-session",
    runnerId: runner.runnerId,
    workspaceId: location.workspaceId,
    projectId: project.id,
    projectLocationId: location.id,
    agentId: null,
    title: "Organization Session",
    useWorktree: false,
    driver: "acp",
    config: {},
    scope: seed.projectScope(project.id)!,
    now: 4,
  });
  seed.createSession({
    id: "personal-project-session",
    runnerId: runner.runnerId,
    workspaceId: location.workspaceId,
    projectId: project.id,
    projectLocationId: location.id,
    agentId: null,
    title: "Personal Session",
    useWorktree: false,
    driver: "acp",
    config: {},
    scope: personalScope,
    now: 5,
  });
  const inaccessible = seed.createProject({
    name: "Owner Personal Project",
    scope: {
      organizationId: identity.organizationId,
      owner: { kind: "user", userId: identity.userId },
    },
    now: 6,
  });
  const operatorProject = seed.createProject({
    name: "Operator Personal Project",
    scope: personalScope,
    now: 7,
  });
  seed.createSessionFromSnapshot({
    id: "late-workspace-inaccessible-adopted-session",
    workspaceId: null,
    agentId: null,
    title: "Imported Late Private Workspace Session",
    status: "idle",
    driver: "codex",
    useWorktree: false,
    worktreePath: null,
    workspacePath: "/owner/private/import",
    config: {},
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: true,
    seq: 0,
    createdAt: 8,
    updatedAt: 8,
  }, runner.runnerId, 8, personalScope, { projectId: null, projectLocationId: null });
  const ownerWorkspace = seed.registerMachineWorkspace(runner.runnerId, {
    name: "Owner Private Workspace",
    path: "/owner/private/import",
  }, {
    organizationId: identity.organizationId,
    owner: { kind: "user", userId: identity.userId },
  }, 8);
  seed.createSessionFromSnapshot({
    id: "workspace-inaccessible-adopted-session",
    workspaceId: ownerWorkspace.id,
    agentId: null,
    title: "Imported Private Workspace Session",
    status: "idle",
    driver: "codex",
    useWorktree: false,
    worktreePath: null,
    workspacePath: "/owner/private/import",
    config: {},
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: true,
    seq: 0,
    createdAt: 9,
    updatedAt: 9,
  }, runner.runnerId, 9, personalScope, { projectId: null, projectLocationId: null });
  seed.createSessionFromSnapshot({
    id: "parent-workspace-inaccessible-adopted-session",
    workspaceId: location.workspaceId,
    agentId: null,
    title: "Imported Parent Workspace Session",
    status: "idle",
    driver: "codex",
    useWorktree: false,
    worktreePath: null,
    workspacePath: "/workspace/private/import",
    config: {},
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: true,
    seq: 0,
    createdAt: 10,
    updatedAt: 10,
  }, runner.runnerId, 10, personalScope, { projectId: null, projectLocationId: null });
  seed.registerMachineWorkspace(runner.runnerId, {
    name: "Owner Exact Private Workspace",
    path: "/workspace/private/import",
  }, {
    organizationId: identity.organizationId,
    owner: { kind: "user", userId: identity.userId },
  }, 11);
  seed.close();

  let output = "";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/control-plane/src/index.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath,
        CONTROL_PLANE_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const capture = (chunk: unknown) => {
    output = (output + String(chunk)).slice(-32_768);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  t.after(async () => {
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  const httpBase = `http://127.0.0.1:${port}`;
  const ownerFetch = (path: string, init?: RequestInit) =>
    fetchWithBearer(`${httpBase}${path}`, ownerToken, init);
  const operatorHeaders = {
    authorization: `Bearer ${operatorToken}`,
    "content-type": "application/json",
  };
  await waitForHealth(httpBase, child, () => output);

  const visibleProject = await (await fetch(`${httpBase}/api/projects/${project.id}`, {
    headers: { authorization: `Bearer ${operatorToken}` },
  })).json() as { project: { name: string; canManage?: boolean } };
  assert.equal(visibleProject.project.canManage, false);

  const deniedLocationLink = await fetch(`${httpBase}/api/sessions/personal-project-session/project`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ projectId: project.id, linkLocation: true }),
  });
  assert.equal(deniedLocationLink.status, 403,
    "personal session ownership cannot mutate a Project Location without Project-management permission");

  const deniedWorkspaceLink = await fetch(
    `${httpBase}/api/sessions/workspace-inaccessible-adopted-session/project`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ projectId: operatorProject.id, linkLocation: true }),
    },
  );
  assert.equal(deniedWorkspaceLink.status, 404,
    "Project management cannot link an execution Workspace the principal cannot access");

  const deniedLateWorkspaceLink = await fetch(
    `${httpBase}/api/sessions/late-workspace-inaccessible-adopted-session/project`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ projectId: operatorProject.id, linkLocation: true }),
    },
  );
  assert.equal(deniedLateWorkspaceLink.status, 404,
    "Project management cannot reuse an exact inaccessible Workspace discovered after adoption");

  const deniedExactOverParentLink = await fetch(
    `${httpBase}/api/sessions/parent-workspace-inaccessible-adopted-session/project`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ projectId: operatorProject.id, linkLocation: true }),
    },
  );
  assert.equal(deniedExactOverParentLink.status, 404,
    "authorization must check the exact Workspace the link transaction will select, not its accessible parent");

  const deniedDetach = await fetch(`${httpBase}/api/sessions/organization-project-session/project`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ projectId: null }),
  });
  assert.equal(deniedDetach.status, 403,
    "read access to an organization session does not grant authority to remove it from its Project");

  const hiddenTarget = await fetch(`${httpBase}/api/sessions/organization-project-session/project`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ projectId: inaccessible.id }),
  });
  assert.equal(hiddenTarget.status, 404, "inaccessible target Projects remain indistinguishable");

  const personalDetach = await fetch(`${httpBase}/api/sessions/personal-project-session/project`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ projectId: null }),
  });
  assert.equal(personalDetach.status, 200);
  const detachedPersonalSession = await personalDetach.json() as {
    projectId: string | null;
    audience?: string;
  };
  assert.equal(detachedPersonalSession.projectId, null);
  assert.equal(detachedPersonalSession.audience, "user");

  const personalReattach = await fetch(`${httpBase}/api/sessions/personal-project-session/project`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ projectId: project.id }),
  });
  assert.equal(personalReattach.status, 200);
  const reattachedPersonalSession = await personalReattach.json() as {
    projectId: string | null;
    audience?: string;
  };
  assert.equal(reattachedPersonalSession.projectId, project.id);
  assert.equal(reattachedPersonalSession.audience, "user",
    "filing a personal session in an organization Project does not silently widen its audience");

  const denied = await fetch(
    `${httpBase}/api/runners/${runner.runnerId}/workspaces/${runner.workspaces[0]!.id}/rename`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ name: "Unauthorized Rename" }),
    },
  );
  assert.equal(denied.status, 404);
  assert.equal(
    ((await (await fetch(`${httpBase}/api/projects/${project.id}`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })).json()) as { project: { name: string } }).project.name,
    "Organization Workspace",
  );

  const ownerRename = await ownerFetch(
    `/api/runners/${runner.runnerId}/workspaces/${runner.workspaces[0]!.id}/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Owner Rename" }),
    },
  );
  assert.equal(ownerRename.status, 200);
  assert.equal(
    ((await (await ownerFetch(`/api/projects/${project.id}`)).json()) as { project: { name: string } }).project.name,
    "Owner Rename",
  );
});
