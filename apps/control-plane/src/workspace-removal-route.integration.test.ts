import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type ProjectView, type RunnerMetadata, type RunnerView } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const OWNER_TOKEN = "workspace-removal-owner-token";
const OPERATOR_TOKEN = "workspace-removal-operator-token";
const RUNNER_TOKEN = `wollipogr_${"w".repeat(43)}`;

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


async function openRunner(port: number, sockets: Set<WebSocket>, protocolVersion: number, runner: RunnerMetadata) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  sockets.add(socket);
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
  });
  socket.send(JSON.stringify({ type: "register", token: RUNNER_TOKEN, protocolVersion, runner, liveSessions: [] }));
  await inbox.take((message) => message.type === "registered");
  return { socket, inbox };
}

test("Remove Workspace unregisters managed and configured workspaces with registration's authority", { timeout: 30_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-workspace-removal-route-"));
  const databasePath = join(temp, "control-plane.db");
  const runner: RunnerMetadata = {
    runnerId: "runner-workspace-removal",
    hostname: "workspace-removal-host",
    os: "linux",
    version: "integration",
    agents: [],
    workspaces: [
      { id: "home", name: "home", path: "/home/person" },
      { id: "site", name: "site", path: "/srv/site" },
    ],
  };
  const now = Date.now();
  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  seed.createDevice({ id: "device_workspace_removal_owner", name: "Owner Device", tokenHash: hashToken(OWNER_TOKEN), now });
  seed.createIdentityMember({
    userId: "usr_workspace_operator", displayName: "Workspace Operator", organizationId: identity.organizationId,
    role: "operator", now,
  });
  seed.createDevice({
    id: "device_workspace_removal_operator", name: "Operator Device", tokenHash: hashToken(OPERATOR_TOKEN),
    userId: "usr_workspace_operator", organizationId: identity.organizationId, now,
  });
  seed.registerRunner(runner, now, 276);
  seed.issueRunnerCredential({
    credentialId: `rcred_${"workspaceremoval".padEnd(32, "0")}`,
    runnerId: runner.runnerId,
    organizationId: identity.organizationId,
    ownerKind: "organization",
    ownerId: identity.organizationId,
    label: "Workspace removal fixture",
    tokenHash: hashToken(RUNNER_TOKEN),
    createdByUserId: identity.userId,
    now,
    expiresAt: now + 60_000,
  });
  const notes = seed.registerMachineWorkspace(runner.runnerId, { name: "Notes", path: "/srv/notes" }, undefined, now);
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
  const owner = { authorization: `Bearer ${OWNER_TOKEN}` };
  const remove = (workspaceId: string, headers: Record<string, string> = owner) =>
    fetch(`${httpBase}/api/runners/${runner.runnerId}/workspaces/${workspaceId}`, { method: "DELETE", headers });
  const workspaces = async () => {
    const { runners } = await (await fetch(`${httpBase}/api/runners`, { headers: owner })).json() as { runners: RunnerView[] };
    return runners.find((candidate) => candidate.runnerId === runner.runnerId)!.workspaces
      .map(({ id, source }) => ({ id, source }));
  };

  const oldRunner = await openRunner(port, sockets, 276, runner);
  assert.deepEqual(await workspaces(), [
    { id: "home", source: "configured" },
    { id: "site", source: "configured" },
    { id: notes.id, source: "managed" },
  ]);

  const operatorAttempt = await remove(notes.id, { authorization: `Bearer ${OPERATOR_TOKEN}` });
  assert.equal(operatorAttempt.status, 403, "removal needs the owner or admin authority registration needs");
  assert.equal((await remove("unknown")).status, 404);

  const unsupported = await remove("site");
  assert.equal(unsupported.status, 409);
  assert.deepEqual(await unsupported.json(), {
    error: "This machine needs a newer runner for removing configured workspaces. Update and restart the runner.",
    requiredRunnerProtocolVersion: 277,
    runnerProtocolVersion: 276,
  });

  // A workspace added in Wollipog lives in the control plane, so any runner version can drop it.
  const managedRemoval = await remove(notes.id);
  assert.equal(managedRemoval.status, 200);
  assert.deepEqual(await managedRemoval.json(), { removed: true });
  assert.deepEqual((await workspaces()).map((workspace) => workspace.id), ["home", "site"]);

  oldRunner.socket.close();
  const offline = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await remove("site");
      if (response.status === 409 && (await response.clone().json() as { error: string }).error === "runner is offline") return response;
      await delay(50);
    }
    throw new Error("the runner never went offline");
  })();
  assert.equal(offline.status, 409);

  const { socket, inbox } = await openRunner(port, sockets, PROTOCOL_VERSION, runner);

  const blocked = await remove("site");
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json() as { error: string; blockers: Array<{ kind: string }> };
  assert.equal(blockedBody.error, "This workspace is still in use. Remove it from the project “site” first.");
  assert.deepEqual(blockedBody.blockers.map((blocker) => blocker.kind), ["project_location"]);

  const { projects } = await (await fetch(`${httpBase}/api/projects`, { headers: owner })).json() as { projects: ProjectView[] };
  const location = projects.flatMap((project) => project.locations).find((candidate) => candidate.workspaceId === "site")!;
  const locationRemoval = await fetch(`${httpBase}/api/projects/${location.projectId}/locations/${location.id}`, {
    method: "DELETE", headers: owner,
  });
  assert.equal(locationRemoval.status, 200);

  const refusedResponse = remove("site");
  const refused = await inbox.take((message) => message.type === "remove_workspace");
  assert.deepEqual(
    { runnerId: refused.runnerId, workspaceId: refused.workspaceId, path: refused.path },
    { runnerId: runner.runnerId, workspaceId: "site", path: "/srv/site" },
  );
  socket.send(JSON.stringify({
    type: "remove_workspace_result", requestId: refused.requestId, ok: false,
    error: "A session is running in this workspace. Stop it, then try again.",
  }));
  const refusedReply = await refusedResponse;
  assert.equal(refusedReply.status, 409);
  assert.deepEqual(await refusedReply.json(), { error: "A session is running in this workspace. Stop it, then try again." });
  assert.deepEqual((await workspaces()).map((workspace) => workspace.id), ["home", "site"], "a refusal changes nothing");

  const removalResponse = remove("site");
  const removal = await inbox.take((message) => message.type === "remove_workspace");
  socket.send(JSON.stringify({ type: "remove_workspace_result", requestId: removal.requestId, ok: true }));
  const removalReply = await removalResponse;
  assert.equal(removalReply.status, 200);
  assert.deepEqual(await removalReply.json(), { removed: true });
  assert.deepEqual((await workspaces()).map((workspace) => workspace.id), ["home"]);

  // The runner keeps it removed, so a reconnect advertises only what remains.
  socket.close();
  await openRunner(port, sockets, PROTOCOL_VERSION, { ...runner, workspaces: [runner.workspaces[0]!] });
  assert.deepEqual(await workspaces(), [{ id: "home", source: "configured" }]);
});
