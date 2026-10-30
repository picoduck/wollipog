/** #2940, owner direction 2026-10-30: a Full Control campaign's accepted follow-up allowance is an
 * approval threshold, not a hard cap. Past it, a follow-up is a typed Human decision; the person
 * changes the limit on the live campaign. This drives the real control plane process and HTTP
 * routes, with a synthetic runner, an Orchestrator session credential and the owner's device. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER, pendingRequests,
  type CampaignControl, type RunnerMetadata, type SessionView, type WorkflowDecisionView } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { ControlPlaneDb } from "./db.js";
import { normalizeWorkflowDecisionSnapshot } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-follow-up-limit";
const WORKSPACE_ID = "workspace-follow-up-limit";
const RUNNER_TOKEN = `wollipogr_${"f".repeat(43)}`;
const DEVICE_TOKEN = "device-follow-up-limit";
const AGENT_TOKEN = "agent_follow_up_limit_orchestrator_token";
const REPOSITORY = "picoduck/wollipog";
const ROOT = "campaign-follow-up-limit";
const AUTHORIZED_AT = 1_793_108_688_979;

function runnerMetadata(): RunnerMetadata {
  return { runnerId: RUNNER_ID, hostname: "follow-up-limit-host", os: "linux", version: "integration",
    workspaces: [{ id: WORKSPACE_ID, name: "Wollipog", path: "/workspace" }],
    agents: [{ id: "claude-agent", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true }] };
}

/** A current, running Full Control campaign whose Human allows one follow-up without approval. */
function seed(database: string): void {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    const identity = db.localIdentityContext();
    db.registerRunner(runnerMetadata(), now, PROTOCOL_VERSION);
    db.issueRunnerCredential({ credentialId: `rcred_${"followuplimit".padEnd(32, "0")}`, runnerId: RUNNER_ID, organizationId: identity.organizationId,
      ownerKind: "organization", ownerId: identity.organizationId, label: "Follow-up limit route fixture",
      tokenHash: hashToken(RUNNER_TOKEN), createdByUserId: identity.userId, now, expiresAt: now + 120_000 });
    db.createDevice({ id: "device-follow-up-limit", name: "Owner Browser", tokenHash: hashToken(DEVICE_TOKEN), userId: identity.userId,
      organizationId: identity.organizationId, now });
    const budgetAuthority = { version: 1 as const, concurrency: 3, acceptedFollowUps: 1, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    const control: CampaignControl = { mode: "full_control", boundary: { version: 1, revision: 2, issueScopeRevision: 2, repository: REPOSITORY,
      objective: "Finish #3522 and #3617", authorizedByUserId: identity.userId, authorizedAt: AUTHORIZED_AT,
      operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval",
        "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"], delegatablePolicyIds: [],
      issueAuthority: { epics: [3522, 3617], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed"] }, budgetAuthority } };
    const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policy.issueScope = { repository: REPOSITORY, issueNumbers: [3522, 3617], revision: 2, authorizedByUserId: identity.userId, authorizedAt: AUTHORIZED_AT };
    policy.issueNumbers = [3522, 3617];
    policy.control = control;
    db.createSession({ id: ROOT, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "claude-agent", title: ROOT, useWorktree: false,
      driver: "claude-code", config: { permissionMode: "orchestrator" }, role: "orchestrator", orchestratorPolicy: policy, creationActor: "human",
      parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } }, now });
    db.raw().prepare("UPDATE sessions SET parent_control_policy_revision=2 WHERE id=?").run(ROOT);
    db.campaignBudgets.authorize(ROOT, budgetAuthority);
    db.updateSessionStatus(ROOT, "running", now + 1);
    assert.equal(db.setAgentControlCredential(ROOT, RUNNER_ID, hashToken(AGENT_TOKEN), now + 2), true);
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
  const temp = mkdtempSync(join(tmpdir(), "wollipog-follow-up-limit-"));
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
  const call = (token: string, agent: boolean) => async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(agent ? { [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: ROOT } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* Not every refusal has a body. */ }
    return { status: response.status, json, text };
  };
  return { database, human: call(DEVICE_TOKEN, false), orchestrator: call(AGENT_TOKEN, true), logs: () => logs };
}

function read<T>(database: string, work: (db: ControlPlaneDb) => T): T {
  const db = ControlPlaneDb.open(database);
  try { return work(db); } finally { db.close(); }
}

function boundaryOf(session: SessionView) {
  return (session.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary;
}

/** The Orchestrator plans one follow-up work item, as record_campaign_plan does. */
function planFollowUp(cp: Awaited<ReturnType<typeof startControlPlane>>, key: string, title = `Follow-up ${key}`,
  issue?: { repository: string; number: number } | null) {
  return cp.orchestrator(`/api/sessions/${ROOT}/orchestrator-campaign/plan`,
    { items: [{ key, title, origin: "follow_up", ...(issue === undefined ? {} : { issue }) }], planComplete: false });
}

/** The occurrence a refusal names. */
function occurrence(error: string): string {
  const match = /decision (workflow_[a-f0-9]+)/u.exec(error);
  assert.ok(match, `the refusal names its decision: ${error}`);
  return match[1]!;
}

function decision(database: string, occurrenceId: string): WorkflowDecisionView {
  return read(database, (db) => db.workflowDecisionByOccurrence(occurrenceId)!);
}

/** A follow-up admission's snapshot without its identity digest, which must be a SHA-256. */
function admissionFacts(snapshot: WorkflowDecisionView["resourceSnapshot"]) {
  assert.equal(snapshot.category, "campaign_follow_up_admission");
  const { identityDigest, ...facts } = snapshot as Extract<typeof snapshot, { category: "campaign_follow_up_admission" }>;
  assert.match(identityDigest, /^[a-f0-9]{64}$/u);
  return facts;
}

test("past the threshold a follow-up is a Human decision the Orchestrator cannot approve; approval admits it once, denial refuses it by name",
  { timeout: 90_000 }, async (t) => {
    const cp = await startControlPlane(t);
    const below = await planFollowUp(cp, "follow-up-1");
    assert.equal(below.status, 200, `below the threshold it is accepted automatically: ${below.text}\n${cp.logs()}`);

    const over = await planFollowUp(cp, "follow-up-2");
    assert.equal(over.status, 409, over.text);
    assert.match(String(over.json.error), /past the campaign's limit of 1 follow-up without approval \(1 accepted\), so it needs the person's approval/);
    const first = occurrence(String(over.json.error));
    const pending = decision(cp.database, first);
    assert.equal(pending.category, "campaign_follow_up_admission");
    assert.equal(pending.authority, "human", "the Human owns it under Full Control");
    assert.equal(pending.status, "pending");
    assert.deepEqual(admissionFacts(pending.resourceSnapshot), { category: "campaign_follow_up_admission", subject: { kind: "work_item", key: "follow-up-2" },
      title: "Follow-up follow-up-2", issue: null, acceptedFollowUps: 1, limit: 1 });
    const root = read(cp.database, (db) => db.getSession(ROOT)!);
    assert.ok(pendingRequests(root.pendingApproval).some((request) => request.occurrenceId === first), "it is a Pending Decision card on the root");
    assert.deepEqual(root.orchestratorCampaign?.budget?.followUpApprovals, { pending: [{ occurrenceId: first, title: "Follow-up follow-up-2" }], approved: 0 });

    const again = await planFollowUp(cp, "follow-up-2");
    assert.equal(again.status, 409);
    assert.match(String(again.json.error), new RegExp(`waiting for the person's decision ${first}`), "no second decision while one is pending");

    // The Orchestrator cannot approve it: not as a parent resolving a gate, not as a person, not by consuming it.
    const asGate = await cp.orchestrator(`/api/sessions/${ROOT}/descendant-requests/resolve`,
      { sessionId: ROOT, occurrenceId: first, resolution: { action: "resolve_workflow_decision", outcome: "approve" } });
    assert.ok(asGate.status >= 400 && asGate.status < 500, `${asGate.status} ${asGate.text}`);
    const asPerson = await cp.orchestrator(`/api/sessions/${ROOT}/approve`, { requestId: first, optionId: "approve" });
    assert.ok(asPerson.status >= 400 && asPerson.status < 500, `${asPerson.status} ${asPerson.text}`);
    const consumed = await cp.orchestrator(`/api/sessions/${ROOT}/workflow-decisions/${first}/consume`, { resourceSnapshot: pending.resourceSnapshot });
    assert.ok(consumed.status >= 400 && consumed.status < 500, `${consumed.status} ${consumed.text}`);
    assert.equal(decision(cp.database, first).status, "pending", "the Orchestrator changed nothing");

    const approved = await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: first, optionId: "approve" });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(decision(cp.database, first).status, "approved");
    // The key is the Orchestrator's own: the approval binds the title the person saw too.
    const swapped = await planFollowUp(cp, "follow-up-2", "Something the person never saw");
    assert.equal(swapped.status, 409, swapped.text);
    const swappedOccurrence = occurrence(String(swapped.json.error));
    assert.notEqual(swappedOccurrence, first, "another title is another decision");
    assert.equal(decision(cp.database, first).status, "superseded", "the approval of the original title was not used for it");
    assert.equal(read(cp.database, (db) => db.campaignBudgets.view(ROOT)!.acceptedFollowUps), 1);
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: swappedOccurrence, optionId: "deny" })).status, 200);
    const reRequested = await planFollowUp(cp, "follow-up-2");
    assert.equal(reRequested.status, 409);
    const original = occurrence(String(reRequested.json.error));
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: original, optionId: "approve" })).status, 200);
    const admitted = await planFollowUp(cp, "follow-up-2");
    assert.equal(admitted.status, 200, `approval admits exactly that follow-up: ${admitted.text}`);
    assert.equal(decision(cp.database, original).status, "consumed", "consumed by the admission itself");
    assert.equal(read(cp.database, (db) => db.campaignBudgets.view(ROOT)!.acceptedFollowUps), 2);

    const next = await planFollowUp(cp, "follow-up-3");
    assert.equal(next.status, 409, "the approval admitted only that one");
    const second = occurrence(String(next.json.error));
    assert.notEqual(second, original);
    const denied = await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: second, optionId: "deny" });
    assert.equal(denied.status, 200, denied.text);
    const refused = await planFollowUp(cp, "follow-up-3");
    assert.equal(refused.status, 409);
    assert.match(String(refused.json.error), new RegExp(`the person denied it \\(decision ${second}\\)\\. Do not accept it again`));
    assert.equal(read(cp.database, (db) => db.campaignBudgets.view(ROOT)!.acceptedFollowUps), 2, "a denial admits nothing");
    const view = read(cp.database, (db) => db.getSession(ROOT)!.orchestratorCampaign?.budget?.followUpApprovals);
    assert.deepEqual(view, { pending: [], approved: 1 });
  });

test("the person raises, clears and lowers the limit on the live campaign; the boundary stays current and the next follow-up follows it",
  { timeout: 90_000 }, async (t) => {
    const cp = await startControlPlane(t);
    assert.equal((await planFollowUp(cp, "follow-up-1")).status, 200);
    const over = await planFollowUp(cp, "follow-up-2");
    assert.equal(over.status, 409);
    const pendingBefore = occurrence(String(over.json.error));

    // Only a person, through the human route, with the current revision.
    const byAgent = await cp.orchestrator(`/api/sessions/${ROOT}/orchestrator-campaign/follow-up-limit`, { acceptedFollowUps: 10, expectedRevision: 2 });
    // No agent allowlist entry: the Orchestrator's credential is not a person's.
    assert.ok(byAgent.status === 401 || byAgent.status === 403, `${byAgent.status} ${byAgent.text}`);
    const stale = await cp.human(`/api/sessions/${ROOT}/orchestrator-campaign/follow-up-limit`, { acceptedFollowUps: 3, expectedRevision: 1 });
    assert.equal(stale.status, 409, stale.text);
    const invalid = await cp.human(`/api/sessions/${ROOT}/orchestrator-campaign/follow-up-limit`, { acceptedFollowUps: -1, expectedRevision: 2 });
    assert.equal(invalid.status, 400, invalid.text);
    assert.equal(read(cp.database, (db) => db.parentControlPolicy(ROOT)!.revision), 2, "refusals change nothing");

    const raised = await cp.human(`/api/sessions/${ROOT}/orchestrator-campaign/follow-up-limit`, { acceptedFollowUps: 3, expectedRevision: 2 });
    assert.equal(raised.status, 200, `${raised.text}\n${cp.logs()}`);
    let root = read(cp.database, (db) => db.getSession(ROOT)!);
    let boundary = boundaryOf(root);
    assert.equal(boundary.revision, 3, "re-minted, compare-and-set on the revision");
    assert.equal(root.parentControlPolicy!.revision, 3);
    assert.equal(boundary.budgetAuthority!.acceptedFollowUps, 3);
    assert.equal(boundary.issueAuthority!.maxIssues, 5, "Maximum Issues grows with the follow-ups it admits");
    assert.equal(campaignBoundaryCurrent(root), true, "the boundary stays current");
    assert.equal(read(cp.database, (db) => db.campaignBudgets.view(ROOT)!.authority.acceptedFollowUps), 3, "the allowance enforces the new limit");
    assert.equal(decision(cp.database, pendingBefore).status, "revoked", "like any boundary change, undecided requests are withdrawn");
    assert.equal(root.orchestratorCampaign?.budget?.authority.acceptedFollowUps, 3);

    // A person's message still reaches the campaign: no stale-boundary lockout (#3778).
    const prompted = await cp.human(`/api/sessions/${ROOT}/prompt`, { text: "Continue with the follow-ups" });
    assert.ok(prompted.status < 300, `${prompted.status} ${prompted.text}\n${cp.logs()}`);

    assert.equal((await planFollowUp(cp, "follow-up-2")).status, 200, "raised live: the next one is automatic");
    assert.equal((await planFollowUp(cp, "follow-up-3")).status, 200);
    assert.equal((await planFollowUp(cp, "follow-up-4")).status, 409, "the new limit is a threshold too");

    const cleared = await cp.human(`/api/sessions/${ROOT}/orchestrator-campaign/follow-up-limit`, { acceptedFollowUps: null, expectedRevision: 3 });
    assert.equal(cleared.status, 200, cleared.text);
    root = read(cp.database, (db) => db.getSession(ROOT)!);
    boundary = boundaryOf(root);
    assert.equal(boundary.budgetAuthority!.acceptedFollowUps, undefined, "no limit");
    assert.equal(boundary.issueAuthority!.maxIssues, 100);
    assert.equal(campaignBoundaryCurrent(root), true);
    assert.equal((await planFollowUp(cp, "follow-up-4")).status, 200, "no limit: every follow-up is automatic");

    const lowered = await cp.human(`/api/sessions/${ROOT}/orchestrator-campaign/follow-up-limit`, { acceptedFollowUps: 1, expectedRevision: 4 });
    assert.equal(lowered.status, 200, lowered.text);
    root = read(cp.database, (db) => db.getSession(ROOT)!);
    assert.equal(campaignBoundaryCurrent(root), true);
    assert.equal(boundaryOf(root).issueAuthority!.maxIssues, 100, "lowering never shrinks Maximum Issues");
    const budget = read(cp.database, (db) => db.campaignBudgets.view(ROOT)!);
    assert.equal(budget.acceptedFollowUps, 4, "lowering below the count revokes nothing already accepted");
    assert.equal(budget.state, "active");
    const afterLowering = await planFollowUp(cp, "follow-up-5");
    assert.equal(afterLowering.status, 409, "only the next follow-up needs approval");
    assert.match(String(afterLowering.json.error), /limit of 1 follow-up without approval \(4 accepted\)/);
    assert.equal((await planFollowUp(cp, "follow-up-4")).status, 200, "an accepted follow-up is never re-counted");
  });

test("accepting a recommendation past the threshold asks the person about that recommendation, and its approval adds one issue slot",
  { timeout: 90_000 }, async (t) => {
    const cp = await startControlPlane(t);
    assert.equal((await planFollowUp(cp, "follow-up-1")).status, 200);
    const recommendation = read(cp.database, (db) => db.recordCampaignFollowUp({ campaignSessionId: ROOT, originSessionId: ROOT,
      repository: REPOSITORY, title: "Retry the merge group on a red main", followUpsMode: "execute_approved", now: Date.now() }));
    const adjudicate = () => cp.orchestrator(`/api/sessions/${ROOT}/orchestrator-campaign/recommendations/${recommendation.id}/adjudicate`,
      { disposition: "accepted", reason: "It blocks the campaign's merges.", publicationRequired: false });

    const over = await adjudicate();
    assert.equal(over.status, 409, over.text);
    const requested = occurrence(String(over.json.error));
    const pending = decision(cp.database, requested);
    assert.deepEqual(admissionFacts(pending.resourceSnapshot), { category: "campaign_follow_up_admission",
      subject: { kind: "recommendation", recommendationId: recommendation.id }, title: "Retry the merge group on a red main", issue: null,
      recommendationTitle: "Retry the merge group on a red main", acceptedFollowUps: 1, limit: 1 });
    assert.equal(read(cp.database, (db) => db.campaignIssueLimit(ROOT, 3)), 3, "no slot before the person approves");

    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: requested, optionId: "approve" })).status, 200);
    const admitted = await adjudicate();
    assert.equal(admitted.status, 200, admitted.text);
    assert.equal((admitted.json.recommendation as { disposition: string }).disposition, "accepted");
    assert.equal(decision(cp.database, requested).status, "consumed");
    assert.equal(read(cp.database, (db) => db.campaignIssueLimit(ROOT, 3)), 4,
      "the admitted follow-up's issue is not refused by a Maximum Issues derived from the follow-ups it exceeded");
  });

test("a follow-up admitted past the threshold stays bound to the title and issue the person approved; changing either is a new decision",
  { timeout: 90_000 }, async (t) => {
    const cp = await startControlPlane(t);
    const below = await planFollowUp(cp, "follow-up-1");
    assert.equal(below.status, 200);
    // A follow-up accepted under the limit was never bound: the Orchestrator retitles it freely.
    assert.equal((await planFollowUp(cp, "follow-up-1", "A Better Title")).status, 200);

    const ISSUE = { repository: REPOSITORY, number: 3770 };
    const over = await planFollowUp(cp, "follow-up-2", "Fix the merge queue", ISSUE);
    assert.equal(over.status, 409, over.text);
    const first = occurrence(String(over.json.error));
    assert.deepEqual(admissionFacts(decision(cp.database, first).resourceSnapshot).issue, ISSUE, "the decision binds the issue");
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: first, optionId: "approve" })).status, 200);
    const otherIssue = await planFollowUp(cp, "follow-up-2", "Fix the merge queue", { repository: REPOSITORY, number: 9999 });
    assert.equal(otherIssue.status, 409, "the approval admits only the approved issue");
    assert.equal(decision(cp.database, first).status, "superseded");
    const reRequested = occurrence(String((await planFollowUp(cp, "follow-up-2", "Fix the merge queue", ISSUE)).json.error));
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: reRequested, optionId: "approve" })).status, 200);
    const admitted = await planFollowUp(cp, "follow-up-2", "Fix the merge queue", ISSUE);
    assert.equal(admitted.status, 200, admitted.text);
    const itemId = (admitted.json.items as Array<{ workItemId: string }>)[0]!.workItemId;
    assert.equal((await planFollowUp(cp, "follow-up-2", "Fix the merge queue", ISSUE)).status, 200, "the same content changes nothing");

    // The approval binds the complete title, not the 200 characters shown (CR-1.2).
    const prefix = "Keep the merge queue moving ".repeat(8).slice(0, 200);
    const longOver = await planFollowUp(cp, "follow-up-long", `${prefix} when main is red`);
    assert.equal(longOver.status, 409);
    const longApproval = occurrence(String(longOver.json.error));
    assert.equal(admissionFacts(decision(cp.database, longApproval).resourceSnapshot).title, prefix, "the display title is bounded");
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: longApproval, optionId: "approve" })).status, 200);
    const sameShown = await planFollowUp(cp, "follow-up-long", `${prefix} and delete every branch`);
    assert.equal(sameShown.status, 409, "the same 200 characters with another ending is another follow-up");
    assert.notEqual(occurrence(String(sameShown.json.error)), longApproval);

    // Retitling it through the plan is a decision of its own, which revises the approval.
    const retitled = await planFollowUp(cp, "follow-up-2", "Something the person never approved", ISSUE);
    assert.equal(retitled.status, 409, retitled.text);
    assert.match(String(retitled.json.error), /admitted past the campaign's follow-up limit, so changing its title or issue needs the person's approval/);
    const change = occurrence(String(retitled.json.error));
    const changeSnapshot = admissionFacts(decision(cp.database, change).resourceSnapshot);
    assert.deepEqual(changeSnapshot, { category: "campaign_follow_up_admission", subject: { kind: "work_item", key: "follow-up-2" },
      title: "Something the person never approved", issue: ISSUE, acceptedFollowUps: 2, limit: 1, revises: reRequested });
    const item = () => read(cp.database, (db) => db.campaignWorkLedger.detail(ROOT, itemId, Date.now())!);
    assert.equal(item().title, "Fix the merge queue", "nothing changed while it waits");

    // Changing its issue through the work item route is held the same way.
    const moved = await cp.orchestrator(`/api/sessions/${ROOT}/orchestrator-campaign/work-items/${itemId}`, { issue: null });
    assert.equal(moved.status, 409, moved.text);
    assert.deepEqual(item().issue, ISSUE);

    // Denied: the follow-up keeps what the person approved.
    const removal = occurrence(String(moved.json.error));
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: removal, optionId: "deny" })).status, 200);
    const refused = await cp.orchestrator(`/api/sessions/${ROOT}/orchestrator-campaign/work-items/${itemId}`, { issue: null });
    assert.equal(refused.status, 409);
    assert.match(String(refused.json.error), new RegExp(`the person denied it \\(decision ${removal}\\)\\. Do not make the change again; keep the follow-up as approved\\.`));

    // Approved: the change applies once, and the follow-up is bound to it from then on.
    const retitle = occurrence(String((await planFollowUp(cp, "follow-up-2", "Fix the Merge Queue Retry", ISSUE)).json.error));
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: retitle, optionId: "approve" })).status, 200);
    const applied = await planFollowUp(cp, "follow-up-2", "Fix the Merge Queue Retry", ISSUE);
    assert.equal(applied.status, 200, applied.text);
    assert.equal(decision(cp.database, retitle).status, "consumed");
    assert.equal(item().title, "Fix the Merge Queue Retry");
    assert.equal(read(cp.database, (db) => db.campaignBudgets.view(ROOT)!.acceptedFollowUps), 2, "a change is not another follow-up");
    assert.equal(read(cp.database, (db) => db.campaignIssueLimit(ROOT, 3)), 4, "nor another issue slot");
    assert.equal((await planFollowUp(cp, "follow-up-2", "Fix the merge queue", ISSUE)).status, 409, "changing it back needs approval too");
  });

test("another recommendation accepted into a follow-up admitted past the threshold needs its own approval (CR-1.1)",
  { timeout: 90_000 }, async (t) => {
    const cp = await startControlPlane(t);
    assert.equal((await planFollowUp(cp, "follow-up-1")).status, 200);
    const record = (title: string) => read(cp.database, (db) => db.recordCampaignFollowUp({ campaignSessionId: ROOT, originSessionId: ROOT,
      repository: REPOSITORY, title, followUpsMode: "execute_approved", now: Date.now() }));
    const adjudicate = (id: string, body: Record<string, unknown> = {}) =>
      cp.orchestrator(`/api/sessions/${ROOT}/orchestrator-campaign/recommendations/${id}/adjudicate`,
        { disposition: "accepted", reason: "It blocks the campaign's merges.", publicationRequired: false, ...body });
    const a = record("Retry the merge group on a red main");
    const b = record("Delete every stale branch");

    const admitA = occurrence(String((await adjudicate(a.id, { resultingWorkItemKey: "follow-up-a" })).json.error));
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: admitA, optionId: "approve" })).status, 200);
    assert.equal((await adjudicate(a.id, { resultingWorkItemKey: "follow-up-a" })).status, 200);
    const denyB = occurrence(String((await adjudicate(b.id)).json.error));
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: denyB, optionId: "deny" })).status, 200);

    // B, denied, cannot ride into A's admitted item, with or without an issue.
    const riding = await adjudicate(b.id, { resultingWorkItemKey: "follow-up-a", resultingIssue: { repository: REPOSITORY, number: 4242 } });
    assert.equal(riding.status, 409, riding.text);
    assert.match(String(riding.json.error),
      /Accepting recommendation "Delete every stale branch" into a follow-up admitted past the campaign's follow-up limit as "Retry the merge group on a red main" needs the person's approval/);
    const riderDecision = admissionFacts(decision(cp.database, occurrence(String(riding.json.error))).resourceSnapshot);
    assert.deepEqual(riderDecision.subject, { kind: "recommendation", recommendationId: b.id });
    assert.equal(riderDecision.revises, admitA);
    assert.deepEqual(riderDecision.issue, { repository: REPOSITORY, number: 4242 });
    const item = read(cp.database, (db) => db.campaignWorkLedger.page(ROOT, { origin: "follow_up", state: "all", sort: "queue", limit: 50 } as never,
      Date.now()));
    assert.ok(item.ok);
    const a1 = item.data!.items.find((row) => row.key === "follow-up-a")!;
    assert.equal(a1.issue, null, "nothing changed while it waits");
    assert.equal(read(cp.database, (db) => db.campaignWorkLedger.recommendation(ROOT, b.id)!.disposition), "awaiting_adjudication");
    // A itself is still accepted into its own item without asking again.
    assert.equal((await adjudicate(a.id, { resultingWorkItemKey: "follow-up-a" })).status, 200);

    // B into A with no issue change (CR-2.1): the decision names B and says it replaces A.
    const rebinding = await adjudicate(b.id, { resultingWorkItemKey: "follow-up-a" });
    assert.equal(rebinding.status, 409, rebinding.text);
    assert.match(String(rebinding.json.error), /Accepting recommendation "Delete every stale branch" into a follow-up admitted past the campaign's follow-up limit as "Retry the merge group on a red main"/);
    const rebind = occurrence(String(rebinding.json.error));
    assert.deepEqual(admissionFacts(decision(cp.database, rebind).resourceSnapshot), { category: "campaign_follow_up_admission",
      subject: { kind: "recommendation", recommendationId: b.id }, title: "Retry the merge group on a red main", issue: null,
      recommendationTitle: "Delete every stale branch", acceptedFollowUps: 2, limit: 1, revises: admitA, rebinds: true });
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: rebind, optionId: "approve" })).status, 200);
    const accepted = await adjudicate(b.id, { resultingWorkItemKey: "follow-up-a" });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(decision(cp.database, rebind).status, "consumed");
    assert.equal(read(cp.database, (db) => db.campaignWorkLedger.recommendation(ROOT, b.id)!.disposition), "accepted");
    assert.equal(read(cp.database, (db) => db.campaignBudgets.view(ROOT)!.acceptedFollowUps), 2, "a rebinding is not another follow-up");
  });

test("a follow-up admission names an issue in any repository the work ledger accepts, GitLab projects included (CR-4.1)", () => {
  const snapshot = (repository: string) => ({ category: "campaign_follow_up_admission", subject: { kind: "work_item", key: "follow-up-gitlab" },
    title: "Fix the runner", issue: { repository, number: 7 }, identityDigest: "a".repeat(64), acceptedFollowUps: 1, limit: 1 });
  for (const repository of ["gitlab.com/team/project", "gitlab.example.com:8443/group/subgroup/project", "picoduck/wollipog"]) {
    const normalized = normalizeWorkflowDecisionSnapshot(snapshot(repository));
    assert.ok(normalized.ok, `${repository}: ${normalized.error}`);
    assert.deepEqual(normalized.data!.category === "campaign_follow_up_admission" && normalized.data!.issue, { repository, number: 7 });
  }
  for (const repository of ["github.com/picoduck/wollipog", "not a repository", "wollipog"]) {
    assert.equal(normalizeWorkflowDecisionSnapshot(snapshot(repository)).ok, false, `${repository} is not a ledger repository`);
  }
});

test("an over-threshold follow-up tracking a GitLab issue is asked about, approved and admitted through the real routes (CR-4.1)",
  { timeout: 90_000 }, async (t) => {
    const cp = await startControlPlane(t);
    assert.equal((await planFollowUp(cp, "follow-up-1")).status, 200);
    const GITLAB = { repository: "gitlab.com/team/project", number: 7 };
    const over = await planFollowUp(cp, "follow-up-gitlab", "Fix the GitLab runner", GITLAB);
    assert.equal(over.status, 409, over.text);
    assert.match(String(over.json.error), /so it needs the person's approval\. Requested decision/);
    const requested = occurrence(String(over.json.error));
    assert.deepEqual(admissionFacts(decision(cp.database, requested).resourceSnapshot).issue, GITLAB);
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: requested, optionId: "approve" })).status, 200);
    const admitted = await planFollowUp(cp, "follow-up-gitlab", "Fix the GitLab runner", GITLAB);
    assert.equal(admitted.status, 200, admitted.text);
    assert.equal(decision(cp.database, requested).status, "consumed");
    // A later change naming another GitLab issue is a decision of its own, which the person can approve.
    const moved = await planFollowUp(cp, "follow-up-gitlab", "Fix the GitLab runner", { repository: "gitlab.com/team/project", number: 8 });
    assert.equal(moved.status, 409, moved.text);
    const change = occurrence(String(moved.json.error));
    assert.deepEqual(admissionFacts(decision(cp.database, change).resourceSnapshot).issue, { repository: "gitlab.com/team/project", number: 8 });
    assert.equal((await cp.human(`/api/sessions/${ROOT}/approve`, { requestId: change, optionId: "approve" })).status, 200);
    assert.equal((await planFollowUp(cp, "follow-up-gitlab", "Fix the GitLab runner", { repository: "gitlab.com/team/project", number: 8 })).status, 200);
  });
