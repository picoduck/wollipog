import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CAMPAIGN_FORGE_OBSERVATION, CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES, DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL, type CampaignControl, type CampaignPublicationAdmissionFailure, type RunnerMetadata, type WorkflowDecisionView,
  type CampaignWorkItemDetail, type IssueClosureDeliveryGap, type IssueClosureEpicMembers, ISSUE_CLOSURE_DELIVERY_FAILURE_MAX, issueClosureDeliveryFailure,
  issueClosureDeliveryGap, normalizeIssueClosureDeliveryGaps, normalizeIssueClosureEpicMembers } from "@wollipog/protocol";
import { ControlPlaneDb, campaignRequestToken } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService, canonicalPrMergeEnqueueCommand } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { campaignBoundaryCurrent, evaluateCampaignAuthority } from "./campaign-authority.js";
import { closureEvidence, closureDeliveryGaps, issueEvidenceDigest } from "./campaign-issue-authority.js";
import { CampaignRecoveryService, recoveryCoordinate } from "./campaign-recovery.js";
import { CampaignForgeObserver } from "./campaign-forge-observations.js";
import type { AgentPrincipal, HumanPrincipal } from "./identity.js";
import { healthyDecisionRuntime } from "./credential-screen-test-fixture.js";

/** A related open pull request as the runner reports it, without a closing reference. */
const openPullRequest = (number: number) => ({ number, title: "Work", url: `https://github.com/team/repo/pull/${number}`, headSha: "b".repeat(40) });
/** Each gap's code and work item, without its derived action and summary. */
const gapNames = (gaps: IssueClosureDeliveryGap[] | null | undefined) => gaps?.map((gap) => ({ code: gap.code, workItemId: gap.workItemId }));

function harness(full = true, maximum = 5, issues = [100]) {
  const db = ControlPlaneDb.open(":memory:");
  const principal: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: db.localIdentityContext().userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {},
      driver: "codex-app-server", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "team/repo", issueNumbers: issues, revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = issues;
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "codex", title: id, useWorktree: false, driver: "codex-app-server", now: 1, config: {},
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } } : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {}; hub.sendToRunner = () => true;
  const state = { publicationOk: true, subjectSearch: true, executes: 0, openPR: false as boolean | number, delivery: [] as Array<{number:number;headSha:string;mergeCommitSha:string}>, publicationTitles: {} as Record<number,string>,
    epicMembers: undefined as IssueClosureEpicMembers | undefined, closureMessages: [] as unknown[] };
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type === "campaign_issue_scope") {
      if (message.operation === "publication_inspect") return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId,
        ok: state.publicationOk, repository: "team/repo", publicationDigest: issueEvidenceDigest({ sanitizedTitle: message.sanitizedTitle, sanitizedBody: message.sanitizedBody, labels: message.labels }),
        ...(state.subjectSearch ? { duplicateSearch: "subject" as const } : {}) };
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo",
        ...(message.operation === "synchronize" ? { revision: message.scope.revision } : { candidates: (message.issues ?? [100, 101]).map((number) =>
          ({ issue: { repository: "team/repo", number }, title: message.publication?.sanitizedTitle ?? state.publicationTitles[number] ?? `Issue ${number}`, source: "sub_issue" as const })) }) };
    }
    if (message.type === "github_issue_closure") {
      state.closureMessages.push(message);
      if (message.operation === "execute") { state.executes++; return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId, ok: true,
        result: { outcome: "uncertain", completedAt: Date.now() } }; }
      return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId, ok: true, inspection: { repository: "team/repo", issue: message.issue,
        title: "Issue", url: `https://github.com/team/repo/issues/${message.issue}`, state: "OPEN", forgeDigest: "a".repeat(64),
        openPullRequests: state.openPR === false ? [] : [openPullRequest(state.openPR === true ? 10 : state.openPR)],
        ...(message.deliveryPullRequests === undefined ? {} : { delivery: state.delivery }),
        // A member read is bound into the digest, as the runner binds it.
        ...(message.epicMembers && state.epicMembers ? { epicMembers: state.epicMembers, forgeDigest: "b".repeat(64) } : {}) } };
    }
    throw new Error("Unexpected runner command");
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  // A healthy Decision Model (#4104) on a fake harness: relatedness and closure-reason checks confirm.
  svc.setDecisionRuntime(healthyDecisionRuntime(db).runtime);
  if (full) assert.ok(svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100", operations: ["campaign_issue_scope", "issue_closure", "follow_up_issue_publication", "implementation_question"],
    delegatablePolicyIds: [], issueAuthority: { epics: issues, relatedFollowUps: true, maxIssues: maximum, closureReasons: ["completed", "not_planned"] } }, 1, principal).ok);
  const approve = (d: WorkflowDecisionView) => svc.resolveWorkflowDecision("root", "root", d.occurrenceId, { outcome: "approve" }, d.authority,
    d.authority === "human" ? { kind: "human", id: principal.userId } : { kind: "agent", id: "root" }, () => true);
  const proposal = (requestId: string, number = 101) => svc.proposeCampaignIssueScope("root", { requestId, expectedRevision: 1, additions: [{repository:"team/repo",number}],
    removals: [], explanation: "Verified intended member", lineage: { kind: "epic", epic: 100 } });
  assert.ok(svc.recordCampaignPlan("root", {items:[{key:"issue:100",issue:{repository:"team/repo",number:100}}],planComplete:true}).ok);
  const page = db.campaignWorkLedger.page("root", {state:"all",limit:100},Date.now()); assert.ok(page.ok);
  const item = page.data.items[0]!;
  return { db, svc, hub, metadata, principal, state, approve, proposal, item };
}

test("#4164 real runner inspection admits a merge-queue squash delivery and rejects invalid merges", async () => {
  const { inspectGithubIssueClosure, issueClosureRun, IssueClosureInspectionError } = await import("../../runner/src/github-issue-closure.js");
  for (const mode of ["merged", "not_merged", "wrong_head", "wrong_base"] as const) {
    const { h, observe, close } = delivery({ stage: [{ number: 10 }] });
    const connection = { nodes: [], pageInfo: { hasNextPage: false } };
    const bounded = issueClosureRun({ kind: "native" }, process.cwd());
    const run = async (command: string, args: string[]) => {
      if (command === "git") return "git@github.com:team/repo.git";
      if (args.includes("graphql")) return JSON.stringify({ data: { repository: { nameWithOwner: "team/repo",
        issue: { id: "issue", number: 100, title: "Issue", body: "Delivered", url: "https://github.com/team/repo/issues/100",
          state: "OPEN", updatedAt: "2026-11-04T22:03:00Z", labels: connection, assignees: connection, timelineItems: connection }, pullRequests: connection } } });
      const path = args.find((arg) => arg.startsWith("repos/"));
      if (path === "repos/team/repo") return JSON.stringify({ default_branch: "main" });
      if (path === "repos/team/repo/pulls/10") return JSON.stringify({ number: 10, state: "closed", merged: mode !== "not_merged",
        merge_commit_sha: "c".repeat(40), head: { sha: (mode === "wrong_head" ? "d" : "b").repeat(40) },
        base: { ref: mode === "wrong_base" ? "feature" : "main", repo: { full_name: "team/repo" } } });
      assert.ok(path?.includes("/compare/"));
      return bounded(process.execPath, ["-e", args.includes("--jq") ? 'process.stdout.write(JSON.stringify({status:"ahead"}))'
        : 'process.stdout.write(JSON.stringify({status:"ahead",files:[{patch:"x".repeat(3*1024*1024)}]}))']);
    };
    const runner = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (r, id, message, timeout) => {
      if (message.type !== "github_issue_closure" || message.operation !== "inspect") return runner(r, id, message, timeout);
      const base = { type: "github_issue_closure_result" as const, requestId: id, sessionId: message.sessionId };
      try { return { ...base, ok: true, inspection: await inspectGithubIssueClosure(message.issue, run, message.deliveryPullRequests) }; }
      catch (error) {
        assert.ok(error instanceof IssueClosureInspectionError);
        return { ...base, ok: false, deliveryVerificationFailure: error.deliveryVerificationFailure };
      }
    };
    try {
      observe(10, "merged");
      const result = await close(`real-inspection-${mode}`);
      assert.ok(result.ok, result.error ?? "closure");
      assert.equal(result.data!.decision!.authority, mode === "merged" ? "orchestrator" : "human");
      if (mode === "merged") assert.deepEqual(closureSnapshot(result.data!.decision!).delivery,
        [{ number: 10, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }]);
    } finally { h.db.close(); }
  }
});

test("#4164 epic delivery records its own result instead of an ordinary-route failure", async () => {
  for (const epicFails of [false, true]) {
    const { h, observe, close } = delivery({ stage: [{ number: 10 }], epic: true });
    try {
      observe(10, "merged");
      h.state.epicMembers = { readable: true, members: [{ number: 101, state: "completed" }] };
      const runner = h.hub.requestFromRunner;
      h.hub.requestFromRunner = async (r, id, message, timeout) => {
        const result = await runner(r, id, message, timeout);
        if (message.type === "github_issue_closure" && message.operation === "inspect" && message.deliveryPullRequests && (!message.epicMembers || epicFails)) {
          return { type: "github_issue_closure_result", requestId: id, sessionId: message.sessionId, ok: false,
            deliveryVerificationFailure: { check: message.epicMembers ? "base" : "head", pullRequest: 10 } };
        }
        return result;
      };
      const result = await close(`epic-result-${epicFails}`);
      assert.ok(result.ok, result.error ?? "closure");
      assert.equal(result.data!.decision!.authority, epicFails ? "human" : "orchestrator");
      assert.equal(closureSnapshot(result.data!.decision!).deliveryVerificationFailure?.check, epicFails ? "base" : undefined);
    } finally { h.db.close(); }
  }
});

test("#4164 delivery diagnostics survive person routing without raw runner errors", async () => {
  for (const mode of ["merged_state", "head", "base", "comparison_read", "throw", "digest", "missing", "legacy", "confirmed"] as const) {
    const { h, observe, close } = delivery({ stage: [{ number: 10 }] });
    const logs: string[] = [];
    (h.svc as unknown as { log: { info: (s: string) => void } }).log.info = (s) => logs.push(s);
    try {
      observe(10, "merged");
      const runner = h.hub.requestFromRunner;
      h.hub.requestFromRunner = async (r, id, message, timeout) => {
        const result = await runner(r, id, message, timeout);
        if (message.type !== "github_issue_closure" || message.operation !== "inspect" || !message.deliveryPullRequests || mode === "confirmed") return result;
        if (mode === "throw") throw new Error("private path and provider output");
        if (result.type !== "github_issue_closure_result") return result;
        if (mode === "digest") return { ...result, inspection: { ...result.inspection!, forgeDigest: "f".repeat(64) } };
        if (mode === "missing") return { ...result, inspection: { ...result.inspection!, delivery: undefined } };
        return { ...result, ok: false, inspection: undefined, error: "private path and provider output",
          ...(mode === "legacy" ? {} : { deliveryVerificationFailure: { check: mode, pullRequest: 10 } }) };
      };
      const result = await close(`diagnostic-${mode}`);
      assert.ok(result.ok, result.error ?? "closure");
      const decision = result.data!.decision!;
      assert.equal(decision.authority, mode === "confirmed" ? "orchestrator" : "human");
      if (mode === "confirmed") { assert.ok(!logs.some((line) => line.includes("campaign_issue_delivery_verification_failed"))); continue; }
      const check = mode === "throw" ? "runner_unavailable" : mode === "digest" ? "issue_changed" : mode === "missing" ? "delivery_missing" : mode === "legacy" ? "runner_response" : mode;
      const snapshot = closureSnapshot(decision);
      assert.equal(snapshot.deliveryVerificationFailure?.check, check);
      assert.match(snapshot.deliveryGaps![0]!.summary, new RegExp(`failed at ${check}`));
      assert.ok(logs.some((line) => line.includes('"event":"campaign_issue_delivery_verification_failed"') && line.includes(check) && line.includes('"pullRequests":[10]')));
      assert.ok(!JSON.stringify({ logs, snapshot }).includes("private path"));
    } finally { h.db.close(); }
  }
});

test("fixed-by planning is scoped, root-only, atomic and immutable before dispatch (#3943)", () => {
  const h = harness();
  try {
    const link = { issue: { repository: "team/repo", number: 100 }, workItemKeys: ["unit:a", "unit:b"] };
    assert.equal(h.svc.recordCampaignPlan("child", { items: [], planComplete: true, fixedBy: [link] }).ok, false);
    assert.equal(h.svc.recordCampaignPlan("root", { items: [], planComplete: true, fixedBy: [link] }).ok, false);
    h.db.raw().prepare("DELETE FROM sessions WHERE id='child'").run();
    assert.equal(h.svc.recordCampaignPlan("root", { items: [], planComplete: true,
      fixedBy: [{ ...link, issue: { repository: "team/repo", number: 999 } }] }).ok, false);
    const plan = { items: [{ key: "unit:a", issue: link.issue }, { key: "unit:b", issue: link.issue }], planComplete: true, fixedBy: [link] };
    assert.ok(h.svc.recordCampaignPlan("root", plan).ok);
    const ids = h.db.campaignWorkLedger.fixedBy("root", "team/repo", 100)!;
    assert.equal(ids.length, 2);
    assert.ok(h.svc.recordCampaignPlan("root", plan).ok);
    assert.equal(h.svc.recordCampaignPlan("root", { ...plan, fixedBy: [{ ...link, workItemKeys: ["unit:a"] }] }).ok, false);
    assert.equal(h.svc.recordCampaignPlan("root", { ...plan, fixedBy: [{ ...link, workItemKeys: ["missing"] }] }).ok, false);
    assert.deepEqual(h.db.campaignWorkLedger.fixedBy("root", "team/repo", 100), ids);
    h.db.createSession({ id: "child", runnerId: "r", workspaceId: "w", agentId: "codex", title: "child", useWorktree: false,
      driver: "codex-app-server", now: 2, config: {}, parentSessionId: "root" });
    h.db.updateSessionStatus("child", "running", 3);
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: ids[0]!, childSessionId: "child" }).ok);
    const late = h.svc.recordCampaignPlan("root", plan);
    assert.equal(late.ok, false); assert.match(late.error!, /before creating any campaign child/);
    // Historical attempts continue to freeze planning even after the child is deleted.
    h.db.raw().prepare("DELETE FROM sessions WHERE id='child'").run();
    assert.match(h.svc.recordCampaignPlan("root", plan).error!, /before any campaign dispatch/);
  } finally { h.db.close(); }
});

test("every fixed-by unit needs delivery, verification and exact merged proof (#3943)", async () => {
  const h = harness(true, 5, [100, 101, 102]);
  try {
    h.db.raw().prepare("DELETE FROM sessions WHERE id='child'").run();
    const target = { repository: "team/repo", number: 100 };
    const prior = await h.svc.requestGithubIssueClosure("root", { requestId: "before-plan", issue: 100, reason: "completed",
      explanation: "No established delivery", evidence: ["Plan pending"] });
    assert.ok(prior.ok); assert.equal(prior.data!.decision!.authority, "human");
    const plan = h.svc.recordCampaignPlan("root", { items: [{ key: "unit:a", issue: { ...target, number: 101 } }, { key: "unit:b", issue: { ...target, number: 102 } }],
      planComplete: true, fixedBy: [{ issue: target, workItemKeys: ["unit:a", "unit:b"] }] });
    assert.ok(plan.ok, plan.error ?? "plan recorded");
    assert.equal(h.svc.workflowDecision("root", prior.data!.decision!.occurrenceId).data?.authority, "human");
    const merge = { number: 10, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) };
    h.state.delivery = [merge];
    const details = new Map(plan.data!.items.map(({ workItemId }, index) => [workItemId, { id: workItemId, issue: { ...target, number: 101 + index }, primaryState: "delivered", currentAttempt: null,
      verifications: [{ outcome: "delivered", report: { digest: "d".repeat(64) } }],
      observed: { pullRequests: [{ ref: { repository: "team/repo", number: 10 }, fact: { availability: "fresh", value: { state: "merged", ...merge } } }] },
    } as unknown as CampaignWorkItemDetail]));
    const original = h.db.campaignWorkLedger.detail.bind(h.db.campaignWorkLedger);
    h.db.campaignWorkLedger.detail = (campaign, id, now) => details.get(id) ?? original(campaign, id, now);
    const request = { requestId: "fixed-by-completed", issue: 100, reason: "completed" as const, explanation: "All required units verified", evidence: ["Merged reports"] };
    const ownGap = await h.svc.requestGithubIssueClosure("root", { ...request, requestId: "own-unit-still-queued" });
    assert.ok(ownGap.ok);
    assert.equal(ownGap.data!.decision!.authority, "human", "fixed-by units cannot bypass the target's own queued item");
    const first = [...details.values()][0]!;
    details.set(h.item.id, { ...structuredClone(first), id: h.item.id, issue: target });
    const closure = await h.svc.requestGithubIssueClosure("root", request);
    assert.ok(closure.ok, closure.error ?? "closure requested");
    assert.equal(closure.data!.decision!.authority, "orchestrator");
    const snapshot = closure.data!.decision!.resourceSnapshot;
    assert.equal(snapshot.category, "issue_closure");
    if (snapshot.category !== "issue_closure") return;
    // A gate for the fixed-by target still constrains a cited unit's delivered head.
    first.attempts = [{ id: "unit-attempt", sessionId: "unit-session", startedAt: 1, endedAt: 3 }] as CampaignWorkItemDetail["attempts"];
    const firstVerifications = first.verifications;
    first.verifications = [{ outcome: "delivered", attemptId: "unit-attempt", childSessionId: "unit-session", report: { ts: 3, digest: "d".repeat(64) } }] as CampaignWorkItemDetail["verifications"];
    const originalGates = h.db.consumedPullRequestMerges.bind(h.db);
    h.db.consumedPullRequestMerges = () => [{ sessionId: "unit-session", createdAt: 2, resourceSnapshot: {
      category: "pr_merge", repository: "team/repo", pullRequest: 10, headSha: "e".repeat(40), intendedClosures: ["team/repo#100"],
    } }] as unknown as ReturnType<typeof h.db.consumedPullRequestMerges>;
    assert.equal(closureEvidence(h.db, h.db.getSession("root")!, snapshot), null, "a target-only approval cannot admit a different merged head");
    h.db.consumedPullRequestMerges = originalGates;
    first.verifications = firstVerifications;
    const second = [...details.values()][1]!;
    assert.ok(h.approve(closure.data!.decision!).ok);
    const verified = second.verifications;
    second.verifications = [];
    assert.equal((await h.svc.executeGithubIssueClosure("root", closure.data!.decision!.occurrenceId, closure.data!.decision!.resourceDigest)).ok, false);
    second.verifications = verified;
    const codes = { unverified: "no_delivered_verification", undelivered: "work_item_not_delivered", unmerged: "no_merged_delivery_pull_request",
      missing: "missing_work_item" } as const;
    for (const gap of ["unverified", "undelivered", "unmerged", "missing"] as const) {
      const saved = structuredClone(second);
      if (gap === "unverified") second.verifications = [];
      if (gap === "undelivered") second.primaryState = "queued";
      if (gap === "unmerged") second.observed.pullRequests = [];
      if (gap === "missing") h.db.campaignWorkLedger.detail = (_c, id) => id === second.id ? null : details.get(id) ?? null;
      assert.equal(closureEvidence(h.db, h.db.getSession("root")!, snapshot), null, gap);
      const named = { code: codes[gap], workItemId: second.id };
      assert.deepEqual(gapNames(closureDeliveryGaps(h.db, h.db.getSession("root")!, snapshot, { proven: false, commentSafe: true })), [named], gap);
      const fallback = await h.svc.requestGithubIssueClosure("root", { ...request, requestId: `gap-${gap}` });
      assert.ok(fallback.ok, fallback.error ?? "human fallback");
      assert.equal(fallback.data!.decision!.authority, "human");
      assert.equal(fallback.data!.decision!.authorityEvaluation?.reason, "closure_proof_incomplete", gap);
      const fallbackSnapshot = fallback.data!.decision!.resourceSnapshot;
      assert.ok(fallbackSnapshot.category === "issue_closure");
      assert.deepEqual(gapNames(fallbackSnapshot.deliveryGaps), [named], gap);
      assert.equal(fallbackSnapshot.deliveryFailure, `${codes[gap]}:${second.id}`);
      assert.deepEqual(fallback.data!.proofGaps?.gaps, fallbackSnapshot.deliveryGaps);
      Object.assign(second, saved);
      h.db.campaignWorkLedger.detail = (campaign, id, now) => details.get(id) ?? original(campaign, id, now);
    }
    const lateOwn = h.svc.recordCampaignPlan("root", { items: [{ key: "late-own", issue: target }], planComplete: true });
    assert.ok(lateOwn.ok);
    const lateGap = await h.svc.requestGithubIssueClosure("root", { ...request, requestId: "late-own-unit-queued" });
    assert.ok(lateGap.ok); assert.equal(lateGap.data!.decision!.authority, "human");
    const lateId = lateOwn.data!.items[0]!.workItemId;
    details.set(lateId, { ...structuredClone(first), id: lateId, issue: target });
    const final = await h.svc.requestGithubIssueClosure("root", { ...request, requestId: "fixed-by-final" });
    assert.ok(final.ok); assert.equal(final.data!.decision!.authority, "orchestrator");
    assert.ok(h.approve(final.data!.decision!).ok);
    assert.ok((await h.svc.executeGithubIssueClosure("root", final.data!.decision!.occurrenceId, final.data!.decision!.resourceDigest)).ok);
  } finally { h.db.close(); }
});

test("#4060 an in-scope epic's completed closure is Orchestrator-owned from its closed members, and names any member that is not", async () => {
  const h = harness(true, 5, [100, 101, 102]);
  try {
    const request = { issue: 100, reason: "completed" as const, explanation: "Every member delivered", evidence: ["Members closed"] };
    const ask = (requestId: string, reason: "completed" | "not_planned" = "completed") =>
      h.svc.requestGithubIssueClosure("root", { ...request, reason, requestId });
    const closureSnapshot = (decision: WorkflowDecisionView) => {
      assert.equal(decision.resourceSnapshot.category, "issue_closure");
      return decision.resourceSnapshot as Extract<WorkflowDecisionView["resourceSnapshot"], { category: "issue_closure" }>;
    };
    const member = (number: number, state: IssueClosureEpicMembers["members"][number]["state"]) => ({ number, state });
    // The epic's own work item is a placeholder: it was never dispatched, so it is never a gap here.
    for (const [name, members, code, named] of [
      ["open", [member(101, "completed"), member(102, "open")], "epic_member_open", [102]],
      ["closed otherwise", [member(101, "completed"), member(102, "closed_not_completed")], "epic_member_not_completed", [102]],
      // A member added to the epic after launch counts, and is outside scope until admitted.
      ["added after launch", [member(101, "completed"), member(102, "completed"), member(103, "completed")], "epic_member_outside_scope", [103]],
      ["unreadable member", [member(101, "completed"), member(102, "unreadable")], "epic_member_unreadable", [102]],
    ] as const) {
      h.state.epicMembers = { readable: true, members: [...members] };
      const result = await ask(`epic-${name}`);
      assert.ok(result.ok, result.error ?? name);
      const decision = result.data!.decision!;
      assert.equal(decision.authority, "human", name);
      assert.equal(decision.authorityEvaluation?.reason, "closure_proof_incomplete", name);
      const snapshot = closureSnapshot(decision);
      assert.deepEqual(snapshot.epicMembers, h.state.epicMembers, name);
      assert.deepEqual(snapshot.deliveryGaps?.map((gap) => [gap.code, gap.members, gap.workItemId]), [[code, named, undefined]], name);
      assert.equal(snapshot.deliveryFailure, `${code}:#${named[0]}`, name);
      assert.match(snapshot.deliveryGaps![0]!.summary, new RegExp(`#${named[0]}\\b`), name);
      assert.deepEqual(result.data!.proofGaps?.gaps, snapshot.deliveryGaps, name);
    }
    // A member list the runner could not read is named, and the ordinary snapshot and gaps stand.
    h.state.epicMembers = { readable: false, members: [] };
    const unreadable = await ask("epic-unreadable-list");
    assert.ok(unreadable.ok); assert.equal(unreadable.data!.decision!.authority, "human");
    const ordinary = closureSnapshot(unreadable.data!.decision!);
    assert.equal(ordinary.epicMembers, undefined);
    assert.deepEqual(gapNames(ordinary.deliveryGaps), [{ code: "no_delivered_verification", workItemId: h.item.id },
      { code: "epic_members_unreadable", workItemId: undefined }]);
    // An issue without members behaves as before.
    h.state.epicMembers = { readable: true, members: [] };
    const plain = await ask("no-members");
    assert.ok(plain.ok); assert.equal(plain.data!.decision!.authority, "human");
    assert.equal(closureSnapshot(plain.data!.decision!).epicMembers, undefined);
    assert.deepEqual(gapNames(closureSnapshot(plain.data!.decision!).deliveryGaps), [{ code: "no_delivered_verification", workItemId: h.item.id }]);

    h.state.epicMembers = { readable: true, members: [member(101, "completed"), member(102, "completed")] };
    // An epic item that was dispatched is no placeholder: it still needs its own delivery.
    const original = h.db.campaignWorkLedger.detail.bind(h.db.campaignWorkLedger);
    h.db.campaignWorkLedger.detail = (campaign, id, now) => {
      const item = original(campaign, id, now);
      return item && id === h.item.id ? { ...item, attemptCount: 1 } : item;
    };
    const dispatched = await ask("epic-dispatched-item");
    assert.ok(dispatched.ok); assert.equal(dispatched.data!.decision!.authority, "human");
    assert.deepEqual(gapNames(closureSnapshot(dispatched.data!.decision!).deliveryGaps), [{ code: "no_delivered_verification", workItemId: h.item.id }]);
    h.db.campaignWorkLedger.detail = original;

    // Every member closed as completed and in scope: Orchestrator-owned, with no fixed-by plan.
    const proven = await ask("epic-proven");
    assert.ok(proven.ok, proven.error ?? "epic closure requested");
    const decision = proven.data!.decision!;
    assert.equal(decision.authority, "orchestrator");
    const snapshot = closureSnapshot(decision);
    assert.deepEqual(snapshot.epicMembers, h.state.epicMembers);
    assert.equal(snapshot.forgeDigest, "b".repeat(64), "the snapshot is the member read's inspection");
    assert.ok(snapshot.issueAdmission);
    assert.equal(snapshot.deliveryGaps, undefined);
    const proof = closureEvidence(h.db, h.db.getSession("root")!, snapshot);
    assert.deepEqual(proof && "placeholders" in proof ? proof.placeholders : null, [h.item.id]);
    // A member's state recorded in the snapshot is the proof: an open one never proves it.
    assert.equal(closureEvidence(h.db, h.db.getSession("root")!, { ...snapshot, epicMembers: { readable: true,
      members: [member(101, "completed"), member(102, "open")] } }), null);
    // Not-planned closures never read members.
    const asked = h.state.closureMessages.length;
    const notPlanned = await ask("epic-not-planned", "not_planned");
    assert.ok(notPlanned.ok);
    assert.equal(closureSnapshot(notPlanned.data!.decision!).epicMembers, undefined);
    assert.ok(h.state.closureMessages.slice(asked).every((message) => !(message as { epicMembers?: true }).epicMembers));
    // The proven request superseded every earlier one; approve and execute it, and the runner gets the member read.
    const current = (await ask("epic-proven-again")).data!.decision!;
    assert.equal(current.authority, "orchestrator");
    assert.ok(h.approve(current).ok);
    assert.ok((await h.svc.executeGithubIssueClosure("root", current.occurrenceId, current.resourceDigest)).ok);
    const executed = h.state.closureMessages.at(-1) as { operation: string; snapshot: { epicMembers?: IssueClosureEpicMembers } };
    assert.equal(executed.operation, "execute");
    assert.deepEqual(executed.snapshot.epicMembers, h.state.epicMembers);
  } finally { h.db.close(); }
});

test("#4060 an epic's closure keeps the ordinary proof on a runner without the member read", async () => {
  const h = harness(true, 5, [100, 101, 102]);
  try {
    h.db.registerRunner(h.metadata, 1, RUNNER_CAPABILITY_MIN_PROTOCOL.epicClosureMembers - 1);
    h.state.epicMembers = { readable: true, members: [{ number: 101, state: "completed" }, { number: 102, state: "completed" }] };
    const result = await h.svc.requestGithubIssueClosure("root", { requestId: "old-runner", issue: 100, reason: "completed",
      explanation: "Every member delivered", evidence: ["Members closed"] });
    assert.ok(result.ok, result.error ?? "closure requested");
    assert.equal(result.data!.decision!.authority, "human");
    assert.ok(h.state.closureMessages.every((message) => !(message as { epicMembers?: true }).epicMembers));
  } finally { h.db.close(); }
});

test("scope reads and proposals explain unsupported runner targets without exposing runner error text", async () => {
  const h = harness(false);
  try {
    h.hub.requestFromRunner = async (_runner, requestId, message) => {
      assert.equal(message.type, "campaign_issue_scope");
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: false,
        failure: "unsupported_execution_target", error: "private runner path and credential text" };
    };
    for (const result of [await h.svc.campaignIssueScope("root", 100), await h.proposal("unsupported")]) {
      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.equal(result.error, "Campaign scope requires a valid local or SSH host execution target belonging to its runner. Container and cloud targets are not supported.");
      assert.equal(JSON.stringify(result).includes("private runner"), false);
      assert.equal(JSON.stringify(result).includes("gh authentication"), false);
    }
  } finally { h.db.close(); }
});

test("scope refusals preserve bounded target reasons and safely ignore unknown reasons", async () => {
  for (const [reason, expected] of [
    ["runner_mismatch", "saved execution target does not match its runner"],
    ["unsupported_adapter", "supports only local or SSH host execution targets"],
    ["workspace_mismatch", "saved workspace strategy does not match"],
    ["filesystem_mismatch", "saved filesystem boundary does not match"],
    ["stale_network_policy", "saved network boundary no longer matches"],
    ["unsupported_host_boundaries", "saved secrets or billing boundary is unsupported"],
    ["future_reason", "Campaign scope requires a valid local or SSH"],
    ["__proto__", "Campaign scope requires a valid local or SSH"],
    [undefined, "Campaign scope requires a valid local or SSH"],
  ] as const) {
    const h = harness(false);
    try {
      h.hub.requestFromRunner = async (_runner, requestId, message) => {
        assert.equal(message.type, "campaign_issue_scope");
        return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: false,
          failure: "unsupported_execution_target",
          targetFailureReason: reason as import("@wollipog/protocol").HostExecutionTargetRefusalReason,
          error: "private runner path and credential text" };
      };
      for (const result of [await h.svc.campaignIssueScope("root", 100), await h.proposal("refused")]) {
        assert.equal(result.status, 409, String(reason));
        assert.equal(result.ok, false);
        assert.ok(result.error?.includes(expected), `${reason}: ${result.error}`);
        assert.equal(JSON.stringify(result).includes("private runner"), false);
        assert.equal(JSON.stringify(result).includes("gh authentication"), false);
      }
      assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision, 1);
    } finally { h.db.close(); }
  }
});

test("bounded epic scope records lineage, preserves the authorizing human and revokes outstanding grants atomically", async () => {
  const h = harness();
  try {
    const other = h.svc.createWorkflowDecision("child",{requestId:"question",resourceKey:"question",resourceSnapshot:{category:"implementation_question",question:"Which test?",options:[{optionId:"a",label:"A"},{optionId:"b",label:"B"}]}});
    assert.ok(other.ok,other.error ?? "request");
    const proposed = await h.proposal("members"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    assert.equal(proposed.data!.authority,"orchestrator");
    assert.equal(h.svc.resolveWorkflowDecision("root","root",proposed.data!.occurrenceId,{outcome:"approve"},"orchestrator",{kind:"agent",id:"root"},()=>false).ok,false);
    const result = h.approve(proposed.data!); assert.ok(result.ok,result.error ?? "approval");
    const root = h.db.getSession("root")!;
    assert.deepEqual(root.orchestratorPolicy!.issueNumbers,[100,101]);
    assert.equal(root.orchestratorPolicy!.issueScope!.authorizedByUserId,h.principal.userId);
    assert.equal(root.orchestratorPolicy!.issueScope!.authorizedAt,1);
    assert.equal(root.orchestratorPolicy!.issueScope!.disposition!.bySessionId,"root");
    assert.equal(campaignBoundaryCurrent(root),true);
    const inherited = await h.svc.campaignIssueScope("child");
    assert.deepEqual(inherited.data!.issueNumbers,[100,101]);
    assert.equal((await h.svc.proposeCampaignIssueScope("child",{requestId:"nested",expectedRevision:2,additions:[],removals:[{repository:"team/repo",number:101}],explanation:"Nested removal"})).ok,false);
    assert.equal(result.data!.status,"consumed");
    assert.equal(h.db.workflowDecisionByOccurrence(other.data!.occurrenceId)!.status,"revoked");
    assert.equal(h.approve(proposed.data!).ok,false);
    assert.equal((await h.proposal("stale")).ok,false);
  } finally { h.db.close(); }
});

test("consumed scope changes fence a previously queued recovery turn under its original scope", async () => {
  const h = harness();
  try {
    const sent: unknown[] = [];
    h.hub.sendToRunner = (_id, message) => { sent.push(message); return true; };
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "old-scope-ready", kind: "child_ready", now: 5 });
    h.hub.isRunnerOnline = () => false;
    h.svc.retryDuePrompts(10000);
    const staged = h.db.latestCampaignContinuation("root")!;
    assert.ok(staged);
    const before = h.db.getSessionPromptCommand(staged.commandId)!.payloadJson;
    h.hub.isRunnerOnline = () => true;
    const proposed = await h.proposal("new-members");
    assert.ok(proposed.ok, proposed.error ?? "scope proposal refused");
    assert.ok(h.approve(proposed.data!).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(proposed.data!.occurrenceId)!.status, "consumed");
    assert.equal(campaignBoundaryCurrent(h.db.getSession("root")!), true, "new scope is valid for future exact admissions");
    h.db.updateSessionStatus("root", "idle", 20000);
    h.svc.retryDuePrompts(30000);
    assert.equal(sent.some(m => (m as {commandId?:string}).commandId === staged.commandId), false,
      "scope consumption does not rebind an old staged turn");
    assert.equal(h.db.getSessionPromptCommand(staged.commandId)!.payloadJson, before);
    assert.equal(h.db.campaignProjection("root")!.recovery!.automation!.state, "authority_unavailable");
  } finally { h.db.close(); }
});

test("scope rejects incidental references, unapproved epics, foreign repositories, oversized scope and affected-work races", async () => {
  const h = harness();
  try {
    assert.equal((await h.proposal("dependency",999)).ok,false);
    for (const change of [{lineage:{kind:"epic" as const,epic:999}},{additions:[{repository:"other/repo",number:101}]}]) {
      assert.equal((await h.svc.proposeCampaignIssueScope("root", {requestId:JSON.stringify(change),expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Claim",lineage:{kind:"epic",epic:100},...change})).ok,false);
    }
    // Without lineage nothing is admitted: the addition waits for the owner (#4267).
    const unadmitted = await h.svc.proposeCampaignIssueScope("root", {requestId:"no-lineage",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Claim"});
    assert.ok(unadmitted.ok, unadmitted.error ?? "refused"); assert.equal(unadmitted.data!.authority,"human");
    const p = await h.proposal("race"); assert.ok(p.ok);
    h.db.createSession({id:"later",runnerId:"r",workspaceId:"w",agentId:"codex",title:"Later",parentSessionId:"root",driver:"codex-app-server",config:{},useWorktree:false,now:Date.now()});
    assert.equal(h.approve(p.data!).ok,false);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers,[100]);
  } finally { h.db.close(); }
  const limited = harness(true,1);
  try { assert.equal((await limited.proposal("capacity")).ok,false); } finally { limited.db.close(); }
});

/** Deliver the next campaign continuation the idle root is woken with, if any: its text, and
 * whether a prompt event woke it. The delivery completes, so a later one can follow. */
function nextContinuation(h: ReturnType<typeof harness>): { text: string; prompt: boolean } | null {
  h.db.updateSessionStatus("root", "idle", Date.now());
  const prompt = h.db.campaignContinuationPromptEventAt("root") !== null;
  const sent: Array<{ type: string; requestId?: string; commandId?: string; command?: { type: string; text?: string; campaignContinuation?: unknown } }> = [];
  h.hub.sendToRunner = (_id, message) => { sent.push(message as (typeof sent)[number]); return true; };
  h.svc.retryDuePrompts(Date.now() + 120_000);
  h.hub.sendToRunner = () => true;
  const delivery = sent.find((message) => message.type === "durable_session_command" && message.command?.campaignContinuation);
  if (!delivery) return null;
  assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_result", requestId: delivery.requestId!,
    commandId: delivery.commandId!, sessionId: "root", state: "accepted", revision: 1, duplicate: false }));
  assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update", commandId: delivery.commandId!,
    sessionId: "root", state: "completed", revision: 2 }));
  return { text: delivery.command!.text!, prompt };
}

function requiredContinuation(h: ReturnType<typeof harness>): { text: string; prompt: boolean } {
  const continuation = nextContinuation(h);
  assert.ok(continuation, "a continuation was delivered");
  return continuation;
}

function revocationAudit(h: ReturnType<typeof harness>, sessionId: string, occurrenceId: string) {
  const entries = h.db.listGovernanceAudit(sessionId).filter((entry) => entry.requestId === occurrenceId && entry.outcome === "revoked");
  assert.equal(entries.length, 1);
  return entries[0]!;
}

test("#3916 a person's scope approval refused as stale is the system's revocation, with its reason and the person as trigger", async () => {
  const h = harness(false);
  try {
    const proposed = await h.proposal("stale-human"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    const occurrenceId = proposed.data!.occurrenceId;
    assert.equal(proposed.data!.authority, "human");
    nextContinuation(h);
    h.db.updateSessionStatus("root", "running", Date.now());
    // Affected child work changes while the request waits for the person.
    h.db.createSession({ id: "later", runnerId: "r", workspaceId: "w", agentId: "codex", title: "Later", parentSessionId: "root",
      driver: "codex-app-server", config: {}, useWorktree: false, now: Date.now() });
    const refused = h.approve(proposed.data!);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.equal(h.db.workflowDecisionByOccurrence(occurrenceId)!.status, "revoked");

    const resolution = h.db.campaignRequestResolution("root", campaignRequestToken("typed", "root", occurrenceId));
    assert.deepEqual({ outcome: resolution?.outcome, resolvedBy: resolution?.resolvedBy,
      revocationReason: resolution?.revocationReason, triggeredBy: resolution?.triggeredBy },
    { outcome: "revoked", resolvedBy: "system", revocationReason: "approval_refused_stale", triggeredBy: "human" });
    const audit = revocationAudit(h, "root", occurrenceId);
    assert.deepEqual(audit.actor, { kind: "system", id: "approval_refused_stale" });
    assert.deepEqual(audit.workflowDecision?.revocation,
      { reason: "approval_refused_stale", triggeredBy: { kind: "human", id: h.principal.userId } });

    const { text, prompt } = requiredContinuation(h);
    assert.match(text, new RegExp(`"kind":"request_resolved",.*"occurrenceId":"${occurrenceId}","owner":"human",.*` +
      `"outcome":"revoked","resolvedBy":"system","revocationReason":"approval_refused_stale","triggeredBy":"human"`, "u"));
    assert.doesNotMatch(text, /"resolvedBy":"human"/u, "the person approved; they did not revoke it");
    assert.equal(prompt, true, "a refused human approval wakes the Orchestrator as promptly as the approval would have");
    assert.match(text, /Action needed: yes/u);
  } finally { h.db.close(); }
});

test("#3916 decisions a person's scope approval revokes are reported as the system's, superseded by that change", async () => {
  const h = harness(false);
  try {
    const other = h.svc.createWorkflowDecision("child", { requestId: "question", resourceKey: "question",
      resourceSnapshot: { category: "implementation_question", question: "Which test?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(other.ok, other.error ?? "question");
    assert.equal(other.data!.authority, "human");
    const proposed = await h.proposal("side-effect"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    nextContinuation(h);
    h.db.updateSessionStatus("root", "running", Date.now());
    assert.ok(h.approve(proposed.data!).ok);
    const occurrenceId = other.data!.occurrenceId;
    assert.equal(h.db.workflowDecisionByOccurrence(occurrenceId)!.status, "revoked");

    const resolution = h.db.campaignRequestResolution("root", campaignRequestToken("typed", "child", occurrenceId));
    assert.deepEqual({ outcome: resolution?.outcome, resolvedBy: resolution?.resolvedBy,
      revocationReason: resolution?.revocationReason, triggeredBy: resolution?.triggeredBy },
    { outcome: "revoked", resolvedBy: "system", revocationReason: "superseded_by_scope_change", triggeredBy: "human" });
    const audit = revocationAudit(h, "child", occurrenceId);
    assert.deepEqual(audit.actor, { kind: "system", id: "superseded_by_scope_change" });
    assert.deepEqual(audit.workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });

    const { text } = requiredContinuation(h);
    assert.match(text, new RegExp(`"kind":"request_resolved",.*"occurrenceId":"${occurrenceId}","owner":"human",.*` +
      `"outcome":"revoked","resolvedBy":"system","revocationReason":"superseded_by_scope_change","triggeredBy":"human"`, "u"));
    assert.match(text, new RegExp(`"occurrenceId":"${proposed.data!.occurrenceId}","owner":"human",.*"outcome":"allowed","resolvedBy":"human"`, "u"),
      "the person's own approval is still theirs");
  } finally { h.db.close(); }
});

test("#3916 decisions the Orchestrator's own scope approval revokes record it as the trigger and do not wake it", async () => {
  const h = harness();
  try {
    const other = h.svc.createWorkflowDecision("child", { requestId: "question", resourceKey: "question",
      resourceSnapshot: { category: "implementation_question", question: "Which test?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(other.ok, other.error ?? "question");
    const proposed = await h.proposal("orchestrator-side-effect"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    assert.equal(proposed.data!.authority, "orchestrator");
    const eventsBefore = h.db.campaignContinuationEvents("root").length;
    assert.ok(h.approve(proposed.data!).ok);
    const occurrenceId = other.data!.occurrenceId;
    const token = campaignRequestToken("typed", "child", occurrenceId);
    const resolution = h.db.campaignRequestResolution("root", token);
    assert.deepEqual({ resolvedBy: resolution?.resolvedBy, revocationReason: resolution?.revocationReason, triggeredBy: resolution?.triggeredBy },
      { resolvedBy: "system", revocationReason: "superseded_by_scope_change", triggeredBy: "orchestrator" });
    assert.deepEqual(revocationAudit(h, "child", occurrenceId).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "agent", id: "root" } });
    assert.equal(h.db.campaignContinuationEvents("root").slice(eventsBefore)
      .some((event) => event.kind === "request_resolved" && event.occurrenceId === token), false,
    "the Orchestrator caused it and already has the result");
  } finally { h.db.close(); }
});

test("#3916 a person's denial of a scope change is still reported as theirs, with no revocation reason", async () => {
  const h = harness(false);
  try {
    const proposed = await h.proposal("human-denial"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    const occurrenceId = proposed.data!.occurrenceId;
    nextContinuation(h);
    h.db.updateSessionStatus("root", "running", Date.now());
    assert.ok(h.svc.resolveWorkflowDecision("root", "root", occurrenceId, { outcome: "deny" }, "human",
      { kind: "human", id: h.principal.userId }, () => true).ok);
    const resolution = h.db.campaignRequestResolution("root", campaignRequestToken("typed", "root", occurrenceId));
    assert.equal(resolution?.resolvedBy, "human");
    assert.equal(resolution?.outcome, "denied");
    assert.equal(resolution?.revocationReason, undefined);
    assert.equal(resolution?.triggeredBy, undefined);
    const { text, prompt } = requiredContinuation(h);
    assert.match(text, new RegExp(`"occurrenceId":"${occurrenceId}","owner":"human",.*"outcome":"denied","resolvedBy":"human"\\}`, "u"));
    assert.equal(prompt, true);
  } finally { h.db.close(); }
});

test("Custom scope and closure stay human-owned, and old peers cannot execute the bounded issue contract", async () => {
  const h = harness(false);
  try {
    const p = await h.proposal("custom"); assert.ok(p.ok,p.error ?? "proposal"); assert.equal(p.data!.authority,"human");
    assert.ok(h.approve(p.data!).ok);
    const c = await h.svc.requestGithubIssueClosure("root",{requestId:"custom-closure",issue:100,reason:"completed",explanation:"Claim",evidence:["Claim"]});
    assert.ok(c.ok,c.error ?? "closure"); assert.equal(c.data!.decision!.authority,"human");
  } finally { h.db.close(); }
  for (const version of [215, 216]) {
    const older = harness();
    try {
      older.db.raw().prepare("UPDATE runners SET protocol_version=? WHERE runner_id='r'").run(version);
      assert.equal((await older.proposal(`old-${version}`)).ok,false);
    } finally { older.db.close(); }
  }
});

const body = "## Problem\nRelated failure\n## Proposed Behavior\nRepair it\n## Acceptance Criteria\n- Verified repair\n## Security and Compatibility\nNone";

async function consumedPublication(h: ReturnType<typeof harness>, title = "Lifecycle repair", issue = 101) {
  const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
  assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
  const result=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:`publish-${title}`,resourceKey:"publication",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
    sanitizedTitle:title,sanitizedBody:body,labels:[],recommendationId:rec.data!.id}}); assert.ok(result.ok);
  const decision=result.data!; assert.equal(decision.authority,"orchestrator"); assert.ok(h.approve(decision).ok);
  assert.ok((await h.svc.consumeWorkflowDecision("root",decision.occurrenceId,{resourceSnapshot:decision.resourceSnapshot})).ok);
  h.state.publicationTitles[issue]=title;
  assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Published payload read back",
    resultingWorkItemKey:`followup:${rec.data!.id}`,resultingIssue:{repository:"team/repo",number:issue}}).ok);
  return {decision,recommendationId:rec.data!.id};
}

test("compatible reauthorization can admit an earlier consumed publication exactly once", async () => {
  const h=harness(true,3);
  try {
    const p=await consumedPublication(h);
    assert.ok(h.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:["campaign_issue_scope","follow_up_issue_publication"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:3,closureReasons:[]}},2,h.principal).ok);
    const scope=await h.svc.proposeCampaignIssueScope("root",{requestId:"renewed-publication",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Compatible original publication authority",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}}); assert.ok(scope.ok,scope.error ?? "renewed scope"); assert.ok(h.approve(scope.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),101);
    h.state.publicationTitles[102]="Lifecycle repair";
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:p.recommendationId,disposition:"accepted",reason:"Duplicate payload claim",
      resultingWorkItemKey:`duplicate:${p.recommendationId}`,resultingIssue:{repository:"team/repo",number:102}}).ok);
    const reuse=await h.svc.proposeCampaignIssueScope("root",{requestId:"reuse-lineage",expectedRevision:2,additions:[{repository:"team/repo",number:102}],removals:[],explanation:"Same payload on another issue",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}});
    assert.equal(reuse.ok,false); assert.match(reuse.error ?? "",/unused|already/);
  } finally {h.db.close();}
});

test("reauthorization counts reservations, while fresh human verified scope settles an earlier publication", async () => {
  const h=harness(true,2);
  try {
    const p=await consumedPublication(h);
    const other=(requestId:string)=>h.svc.proposeCampaignIssueScope("root",{requestId,expectedRevision:1,additions:[{repository:"team/repo",number:999}],removals:[],explanation:"Human adds separate scope"},()=>true,h.principal);
    // A Human approval re-mints the boundary (#2940) only within its issue limit, which counts the
    // consumed publication's slot: one scoped issue, that held slot and #999 would make three.
    const added=await other("human-other"); assert.ok(added.ok);
    const refused=h.approve(added.data!); assert.equal(refused.ok,false);
    assert.match(refused.error!,/give the campaign 3 issues, counting 1 published follow-up not yet in scope, more than the 2/);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers,[100]);
    const proposal={mode:"full_control" as const,objective:"Implement epic 100",operations:["campaign_issue_scope","follow_up_issue_publication"] as Array<"campaign_issue_scope"|"follow_up_issue_publication">,delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:2,closureReasons:[]}};
    assert.ok(h.svc.setCampaignControl("root",{...proposal,issueAuthority:{...proposal.issueAuthority,maxIssues:3}},2,h.principal).ok);
    const readded=await other("human-other-again"); assert.ok(readded.ok,readded.error ?? "proposal"); assert.ok(h.approve(readded.data!).ok);
    // Right after the Human approval, the re-minted boundary holds the scope and every held slot.
    const root=h.db.getSession("root")!;
    const boundary=(root.orchestratorPolicy!.control as Extract<CampaignControl,{mode:"full_control"}>).boundary;
    assert.equal(campaignBoundaryCurrent(root),true); assert.equal(root.parentControlPolicy!.revision,4);
    assert.equal(root.orchestratorPolicy!.issueNumbers!.length+h.db.unsettledPublicationSlots("root"),3);
    assert.ok(root.orchestratorPolicy!.issueNumbers!.length+h.db.unsettledPublicationSlots("root")<=boundary.issueAuthority!.maxIssues);
    assert.equal(h.svc.setCampaignControl("root",proposal,4,h.principal).error,"The issue boundary exceeds its human-set scope limit.","scope plus the consumed unscoped slot exceeds two");
    // Adopting the published issue itself settles its slot, so it fits the same limit.
    const direct=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-published",expectedRevision:2,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Human explicitly adopts the verified publication"},()=>true,h.principal);
    assert.ok(direct.ok,direct.error ?? "human publication scope"); assert.equal(direct.data!.authority,"human");
    const adopted=h.approve(direct.data!); assert.ok(adopted.ok,adopted.error ?? "adoption");
    assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),101,"independent read-back and human consumption settle the slot");
  } finally {h.db.close();}
});

test("a changed objective cannot inherit old publication authority automatically", async () => {
  const h=harness(true,2);
  try {
    const p=await consumedPublication(h);
    assert.ok(h.svc.setCampaignControl("root",{mode:"full_control",objective:"A different objective",operations:["campaign_issue_scope","follow_up_issue_publication"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:2,closureReasons:[]}},2,h.principal).ok);
    const scope=await h.svc.proposeCampaignIssueScope("root",{requestId:"changed-objective",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Old authority cannot grant the new objective",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}});
    assert.equal(scope.ok,false); assert.match(scope.error ?? "",/human\/objective/);
  } finally {h.db.close();}
});

test("reauthorization excludes pending publication slots that it atomically revokes", async () => {
  const h=harness(true,2);
  try {
    const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Pending repair",originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
    const pending=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"pending-slot",resourceKey:"publication",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
      sanitizedTitle:"Pending repair",sanitizedBody:body,labels:[],recommendationId:rec.data!.id}}); assert.ok(pending.ok); assert.ok(h.approve(pending.data!).ok);
    const changed=h.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:["campaign_issue_scope","follow_up_issue_publication"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:1,closureReasons:[]}},2,h.principal);
    assert.ok(changed.ok,changed.error ?? "reauthorization");
    assert.equal(h.db.workflowDecisionByOccurrence(pending.data!.occurrenceId)!.status,"revoked");
  } finally {h.db.close();}
});

test("human verified scope settles a consumed publication without delegated admission", async () => {
  const h=harness(true,2);
  try {
    const p=await consumedPublication(h);
    const held=()=>h.db.getSession("root")!.orchestratorPolicy!.issueNumbers!.length+h.db.unsettledPublicationSlots("root");
    // A follow-up lineage the caller names settles nothing by itself (#2940): unrelated #999 claiming
    // the publication carries no verified payload or issue admission, so its slot still counts.
    const claimed=await h.svc.proposeCampaignIssueScope("root",{requestId:"claimed-lineage",expectedRevision:1,additions:[{repository:"team/repo",number:999}],removals:[],
      explanation:"An unrelated issue claiming the publication",lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}},()=>true,h.principal);
    assert.ok(claimed.ok,claimed.error ?? "claimed lineage proposal"); assert.equal(claimed.data!.authority,"human");
    const claim=claimed.data!.resourceSnapshot as Extract<WorkflowDecisionView["resourceSnapshot"],{category:"campaign_issue_scope"}>;
    assert.equal(claim.verifiedPublications,undefined); assert.equal(claim.issueAdmission,undefined);
    const refused=h.approve(claimed.data!); assert.equal(refused.ok,false);
    assert.match(refused.error!,/give the campaign 3 issues, counting 1 published follow-up not yet in scope, more than the 2/);
    assert.equal(held(),2); assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),null);
    assert.ok(h.svc.resolveWorkflowDecision("root","root",claimed.data!.occurrenceId,{outcome:"deny"},"human",{kind:"human",id:h.principal.userId},()=>true).ok);
    const direct=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-settlement",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Human adopts the exact published payload"},()=>true,h.principal);
    assert.ok(direct.ok); assert.equal(direct.data!.authority,"human"); assert.ok(h.approve(direct.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),101);
    assert.ok(held()<=2,"scope and held slots never exceed the limit");
  } finally {h.db.close();}
});

test("one consumed publication cannot admit a second issue with copied payload", async () => {
  const h=harness(true,3);
  try {
    const p=await consumedPublication(h);
    const first=await h.svc.proposeCampaignIssueScope("root",{requestId:"first-lineage",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Verified publication",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}}); assert.ok(first.ok); assert.ok(h.approve(first.data!).ok);
    h.state.publicationTitles[102]="Lifecycle repair";
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:p.recommendationId,disposition:"accepted",reason:"Copied payload claim",
      resultingWorkItemKey:`copy:${p.recommendationId}`,resultingIssue:{repository:"team/repo",number:102}}).ok);
    const second=await h.svc.proposeCampaignIssueScope("root",{requestId:"second-lineage",expectedRevision:2,additions:[{repository:"team/repo",number:102}],removals:[],explanation:"Copied exact payload",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}});
    assert.equal(second.ok,false); assert.match(second.error ?? "",/unused|already/);
  } finally {h.db.close();}
});

test("non-delegatable recommendation metadata and closure comments retain human review", async () => {
  const h=harness(false);
  try {
    const result=await h.svc.createWorkflowDecisionWithVideo("child",{requestId:"custom-recommendation",resourceKey:"custom-pub",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
      sanitizedTitle:"Custom review",sanitizedBody:body,labels:[],recommendationId:"claim-only"}});
    assert.ok(result.ok,result.error ?? "custom request"); assert.equal(result.data!.authority,"human");
  } finally {h.db.close();}
  const full=harness();
  try {
    const result=await full.svc.requestGithubIssueClosure("root",{requestId:"comment-review",issue:100,reason:"completed",explanation:"Owner reviews the exact comment",evidence:["Human review"],comment:"Contact support@example.invalid"});
    assert.ok(result.ok,result.error ?? "human comment"); assert.equal(result.data!.decision!.authority,"human");
  } finally {full.db.close();}
});

test("publication requires an accepted unique related recommendation, exact sanitized payload, fresh duplicates and one-shot capacity", async () => {
  const h = harness();
  try {
    const record = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Related repair",originWorkItemIds:[h.item.id]});
    assert.ok(record.ok,record.error ?? "record");
    const id = record.data!.id;
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:id,disposition:"accepted",reason:"Same objective, observed regression",publicationRequired:true}).ok);
    const snapshot = {category:"follow_up_issue_publication" as const,repository:"team/repo",sanitizedTitle:"Related repair",sanitizedBody:body,labels:[],recommendationId:id};
    const privatePayload=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"secret",resourceKey:"secret",resourceSnapshot:{...snapshot,sanitizedBody:body+"\napi_key=secret-value"}});
    assert.ok(privatePayload.ok); assert.equal(privatePayload.data!.authority,"human","unsafe content never gains standing admission");
    h.state.publicationOk=false;
    const duplicate=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"duplicate",resourceKey:"pub",resourceSnapshot:snapshot});
    assert.ok(duplicate.ok); assert.equal(duplicate.data!.authority,"human");
    h.state.publicationOk=true;
    const p = await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"publication",resourceKey:"pub",resourceSnapshot:snapshot}); assert.ok(p.ok,p.error ?? "publication");
    assert.equal(h.svc.createWorkflowDecision("root",{requestId:"spoof-admission",resourceKey:"spoof",resourceSnapshot:p.data!.resourceSnapshot}).status,403,
      "an echo of server admission cannot be supplied to generic create");
    assert.equal(p.data!.authority,"orchestrator"); assert.ok(h.approve(p.data!).ok);
    h.state.publicationOk=false;
    assert.equal((await h.svc.consumeWorkflowDecision("root",p.data!.occurrenceId,{resourceSnapshot:p.data!.resourceSnapshot})).ok,false);
    h.state.publicationOk=true;
    assert.ok((await h.svc.consumeWorkflowDecision("root",p.data!.occurrenceId,{resourceSnapshot:p.data!.resourceSnapshot})).ok);
    const replay=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"replay-pub",resourceKey:"pub",resourceSnapshot:snapshot});
    assert.deepEqual([replay.ok,replay.status,replay.errorDetails?.code],[false,409,"recommendation_spent"],"spent recommendations never mint another standing grant");
    assert.equal(h.db.workflowDecisionByRequestId("root","replay-pub"),null);
  } finally { h.db.close(); }
});

const bugBody = "## Problem\nRelated failure\n## Reproduction Steps\n1. Run it\n## Actual Behavior\nFails\n## Expected Behavior\nPasses\n## Environment\nLinux\n## Acceptance Criteria\n- Verified repair";

function acceptedRecommendation(h: ReturnType<typeof harness>, title = "Related repair") {
  const record = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]});
  assert.ok(record.ok,record.error ?? "record");
  assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:record.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
  return record.data!.id;
}

// #2940, observed live: Full Control children drafted accepted follow-ups and requested them with
// their recommendationId. The issue-form "[Bug]: " prefix and the child requester each refused
// admission silently, so the person was asked to approve in-boundary publications.
test("a child's accepted, in-scope publication with an issue-form title prefix is Orchestrator-owned and consumable (#2940)", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    for (const [requestId, title, issueBody, labels] of [["feature-form", "[Feature]: Related repair", body, ["enhancement", "UI"]], ["bug-form", "[Bug]: Related repair", bugBody, ["bug"]]] as const) {
      const snapshot = {category:"follow_up_issue_publication" as const,repository:"team/repo",sanitizedTitle:title,sanitizedBody:issueBody,labels:[...labels],recommendationId};
      const p = await h.svc.createWorkflowDecisionWithVideo("child",{requestId,resourceKey:requestId,resourceSnapshot:snapshot});
      assert.ok(p.ok,p.error ?? requestId);
      const decision = p.data!;
      assert.equal(decision.controllingSessionId,"root");
      assert.equal(decision.authority,"orchestrator",JSON.stringify(decision.authorityEvaluation));
      assert.deepEqual([decision.authorityEvaluation?.basis,decision.authorityEvaluation?.reason],["campaign_delegation","authorized_operation"]);
      assert.equal(decision.authorityEvaluation?.admissionFailure,undefined);
      assert.ok(decision.resourceSnapshot.category === "follow_up_issue_publication" && decision.resourceSnapshot.recommendationId === recommendationId &&
        decision.resourceSnapshot.issueAdmission, "the recommendation lineage and server admission are retained");
      if (requestId === "bug-form") {
        assert.ok(h.svc.resolveWorkflowDecision("root","child",decision.occurrenceId,{outcome:"approve"},"orchestrator",{kind:"agent",id:"root"},()=>true).ok);
        const consumed = await h.svc.consumeWorkflowDecision("child",decision.occurrenceId,{resourceSnapshot:decision.resourceSnapshot});
        assert.ok(consumed.ok,consumed.error ?? "consume");
      }
    }
    const replay = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:"replay",resourceKey:"replay",
      resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:"Related repair",sanitizedBody:body,labels:[],recommendationId}});
    assert.deepEqual([replay.ok,replay.status,replay.errorDetails?.code],[false,409,"recommendation_spent"],
      "a consumed recommendation never mints a second standing grant, nor asks a person to approve it (#4065)");
    assert.equal(h.db.workflowDecisionByRequestId("child","replay"),null);
  } finally { h.db.close(); }
});

test("every bounded publication needs a runner whose duplicate search and comparison ignore the tag (#2940)", async () => {
  // An older runner keeps the tag on both sides of its duplicate check. A tagged title can hide an
  // older untagged issue from its search; an untagged one misses an existing "[Bug]: Subject"
  // issue in its comparison. Either way its successful inspection proves no deduplication.
  for (const [recommendationTitle, payloadTitle] of [["Related repair", "[Bug]: Related repair"], ["[Bug]: Related repair", "Related repair"]] as const) {
    const h = harness();
    try {
      const recommendationId = acceptedRecommendation(h, recommendationTitle);
      const request = (requestId: string) => h.svc.createWorkflowDecisionWithVideo("child",{requestId,resourceKey:requestId,
        resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:payloadTitle,sanitizedBody:body,labels:[],recommendationId}});
      h.state.subjectSearch = false;
      const older = await request("older-runner");
      assert.ok(older.ok,payloadTitle); assert.equal(older.data!.authority,"human",payloadTitle);
      assert.equal(older.data!.authorityEvaluation?.admissionFailure,"inspection_failed",payloadTitle);
      h.state.subjectSearch = true;
      const current = await request("subject-runner");
      assert.ok(current.ok,payloadTitle); assert.equal(current.data!.authority,"orchestrator",payloadTitle);
      assert.ok(h.svc.resolveWorkflowDecision("root","child",current.data!.occurrenceId,{outcome:"approve"},"orchestrator",{kind:"agent",id:"root"},()=>true).ok);
      h.state.subjectSearch = false;
      assert.equal((await h.svc.consumeWorkflowDecision("child",current.data!.occurrenceId,{resourceSnapshot:current.data!.resourceSnapshot})).ok,false,
        `${payloadTitle}: consumption after a runner downgrade repeats the requirement`);
      h.state.subjectSearch = true;
      assert.ok((await h.svc.consumeWorkflowDecision("child",current.data!.occurrenceId,{resourceSnapshot:current.data!.resourceSnapshot})).ok,payloadTitle);
    } finally { h.db.close(); }
  }
});

test("a child's publication outside the proof is refused when it can correct it, and otherwise routes to the person with a visible admission failure (#2940, #4065)", async () => {
  const cases: Array<{ name: string; expected: string; refused: boolean; maximum?: number; setup?: (h: ReturnType<typeof harness>) => string;
    change?: (snapshot: { sanitizedTitle: string; sanitizedBody: string; labels: string[]; recommendationId: string }) => void }> = [
    { name: "forged", expected: "recommendation_not_found", refused: true, setup: () => "followup_forged" },
    { name: "unaccepted", expected: "recommendation_not_accepted", refused: true, setup: (h) => {
      const record = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Related repair",originWorkItemIds:[h.item.id]});
      assert.ok(record.ok); return record.data!.id;
    } },
    { name: "other title", expected: "title_mismatch", refused: true, change: (s) => { s.sanitizedTitle = "[Bug]: A different repair"; } },
    { name: "unsafe", expected: "unsafe_payload", refused: false, change: (s) => { s.sanitizedBody += "\napi_key=secret-value"; } },
    { name: "duplicate labels", expected: "unsafe_payload", refused: false, change: (s) => { s.labels = ["bug", "bug"]; } },
    { name: "over cap", expected: "capacity_exhausted", refused: false, maximum: 1 },
  ];
  for (const c of cases) {
    const h = harness(true, c.maximum ?? 5);
    try {
      const recommendationId = c.setup ? c.setup(h) : acceptedRecommendation(h);
      const snapshot = { sanitizedTitle: "[Feature]: Related repair", sanitizedBody: body, labels: ["enhancement"], recommendationId };
      c.change?.(snapshot);
      const p = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:c.name,resourceKey:c.name,
        resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",...snapshot}});
      if (c.refused) {
        assert.deepEqual([p.ok,p.status,p.errorDetails?.code],[false,409,c.expected],c.name);
        assert.equal(p.error,CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES[c.expected as CampaignPublicationAdmissionFailure],c.name);
        assert.ok(p.error!.startsWith(`${c.expected}: `) && p.error!.includes("Nothing was created"),c.name);
        assert.equal(h.db.workflowDecisionByRequestId("child",c.name),null,`${c.name}: a refusal creates no decision`);
        assert.equal(h.db.getSession("child")!.pendingApproval ?? null,null,`${c.name}: nobody is asked`);
        assert.equal(h.db.campaignPublicationReservations("root").length,0,`${c.name}: nothing is reserved`);
        continue;
      }
      assert.ok(p.ok,`${c.name}: ${p.error}`);
      assert.equal(p.data!.authority,"human",c.name);
      assert.equal(p.data!.authorityEvaluation?.admissionFailure,c.expected,c.name);
      assert.equal(p.data!.authorityEvaluation?.admissionMessage,CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES[c.expected as CampaignPublicationAdmissionFailure],c.name);
      assert.ok(p.data!.resourceSnapshot.category === "follow_up_issue_publication" && p.data!.resourceSnapshot.recommendationId === recommendationId &&
        !p.data!.resourceSnapshot.issueAdmission, `${c.name}: an unproven claim is kept as sent (#3918) and carries no admission`);
      if (c.expected === "capacity_exhausted") assert.match(p.data!.authorityEvaluation!.admissionMessage!,
        /Maximum Issues.*Only the person who authorized Full Control can raise it: in Campaign Status.*An Orchestrator can't raise it\./u,
        "the recorded text names the limit and the owner's route, as the scope refusal does");
    } finally { h.db.close(); }
  }
  const failedInspection = harness();
  try {
    const recommendationId = acceptedRecommendation(failedInspection);
    failedInspection.state.publicationOk = false;
    const p = await failedInspection.svc.createWorkflowDecisionWithVideo("child",{requestId:"duplicate",resourceKey:"duplicate",
      resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:"Related repair",sanitizedBody:body,labels:[],recommendationId}});
    assert.ok(p.ok); assert.equal(p.data!.authority,"human");
    assert.equal(p.data!.authorityEvaluation?.admissionFailure,"inspection_failed");
  } finally { failedInspection.db.close(); }
});

const publicationRefusalRecord = (h: ReturnType<typeof harness>, sessionId = "child") =>
  h.db.campaignProjection("root")!.recovery?.records.find(item => item.resource.sessionId === sessionId && item.action === "reformulate_request");

// #4065, observed live: a child's title differed from the accepted recommendation's, so a person
// was asked to approve a payload the Orchestrator could have reviewed after a one-line correction.
test("#4065 a child's title mismatch creates nothing, reaches the root as recovery, and the corrected request is the Orchestrator's", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    h.db.updateSessionStatus("root", "idle", 3);
    const request = (title: string) => h.svc.createWorkflowDecisionWithVideo("child", { requestId: "publish", resourceKey: "publish",
      resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: title, sanitizedBody: body,
        labels: ["enhancement"], recommendationId } });
    const eventsBefore = h.db.campaignContinuationEvents("root").length;
    const refused = await request("[Feature]: Related repairs");
    assert.deepEqual([refused.ok, refused.status, refused.errorDetails?.code], [false, 409, "title_mismatch"]);
    assert.match(refused.error!, /^title_mismatch: .*Use that title exactly.*Nothing was created\.$/u);
    assert.equal(h.db.workflowDecisionByRequestId("child", "publish"), null, "no decision is created");
    assert.equal(h.db.getSession("child")!.pendingApproval ?? null, null, "nobody is notified with a request");
    assert.equal(h.db.campaignProjection("root")!.pendingRequests?.human ?? 0, 0);
    // The root learns of it the way it learns of other child requests that need it: a recovery
    // record whose wake is a request_actionable continuation event.
    const record = publicationRefusalRecord(h)!;
    assert.ok(record, "the refusal is recorded for the root");
    assert.deepEqual([record.reason, record.effectiveOwner, record.admissionFailure, record.requiredInput],
      ["correctable_refusal", "orchestrator", "title_mismatch", "none"]);
    assert.equal(record.state, "dispatched");
    assert.ok(record.explanation.includes(CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES.title_mismatch));
    assert.deepEqual(h.db.campaignContinuationEvents("root").slice(eventsBefore).map((event) => [event.kind, event.subjectSessionId, event.occurrenceId]),
      [["request_actionable", "child", record.id]]);
    // The same requestId, corrected, is admitted and owned by the Orchestrator; the refusal settles.
    const corrected = await request("[Feature]: Related repair");
    assert.ok(corrected.ok, corrected.error ?? "corrected");
    assert.equal(corrected.data!.authority, "orchestrator");
    assert.equal(corrected.data!.authorityEvaluation?.admissionFailure, undefined);
    const settled = publicationRefusalRecord(h);
    assert.ok(!settled || settled.state === "resolved", "the corrected request settles the refusal");
    assert.equal(h.db.campaignRecovery.publicationRefusals("root", h.db.getSession("root")!.parentControlPolicy?.revision ?? 0).length, 0);
  } finally { h.db.close(); }
});

// #2938 criterion 2: the reformulate_request recovery action is emitted and reaches the root as an
// actionable instruction naming the member and the condition to correct, never the member's text.
test("#2938 a member's correctable refusal wakes the root with an actionable reformulate_request instruction", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    h.db.updateSessionStatus("root", "idle", 3);
    const refused = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "publish", resourceKey: "publish",
      resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "[Feature]: Mistitled repairs",
        sanitizedBody: body, labels: [], recommendationId } });
    assert.equal(refused.errorDetails?.code, "title_mismatch");
    const record = publicationRefusalRecord(h)!;
    const wake = nextContinuation(h);
    assert.ok(wake, "the refusal wakes the idle root");
    assert.match(wake.text, /Action needed: yes/u);
    for (const fact of [`"recoveryId":"${record.id}"`, `"action":"reformulate_request"`, `"reason":"correctable_refusal"`,
      `"admissionFailure":"title_mismatch"`, `"sessionId":"child"`, `"pending":true`]) {
      assert.ok(wake.text.includes(fact), `the instruction carries ${fact}`);
    }
    assert.equal(wake.text.includes("Mistitled"), false, "the member's refused payload is not repeated to the root");
  } finally { h.db.close(); }
});

test("#4065 each correctable failure is refused with its own condition, and the root's own refusal is not recorded as a child's", async () => {
  const h = harness();
  try {
    const publish = (sessionId: string, requestId: string, recommendationId: string) => h.svc.createWorkflowDecisionWithVideo(sessionId, { requestId,
      resourceKey: requestId, resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Related repair",
        sanitizedBody: body, labels: [], recommendationId } });
    const unknown = await publish("child", "unknown", "followup_unknown");
    assert.deepEqual([unknown.status, unknown.errorDetails?.code], [409, "recommendation_not_found"]);
    assert.equal(publicationRefusalRecord(h)!.admissionFailure, "recommendation_not_found");
    const recorded = h.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title: "Related repair", originWorkItemIds: [h.item.id] });
    assert.ok(recorded.ok);
    const unaccepted = await publish("child", "unaccepted", recorded.data!.id);
    assert.deepEqual([unaccepted.status, unaccepted.errorDetails?.code], [409, "recommendation_not_accepted"]);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root", { recommendationId: recorded.data!.id, disposition: "accepted", reason: "Observed related work",
      publicationRequired: true }).ok);
    const admitted = await publish("child", "admitted", recorded.data!.id);
    assert.equal(admitted.data?.authority, "orchestrator");
    assert.ok(h.svc.resolveWorkflowDecision("root", "child", admitted.data!.occurrenceId, { outcome: "approve" }, "orchestrator", { kind: "agent", id: "root" }, () => true).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("child", admitted.data!.occurrenceId, { resourceSnapshot: admitted.data!.resourceSnapshot })).ok);
    const spent = await publish("child", "spent", recorded.data!.id);
    assert.deepEqual([spent.status, spent.errorDetails?.code], [409, "recommendation_spent"]);
    for (const result of [unknown, unaccepted, spent]) {
      const code = result.errorDetails!.code as CampaignPublicationAdmissionFailure;
      assert.equal(result.error, CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES[code]);
    }
    for (const requestId of ["unknown", "unaccepted", "spent"]) assert.equal(h.db.workflowDecisionByRequestId("child", requestId), null, requestId);
    // The root's own refusal reaches it in the response; no recovery wake repeats it.
    const own = await publish("root", "root-unknown", "followup_root_unknown");
    assert.deepEqual([own.status, own.errorDetails?.code], [409, "recommendation_not_found"]);
    assert.equal(publicationRefusalRecord(h, "root"), undefined);
  } finally { h.db.close(); }
});

test("#4065 a publication naming no recommendation goes to the person with recommendation_missing, and recovery shows it instead of a boundary enlargement", async () => {
  const h = harness();
  try {
    const p = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "unnamed", resourceKey: "unnamed", resourceSnapshot: {
      category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Related repair", sanitizedBody: body, labels: [] } });
    assert.ok(p.ok, p.error ?? "unnamed");
    assert.equal(p.data!.authority, "human");
    assert.equal(p.data!.authorityEvaluation?.admissionFailure, "recommendation_missing");
    assert.match(p.data!.authorityEvaluation!.admissionMessage!, /Naming the accepted recommendation's recommendationId would let the Orchestrator review it/u,
      "the response tells the requester how the Orchestrator could review it");
    new CampaignRecoveryService(h.db, () => {}, { info() {} }).maintain(Date.now());
    const record = h.db.campaignProjection("root")!.recovery!.records.find(item => item.resource.occurrenceId === recoveryCoordinate(p.data!.occurrenceId))!;
    assert.deepEqual([record.reason, record.effectiveOwner, record.state, record.admissionFailure, record.requiredInput],
      ["publication_not_admitted", "human", "waiting_human", "recommendation_missing", "perform_human_required_action"]);
    assert.ok(record.explanation.includes(CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES.recommendation_missing));
  } finally { h.db.close(); }
  // A boundary that does not authorize related follow-ups still records why the person is asked.
  const unrelated = harness();
  try {
    assert.ok(unrelated.svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100", operations: ["campaign_issue_scope", "follow_up_issue_publication"],
      delegatablePolicyIds: [], issueAuthority: { epics: [100], relatedFollowUps: false, maxIssues: 5, closureReasons: [] } }, 2, unrelated.principal).ok);
    const p = await unrelated.svc.createWorkflowDecisionWithVideo("child", { requestId: "unrelated", resourceKey: "unrelated", resourceSnapshot: {
      category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Related repair", sanitizedBody: body, labels: [] } });
    assert.ok(p.ok, p.error ?? "unrelated");
    assert.deepEqual([p.data!.authority, p.data!.authorityEvaluation?.admissionFailure], ["human", "no_issue_boundary"]);
  } finally { unrelated.db.close(); }
});

test("#4065 an origin outside scope keeps the person fallback with its condition, and Custom campaigns are unchanged", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    // The owner replaces the origin's issue; the recommendation stays accepted.
    const swap = await h.svc.proposeCampaignIssueScope("root", { requestId: "swap-origin", expectedRevision: 1, additions: [{ repository: "team/repo", number: 150 }],
      removals: [{ repository: "team/repo", number: 100 }], explanation: "Owner replaces the origin" }, () => true, h.principal);
    assert.ok(swap.ok, swap.error ?? "swap"); assert.ok(h.approve(swap.data!).ok);
    const p = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "origin", resourceKey: "origin", resourceSnapshot: {
      category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Related repair", sanitizedBody: body, labels: [], recommendationId } });
    assert.ok(p.ok, p.error ?? "origin");
    assert.deepEqual([p.data!.authority, p.data!.authorityEvaluation?.admissionFailure], ["human", "origin_outside_scope"]);
    assert.equal(p.data!.authorityEvaluation?.admissionMessage, CAMPAIGN_PUBLICATION_ADMISSION_MESSAGES.origin_outside_scope);
  } finally { h.db.close(); }
  const custom = harness(false);
  try {
    const rec = custom.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title: "Custom repair", originWorkItemIds: [custom.item.id] });
    assert.ok(rec.ok);
    for (const [requestId, snapshot] of [["named-other-title", { recommendationId: rec.data!.id, sanitizedTitle: "Another repair" }],
      ["unnamed", { sanitizedTitle: "Custom repair" }]] as const) {
      const p = await custom.svc.createWorkflowDecisionWithVideo("child", { requestId, resourceKey: requestId, resourceSnapshot: {
        category: "follow_up_issue_publication", repository: "team/repo", sanitizedBody: body, labels: [], ...snapshot } });
      assert.ok(p.ok, `${requestId}: ${p.error}`);
      assert.equal(p.data!.authority, "human", requestId);
      assert.equal(p.data!.authorityEvaluation?.admissionFailure, "recommendationId" in snapshot ? "no_issue_boundary" : undefined, requestId);
      assert.equal(p.data!.authorityEvaluation?.admissionMessage, undefined, requestId);
    }
  } finally { custom.db.close(); }
});

test("a follow-up past the approval limit cannot be published until the person admits it, and its slot then holds the issue (#2940)", async () => {
  const h = harness(true, 1);
  try {
    // A Human allowance that admits no follow-up without approval, on a scope already at its Maximum Issues.
    const budgetAuthority = { version: 1 as const, concurrency: 3, acceptedFollowUps: 0, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    const policy = h.db.getSession("root")!.orchestratorPolicy!;
    assert.equal(policy.control?.mode, "full_control");
    if (policy.control?.mode === "full_control") policy.control.boundary.budgetAuthority = budgetAuthority;
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
    h.db.campaignBudgets.authorize("root", budgetAuthority);
    assert.equal(campaignBoundaryCurrent(h.db.getSession("root")!), true);

    const record = h.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title: "Related repair", originWorkItemIds: [h.item.id] });
    assert.ok(record.ok, record.error ?? "record");
    const recommendationId = record.data!.id;
    const accept = () => h.svc.adjudicateCampaignRecommendation("root", { recommendationId, disposition: "accepted", reason: "Observed related work", publicationRequired: true });
    const publish = (requestId: string) => h.svc.createWorkflowDecisionWithVideo("child", { requestId, resourceKey: requestId,
      resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "[Feature]: Related repair", sanitizedBody: body,
        labels: ["enhancement"], recommendationId } });

    const over = accept();
    assert.equal(over.ok, false);
    assert.equal(over.status, 409);
    const occurrenceId = /decision (workflow_[a-f0-9]+)/u.exec(over.error ?? "")?.[1];
    assert.ok(occurrenceId, over.error ?? "refusal");

    // Publication is no way around the follow-up approval: the recommendation is not accepted yet,
    // so the request is refused and creates nothing (#4065).
    const early = await publish("early");
    assert.deepEqual([early.ok, early.status, early.errorDetails?.code], [false, 409, "recommendation_not_accepted"]);
    assert.equal(h.db.workflowDecisionByRequestId("child", "early"), null);

    const admission = h.db.workflowDecisionByOccurrence(occurrenceId)!;
    assert.equal(admission.category, "campaign_follow_up_admission");
    assert.ok(h.approve(admission).ok, "the person admits the follow-up");
    assert.ok(accept().ok, "accepting it again admits it once");
    assert.equal(h.db.campaignIssueLimit("root", 1), 2, "the admitted follow-up holds one issue slot past Maximum Issues");

    // In the boundary and within the admitted slot, the child's publication is the Orchestrator's.
    const admitted = await publish("admitted");
    assert.ok(admitted.ok, admitted.error ?? "publication");
    assert.equal(admitted.data!.authorityEvaluation?.admissionFailure, undefined);
    assert.equal(admitted.data!.authority, "orchestrator");
  } finally { h.db.close(); }
});

test("bounded not-planned closure needs a recorded supported disposition and keeps uncertain dispatch unreplayable", async () => {
  const h = harness();
  const request = {requestId:"closure",issue:100,reason:"not_planned" as const,explanation:"Supported retirement",evidence:["Recorded cancellation"]};
  try {
    const fallback=await h.svc.requestGithubIssueClosure("root",{...request,requestId:"missing-disposition"});
    assert.ok(fallback.ok); assert.equal(fallback.data!.decision!.authority,"human");
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId:h.item.id,commitment:{state:"cancelled",reason:"Replaced by a verified alternative"}}).ok);
    h.state.openPR=true;
    const conflict=await h.svc.requestGithubIssueClosure("root",{...request,requestId:"conflict"});
    assert.ok(conflict.ok); assert.equal(conflict.data!.decision!.authority,"human"); h.state.openPR=false;
    const c = await h.svc.requestGithubIssueClosure("root",request); assert.ok(c.ok,c.error ?? "closure");
    const d = c.data!.decision!; assert.equal(d.authority,"orchestrator"); assert.ok(h.approve(d).ok);
    const executed = await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest); assert.ok(executed.ok,executed.error ?? "execution");
    assert.equal(executed.data!.issueClosureResult!.outcome,"uncertain");
    assert.equal((await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest)).ok,false);
    assert.equal(h.state.executes,1);
    const recovery = new CampaignRecoveryService(h.db, () => {}, { info() {} });
    recovery.maintain(Date.now());
    const later = h.svc.createWorkflowDecision("root", { requestId: "later-choice", resourceKey: d.resourceKey,
      resourceSnapshot: { category: "implementation_question", question: "Which separate repair should run?",
        options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(later.ok, later.error ?? "later exact question refused");
    assert.ok(h.db.campaignRecoverySettledDecisions("root").some(item => item.occurrenceId === d.occurrenceId),
      "a newer same-key occurrence cannot supersede an uncertain consumed mutation");
    recovery.maintain(Date.now());
    const original = h.db.campaignProjection("root")!.recovery!.records.find(record =>
      record.resource.occurrenceId === recoveryCoordinate(d.occurrenceId))!;
    assert.equal(original.reason, "uncertain_outcome");
    assert.equal(original.effectiveOwner, "human");
    assert.equal(original.requiredInput, "reconcile_original_outcome");
    assert.equal(h.state.executes, 1, "recovery never replays the uncertain closure");
  } finally { h.db.close(); }
});

test("a human-owned recovery exception makes the campaign Waiting for a Person in detail and summary (#2938)", async () => {
  const h = harness();
  try {
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId:h.item.id,commitment:{state:"cancelled",reason:"Replaced by a verified alternative"}}).ok);
    const c = await h.svc.requestGithubIssueClosure("root",{requestId:"closure",issue:100,reason:"not_planned",
      explanation:"Supported retirement",evidence:["Recorded cancellation"]});
    assert.ok(c.ok, c.error ?? "closure"); const d = c.data!.decision!; assert.ok(h.approve(d).ok);
    const executed = await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest);
    assert.equal(executed.data!.issueClosureResult!.outcome,"uncertain");
    // An unverified child at rest with nothing pending would otherwise read as an active campaign.
    for (const id of ["root", "child"]) h.db.updateSessionStatus(id, "idle", Date.now());
    assert.equal(h.db.getSession("child")!.pendingApproval, null);
    new CampaignRecoveryService(h.db, () => {}, { info() {} }).maintain(Date.now());
    const projection = h.db.campaignProjection("root")!;
    const record = projection.recovery!.records.find(item => item.resource.occurrenceId === recoveryCoordinate(d.occurrenceId))!;
    assert.deepEqual([record.effectiveOwner, record.state, record.reason], ["human", "waiting_human", "uncertain_outcome"]);
    assert.equal(projection.pendingRequests?.human ?? 0, 0, "no request is pending; only the recovery exception waits");
    assert.equal(projection.status, "waiting_human");
    assert.equal(h.db.campaignStatusOnly("root"), "waiting_human");
    const summary = h.db.listSessionSummaries().find(session => session.id === "root")!;
    assert.deepEqual([summary.projection, summary.fullControlCampaignStatus], ["summary", "waiting_human"],
      "summary rows, which carry no recovery records, read the same status");
    assert.equal(h.db.getSession("root")!.fullControlCampaignStatus, "waiting_human");
  } finally { h.db.close(); }
});

test("pending and consumed publications reserve capacity against other publications and epic scope changes", async () => {
  const h=harness(true,2);
  try {
    let firstRecommendation="";
    const make=async (title:string)=> {
      const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
      assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
      if(title==="First repair") firstRecommendation=rec.data!.id;
      return h.svc.createWorkflowDecisionWithVideo("root",{requestId:title,resourceKey:title,resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:title,sanitizedBody:body,labels:[],recommendationId:rec.data!.id}});
    };
    const first=await make("First repair"); assert.ok(first.ok,first.error ?? "first reservation");
    const second=await make("Second repair"); assert.ok(second.ok); assert.equal(second.data!.authority,"human");
    assert.equal((await h.proposal("epic-slot")).ok,false);
    assert.ok(h.approve(first.data!).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("root",first.data!.occurrenceId,{resourceSnapshot:first.data!.resourceSnapshot})).ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:firstRecommendation,disposition:"accepted",reason:"Unverified tracker claim",
      resultingWorkItemKey:`followup:${firstRecommendation}`,resultingIssue:{repository:"team/repo",number:100}}).ok);
    const third=await make("Third repair"); assert.ok(third.ok); assert.equal(third.data!.authority,"human","ledger claims cannot free a standing slot");
  } finally {h.db.close();}
});

test("authenticated human scope proposals preserve direct human narrowing and expansion under Full Control", async () => {
  const h=harness();
  try {
    const proposed=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-add",expectedRevision:1,additions:[{repository:"team/repo",number:999}],removals:[],explanation:"Fresh human scope expansion"},()=>true,h.principal);
    assert.ok(proposed.ok,proposed.error ?? "human proposal"); assert.equal(proposed.data!.authority,"human");
    assert.ok(h.approve(proposed.data!).ok);
    const narrowed=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-remove",expectedRevision:2,additions:[],removals:[{repository:"team/repo",number:999}],explanation:"Human narrowing"},()=>true,h.principal);
    assert.ok(narrowed.ok,narrowed.error ?? "human narrowing"); assert.equal(narrowed.data!.authority,"human");
    assert.ok(h.approve(narrowed.data!).ok);
    const closure=await h.svc.requestGithubIssueClosure("root",{requestId:"human-exception",issue:100,reason:"completed",explanation:"Owner reviews umbrella completion",evidence:["Human review"]});
    assert.ok(closure.ok,closure.error ?? "human closure"); assert.equal(closure.data!.decision!.authority,"human");
    assert.ok(h.approve(closure.data!.decision!).ok);
  } finally {h.db.close();}
});

test("a reservation settles only after exact inspected publication lineage is consumed into scope", async () => {
  const h=harness(true,2);
  try {
    const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Verified repair",originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Related observed work",publicationRequired:true}).ok);
    const publication=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"verified-publication",resourceKey:"pub",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
      sanitizedTitle:"Verified repair",sanitizedBody:body,labels:[],recommendationId:rec.data!.id}}); assert.ok(publication.ok);
    const d=publication.data!; assert.ok(h.approve(d).ok); assert.ok((await h.svc.consumeWorkflowDecision("root",d.occurrenceId,{resourceSnapshot:d.resourceSnapshot})).ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Read-back payload verified",resultingWorkItemKey:`followup:${rec.data!.id}`,
      resultingIssue:{repository:"team/repo",number:101}}).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",d.occurrenceId),null,"ledger read-back alone is still a claim");
    const scope=await h.svc.proposeCampaignIssueScope("root",{requestId:"verified-published-scope",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],
      explanation:"Exact payload and related origin independently inspected",lineage:{kind:"follow_up",publicationOccurrenceId:d.occurrenceId}}); assert.ok(scope.ok,scope.error ?? "scope");
    assert.ok(h.approve(scope.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",d.occurrenceId),101);
  } finally {h.db.close();}
});

test("the actual Campaign Status HTTP route keeps a bounded Full Control human proposal human-owned", async () => {
  const h=harness();
  const {default:Fastify}=await import("fastify");
  const {registerCampaignIssueScopeRoutes}=await import("./campaign-issue-scope-routes.js");
  const app=Fastify();
  try {
    registerCampaignIssueScopeRoutes(app,{db:h.db,svc:h.svc,requestPrincipal:()=>h.principal});
    const result=await app.inject({method:"POST",url:"/api/sessions/root/campaign/issue-scope/proposals",payload:{requestId:"human-http",expectedRevision:1,
      additions:[{repository:"team/repo",number:999}],removals:[],explanation:"Human owner explicitly broadens scope"}});
    assert.equal(result.statusCode,201,result.body); assert.equal(result.json().authority,"human");
    assert.equal(result.json().resourceSnapshot.issueAdmission,undefined);
  } finally {await app.close();h.db.close();}
});

for (const [credentialSessionId, method, target] of [
  ["child", "POST", "root"],
  ["child", "POST", "child"],
  ["other-root", "POST", "root"],
  ["other-root", "GET", "root"],
  ["child", "GET", "root"],
  ["root", "POST", "root"],
  ["root", "GET", "root"],
] as const) {
  test(`issue-scope agent route: ${credentialSessionId} ${method} ${target}`, async () => {
    const h = harness();
    const { default: Fastify } = await import("fastify");
    const { registerCampaignIssueScopeRoutes } = await import("./campaign-issue-scope-routes.js");
    const app = Fastify();
    try {
      h.db.createSession({ id: "other-root", runnerId: "r", workspaceId: "w", agentId: "codex", title: "Other campaign",
        useWorktree: false, driver: "codex-app-server", now: 1, config: {}, role: "orchestrator",
        orchestratorPolicy: h.db.getSession("root")!.orchestratorPolicy! });
      const principal: AgentPrincipal = { kind: "agent", actorId: credentialSessionId, credentialSessionId,
        orchestrator: credentialSessionId !== "child", organizationId: h.principal.organizationId,
        delegatedScope: h.db.sessionScope(credentialSessionId)! };
      // Same-owner access must succeed so the route's agent checks, rather than resource isolation, refuse the request.
      assert.equal(h.db.canAccessSession(principal, target), true);
      assert.equal(h.db.canAccessSession(principal, "root"), true);
      assert.equal(h.db.resolvedCampaignSessionId("other-root"), "other-root");
      registerCampaignIssueScopeRoutes(app, { db: h.db, svc: h.svc, requestPrincipal: () => principal });
      const decisions = () => h.db.raw().prepare("SELECT * FROM workflow_decisions ORDER BY occurrence_id").all();
      const before = decisions();
      const result = await app.inject({ method,
        url: `/api/sessions/${target}/campaign/issue-scope${method === "POST" ? "/proposals" : ""}`,
        ...(method === "POST" ? { payload: { requestId: "agent-http", expectedRevision: 1,
          additions: [{ repository: "team/repo", number: 101 }], removals: [], explanation: "Verified intended member",
          lineage: { kind: "epic", epic: 100 } } } : {}) });
      if (credentialSessionId !== "root") {
        assert.equal(result.statusCode, 403, result.body);
        assert.deepEqual(result.json(), { error: method === "POST"
          ? "only the campaign owner or its root Orchestrator may propose a scope change"
          : "campaign scope requires access to its Orchestrator" });
        assert.deepEqual(decisions(), before, "refused requests create no scope proposal");
      } else if (method === "POST") {
        assert.equal(result.statusCode, 201, result.body);
        assert.equal(result.json().resourceSnapshot.category, "campaign_issue_scope");
        assert.equal(result.json().authority, "orchestrator");
        assert.equal(decisions().length, before.length + 1);
        assert.ok(h.db.workflowDecisionByOccurrence(result.json().occurrenceId));
      } else {
        assert.equal(result.statusCode, 200, result.body);
        assert.deepEqual(result.json().issueNumbers, [100]);
        assert.equal(result.json().repository, "team/repo");
        assert.deepEqual(decisions(), before);
      }
    } finally { await app.close(); h.db.close(); }
  });
}

test("non-delegated closure reasons and operations retain human review without demanding delivery inspection", async () => {
  for (const operations of [["campaign_issue_scope"],["campaign_issue_scope","issue_closure"]] as const) {
    const h=harness();
    try {
      assert.ok(h.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:[...operations],delegatablePolicyIds:[],
        issueAuthority:{epics:[100],relatedFollowUps:false,maxIssues:5,closureReasons:["not_planned"]}},2,h.principal).ok);
      const result=await h.svc.requestGithubIssueClosure("root",{requestId:"human-reason",issue:100,reason:"completed",explanation:"Human reviews umbrella",evidence:["Current human review"]});
      assert.ok(result.ok,result.error ?? "human exception"); assert.equal(result.data!.decision!.authority,"human");
      assert.equal(result.data!.decision!.resourceSnapshot.category==="issue_closure" && result.data!.decision!.resourceSnapshot.delivery,undefined);
      assert.ok(h.approve(result.data!.decision!).ok);
      assert.ok((await h.svc.executeGithubIssueClosure("root",result.data!.decision!.occurrenceId,result.data!.decision!.resourceDigest)).ok);
    } finally {h.db.close();}
  }
});

test("legacy duplicate-label publication decisions still normalize and consume", async () => {
  const h=harness(false);
  try {
    const snapshot={category:"follow_up_issue_publication" as const,repository:"team/repo",sanitizedTitle:"Legacy exact payload",sanitizedBody:body,labels:["feature","feature"]};
    const p=h.svc.createWorkflowDecision("child",{requestId:"legacy-labels",resourceKey:"legacy-labels",resourceSnapshot:snapshot}); assert.ok(p.ok,p.error ?? "legacy request");
    assert.ok(h.svc.resolveWorkflowDecision("root","child",p.data!.occurrenceId,{outcome:"approve"},"human",{kind:"human",id:h.principal.userId},()=>true).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("child",p.data!.occurrenceId,{resourceSnapshot:snapshot})).ok);
  } finally {h.db.close();}
});

test("completed delegated closure binds verified delivery and refuses delivery changes before execution", async () => {
  for (const changed of [false,true]) {
    const h=harness();
    try {
      const merge={number:10,headSha:"b".repeat(40),mergeCommitSha:"c".repeat(40)}; h.state.delivery=[merge];
      const detail={id:h.item.id,issue:{repository:"team/repo",number:100},primaryState:"delivered",currentAttempt:null,
        verifications:[{outcome:"delivered",report:{digest:"d".repeat(64)}}],observed:{pullRequests:[{ref:{repository:"team/repo",number:10},fact:{availability:"fresh",value:{state:"merged",headSha:merge.headSha,mergeCommitSha:merge.mergeCommitSha}}}]}} as unknown as CampaignWorkItemDetail;
      h.db.campaignWorkLedger.detail=()=>detail;
      const c=await h.svc.requestGithubIssueClosure("root",{requestId:"delivered",issue:100,reason:"completed",explanation:"All criteria verified against the final report",evidence:["Report and actual merged PR"]});
      assert.ok(c.ok,c.error ?? "completed closure"); const d=c.data!.decision!; assert.equal(d.authority,"orchestrator"); assert.ok(h.approve(d).ok);
      if(changed) detail.verifications=[];
      const result=await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest);
      assert.equal(result.ok,!changed); assert.equal(h.state.executes,changed?0:1);
    } finally {h.db.close();}
  }
});

test("completed closure cannot rely on a reported stage, queue entry, stale forge fact or missing verified report", () => {
  const h = harness();
  try {
    const snapshot = {category:"issue_closure" as const,repository:"team/repo",issue:100,title:"Issue",url:"https://github.com/team/repo/issues/100",forgeDigest:"a".repeat(64),
      reason:"completed" as const,explanation:"Delivered",evidence:["Verified report"],openPullRequests:[],activeChildren:[],delivery:[{number:10,headSha:"b".repeat(40),mergeCommitSha:"c".repeat(40)}]};
    const detail = {id:h.item.id,issue:{repository:"team/repo",number:100},primaryState:"delivered",currentAttempt:null,
      verifications:[{outcome:"delivered",report:{digest:"d".repeat(64)}}],observed:{pullRequests:[{ref:{repository:"team/repo",number:10},fact:{availability:"fresh",value:{state:"merged",headSha:"b".repeat(40),mergeCommitSha:"c".repeat(40)}}}]}} as unknown as CampaignWorkItemDetail;
    const original = h.db.campaignWorkLedger.detail;
    h.db.campaignWorkLedger.detail = () => detail;
    assert.ok(closureEvidence(h.db,h.db.getSession("root")!,snapshot));
    for (const availability of ["stale","unavailable"]) {
      detail.observed.pullRequests![0]!.fact.availability=availability as "fresh";
      assert.equal(closureEvidence(h.db,h.db.getSession("root")!,snapshot),null);
    }
    detail.observed.pullRequests![0]!.fact.availability="fresh";
    detail.verifications=[]; assert.equal(closureEvidence(h.db,h.db.getSession("root")!,snapshot),null);
    h.db.campaignWorkLedger.detail=original;
  } finally { h.db.close(); }
});

test("an issue boundary refuses its scope limit and its runner floor as separate errors", () => {
  const h = harness(false);
  try {
    const proposal = { mode: "full_control" as const, objective: "Implement epic 100", operations: ["campaign_issue_scope"] as Array<"campaign_issue_scope">,
      delegatablePolicyIds: [], issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 1, closureReasons: [] } };
    const policy = structuredClone(h.db.getSession("root")!.orchestratorPolicy!);
    policy.issueScope = { ...policy.issueScope!, issueNumbers: [100, 101] };
    policy.issueNumbers = [100, 101];
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id=?").run(JSON.stringify(policy), "root");
    const overLimit = h.svc.setCampaignControl("root", proposal, 1, h.principal);
    assert.equal(overLimit.status, 409);
    assert.equal(overLimit.error, "The issue boundary exceeds its human-set scope limit.");
    assert.equal(overLimit.capabilityRequirement, undefined, "a scope limit is not a runner refusal");
    const floor = RUNNER_CAPABILITY_MIN_PROTOCOL.fullControlIssueAuthority;
    h.db.registerRunner(h.metadata, 3, floor - 1);
    const outdated = h.svc.setCampaignControl("root", { ...proposal, issueAuthority: { ...proposal.issueAuthority, maxIssues: 5 } }, 1, h.principal);
    assert.equal(outdated.status, 409);
    assert.equal(outdated.error, "This machine needs a newer runner for campaign issue limits. Update and restart the runner.");
    assert.deepEqual(outdated.capabilityRequirement, { requiredRunnerProtocolVersion: floor, runnerProtocolVersion: floor - 1 });
  } finally { h.db.close(); }
});

test("a scoped Orchestrator refuses an older runner with the shared sentence on child creation and restart", () => {
  const h = harness(false);
  try {
    const floor = RUNNER_CAPABILITY_MIN_PROTOCOL.campaignIssueScopeChanges;
    const refusal = "This machine needs a newer runner for campaign issue scope changes. Update and restart the runner.";
    const versions = { requiredRunnerProtocolVersion: floor, runnerProtocolVersion: floor - 1 };
    h.db.updateSessionConfig("root", { permissionMode: "orchestrator" }, 3);
    h.db.registerRunner({ ...h.metadata, agents: h.metadata.agents.map((agent) => ({ ...agent,
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default", "orchestrator"] } })) }, 4, floor - 1);
    const child = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "codex", role: "orchestrator", prompt: "Coordinate",
      config: { permissionMode: "orchestrator" } }, undefined, undefined, false, false, false,
    { parentSessionId: "root", defaultOwnerUserId: h.principal.userId });
    assert.equal(child.error, refusal);
    assert.equal(child.status, 409);
    assert.deepEqual(child.capabilityRequirement, versions);
    h.db.updateSessionStatus("root", "completed", 5);
    const restart = h.svc.restart("root");
    assert.equal(restart.error, refusal);
    assert.equal(restart.status, 409);
    assert.deepEqual(restart.capabilityRequirement, versions);
  } finally { h.db.close(); }
});

test("campaign issue scope refuses each runner floor with the shared sentence and returns the versions beside it", async () => {
  const {default:Fastify}=await import("fastify");
  const {registerCampaignIssueScopeRoutes}=await import("./campaign-issue-scope-routes.js");
  for (const [full, capability, label] of [
    [true, "fullControlIssueAuthority", "campaign issue limits"],
    [false, "campaignIssueScopeChanges", "campaign issue scope changes"],
  ] as const) {
    const h = harness(full);
    const app = Fastify();
    try {
      registerCampaignIssueScopeRoutes(app, { db: h.db, svc: h.svc, requestPrincipal: () => h.principal });
      const floor = RUNNER_CAPABILITY_MIN_PROTOCOL[capability];
      const refusal = `This machine needs a newer runner for ${label}. Update and restart the runner.`;
      const versions = { requiredRunnerProtocolVersion: floor, runnerProtocolVersion: floor - 1 };
      assert.doesNotMatch(refusal, /protocol|v\d/u);
      h.db.registerRunner(h.metadata, 3, floor - 1);
      const view = await app.inject({ method: "GET", url: "/api/sessions/root/campaign/issue-scope" });
      assert.equal(view.statusCode, 200, view.body);
      assert.deepEqual(
        (({ supported, compatibilityMessage, requiredRunnerProtocolVersion, runnerProtocolVersion }) =>
          ({ supported, compatibilityMessage, requiredRunnerProtocolVersion, runnerProtocolVersion }))(view.json()),
        { supported: false, compatibilityMessage: refusal, ...versions },
      );
      const proposed = await app.inject({ method: "POST", url: "/api/sessions/root/campaign/issue-scope/proposals",
        payload: { requestId: `old-runner-${capability}`, expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }],
          removals: [], explanation: "Verified intended member", lineage: { kind: "epic", epic: 100 } } });
      assert.equal(proposed.statusCode, 409);
      assert.deepEqual(proposed.json(), { error: refusal, ...versions }, "the HTTP refusal keeps the versions beside the sentence");
    } finally { await app.close(); h.db.close(); }
  }
});

/** #2940: the live Full Control root delivered an issue through a gated, merged pull request it never
 * named in a reported stage, then waited past the forge fact's freshness. These run the real ledger,
 * verification, `pr_merge` gate and closure route rather than a stubbed work-item detail. */
type GateOption = "consumed" | "revoked" | "other_session" | "reassigned" | null;
function delivery(options: { stage?: Array<{ number: number }>; gate?: GateOption; verify?: boolean; intendedClosures?: string[]; epic?: boolean } = {}) {
  const h = options.epic ? harness(true, 5, [100, 101]) : harness();
  const head = "b".repeat(40), merge = "c".repeat(40);
  const ref = (number: number) => ({ repository: "team/repo", number });
  type State = "open" | "closed" | "merged";
  const observation = (state: State, headSha = head) => ({ state, draft: false, headSha, baseRef: "main",
    reviewDecision: "approved" as const, checks: { state: "passing" as const, passing: 1, failing: 0, pending: 0 },
    requiredChecks: { state: "passing" as const, passing: 1, failing: 0, pending: 0 }, mergeQueue: null,
    mergeCommitSha: state === "merged" ? merge : null });
  /** What GitHub says now; the store only learns it through an observation. */
  const forge = new Map<number, ReturnType<typeof observation>>();
  const setForge = (number: number, state: State, headSha = head) => forge.set(number, observation(state, headSha));
  const observe = (number: number, state: State, at = Date.now(), headSha = head) => {
    setForge(number, state, headSha);
    h.db.campaignForgeObservations.record("root", "r", [{ ref: ref(number), observation: observation(state, headSha) }], at);
  };
  const verified: Array<Array<{ number: number; headSha: string }> | undefined> = [];
  const forgeReads: number[][] = [];
  /** While `hold` is set, each forge read is sent but waits for `release()` before GitHub answers. */
  const reads = { hold: false, waiting: [] as Array<() => void>, release() { for (const resume of this.waiting.splice(0)) resume(); } };
  /** While `hold` is set, each campaign-scope synchronization waits for `release()`. */
  const syncs = { hold: false, waiting: [] as Array<() => void>, release() { for (const resume of this.waiting.splice(0)) resume(); } };
  const runner = h.hub.requestFromRunner;
  h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
    if (message.type === "campaign_issue_scope" && message.operation === "synchronize" && syncs.hold) {
      await new Promise<void>((resume) => syncs.waiting.push(resume));
    }
    if (message.type === "campaign_forge_observe") {
      forgeReads.push(message.pullRequests.map((pr) => pr.number));
      if (reads.hold) await new Promise<void>((resume) => reads.waiting.push(resume));
      // The runner's own per-request limit (campaign-forge-status.ts).
      if (message.pullRequests.length > CAMPAIGN_FORGE_OBSERVATION.refsPerRequest) {
        return { type: "campaign_forge_observe_result", requestId, sessionId: message.sessionId, observedAt: Date.now(), ok: false, failure: "forge_error" as const };
      }
      return { type: "campaign_forge_observe_result", requestId, sessionId: message.sessionId, observedAt: Date.now(), ok: true,
        results: message.pullRequests.map((pr) => forge.has(pr.number)
          ? { ref: pr, ok: true as const, observation: forge.get(pr.number)! }
          : { ref: pr, ok: false as const, failure: "forge_not_found" as const }) };
    }
    if (message.type === "github_issue_closure" && message.operation === "inspect" && message.deliveryPullRequests) {
      verified.push(message.deliveryPullRequests);
      h.state.delivery = message.deliveryPullRequests.map((pr) => ({ ...pr, mergeCommitSha: merge }));
    }
    return runner(runnerId, requestId, message, timeout);
  };
  if (options.gate === "other_session") {
    h.db.createSession({ id: "other", runnerId: "r", workspaceId: "w", agentId: "codex", title: "other", useWorktree: false,
      driver: "codex-app-server", now: 1, config: {}, parentSessionId: "root" });
    h.db.updateSessionStatus("other", "running", 2);
  }
  // A reassigned child first works on another item, whose merge gate must not prove this one.
  let earlier: number | null = null;
  if (options.gate === "reassigned") {
    const plan = h.svc.recordCampaignPlan("root", { items: [{ key: "issue:100", issue: { repository: "team/repo", number: 100 } },
      { key: "other-work", title: "Unrelated work" }], planComplete: true });
    assert.ok(plan.ok, plan.error ?? "plan");
    const other = plan.data!.items.find((item) => item.key === "other-work")!.workItemId;
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: other, childSessionId: "child" }).ok);
  } else {
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.item.id, childSessionId: "child" }).ok);
  }
  if (options.gate) {
    const requester = options.gate === "other_session" ? "other" : "child";
    const gate = h.svc.createWorkflowDecision(requester, { requestId: "merge-10", resourceKey: "team/repo#10/merge", resourceSnapshot: {
      category: "pr_merge", repository: "team/repo", pullRequest: 10, headSha: head, reviewResult: "merge",
      requiredChecks: { headSha: head, status: "passed", checkedAt: 1, checks: [{ name: "CI", state: "passed" }] },
      ...(options.intendedClosures ? { intendedClosures: options.intendedClosures } : {}) } });
    assert.ok(gate.ok, gate.error ?? "merge gate");
    assert.ok(h.svc.resolveWorkflowDecision("root", requester, gate.data!.occurrenceId, { outcome: "approve" }, gate.data!.authority,
      { kind: "human", id: h.principal.userId }, () => true).ok);
    if (options.gate === "revoked") assert.ok(h.db.markWorkflowDecisionRevoked(gate.data!.occurrenceId, Date.now()));
    else assert.ok(h.db.consumeWorkflowDecision(gate.data!.occurrenceId, Date.now()));
  }
  if (options.gate === "reassigned") {
    h.svc.onSessionStatus("child", "idle");
    earlier = h.db.appendEvent("child", { kind: "agent_message", text: "Other work delivered.", final: true }, Date.now()).seq;
    const later = Date.now() + 5;
    while (Date.now() < later) { /* the next attempt starts strictly after the earlier report */ }
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.item.id, childSessionId: "child" }).ok);
  }
  if (options.stage) assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item.id,
    stage: { stage: "merged", pullRequests: options.stage.map(({ number }) => ref(number)) } }).ok);
  if (options.verify !== false) {
    h.svc.onSessionStatus("child", "idle");
    const report = earlier ?? h.db.appendEvent("child", { kind: "agent_message", text: "Delivered.", final: true }, Date.now()).seq;
    const result = h.svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: h.item.id, outcome: "delivered" } });
    assert.ok(result.ok, result.error ?? "verify");
  }
  const close = (requestId: string) => h.svc.requestGithubIssueClosure("root", { requestId, issue: 100, reason: "completed",
    explanation: "Delivered by the merged pull request", evidence: ["Verified report"] });
  /** The real observer behind both service hooks, its clock held inside one minIntervalMs. */
  const useObserver = () => {
    const clock = Date.now();
    let ids = 0;
    const observer = new CampaignForgeObserver({
      observingRunner: (id) => h.db.campaignForgeObservingRunner(id), store: h.db.campaignForgeObservations,
      requestFromRunner: (runnerId, requestId, message, timeoutMs) => h.hub.requestFromRunner(runnerId, requestId, message, timeoutMs),
      backgroundTargets: () => [], changed() {}, warn() {}, newRequestId: () => `forge_${++ids}`, now: () => clock,
    });
    h.svc.campaignForgeRefresh = (campaignId, refs) => observer.refresh(campaignId, refs);
    h.svc.campaignForgeReadNow = (campaignId, refs) => observer.readNow(campaignId, refs);
    return observer;
  };
  const settle = async (until: () => boolean) => { while (!until()) await new Promise((resolve) => setImmediate(resolve)); };
  return { h, head, observe, setForge, forgeReads, reads, syncs, verified, close, useObserver, settle };
}

test("#2940 a verified issue delivered through a consumed merge gate gets Orchestrator-owned closure after an on-demand refresh", async () => {
  const { h, head, observe, verified, close } = delivery({ gate: "consumed" });
  try {
    // The background pass dropped the pull request once the item was delivered; its fact went stale.
    observe(10, "merged", Date.now() - CAMPAIGN_FORGE_OBSERVATION.staleAfterMs - 60_000);
    const refreshed: number[][] = [];
    h.svc.campaignForgeRefresh = async (campaignId, refs) => {
      assert.equal(campaignId, "root");
      refreshed.push(refs.map((ref) => ref.number));
      observe(10, "merged");
    };
    const c = await close("live-shape");
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.deepEqual(refreshed, [[10]], "the gated pull request is read even though no stage names it");
    assert.deepEqual(verified, [[{ number: 10, headSha: head }]], "the runner re-verifies the exact approved head");
    assert.ok(h.approve(d).ok);
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
    assert.deepEqual(refreshed, [[10], [10]], "execution refreshes before it re-proves delivery");
  } finally { h.db.close(); }
});

test("#2940 a Full Control root's pending own closure names the self-approval step; resolve-self then execute closes it once", async () => {
  const { h, observe, close } = delivery({ gate: "consumed" });
  try {
    observe(10, "merged");
    const c = await close("self-owned");
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.equal(d.status, "pending");
    // Executing straight after the request, as the role prompt once described, refuses with the step.
    const early = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(early.ok, false);
    assert.equal(early.status, 409);
    assert.match(early.error!, /no person will approve it/u);
    assert.match(early.error!, /resolve_descendant_workflow_decision \(sessionId "root", your own session; occurrenceId "[^"]+"; outcome "approve"\)/u);
    assert.ok(early.error!.includes(d.occurrenceId), "the refusal names the exact occurrence");
    assert.equal(h.state.executes, 0, "nothing reached the forge");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)!.status, "pending", "the refusal does not revoke the request");
    // The named step: the root approves its own occurrence through the descendant-resolution route.
    const resolved = h.svc.resolveDescendantRequest("root", "root", d.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.ok(resolved.ok, resolved.error ?? "self-resolve");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
    const replay = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(replay.ok, false);
    assert.equal(h.state.executes, 1, "the closure executes exactly once");
  } finally { h.db.close(); }
});

test("#3982 a root is not resumed by a closure it resolved itself, but is by one a person resolved", async () => {
  /** Every prompt the root was sent, ordinary or durable. */
  const recordPrompts = (hub: Hub) => {
    const prompts: string[] = [];
    hub.sendToRunner = (_runnerId, message) => {
      if (message.type === "prompt_session" && message.sessionId === "root") prompts.push(message.text);
      if (message.type === "durable_session_command" && message.command.type === "prompt_session" &&
          message.command.sessionId === "root") prompts.push(message.command.text);
      return true;
    };
    return prompts;
  };
  const resumeState = (h: ReturnType<typeof harness>, occurrenceId: string) => (h.db.raw().prepare(
    "SELECT resume_state FROM workflow_decisions WHERE occurrence_id=?").get(occurrenceId) as { resume_state: string | null }).resume_state;
  const { h, observe, close } = delivery({ gate: "consumed" });
  try {
    observe(10, "merged");
    const prompts = recordPrompts(h.hub);
    const c = await close("self-resume");
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.svc.resolveDescendantRequest("root", "root", d.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)!.status, "approved");
    assert.equal(resumeState(h, d.occurrenceId), null, "no resume is owed to the root that resolved it");
    assert.equal(h.db.getSession("root")!.pendingApproval ?? null, null, "the root still loses the card");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.deepEqual(prompts, [], "the root acted inside its own turn, so nothing resumes it afterwards");
  } finally { h.db.close(); }

  // A person's resolution of a root's own closure still resumes it: the root did not decide it.
  const custom = harness(false);
  try {
    const prompts = recordPrompts(custom.hub);
    const c = await custom.svc.requestGithubIssueClosure("root", { requestId: "human-resume", issue: 100, reason: "completed",
      explanation: "Claimed delivery", evidence: ["Claim"] });
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "human");
    assert.ok(custom.approve(d).ok);
    assert.equal(prompts.length, 1, "the person's approval resumes the root once");
    assert.match(prompts[0]!, new RegExp(`A human reviewer approved your issue_closure decision ${d.occurrenceId}`, "u"));
  } finally { custom.db.close(); }
});

test("#2940 a pending human-owned closure tells an agent a person must approve it, and the agent cannot", async () => {
  for (const full of [false, true]) {
    const h = harness(full);
    try {
      // Custom keeps closure human-owned; under Full Control an unverified delivery does too.
      const c = await h.svc.requestGithubIssueClosure("root", { requestId: `human-${full}`, issue: 100, reason: "completed",
        explanation: "Claimed delivery", evidence: ["Claim"] });
      assert.ok(c.ok, c.error ?? "closure");
      const d = c.data!.decision!;
      assert.equal(d.authority, "human");
      const early = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
      assert.equal(early.ok, false);
      assert.equal(early.status, 409);
      assert.match(early.error!, /a person must approve this human-owned closure in Wollipog first\. Never approve it yourself/u);
      assert.doesNotMatch(early.error!, /resolve_descendant_workflow_decision/u, "an agent is never pointed at self-approval");
      const self = h.svc.resolveDescendantRequest("root", "root", d.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
      assert.equal(self.ok, false, "an agent cannot approve a human-owned closure");
      assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)!.status, "pending");
      assert.equal(h.state.executes, 0);
    } finally { h.db.close(); }
  }
});

test("#2940 a stale fact that no refresh renews still retains human closure review", async () => {
  for (const hook of [false, true]) {
    const { h, observe, close } = delivery({ gate: "consumed" });
    try {
      observe(10, "merged", Date.now() - CAMPAIGN_FORGE_OBSERVATION.staleAfterMs - 60_000);
      if (hook) h.svc.campaignForgeRefresh = async () => {};
      const c = await close(`stale-${hook}`);
      assert.ok(c.ok, c.error ?? "closure");
      assert.equal(c.data!.decision!.authority, "human");
    } finally { h.db.close(); }
  }
});

test("#2940 a closed-unmerged pull request does not poison an issue another gated pull request delivered", async () => {
  const { h, head, observe, verified, close } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    observe(9, "closed"); observe(10, "merged");
    const c = await close("superseded-pr");
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.deepEqual(verified, [[{ number: 10, headSha: head }]], "only the merged pull request is sent for verification");
    assert.ok(h.approve(d).ok);
    // The excluded pull request reopens before execution: the bound proof no longer holds.
    observe(9, "open");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.equal(h.state.executes, 0);
  } finally { h.db.close(); }
});

test("#2940 execution re-reads an excluded pull request past the observer's cache and rate limit (CR-1.2)", async () => {
  for (const reopened of [true, false]) {
    const { h, setForge, forgeReads, close, useObserver } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
    try {
      setForge(9, "closed"); setForge(10, "merged");
      // The real observer, its clock held inside one minIntervalMs, so a repeat refresh is suppressed.
      useObserver();
      const c = await close(`excluded-${reopened}`);
      assert.ok(c.ok, c.error ?? "closure");
      const d = c.data!.decision!;
      assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
      assert.deepEqual(forgeReads, [[9, 10]], "the observer read both candidates once");
      assert.ok(h.approve(d).ok);
      // GitHub reopens the excluded pull request (no issue reference); the store still says closed.
      if (reopened) setForge(9, "open");
      const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
      assert.deepEqual(forgeReads, [[9, 10], [9]], "the observer suppressed its repeat; execution read the excluded ref uncached");
      assert.equal(executed.ok, !reopened, executed.error ?? "executed");
      assert.equal(h.state.executes, reopened ? 0 : 1);
      if (reopened) assert.equal(executed.status, 409);
    } finally { h.db.close(); }
  }
});

test("#2940 delivery candidates never stand in for a missing merge, gate, head or verification", async () => {
  const cases: Array<[string, Parameters<typeof delivery>[0], (observe: ReturnType<typeof delivery>["observe"]) => void]> = [
    ["only a closed-unmerged pull request", { stage: [{ number: 9 }] }, (observe) => observe(9, "closed")],
    ["an open stage pull request beside the merge", { gate: "consumed", stage: [{ number: 11 }] }, (observe) => { observe(10, "merged"); observe(11, "open"); }],
    ["a revoked, never consumed gate", { gate: "revoked" }, (observe) => observe(10, "merged")],
    ["a gate another session passed", { gate: "other_session" }, (observe) => observe(10, "merged")],
    // CR-1.1: the child's earlier merge for other work, then its earlier report verified against this item.
    ["a gate from the child's earlier attempt on other work", { gate: "reassigned" }, (observe) => observe(10, "merged")],
    ["a gate meant to close only another issue", { gate: "consumed", intendedClosures: ["team/repo#101"] }, (observe) => observe(10, "merged")],
    ["a merge at a head other than the approved one", { gate: "consumed" }, (observe) => observe(10, "merged", Date.now(), "e".repeat(40))],
    ["an unverified attempt", { gate: "consumed", verify: false }, (observe) => observe(10, "merged")],
  ];
  for (const [label, options, setup] of cases) {
    const { h, observe, close } = delivery(options);
    try {
      setup(observe);
      const c = await close(label.replaceAll(" ", "-"));
      assert.ok(c.ok, c.error ?? label);
      assert.equal(c.data!.decision!.authority, "human", label);
    } finally { h.db.close(); }
  }
});

test("#2940 a gate that names this issue among its intended closures still proves delivery", async () => {
  const { h, observe, close } = delivery({ gate: "consumed", intendedClosures: ["team/repo#100", "team/repo#101"] });
  try {
    observe(10, "merged");
    const c = await close("named-closure");
    assert.ok(c.ok, c.error ?? "closure");
    assert.equal(c.data!.decision!.authority, "orchestrator", JSON.stringify(c.data!.decision!.authorityEvaluation));
  } finally { h.db.close(); }
});

test("#2940 work assigned while the excluded-pull-request read is pending is never closed (CR-2.1)", async () => {
  const { h, setForge, reads, close, useObserver, settle } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    setForge(9, "closed"); setForge(10, "merged");
    useObserver();
    const c = await close("assigned-mid-read");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    reads.hold = true;
    const pending = h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    await settle(() => reads.waiting.length > 0);
    // The delivered item gets new work while execution waits on GitHub.
    h.db.createSession({ id: "late", runnerId: "r", workspaceId: "w", agentId: "codex", title: "late", useWorktree: false,
      driver: "codex-app-server", now: Date.now(), config: {}, parentSessionId: "root" });
    h.db.updateSessionStatus("late", "running", Date.now());
    const assigned = h.svc.assignCampaignWorkItem("root", { workItemId: h.item.id, childSessionId: "late" });
    assert.ok(assigned.ok, assigned.error ?? "assign");
    reads.release();
    const executed = await pending;
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "approved", "the approval stays unconsumed");
  } finally { h.db.close(); }
});

test("#2940 more excluded pull requests than one runner request admits are read in batches (CR-2.2)", async () => {
  const closed = Array.from({ length: 16 }, (_, index) => ({ number: 20 + index }));
  const { h, setForge, forgeReads, close, useObserver } = delivery({ gate: "consumed", stage: closed });
  try {
    for (const { number } of closed) setForge(number, "closed");
    setForge(10, "merged");
    // A second item for the same issue, delivered by another child, names a 17th closed pull request.
    const plan = h.svc.recordCampaignPlan("root", { items: [{ key: "issue:100", issue: { repository: "team/repo", number: 100 } },
      { key: "issue:100:part-2", issue: { repository: "team/repo", number: 100 } }], planComplete: true });
    assert.ok(plan.ok, plan.error ?? "plan");
    const second = plan.data!.items.find((item) => item.key === "issue:100:part-2")!.workItemId;
    h.db.createSession({ id: "child2", runnerId: "r", workspaceId: "w", agentId: "codex", title: "child2", useWorktree: false,
      driver: "codex-app-server", now: Date.now(), config: {}, parentSessionId: "root" });
    h.db.updateSessionStatus("child2", "running", Date.now());
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: second, childSessionId: "child2" }).ok);
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: second, stage: { stage: "merged",
      pullRequests: [{ repository: "team/repo", number: 36 }, { repository: "team/repo", number: 37 }] } }).ok);
    setForge(36, "closed"); setForge(37, "merged");
    h.svc.onSessionStatus("child2", "idle");
    const report = h.db.appendEvent("child2", { kind: "agent_message", text: "Delivered.", final: true }, Date.now()).seq;
    assert.ok(h.svc.verifyCampaignChild("root", { childSessionId: "child2", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: second, outcome: "delivered" } }).ok);
    useObserver();
    const c = await close("seventeen-excluded");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    const before = forgeReads.length;
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.deepEqual(forgeReads.slice(before).map((batch) => batch.length).sort((a, b) => a - b), [1, 16],
      "17 excluded refs go out as one full batch and one more");
    assert.equal(h.state.executes, 1);
  } finally { h.db.close(); }
});

/** #3793: the closure binds each child's prompts by identity and content. A durable outbox retry
 * rewrites only delivery bookkeeping (`attemptCount`, `updatedAt`), which must not revoke it. */
function promptedClosure(requestId: string) {
  const fixture = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  const { h, setForge, close, useObserver } = fixture;
  setForge(9, "closed"); setForge(10, "merged");
  useObserver();
  // Enabling Full Control sent the bound child a policy notice its runner has not acknowledged.
  const prompts = () => h.db.getSession("child")?.pendingPrompts ?? [];
  assert.equal(prompts().length, 1);
  const commandId = prompts()[0]!.commandId;
  assert.equal(prompts()[0]!.state, "sent");
  const pending = () => prompts().find((prompt) => prompt.commandId === commandId);
  return { ...fixture, prompts, pending, approved: async () => {
    const c = await close(requestId);
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(d.resourceSnapshot.category === "issue_closure" && d.resourceSnapshot.activeChildren.some((child) => child.sessionId === "child"),
      "the prompted child is bound to the closure");
    assert.ok(h.approve(d).ok);
    return d;
  } };
}

test("#3793 a prompt delivery retry between approval and execution keeps the closure", async () => {
  const { h, pending, approved } = promptedClosure("retried-prompt");
  try {
    const d = await approved();
    const before = pending()!;
    // The outbox's backoff has elapsed: it sends the same unacknowledged prompt again.
    h.svc.retryDuePrompts(Date.now() + 60_000);
    const after = pending()!;
    assert.equal(after.commandId, before.commandId);
    assert.ok(after.attemptCount > before.attemptCount, `retried: ${before.attemptCount} -> ${after.attemptCount}`);
    assert.ok(after.updatedAt > before.updatedAt);
    // The runner then admits it to its queue: another delivery transition of the same prompt.
    assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update", commandId: after.commandId,
      sessionId: "child", state: "queued", revision: after.revision + 1 }));
    assert.equal(pending()!.state, "queued");
    assert.equal(h.db.getSession("child")?.queued?.[0]?.durableDeliveryState, "queued");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
  } finally { h.db.close(); }
});

test("#3793 a new prompt for a bound child between approval and execution still revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("new-prompt");
  try {
    const d = await approved();
    // Admitted while the child waits for a provider slot, the prompt takes the durable outbox.
    h.db.updateSessionStatus("child", "queued", Date.now());
    const sent = h.svc.prompt("child", "Start on something else");
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.equal(prompts().length, 2, "a second durable prompt is pending");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});

/** #3835: a prompt to an idle child without a worktree is sent straight to the runner, so it is
 * neither pending nor queued. Its admission must still change the bound child's digest at once,
 * not only when the runner echoes it back as a user message. */
test("#3835 an immediate-lane prompt for a bound idle child between approval and execution revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("immediate-prompt");
  try {
    const d = await approved();
    const child = h.db.getSession("child")!;
    assert.equal(child.status, "idle");
    assert.equal(child.worktreePath, null);
    const queued = JSON.stringify(child.queued ?? []);
    const sends: string[] = [];
    h.hub.sendToRunner = (_runner, message) => { sends.push(message.type); return true; };
    // What the session prompt route admits: with no turn in flight, nothing is steered.
    const sent = await h.svc.promptOrSteer("child", "Start on something else");
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.deepEqual(sends, ["prompt_session"], "the prompt went straight to the runner");
    assert.equal(h.db.getSession("child")?.status, "running");
    assert.equal(prompts().length, 1, "no durable prompt was staged");
    assert.equal(JSON.stringify(h.db.getSession("child")?.queued ?? []), queued, "nor queued");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});

test("#3835 an immediate-lane prompt admitted and echoed before the closure request keeps it", async () => {
  const { h, approved } = promptedClosure("echoed-prompt");
  try {
    const sent = await h.svc.promptOrSteer("child", "One more check");
    assert.ok(sent.ok, sent.error ?? "prompt");
    h.db.appendEvent("child", { kind: "user_message", text: "One more check" }, Date.now());
    h.svc.onSessionStatus("child", "idle");
    const d = await approved();
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
  } finally { h.db.close(); }
});

/** #3877: a prompt for a child that is mid-turn is steered into that turn, so it is recorded only
 * as a steering attempt. Make the bound child steerable: running with a live turn on a provider
 * that steers. While `hold` is set, the runner's steering reply waits for `release()`. */
function steerable(h: ReturnType<typeof harness>) {
  h.db.registerRunner({ ...h.metadata, agents: h.metadata.agents.map((agent) => ({ ...agent, capabilities: {
    models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, supportsSteering: true } })) },
  Date.now(), PROTOCOL_VERSION);
  h.db.updateSessionStatus("child", "running", Date.now());
  h.hub.activeTurnIdForSession = (id) => id === "child" ? "turn-live" : undefined;
  const steering = { hold: false, submissions: [] as string[], waiting: [] as Array<() => void>,
    release() { for (const resume of this.waiting.splice(0)) resume(); } };
  const runner = h.hub.requestFromRunner;
  h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
    if (message.type !== "steer_session") return runner(runnerId, requestId, message, timeout);
    steering.submissions.push(message.submissionId);
    if (steering.hold) await new Promise<void>((resume) => steering.waiting.push(resume));
    return { type: "steer_session_result", requestId: message.requestId, submissionId: message.submissionId,
      sessionId: message.sessionId, turnId: message.turnId, disposition: "accepted", reason: "accepted", providerTurnId: "provider-turn" };
  };
  return steering;
}

test("#3877 a prompt steered into a bound running child between approval and execution revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("steered-prompt");
  try {
    const steering = steerable(h);
    const d = await approved();
    const transcript = h.db.issueClosureAssignmentState("child").latest;
    const pending = JSON.stringify(prompts());
    const queued = JSON.stringify(h.db.getSession("child")?.queued ?? []);
    const sends: string[] = [];
    h.hub.sendToRunner = (_runner, message) => { sends.push(message.type); return true; };
    // What the session prompt route admits: with a turn in flight, the message is steered into it.
    const sent = await h.svc.promptOrSteer("child", "Start on something else");
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.equal(sent.data?.promptDelivery?.lane, "steered");
    assert.equal(steering.submissions.length, 1, "one steer_session went to the runner");
    assert.deepEqual(sends, [], "no prompt_session was sent");
    // Nothing the closure digest read before #3877 records the steered message.
    assert.equal(h.db.getSession("child")?.status, "running");
    assert.deepEqual(h.db.issueClosureAssignmentState("child").latest, transcript, "the runner has not echoed it");
    assert.equal(JSON.stringify(prompts()), pending, "no durable prompt was staged");
    assert.equal(JSON.stringify(h.db.getSession("child")?.queued ?? []), queued, "nor queued");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});

test("#3877 a steering attempt admitted before the closure request keeps it whatever the runner later reports", async () => {
  const { h, settle, approved } = promptedClosure("steered-before");
  const steering = steerable(h);
  try {
    steering.hold = true;
    let returned = false;
    const steered = h.svc.promptOrSteer("child", "One more check").finally(() => { returned = true; });
    await settle(() => steering.waiting.length > 0 || returned);
    assert.equal(steering.waiting.length, 1, "the steer is waiting on the runner");
    const submission = steering.submissions[0]!;
    assert.equal(h.db.findSteeringAttemptBySubmission("child", submission)?.attempt.state, "pending");
    const d = await approved();
    // The runner's reply settles the attempt after approval; no new instruction reached the child.
    steering.release();
    const sent = await steered;
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.equal(sent.data?.promptDelivery?.lane, "steered");
    assert.equal(h.db.findSteeringAttemptBySubmission("child", submission)?.attempt.state, "accepted");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
  } finally { steering.release(); h.db.close(); }
});

test("#3877 the closure state of a never-steered child is unchanged and a steered one binds its latest attempt", async () => {
  const { h } = promptedClosure("steering-state");
  try {
    // Exactly what the digest bound before #3877, so approvals pending across the upgrade survive.
    const unsteered = h.db.issueClosureAssignmentState("child");
    assert.deepEqual(Object.keys(unsteered), ["latest", "command"]);
    const steering = steerable(h);
    for (const text of ["First redirect", "Second redirect"]) {
      const sent = await h.svc.promptOrSteer("child", text);
      assert.ok(sent.ok, sent.error ?? "prompt");
      assert.equal(sent.data?.promptDelivery?.lane, "steered");
    }
    const latest = h.db.findSteeringAttemptBySubmission("child", steering.submissions[1]!)!;
    // Compared as the closure digest serializes it.
    assert.equal(JSON.stringify(h.db.issueClosureAssignmentState("child")),
      JSON.stringify({ ...unsteered, steering: { id: latest.requestId, digest: latest.requestSha256, count: 2 } }));
  } finally { h.db.close(); }
});

test("#3877 a prompt steered after the wall clock steps back between approval and execution still revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("steered-clock-step");
  const now = Date.now;
  try {
    const steering = steerable(h);
    const first = await h.svc.promptOrSteer("child", "First redirect");
    assert.ok(first.ok, first.error ?? "prompt");
    const a = h.db.findSteeringAttemptBySubmission("child", steering.submissions[0]!)!;
    const d = await approved();
    const pending = JSON.stringify(prompts());
    // An NTP step or VM restore: the next attempt is stamped before the one the approval bound.
    Date.now = () => a.attempt.createdAt - 60_000;
    const second = await h.svc.promptOrSteer("child", "Start on something else");
    Date.now = now;
    assert.ok(second.ok, second.error ?? "prompt");
    assert.equal(second.data?.promptDelivery?.lane, "steered");
    const b = h.db.findSteeringAttemptBySubmission("child", steering.submissions[1]!)!;
    assert.ok(b.attempt.createdAt < a.attempt.createdAt, "the new attempt is stamped earlier");
    assert.equal(JSON.stringify(prompts()), pending, "and the runner has echoed nothing");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { Date.now = now; h.db.close(); }
});

test("#2940 concurrent executes of one closure share one uncached read (CR-2.3)", async () => {
  const { h, setForge, forgeReads, reads, close, useObserver, settle } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    setForge(9, "closed"); setForge(10, "merged");
    useObserver();
    const c = await close("concurrent-executes");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    const before = forgeReads.length;
    reads.hold = true;
    const executes = Array.from({ length: 4 }, () => h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest));
    await settle(() => reads.waiting.length > 0);
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(forgeReads.slice(before), [[9]], "one read in flight for every concurrent execute");
    reads.hold = false;
    reads.release();
    const results = await Promise.all(executes);
    assert.equal(results.filter((result) => result.ok).length, 1, "exactly one execute dispatches");
    assert.equal(h.state.executes, 1);
    // A settled answer is never reused: a later execute of the consumed occurrence reads nothing new and is refused.
    assert.equal((await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest)).ok, false);
    assert.deepEqual(forgeReads.slice(before), [[9]]);
  } finally { h.db.close(); }
});

test("#2940 an excluded pull request reopened during scope synchronization is never closed over (CR-3.1)", async () => {
  const { h, setForge, forgeReads, syncs, close, useObserver, settle } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    setForge(9, "closed"); setForge(10, "merged");
    useObserver();
    const c = await close("reopened-during-sync");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    const before = forgeReads.length;
    syncs.hold = true;
    const pending = h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    await settle(() => syncs.waiting.length > 0);
    assert.equal(forgeReads.length, before, "no excluded read before synchronization settles");
    // GitHub reopens the excluded pull request; the store still says closed.
    setForge(9, "open");
    syncs.hold = false;
    syncs.release();
    const executed = await pending;
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.deepEqual(forgeReads.slice(before), [[9]], "the uncached read follows synchronization");
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "approved", "the approval stays unconsumed");
  } finally { h.db.close(); }
});

// #2940, observed live: before #3824 a child's in-boundary publication was routed to the person,
// who approved its exact payload. The fallback carries no issueAdmission, so the Orchestrator could
// never admit the published issue: the bounded path needed an admission it never got.
type ScopeHarness = ReturnType<typeof harness>;

function member(h: ScopeHarness, userId: string, role: "owner" | "admin" | "operator" | "viewer") {
  h.db.raw().prepare("INSERT INTO identity_users(user_id,display_name,created_at,updated_at) VALUES (?,?,1,1)").run(userId, userId);
  h.db.raw().prepare("INSERT INTO identity_memberships(organization_id,user_id,role,created_at,updated_at) VALUES (?,?,?,1,1)").run(h.principal.organizationId, userId, role);
}

async function humanApprovedPublication(h: ScopeHarness, options: { approver?: string; title?: string; issue?: number; accept?: boolean;
  resolution?: Record<string, unknown> } = {}) {
  const { approver = h.principal.userId, title = "Human approved repair", issue = 101, accept = true } = options;
  const rec = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]}); assert.ok(rec.ok,rec.error ?? "record");
  if (accept) assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
  // A failed inspection routes the child's request to the person, as #3814 and #3815 were. Naming
  // an unaccepted recommendation is refused instead (#4065), so that request names none.
  h.state.publicationOk = false;
  const created = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:`human-${title}`,resourceKey:`human-${title}`,resourceSnapshot:{category:"follow_up_issue_publication",
    repository:"team/repo",sanitizedTitle:`[Feature]: ${title}`,sanitizedBody:body,labels:[],...(accept ? { recommendationId:rec.data!.id } : {})}});
  h.state.publicationOk = true;
  assert.ok(created.ok,created.error ?? "publication"); const decision = created.data!;
  assert.equal(decision.authority,"human");
  assert.ok(decision.resourceSnapshot.category === "follow_up_issue_publication" && !decision.resourceSnapshot.issueAdmission &&
    decision.resourceSnapshot.recommendationId === (accept ? rec.data!.id : undefined));
  const approved = h.svc.resolveWorkflowDecision("root","child",decision.occurrenceId,
    { outcome: "approve", ...options.resolution } as import("@wollipog/protocol").ResolveWorkflowDecisionRequest,"human",{kind:"human",id:approver},()=>true);
  assert.ok(approved.ok,approved.error ?? "human approval");
  const consumed = await h.svc.consumeWorkflowDecision("child",decision.occurrenceId,{resourceSnapshot:decision.resourceSnapshot}); assert.ok(consumed.ok,consumed.error ?? "consume");
  h.state.publicationTitles[issue] = `[Feature]: ${title}`;
  if (accept) assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Published payload read back",
    resultingWorkItemKey:`followup:${rec.data!.id}`,resultingIssue:{repository:"team/repo",number:issue}}).ok);
  return { decision, recommendationId: rec.data!.id };
}

const followUpScope = (h: ScopeHarness, requestId: string, publicationOccurrenceId: string, issue = 101, expectedRevision = 1) =>
  h.svc.proposeCampaignIssueScope("root",{requestId,expectedRevision,additions:[{repository:"team/repo",number:issue}],removals:[],
    explanation:"Published follow-up of an accepted recommendation",lineage:{kind:"follow_up",publicationOccurrenceId}});

const refusalCode = (result: { ok: boolean; errorDetails?: Record<string, string | number> }) => result.ok ? "admitted" : result.errorDetails?.code;

const approvedAt = (h: ScopeHarness, decision: WorkflowDecisionView) =>
  h.db.workflowDecisionHumanApprover(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!)!.approvedAt;

type ScopeSnapshot = Extract<WorkflowDecisionView["resourceSnapshot"],{category:"campaign_issue_scope"}>;

test("#2940 a person-approved consumed publication of an accepted recommendation admits exactly its issue, once", async () => {
  const h = harness(true, 3);
  try {
    const p = await humanApprovedPublication(h);
    const scope = await followUpScope(h, "human-approved", p.decision.occurrenceId);
    assert.ok(scope.ok, scope.error ?? "scope"); assert.equal(scope.data!.authority, "orchestrator");
    const snapshot = scope.data!.resourceSnapshot as ScopeSnapshot;
    assert.deepEqual(snapshot.verifiedPublications, [{ publicationOccurrenceId: p.decision.occurrenceId, issue: 101 }]);
    // The admission evidence names the person's approval, so it differs from a bounded grant's.
    const bounded = { occurrenceId: p.decision.occurrenceId, payloadDigest: p.decision.resourceDigest, issue: 101 };
    assert.equal(snapshot.issueAdmission!.evidenceDigest, issueEvidenceDigest({ ...bounded, approval: { kind: "human", approvedByUserId: h.principal.userId,
      approvedAt: approvedAt(h, p.decision), basis: "boundary_author", objective: "current_authorization" } }));
    assert.notEqual(snapshot.issueAdmission!.evidenceDigest, issueEvidenceDigest(bounded));
    assert.ok(h.approve(scope.data!).ok);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101]);
    assert.equal(h.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), 101);
    // The same grant cannot admit a second issue, even after the ledger names another one.
    h.state.publicationTitles[102] = "[Feature]: Human approved repair";
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:p.recommendationId,disposition:"accepted",reason:"Copied payload claim",
      resultingWorkItemKey:`copy:${p.recommendationId}`,resultingIssue:{repository:"team/repo",number:102}}).ok);
    const reuse = await followUpScope(h, "human-approved-reuse", p.decision.occurrenceId, 102, 2);
    assert.equal(refusalCode(reuse), "publication_already_admitted"); assert.equal(reuse.status, 409);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101]);
  } finally { h.db.close(); }
});

test("#2940 a person-approved publication grants scope only when its approver is the boundary author or a campaign owner", async () => {
  const h = harness(true, 3);
  try {
    member(h, "usr_operator", "operator");
    const p = await humanApprovedPublication(h, { approver: "usr_operator" });
    const refused = await followUpScope(h, "other-person", p.decision.occurrenceId);
    assert.equal(refusalCode(refused), "publication_approver_not_owner"); assert.equal(refused.status, 403);
    assert.match(refused.error!, /neither the Full Control boundary's author nor an owner of this campaign/);
    assert.equal(JSON.stringify(refused).includes("usr_operator"), false, "the refusal names no person");
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
  } finally { h.db.close(); }
  // Every member owns an organization-owned campaign's session, so only an active owner or admin of
  // the organization counts there: not an operator (above), a viewer or a suspended administrator.
  const shared = harness(true, 5);
  try {
    member(shared, "usr_viewer", "viewer"); member(shared, "usr_suspended", "admin"); member(shared, "usr_admin", "admin");
    shared.db.raw().prepare("UPDATE identity_users SET status='suspended' WHERE user_id='usr_suspended'").run();
    const viewer = await humanApprovedPublication(shared, { approver: "usr_viewer", title: "Viewer repair", issue: 101 });
    assert.equal(refusalCode(await followUpScope(shared, "viewer", viewer.decision.occurrenceId, 101)), "publication_approver_not_owner");
    const suspended = await humanApprovedPublication(shared, { approver: "usr_suspended", title: "Suspended repair", issue: 102 });
    assert.equal(refusalCode(await followUpScope(shared, "suspended", suspended.decision.occurrenceId, 102)), "publication_approver_not_owner");
    const owner = await humanApprovedPublication(shared, { approver: "usr_admin", title: "Owner repair", issue: 103 });
    const admitted = await followUpScope(shared, "owner", owner.decision.occurrenceId, 103);
    assert.ok(admitted.ok, admitted.error ?? "owner scope");
    assert.equal((admitted.data!.resourceSnapshot as ScopeSnapshot).issueAdmission!.evidenceDigest, issueEvidenceDigest({ occurrenceId: owner.decision.occurrenceId,
      payloadDigest: owner.decision.resourceDigest, issue: 103, approval: { kind: "human", approvedByUserId: "usr_admin", approvedAt: approvedAt(shared, owner.decision), basis: "campaign_owner", objective: "current_authorization" } }));
  } finally { shared.db.close(); }
  // A user-owned campaign is owned by that user alone; another administrator is not its owner.
  const personal = harness(true, 5);
  try {
    member(personal, "usr_owner", "operator"); member(personal, "usr_admin", "admin");
    personal.db.raw().prepare("UPDATE session_ownership SET owner_kind='user', owner_id='usr_owner' WHERE session_id='root'").run();
    const other = await humanApprovedPublication(personal, { approver: "usr_admin", title: "Administrator repair", issue: 101 });
    assert.equal(refusalCode(await followUpScope(personal, "administrator", other.decision.occurrenceId, 101)), "publication_approver_not_owner");
    const owned = await humanApprovedPublication(personal, { approver: "usr_owner", title: "Owner repair", issue: 102 });
    const admitted = await followUpScope(personal, "user-owner", owned.decision.occurrenceId, 102);
    assert.ok(admitted.ok, admitted.error ?? "user owner scope");
  } finally { personal.db.close(); }
});

test("#2940 a person-approved publication cannot exceed the human-set issue limit", async () => {
  const h = harness(true, 1);
  try {
    const p = await humanApprovedPublication(h);
    const refused = await followUpScope(h, "over-limit", p.decision.occurrenceId);
    assert.equal(refusalCode(refused), "capacity_exhausted"); assert.equal(refused.status, 409);
    assert.equal(h.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), null);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
    // The limit is the campaign's, not the raw Maximum Issues: once the person admits a follow-up
    // past the approval limit, its slot holds an issue here too (#3826).
    const budgetAuthority = { version: 1 as const, concurrency: 3, acceptedFollowUps: 0, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    const policy = h.db.getSession("root")!.orchestratorPolicy!;
    if (policy.control?.mode === "full_control") policy.control.boundary.budgetAuthority = budgetAuthority;
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
    h.db.campaignBudgets.authorize("root", budgetAuthority);
    const other = h.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title: "Other repair", originWorkItemIds: [h.item.id] });
    assert.ok(other.ok, other.error ?? "record");
    const accept = () => h.svc.adjudicateCampaignRecommendation("root", { recommendationId: other.data!.id, disposition: "accepted", reason: "Observed related work" });
    const over = accept(); assert.equal(over.ok, false);
    const admission = h.db.workflowDecisionByOccurrence(/decision (workflow_[a-f0-9]+)/u.exec(over.error ?? "")![1]!)!;
    assert.ok(h.approve(admission).ok); assert.ok(accept().ok);
    assert.equal(h.db.campaignIssueLimit("root", 1), 2);
    const admitted = await followUpScope(h, "within-admitted-slot", p.decision.occurrenceId);
    assert.ok(admitted.ok, admitted.error ?? "admitted slot");
  } finally { h.db.close(); }
});

// CR-1.1: a person's approval proves the current objective only when it followed the current
// authorization, or when the boundary the server recorded with it has the current author and
// objective. A changed objective, or an approval recorded without its boundary, needs fresh review.
test("#2940 a person-approved publication carries its approval only across a same-author, same-objective re-mint", async () => {
  const reauthorize = (h: ScopeHarness, objective: string, expectedRevision = 2) => h.svc.setCampaignControl("root", { mode: "full_control", objective,
    operations: ["campaign_issue_scope", "issue_closure", "follow_up_issue_publication", "implementation_question"], delegatablePolicyIds: [],
    issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed", "not_planned"] } }, expectedRevision, h.principal);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const changed = harness(true, 3);
  try {
    const p = await humanApprovedPublication(changed);
    await tick();
    assert.ok(reauthorize(changed, "A different objective").ok);
    const refused = await followUpScope(changed, "changed-objective", p.decision.occurrenceId);
    assert.equal(refusalCode(refused), "publication_approved_under_earlier_boundary"); assert.equal(refused.status, 403);
    assert.match(refused.error!, /approved before the current Full Control authorization.*Campaign Status/);
    assert.deepEqual(changed.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
    assert.equal(changed.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), null);
    // A publication the person approves under the new authorization is admitted.
    const fresh = await humanApprovedPublication(changed, { title: "Fresh repair", issue: 102 });
    assert.ok((await followUpScope(changed, "fresh-objective", fresh.decision.occurrenceId, 102)).ok);
  } finally { changed.db.close(); }
  const remint = async (h: ScopeHarness) => {
    await tick();
    const added = await h.svc.proposeCampaignIssueScope("root",{requestId:"human-remint",expectedRevision:1,additions:[{repository:"team/repo",number:150}],removals:[],
      explanation:"Owner adds separate scope"},()=>true,h.principal);
    assert.ok(added.ok, added.error ?? "human scope"); assert.ok(h.approve(added.data!).ok);
  };
  const kept = harness(true, 3);
  try {
    const p = await humanApprovedPublication(kept);
    await remint(kept);
    const admitted = await followUpScope(kept, "same-objective-remint", p.decision.occurrenceId, 101, 2);
    assert.ok(admitted.ok, admitted.error ?? "re-minted scope");
    assert.equal((admitted.data!.resourceSnapshot as ScopeSnapshot).issueAdmission!.evidenceDigest, issueEvidenceDigest({ occurrenceId: p.decision.occurrenceId,
      payloadDigest: p.decision.resourceDigest, issue: 101, approval: { kind: "human", approvedByUserId: kept.principal.userId, approvedAt: approvedAt(kept, p.decision),
        basis: "boundary_author", objective: "recorded_boundary" } }));
  } finally { kept.db.close(); }
  // An approval whose audit carries no recorded boundary, as every one before this change, proves
  // nothing once the boundary is re-minted after it.
  const unrecorded = harness(true, 3);
  try {
    const p = await humanApprovedPublication(unrecorded);
    unrecorded.db.raw().prepare(`UPDATE governance_audit SET workflow_decision=json_remove(workflow_decision, '$.publicationAuthority')
      WHERE request_id=? AND stage='resolution' AND outcome='allowed'`).run(p.decision.occurrenceId);
    await remint(unrecorded);
    assert.equal(refusalCode(await followUpScope(unrecorded, "unrecorded-remint", p.decision.occurrenceId, 101, 2)), "publication_approved_under_earlier_boundary");
    assert.deepEqual(unrecorded.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 150]);
  } finally { unrecorded.db.close(); }
});

test("#2940 only the server records the boundary of a person's publication approval", async () => {
  const h = harness(true, 3);
  try {
    // A resolution that names its own boundary is ignored: the record is the controller's.
    const forged = { authorizedByUserId: "usr_forged", objectiveDigest: "1".repeat(64) };
    const p = await humanApprovedPublication(h, { resolution: { publicationAuthority: forged } });
    const boundary = (h.db.getSession("root")!.orchestratorPolicy!.control as Extract<CampaignControl,{mode:"full_control"}>).boundary;
    assert.deepEqual(h.db.workflowDecisionHumanApprover(h.db.workflowDecisionByOccurrence(p.decision.occurrenceId)!)!.publicationAuthority,
      { authorizedByUserId: boundary.authorizedByUserId, objectiveDigest: issueEvidenceDigest(boundary.objective) });
  } finally { h.db.close(); }
  const custom = harness(false, 3);
  try {
    const rec = custom.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Custom repair",originWorkItemIds:[custom.item.id]}); assert.ok(rec.ok);
    const publication = await custom.svc.createWorkflowDecisionWithVideo("child",{requestId:"custom-pub",resourceKey:"custom-pub",resourceSnapshot:{category:"follow_up_issue_publication",
      repository:"team/repo",sanitizedTitle:"Custom repair",sanitizedBody:body,labels:[]}});
    assert.ok(publication.ok);
    assert.ok(custom.svc.resolveWorkflowDecision("root","child",publication.data!.occurrenceId,{outcome:"approve"},"human",{kind:"human",id:custom.principal.userId},()=>true).ok);
    assert.equal(custom.db.workflowDecisionHumanApprover(custom.db.workflowDecisionByOccurrence(publication.data!.occurrenceId)!)!.publicationAuthority, undefined,
      "no Full Control issue boundary, nothing recorded");
  } finally { custom.db.close(); }
});

test("#2940 a person-approved publication names the failed condition: removed origin, unaccepted recommendation, payload mismatch", async () => {
  const removed = harness(true, 3);
  try {
    // The owner's removal re-mints the boundary with the same objective, so only the origin fails.
    const p = await humanApprovedPublication(removed);
    const swap = await removed.svc.proposeCampaignIssueScope("root",{requestId:"swap-origin",expectedRevision:1,additions:[{repository:"team/repo",number:150}],
      removals:[{repository:"team/repo",number:100}],explanation:"Owner replaces the origin"},()=>true,removed.principal);
    assert.ok(swap.ok, swap.error ?? "swap"); assert.ok(removed.approve(swap.data!).ok);
    const refused = await followUpScope(removed, "removed-origin", p.decision.occurrenceId, 101, 2);
    assert.equal(refusalCode(refused), "origin_outside_scope");
    assert.equal(refused.error, "The published follow-up's authorized origins were removed from scope");
  } finally { removed.db.close(); }
  const unaccepted = harness(true, 3);
  try {
    const p = await humanApprovedPublication(unaccepted, { accept: false });
    assert.equal(refusalCode(await followUpScope(unaccepted, "unaccepted", p.decision.occurrenceId)), "recommendation_not_accepted");
  } finally { unaccepted.db.close(); }
  const unrecorded = harness(true, 3);
  try {
    const p = await humanApprovedPublication(unrecorded);
    unrecorded.state.publicationTitles[109] = "[Feature]: Human approved repair";
    assert.equal(refusalCode(await followUpScope(unrecorded, "other-issue", p.decision.occurrenceId, 109)), "resulting_issue_mismatch");
  } finally { unrecorded.db.close(); }
  const mismatch = harness(true, 3);
  try {
    const p = await humanApprovedPublication(mismatch);
    const runner = mismatch.hub.requestFromRunner.bind(mismatch.hub);
    mismatch.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      const result = await runner(runnerId, requestId, message, timeout);
      return message.type === "campaign_issue_scope" && message.operation === "inspect" && message.publication && result.type === "campaign_issue_scope_result"
        ? { ...result, candidates: result.candidates?.map((c) => ({ ...c, title: "[Feature]: An edited title" })) } : result;
    };
    assert.equal(refusalCode(await followUpScope(mismatch, "payload-mismatch", p.decision.occurrenceId)), "payload_mismatch");
    assert.equal(mismatch.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), null);
  } finally { mismatch.db.close(); }
});

test("#2940 Orchestrator scope refusals name their condition with a bounded code and no requested content", async () => {
  const h = harness(true, 5);
  try {
    const propose = (requestId: string, change: Partial<import("@wollipog/protocol").CampaignIssueScopeRequest>) => h.svc.proposeCampaignIssueScope("root",
      { requestId, expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }], removals: [], explanation: "Secret-looking explanation text", ...change });
    const otherEpic = await propose("other-epic", { lineage: { kind: "epic", epic: 999 } });
    assert.equal(refusalCode(otherEpic), "epic_not_authorized"); assert.equal(otherEpic.status, 403);
    assert.match(otherEpic.error!, /Campaign Status/);
    assert.equal(JSON.stringify(otherEpic).includes("Secret-looking"), false);
    assert.equal(refusalCode(await propose("unknown-publication", { lineage: { kind: "follow_up", publicationOccurrenceId: "missing" } })), "publication_not_found");
    assert.equal(refusalCode(await propose("two-follow-ups", { additions: [{ repository: "team/repo", number: 101 }, { repository: "team/repo", number: 102 }],
      lineage: { kind: "follow_up", publicationOccurrenceId: "missing" } })), "follow_up_not_single");
    const pending = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:"pending-human",resourceKey:"pending-human",resourceSnapshot:{category:"follow_up_issue_publication",
      repository:"team/repo",sanitizedTitle:"Pending repair",sanitizedBody:body,labels:[]}});
    assert.ok(pending.ok, pending.error ?? "pending");
    assert.equal(refusalCode(await propose("pending", { lineage: { kind: "follow_up", publicationOccurrenceId: pending.data!.occurrenceId } })), "publication_not_consumed");
  } finally { h.db.close(); }
  const noFollowUps = harness(true, 5);
  try {
    assert.ok(noFollowUps.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:["campaign_issue_scope"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:false,maxIssues:5,closureReasons:[]}},2,noFollowUps.principal).ok);
    assert.equal(refusalCode(await followUpScope(noFollowUps, "no-follow-ups", "missing")), "follow_ups_not_authorized");
  } finally { noFollowUps.db.close(); }
});

const pendingScopeRequests = (h: ReturnType<typeof harness>) =>
  h.db.pendingWorkflowDecisionsForController("root").filter((d) => d.category === "campaign_issue_scope");
const boundaryMaxIssues = (h: ReturnType<typeof harness>) => {
  const control = h.db.getSession("root")!.orchestratorPolicy!.control;
  return control?.mode === "full_control" ? control.boundary.issueAuthority?.maxIssues : undefined;
};
const proposeWithoutLineage = (h: ReturnType<typeof harness>, requestId: string, numbers: number[], explanation = "The owner asked for these in chat") =>
  h.svc.proposeCampaignIssueScope("root", { requestId, expectedRevision: 1, additions: numbers.map((number) => ({ repository: "team/repo", number })),
    removals: [], explanation });

test("#4267 additions without lineage become exactly one pending owner request instead of a 403, and a repeat returns it", async () => {
  const h = harness(true, 5);
  try {
    // An outstanding decision the owner's approval will revoke, as every Full Control human scope approval does (#3915).
    const question = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "question", resourceKey: "question",
      resourceSnapshot: { category: "implementation_question", question: "Which layout?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(question.ok, question.error ?? "question");
    const proposed = await proposeWithoutLineage(h, "owner-asked", [101, 102]);
    assert.ok(proposed.ok, proposed.error ?? "refused");
    assert.equal(proposed.data!.authority, "human"); assert.equal(proposed.data!.status, "pending");
    const snapshot = proposed.data!.resourceSnapshot as ScopeSnapshot;
    assert.deepEqual(snapshot.additions, [101, 102]);
    assert.equal(snapshot.explanation, "The owner asked for these in chat");
    assert.deepEqual(snapshot.ownerReview, { cause: "lineage_missing" });
    assert.equal(snapshot.issueAdmission, undefined); assert.equal(snapshot.lineage, undefined);
    assert.deepEqual(snapshot.affectedDecisions, [question.data!.occurrenceId]);
    assert.deepEqual(pendingScopeRequests(h).map((d) => d.occurrenceId), [proposed.data!.occurrenceId]);
    // Re-proposing the same additions, reworded under a new request id, returns the same request.
    const again = await proposeWithoutLineage(h, "owner-asked-again", [102, 101], "Reworded rationale");
    assert.ok(again.ok, again.error ?? "refused");
    assert.equal(again.data!.occurrenceId, proposed.data!.occurrenceId);
    assert.deepEqual(pendingScopeRequests(h).map((d) => d.occurrenceId), [proposed.data!.occurrenceId]);
    // Campaign Status lists it under Waiting for You so the owner can open the request.
    assert.deepEqual(h.db.campaignOwnerDecisions("root")?.items.map(({ occurrenceId, category, summary, handedOff }) => ({ occurrenceId, category, summary, handedOff })),
      [{ occurrenceId: proposed.data!.occurrenceId, category: "campaign_issue_scope", summary: "Add team/repo#101, team/repo#102", handedOff: false }]);
    // The owner approves it in one step: the scope holds the additions and the outstanding decision is revoked.
    assert.ok(h.approve(proposed.data!).ok);
    assert.equal(h.db.campaignOwnerDecisions("root"), null);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101, 102]);
    assert.equal(h.db.workflowDecisionByOccurrence(question.data!.occurrenceId)!.status, "revoked");
    assert.equal(boundaryMaxIssues(h), 5);
  } finally { h.db.close(); }
});

test("#4267 an owner request states the Maximum Issues increase its additions need; approving applies both and denying neither", async () => {
  for (const outcome of ["approve", "deny"] as const) {
    const h = harness(true, 2);
    try {
      const proposed = await proposeWithoutLineage(h, `over-limit-${outcome}`, [101, 102]);
      assert.ok(proposed.ok, proposed.error ?? "refused");
      assert.equal(proposed.data!.authority, "human");
      assert.deepEqual((proposed.data!.resourceSnapshot as ScopeSnapshot).ownerReview, { cause: "lineage_missing", maxIssuesIncrease: { from: 2, increase: 1 } });
      assert.equal(h.db.campaignOwnerDecisions("root")?.items[0]?.summary, "Add team/repo#101, team/repo#102, raising Maximum Issues from 2 to 3");
      const resolved = h.svc.resolveWorkflowDecision("root", "root", proposed.data!.occurrenceId, { outcome }, "human", { kind: "human", id: h.principal.userId }, () => true);
      assert.ok(resolved.ok, resolved.error ?? outcome);
      if (outcome === "approve") {
        assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101, 102]);
        assert.equal(boundaryMaxIssues(h), 3);
      } else {
        assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
        assert.equal(boundaryMaxIssues(h), 2);
        assert.equal(h.db.workflowDecisionByOccurrence(proposed.data!.occurrenceId)!.status, "denied");
      }
    } finally { h.db.close(); }
  }
  // A lineage-bearing proposal past the limit is still refused, naming the owner's route (#4061).
  const epic = harness(true, 1);
  try {
    const refused = await epic.proposal("epic-over-limit");
    assert.equal(refusalCode(refused), "capacity_exhausted"); assert.equal(refused.status, 409);
  } finally { epic.db.close(); }
});

test("#4267 only the owner resolves an owner request; the Orchestrator cannot approve, consume or widen it", async () => {
  const h = harness(true, 2);
  try {
    const proposed = await proposeWithoutLineage(h, "owner-only", [101, 102]);
    assert.ok(proposed.ok, proposed.error ?? "refused");
    const occurrenceId = proposed.data!.occurrenceId;
    const asAgent = h.svc.resolveWorkflowDecision("root", "root", occurrenceId, { outcome: "approve" }, "human", { kind: "agent", id: "root" }, () => true);
    assert.equal(asAgent.ok, false);
    const asOrchestrator = h.svc.resolveWorkflowDecision("root", "root", occurrenceId, { outcome: "approve" }, "orchestrator", { kind: "agent", id: "root" }, () => true);
    assert.equal(asOrchestrator.ok, false);
    const consumed = await h.svc.consumeWorkflowDecision("root", occurrenceId, { resourceSnapshot: proposed.data!.resourceSnapshot });
    assert.equal(consumed.ok, false); assert.equal(consumed.status, 403);
    // An agent cannot hand the server its own owner review or a larger increase.
    const forged = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "forged", resourceKey: "campaign_issue_scope:root",
      resourceSnapshot: { ...(proposed.data!.resourceSnapshot as ScopeSnapshot), ownerReview: { cause: "lineage_missing", maxIssuesIncrease: { from: 2, increase: 50 } } } });
    assert.equal(forged.ok, false); assert.equal(forged.status, 403);
    assert.equal(h.db.workflowDecisionByOccurrence(occurrenceId)!.status, "pending");
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
    assert.equal(boundaryMaxIssues(h), 2);
  } finally { h.db.close(); }
});

test("#4267 an owner request counts only the publication slots its approval keeps, as its resolution does", async () => {
  // At the ceiling and below it: a pending admitted publication is revoked by the owner's approval,
  // so it neither refuses the addition nor asks for a Maximum Issues increase.
  for (const [maximum, issues] of [[100, [...Array.from({ length: 98 }, (_, i) => i + 1), 100]], [2, [100]]] as const) {
    const h = harness(true, maximum, [...issues]);
    try {
      const rec = h.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title: "Pending repair", originWorkItemIds: [h.item.id] });
      assert.ok(rec.ok, rec.error ?? "recommendation");
      assert.ok(h.svc.adjudicateCampaignRecommendation("root", { recommendationId: rec.data!.id, disposition: "accepted", reason: "Observed related work", publicationRequired: true }).ok);
      const publication = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "pending-publication", resourceKey: "publication",
        resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Pending repair", sanitizedBody: body, labels: [], recommendationId: rec.data!.id } });
      assert.ok(publication.ok, publication.error ?? "publication");
      assert.equal(publication.data!.status, "pending"); assert.ok((publication.data!.resourceSnapshot as { issueAdmission?: unknown }).issueAdmission);
      const addition = 500;
      const proposed = await proposeWithoutLineage(h, `final-${maximum}`, [addition]);
      assert.ok(proposed.ok, proposed.error ?? "refused");
      assert.equal(proposed.data!.authority, "human");
      assert.deepEqual((proposed.data!.resourceSnapshot as ScopeSnapshot).ownerReview, { cause: "lineage_missing" });
      assert.ok(h.approve(proposed.data!).ok);
      assert.ok(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers!.includes(addition));
      assert.equal(boundaryMaxIssues(h), maximum);
      assert.equal(h.db.workflowDecisionByOccurrence(publication.data!.occurrenceId)!.status, "revoked");
    } finally { h.db.close(); }
  }
});

test("#4267 lineage admissions and Custom proposals keep their routes", async () => {
  const full = harness(true, 5);
  try {
    const epic = await full.proposal("epic-member");
    assert.ok(epic.ok, epic.error ?? "refused");
    assert.equal(epic.data!.authority, "orchestrator");
    assert.equal((epic.data!.resourceSnapshot as ScopeSnapshot).ownerReview, undefined);
    // Selection lineage under a grant without a selection is still refused (#4103).
    const selection = await full.svc.proposeCampaignIssueScope("root", { requestId: "selection", expectedRevision: 1,
      additions: [{ repository: "team/repo", number: 102 }], removals: [], explanation: "Chosen", lineage: { kind: "selection" } });
    assert.equal(refusalCode(selection), "selection_not_granted");
  } finally { full.db.close(); }
  const custom = harness(false, 5);
  try {
    const proposed = await proposeWithoutLineage(custom, "custom", [101]);
    assert.ok(proposed.ok, proposed.error ?? "refused");
    assert.equal(proposed.data!.authority, "human");
    assert.equal((proposed.data!.resourceSnapshot as ScopeSnapshot).ownerReview, undefined);
  } finally { custom.db.close(); }
});

test("#2940 the bounded publication path admits unchanged and refuses with the new codes", async () => {
  const h = harness(true, 3);
  try {
    const p = await consumedPublication(h);
    const scope = await followUpScope(h, "bounded", p.decision.occurrenceId);
    assert.ok(scope.ok, scope.error ?? "bounded scope"); assert.equal(scope.data!.authority, "orchestrator");
    assert.equal((scope.data!.resourceSnapshot as ScopeSnapshot).issueAdmission!.evidenceDigest,
      issueEvidenceDigest({ occurrenceId: p.decision.occurrenceId, payloadDigest: p.decision.resourceDigest, issue: 101 }), "a bounded grant's admission evidence is exactly what it was");
    assert.ok(h.approve(scope.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), 101);
    assert.equal(refusalCode(await followUpScope(h, "bounded-again", p.decision.occurrenceId, 102, 2)), "publication_already_admitted");
  } finally { h.db.close(); }
});

test("#2940 Custom campaigns and the owner's Campaign Status route treat a person-approved publication as before", async () => {
  const custom = harness(false, 3);
  try {
    const rec = custom.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Custom repair",originWorkItemIds:[custom.item.id]}); assert.ok(rec.ok);
    const publication = await custom.svc.createWorkflowDecisionWithVideo("child",{requestId:"custom-pub",resourceKey:"custom-pub",resourceSnapshot:{category:"follow_up_issue_publication",
      repository:"team/repo",sanitizedTitle:"Custom repair",sanitizedBody:body,labels:[],recommendationId:rec.data!.id}});
    assert.ok(publication.ok); assert.equal(publication.data!.authority, "human");
    assert.ok(custom.svc.resolveWorkflowDecision("root","child",publication.data!.occurrenceId,{outcome:"approve"},"human",{kind:"human",id:custom.principal.userId},()=>true).ok);
    assert.ok((await custom.svc.consumeWorkflowDecision("child",publication.data!.occurrenceId,{resourceSnapshot:publication.data!.resourceSnapshot})).ok);
    const scope = await followUpScope(custom, "custom-follow-up", publication.data!.occurrenceId);
    assert.ok(scope.ok, scope.error ?? "custom scope"); assert.equal(scope.data!.authority, "human");
    const snapshot = scope.data!.resourceSnapshot as ScopeSnapshot;
    assert.equal(snapshot.issueAdmission, undefined); assert.equal(snapshot.verifiedPublications, undefined);
  } finally { custom.db.close(); }
  const full = harness(true, 3);
  try {
    await humanApprovedPublication(full);
    const direct = await full.svc.proposeCampaignIssueScope("root",{requestId:"owner-direct",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],
      explanation:"Owner adopts the published follow-up"},()=>true,full.principal);
    assert.ok(direct.ok, direct.error ?? "owner proposal"); assert.equal(direct.data!.authority, "human");
    const snapshot = direct.data!.resourceSnapshot as ScopeSnapshot;
    assert.equal(snapshot.issueAdmission, undefined); assert.equal(snapshot.verifiedPublications, undefined, "the owner's route settles only bounded grants, as before");
    assert.ok(full.approve(direct.data!).ok);
    assert.deepEqual(full.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101]);
  } finally { full.db.close(); }
});

// #3918, observed live: a Custom campaign's publication dropped the recommendation it named, so
// consuming with the requested snapshot was refused as stale and revoked the approval, and nothing
// linked the published issue back to the accepted recommendation.
const workSummary = (h: ReturnType<typeof harness>) => h.db.campaignWorkLedger.summary("root",
  { campaignCreatedAt: 1, complete: false, childSessionIds: ["child"], cleanupPending: 0 });
const workItemCount = (h: ReturnType<typeof harness>) => {
  const page = h.db.campaignWorkLedger.page("root", { state: "all", limit: 100 }, Date.now());
  assert.ok(page.ok); return page.data.items.length;
};
const humanApprove = (h: ReturnType<typeof harness>, requester: string, d: WorkflowDecisionView) =>
  h.svc.resolveWorkflowDecision("root", requester, d.occurrenceId, { outcome: "approve" }, "human", { kind: "human", id: h.principal.userId }, () => true);

/** The documented step after publishing (#3918): record the issue on the accepted recommendation. */
function linksPublishedIssue(h: ReturnType<typeof harness>, recommendationId: string, issue: number) {
  const before = h.db.campaignWorkLedger.recommendation("root", recommendationId)!;
  assert.equal(before.publication, "awaiting_publication");
  assert.ok(before.resultingWorkItemId, "acceptance created the follow-up work item");
  const items = workItemCount(h);
  assert.equal(workSummary(h).obligations.publication, 1);
  const linked = h.svc.adjudicateCampaignRecommendation("root", { recommendationId, disposition: "accepted", reason: "Published payload read back",
    resultingIssue: { repository: "team/repo", number: issue } });
  assert.ok(linked.ok, linked.error ?? "link");
  assert.equal(linked.data!.workItem?.id, before.resultingWorkItemId, "the existing work item is linked");
  assert.equal(workItemCount(h), items, "no second work item is created");
  assert.deepEqual(linked.data!.workItem?.issue, { repository: "team/repo", number: issue });
  const after = h.db.campaignWorkLedger.recommendation("root", recommendationId)!;
  assert.equal(after.publication, "published");
  assert.deepEqual(after.resultingIssue, { repository: "team/repo", number: issue });
  assert.equal(workSummary(h).obligations.publication, 0);
}

for (const named of [true, false]) {
  test(`#3918 a Custom child's publication ${named ? "naming" : "without"} its recommendation is consumed as requested and links its existing item`, async () => {
    const h = harness(false);
    try {
      const recommendationId = acceptedRecommendation(h);
      const requested = { category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: "[Feature]: Related repair",
        sanitizedBody: body, labels: ["enhancement"], ...(named ? { recommendationId } : {}) };
      const created = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "custom", resourceKey: "custom", resourceSnapshot: requested });
      assert.ok(created.ok, created.error ?? "request");
      const decision = created.data!;
      assert.equal(decision.authority, "human");
      assert.equal(decision.controllingSessionId, "root");
      assert.deepEqual(decision.resourceSnapshot, requested, "the stored snapshot is exactly the requested one");
      assert.deepEqual(h.svc.workflowDecision("child", decision.occurrenceId).data!.resourceSnapshot, requested);
      if (named) assert.equal(decision.authorityEvaluation?.admissionFailure, "no_issue_boundary", "the person sees why it is theirs");
      assert.equal(h.db.campaignPublicationReservations("root").length, 0, "a named recommendation reserves no bounded slot");
      assert.ok(humanApprove(h, "child", decision).ok);
      const consumed = await h.svc.consumeWorkflowDecision("child", decision.occurrenceId, { resourceSnapshot: requested });
      assert.ok(consumed.ok, consumed.error ?? "consume");
      assert.equal(consumed.data!.status, "consumed");
      linksPublishedIssue(h, recommendationId, 101);
    } finally { h.db.close(); }
  });
}

test("#3918 a person-approved publication's named recommendation never replaces the title match or makes it bounded", async () => {
  const h = harness(true, 3);
  try {
    const alpha = acceptedRecommendation(h, "Alpha repair");
    h.state.publicationOk = true;
    // The name claims Alpha for a Beta payload: the requester is refused and can correct it (#4065).
    const requested = { category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: "[Feature]: Beta repair",
      sanitizedBody: body, labels: [], recommendationId: alpha };
    const refused = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "beta", resourceKey: "beta", resourceSnapshot: requested });
    assert.deepEqual([refused.ok, refused.status, refused.errorDetails?.code], [false, 409, "title_mismatch"]);
    // A person-owned decision recorded before that refusal existed still names Alpha; its name must
    // never bind scope. The generic create stands in for that earlier route.
    const created = h.svc.createWorkflowDecision("child", { requestId: "beta", resourceKey: "beta", resourceSnapshot: requested });
    assert.ok(created.ok, created.error ?? "request");
    assert.equal(created.data!.authority, "human");
    assert.equal(created.data!.authorityEvaluation?.admissionFailure, "authority_unavailable");
    assert.deepEqual(created.data!.resourceSnapshot, requested);
    assert.equal(h.db.campaignPublicationReservations("root").length, 0);
    assert.ok(humanApprove(h, "child", created.data!).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("child", created.data!.occurrenceId, { resourceSnapshot: requested })).ok);
    h.state.publicationTitles[101] = requested.sanitizedTitle;
    assert.ok(h.svc.adjudicateCampaignRecommendation("root", { recommendationId: alpha, disposition: "accepted", reason: "Claimed delivery",
      resultingIssue: { repository: "team/repo", number: 101 } }).ok);
    const scope = await followUpScope(h, "named-other-title", created.data!.occurrenceId);
    assert.equal(refusalCode(scope), "recommendation_not_found");
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
  } finally { h.db.close(); }
});

// #3919, observed live: a Custom root that drafted a follow-up itself was refused with "no
// controlling Orchestrator ancestor" and had to create a child only to publish it.
test("#3919 a Custom root requests its own publication, only the campaign owner decides it, and consume stays exact and one-shot", async () => {
  const h = harness(false);
  try {
    // Even a delegated publication policy never lets the root own its own request.
    assert.ok(h.svc.setParentControlPolicy("root", { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, follow_up_issue_publication: "orchestrator" }).ok);
    const requested = { category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: "[Bug]: Root drafted repair",
      sanitizedBody: body, labels: ["bug"] };
    const created = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "root-draft", resourceKey: "root-draft", resourceSnapshot: requested });
    assert.ok(created.ok, created.error ?? "root request");
    const decision = created.data!;
    assert.equal(decision.status, "pending");
    assert.equal(decision.authority, "human");
    assert.equal(decision.sessionId, "root");
    assert.equal(decision.controllingSessionId, "root");
    assert.deepEqual(decision.resourceSnapshot, requested);
    assert.equal(h.db.getSession("root")!.status, "input_required");
    // The root's agent cannot approve its own occurrence by any route.
    const asOrchestrator = h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve" }, "orchestrator", { kind: "agent", id: "root" }, () => true);
    assert.equal(asOrchestrator.ok, false); assert.equal(asOrchestrator.status, 403);
    const asAgent = h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve" }, "human", { kind: "agent", id: "root" }, () => true);
    assert.equal(asAgent.ok, false); assert.equal(asAgent.status, 403);
    const descendant = h.svc.resolveDescendantRequest("root", "root", decision.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.equal(descendant.ok, false);
    const viaCard = h.svc.approve("root", decision.occurrenceId, "approve", { kind: "agent", id: "root" });
    assert.equal(viaCard.ok, false); assert.equal(viaCard.status, 403);
    // A person who is not the campaign's owner cannot decide it either.
    member(h, "usr_operator", "operator");
    const other = h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve" }, "human", { kind: "human", id: "usr_operator" }, () => true);
    assert.equal(other.ok, false); assert.equal(other.status, 403);
    assert.match(other.error!, /Only the campaign owner/);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "pending");
    // The owner approves it from the root's card.
    const approved = h.svc.approve("root", decision.occurrenceId, "approve", { kind: "human", id: h.principal.userId });
    assert.ok(approved.ok, approved.error ?? "owner approval");
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "approved");
    // A changed snapshot is refused and revokes the approval, which can then never be consumed.
    const changed = await h.svc.consumeWorkflowDecision("root", decision.occurrenceId, { resourceSnapshot: { ...requested, sanitizedTitle: "[Bug]: Another repair" } });
    assert.equal(changed.ok, false); assert.equal(changed.status, 409); assert.match(changed.error!, /stale/);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "revoked");
    const revoked = await h.svc.consumeWorkflowDecision("root", decision.occurrenceId, { resourceSnapshot: requested });
    assert.equal(revoked.ok, false); assert.equal(revoked.status, 409);
    // A fresh request naming an accepted recommendation is consumed once, then linked.
    const recommendationId = acceptedRecommendation(h, "Root drafted repair");
    const again = { ...requested, recommendationId };
    const second = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "root-draft-2", resourceKey: "root-draft", resourceSnapshot: again });
    assert.ok(second.ok, second.error ?? "second request");
    assert.equal(second.data!.authority, "human");
    assert.deepEqual(second.data!.resourceSnapshot, again);
    assert.ok(h.svc.approve("root", second.data!.occurrenceId, "approve", { kind: "human", id: h.principal.userId }).ok);
    const consumed = await h.svc.consumeWorkflowDecision("root", second.data!.occurrenceId, { resourceSnapshot: again });
    assert.ok(consumed.ok, consumed.error ?? "consume"); assert.equal(consumed.data!.status, "consumed");
    const reused = await h.svc.consumeWorkflowDecision("root", second.data!.occurrenceId, { resourceSnapshot: again });
    assert.equal(reused.ok, false); assert.equal(reused.status, 409);
    linksPublishedIssue(h, recommendationId, 101);
  } finally { h.db.close(); }
});

test("#3919 a root's own publication leaves child, nested and non-campaign requesters as before", async () => {
  const h = harness(false);
  try {
    assert.ok(h.svc.setParentControlPolicy("root", { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, follow_up_issue_publication: "orchestrator" }).ok);
    const policy = h.db.getSession("root")!.parentControlPolicy!;
    h.db.createSession({ id: "nested", runnerId: "r", workspaceId: "w", agentId: "codex", title: "nested", useWorktree: false, driver: "codex-app-server", now: 1, config: {},
      role: "orchestrator", parentSessionId: "root", parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
    h.db.createSession({ id: "solo", runnerId: "r", workspaceId: "w", agentId: "codex", title: "solo", useWorktree: false, driver: "codex-app-server", now: 1, config: {} });
    for (const id of ["nested", "solo"]) h.db.updateSessionStatus(id, "running", 2);
    const snapshot = (title: string) => ({ category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: title, sanitizedBody: body, labels: [] });
    // A child's publication still follows the root's saved policy.
    const child = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "child", resourceKey: "child", resourceSnapshot: snapshot("Child repair") });
    assert.ok(child.ok, child.error ?? "child");
    assert.equal(child.data!.controllingSessionId, "root"); assert.equal(child.data!.authority, "orchestrator");
    assert.equal(child.data!.policyRevision, policy.revision);
    // A nested Orchestrator's publication belongs to the root, not to itself.
    const nested = await h.svc.createWorkflowDecisionWithVideo("nested", { requestId: "nested", resourceKey: "nested", resourceSnapshot: snapshot("Nested repair") });
    assert.ok(nested.ok, nested.error ?? "nested");
    assert.equal(nested.data!.controllingSessionId, "root"); assert.equal(nested.data!.authority, "orchestrator");
    // A session outside any campaign still has nobody to control its publication.
    const solo = await h.svc.createWorkflowDecisionWithVideo("solo", { requestId: "solo", resourceKey: "solo", resourceSnapshot: snapshot("Solo repair") });
    assert.equal(solo.ok, false); assert.equal(solo.status, 409);
    assert.match(solo.error!, /no controlling Orchestrator ancestor/);
  } finally { h.db.close(); }
});

/* ---------- #3915: a scope change binds and revokes only what depends on the issues it changes ---------- */

/** Ledger-attributed children for scope-impact tests: each gets an open attempt on a plan item
 * and its launch prompt, so the work ledger can prove what it is unrelated to (#3914). */
function scopeImpactFixture(h: ReturnType<typeof harness>, delegateMerge = true) {
  assert.ok(h.svc.recordCampaignPlan("root", { items: [{ key: "other" }, { key: "issue:101", issue: { repository: "team/repo", number: 101 } }],
    planComplete: true }).ok);
  const page = h.db.campaignWorkLedger.page("root", { state: "all", limit: 100 }, Date.now()); assert.ok(page.ok);
  const itemId = (key: string) => page.data.items.find((item) => item.key === key)!.id;
  const policy = h.db.getSession("root")!.parentControlPolicy!;
  if (delegateMerge) assert.ok(h.svc.setParentControlPolicy("root", { ...policy.decisions, pr_merge: "orchestrator" }, policy.revision).ok);
  const runner = h.hub.requestFromRunner;
  h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => message.type === "github_merge_preflight"
    ? { type: "github_merge_preflight_result", requestId, sessionId: message.sessionId, ok: true, check: { checkedAt: 1, closures: [] } }
    : runner(runnerId, requestId, message, timeout);
  const child = (id: string, key: string, driver: "codex-app-server" | "claude-code" = "codex-app-server") => {
    if (!h.db.getSession(id)) h.db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "codex", title: id, parentSessionId: "root",
      driver, config: {}, useWorktree: false, now: Date.now() });
    h.db.updateSessionStatus(id, "running", Date.now());
    h.db.appendEvent(id, { kind: "user_message", text: `Deliver ${key}` }, Date.now());
    const assigned = h.svc.assignCampaignWorkItem("root", { workItemId: itemId(key), childSessionId: id });
    assert.ok(assigned.ok, assigned.error ?? "refused");
    return id;
  };
  const question = (sessionId: string, requestId: string) => {
    const created = h.svc.createWorkflowDecision(sessionId, { requestId, resourceKey: requestId, resourceSnapshot: { category: "implementation_question",
      question: "Which test?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(created.ok && created.data, created.error ?? "refused");
    return created.data.occurrenceId;
  };
  /** An Orchestrator-approved merge its Claude Code child has armed: the enqueue already ran. */
  const armedMerge = async (sessionId: string, pullRequest: number, arm = true) => {
    const headSha = String(pullRequest).padStart(40, "a");
    const snapshot = { category: "pr_merge" as const, repository: "team/repo", pullRequest, headSha, reviewResult: "merge" as const,
      requiredChecks: { headSha, status: "passed" as const, checkedAt: 10, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" as const }] } };
    const created = h.svc.createWorkflowDecision(sessionId, { requestId: `merge-${pullRequest}`, resourceKey: `team/repo#${pullRequest}`, resourceSnapshot: snapshot });
    assert.ok(created.ok && created.data, created.error ?? "refused");
    assert.equal(created.data.authority, "orchestrator");
    const approved = h.svc.resolveDescendantRequest("root", sessionId, created.data.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.ok(approved.ok, approved.error ?? "refused");
    const command = canonicalPrMergeEnqueueCommand(snapshot);
    if (!arm) return { occurrenceId: created.data.occurrenceId, snapshot, command };
    const armed = await h.svc.consumeWorkflowDecision(sessionId, created.data.occurrenceId, { resourceSnapshot: snapshot, action: { kind: "pr_merge_enqueue", command } });
    assert.ok(armed.ok, armed.error ?? "refused");
    assert.equal(armed.data?.status, "approved");
    return { occurrenceId: created.data.occurrenceId, snapshot, command };
  };
  const closure = async (issue: number) => {
    const requested = await h.svc.requestGithubIssueClosure("root", { requestId: `closure-${issue}`, issue, reason: "completed",
      explanation: "The work merged.", evidence: ["Merged in the campaign."] });
    assert.ok(requested.ok && requested.data?.decision, requested.error ?? "refused");
    return requested.data.decision;
  };
  const status = (occurrenceId: string) => h.db.workflowDecisionByOccurrence(occurrenceId)!.status;
  /** The runner's forge read for a reconciliation: merged at the approved head only when `merged`. */
  const forge = (merge: { occurrenceId: string; command: string; snapshot: { headSha: string } }, sessionId: string, merged: () => boolean) => {
    const runner = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      if (message.type !== "reconcile_workflow_action") return runner(runnerId, requestId, message, timeout);
      return merged() ? { type: "workflow_action_reconciliation_result", requestId, sessionId, occurrenceId: message.occurrenceId, accepted: true,
        commandDigest: createHash("sha256").update(merge.command, "utf8").digest("hex"), forgeHeadSha: merge.snapshot.headSha }
        : { type: "workflow_action_reconciliation_result", requestId, sessionId, occurrenceId: message.occurrenceId, accepted: false,
          error: "forge did not prove the exact approved head was merged" };
    };
  };
  return { itemId, child, question, armedMerge, closure, status, forge };
}

/** A Full Control campaign whose boundary gives the Orchestrator merges and scope, so a person's
 * scope approval re-mints it (#3915). */
function fullControlMergeHarness() {
  const h = harness(false);
  const revision = h.db.getSession("root")!.parentControlPolicy!.revision;
  assert.ok(h.svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100",
    operations: ["campaign_issue_scope", "issue_closure", "pr_merge", "implementation_question"], delegatablePolicyIds: [],
    issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 5, closureReasons: ["completed"] } }, revision, h.principal).ok);
  return h;
}

const humanScopeAddition = (h: ReturnType<typeof harness>, requestId: string, number: number, expectedRevision = 1) =>
  h.svc.proposeCampaignIssueScope("root", { requestId, expectedRevision, additions: [{ repository: "team/repo", number }],
    removals: [], explanation: "Verified intended member" }, () => true, h.principal);

test("#3915 adding an issue leaves unrelated decisions as they were and revokes only work related to it", async () => {
  const h = harness(false);
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const merger = f.child("merger", "issue:100", "claude-code");
    const related = f.child("worker101", "issue:101", "claude-code");
    const unrelatedQuestion = f.question(unrelated, "unrelated-question");
    const relatedQuestion = f.question(related, "related-question");
    const unrelatedMerge = await f.armedMerge(merger, 7);
    const relatedMerge = await f.armedMerge(related, 8);
    const closure = await f.closure(100);
    assert.ok(h.approve(closure).ok, "the person approves the closure of an issue the change keeps");
    const published = await h.svc.createWorkflowDecisionWithVideo(unrelated, { requestId: "unrelated-publication", resourceKey: "publication",
      resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Unrelated Repair", sanitizedBody: body, labels: [] } });
    assert.ok(published.ok && published.data, published.error ?? "refused");
    const publication = published.data.occurrenceId;

    const proposed = await h.proposal("add-101"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    const snapshot = proposed.data!.resourceSnapshot;
    assert.ok(snapshot.category === "campaign_issue_scope");
    assert.deepEqual(snapshot.activeChildren.map((c) => c.sessionId), [related], "only a child related to the added issue binds the request");
    assert.deepEqual(snapshot.affectedDecisions, [relatedQuestion, publication].sort(), "the request lists exactly what it will revoke");
    assert.ok(h.approve(proposed.data!).ok);

    assert.equal(f.status(publication), "revoked", "a publication counts against the issue capacity every scope change moves");
    assert.equal(f.status(unrelatedQuestion), "pending");
    assert.equal(f.status(unrelatedMerge.occurrenceId), "approved");
    assert.equal(h.db.workflowDecisionByOccurrence(unrelatedMerge.occurrenceId)!.actionAdmission?.command, unrelatedMerge.command);
    assert.equal(f.status(relatedMerge.occurrenceId), "approved", "an armed merge survives a change that only adds issues");
    assert.equal(f.status(closure.occurrenceId), "approved", "a closure of an issue the change keeps stays approved");
    assert.equal(f.status(relatedQuestion), "revoked", "a child related to the added issue cannot keep an approval evaluated before it");
    assert.deepEqual(revocationAudit(h, related, relatedQuestion).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });
    assert.deepEqual(revocationAudit(h, related, relatedQuestion).actor, { kind: "system", id: "superseded_by_scope_change" });

    // The kept closure still executes: the only later scope revision left its issue alone.
    assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision, 2);
    assert.equal(h.db.issueScopeUnchangedFor("root", "team/repo", 100, 1, 2), true);
    assert.equal(h.db.issueScopeUnchangedFor("root", "team/repo", 101, 1, 2), false, "the change added 101");
    assert.equal(h.db.issueScopeUnchangedFor("root", "team/repo", 100, 1, 3), false, "no scope decision wrote revision 3");
    assert.equal(h.db.issueScopeUnchangedFor("root", "other/repo", 100, 1, 2), false, "another repository has separate authority");
    // Like the runner, refuse a snapshot at any revision but the one just synchronized.
    let synchronizedRevision = 0;
    let dispatched: import("@wollipog/protocol").GithubIssueClosureSnapshot | undefined;
    const runner = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      if (message.type === "campaign_issue_scope" && message.operation === "synchronize") synchronizedRevision = message.scope.revision;
      if (message.type === "github_issue_closure" && message.operation === "execute") {
        dispatched = message.snapshot;
        if (message.snapshot.scopeRevision !== synchronizedRevision) return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId,
          ok: false, error: "Campaign scope revision is stale; synchronize and request renewed review" };
      }
      return runner(runnerId, requestId, message, timeout);
    };
    const executed = await h.svc.executeGithubIssueClosure("root", closure.occurrenceId, closure.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "refused");
    assert.equal(h.state.executes, 1);
    assert.equal(synchronizedRevision, 2);
    assert.ok(closure.resourceSnapshot.category === "issue_closure");
    // The excluded children are for the approver only (#3237); the runner receives the binding.
    const { excludedChildren, ...binding } = closure.resourceSnapshot;
    assert.ok(excludedChildren?.length, "the closure records the children it excludes");
    assert.deepEqual(dispatched, { ...binding, scopeRevision: 2 },
      "the approved closure is dispatched unchanged except for the revision the runner was synchronized to");
    assert.notEqual(h.db.workflowDecisionByOccurrence(closure.occurrenceId)!.issueClosureResult?.outcome, "refused");
  } finally { h.db.close(); }
});

test("#3915 a scope change during closure synchronization defers the closure without consuming it", async () => {
  const h = harness(false);
  try {
    const f = scopeImpactFixture(h);
    const closure = await f.closure(100);
    assert.ok(h.approve(closure).ok);
    const first = await h.proposal("add-101"); assert.ok(first.ok, first.error ?? "proposal");
    assert.ok(h.approve(first.data!).ok);
    const second = await h.svc.proposeCampaignIssueScope("root", { requestId: "add-102", expectedRevision: 2, additions: [{ repository: "team/repo", number: 102 }],
      removals: [], explanation: "Verified intended member" });
    assert.ok(second.ok, second.error ?? "proposal");

    // The runner acknowledges only what reaches it. During execution's synchronization at revision
    // 2, the unrelated addition of 102 is approved; its own synchronization never reaches the runner.
    let runnerRevision = 0;
    let raced = false;
    let holdLater = true;
    const runner = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      if (message.type === "campaign_issue_scope" && message.operation === "synchronize") {
        if (message.scope.revision === 3 && holdLater) return new Promise(() => {});
        runnerRevision = message.scope.revision;
        if (!raced) { raced = true; assert.ok(h.approve(second.data!).ok); }
      }
      if (message.type === "github_issue_closure" && message.operation === "execute" && message.snapshot.scopeRevision !== runnerRevision) {
        return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId, ok: false, error: "Campaign scope revision is stale" };
      }
      return runner(runnerId, requestId, message, timeout);
    };
    const deferred = await h.svc.executeGithubIssueClosure("root", closure.occurrenceId, closure.resourceDigest);
    assert.equal(deferred.status, 409);
    assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision, 3);
    assert.equal(f.status(closure.occurrenceId), "approved", "nothing was consumed or dispatched");
    assert.equal(h.state.executes, 0);

    holdLater = false;
    const executed = await h.svc.executeGithubIssueClosure("root", closure.occurrenceId, closure.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "refused");
    assert.equal(runnerRevision, 3);
    assert.equal(h.state.executes, 1, "once synchronized, the closure runs at the revision the runner holds");
  } finally { h.db.close(); }
});

test("#3915 a pending scope request stays approvable through unrelated child activity and goes stale on related activity", async () => {
  const h = harness(false);
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const related = f.child("worker101", "issue:101");
    const quiet = await h.proposal("add-101"); assert.ok(quiet.ok, quiet.error ?? "proposal");
    // Routine progress by a child unrelated to 101: a new prompt and a new request.
    h.db.stageSessionPromptCommand({ commandId: "prompt-unrelated", sessionId: unrelated, runnerId: "r",
      payloadJson: JSON.stringify({ text: "Continue." }), payloadSha256: "c".repeat(64), expiresAt: Date.now() + 60_000, now: Date.now() });
    const kept = f.question(unrelated, "unrelated-question");
    assert.ok(h.approve(quiet.data!).ok, "unrelated progress does not make the request stale");
    assert.equal(f.status(kept), "pending");

    const busy = await h.svc.proposeCampaignIssueScope("root", { requestId: "add-102", expectedRevision: 2, additions: [{ repository: "team/repo", number: 102 }],
      removals: [{ repository: "team/repo", number: 101 }], explanation: "Swap the member" });
    assert.ok(busy.ok, busy.error ?? "refused");
    h.db.stageSessionPromptCommand({ commandId: "prompt-related", sessionId: related, runnerId: "r",
      payloadJson: JSON.stringify({ text: "Continue." }), payloadSha256: "d".repeat(64), expiresAt: Date.now() + 60_000, now: Date.now() });
    const refused = h.approve(busy.data!);
    assert.equal(refused.status, 409, "a child assigned to the removed issue changed");
    assert.equal(f.status(busy.data!.occurrenceId), "revoked");
    assert.deepEqual(revocationAudit(h, "root", busy.data!.occurrenceId).actor, { kind: "system", id: "approval_refused_stale" });
    assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision, 2);
  } finally { h.db.close(); }
});

test("#3915 removing an issue revokes its closure and related work, and its armed merge is recorded from forge proof only", async () => {
  const h = harness(false);
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const merger = f.child("merger", "issue:100", "claude-code");
    const unrelatedQuestion = f.question(unrelated, "unrelated-question");
    const relatedQuestion = f.question(merger, "related-question");
    const merge = await f.armedMerge(merger, 9);
    const closure = await f.closure(100);

    const removal = await h.svc.proposeCampaignIssueScope("root", { requestId: "remove-100", expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }],
      removals: [{ repository: "team/repo", number: 100 }], explanation: "Replace the member" });
    assert.ok(removal.ok, removal.error ?? "refused");
    assert.ok(removal.data!.resourceSnapshot.category === "campaign_issue_scope");
    assert.deepEqual(removal.data!.resourceSnapshot.activeChildren.map((c) => c.sessionId), [merger]);
    assert.ok(h.approve(removal.data!).ok);
    for (const occurrenceId of [relatedQuestion, merge.occurrenceId, closure.occurrenceId]) {
      assert.equal(f.status(occurrenceId), "revoked", occurrenceId);
    }
    assert.equal(f.status(unrelatedQuestion), "pending");
    assert.deepEqual(revocationAudit(h, "root", closure.occurrenceId).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });

    // Reconciliation only records what the forge proves: first an unmerged head, then the merge.
    let merged = false;
    const runner = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      if (message.type !== "reconcile_workflow_action") return runner(runnerId, requestId, message, timeout);
      assert.equal(message.command, merge.command);
      return merged ? { type: "workflow_action_reconciliation_result", requestId, sessionId: merger, occurrenceId: merge.occurrenceId, accepted: true,
        commandDigest: createHash("sha256").update(merge.command, "utf8").digest("hex"), forgeHeadSha: merge.snapshot.headSha }
        : { type: "workflow_action_reconciliation_result", requestId, sessionId: merger, occurrenceId: merge.occurrenceId, accepted: false,
          error: "forge did not prove the exact approved head was merged" };
    };
    const early = await h.svc.reconcileWorkflowDecision(merger, merge.occurrenceId, { resourceSnapshot: merge.snapshot });
    assert.equal(early.status, 409);
    assert.equal(f.status(merge.occurrenceId), "revoked", "nothing is recorded before the forge proves the merge");
    merged = true;
    const recorded = await h.svc.reconcileWorkflowDecision(merger, merge.occurrenceId, { resourceSnapshot: merge.snapshot });
    assert.ok(recorded.ok, recorded.error ?? "refused");
    assert.equal(recorded.data?.status, "consumed");
    assert.equal((await h.svc.reconcileWorkflowDecision(merger, merge.occurrenceId, { resourceSnapshot: merge.snapshot })).status, 409,
      "the merge is recorded once");

    // The removed issue's closure stays revoked and is never executed.
    const executed = await h.svc.executeGithubIssueClosure("root", closure.occurrenceId, closure.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(h.state.executes, 0);
  } finally { h.db.close(); }
});

test("#3915 a person's scope approval under Full Control re-authorizes the boundary and still revokes every outstanding decision", async () => {
  const h = harness();
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const question = f.question(unrelated, "unrelated-question");
    const proposed = await h.svc.proposeCampaignIssueScope("root", { requestId: "human-add", expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }],
      removals: [], explanation: "Verified intended member" }, () => true, h.principal);
    assert.ok(proposed.ok, proposed.error ?? "refused");
    assert.equal(proposed.data!.authority, "human");
    assert.ok(proposed.data!.resourceSnapshot.category === "campaign_issue_scope");
    assert.deepEqual(proposed.data!.resourceSnapshot.affectedDecisions, [question],
      "the person sees every decision their approval revokes, although the child is unrelated");
    assert.ok(h.approve(proposed.data!).ok);
    assert.equal(f.status(question), "revoked");
    assert.deepEqual(revocationAudit(h, unrelated, question).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });
  } finally { h.db.close(); }
});

test("#3915 an armed merge a person's Full Control scope approval revoked is recorded once from forge proof; an unarmed one stays terminal", async () => {
  const h = fullControlMergeHarness();
  try {
    const f = scopeImpactFixture(h, false);
    const merger = f.child("merger", "other", "claude-code");
    const armed = await f.armedMerge(merger, 21);
    const unarmed = await f.armedMerge(merger, 22, false);
    assert.equal(f.status(unarmed.occurrenceId), "approved");
    const before = h.db.getSession("root")!.parentControlPolicy!.revision;
    const proposed = await humanScopeAddition(h, "human-add", 101); assert.ok(proposed.ok, proposed.error ?? "proposal");
    assert.equal(proposed.data!.authority, "human");
    assert.ok(h.approve(proposed.data!).ok);
    assert.equal(h.db.getSession("root")!.parentControlPolicy!.revision, before + 1, "the approval re-minted the boundary");
    assert.equal(f.status(armed.occurrenceId), "revoked");
    assert.equal(f.status(unarmed.occurrenceId), "revoked");
    assert.equal(h.db.scopeApprovalRevoking(h.db.workflowDecisionByOccurrence(armed.occurrenceId)!)?.occurrenceId, proposed.data!.occurrenceId);

    let merged = false;
    f.forge(armed, merger, () => merged);
    const early = await h.svc.reconcileWorkflowDecision(merger, armed.occurrenceId, { resourceSnapshot: armed.snapshot });
    assert.equal(early.status, 409);
    assert.equal(f.status(armed.occurrenceId), "revoked", "nothing is recorded before the forge proves the merge");
    merged = true;
    const recorded = await h.svc.reconcileWorkflowDecision(merger, armed.occurrenceId, { resourceSnapshot: armed.snapshot });
    assert.ok(recorded.ok, recorded.error ?? "refused");
    assert.equal(recorded.data?.status, "consumed");
    assert.equal(recorded.data?.actionAdmission?.command, armed.command, "the armed command is recorded, not a new one");
    assert.equal((await h.svc.reconcileWorkflowDecision(merger, armed.occurrenceId, { resourceSnapshot: armed.snapshot })).status, 409,
      "the merge is recorded once");

    const stillTerminal = await h.svc.reconcileWorkflowDecision(merger, unarmed.occurrenceId, { resourceSnapshot: unarmed.snapshot });
    assert.equal(stillTerminal.status, 409, "an approval that was never armed cannot be recorded");
    assert.equal(f.status(unarmed.occurrenceId), "revoked");
  } finally { h.db.close(); }
});

test("#3915 a merge revoked by a policy change outside a scope approval, or one followed by another policy change, stays unreconcilable", async () => {
  const h = fullControlMergeHarness();
  try {
    const f = scopeImpactFixture(h, false);
    const merger = f.child("merger", "other", "claude-code");
    const control = (revision: number) => h.svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100",
      operations: ["campaign_issue_scope", "issue_closure", "pr_merge", "implementation_question"], delegatablePolicyIds: [],
      issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 5, closureReasons: ["completed"] } }, revision, h.principal);
    f.forge({ command: "", occurrenceId: "", snapshot: { headSha: "" } }, merger, () => true);

    // A re-authorization of Full Control is a policy change, not a scope approval.
    const reauthorized = await f.armedMerge(merger, 31);
    assert.ok(control(h.db.getSession("root")!.parentControlPolicy!.revision).ok);
    assert.equal(f.status(reauthorized.occurrenceId), "revoked");
    f.forge(reauthorized, merger, () => true);
    assert.equal((await h.svc.reconcileWorkflowDecision(merger, reauthorized.occurrenceId, { resourceSnapshot: reauthorized.snapshot })).status, 409);
    assert.equal(f.status(reauthorized.occurrenceId), "revoked");

    // A scope approval's revocation does not survive a later policy change.
    const scoped = await f.armedMerge(merger, 32);
    const proposed = await humanScopeAddition(h, "human-add", 101); assert.ok(proposed.ok, proposed.error ?? "proposal");
    assert.ok(h.approve(proposed.data!).ok);
    assert.equal(f.status(scoped.occurrenceId), "revoked");
    assert.ok(control(h.db.getSession("root")!.parentControlPolicy!.revision).ok);
    f.forge(scoped, merger, () => true);
    assert.equal((await h.svc.reconcileWorkflowDecision(merger, scoped.occurrenceId, { resourceSnapshot: scoped.snapshot })).status, 409,
      "only the exact revision bump of the revoking scope approval is accepted");
    assert.equal(f.status(scoped.occurrenceId), "revoked");
  } finally { h.db.close(); }
});

/** A closure decision's resource snapshot, narrowed to an issue closure. */
function closureSnapshot(decision: WorkflowDecisionView) {
  const snapshot = decision.resourceSnapshot;
  assert.equal(snapshot.category, "issue_closure");
  if (snapshot.category !== "issue_closure") throw new Error("not an issue closure");
  return snapshot;
}

test("#4058 a closure awaiting the child's verification names the item and the verify step; verifying then supersedes it", async () => {
  const { h, observe, close } = delivery({ stage: [{ number: 10 }], verify: false });
  try {
    observe(10, "merged");
    h.svc.onSessionStatus("child", "idle");
    const report = h.db.appendEvent("child", { kind: "agent_message", text: "Delivered.", final: true }, Date.now()).seq;
    const first = await close("before-verification");
    assert.ok(first.ok, first.error ?? "closure");
    const pending = first.data!.decision!;
    assert.equal(pending.authority, "human", "the person-owned fallback stays");
    assert.deepEqual([pending.authorityEvaluation?.basis, pending.authorityEvaluation?.reason], ["human_required", "closure_proof_incomplete"]);
    const snapshot = closureSnapshot(pending);
    assert.deepEqual(gapNames(snapshot.deliveryGaps), [{ code: "attempt_awaiting_verification", workItemId: h.item.id }]);
    assert.equal(snapshot.deliveryFailure, `attempt_awaiting_verification:${h.item.id}`);
    const notice = first.data!.proofGaps!;
    assert.equal(notice.reason, "closure_proof_incomplete");
    assert.equal(notice.gaps[0]!.action, "verify_child");
    assert.match(notice.gaps[0]!.summary, new RegExp(`Work item ${h.item.id} has a completed report awaiting verification\\. Verify .*verify_campaign_child`, "u"));
    assert.match(notice.summary, /a person decides this request.*supersedes this one/u);
    assert.ok(h.svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: h.item.id, outcome: "delivered" } }).ok);
    const again = await close("after-verification");
    assert.ok(again.ok, again.error ?? "closure");
    assert.equal(again.data!.decision!.authority, "orchestrator", JSON.stringify(again.data!.decision!.authorityEvaluation));
    assert.equal(again.data!.proofGaps, undefined);
    assert.equal(closureSnapshot(again.data!.decision!).deliveryGaps, undefined);
    assert.equal(h.db.workflowDecisionByOccurrence(pending.occurrenceId)!.status, "superseded");
  } finally { h.db.close(); }
});

test("#4058 a delivered item that lists no merged delivery pull request names that gap; recording it then supersedes the person's request", async () => {
  const { h, observe, close } = delivery();
  try {
    observe(10, "merged");
    const first = await close("unlisted-pr");
    assert.ok(first.ok, first.error ?? "closure");
    const pending = first.data!.decision!;
    assert.equal(pending.authority, "human");
    assert.equal(pending.authorityEvaluation?.reason, "closure_proof_incomplete");
    assert.deepEqual(gapNames(closureSnapshot(pending).deliveryGaps), [{ code: "no_merged_delivery_pull_request", workItemId: h.item.id }]);
    assert.equal(first.data!.proofGaps!.gaps[0]!.action, "record_delivery_pull_requests");
    assert.match(first.data!.proofGaps!.gaps[0]!.summary, /update_campaign_work_item \(stage\.pullRequests\)/u);
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item.id,
      stage: { stage: "merged", pullRequests: [{ repository: "team/repo", number: 10 }] } }).ok);
    const again = await close("listed-pr");
    assert.ok(again.ok, again.error ?? "closure");
    assert.equal(again.data!.decision!.authority, "orchestrator", JSON.stringify(again.data!.decision!.authorityEvaluation));
    assert.equal(h.db.workflowDecisionByOccurrence(pending.occurrenceId)!.status, "superseded");
  } finally { h.db.close(); }
});

test("#4058 an open related pull request names its number and blocks until it merges or closes, even with only a timeline reference", async () => {
  const { h, observe, close } = delivery({ stage: [{ number: 10 }] });
  try {
    observe(10, "merged");
    // A sibling campaign PR mentioned the issue. The runner relates an open PR by closing reference,
    // title, body or GitHub's timeline cross-reference; with the mention edited out, the timeline
    // event remains, so the runner still reports it, and it keeps blocking delegated closure.
    h.state.openPR = 11;
    for (const requestId of ["sibling-mentions", "sibling-edited"]) {
      const blocked = await close(requestId);
      assert.ok(blocked.ok, blocked.error ?? "closure");
      const decision = blocked.data!.decision!;
      assert.equal(decision.authority, "human");
      assert.equal(decision.authorityEvaluation?.reason, "closure_proof_incomplete");
      const snapshot = closureSnapshot(decision);
      assert.deepEqual(snapshot.deliveryGaps?.map(({ code, pullRequests }) => ({ code, pullRequests })),
        [{ code: "open_related_pull_requests", pullRequests: [11] }], "only the open PR is named: the runner was not asked to confirm the merge");
      assert.equal(snapshot.deliveryFailure, "open_related_pull_requests:#11");
      const gap = blocked.data!.proofGaps!.gaps[0]!;
      assert.equal(gap.action, "wait_for_pull_requests");
      assert.match(gap.summary, /Related pull requests are open: #11\. .*timeline cross-references it\. It blocks delegated closure until each named pull request merges or closes/u);
    }
    h.state.openPR = false;
    const again = await close("sibling-merged");
    assert.ok(again.ok, again.error ?? "closure");
    assert.equal(again.data!.decision!.authority, "orchestrator", JSON.stringify(again.data!.decision!.authorityEvaluation));
  } finally { h.db.close(); }
});

test("#4058 an unsafe closing comment on a proven closure is its only gap", async () => {
  const { h, observe } = delivery({ stage: [{ number: 10 }] });
  try {
    observe(10, "merged");
    const result = await h.svc.requestGithubIssueClosure("root", { requestId: "unsafe-comment", issue: 100, reason: "completed",
      explanation: "Delivered by the merged pull request", evidence: ["Verified report"], comment: "Contact support@example.invalid" });
    assert.ok(result.ok, result.error ?? "closure");
    assert.equal(result.data!.decision!.authority, "human");
    assert.equal(result.data!.decision!.authorityEvaluation?.reason, "closure_proof_incomplete");
    assert.deepEqual(gapNames(closureSnapshot(result.data!.decision!).deliveryGaps), [{ code: "comment_unsafe", workItemId: undefined }]);
    assert.equal(result.data!.proofGaps!.gaps[0]!.action, "revise_comment");
  } finally { h.db.close(); }
});

test("#4058 a closure the boundary does not delegate stays outside_boundary, with no gaps", async () => {
  const h = harness();
  try {
    assert.ok(h.svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100", operations: ["campaign_issue_scope", "issue_closure"],
      delegatablePolicyIds: [], issueAuthority: { epics: [100], relatedFollowUps: false, maxIssues: 5, closureReasons: ["not_planned"] } }, 2, h.principal).ok);
    const result = await h.svc.requestGithubIssueClosure("root", { requestId: "undelegated-reason", issue: 100, reason: "completed",
      explanation: "Delivered", evidence: ["Verified report"] });
    assert.ok(result.ok, result.error ?? "closure");
    const decision = result.data!.decision!;
    assert.equal(decision.authority, "human");
    assert.equal(decision.authorityEvaluation?.reason, "outside_boundary");
    assert.equal(closureSnapshot(decision).deliveryGaps, undefined);
    assert.equal(closureSnapshot(decision).deliveryFailure, "outside_boundary");
    assert.equal(result.data!.proofGaps, undefined);
  } finally { h.db.close(); }
});

test("#4058 only a current boundary's in-scope, unadmitted closure with gaps is closure_proof_incomplete", async () => {
  const { h, close } = delivery();
  try {
    const pending = (await close("evaluated")).data!.decision!;
    assert.equal(pending.authorityEvaluation?.reason, "closure_proof_incomplete");
    const root = h.db.getSession("root")!;
    const policy = root.parentControlPolicy!;
    const protocol = PROTOCOL_VERSION;
    const snapshot = closureSnapshot(pending);
    const reason = (controller: typeof root, resource: typeof snapshot, decisions = policy) =>
      evaluateCampaignAuthority(controller, root, protocol, resource, decisions, protocol).reason;
    assert.equal(reason(root, snapshot), "closure_proof_incomplete", "positive control");
    assert.equal(reason(root, snapshot, { ...policy, revision: policy.revision + 1 }), "outside_boundary", "a stale boundary");
    const unscoped = structuredClone(root);
    unscoped.orchestratorPolicy!.issueNumbers = [];
    assert.equal(reason(unscoped, snapshot), "outside_boundary", "an issue outside the scope");
    const { deliveryGaps: _gaps, ...withoutGaps } = snapshot;
    assert.equal(reason(root, withoutGaps), "outside_boundary", "no server-named gap");
    assert.equal(reason(root, { ...snapshot, issueAdmission: { boundaryRevision: 999, evidenceDigest: "e".repeat(64) } }), "outside_boundary",
      "an admission bound to another boundary revision");
    assert.equal(reason(root, { ...snapshot, repository: "team/other" }), "outside_boundary", "another repository");
  } finally { h.db.close(); }
});

test("#4058 gaps are canonical: action and summary derive from the code, and the compact line stays bounded", () => {
  const gap = issueClosureDeliveryGap("unmerged_pull_request", { workItemId: "item-1", pullRequests: [12, 3, 12] });
  assert.deepEqual([gap.pullRequests, gap.action], [[3, 12], "wait_for_pull_requests"]);
  assert.deepEqual(normalizeIssueClosureDeliveryGaps([{ ...gap, action: "person_decides", summary: "forged" }]), [gap]);
  assert.equal(normalizeIssueClosureDeliveryGaps([{ code: "from_a_newer_peer" }])![0]!.code, "delivery_unverified");
  assert.equal(normalizeIssueClosureDeliveryGaps([]), null);
  assert.equal(normalizeIssueClosureDeliveryGaps([{ code: "no_work_item", workItemId: "" }]), null);
  const many = Array.from({ length: 32 }, (_, index) => issueClosureDeliveryGap("unmerged_pull_request",
    { workItemId: `item-${"x".repeat(200)}-${index}`, pullRequests: Array.from({ length: 30 }, (_, n) => n + 1) }));
  const line = issueClosureDeliveryFailure(many);
  assert.ok(line.length <= ISSUE_CLOSURE_DELIVERY_FAILURE_MAX, `${line.length}`);
  assert.match(line, /^unmerged_pull_request:item-x+-0:#1,#2,#3,#4,#5,#6,#7,#8,#9,#10,\+20; \+31 more$/u, "a gap that would pass the bound is counted, never cut");
  const short = issueClosureDeliveryFailure([issueClosureDeliveryGap("attempt_open", { workItemId: "a" }), issueClosureDeliveryGap("stale_pull_request", { workItemId: "b", pullRequests: [4] })]);
  assert.equal(short, "attempt_open:a; stale_pull_request:b:#4");
  assert.equal(issueClosureDeliveryFailure([issueClosureDeliveryGap("no_work_item")]), "no_work_item");
});

test("#4060 epic member gaps name their members, and stored member reads normalize canonically", () => {
  const open = issueClosureDeliveryGap("epic_member_open", { members: [7, 3, 7] });
  assert.deepEqual([open.members, open.action], [[3, 7], "close_members"]);
  assert.match(open.summary, /^Members of this epic are open: #3, #7\. Close each named member as completed through its own closure request/u);
  assert.equal(issueClosureDeliveryGap("epic_member_outside_scope", { members: [9] }).action, "person_decides");
  assert.equal(issueClosureDeliveryGap("epic_member_not_completed", { members: [9] }).action, "person_decides");
  assert.equal(issueClosureDeliveryGap("epic_members_unreadable").action, "request_again");
  assert.deepEqual(normalizeIssueClosureDeliveryGaps([{ ...open, summary: "forged" }]), [open]);
  assert.equal(normalizeIssueClosureDeliveryGaps([{ code: "epic_member_open", members: "3" }]), null);
  assert.equal(issueClosureDeliveryFailure([open, issueClosureDeliveryGap("epic_members_unreadable")]), "epic_member_open:#3,#7; epic_members_unreadable");
  const read = { readable: true, members: [{ number: 3, state: "completed" }, { number: 7, state: "open" }] };
  assert.deepEqual(normalizeIssueClosureEpicMembers(read), read);
  for (const invalid of [null, [], { readable: true }, { readable: false, members: [{ number: 3, state: "open" }] },
    { readable: true, members: [{ number: 7, state: "open" }, { number: 3, state: "open" }] },
    { readable: true, members: [{ number: 3, state: "open" }, { number: 3, state: "open" }] },
    { readable: true, members: [{ number: 3, state: "merged" }] }, { readable: true, members: [{ number: 0, state: "open" }] },
    { readable: true, members: Array.from({ length: 101 }, (_, n) => ({ number: n + 1, state: "open" })) }]) {
    assert.equal(normalizeIssueClosureEpicMembers(invalid), null, JSON.stringify(invalid).slice(0, 80));
  }
});

test("#4058 every named gap appears with and without a fixed-by plan, and naming it never admits the proof", () => {
  for (const fixedBy of [false, true]) {
    const h = harness();
    try {
      const merge = { number: 10, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) };
      const base = { category: "issue_closure" as const, repository: "team/repo", issue: 100, title: "Issue", url: "https://github.com/team/repo/issues/100",
        forgeDigest: "a".repeat(64), reason: "completed" as const, explanation: "Delivered", evidence: ["Verified report"], openPullRequests: [],
        activeChildren: [], delivery: [merge] };
      const delivered = () => ({ id: h.item.id, issue: { repository: "team/repo", number: 100 }, primaryState: "delivered", stateCauses: [], currentAttempt: null,
        verifications: [{ outcome: "delivered", report: { digest: "d".repeat(64) } }],
        observed: { pullRequests: [{ ref: { repository: "team/repo", number: 10 }, fact: { availability: "fresh", value: { state: "merged", ...merge } } }] },
      }) as unknown as CampaignWorkItemDetail;
      let detail = delivered();
      h.db.campaignWorkLedger.detail = () => detail;
      if (fixedBy) h.db.campaignWorkLedger.fixedBy = () => [h.item.id];
      const root = () => h.db.getSession("root")!;
      assert.ok(closureEvidence(h.db, root(), base), "positive control");
      const fact = (value: object) => ({ ...detail.observed.pullRequests![0]!, fact: { availability: "fresh", value: { state: "merged", ...merge, ...value } } }) as never;
      const cases: Array<[string, () => void, typeof base | (Omit<typeof base, "openPullRequests" | "delivery"> & Record<string, unknown>), object]> = [
        ["awaiting verification", () => { detail.currentAttempt = { id: "a", sessionId: "child", sessionTitle: null }; detail.stateCauses = ["attempt_awaiting_verification"]; detail.primaryState = "waiting"; },
          base, { code: "attempt_awaiting_verification", workItemId: h.item.id }],
        ["attempt open", () => { detail.currentAttempt = { id: "a", sessionId: "child", sessionTitle: null }; detail.primaryState = "running"; },
          base, { code: "attempt_open", workItemId: h.item.id }],
        ["no verification", () => { detail.verifications = []; }, base, { code: "no_delivered_verification", workItemId: h.item.id }],
        ["no pull request", () => { detail.observed.pullRequests = []; }, base, { code: "no_merged_delivery_pull_request", workItemId: h.item.id }],
        ["unmerged", () => { detail.observed.pullRequests = [fact({ state: "open", mergeCommitSha: null })]; }, base,
          { code: "unmerged_pull_request", workItemId: h.item.id, pullRequests: [10] }],
        ["stale", () => { detail.observed.pullRequests![0]!.fact.availability = "stale" as "fresh"; }, base,
          { code: "stale_pull_request", workItemId: h.item.id, pullRequests: [10] }],
        ["open related", () => {}, { ...base, openPullRequests: [openPullRequest(11)], delivery: undefined } as never,
          { code: "open_related_pull_requests", pullRequests: [11] }],
        ["merge unconfirmed", () => {}, { ...base, delivery: undefined } as never, { code: "delivery_merge_unconfirmed", workItemId: h.item.id, pullRequests: [10] }],
      ];
      for (const [name, change, snapshot, expected] of cases) {
        detail = delivered();
        change();
        const label = `${name}${fixedBy ? " (fixed-by)" : ""}`;
        assert.equal(closureEvidence(h.db, root(), snapshot as typeof base), null, label);
        const gaps = closureDeliveryGaps(h.db, root(), snapshot as typeof base, { proven: false, commentSafe: true })!;
        assert.deepEqual(gaps.map(({ code, workItemId, pullRequests }) => ({ code, ...(workItemId ? { workItemId } : {}), ...(pullRequests ? { pullRequests } : {}) })),
          [expected], label);
      }
    } finally { h.db.close(); }
  }
});

/* ---------- #4062: the issue scope bounds dispatch and merges, not only typed closures ---------- */

/** A Full Control campaign that delegates merges, whose runner reports what each pull request
 * would close from `closes` (GitHub's read, #3713). */
function scopeGuardHarness(maxIssues = 5, issues = [100]) {
  const h = harness(false, maxIssues, issues);
  const revision = h.db.getSession("root")!.parentControlPolicy!.revision;
  assert.ok(h.svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100",
    operations: ["campaign_issue_scope", "issue_closure", "pr_merge", "implementation_question"], delegatablePolicyIds: [],
    issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues, closureReasons: ["completed"] } }, revision, h.principal).ok);
  const sql = (h.db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const closes = new Map<number, string[]>();
  /** Runs once inside the next GitHub read, as a concurrent change would. */
  const during = { preflight: null as (() => void) | null };
  const runner = h.hub.requestFromRunner;
  h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
    if (message.type !== "github_merge_preflight") return runner(runnerId, requestId, message, timeout);
    const change = during.preflight; during.preflight = null; change?.();
    return { type: "github_merge_preflight_result", requestId, sessionId: message.sessionId, ok: true, check: { checkedAt: 1,
      closures: (closes.get(message.pullRequest) ?? []).map((issue) => ({ issue, sources: ["description" as const], excerpt: `Closes #${issue.split("#")[1]}` })) } };
  };
  /** The campaign's scope as the server would store it, naming only `numbers`. */
  const narrowScope = (numbers: number[]) => {
    const policy = structuredClone(h.db.getSession("root")!.orchestratorPolicy!);
    policy.issueNumbers = numbers; policy.issueScope = { ...policy.issueScope!, issueNumbers: numbers };
    sql.prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
  };
  const itemFor = (key: string, number: number) => {
    const page = h.db.campaignWorkLedger.page("root", { state: "all", limit: 100 }, Date.now()); assert.ok(page.ok);
    const existing = page.data.items.find((item) => item.key === key);
    if (existing) return existing.id;
    const plan = h.svc.recordCampaignPlan("root", { items: [...page.data.items.map((item) => ({ key: item.key, ...(item.issue ? { issue: item.issue } : {}) })),
      { key, issue: { repository: "team/repo", number } }], planComplete: true });
    assert.ok(plan.ok, plan.error ?? "a work item for an unscoped issue may still be recorded");
    return plan.data!.items.find((item) => item.key === key)!.workItemId;
  };
  const launch = (campaignWorkItemId: string) => {
    const request = { runnerId: "r", workspaceId: "w", agentId: "codex", prompt: "Deliver the item", campaignWorkItemId };
    const context = { parentSessionId: "root" };
    let result = h.svc.createSession(request, undefined, undefined, false, false, false, context);
    if (result.status === 428) {
      assert.ok(h.svc.approve("root", h.db.getSession("root")!.pendingApproval!.requestId, "allow").ok);
      result = h.svc.createSession(request, undefined, undefined, false, false, false, context);
    }
    return result;
  };
  const merge = (sessionId: string, pullRequest: number, closing: string[]) => {
    closes.set(pullRequest, closing);
    const headSha = String(pullRequest).padStart(40, "a");
    const snapshot = { category: "pr_merge" as const, repository: "team/repo", pullRequest, headSha, reviewResult: "merge" as const,
      requiredChecks: { headSha, status: "passed" as const, checkedAt: 10, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" as const }] },
      ...(closing.length ? { intendedClosures: closing } : {}) };
    return { snapshot, request: () => h.svc.createWorkflowDecisionWithVideo(sessionId, { requestId: `merge-${pullRequest}`,
      resourceKey: `team/repo#${pullRequest}`, resourceSnapshot: snapshot }) };
  };
  const children = () => (sql.prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id='root'").get() as { n: number }).n;
  const decisions = (sessionId: string) => h.svc.workflowDecisions(sessionId, undefined, 50).data!.decisions;
  return { ...h, closes, during, narrowScope, itemFor, launch, merge, children, decisions };
}

const SCOPE_ROUTE = /outside this Full Control campaign's issue scope.*request_campaign_issue_scope_change/;

test("#4062 a refused epic-member addition cannot be delivered through a dispatch and a merge that closes it", async () => {
  const h = scopeGuardHarness(1);
  try {
    // The root's request to add the epic's member is refused: the scope is at its limit.
    const refused = await h.proposal("add-101", 101);
    assert.equal(refusalCode(refused), "capacity_exhausted");
    // Recording the work stays allowed; the ledger is not authority.
    const member = h.itemFor("issue:101", 101);
    const children = h.children();
    const launched = h.launch(member);
    assert.equal(launched.ok, false); assert.equal(launched.status, 409);
    assert.match(launched.error!, /team\/repo#101/); assert.match(launched.error!, SCOPE_ROUTE);
    assert.equal(h.children(), children, "no child was created for the unscoped issue");
    const assigned = h.svc.assignCampaignWorkItem("root", { workItemId: member, childSessionId: "child" });
    assert.equal(assigned.ok, false); assert.equal(assigned.status, 409); assert.match(assigned.error!, SCOPE_ROUTE);
    assert.equal(h.db.campaignWorkLedger.currentAssignment("child"), null);

    // A merge that would close it is refused with the issue named, and nobody gets a decision.
    const closing = await h.merge("child", 11, ["team/repo#101"]).request();
    assert.equal(closing.ok, false); assert.equal(closing.status, 409);
    assert.match(closing.error!, /outside this Full Control campaign's issue scope: team\/repo#101\./);
    assert.match(closing.error!, /Refs #N.*request_campaign_issue_scope_change/);
    assert.deepEqual(h.decisions("child"), []);

    // Work on the scoped epic is dispatched and merged as before.
    const scoped = h.launch(h.item.id);
    assert.ok(scoped.ok, scoped.error ?? "refused");
    // Retargeting that dispatched item at the unscoped issue is a dispatch for it, refused the same way.
    const retarget = h.svc.recordCampaignPlan("root", { items: [{ key: "issue:100", issue: { repository: "team/repo", number: 101 } },
      { key: "issue:101", issue: { repository: "team/repo", number: 101 } }], planComplete: true });
    assert.equal(retarget.ok, false); assert.equal(retarget.status, 409);
    assert.match(retarget.error!, /issue:100 has an open attempt, so it cannot be retargeted/); assert.match(retarget.error!, SCOPE_ROUTE);
    const launchedChild = scoped.data!.id;
    const updated = h.svc.updateCampaignWorkItem("root", { workItemId: h.item.id, issue: { repository: "team/repo", number: 101 } });
    assert.equal(updated.ok, false); assert.equal(updated.status, 409);
    assert.match(updated.error!, /issue:100 has an open attempt, so it cannot be retargeted/); assert.match(updated.error!, SCOPE_ROUTE);
    assert.deepEqual(h.db.campaignWorkLedger.detail("root", h.item.id, Date.now())!.issue, { repository: "team/repo", number: 100 });
    assert.equal(h.db.campaignWorkLedger.currentAssignment(launchedChild)?.workItemId, h.item.id);
    const delivered = await h.merge("child", 12, ["team/repo#100"]).request();
    assert.ok(delivered.ok, delivered.error ?? "refused");
    assert.equal(delivered.data!.authority, "orchestrator");
    assert.equal(delivered.data!.authorityEvaluation?.reason, "authorized_operation");
  } finally { h.db.close(); }
});

test("#4062 a refused follow-up addition cannot be delivered through a recommit, a dispatch and a merge that closes it", async () => {
  const h = scopeGuardHarness();
  try {
    // Without lineage the addition waits for the owner (#4267); until a person approves it, the scope is unchanged.
    const unadmitted = await h.svc.proposeCampaignIssueScope("root", { requestId: "add-follow-up", expectedRevision: 1,
      additions: [{ repository: "team/repo", number: 103 }], removals: [], explanation: "Verified follow-up" });
    assert.ok(unadmitted.ok, unadmitted.error ?? "refused");
    assert.equal(unadmitted.data!.authority, "human"); assert.equal(unadmitted.data!.status, "pending");
    assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers!.includes(103), false);
    const followUp = h.itemFor("follow-up:103", 103);
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: followUp, commitment: { state: "scope_removed", reason: "Not in scope." } }).ok);
    // Recommitting the item is recording, which stays allowed; dispatching it is not.
    const recommitted = h.svc.updateCampaignWorkItem("root", { workItemId: followUp, commitment: { state: "committed" } });
    assert.ok(recommitted.ok, recommitted.error ?? "refused");
    const launched = h.launch(followUp);
    assert.equal(launched.ok, false); assert.equal(launched.status, 409);
    assert.match(launched.error!, /team\/repo#103/); assert.match(launched.error!, SCOPE_ROUTE);

    const closing = await h.merge("child", 13, ["team/repo#103"]).request();
    assert.equal(closing.ok, false); assert.equal(closing.status, 409);
    assert.match(closing.error!, /team\/repo#103/);
    // Mixed closures name only the unscoped issues, each of them.
    const mixed = await h.merge("child", 14, ["other/repo#100", "team/repo#100", "team/repo#103"]).request();
    assert.equal(mixed.ok, false);
    assert.match(mixed.error!, /issue scope: other\/repo#100, team\/repo#103\./);
    assert.deepEqual(h.decisions("child"), []);
  } finally { h.db.close(); }
});

test("#4062 a merge that says Refs and closes nothing stays the Orchestrator's, and Custom campaigns are unchanged", async () => {
  const h = scopeGuardHarness();
  try {
    // This campaign's own pull requests reference their issue without closing it.
    const refs = await h.merge("child", 15, []).request();
    assert.ok(refs.ok, refs.error ?? "refused");
    assert.equal(refs.data!.authority, "orchestrator");
    assert.equal(refs.data!.resourceSnapshot.category === "pr_merge" && refs.data!.resourceSnapshot.intendedClosures, undefined);
  } finally { h.db.close(); }
  const custom = harness(false);
  try {
    const closes = ["team/repo#101"];
    const runner = custom.hub.requestFromRunner;
    custom.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => message.type === "github_merge_preflight"
      ? { type: "github_merge_preflight_result", requestId, sessionId: message.sessionId, ok: true, check: { checkedAt: 1,
        closures: closes.map((issue) => ({ issue, sources: ["description" as const], excerpt: "Closes #101" })) } }
      : runner(runnerId, requestId, message, timeout);
    const policy = custom.db.getSession("root")!.parentControlPolicy!;
    assert.ok(custom.svc.setParentControlPolicy("root", { ...policy.decisions, pr_merge: "orchestrator" }, policy.revision).ok);
    const headSha = "f".repeat(40);
    const created = await custom.svc.createWorkflowDecisionWithVideo("child", { requestId: "custom-merge", resourceKey: "team/repo#16", resourceSnapshot: {
      category: "pr_merge", repository: "team/repo", pullRequest: 16, headSha, reviewResult: "merge", intendedClosures: closes,
      requiredChecks: { headSha, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] } } });
    assert.ok(created.ok, created.error ?? "refused");
    assert.equal(created.data!.authority, "orchestrator", "a Custom campaign's saved merge owner still applies to an unscoped closure");
    assert.equal(created.data!.authorityEvaluation?.reason, "custom_owner");
    // Dispatch on an unscoped issue's item is unchanged under Custom, too.
    const plan = custom.svc.recordCampaignPlan("root", { items: [{ key: "issue:100", issue: { repository: "team/repo", number: 100 } },
      { key: "issue:101", issue: { repository: "team/repo", number: 101 } }], planComplete: true });
    assert.ok(plan.ok, plan.error ?? "plan");
    const unscoped = plan.data!.items.find((item) => item.key === "issue:101")!.workItemId;
    const assigned = custom.svc.assignCampaignWorkItem("root", { workItemId: unscoped, childSessionId: "child" });
    assert.ok(assigned.ok, assigned.error ?? "refused");
  } finally { custom.db.close(); }
});

test("#3762 a Full Control GitLab merge is the Orchestrator's only with its closures read and all in scope", async () => {
  const h = scopeGuardHarness();
  try {
    // The same campaign, on a GitLab project.
    const project = "gitlab.example.com/team/repo";
    const sql = (h.db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const policy = structuredClone(h.db.getSession("root")!.orchestratorPolicy!);
    assert.ok(policy.control?.mode === "full_control");
    policy.control.boundary.repository = project;
    policy.issueScope = { ...policy.issueScope!, repository: project };
    sql.prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
    const closes = new Map<number, string[] | "unreadable">();
    const runner = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      if (message.type !== "gitlab_merge_closures") return runner(runnerId, requestId, message, timeout);
      const closing = closes.get(message.pullRequest) ?? [];
      return closing === "unreadable"
        ? { type: "gitlab_merge_closures_result", requestId, sessionId: message.sessionId, ok: false, refusal: "unavailable",
          reason: "glab in this session's context is not signed in to gitlab.example.com." }
        : { type: "gitlab_merge_closures_result", requestId, sessionId: message.sessionId, ok: true, check: { checkedAt: 1,
          closures: closing.map((issue) => ({ issue, sources: ["description" as const], excerpt: `Implementing #${issue.split("#")[1]}` })) } };
    };
    const merge = (pullRequest: number, closing: string[] | "unreadable", declared = closing === "unreadable" ? [] : closing) => {
      closes.set(pullRequest, closing);
      const headSha = String(pullRequest).padStart(40, "c");
      return h.svc.createWorkflowDecisionWithVideo("child", { requestId: `gitlab-merge-${pullRequest}`, resourceKey: `${project}!${pullRequest}`,
        resourceSnapshot: { category: "pr_merge", repository: project, pullRequest, headSha, reviewResult: "merge",
          mergeMethod: "merge_train", squash: false, removeSourceBranch: false,
          requiredChecks: { headSha, status: "passed", checkedAt: 10, checks: [{ name: "Pipeline #1", state: "passed" }] },
          ...(declared.length ? { intendedClosures: declared } : {}) } });
    };

    // Read, and every closure in scope: owned exactly like a GitHub merge.
    for (const [pullRequest, closing] of [[31, [`${project}#100`]], [32, []]] as const) {
      const created = await merge(pullRequest, [...closing]);
      assert.ok(created.ok, created.error ?? "refused");
      assert.equal(created.data!.authority, "orchestrator");
      assert.equal(created.data!.authorityEvaluation?.reason, "authorized_operation");
      assert.deepEqual(created.data!.closingReferenceCheck?.closures.map((closure) => closure.issue), closing);
    }
    // A closure outside the scope is refused, naming the issue, whether declared or not.
    const declared = await merge(33, [`${project}#101`]);
    assert.equal(declared.status, 409);
    assert.match(declared.error!, /Merging this merge request would close an issue outside this Full Control campaign's issue scope: gitlab\.example\.com\/team\/repo#101\./);
    const undeclared = await merge(34, [`${project}#101`], []);
    assert.equal(undeclared.status, 409);
    assert.match(undeclared.error!, /intendedClosures does not list: gitlab\.example\.com\/team\/repo#101, from the description: “Implementing #101”/);
    // Closures that cannot be read never make it the Orchestrator's: nothing is created.
    const unreadable = await merge(35, "unreadable");
    assert.equal(unreadable.status, 409);
    assert.match(unreadable.error!, /GitLab could not be read .*not signed in to gitlab\.example\.com\. Try again\./);
    assert.deepEqual(h.decisions("child").map((decision) => decision.resourceSnapshot.category === "pr_merge" && decision.resourceSnapshot.pullRequest), [31, 32]);
    // A runner that predates the read (v294) keeps today's behavior: the person's.
    h.db.registerRunner(h.metadata, 1, RUNNER_CAPABILITY_MIN_PROTOCOL.gitlabMergeClosingReferences - 1);
    const legacy = await merge(36, [`${project}#100`]);
    assert.ok(legacy.ok, legacy.error ?? "refused");
    assert.equal(legacy.data!.authority, "human");
    assert.equal(legacy.data!.authorityEvaluation?.reason, "unverified_closures");
    assert.equal(legacy.data!.closingReferenceCheck, undefined);
    assert.equal(h.svc.resolveDescendantRequest("root", "child", legacy.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true).ok, false, "the Orchestrator cannot approve it");
  } finally { h.db.close(); }
});

test("#4062 a merge from a runner that cannot read closing references is the person's, whatever it declares", async () => {
  const h = scopeGuardHarness();
  try {
    h.db.registerRunner(h.metadata, 1, 241);
    // The pull request may also close an unscoped issue; a v241 runner is never asked.
    h.closes.set(21, ["team/repo#100", "team/repo#101"]);
    for (const [pullRequest, closing] of [[21, ["team/repo#100"]], [22, []]] as const) {
      const created = await h.merge("child", pullRequest, [...closing]).request();
      assert.ok(created.ok, created.error ?? "refused");
      assert.equal(created.data!.authority, "human");
      assert.equal(created.data!.authorityEvaluation?.reason, "unverified_closures");
      const approved = h.svc.resolveDescendantRequest("root", "child", created.data!.occurrenceId,
        { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
      assert.equal(approved.ok, false, "the Orchestrator cannot approve it");
      assert.equal(h.db.workflowDecisionByOccurrence(created.data!.occurrenceId)!.status, "pending");
    }
    const unscoped = await h.merge("child", 23, ["team/repo#101"]).request();
    assert.equal(unscoped.ok, false); assert.match(unscoped.error!, /team\/repo#101/);
  } finally { h.db.close(); }
});

test("#4062 a scope that drops a merge's closing issue after it was requested is evaluated again before approval and arming", async () => {
  const h = scopeGuardHarness(5, [100, 101]);
  try {
    h.db.createSession({ id: "merger", runnerId: "r", workspaceId: "w", agentId: "codex", title: "merger", parentSessionId: "root",
      driver: "claude-code", config: {}, useWorktree: false, now: Date.now() });
    h.db.updateSessionStatus("merger", "running", Date.now());
    const approvedFirst = h.merge("merger", 17, ["team/repo#101"]);
    const pendingFirst = h.merge("merger", 18, ["team/repo#101"]);
    const approved = await approvedFirst.request(), pending = await pendingFirst.request();
    assert.ok(approved.ok && pending.ok, approved.error ?? pending.error ?? "refused");
    assert.equal(approved.data!.authority, "orchestrator"); assert.equal(pending.data!.authority, "orchestrator");
    assert.ok(h.svc.resolveDescendantRequest("root", "merger", approved.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true).ok);

    // The campaign's scope no longer names the issue both merges would close.
    h.narrowScope([100]);

    const armed = await h.svc.consumeWorkflowDecision("merger", approved.data!.occurrenceId, { resourceSnapshot: approvedFirst.snapshot,
      action: { kind: "pr_merge_enqueue", command: canonicalPrMergeEnqueueCommand(approvedFirst.snapshot) } });
    assert.equal(armed.ok, false); assert.equal(armed.status, 409);
    assert.equal(h.db.workflowDecisionByOccurrence(approved.data!.occurrenceId)!.status, "revoked");
    const late = h.svc.resolveDescendantRequest("root", "merger", pending.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.equal(late.ok, false);
    assert.equal(h.db.workflowDecisionByOccurrence(pending.data!.occurrenceId)!.status, "revoked");
    const again = await h.merge("merger", 19, ["team/repo#101"]).request();
    assert.equal(again.ok, false); assert.match(again.error!, /team\/repo#101/);
  } finally { h.db.close(); }
});

test("#4062 a scope that drops a merge's closing issue while GitHub is read for arming leaves the merge unarmed", async () => {
  const h = scopeGuardHarness(5, [100, 101]);
  try {
    h.db.createSession({ id: "merger", runnerId: "r", workspaceId: "w", agentId: "codex", title: "merger", parentSessionId: "root",
      driver: "claude-code", config: {}, useWorktree: false, now: Date.now() });
    h.db.updateSessionStatus("merger", "running", Date.now());
    const merge = h.merge("merger", 20, ["team/repo#101"]);
    const created = await merge.request();
    assert.ok(created.ok, created.error ?? "refused");
    assert.ok(h.svc.resolveDescendantRequest("root", "merger", created.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true).ok);
    h.during.preflight = () => h.narrowScope([100]);
    const armed = await h.svc.consumeWorkflowDecision("merger", created.data!.occurrenceId, { resourceSnapshot: merge.snapshot,
      action: { kind: "pr_merge_enqueue", command: canonicalPrMergeEnqueueCommand(merge.snapshot) } });
    assert.equal(armed.ok, false); assert.equal(armed.status, 409);
    assert.match(armed.error!, /authority changed while arming/);
    const decision = h.db.workflowDecisionByOccurrence(created.data!.occurrenceId)!;
    assert.equal(decision.status, "revoked"); assert.equal(decision.actionAdmission, undefined);
  } finally { h.db.close(); }
});

// #4066, observed live: children re-requested publications that had gone to the person, and each
// re-request superseded the person's occurrence, so the person's approval landed on a dead one.
const publicationRequest = (h: ReturnType<typeof harness>, sessionId: string, requestId: string, resourceKey: string,
  recommendationId: string, sanitizedBody = body) => h.svc.createWorkflowDecisionWithVideo(sessionId, { requestId, resourceKey,
  resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Related repair", sanitizedBody, labels: [], recommendationId } });
const personResolves = (h: ReturnType<typeof harness>, sessionId: string, occurrenceId: string, outcome: "approve" | "deny" = "approve") =>
  h.svc.resolveWorkflowDecision("root", sessionId, occurrenceId, { outcome }, "human", { kind: "human", id: h.principal.userId }, () => true);
const cardIds = (h: ReturnType<typeof harness>, sessionId: string) =>
  JSON.stringify(h.db.getSession(sessionId)!.pendingApproval ?? null);

test("#4066 case A: a re-request never supersedes the person's pending or approved publication, and names it with the withdrawal route", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    const unsafe = `${body}\napi_key=secret-value`;
    const first = await publicationRequest(h, "child", "publish-1", "publish", recommendationId, unsafe);
    assert.ok(first.ok, first.error ?? "first");
    assert.deepEqual([first.data!.authority, first.data!.authorityEvaluation?.admissionFailure], ["human", "unsafe_payload"]);
    const personal = first.data!.occurrenceId;

    // While the person is deciding, the same key is refused, and nothing is created or retired.
    const again = await publicationRequest(h, "child", "publish-2", "publish", recommendationId, unsafe);
    assert.deepEqual([again.ok, again.status, again.errorDetails?.code, again.errorDetails?.occurrenceId],
      [false, 409, "person_owned_publication_open", personal]);
    assert.match(again.error!, new RegExp(`decision ${personal} \\(pending\\).*Nothing was created\\. Wait for the person's decision, or withdraw it first with withdraw_workflow_decision \\(wollipog decision withdraw ${personal} `, "u"));
    assert.equal(h.db.workflowDecisionByRequestId("child", "publish-2"), null);
    assert.equal(h.db.workflowDecisionByOccurrence(personal)!.status, "pending");
    assert.ok(cardIds(h, "child").includes(personal), "the person's card stays");

    // The person's approval lands on the live occurrence.
    const approved = personResolves(h, "child", personal);
    assert.ok(approved.ok, approved.error ?? "approve");
    assert.equal(h.db.workflowDecisionByOccurrence(personal)!.status, "approved");

    // A re-request after the person approved is refused too, and tells the requester to consume it.
    const afterApproval = await publicationRequest(h, "child", "publish-3", "publish", recommendationId, unsafe);
    assert.deepEqual([afterApproval.status, afterApproval.errorDetails?.occurrenceId], [409, personal]);
    assert.match(afterApproval.error!, /\(approved\).*It is approved: consume it to publish, or withdraw it first/u);
    assert.equal(h.db.workflowDecisionByRequestId("child", "publish-3"), null);
    assert.equal(h.db.workflowDecisionByOccurrence(personal)!.status, "approved", "the person's approval still stands");

    // A replayed requestId still answers with its own occurrence.
    const replay = await publicationRequest(h, "child", "publish-1", "publish", recommendationId, unsafe);
    assert.equal(replay.data?.occurrenceId, personal);
  } finally { h.db.close(); }
});

test("#4066 case A: after the requester withdraws the person's pending publication, it can request again", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    const unsafe = `${body}\napi_key=secret-value`;
    const first = await publicationRequest(h, "child", "publish-1", "publish", recommendationId, unsafe);
    assert.ok(first.ok);
    assert.equal((await publicationRequest(h, "child", "publish-2", "publish", recommendationId, unsafe)).status, 409);
    assert.ok(h.svc.withdrawWorkflowDecision("child", first.data!.occurrenceId, { reason: "Payload needs another redaction" }).ok);
    const next = await publicationRequest(h, "child", "publish-3", "publish", recommendationId, unsafe);
    assert.ok(next.ok, next.error ?? "after withdrawal");
    assert.equal(next.data!.authority, "human");
    assert.equal(h.db.workflowDecisionByOccurrence(first.data!.occurrenceId)!.status, "revoked", "the withdrawal, not a supersession");
  } finally { h.db.close(); }
});

test("#4066 case B: an admitted re-request retires the requester's person-owned publication for its recommendation, naming itself as the cause", async () => {
  for (const personApprovedFirst of [false, true]) {
    const label = personApprovedFirst ? "approved" : "pending";
    const h = harness();
    try {
      const recommendationId = acceptedRecommendation(h);
      const otherRecommendation = acceptedRecommendation(h, "Second repair");
      h.state.publicationOk = false;
      const personal = await publicationRequest(h, "child", "publish-1", "publish", recommendationId);
      assert.ok(personal.ok, personal.error ?? label);
      assert.deepEqual([personal.data!.authority, personal.data!.authorityEvaluation?.admissionFailure], ["human", "inspection_failed"], label);
      // Neither another recommendation's person-owned publication nor another requester's is retired.
      const other = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "other-1", resourceKey: "other", resourceSnapshot: {
        category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Second repair", sanitizedBody: body, labels: [], recommendationId: otherRecommendation } });
      assert.equal(other.data?.authority, "human", label);
      const rootOwn = await publicationRequest(h, "root", "root-1", "publish", recommendationId);
      assert.equal(rootOwn.data?.authority, "human", label);
      if (personApprovedFirst) assert.ok(personResolves(h, "child", personal.data!.occurrenceId).ok, label);

      h.state.publicationOk = true;
      const admitted = await publicationRequest(h, "child", "publish-2", "publish", recommendationId);
      assert.ok(admitted.ok, `${label}: ${admitted.error}`);
      assert.equal(admitted.data!.authority, "orchestrator", label);
      assert.equal(admitted.data!.resourceKey, `publication:${recommendationId}`, label);

      const retired = h.db.workflowDecisionByOccurrence(personal.data!.occurrenceId)!;
      assert.deepEqual([retired.status, retired.supersededBy], ["superseded", admitted.data!.occurrenceId], label);
      assert.ok(!cardIds(h, "child").includes(personal.data!.occurrenceId), `${label}: the person's card is withdrawn`);
      assert.ok(cardIds(h, "child").includes(admitted.data!.occurrenceId), label);
      assert.ok(!h.db.unconsumedWorkflowDecisionsForSession("child").some((d) => d.occurrenceId === personal.data!.occurrenceId),
        `${label}: verification no longer finds it unresolved`);
      assert.equal(h.db.workflowDecisionByOccurrence(other.data!.occurrenceId)!.status, "pending", `${label}: another recommendation's stays`);
      assert.equal(h.db.workflowDecisionByOccurrence(rootOwn.data!.occurrenceId)!.status, "pending", `${label}: another requester's stays`);

      // The person cannot approve it, and is told what replaced it, on either route.
      for (const refused of [personResolves(h, "child", personal.data!.occurrenceId),
        h.svc.approve("child", personal.data!.occurrenceId, "approve", { kind: "human", id: h.principal.userId })]) {
        assert.deepEqual([refused.ok, refused.status, refused.errorDetails?.code, refused.errorDetails?.supersededBy],
          [false, 409, "workflow_decision_superseded", admitted.data!.occurrenceId], label);
        assert.equal(refused.error, `workflow decision ${personal.data!.occurrenceId} was superseded by workflow decision ${admitted.data!.occurrenceId} and can no longer be approved or denied`, label);
      }
      assert.equal(h.db.workflowDecisionByOccurrence(personal.data!.occurrenceId)!.status, "superseded", label);

      // The admitted one is the Orchestrator's to approve and the requester's to consume.
      assert.ok(h.svc.resolveWorkflowDecision("root", "child", admitted.data!.occurrenceId, { outcome: "approve" }, "orchestrator", { kind: "agent", id: "root" }, () => true).ok, label);
      const consumed = await h.svc.consumeWorkflowDecision("child", admitted.data!.occurrenceId, { resourceSnapshot: admitted.data!.resourceSnapshot });
      assert.ok(consumed.ok, `${label}: ${consumed.error}`);
    } finally { h.db.close(); }
  }
});

test("#4066 supersession between Orchestrator-owned occurrences is unchanged, and now names its cause", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    const first = await publicationRequest(h, "child", "admitted-1", "publish", recommendationId);
    const second = await publicationRequest(h, "child", "admitted-2", "publish", recommendationId);
    assert.deepEqual([first.data?.authority, second.data?.authority], ["orchestrator", "orchestrator"]);
    const replaced = h.db.workflowDecisionByOccurrence(first.data!.occurrenceId)!;
    assert.deepEqual([replaced.status, replaced.supersededBy], ["superseded", second.data!.occurrenceId]);
    const refused = h.svc.resolveWorkflowDecision("root", "child", first.data!.occurrenceId, { outcome: "approve" }, "orchestrator", { kind: "agent", id: "root" }, () => true);
    assert.equal(refused.status, 409);
    assert.match(refused.error!, new RegExp(`superseded by workflow decision ${second.data!.occurrenceId}`, "u"));
  } finally { h.db.close(); }
});
