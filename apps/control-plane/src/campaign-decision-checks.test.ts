/**
 * Follow-up relatedness and closure-reason choice on the Decision Model (#4104, Slice B). Every
 * path runs against a fake harness; no test calls a real provider.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, type DecisionKind,
  type RunDecisionMessage, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { issueEvidenceDigest } from "./campaign-issue-authority.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";
import { DECISION_MAX_ATTEMPTS } from "./decision-runtime.js";
import { HEALTHY_VERDICTS, fakeDecisionData, fakeDecisionKind, fakeDecisionRuntime, type FakeDecisionStep } from "./credential-screen-test-fixture.js";

type Answer = (kind: DecisionKind, message: RunDecisionMessage, attempt: number) => FakeDecisionStep | Promise<FakeDecisionStep>;

function harness(answer: Answer = (kind) => ({ verdict: HEALTHY_VERDICTS[kind]! })) {
  const db = ControlPlaneDb.open(":memory:");
  const principal: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: db.localIdentityContext().userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "team/repo", issueNumbers: [100], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [100];
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false, driver: "claude-code", now: 1, config: {},
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } }
        : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {}; hub.sendToRunner = () => true;
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type === "campaign_issue_scope") {
      if (message.operation === "publication_inspect") return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true,
        repository: "team/repo", duplicateSearch: "subject" as const,
        publicationDigest: issueEvidenceDigest({ sanitizedTitle: message.sanitizedTitle, sanitizedBody: message.sanitizedBody, labels: message.labels }) };
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo",
        ...(message.operation === "synchronize" ? { revision: message.scope.revision } : { candidates: (message.issues ?? [100]).map((number) =>
          ({ issue: { repository: "team/repo", number }, title: `Issue ${number}`, source: "sub_issue" as const })) }) };
    }
    if (message.type === "github_issue_closure") {
      if (message.operation !== "inspect") throw new Error("These tests never execute a closure");
      return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId, ok: true, inspection: { repository: "team/repo",
        issue: message.issue, title: "Retire the legacy importer", url: `https://github.com/team/repo/issues/${message.issue}`, state: "OPEN",
        forgeDigest: "a".repeat(64), openPullRequests: [], ...(message.deliveryPullRequests === undefined ? {} : { delivery: [] }) } };
    }
    throw new Error("Unexpected runner command");
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const fake = fakeDecisionRuntime(db, (message, attempt) => answer(fakeDecisionKind(message), message, attempt));
  svc.setDecisionRuntime(fake.runtime);
  assert.ok(svc.setCampaignControl("root", { mode: "full_control", objective: "Fix the importer crash in issue 100",
    operations: ["campaign_issue_scope", "issue_closure", "follow_up_issue_publication", "implementation_question"], delegatablePolicyIds: [],
    issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 5, closureReasons: ["completed", "not_planned"] } }, 1, principal).ok);
  assert.ok(svc.recordCampaignPlan("root", { items: [{ key: "issue:100", issue: { repository: "team/repo", number: 100 } }], planComplete: true }).ok);
  const page = db.campaignWorkLedger.page("root", { state: "all", limit: 100 }, Date.now());
  assert.ok(page.ok);
  const item = page.data.items[0]!;
  const calls = (kind: DecisionKind) => fake.calls.filter((message) => fakeDecisionKind(message) === kind);
  const occurrences = (kind: DecisionKind) => db.listCampaignDecisionOccurrences("root").filter((occurrence) => occurrence.kind === kind);
  return { db, svc, principal, item, calls, occurrences };
}

const body = "## Problem\nThe importer leaks a temp file on the crash path\n## Proposed Behavior\nRemove it\n## Acceptance Criteria\n- Verified\n" +
  "## Security and Compatibility\nNone";

function recommend(h: ReturnType<typeof harness>, title = "Clean Up the Importer Temp File on Crash") {
  const record = h.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title, originWorkItemIds: [h.item.id] });
  assert.ok(record.ok, record.error ?? "record");
  assert.ok(h.svc.adjudicateCampaignRecommendation("root", { recommendationId: record.data!.id, disposition: "accepted",
    reason: "Found while fixing the crash", publicationRequired: true }).ok);
  return { id: record.data!.id, title };
}

const publish = (h: ReturnType<typeof harness>, requestId: string, recommendation: { id: string; title: string }) =>
  h.svc.createWorkflowDecisionWithVideo("child", { requestId, resourceKey: requestId, resourceSnapshot: { category: "follow_up_issue_publication",
    repository: "team/repo", sanitizedTitle: recommendation.title, sanitizedBody: body, labels: [], recommendationId: recommendation.id } });

/** A not-planned closure whose floor is proven: the work item cancelled with a recorded reason. */
function cancelWork(h: ReturnType<typeof harness>, reason = "Superseded by the new importer, which replaces it") {
  assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item.id, commitment: { state: "cancelled", reason } }).ok);
}
const close = (h: ReturnType<typeof harness>, requestId: string) => h.svc.requestGithubIssueClosure("root", { requestId, issue: 100,
  reason: "not_planned", explanation: "The new importer replaces the legacy one", evidence: ["Work item cancelled as superseded"] });

test("follow-up relatedness: a healthy model admits a related follow-up, with the owner's words and the origin work as its inputs", async () => {
  const h = harness();
  try {
    const recommendation = recommend(h);
    const asked = await publish(h, "related", recommendation);
    assert.ok(asked.ok, asked.error ?? "publication");
    assert.equal(asked.data!.authority, "orchestrator");
    assert.equal(asked.data!.authorityEvaluation?.admissionFailure, undefined);
    const [call] = h.calls("follow_up_relatedness");
    assert.match(call!.input, /<owner_message>\n"Fix the importer crash in issue 100"\n<\/owner_message>/u);
    assert.deepEqual(fakeDecisionData<{ issues: number[] }>(call!, "grant").issues, [100]);
    assert.equal(fakeDecisionData<{ title: string }>(call!, "follow_up").title, recommendation.title);
    const subject = h.db.campaignDecisionSubject(h.occurrences("follow_up_relatedness")[0]!.occurrenceId);
    assert.deepEqual([subject?.surface, subject?.requestId, subject?.sessionId], ["follow_up_publication", recommendation.id, "child"]);
  } finally { h.db.close(); }
});

test("follow-up relatedness: an unrelated follow-up is refused back to the Orchestrator with the model's reason, and nothing is created", async () => {
  const h = harness((kind) => kind === "follow_up_relatedness"
    ? { verdict: "unrelated", reason: "It starts a dark-mode theme the owner did not ask for." } : { verdict: HEALTHY_VERDICTS[kind]! });
  try {
    const refused = await publish(h, "unrelated", recommend(h, "Add a Dark-Mode Theme"));
    assert.deepEqual([refused.ok, refused.status, refused.errorDetails?.code], [false, 409, "unrelated_follow_up"]);
    assert.match(refused.error!, /The Decision Model's reason: It starts a dark-mode theme the owner did not ask for\./u);
    assert.equal(h.db.workflowDecisionByRequestId("child", "unrelated"), null, "no decision for anyone");
  } finally { h.db.close(); }
});

test("follow-up relatedness: a transient failure that succeeds on retry asks nobody", async () => {
  const h = harness((kind, _message, attempt) => kind === "follow_up_relatedness" && attempt === 1
    ? { errorClass: "rate_limited" } : { verdict: HEALTHY_VERDICTS[kind]! });
  try {
    const asked = await publish(h, "retry", recommend(h));
    assert.equal(asked.data!.authority, "orchestrator");
    assert.equal(h.calls("follow_up_relatedness").length, 2);
  } finally { h.db.close(); }
});

for (const [label, step, attempts] of [
  ["retries exhausted", { errorClass: "provider_overloaded" }, DECISION_MAX_ATTEMPTS],
  ["a non-transient error", { errorClass: "authentication" }, 1],
  ["an uncertain verdict", { verdict: "uncertain", reason: "It might be related." }, 1],
] as const) {
  test(`follow-up relatedness: ${label} makes the publication the owner's, exactly once, never read another way`, async () => {
    const h = harness((kind) => kind === "follow_up_relatedness" ? step : { verdict: HEALTHY_VERDICTS[kind]! });
    try {
      const recommendation = recommend(h);
      const asked = await publish(h, "held", recommendation);
      assert.ok(asked.ok, asked.error ?? "publication");
      assert.equal(h.calls("follow_up_relatedness").length, attempts, "only transient failures are retried");
      assert.equal(asked.data!.authority, "human");
      assert.equal(asked.data!.authorityEvaluation?.admissionFailure, "relatedness_unconfirmed");
      // Asking again joins the same person-owned request and the same occurrence.
      const again = await publish(h, "held", recommendation);
      assert.equal(again.data?.occurrenceId, asked.data!.occurrenceId);
      assert.equal(h.occurrences("follow_up_relatedness").length, 1);
      assert.equal(h.calls("follow_up_relatedness").length, attempts);
      assert.equal(h.db.pendingWorkflowDecisionsForController("root").filter((d) => d.authority === "human").length, 1);
    } finally { h.db.close(); }
  });
}

test("follow-up relatedness: concurrent requests record one verdict, and the structural floor runs first", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(async (kind) => { await gate; return { verdict: HEALTHY_VERDICTS[kind]! }; });
  try {
    const recommendation = recommend(h);
    const first = publish(h, "same", recommendation);
    const second = publish(h, "same", recommendation);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a.ok && b.ok, a.error ?? b.error ?? "publication");
    assert.equal(a.data!.occurrenceId, b.data!.occurrenceId);
    assert.equal(h.occurrences("follow_up_relatedness").length, 1);
    assert.equal(h.calls("follow_up_relatedness").length, 1);
    // A title that fails the floor is refused before any model call.
    const before = h.calls("follow_up_relatedness").length;
    const floor = await publish(h, "floor", { id: recommend(h, "Another Repair").id, title: "Something Else Entirely" });
    assert.equal(floor.errorDetails?.code, "title_mismatch");
    assert.equal(h.calls("follow_up_relatedness").length, before, "the floor never calls the model");
  } finally { h.db.close(); }
});

test("closure reason: a fitting not-planned reason is the Orchestrator's, and a delivery-proven or unproven closure is never checked", async () => {
  const h = harness();
  try {
    const unproven = await close(h, "unproven");
    assert.ok(unproven.ok, unproven.error ?? "closure");
    assert.equal(unproven.data!.decision!.authority, "human", "today's human fallback for missing proof is unchanged");
    assert.equal(h.calls("closure_reason").length, 0, "no model call without a proven floor");
    cancelWork(h);
    const fits = await close(h, "fits");
    assert.equal(fits.data!.decision!.authority, "orchestrator");
    const [call] = h.calls("closure_reason");
    assert.equal(fakeDecisionData<{ reason: string }>(call!, "closure").reason, "not_planned");
    assert.match(JSON.stringify(fakeDecisionData(call!, "evidence")), /Superseded by the new importer/u);
    const subject = h.db.campaignDecisionSubject(h.occurrences("closure_reason")[0]!.occurrenceId);
    assert.deepEqual([subject?.surface, subject?.requestId], ["issue_closure", "team/repo#100"]);
  } finally { h.db.close(); }
});

test("closure reason: a reason that does not fit is refused back to the Orchestrator with the model's reason, and nothing is created", async () => {
  const h = harness((kind) => kind === "closure_reason"
    ? { verdict: "does_not_fit", reason: "The recorded reason says the work is only paused." } : { verdict: HEALTHY_VERDICTS[kind]! });
  try {
    cancelWork(h, "Paused until the next quarter");
    const refused = await close(h, "misfit");
    assert.deepEqual([refused.ok, refused.status], [false, 409]);
    assert.match(refused.error!, /does not fit issue #100.*The recorded reason says the work is only paused\./u);
    assert.equal(h.db.workflowDecisionByRequestId("root", "misfit"), null);
  } finally { h.db.close(); }
});

test("closure reason: a transient failure that succeeds on retry asks nobody", async () => {
  const h = harness((kind, _message, attempt) => kind === "closure_reason" && attempt === 1
    ? { errorClass: "timed_out" } : { verdict: HEALTHY_VERDICTS[kind]! });
  try {
    cancelWork(h);
    const asked = await close(h, "retry");
    assert.equal(asked.data!.decision!.authority, "orchestrator");
    assert.equal(h.calls("closure_reason").length, 2);
  } finally { h.db.close(); }
});

for (const [label, step, attempts] of [
  ["retries exhausted", { errorClass: "transport" }, DECISION_MAX_ATTEMPTS],
  ["a non-transient error", { errorClass: "model_unavailable" }, 1],
  ["an uncertain verdict", { verdict: "uncertain", reason: "The record is ambiguous." }, 1],
] as const) {
  test(`closure reason: ${label} makes the closure the person's, exactly once, never read another way`, async () => {
    const h = harness((kind) => kind === "closure_reason" ? step : { verdict: HEALTHY_VERDICTS[kind]! });
    try {
      cancelWork(h);
      const asked = await close(h, "held");
      assert.ok(asked.ok, asked.error ?? "closure");
      assert.equal(h.calls("closure_reason").length, attempts);
      const decision = asked.data!.decision!;
      assert.deepEqual([decision.authority, decision.authorityEvaluation?.reason], ["human", "closure_proof_incomplete"]);
      assert.ok(decision.resourceSnapshot.category === "issue_closure" &&
        decision.resourceSnapshot.deliveryGaps?.map((gap) => [gap.code, gap.action]).join() === "reason_unconfirmed,person_decides");
      const again = await close(h, "held");
      assert.equal(again.data?.decision?.occurrenceId, decision.occurrenceId);
      assert.equal(h.occurrences("closure_reason").length, 1);
      assert.equal(h.calls("closure_reason").length, attempts);
    } finally { h.db.close(); }
  });
}

test("a subjects table from the question screen's release is widened in place, keeping its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-subjects-"));
  const path = join(dir, "cp.db");
  try {
    const first = ControlPlaneDb.open(path);
    const organizationId = first.localIdentityContext().organizationId;
    const raw = first.raw();
    raw.exec(`DROP TABLE campaign_decision_subjects;
      CREATE TABLE campaign_decision_subjects (
        occurrence_id TEXT PRIMARY KEY, campaign_session_id TEXT NOT NULL, session_id TEXT NOT NULL,
        surface TEXT NOT NULL CHECK (surface IN ('implementation_question','provider_question','tool_request','owner_decision')),
        request_id TEXT NOT NULL, classification TEXT CHECK (classification IN ('decline','orchestrator')),
        classified_by TEXT, classified_at INTEGER, created_at INTEGER NOT NULL,
        FOREIGN KEY (occurrence_id) REFERENCES decision_occurrences(occurrence_id) ON DELETE CASCADE);`);
    for (const id of ["dec_old", "dec_new"]) first.createDecisionOccurrence({ occurrenceId: id, organizationId, campaignSessionId: "root",
      occurrenceKey: id, kind: "credential_screen", promptVersion: "v", inputDigests: {}, inputDigest: "d", now: 1 });
    first.recordCampaignDecisionSubject({ occurrenceId: "dec_old", campaignSessionId: "root", sessionId: "child",
      surface: "implementation_question", requestId: "q-1" }, 1);
    assert.throws(() => raw.exec(`INSERT INTO campaign_decision_subjects (occurrence_id, campaign_session_id, session_id, surface, request_id,
      created_at) VALUES ('dec_new', 'root', 'root', 'issue_closure', 'team/repo#1', 1)`), /CHECK constraint failed/u, "the fixture is the old table");
    first.close();
    const second = ControlPlaneDb.open(path);
    try {
      assert.equal(second.campaignDecisionSubject("dec_old")?.requestId, "q-1", "every row survives");
      second.recordCampaignDecisionSubject({ occurrenceId: "dec_new", campaignSessionId: "root", sessionId: "root",
        surface: "issue_closure", requestId: "team/repo#1" }, 2);
      assert.equal(second.campaignDecisionSubject("dec_new")?.surface, "issue_closure");
    } finally { second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("closure reason: concurrent requests record one verdict", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(async (kind) => { await gate; return { verdict: HEALTHY_VERDICTS[kind]! }; });
  try {
    cancelWork(h);
    const first = close(h, "same");
    const second = close(h, "same");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a.ok && b.ok, a.error ?? b.error ?? "closure");
    assert.equal(a.data!.decision!.occurrenceId, b.data!.decision!.occurrenceId);
    assert.equal(h.occurrences("closure_reason").length, 1);
    assert.equal(h.calls("closure_reason").length, 1);
  } finally { h.db.close(); }
});
