/**
 * End-to-end coverage for managed-skill authorization and discovery-time sync against the REAL
 * control plane: the process is spawned exactly like production (index.ts), so requests pass
 * through the genuine auth gate (authorizeApiRequest) and runner frames through the genuine
 * /runner channel.
 *
 * Pins two review findings:
 * - P1 authorization: skill routes are member-scoped like /api/projects — an ordinary member and
 *   an owner/admin of a NON-personal organization must both reach them (previously every skill
 *   route was rejected as a personal-organization-global resource).
 * - P1 discovery race: a runner that registers with an empty agent inventory and only reports its
 *   harnesses via a later agents_updated message must still receive a refreshed skills_sync.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "./local-device-credential.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-skills-integration";
const RUNNER_TOKEN = `wollipogr_${"s".repeat(43)}`;
const MEMBER_TOKEN = "skills-integration-member-token";
const FOREIGN_ADMIN_TOKEN = "skills-integration-foreign-admin-token";
const FOREIGN_ORGANIZATION_ID = "org_skills_integration_other";

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

  take(predicate: (message: JsonObject) => boolean, timeoutMs = 10_000): Promise<JsonObject> {
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
    } catch {
      /* listen has not completed */
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

function api(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

function skillPayload(name: string): string {
  return JSON.stringify({
    name,
    files: [{
      path: "SKILL.md",
      content: `---\nname: ${name}\ndescription: Integration fixture.\n---\nBody`,
      encoding: "utf8",
    }],
  });
}

test("skill routes are member-scoped and agents_updated refreshes the skills_sync", { timeout: 60_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-skills-route-"));
  const databasePath = join(temp, "control-plane.db");
  loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));

  // Personal-organization fixtures: an ordinary (operator) member and a runner credential.
  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  seed.createIdentityMember({
    userId: "usr_skills_member",
    displayName: "Skills Member",
    organizationId: identity.organizationId,
    role: "operator",
    now: 1,
  });
  seed.createDevice({
    id: "dev_skills_member",
    name: "Skills Member Device",
    tokenHash: hashToken(MEMBER_TOKEN),
    userId: "usr_skills_member",
    organizationId: identity.organizationId,
    now: 2,
  });
  const credentialNow = Date.now();
  seed.issueRunnerCredential({
    credentialId: "rcred_skills_integration_test1",
    runnerId: RUNNER_ID,
    organizationId: identity.organizationId,
    ownerKind: "organization",
    ownerId: identity.organizationId,
    label: "Skills integration",
    tokenHash: hashToken(RUNNER_TOKEN),
    createdByUserId: identity.userId,
    now: credentialNow,
    expiresAt: credentialNow + 600_000,
  });
  seed.close();

  // A second, NON-personal organization with its own admin — no creation API exists, so the
  // organization row is seeded directly before its membership and device rows.
  {
    const raw = new DatabaseSync(databasePath);
    raw.prepare(
      "INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(FOREIGN_ORGANIZATION_ID, "Skills Integration Other Org", 3, 3);
    raw.close();
  }
  const reseed = ControlPlaneDb.open(databasePath);
  reseed.createIdentityMember({
    userId: "usr_skills_foreign_admin",
    displayName: "Foreign Admin",
    organizationId: FOREIGN_ORGANIZATION_ID,
    role: "admin",
    now: 4,
  });
  reseed.createDevice({
    id: "dev_skills_foreign_admin",
    name: "Foreign Admin Device",
    tokenHash: hashToken(FOREIGN_ADMIN_TOKEN),
    userId: "usr_skills_foreign_admin",
    organizationId: FOREIGN_ORGANIZATION_ID,
    now: 5,
  });
  reseed.close();

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
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  const httpBase = `http://127.0.0.1:${port}`;
  await waitForHealth(httpBase, child, () => output);

  /* ---------- P1: skill routes are reachable by ordinary members (like /api/projects) ---------- */

  const memberList = await api(httpBase, MEMBER_TOKEN, "/api/skills");
  assert.equal(memberList.status, 200, "an ordinary member can list skills");
  assert.deepEqual((await memberList.json() as { skills: unknown[] }).skills, []);

  const memberCreate = await api(httpBase, MEMBER_TOKEN, "/api/skills", {
    method: "POST",
    body: skillPayload("member-skill"),
  });
  assert.equal(memberCreate.status, 201, "an ordinary member can create a skill");
  const memberSkill = (await memberCreate.json() as { skill: { id: string } }).skill;

  const memberAssignments = await api(httpBase, MEMBER_TOKEN, "/api/skill-assignments");
  assert.equal(memberAssignments.status, 200, "an ordinary member can list skill assignments");

  /* --------- P1: an owner/admin of a NON-personal organization is not rejected either --------- */

  const foreignList = await api(httpBase, FOREIGN_ADMIN_TOKEN, "/api/skills");
  assert.equal(foreignList.status, 200,
    "a non-personal-organization admin is not rejected as a personal-organization-global caller");

  const foreignCreate = await api(httpBase, FOREIGN_ADMIN_TOKEN, "/api/skills", {
    method: "POST",
    body: skillPayload("foreign-org-skill"),
  });
  assert.equal(foreignCreate.status, 201, "a non-personal-organization admin can create a skill");

  /* --------------- P1: assignments + the discovery-race fixture (finding 2 setup) --------------- */

  const assigned = await api(httpBase, MEMBER_TOKEN, "/api/skill-assignments", {
    method: "POST",
    body: JSON.stringify({ skillId: memberSkill.id, scopeKind: "instance", agentSelector: { kind: "all" } }),
  });
  assert.equal(assigned.status, 201, "an ordinary member can assign a skill machine-wide");

  // The runner registers with an EMPTY agent inventory — discovery has not reported yet, so the
  // registration-time skills_sync can resolve no harness targets.
  const { socket: runner, inbox: runnerInbox } = await openSocketWithInbox(`ws://127.0.0.1:${port}/runner`);
  sockets.add(runner);
  runner.send(JSON.stringify({
    type: "register",
    token: RUNNER_TOKEN,
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId: RUNNER_ID,
      hostname: "skills-integration-host",
      os: "linux",
      version: "integration",
      workspaces: [],
      agents: [],
    },
    sessionSnapshots: [],
  }));
  await runnerInbox.take((message) => message.type === "registered");
  const registrationSync = await runnerInbox.take((message) => message.type === "skills_sync");
  const registrationSkills = registrationSync.skills as Array<{ name: string; targets: unknown[] }>;
  assert.equal(registrationSkills[0]?.name, "member-skill");
  assert.deepEqual(registrationSkills[0]?.targets, [],
    "before discovery reports agents, the desired set has no harness targets");

  // The parameterized per-machine routes are member-scoped too, and resource scoping still
  // applies: the personal-organization member reaches the runner, the foreign admin gets 404.
  const memberRunnerView = await api(httpBase, MEMBER_TOKEN, `/api/runners/${RUNNER_ID}/skills`);
  assert.equal(memberRunnerView.status, 200, "an ordinary member can view a machine's skill state");
  assert.equal((await memberRunnerView.json() as { desired: Array<{ name: string }> }).desired[0]?.name,
    "member-skill");
  const foreignRunnerView = await api(httpBase, FOREIGN_ADMIN_TOKEN, `/api/runners/${RUNNER_ID}/skills`);
  assert.equal(foreignRunnerView.status, 404,
    "a foreign-organization admin is scoped out per-resource (404), not blanket-rejected (403)");

  /* ------- P1 (finding 2): agents_updated after registration triggers a refreshed sync ------- */

  runner.send(JSON.stringify({
    type: "agents_updated",
    runnerId: RUNNER_ID,
    agents: [{
      id: "claude",
      name: "Claude Code",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      context: { kind: "native" },
    }],
  }));
  const refreshedSync = await runnerInbox.take((message) =>
    message.type === "skills_sync" &&
    Array.isArray(message.skills) &&
    (message.skills as Array<{ targets?: Array<{ agentId?: string }> }>)
      .some((entry) => entry.targets?.some((target) => target.agentId === "claude")));
  const refreshedSkills = refreshedSync.skills as Array<{
    name: string;
    targets: Array<{ agentId: string; invocation: string }>;
  }>;
  assert.equal(refreshedSkills[0]!.name, "member-skill");
  assert.deepEqual(refreshedSkills[0]!.targets, [{ agentId: "claude", invocation: "agent" }],
    "the post-discovery sync resolves harness targets for the newly reported agent");

  assert.equal(child.exitCode, null, `control plane exited during the skills scenario\n${output}`);
});
