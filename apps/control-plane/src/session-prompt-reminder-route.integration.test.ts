import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-prompt-reminder-route";
const SESSION_ID = "session-prompt-reminder-route";
const OWNER_TOKEN = "prompt-reminder-owner-token";
const OTHER_TOKEN = "prompt-reminder-other-token";
const AGENT_TOKEN = "prompt-reminder-agent-token";
const RUNNER_TOKEN = "prompt-reminder-runner-token";
const OTHER_USER_ID = "user_prompt_reminder_other";

type JsonObject = Record<string, unknown>;

class JsonInbox {
  private readonly queued: JsonObject[] = [];
  private readonly waiters = new Set<{
    predicate: (message: JsonObject) => boolean;
    resolve: (message: JsonObject) => void;
  }>();

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const message = parsed as JsonObject;
      for (const waiter of this.waiters) {
        if (!waiter.predicate(message)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(message);
        return;
      }
      this.queued.push(message);
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
        reject(new Error("timed out waiting for runner websocket message"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
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

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch { /* listen has not completed */ }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

function storedReminder(database: string, userId: string): { reminderId: string; state: string } | null {
  const db = new DatabaseSync(database);
  try {
    const row = db.prepare(
      "SELECT reminder_id AS reminderId,state FROM session_reminders WHERE session_id=? AND user_id=?",
    ).get(SESSION_ID, userId) as { reminderId: string; state: string } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function seed(database: string, runner: RunnerMetadata): { ownerUserId: string; reminderIds: Map<string, string> } {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    const identity = db.localIdentityContext();
    db.createIdentityMember({
      userId: OTHER_USER_ID,
      displayName: "Other Reminder User",
      organizationId: identity.organizationId,
      role: "operator",
      now,
    });
    db.createDevice({
      id: "device_prompt_reminder_owner",
      name: "Prompt Reminder Owner",
      tokenHash: hashToken(OWNER_TOKEN),
      userId: identity.userId,
      organizationId: identity.organizationId,
      now: now + 1,
    });
    db.createDevice({
      id: "device_prompt_reminder_other",
      name: "Prompt Reminder Other User",
      tokenHash: hashToken(OTHER_TOKEN),
      userId: OTHER_USER_ID,
      organizationId: identity.organizationId,
      now: now + 2,
    });
    db.registerRunner(runner, now + 3, PROTOCOL_VERSION);
    db.createSession({
      id: SESSION_ID,
      runnerId: RUNNER_ID,
      workspaceId: null,
      agentId: null,
      title: "Prompt Reminder Route",
      titleSource: "user",
      useWorktree: false,
      driver: "acp",
      config: {},
      scope: {
        organizationId: identity.organizationId,
        owner: { kind: "organization", organizationId: identity.organizationId },
      },
      now: now + 4,
    });
    db.updateSessionStatus(SESSION_ID, "running", now + 5);
    assert.equal(db.setAgentControlCredential(SESSION_ID, RUNNER_ID, hashToken(AGENT_TOKEN), now + 6), true);

    const reminderIds = new Map<string, string>();
    for (const [offset, userId] of [identity.userId, OTHER_USER_ID].entries()) {
      const created = db.setSessionReminder({
        sessionId: SESSION_ID,
        userId,
        scheduledFor: now - 1_000 + offset,
        timeZone: "UTC",
        originalExpression: "one second ago",
        wakePolicy: "regardless",
        expectedRevision: 0,
        now: now - 2_000,
      });
      assert.equal(created.kind, "updated");
      if (created.kind === "updated") reminderIds.set(userId, created.reminder.reminderId);
    }
    assert.equal(db.fireDueSessionReminders(now).length, 2);
    return { ownerUserId: identity.userId, reminderIds };
  } finally {
    db.close();
  }
}

test("prompt route acknowledges fired reminders only for accepted human principals", { timeout: 30_000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-prompt-reminder-route-"));
  const database = join(temp, "control-plane.db");
  const port = await reservePort();
  const runner: RunnerMetadata = {
    runnerId: RUNNER_ID,
    hostname: "prompt-reminder-host",
    os: "linux",
    version: "integration",
    agents: [],
    workspaces: [],
  };
  const seeded = seed(database, runner);
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: database,
      CONTROL_PLANE_TOKEN: RUNNER_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, () => output);
  const liveDb = new DatabaseSync(database);
  liveDb.exec("PRAGMA busy_timeout=5000");
  liveDb.prepare("UPDATE sessions SET status='running',updated_at=? WHERE id=?")
    .run(Date.now(), SESSION_ID);
  liveDb.close();

  const humanHeaders = {
    authorization: `Bearer ${OWNER_TOKEN}`,
    "content-type": "application/json",
  };
  const offline = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/prompt`, {
    method: "POST",
    headers: humanHeaders,
    body: JSON.stringify({ text: "offline prompt" }),
  });
  assert.equal(offline.status, 409, await offline.text());
  assert.equal(
    storedReminder(database, seeded.ownerUserId)?.reminderId,
    seeded.reminderIds.get(seeded.ownerUserId),
    "a failed human prompt must retain the exact fired reminder",
  );

  const socket = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  sockets.add(socket);
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
  });
  socket.send(JSON.stringify({
    type: "register",
    token: RUNNER_TOKEN,
    protocolVersion: PROTOCOL_VERSION,
    runner,
    sessionSnapshots: [{
      id: SESSION_ID,
      workspaceId: null,
      agentId: null,
      title: "Prompt Reminder Route",
      status: "running",
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
    }],
  }));
  await inbox.take((message) => message.type === "registered");

  const agentDelivery = inbox.take((message) =>
    message.type === "prompt_session" && message.sessionId === SESSION_ID);
  const automated = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/prompt`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: SESSION_ID,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "automated agent prompt" }),
  });
  assert.equal(automated.status, 200, await automated.text());
  assert.equal((await agentDelivery).text, "automated agent prompt");
  assert.equal(storedReminder(database, seeded.ownerUserId)?.state, "fired",
    "an agent-control prompt must not acknowledge the human user's reminder");
  assert.equal(storedReminder(database, OTHER_USER_ID)?.state, "fired");

  const humanDelivery = inbox.take((message) =>
    message.type === "prompt_session" && message.sessionId === SESSION_ID);
  const accepted = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/prompt`, {
    method: "POST",
    headers: humanHeaders,
    body: JSON.stringify({ text: "accepted human prompt" }),
  });
  assert.equal(accepted.status, 200, await accepted.text());
  assert.equal((await humanDelivery).text, "accepted human prompt");
  assert.equal(storedReminder(database, seeded.ownerUserId), null,
    "an accepted human prompt removes that user's fired reminder");
  assert.equal(
    storedReminder(database, OTHER_USER_ID)?.reminderId,
    seeded.reminderIds.get(OTHER_USER_ID),
    "one user's prompt cannot acknowledge another user's reminder on the shared session",
  );
});
