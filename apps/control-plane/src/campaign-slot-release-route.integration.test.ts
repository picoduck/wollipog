/** #4331, owner decision 2026-11-06: a campaign slot that no automatic proof can ever free is released
 * only by a person. This drives the real control plane process and HTTP route with a synthetic runner,
 * the Orchestrator's own session credential under Full Control, and the owner's device. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER, type CampaignControl, type RunnerMetadata } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-slot-release";
const WORKSPACE_ID = "workspace-slot-release";
const RUNNER_TOKEN = `wollipogr_${"s".repeat(43)}`;
const DEVICE_TOKEN = "device-slot-release";
const AGENT_TOKEN = "agent_slot_release_orchestrator_token";
const REPOSITORY = "picoduck/wollipog";
const ROOT = "campaign-slot-release";
const WORKER = "campaign-slot-release-worker";
const AUTHORIZED_AT = 1_794_030_377_235;

function runnerMetadata(): RunnerMetadata {
  return { runnerId: RUNNER_ID, hostname: "slot-release-host", os: "linux", version: "integration",
    workspaces: [{ id: WORKSPACE_ID, name: "Wollipog", path: "/workspace" }],
    agents: [{ id: "claude-agent", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true }] };
}

/** A running Full Control campaign whose one ended worker holds its only slot: the runner that served
 * it is too old to prove its provider retired. */
function seed(database: string): { generation: string; userId: string } {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    const identity = db.localIdentityContext();
    db.registerRunner(runnerMetadata(), now, PROTOCOL_VERSION);
    db.issueRunnerCredential({ credentialId: `rcred_${"slotrelease".padEnd(32, "0")}`, runnerId: RUNNER_ID, organizationId: identity.organizationId,
      ownerKind: "organization", ownerId: identity.organizationId, label: "Slot release route fixture",
      tokenHash: hashToken(RUNNER_TOKEN), createdByUserId: identity.userId, now, expiresAt: now + 120_000 });
    db.createDevice({ id: "device-slot-release", name: "Owner Browser", tokenHash: hashToken(DEVICE_TOKEN), userId: identity.userId,
      organizationId: identity.organizationId, now });
    const budgetAuthority = { version: 1 as const, concurrency: 1, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    const control: CampaignControl = { mode: "full_control", boundary: { version: 1, revision: 2, issueScopeRevision: 2, repository: REPOSITORY,
      objective: "Finish #4331", authorizedByUserId: identity.userId, authorizedAt: AUTHORIZED_AT,
      operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval",
        "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"], delegatablePolicyIds: [],
      issueAuthority: { epics: [4331], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed"] }, budgetAuthority } };
    const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policy.issueScope = { repository: REPOSITORY, issueNumbers: [4331], revision: 2, authorizedByUserId: identity.userId, authorizedAt: AUTHORIZED_AT };
    policy.issueNumbers = [4331];
    policy.control = control;
    const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
    db.createSession({ id: ROOT, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "claude-agent", title: ROOT, useWorktree: false,
      driver: "claude-code", config: { permissionMode: "orchestrator" }, role: "orchestrator", orchestratorPolicy: policy, creationActor: "human",
      parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, scope, now });
    db.raw().prepare("UPDATE sessions SET parent_control_policy_revision=2 WHERE id=?").run(ROOT);
    db.campaignBudgets.authorize(ROOT, budgetAuthority);
    db.updateSessionStatus(ROOT, "running", now + 1);
    assert.equal(db.setAgentControlCredential(ROOT, RUNNER_ID, hashToken(AGENT_TOKEN), now + 2), true);
    db.createSession({ id: WORKER, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "claude-agent", title: "Implement #4331",
      useWorktree: false, driver: "claude-code", config: {}, parentSessionId: ROOT, creationActor: "agent", scope, now: now + 3 });
    db.campaignBudgets.admit(ROOT, { sessionId: WORKER }, {});
    const generation = db.campaignBudgets.dispatch(WORKER)!.generation;
    db.updateSessionStatus(WORKER, "failed", now + 4);
    // An older runner served it, as its registration below that protocol would have recorded.
    db.registerRunner(runnerMetadata(), now + 5, RUNNER_CAPABILITY_MIN_PROTOCOL.campaignProviderRetirementProof - 1);
    db.registerRunner(runnerMetadata(), now + 6, PROTOCOL_VERSION);
    return { generation, userId: identity.userId };
  } finally { db.close(); }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = Number(process.env.WOLLIPOG_PORT_BLOCK_START ?? 0);
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
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
  const temp = mkdtempSync(join(tmpdir(), "wollipog-slot-release-"));
  const database = join(temp, "control-plane.db");
  const port = await reservePort();
  const seeded = seed(database);
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port), CONTROL_PLANE_DB: database,
      CONTROL_PLANE_LOCAL_TOKEN_FILE: join(temp, "local-device.token") },
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let runner: WebSocket | null = null;
  t.after(async () => { runner?.close(); await stopChild(child); rmSync(temp, { recursive: true, force: true }); });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* Startup races are expected. */ }
    if (Date.now() > deadline) throw new Error(`control plane did not become healthy:\n${logs}`);
    await delay(50);
  }
  // The runner reconnects with the Orchestrator live and the ended worker gone from its inventory.
  runner = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  const messages: Array<Record<string, unknown>> = [];
  runner.addEventListener("message", (event) => {
    if (typeof event.data === "string") messages.push(JSON.parse(event.data) as Record<string, unknown>);
  });
  await new Promise<void>((done, reject) => {
    runner!.addEventListener("open", () => done(), { once: true });
    runner!.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
  });
  runner.send(JSON.stringify({ type: "register", token: RUNNER_TOKEN, protocolVersion: PROTOCOL_VERSION, runner: runnerMetadata(),
    sessionSnapshots: [{ id: ROOT, workspaceId: WORKSPACE_ID, agentId: "claude-agent", title: ROOT, status: "running", driver: "claude-code",
      useWorktree: false, worktreePath: null, config: { permissionMode: "orchestrator" }, preview: null, pendingApproval: null,
      tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 1 }] }));
  for (let waited = 0; !messages.some((message) => message.type === "registered"); waited += 25) {
    if (waited > 10_000) throw new Error(`runner was not registered:\n${logs}`);
    await delay(25);
  }
  const call = (token: string, agent: boolean) => async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, ...(agent ? { [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: ROOT } : {}),
        "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* Not every refusal has a body. */ }
    return { status: response.status, json, text };
  };
  return { database, ...seeded, human: call(DEVICE_TOKEN, false), orchestrator: call(AGENT_TOKEN, true), logs: () => logs };
}

function budget(database: string) {
  const db = ControlPlaneDb.attach(database);
  try { return db.campaignBudgets.view(ROOT)!; } finally { db.close(); }
}

test("only the campaign's owner releases a held slot; its Full Control Orchestrator is refused (#4331)", { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const path = `/api/sessions/${ROOT}/orchestrator-campaign/slots/release`;
  const body = { sessionId: WORKER, generation: cp.generation, reason: "Rebooted the host" };
  assert.deepEqual(budget(cp.database).heldSlots?.map((slot) => [slot.sessionId, slot.reason]), [[WORKER, "older_runner"]]);

  const asOrchestrator = await cp.orchestrator(path, body);
  // No agent allowlist entry exists, so the credential layer refuses it before the route's own
  // human-only check (403) is even reached.
  assert.equal(asOrchestrator.status, 401, `${asOrchestrator.text}\n${cp.logs()}`);
  assert.match(String(asOrchestrator.json.error), /unavailable to the session credential.*owner-only actions/u);
  assert.equal(budget(cp.database).occupied, 1, "the agent's request changed nothing");
  assert.equal(budget(cp.database).slotReleases, undefined);

  const asOwner = await cp.human(path, body);
  assert.equal(asOwner.status, 200, `${asOwner.text}\n${cp.logs()}`);
  assert.equal(asOwner.json.releasedByUserId, cp.userId);
  assert.equal(asOwner.json.reason, "Rebooted the host");
  assert.equal(asOwner.json.heldReason, "older_runner");
  const after = budget(cp.database);
  assert.equal(after.occupied, 0);
  assert.equal(after.heldSlots, undefined);
  assert.deepEqual(after.slotReleases?.map((r) => [r.sessionId, r.releasedByUserId, r.settlement.source]), [[WORKER, cp.userId, "recorded_usage"]]);

  const replay = await cp.human(path, { ...body, reason: "Again" });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.reason, "Rebooted the host", "a repeat returns the recorded release");
  assert.equal(budget(cp.database).slotReleases?.length, 1);
});
