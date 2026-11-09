/** #4117's Location criteria through the real control plane process and routes, with synthetic
 * runners: a person's POST, a runner's registration and an adopted session's move each reach a live
 * campaign's boundary, and a session credential can't add a Location at all. Removing the calls in
 * index.ts that connect those routes to CampaignLocations fails these. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CAMPAIGN_LOCATION_GATES_MIN_PROTOCOL, DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROJECT_LOCATION_INSPECTION_FAILURES, PROTOCOL_VERSION, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type CampaignControl, type RunnerMetadata } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const HOME = "runner-campaign-home";
const AWAY = "runner-campaign-away";
const HOME_TOKEN = `wollipogr_${"c".repeat(43)}`;
const AWAY_TOKEN = `wollipogr_${"d".repeat(43)}`;
const DEVICE_TOKEN = "device-campaign-locations";
const ROOT_TOKEN = "agent-credential-of-the-root";
const CHILD_TOKEN = "agent-credential-of-the-child";
const ROOT = "campaign-locations-root";
const CHILD = "campaign-locations-child";
const ADOPTED = "campaign-locations-adopted";
const ADOPTED_DETACHED = "campaign-locations-adopted-detached";
const REPOSITORY = "owner/launch";
/** What each folder's origin says, as a runner would read it. */
const ORIGINS: Record<string, string> = { "/work/launch": REPOSITORY, "/work/second": "owner/second", "/work/spare": "owner/spare",
  "/work/imported": "owner/imported", "/work/revived": "owner/revived", "/away/third": "owner/third" };

const runnerMetadata = (runnerId: string, workspaces: RunnerMetadata["workspaces"]): RunnerMetadata => ({ runnerId, hostname: runnerId, os: "linux", version: "integration", workspaces,
  agents: [{ id: "claude-agent", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true }],
  runtime: { dataDir: "/data", worktreeRoot: "/data/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 3 } } });
const HOME_WORKSPACES = [{ id: "launch", name: "Launch", path: "/work/launch" }, { id: "second", name: "Second", path: "/work/second" },
  { id: "spare", name: "Spare", path: "/work/spare" }, { id: "revived", name: "Revived", path: "/work/revived" }];
const AWAY_WORKSPACES = [{ id: "third", name: "Third", path: "/away/third" }];

function seed(database: string): { projectId: string; awayLocationId: string; spareLocationId: string; detachedLocationId: string; ownerId: string } {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    const identity = db.localIdentityContext();
    const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
    db.registerRunner(runnerMetadata(HOME, HOME_WORKSPACES), now, PROTOCOL_VERSION);
    db.registerRunner(runnerMetadata(AWAY, AWAY_WORKSPACES), now, PROTOCOL_VERSION);
    for (const [runnerId, token, suffix] of [[HOME, HOME_TOKEN, "home"], [AWAY, AWAY_TOKEN, "away"]] as const) {
      db.issueRunnerCredential({ credentialId: `rcred_${suffix.padEnd(32, "0")}`, runnerId, organizationId: identity.organizationId, ownerKind: "organization",
        ownerId: identity.organizationId, label: `Campaign Locations fixture ${suffix}`, tokenHash: hashToken(token), createdByUserId: identity.userId, now, expiresAt: now + 300_000 });
    }
    db.createDevice({ id: "device-campaign-locations", name: "Owner Browser", tokenHash: hashToken(DEVICE_TOKEN), userId: identity.userId, organizationId: identity.organizationId, now });
    const project = db.createProject({ name: "Campaign Locations", scope });
    const launch = db.addProjectLocation(project.id, { runnerId: HOME, workspaceId: "launch", addedByUserId: identity.userId });
    const away = db.addProjectLocation(project.id, { runnerId: AWAY, workspaceId: "third", addedByUserId: identity.userId });
    const detached = db.addProjectLocation(project.id, { runnerId: HOME, workspaceId: "revived", addedByUserId: identity.userId });
    const elsewhere = db.createProject({ name: "Elsewhere", scope });
    const spare = db.addProjectLocation(elsewhere.id, { runnerId: HOME, workspaceId: "spare", addedByUserId: identity.userId });
    const control: CampaignControl = { mode: "full_control", boundary: { version: 1, revision: 2, issueScopeRevision: 2, repository: REPOSITORY, objective: "Work across the Project",
      authorizedByUserId: identity.userId, authorizedAt: now - 1_000, operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication",
        "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"], delegatablePolicyIds: [],
      issueAuthority: { epics: [], relatedFollowUps: true, maxIssues: 10, closureReasons: ["completed"] },
      repositories: [{ repository: REPOSITORY, locationIds: [launch.id] }] } };
    const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policy.issueScope = { repository: REPOSITORY, issueNumbers: [12], revision: 2, authorizedByUserId: identity.userId, authorizedAt: now - 1_000 };
    policy.issueNumbers = [12];
    policy.control = control;
    // The launch found this one offline: only its runner reconnecting retries it.
    policy.excludedLocations = [{ locationId: away.id, name: away.name, failure: "runner_offline", reason: PROJECT_LOCATION_INSPECTION_FAILURES.runner_offline }];
    db.createSession({ id: ROOT, runnerId: HOME, workspaceId: "launch", agentId: "claude-agent", title: ROOT, useWorktree: false, driver: "claude-code",
      config: { permissionMode: "orchestrator" }, role: "orchestrator", orchestratorPolicy: policy, creationActor: "human",
      parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, scope, now });
    db.raw().prepare("UPDATE sessions SET parent_control_policy_revision=2, project_id=?, project_location_id=? WHERE id=?").run(project.id, launch.id, ROOT);
    db.createSession({ id: CHILD, parentSessionId: ROOT, runnerId: HOME, workspaceId: "launch", agentId: "claude-agent", title: CHILD, useWorktree: false, driver: "claude-code",
      config: {}, creationActor: "agent", scope, now });
    db.updateSessionStatus(ROOT, "running", now + 1);
    db.updateSessionStatus(CHILD, "running", now + 1);
    assert.ok(db.setAgentControlCredential(ROOT, HOME, hashToken(ROOT_TOKEN), now));
    assert.ok(db.setAgentControlCredential(CHILD, HOME, hashToken(CHILD_TOKEN), now));
    db.createSessionFromSnapshot({ id: ADOPTED, workspaceId: null, agentId: null, title: "Imported Session", status: "idle", driver: "codex", useWorktree: false, worktreePath: null,
      workspacePath: "/work/imported", config: {}, preview: null, pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: true, seq: 0, createdAt: now, updatedAt: now },
    HOME, now, scope, { projectId: null, projectLocationId: null });
    db.createSessionFromSnapshot({ id: ADOPTED_DETACHED, workspaceId: null, agentId: null, title: "Imported Session at a Detached Location", status: "idle", driver: "codex", useWorktree: false, worktreePath: null,
      workspacePath: "/work/revived", config: {}, preview: null, pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: true, seq: 0, createdAt: now, updatedAt: now },
    HOME, now, scope, { projectId: null, projectLocationId: null });
    return { projectId: project.id, awayLocationId: away.id, spareLocationId: spare.id, detachedLocationId: detached.id, ownerId: identity.userId };
  } finally { db.close(); }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), delay(3_000)]);
}

async function startControlPlane(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-campaign-locations-"));
  const database = join(temp, "control-plane.db");
  const port = await reservePort();
  const seeded = seed(database);
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port), CONTROL_PLANE_DB: database, CONTROL_PLANE_LOCAL_TOKEN_FILE: join(temp, "local-device.token") } });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.close(); await stopChild(child); rmSync(temp, { recursive: true, force: true }); });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* Startup races are expected. */ }
    if (Date.now() > deadline) throw new Error(`control plane did not become healthy:\n${logs}`);
    await delay(50);
  }
  /** A runner that answers inspections from ORIGINS and accepts every scope synchronization. */
  const connect = async (metadata: RunnerMetadata, token: string, snapshots: unknown[], protocolVersion = PROTOCOL_VERSION) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/runner`);
    sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "campaign_launch_inspect") {
        const repository = ORIGINS[String(message.workspacePath)];
        socket.send(JSON.stringify(repository ? { type: "campaign_launch_inspection_result", requestId: message.requestId, workspaceId: message.workspaceId, ok: true, repository,
          issueNumbers: message.issueNumbers, digest: "d".repeat(64) } : { type: "campaign_launch_inspection_result", requestId: message.requestId, workspaceId: message.workspaceId, ok: false,
          failure: "not_repository", error: "not a repository" }));
      }
      if (message.type === "campaign_issue_scope") {
        socket.send(JSON.stringify({ type: "campaign_issue_scope_result", requestId: message.requestId, sessionId: message.sessionId, ok: true, repository: REPOSITORY,
          ...(message.operation === "synchronize" ? { revision: (message.scope as { revision: number }).revision } : {}) }));
      }
    });
    await new Promise<void>((done, reject) => {
      socket.addEventListener("open", () => done(), { once: true });
      socket.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
    });
    socket.send(JSON.stringify({ type: "register", token, protocolVersion, runner: metadata, sessionSnapshots: snapshots }));
    for (let waited = 0; !messages.some((message) => message.type === "registered"); waited += 25) {
      if (waited > 10_000) throw new Error(`runner was not registered:\n${logs}`);
      await delay(25);
    }
    return messages;
  };
  const snapshot = (id: string, permissionMode: string | null) => ({ id, workspaceId: "launch", agentId: "claude-agent", title: id, status: "running" as const, driver: "claude-code" as const,
    useWorktree: false, worktreePath: null, config: permissionMode ? { permissionMode } : {}, preview: null, pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 1 });
  const homeMessages = await connect(runnerMetadata(HOME, HOME_WORKSPACES), HOME_TOKEN, [snapshot(ROOT, "orchestrator"), snapshot(CHILD, null)]);
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const asOwner = (path: string, body: unknown) => post(path, body, { authorization: `Bearer ${DEVICE_TOKEN}` });
  const read = <T>(work: (db: ControlPlaneDb) => T): T => {
    const db = ControlPlaneDb.attach(database);
    try { return work(db); } finally { db.close(); }
  };
  const write = <T>(work: (db: ControlPlaneDb) => T): T => read(work);
  const boundary = () => read((db) => (db.getSession(ROOT)!.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary);
  const until = async (what: string, predicate: () => boolean) => {
    for (let waited = 0; ; waited += 25) {
      if (predicate()) return;
      if (waited > 15_000) throw new Error(`timed out waiting for ${what}:\n${logs}`);
      await delay(25);
    }
  };
  const rows = () => read((db) => ({
    locations: (db.raw().prepare("SELECT COUNT(*) AS n FROM project_locations").get() as { n: number }).n,
    workspaces: (db.raw().prepare("SELECT COUNT(*) AS n FROM workspace_extras").get() as { n: number }).n,
    adopted: db.getSession(ADOPTED)!.projectId ?? null,
    held: JSON.stringify(boundary().repositories),
    revision: boundary().revision,
  }));
  return { ...seeded, connect, post, get, asOwner, read, write, boundary, until, rows, homeMessages };
}

test("an owner's POST of a Location reaches a live campaign, which inspects it and adds it at a new revision (#4117)", { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const before = cp.boundary().revision;
  const added = await cp.asOwner(`/api/projects/${cp.projectId}/locations`, { runnerId: HOME, workspaceId: "second" });
  assert.equal(added.status, 200, await added.clone().text());
  await cp.until("the Location to join", () => Boolean(cp.boundary().repositories?.some((entry) => entry.repository === "owner/second")));
  assert.equal(cp.boundary().revision, before + 1);
  assert.ok(cp.homeMessages.some((message) => message.type === "campaign_launch_inspect" && message.workspacePath === "/work/second"), "inspected in its own path");
  const joined = cp.read((db) => db.getSession(ROOT)!.orchestratorPolicy!.locationJoins!);
  assert.deepEqual(joined.map((join) => [join.repository, join.source]), [["owner/second", "owner_added"]]);
});

test("a runner's real registration retries the owner's Location the launch found offline, which then joins (#4117)", { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const before = cp.boundary().revision;
  assert.ok(cp.read((db) => db.getSession(ROOT)!.orchestratorPolicy!.excludedLocations!.some((item) => item.locationId === cp.awayLocationId)));
  assert.equal(cp.boundary().repositories!.some((entry) => entry.repository === "owner/third"), false);
  const messages = await cp.connect(runnerMetadata(AWAY, AWAY_WORKSPACES), AWAY_TOKEN, []);
  await cp.until("the Location to join on reconnect", () => Boolean(cp.boundary().repositories?.some((entry) => entry.repository === "owner/third")));
  assert.equal(cp.boundary().revision, before + 1);
  assert.ok(messages.some((message) => message.type === "campaign_launch_inspect" && message.workspacePath === "/away/third"));
  assert.equal(cp.read((db) => db.getSession(ROOT)!.orchestratorPolicy!.excludedLocations?.length ?? 0), 0);
});

test("a runner's real registration below the gates' floor records why, and its real update then joins the Location (#4319)", { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const before = cp.boundary().revision;
  const exclusion = () => cp.read((db) => db.getSession(ROOT)!.orchestratorPolicy!.excludedLocations?.find((item) => item.locationId === cp.awayLocationId));
  assert.equal(exclusion()?.failure, "runner_offline");
  const old = await cp.connect(runnerMetadata(AWAY, AWAY_WORKSPACES), AWAY_TOKEN, [], CAMPAIGN_LOCATION_GATES_MIN_PROTOCOL - 1);
  await cp.until("the exclusion to name the version", () => exclusion()?.failure === "runner_below_gates");
  assert.match(exclusion()!.reason, new RegExp(`protocol version ${CAMPAIGN_LOCATION_GATES_MIN_PROTOCOL} or newer`, "u"));
  assert.equal(cp.boundary().revision, before);
  assert.equal(old.some((message) => message.type === "campaign_launch_inspect"), false, "that runner is never asked");
  const updated = await cp.connect(runnerMetadata(AWAY, AWAY_WORKSPACES), AWAY_TOKEN, []);
  await cp.until("the Location to join after the update", () => Boolean(cp.boundary().repositories?.some((entry) => entry.repository === "owner/third")));
  assert.equal(cp.boundary().revision, before + 1);
  assert.ok(updated.some((message) => message.type === "campaign_launch_inspect" && message.workspacePath === "/away/third"));
  assert.equal(exclusion(), undefined);
});

test("a session credential is refused by every route that adds a Location, and no row is written (#4117)", { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const before = cp.rows();
  const attempts: Array<[string, unknown]> = [
    [`/api/projects/${cp.projectId}/locations`, { runnerId: HOME, workspaceId: "second" }],
    [`/api/projects/${cp.projectId}/locations/new`, { runnerId: HOME, name: "From an Agent", path: "/work/second" }],
    [`/api/projects/${cp.projectId}/locations/move`, { locationId: cp.spareLocationId }],
    [`/api/runners/${HOME}/workspaces`, { name: "From an Agent", path: "/work/from-agent" }],
    [`/api/sessions/${ADOPTED}/project`, { projectId: cp.projectId, linkLocation: true }],
  ];
  for (const [session, token] of [[ROOT, ROOT_TOKEN], [CHILD, CHILD_TOKEN]] as const) {
    const headers = { authorization: `Bearer ${token}`, [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: session };
    // The credential really is live: it reaches a route the session is allowed.
    const allowed = await cp.get(`/api/sessions/${session}`, headers);
    assert.equal(allowed.status, 200, `${session}'s credential isn't live: ${await allowed.clone().text()}`);
    for (const [path, body] of attempts) {
      const refused = await cp.post(path, body, headers);
      assert.ok(refused.status === 401 || refused.status === 403, `${session} ${path} answered ${refused.status}: ${await refused.clone().text()}`);
    }
  }
  // Give anything the refused requests might have started the time a real addition takes.
  await delay(500);
  assert.deepEqual(cp.rows(), before, "no Location, no Workspace, no join");
  // The same route with the owner's credential does add it, so the refusal is the credential's.
  const added = await cp.asOwner(`/api/projects/${cp.projectId}/locations`, { runnerId: HOME, workspaceId: "second" });
  assert.equal(added.status, 200, await added.clone().text());
  assert.equal(cp.rows().locations, before.locations + 1);
});

test("linking a detached Location by moving an adopted session revives it under its own id, as an addition the campaign hears about (#4117)", { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const before = cp.boundary().revision;
  // The Location detached after its runner was removed, so the Project still lists it as such.
  cp.write((db) => db.raw().prepare("UPDATE project_locations SET detached_at=? WHERE id=?").run(Date.now(), cp.detachedLocationId));
  assert.equal(cp.read((db) => db.getProjectLocation(cp.detachedLocationId)?.availability), "runner_removed");
  const moved = await cp.asOwner(`/api/sessions/${ADOPTED_DETACHED}/project`, { projectId: cp.projectId, linkLocation: true });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(cp.read((db) => db.getSession(ADOPTED_DETACHED)!.projectLocationId), cp.detachedLocationId, "the same Location, revived");
  assert.equal(cp.read((db) => db.projectLocationAddedBy(cp.detachedLocationId)), cp.ownerId);
  await cp.until("the revived Location to join", () => Boolean(cp.boundary().repositories?.some((entry) => entry.locationIds.includes(cp.detachedLocationId))));
  assert.equal(cp.boundary().revision, before + 1);
});

test("a Location an owner links by moving an adopted session records them as its adder and joins the campaign (#4117)", { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const before = cp.boundary().revision;
  const moved = await cp.asOwner(`/api/sessions/${ADOPTED}/project`, { projectId: cp.projectId, linkLocation: true });
  assert.equal(moved.status, 200, await moved.clone().text());
  const locationId = cp.read((db) => db.getSession(ADOPTED)!.projectLocationId)!;
  assert.ok(locationId);
  assert.equal(cp.read((db) => db.projectLocationAddedBy(locationId)), cp.ownerId, "the person moving it added it");
  await cp.until("the linked Location to join", () => Boolean(cp.boundary().repositories?.some((entry) => entry.repository === "owner/imported" && entry.locationIds.includes(locationId))));
  assert.equal(cp.boundary().revision, before + 1);
  assert.equal(cp.read((db) => db.getSession(ROOT)!.orchestratorPolicy!.pendingLocations?.length ?? 0), 0);
});
