/** #2940, live on 2026-10-28: a Full Control root whose Human-approved issue scope (revision 3) its
 * boundary (issue scope revision 2) did not name refused every message its owner sent. This drives
 * the real control plane process and HTTP routes, with a synthetic runner, against that exact state. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, pendingRequests,
  type CampaignControl, type RunnerMetadata, type WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { ControlPlaneDb } from "./db.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-human-scope-boundary";
const WORKSPACE_ID = "workspace-human-scope-boundary";
const RUNNER_TOKEN = `wollipogr_${"h".repeat(43)}`;
const DEVICE_TOKEN = "device-human-scope-boundary";
const REPOSITORY = "picoduck/wollipog";
/** Restored from its Human's approval record. */
const STUCK = "campaign-stuck-by-human-scope";
/** Stale for a reason no approval record explains. */
const UNEXPLAINED = "campaign-stale-unexplained";
/** A current Full Control campaign, as it was before the owner changed its scope. */
const HEALTHY = "campaign-current-boundary";
const BOUNDARY_AT = 1_793_108_688_979;
const APPROVED_AT = 1_793_206_525_429;

function runnerMetadata(): RunnerMetadata {
  return { runnerId: RUNNER_ID, hostname: "human-scope-boundary-host", os: "linux", version: "integration",
    workspaces: [{ id: WORKSPACE_ID, name: "Wollipog", path: "/workspace" }],
    agents: [{ id: "claude-agent", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true }] };
}

function seed(database: string): void {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    const identity = db.localIdentityContext();
    db.registerRunner(runnerMetadata(), now, PROTOCOL_VERSION);
    db.issueRunnerCredential({ credentialId: `rcred_${"humanscope".padEnd(32, "0")}`, runnerId: RUNNER_ID, organizationId: identity.organizationId,
      ownerKind: "organization", ownerId: identity.organizationId, label: "Human scope boundary route fixture",
      tokenHash: hashToken(RUNNER_TOKEN), createdByUserId: identity.userId, now, expiresAt: now + 120_000 });
    db.createDevice({ id: "device-human-scope", name: "Owner Browser", tokenHash: hashToken(DEVICE_TOKEN), userId: identity.userId,
      organizationId: identity.organizationId, now });
    const budgetAuthority = { version: 1 as const, concurrency: 3, acceptedFollowUps: 2, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    const control: CampaignControl = { mode: "full_control", boundary: { version: 1, revision: 2, issueScopeRevision: 2, repository: REPOSITORY,
      objective: "Finish #3522 and #3617", authorizedByUserId: identity.userId, authorizedAt: BOUNDARY_AT,
      operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval",
        "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"], delegatablePolicyIds: [],
      issueAuthority: { epics: [3522, 3617], relatedFollowUps: true, maxIssues: 4, closureReasons: ["completed"] }, budgetAuthority } };
    for (const id of [STUCK, UNEXPLAINED, HEALTHY]) {
      const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
      // What a Human's approval in Campaign Status left before the fix: the next scope revision,
      // authorized now, under the boundary that named the one before it.
      policy.issueScope = id === HEALTHY ? { repository: REPOSITORY, issueNumbers: [3522, 3617], revision: 2, authorizedByUserId: identity.userId, authorizedAt: BOUNDARY_AT }
        : { repository: REPOSITORY, issueNumbers: [3522, 3617, 3773, 3774], revision: 3, authorizedByUserId: identity.userId, authorizedAt: APPROVED_AT };
      policy.issueNumbers = [...policy.issueScope.issueNumbers];
      policy.control = structuredClone(control);
      db.createSession({ id, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "claude-agent", title: id, useWorktree: false,
        driver: "claude-code", config: { permissionMode: "orchestrator" }, role: "orchestrator", orchestratorPolicy: policy, creationActor: "human",
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
        scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } }, now });
      db.raw().prepare("UPDATE sessions SET parent_control_policy_revision=2 WHERE id=?").run(id);
      db.campaignBudgets.authorize(id, budgetAuthority);
      db.updateSessionStatus(id, "idle", now + 1);
    }
    // Only the stuck campaign has the consumed Human approval that wrote its current scope.
    const snapshot: WorkflowDecisionResourceSnapshot = { category: "campaign_issue_scope", repository: REPOSITORY, expectedRevision: 2,
      before: [3522, 3617], additions: [3773, 3774], removals: [], explanation: "The owner adds the follow-up work",
      affectedAssignments: [], affectedDecisions: [], activeChildren: [] };
    const occurrenceId = "workflow_human_scope_boundary_approval";
    assert.ok(db.createWorkflowDecision({ requestId: "human-scope", occurrenceId, sessionId: STUCK, controllingSessionId: STUCK,
      category: "campaign_issue_scope", resourceKey: `${REPOSITORY}:scope`, resourceSnapshot: snapshot,
      resourceDigest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), policyRevision: 2, authority: "human", createdAt: APPROVED_AT - 1 }));
    assert.ok(db.resolveWorkflowDecision(occurrenceId, "human", "approved", APPROVED_AT));
    assert.ok(db.consumeWorkflowDecision(occurrenceId, APPROVED_AT));
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
  const temp = mkdtempSync(join(tmpdir(), "wollipog-human-scope-boundary-"));
  const database = join(temp, "control-plane.db");
  const port = await reservePort();
  seed(database);
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
  runner = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  const messages: Array<Record<string, unknown>> = [];
  runner.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as Record<string, unknown>;
    messages.push(message);
    // The runner verifies issue candidates and accepts the scope it enforces, without a forge.
    if (message.type === "campaign_issue_scope") {
      runner!.send(JSON.stringify({ type: "campaign_issue_scope_result", requestId: message.requestId, sessionId: message.sessionId, ok: true,
        repository: REPOSITORY, ...(message.operation === "synchronize" ? { revision: (message.scope as { revision: number }).revision }
          : { candidates: ((message.issues as number[] | undefined) ?? [3773]).map((number) =>
            ({ issue: { repository: REPOSITORY, number }, title: `Issue ${number}`, source: "sub_issue" })) }) }));
    }
  });
  await new Promise<void>((done, reject) => {
    runner!.addEventListener("open", () => done(), { once: true });
    runner!.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
  });
  const snapshot = (id: string) => ({ id, workspaceId: WORKSPACE_ID, agentId: "claude-agent", title: id, status: "idle" as const,
    driver: "claude-code" as const, useWorktree: false, worktreePath: null, config: { permissionMode: "orchestrator" }, preview: null, pendingApproval: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 1 });
  runner.send(JSON.stringify({ type: "register", token: RUNNER_TOKEN, protocolVersion: PROTOCOL_VERSION, runner: runnerMetadata(),
    sessionSnapshots: [snapshot(STUCK), snapshot(UNEXPLAINED), snapshot(HEALTHY)] }));
  for (let waited = 0; !messages.some((message) => message.type === "registered"); waited += 25) {
    if (waited > 10_000) throw new Error(`runner was not registered:\n${logs}`);
    await delay(25);
  }
  const human = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const next = async (predicate: (message: Record<string, unknown>) => boolean, what: string) => {
    for (let waited = 0; ; waited += 25) {
      const found = messages.find(predicate);
      if (found) return found;
      if (waited > 10_000) throw new Error(`timed out waiting for ${what}:\n${logs}`);
      await delay(25);
    }
  };
  return { database, human, messages, next, send: (message: unknown) => runner!.send(JSON.stringify(message)), logs: () => logs };
}

function campaign(database: string, id: string) {
  const db = ControlPlaneDb.open(database);
  try { return db.getSession(id)!; } finally { db.close(); }
}

test("the owner restores a campaign a Human scope approval left stuck, through the real restart and prompt routes", { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t);
  assert.equal(campaignBoundaryCurrent(campaign(cp.database, STUCK)), false, "the live stuck state");
  // As on main, the runner's reconnect stops a campaign whose allowance boundary is stale.
  const stop = await cp.next((message) => message.type === "stop_session" && message.sessionId === STUCK, "the stale campaign's stop");
  cp.send({ type: "stop_session_result", sessionId: STUCK, operationId: stop.operationId, deliveryAttemptId: stop.deliveryAttemptId, accepted: true });
  for (let waited = 0; campaign(cp.database, STUCK).status !== "stopped"; waited += 25) {
    assert.ok(waited < 10_000, "the stop settles");
    await delay(25);
  }

  const restarted = await cp.human(`/api/sessions/${STUCK}/restart`, {});
  assert.ok(restarted.status < 300, `${restarted.status} ${await restarted.text()}\n${cp.logs()}`);
  const restored = campaign(cp.database, STUCK);
  const boundary = (restored.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary;
  assert.equal(boundary.revision, 3);
  assert.equal(boundary.issueScopeRevision, 3);
  assert.equal(boundary.authorizedAt, APPROVED_AT, "authorized at the Human's approval");
  assert.deepEqual(boundary.issueAuthority, { epics: [3522, 3617], relatedFollowUps: true, maxIssues: 4, closureReasons: ["completed"] });
  assert.equal(restored.parentControlPolicy!.revision, 3);
  assert.deepEqual(restored.orchestratorPolicy!.issueNumbers, [3522, 3617, 3773, 3774]);
  assert.equal(campaignBoundaryCurrent(restored), true);
  await cp.next((message) => message.type === "start_session" && JSON.stringify(message).includes(STUCK), "the restart's launch");

  const prompted = await cp.human(`/api/sessions/${STUCK}/prompt`, { text: "Continue with #3773 and #3774" });
  assert.ok(prompted.status < 300, `${prompted.status} ${await prompted.text()}\n${cp.logs()}`);
  assert.equal((campaign(cp.database, STUCK).orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary.revision, 3,
    "idempotent: the restored boundary is left alone");
});

test("a stale boundary no approval explains refuses the owner's message and restart with the recovery, through the real routes", { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const expected = "This Full Control campaign's authority no longer matches its issue scope or policy, so it can't continue. " +
    "Revoke Full Control in Orchestrator Controls, then Enable Full Control to authorize the campaign's current issue scope.";
  for (const [path, body] of [[`/api/sessions/${UNEXPLAINED}/prompt`, { text: "Continue" }], [`/api/sessions/${UNEXPLAINED}/restart`, {}]] as const) {
    const response = await cp.human(path, body);
    assert.equal(response.status, 409, path);
    assert.deepEqual(await response.json(), { code: "campaign_authority_stale", error: expected }, path);
  }
  const unchanged = campaign(cp.database, UNEXPLAINED);
  assert.equal((unchanged.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary.revision, 2, "never enlarged");
  assert.equal(campaignBoundaryCurrent(unchanged), false);
});

function budgetState(database: string, id: string) {
  const db = ControlPlaneDb.open(database);
  try { return db.campaignBudgets.view(id)?.state; } finally { db.close(); }
}

/** The runner acknowledges the stop the control plane sent, as a provider that exited would. */
async function acknowledgeStop(cp: Awaited<ReturnType<typeof startControlPlane>>, id: string) {
  const stop = await cp.next((message) => message.type === "stop_session" && message.sessionId === id, `${id}'s stop`);
  cp.send({ type: "stop_session_result", sessionId: id, operationId: stop.operationId, deliveryAttemptId: stop.deliveryAttemptId, accepted: true });
  for (let waited = 0; campaign(cp.database, id).status !== "stopped"; waited += 25) {
    assert.ok(waited < 10_000, `${id}'s stop settles`);
    await delay(25);
  }
}

async function ok(response: Response, what: string, logs: () => string) {
  const text = await response.text();
  assert.ok(response.status < 300, `${what}: ${response.status} ${text}\n${logs()}`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

test("a human scope change, then Revoke Full Control, leaves the campaign restartable and promptable under Custom, through the real routes", { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t);
  assert.equal(campaignBoundaryCurrent(campaign(cp.database, HEALTHY)), true);

  // The owner adds an issue in Campaign Status and approves it on the campaign's card.
  const proposal = await ok(await cp.human(`/api/sessions/${HEALTHY}/campaign/issue-scope/proposals`, { requestId: "owner-adds-3773",
    expectedRevision: 2, additions: [{ repository: REPOSITORY, number: 3773 }], removals: [], explanation: "The owner adds this work" }), "proposal", cp.logs);
  assert.equal(proposal.authority, "human");
  const card = pendingRequests(campaign(cp.database, HEALTHY).pendingApproval).find((request) => request.occurrenceId === proposal.occurrenceId);
  assert.ok(card, "the approval card");
  await ok(await cp.human(`/api/sessions/${HEALTHY}/approve`, { requestId: card.requestId, optionId: "approve" }), "approval", cp.logs);
  const approved = campaign(cp.database, HEALTHY);
  assert.deepEqual(approved.orchestratorPolicy!.issueNumbers, [3522, 3617, 3773]);
  assert.equal((approved.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary.issueScopeRevision, 3);
  assert.equal(campaignBoundaryCurrent(approved), true, "the approval re-minted the boundary");
  await ok(await cp.human(`/api/sessions/${HEALTHY}/prompt`, { text: "Continue with #3773" }), "prompt under Full Control", cp.logs);

  // Revoke Full Control: the campaign keeps running under Custom, and the allowance is revoked.
  const stopsBefore = cp.messages.filter((message) => message.type === "stop_session" && message.sessionId === HEALTHY).length;
  await ok(await cp.human(`/api/sessions/${HEALTHY}/orchestrator-campaign/control`, { proposal: { mode: "custom" },
    expectedRevision: approved.parentControlPolicy!.revision }), "revoke", cp.logs);
  const revoked = campaign(cp.database, HEALTHY);
  assert.deepEqual(revoked.orchestratorPolicy!.control, { mode: "custom" });
  assert.equal(budgetState(cp.database, HEALTHY), "revoked");
  assert.notEqual(revoked.status, "stopped", "revoking does not stop the campaign");
  await delay(200);
  assert.equal(cp.messages.filter((message) => message.type === "stop_session" && message.sessionId === HEALTHY).length, stopsBefore);
  await ok(await cp.human(`/api/sessions/${HEALTHY}/prompt`, { text: "Carry on under Custom" }), "prompt under Custom", cp.logs);

  // A root already stopped in this state, as the live one was, restarts and takes messages.
  await ok(await cp.human(`/api/sessions/${HEALTHY}/stop`, {}), "stop", cp.logs);
  await acknowledgeStop(cp, HEALTHY);
  await ok(await cp.human(`/api/sessions/${HEALTHY}/restart`, {}), "restart under Custom", cp.logs);
  await cp.next((message) => message.type === "start_session" && JSON.stringify(message).includes(HEALTHY), "the restart's launch");
  await ok(await cp.human(`/api/sessions/${HEALTHY}/prompt`, { text: "Resume" }), "prompt after restart", cp.logs);
});

test("Revoke Full Control, then Enable Full Control again, through the real routes, including from a stopped root", { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const revision = campaign(cp.database, HEALTHY).parentControlPolicy!.revision;
  await ok(await cp.human(`/api/sessions/${HEALTHY}/orchestrator-campaign/control`, { proposal: { mode: "custom" }, expectedRevision: revision }), "revoke", cp.logs);
  assert.equal(budgetState(cp.database, HEALTHY), "revoked");

  // A stopped root says how to get back, and restarting under Custom works.
  await ok(await cp.human(`/api/sessions/${HEALTHY}/stop`, {}), "stop", cp.logs);
  await acknowledgeStop(cp, HEALTHY);
  const refused = await cp.human(`/api/sessions/${HEALTHY}/orchestrator-campaign/full-control/preflight`, {});
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "This campaign isn't running. Restart it, then enable Full Control." });
  await ok(await cp.human(`/api/sessions/${HEALTHY}/restart`, {}), "restart under Custom", cp.logs);

  // Enable Full Control as Orchestrator Controls does: preflight, then the exact reviewed digest.
  const preflight = await ok(await cp.human(`/api/sessions/${HEALTHY}/orchestrator-campaign/full-control/preflight`, {}), "preflight", cp.logs) as
    { preflight: { digest: string; ready: boolean; summary: { blockers: Array<{ reason: string }> } }; expectedRevision: number };
  assert.ok(preflight.preflight.ready, JSON.stringify(preflight.preflight.summary.blockers));
  await ok(await cp.human(`/api/sessions/${HEALTHY}/orchestrator-campaign/full-control`, { expectedRevision: preflight.expectedRevision,
    preflightDigest: preflight.preflight.digest }), "enable", cp.logs);
  const enabled = campaign(cp.database, HEALTHY);
  assert.equal(enabled.orchestratorPolicy!.control!.mode, "full_control");
  assert.equal(campaignBoundaryCurrent(enabled), true);
  assert.equal(budgetState(cp.database, HEALTHY), "active", "the Human's new authorization resumes the allowance it revoked");
  await ok(await cp.human(`/api/sessions/${HEALTHY}/prompt`, { text: "Continue under Full Control" }), "prompt after enabling", cp.logs);
});
