import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { compatibleCampaignStatus } from "./campaign-status-compatibility.js";
import { SessionPromptOutbox } from "./session-prompt-outbox.js";

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const owner = { ...identity, kind: "human" as const, actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "agent", name: "Agent",
      command: "claude", args: [], env: {}, driver: "claude-code", available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "agent", title: id,
      useWorktree: false, driver: "claude-code", config: { model: "opus", ...(id === "root" ? { permissionMode: "orchestrator" as const } : {}) }, now: Date.now(),
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default") }
        : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", Date.now());
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = () => true;
  hub.sessionChangedById = () => {};
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  return { db, svc, owner, hub };
}

test("pause is owner-only, holds continuations and admission, and preserves running turns until safe", () => {
  const { db, svc, owner } = fixture();
  try {
    assert.equal(svc.setCampaignPause("root", { action: "pause" }, { ...owner, userId: "someone-else" }).ok, false);
    assert.ok(svc.setCampaignPause("root", { action: "pause" }, owner).ok);
    assert.equal(svc.setCampaignPause("root", { action: "resume" }, { ...owner, userId: "someone-else" }).ok, false);
    assert.equal(db.campaignPaused("root"), true);
    assert.equal(db.campaignProjection("root")!.status, "paused");
    assert.equal(db.campaignProjection("root")!.stuck?.items.length ?? 0, 0);
    assert.equal(db.campaignContinuationAdmission("root").state, "lifecycle_held");
    assert.deepEqual(db.campaignPause("root")!.inFlightSessionIds.sort(), ["child", "root"]);
    assert.equal(svc.prompt("child", "continue").ok, false);
    const creation = svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "agent", useWorktree: false, config: {} },
      undefined, undefined, false, false, false, { parentSessionId: "root" });
    assert.match(creation.error!, /campaign is paused/);
    assert.equal(svc.restart("child").ok, false);
    assert.equal(svc.setArchived("child", true).ok, false);
    assert.match(svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: 1, followUpsAccounted: true }).error!, /paused/);
    assert.equal(db.campaignPaused("child"), true);
    db.updateSessionStatus("child", "idle", Date.now());
    svc.retryDuePrompts();
    assert.equal(db.getSession("child")!.status, "stopped");
    assert.ok(db.campaignPause("root")!.stoppedSessionIds.includes("child"));
    assert.equal(db.campaignStatusOnly("root"), "paused");
  } finally { db.close(); }
});

test("pause names the actual merge watch and keeps it active", () => {
  const { db, svc, owner } = fixture();
  try {
    db.updateSessionStatus("child", "idle", Date.now());
    db.pullRequestWatches.register({ watchId: "queued-merge", sessionId: "child", runnerId: "r",
      repository: "picoduck/wollipog", number: 4560, headSha: "a".repeat(40), now: Date.now() });
    assert.ok(svc.setCampaignPause("root", { action: "pause" }, owner).ok);
    svc.retryDuePrompts();
    assert.equal(db.pullRequestWatches.view("queued-merge")!.state, "watching");
    assert.equal(db.getSession("child")!.status, "idle");
    assert.equal(db.campaignProjection("root")!.pause!.inFlightWork!.find(work => work.sessionId === "child")!.description,
      "Merge of picoduck/wollipog#4560 is still in flight; its merge watch is active.");
  } finally { db.close(); }
});

test("manual pause waits for its owner; timed pause restores existing running members with one prompt each", () => {
  const { db, svc, owner } = fixture();
  try {
    assert.ok(svc.setCampaignPause("root", { action: "pause" }, owner).ok);
    svc.retryDuePrompts(Date.now() + 100_000);
    assert.equal(db.campaignPaused("root"), true);
    assert.ok(svc.setCampaignPause("root", { action: "resume" }, owner).ok);
    assert.equal(db.campaignPaused("root"), false);
    assert.equal(db.campaignPause("root")!.resumedBy, owner.userId);
    assert.ok(svc.setCampaignPause("root", { action: "pause", resumeAt: Date.now() + 10_000 }, owner).ok);
    svc.retryDuePrompts(Date.now() + 20_000);
    assert.equal(db.campaignPaused("root"), false);
    assert.equal(db.campaignPause("root")!.resumedBy, "scheduled");
    const count = db.raw().prepare("SELECT COUNT(*) AS n FROM session_prompt_commands WHERE command_id LIKE 'campaign_resume_%'").get() as { n: number };
    assert.equal(count.n, 4);
    svc.retryDuePrompts(Date.now() + 30_000);
    assert.deepEqual(db.raw().prepare("SELECT COUNT(*) AS n FROM session_prompt_commands WHERE command_id LIKE 'campaign_resume_%'").get(), count);
  } finally { db.close(); }
});

test("old dashboards never read Paused as Active", () => {
  assert.equal(compatibleCampaignStatus("paused", PROTOCOL_VERSION), "paused");
  assert.equal(compatibleCampaignStatus("paused", 367), "stuck");
  assert.equal(compatibleCampaignStatus("paused", 296), "blocked");
});

test("stopped root remains scheduled, waits for Stop confirmation, and restarts preserved children", () => {
  const { db, svc, owner } = fixture();
  try {
    db.updateSessionStatus("root", "idle", Date.now());
    db.updateSessionStatus("child", "idle", Date.now());
    assert.ok(svc.setCampaignPause("root", { action: "pause", resumeAt: Date.now() + 1000 }, owner).ok);
    assert.equal(db.getSession("root")!.status, "stopped");
    assert.equal(db.getSession("child")!.status, "stopped");
    svc.retryDuePrompts(Date.now() + 2000);
    assert.equal(db.campaignPaused("root"), true, "a provisional Stop is never restart proof");
    for (const id of ["root", "child"]) db.settleSessionStopIntent(id, Date.now(), "runner_terminal");
    svc.retryDuePrompts(Date.now() + 3000);
    assert.equal(db.campaignPaused("root"), false);
    assert.equal(db.getSession("child")!.status, "starting");
    assert.equal(db.getSession("root")!.status, "starting");
    const prompts = db.raw().prepare("SELECT session_id FROM session_prompt_commands WHERE command_id LIKE 'campaign_resume_%' ORDER BY session_id").all();
    assert.deepEqual(prompts.map(row => (row as { session_id: string }).session_id), ["child", "root"]);
  } finally { db.close(); }
});

test("pause never revokes or interrupts an armed merge or pending request", () => {
  const { db, svc, owner, hub } = fixture();
  try {
    db.updateSessionStatus("child", "idle", Date.now());
    db.raw().prepare(`INSERT INTO workflow_decisions(request_id,occurrence_id,session_id,controlling_session_id,
      category,resource_key,resource_snapshot,resource_digest,policy_revision,authority,status,created_at,
      action_kind,action_command,action_command_digest,action_armed_at)
      VALUES ('merge','merge-1','child','root','pr_merge','repo#1',?,'digest',1,'human','approved',?,'pr_merge_enqueue','gh pr merge URL --squash','command-digest',?)`)
      .run(JSON.stringify({ category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 1, headSha: "a".repeat(40),
        reviewResult: "merge", requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: Date.now(), checks: [] } }), Date.now(), Date.now());
    db.setPendingApproval("root", { requestId: "question", kind: "question", title: "An existing question", options: [] });
    const before = db.workflowDecisionByOccurrence("merge-1");
    assert.ok(svc.setCampaignPause("root", { action: "pause" }, owner).ok);
    svc.retryDuePrompts();
    assert.equal(db.getSession("child")!.status, "idle");
    assert.deepEqual(db.workflowDecisionByOccurrence("merge-1"), before);
    assert.ok(db.campaignProjection("root")!.pause!.inFlightWork!.some(work =>
      work.description === "Merge of picoduck/wollipog#1 has an armed enqueue decision and is still in flight."));
    assert.equal(db.getSession("root")!.pendingApproval!.requestId, "question");
    assert.deepEqual(db.campaignPause("root")!.inFlightSessionIds.sort(), ["child", "root"]);
    const outbox = new SessionPromptOutbox(db, hub, { warn() {} });
    outbox.stage("root", "r", { type: "prompt_session", sessionId: "root", text: "An existing continuation" }, Date.now(), "existing-continuation");
    assert.equal(outbox.flush(), 0, "pause holds durable prompt transport");
    assert.ok(svc.setCampaignPause("root", { action: "resume" }, owner).ok);
    // The owner resumed the campaign, but its resume notification must never answer a question
    // or interrupt the armed merge. The pre-existing ordinary prompt keeps its own semantics.
    const resumeRows = db.raw().prepare("SELECT command_id,state FROM session_prompt_commands WHERE command_id LIKE 'campaign_resume_%'").all() as Array<{ command_id: string; state: string }>;
    assert.equal(resumeRows.length, 2);
    assert.ok(resumeRows.every(row => row.state === "pending"));
  } finally { db.close(); }
});
