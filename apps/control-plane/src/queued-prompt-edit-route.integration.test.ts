import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WORKSPACE_REFERENCE_MIME_TYPE, type RunnerMetadata, type WorkspaceReference } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const OWNER_TOKEN = "queued-prompt-edit-owner-token";
const RUNNER_TOKEN = `wollipogr_${"q".repeat(43)}`;

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
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
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
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
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
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch { /* listen has not completed */ }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

test("queued prompt edit routes correlate exact reads and atomic writes with a v99 runner", { timeout: 30_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-queued-prompt-edit-route-"));
  const databasePath = join(temp, "control-plane.db");
  const runner: RunnerMetadata = {
    runnerId: "runner-queued-edit",
    hostname: "queued-edit-host",
    os: "linux",
    version: "integration",
    agents: [],
    workspaces: [],
  };
  const sessionId = "session-queued-edit";
  const now = Date.now();
  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  seed.createDevice({
    id: "device_queued_prompt_edit",
    name: "Queued Prompt Edit Device",
    tokenHash: hashToken(OWNER_TOKEN),
    now,
  });
  seed.registerRunner(runner, now, 99);
  seed.issueRunnerCredential({
    credentialId: `rcred_${"queuedpromptedit".padEnd(32, "0")}`,
    runnerId: runner.runnerId,
    organizationId: identity.organizationId,
    ownerKind: "organization",
    ownerId: identity.organizationId,
    label: "Queued prompt edit fixture",
    tokenHash: hashToken(RUNNER_TOKEN),
    createdByUserId: identity.userId,
    now,
    expiresAt: now + 60_000,
  });
  seed.createSession({
    id: sessionId,
    runnerId: runner.runnerId,
    workspaceId: null,
    agentId: null,
    title: "Queued Prompt Edit",
    titleSource: "user",
    useWorktree: false,
    driver: "acp",
    config: {},
    now,
  });
  seed.close();

  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: databasePath,
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

  const httpBase = `http://127.0.0.1:${port}`;
  await waitForHealth(httpBase, child, () => output);
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
    protocolVersion: 99,
    runner,
    liveSessions: [sessionId],
  }));
  await inbox.take((message) => message.type === "registered");
  socket.send(JSON.stringify({
    type: "session_queue",
    sessionId,
    queue: [{
      id: "prompt-1",
      text: "bounded projection",
      hasImages: true,
      liveQueueObserved: true,
      editable: true,
      editRevision: "qer_original",
    }],
    held: false,
  }));

  const headers = { authorization: `Bearer ${OWNER_TOKEN}` };
  const workspaceReference: WorkspaceReference = {
    artifactId: "workspace:queued-edit-pre-v106",
    mimeType: WORKSPACE_REFERENCE_MIME_TYPE,
    sizeBytes: 0,
    sha256: "a".repeat(64),
    referenceVersion: 1,
    kind: "file",
    path: "src/app.ts",
    rootFingerprint: "b".repeat(64),
    targetFingerprint: "a".repeat(64),
  };
  const unsupportedWorkspaceReferenceResponse = await fetch(
    `${httpBase}/api/sessions/${sessionId}/queued/prompt-1/edit`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        submissionId: "workspace-reference-pre-v106",
        expectedRevision: "qer_original",
        text: "must reject unsupported workspace context",
        images: [workspaceReference],
      }),
    },
  );
  assert.equal(unsupportedWorkspaceReferenceResponse.status, 409);
  assert.match(
    (await unsupportedWorkspaceReferenceResponse.json() as { error: string }).error,
    /requires protocol v106/,
  );

  const foreignImageResponse = await fetch(`${httpBase}/api/sessions/${sessionId}/queued/prompt-1/edit`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      submissionId: "foreign-image",
      expectedRevision: "qer_original",
      text: "must not cross the session image boundary",
      images: [{ artifactId: "art_foreign", mimeType: "image/png", sizeBytes: 4, sha256: "a".repeat(64) }],
    }),
  });
  assert.equal(foreignImageResponse.status, 404,
    "queued edits must enforce the same session-scoped image authorization as ordinary prompts");

  const readResponsePromise = fetch(`${httpBase}/api/sessions/${sessionId}/queued/prompt-1/edit`, { headers });
  const read = await inbox.take((message) => message.type === "read_queued_prompt");
  assert.equal(read.sessionId, sessionId);
  assert.equal(read.promptId, "prompt-1");
  socket.send(JSON.stringify({
    type: "read_queued_prompt_result",
    requestId: read.requestId,
    sessionId,
    promptId: "prompt-1",
    ok: true,
    prompt: {
      promptId: "prompt-1",
      text: "Exact queued content",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      editRevision: "qer_original",
    },
  }));
  const readResponse = await readResponsePromise;
  assert.equal(readResponse.status, 200);
  assert.equal((await readResponse.json() as { prompt: { text: string } }).prompt.text, "Exact queued content");

  const editResponsePromise = fetch(`${httpBase}/api/sessions/${sessionId}/queued/prompt-1/edit`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      submissionId: "submission-1",
      expectedRevision: "qer_original",
      text: "Revised queued content",
      images: [],
    }),
  });
  const edit = await inbox.take((message) => message.type === "edit_queued_prompt");
  assert.deepEqual({
    submissionId: edit.submissionId,
    sessionId: edit.sessionId,
    promptId: edit.promptId,
    expectedRevision: edit.expectedRevision,
    text: edit.text,
    images: edit.images,
  }, {
    submissionId: "submission-1",
    sessionId,
    promptId: "prompt-1",
    expectedRevision: "qer_original",
    text: "Revised queued content",
    images: [],
  });
  socket.send(JSON.stringify({
    type: "edit_queued_prompt_result",
    requestId: edit.requestId,
    submissionId: "submission-1",
    sessionId,
    promptId: "prompt-1",
    applied: true,
    prompt: {
      promptId: "prompt-1",
      text: "Revised queued content",
      images: [],
      editRevision: "qer_revised",
    },
  }));
  const editResponse = await editResponsePromise;
  assert.equal(editResponse.status, 200);
  assert.equal((await editResponse.json() as { prompt: { editRevision: string } }).prompt.editRevision, "qer_revised");
});
