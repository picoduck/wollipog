import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  HUMAN_ONLY_PARENT_CONTROL_POLICY,
  OWNER_QUESTION_ANSWER_ID,
  OWNER_QUESTION_NOTE_ID,
  PROTOCOL_VERSION,
  pendingRequests,
  presentOwnerQuestionRequest,
  type ControlPlaneToRunner,
  type ForgeDecisionAction,
  type RunnerMetadata,
  type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
const PNG_SHA = createHash("sha256").update(PNG_BYTES).digest("hex");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeHarness(options: {
  runnerProtocol?: number;
  driver?: "acp" | "claude-code";
  repository?: string;
  withLocation?: boolean;
} = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const owner = { kind: "human" as const, id: principal.userId };
  const otherHuman = { kind: "human" as const, id: "someone-else" };
  let repo = options.repository ?? "team/repo";
  const runnerProtocol = options.runnerProtocol ?? PROTOCOL_VERSION;
  const driver = options.driver ?? "acp";

  const metadata: RunnerMetadata = {
    runnerId: "r",
    hostname: "test-host",
    os: "linux",
    version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/project" }],
    agents: [
      { id: "agent-acp", name: "Antigravity", command: "agy", args: [], env: {}, driver: "acp", context: { kind: "native" }, available: true },
      { id: "agent-claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true },
    ],
    runtime: {
      dataDir: "/tmp/wollipog-test",
      worktreeRoot: "/tmp/wollipog-test/worktrees",
      maxConcurrentSessions: 4,
      campaignLaunchInspection: { version: 4 },
    },
  };
  db.registerRunner(metadata, 1, runnerProtocol);

  const project = db.createProject({ name: "Standalone Project", now: 1 });
  const location = options.withLocation === false
    ? null
    : db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w", addedByUserId: principal.userId }, 1);

  db.createSession({
    id: "solo",
    runnerId: "r",
    workspaceId: "w",
    agentId: driver === "claude-code" ? "agent-claude" : "agent-acp",
    title: "Standalone Task",
    useWorktree: false,
    driver,
    role: "normal",
    projectId: location ? project.id : undefined,
    projectLocationId: location?.id,
    now: 1,
    config: {},
  });
  db.updateSessionStatus("solo", "running", 2);

  const hub = new Hub(db);
  const toRunner: ControlPlaneToRunner[] = [];
  const runnerRequests: ControlPlaneToRunner[] = [];
  const forgeActions: ForgeDecisionAction[] = [];
  let publishedTitle = "Follow-up: tighten retry backoff";
  let publishedBody = "Track exponential backoff after standalone fix.";
  let publishedLabels = ["enhancement"];

  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  hub.sendToRunner = (_runner, message) => { toRunner.push(message); return true; };
  hub.requestFromRunner = (async (_runnerId: string, _requestId: string, message: ControlPlaneToRunner) => {
    runnerRequests.push(message);
    if (message.type === "campaign_launch_inspect") {
      return {
        type: "campaign_launch_inspection_result",
        requestId: message.requestId,
        ok: true,
        workspaceId: message.workspaceId,
        repository: repo,
        issueNumbers: message.issueNumbers ?? [],
        digest: sha256(`${repo}:${message.workspaceId}`),
      };
    }
    if (message.type === "github_merge_preflight") {
      return {
        type: "github_merge_preflight_result",
        requestId: message.requestId,
        sessionId: message.sessionId,
        ok: true,
        check: {
          checkedAt: 100,
          closures: [{ issue: `${repo}#42`, sources: ["description"], excerpt: "Fixes #42" }],
        },
      };
    }
    if (message.type === "forge_decision_action") {
      forgeActions.push(message.action);
      if (message.action.kind === "pr_merge_enqueue") {
        return {
          type: "forge_decision_action_result",
          requestId: message.requestId,
          sessionId: message.sessionId,
          occurrenceId: message.occurrenceId,
          outcome: "enqueued",
        };
      }
      if (message.action.kind === "branch_deletion") {
        return {
          type: "forge_decision_action_result",
          requestId: message.requestId,
          sessionId: message.sessionId,
          occurrenceId: message.occurrenceId,
          outcome: "deleted",
        };
      }
      if (message.action.kind === "issue_publication") {
        publishedTitle = message.action.title;
        publishedBody = message.action.body;
        publishedLabels = [...message.action.labels];
        return {
          type: "forge_decision_action_result",
          requestId: message.requestId,
          sessionId: message.sessionId,
          occurrenceId: message.occurrenceId,
          outcome: "published",
          issue: 88,
        };
      }
    }
    if (message.type === "github_issue_closure") {
      if (message.operation === "inspect") {
        return {
          type: "github_issue_closure_result",
          requestId: message.requestId,
          sessionId: message.sessionId,
          ok: true,
          inspection: {
            repository: repo,
            issue: message.issue,
            title: "Standalone issue to close",
            url: `https://github.com/${repo}/issues/${message.issue}`,
            state: "OPEN",
            forgeDigest: sha256(`${repo}#${message.issue}:open`),
            openPullRequests: [],
          },
        };
      }
      if (message.operation === "execute") {
        return {
          type: "github_issue_closure_result",
          requestId: message.requestId,
          sessionId: message.sessionId,
          ok: true,
          result: {
            outcome: "closed",
            url: `https://github.com/${repo}/issues/${message.snapshot.issue}`,
            completedAt: 200,
          },
        };
      }
    }
    throw new Error(`Unexpected runner request: ${message.type}`);
  }) as Hub["requestFromRunner"];

  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });

  const prompts = (sessionId: string) => [
    ...toRunner.flatMap((message) => message.type === "prompt_session" && message.sessionId === sessionId ? [message.text] : []),
    ...(db.raw().prepare("SELECT payload_json FROM session_prompt_commands WHERE session_id=?").all(sessionId) as Array<{ payload_json: string }>)
      .map((row) => (JSON.parse(row.payload_json) as { text: string }).text),
  ];

  const attachPng = (artifactId: string, sessionId: string, bytes = PNG_BYTES) => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    db.createArtifactBytes({
      artifactId,
      sessionId,
      kind: "screenshot",
      name: `${artifactId}.png`,
      mimeType: "image/png",
      encoding: "base64",
      sizeBytes: bytes.byteLength,
      sha256: digest,
      createdAt: 10,
      createdBy: { kind: "agent", id: sessionId },
    }, bytes);
    return digest;
  };

  return {
    db, svc, hub, principal, owner, otherHuman, project, location,
    toRunner, runnerRequests, forgeActions, prompts, attachPng,
    setRepo: (next: string) => { repo = next; },
  };
}

test("standalone Normal session Owner Question and Owner Approval route to owner, park blocking, resume, and never consume questions (#4894)", async () => {
  const h = makeHarness();
  try {
    // 1. Free-text Owner Question with suggested options
    const asked = await h.svc.createOwnerDecision("solo", {
      requestId: "q-1",
      resourceKey: "export-format",
      kind: "question",
      question: "Which export format should the standalone report use?",
      material: "Both **CSV** and **JSON** are supported.",
      options: [
        { optionId: "json", label: "JSON" },
        { optionId: "csv", label: "CSV" },
      ],
      recommendedOptionId: "json",
    });
    assert.equal(asked.status, 201, asked.error ?? "question created");
    assert.ok(asked.data);
    const question = asked.data;
    assert.equal(question.authority, "human");
    assert.equal(question.controllingSessionId, "solo");

    const soloParked = h.db.getSession("solo")!;
    assert.equal(soloParked.status, "input_required", "standalone Owner Question parks blocking");
    const card = pendingRequests(soloParked.pendingApproval).find((r) => r.occurrenceId === question.occurrenceId)!;
    assert.equal(card.async, undefined, "standalone Owner Question card is blocking");
    assert.equal(presentOwnerQuestionRequest(card).kind, "question");
    assert.equal(presentOwnerQuestionRequest(card).async, undefined);

    // Appears in human attention list (Inbox source).
    const listed = h.db.listSessions().find((s) => s.id === "solo")!;
    assert.ok(listed.attention?.humanActions?.some((action) => action.requestId === question.occurrenceId),
      "standalone Owner Question appears in Inbox humanActions");

    // Non-owner and agent resolutions are refused.
    assert.equal(h.svc.approve("solo", question.occurrenceId, "json", h.otherHuman).status, 403);
    assert.equal(h.svc.approve("solo", question.occurrenceId, "json", { kind: "agent", id: "solo" }).status, 403);
    assert.equal(h.svc.resolveWorkflowDecision("solo", "solo", question.occurrenceId,
      { outcome: "approve", selectedOptionId: "json" }, "orchestrator", { kind: "agent", id: "solo" }, () => true).status, 403);

    // Owner answers with free text via the question answer route.
    const answered = h.svc.answerQuestion("solo", question.occurrenceId, {
      [OWNER_QUESTION_ANSWER_ID]: "JSON (Recommended)",
      [OWNER_QUESTION_NOTE_ID]: "Include schema version 2.",
    }, h.owner, "submit", undefined, question.occurrenceId);
    assert.equal(answered.ok, true, answered.error ?? "owner answered");
    const resolvedQ = h.db.workflowDecisionByOccurrence(question.occurrenceId)!;
    assert.equal(resolvedQ.status, "approved");
    assert.equal(resolvedQ.selectedOptionId, "json");
    assert.equal(resolvedQ.childMessage, "Include schema version 2.");
    assert.equal(pendingRequests(h.db.getSession("solo")!.pendingApproval).length, 0);
    const answerPrompt = h.prompts("solo").find((text) => text.includes(question.occurrenceId));
    assert.ok(answerPrompt, "owner answer resumes standalone session");
    assert.match(answerPrompt!, /Include schema version 2\./u);

    // Owner Question can NEVER be consumed as an approval.
    const consumeQ = await h.svc.consumeWorkflowDecision("solo", question.occurrenceId, {
      resourceSnapshot: resolvedQ.resourceSnapshot,
    });
    assert.equal(consumeQ.status, 403);
    assert.match(consumeQ.error ?? "", /grants no authority/u);

    // 2. Free-text Owner Question with 0 suggested options
    h.db.updateSessionStatus("solo", "running", 20);
    const openQ = await h.svc.createOwnerDecision("solo", {
      requestId: "q-open",
      resourceKey: "open-question",
      kind: "question",
      question: "What release notes highlights do you want emphasized?",
      options: [],
    });
    assert.equal(openQ.status, 201, openQ.error ?? "open question created");
    assert.equal(h.svc.answerQuestion("solo", openQ.data!.occurrenceId, { [OWNER_QUESTION_ANSWER_ID]: "Focus on reliability." },
      h.owner, "submit", undefined, openQ.data!.occurrenceId).ok, true);
    assert.equal(h.db.workflowDecisionByOccurrence(openQ.data!.occurrenceId)!.childMessage, "Focus on reliability.");

    // 3. Generic Owner Approval (kind: "approval")
    h.db.updateSessionStatus("solo", "running", 30);
    const approval = await h.svc.createOwnerDecision("solo", {
      requestId: "ap-1",
      resourceKey: "schema-migration",
      kind: "approval",
      question: "Run the one-time local schema migration?",
      material: "Affects local cache only.",
      options: [
        { optionId: "run", label: "Run Migration" },
        { optionId: "skip", label: "Skip" },
      ],
    });
    assert.equal(approval.status, 201, approval.error ?? "approval created");
    assert.equal(h.svc.approve("solo", approval.data!.occurrenceId, "run", h.otherHuman).status, 403);
    assert.equal(h.svc.approve("solo", approval.data!.occurrenceId, "run", h.owner).ok, true);
    assert.equal(h.db.workflowDecisionByOccurrence(approval.data!.occurrenceId)!.selectedOptionId, "run");

    // 4. ruleDelegation stays bound to Full Control campaigns and is refused for standalone sessions.
    const delegated = await h.svc.createOwnerDecision("solo", {
      requestId: "rd-1",
      resourceKey: "rule-del",
      question: "Delegate rule?",
      options: [{ optionId: "yes", label: "Yes" }, { optionId: "no", label: "No" }],
      ruleDelegation: {
        rule: { source: "~/.claude/CLAUDE.md", quote: "Ask before merging." },
        categories: ["pr_merge"],
      },
    });
    assert.equal(delegated.status, 400);
    assert.match(delegated.error ?? "", /Full Control Owner Approval/u);
  } finally {
    h.db.close();
  }
});

test("standalone Normal session dedicated typed approvals bind targets, verify artifacts/Location, and enforce one-shot execution (#4894)", async () => {
  const h = makeHarness({ driver: "acp" });
  try {
    // 1. pr_merge (non-hook ACP driver executes approved merge directly through Wollipog)
    const mergeSnap: WorkflowDecisionResourceSnapshot = {
      category: "pr_merge",
      repository: "team/repo",
      pullRequest: 7,
      headSha: HEAD_SHA,
      reviewResult: "merge",
      requiredChecks: {
        headSha: HEAD_SHA,
        status: "passed",
        checkedAt: 10,
        checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" }],
      },
      intendedClosures: ["team/repo#42"],
    };
    const mergeReq = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "merge-1",
      resourceKey: "team/repo#7",
      resourceSnapshot: mergeSnap,
    });
    assert.equal(mergeReq.status, 201, mergeReq.error ?? "pr_merge created");
    assert.equal(mergeReq.data!.authority, "human");
    assert.equal(h.svc.approve("solo", mergeReq.data!.occurrenceId, "approve", h.otherHuman).status, 403);
    assert.equal(h.svc.approve("solo", mergeReq.data!.occurrenceId, "approve", h.owner).ok, true);

    const mergeExec = await h.svc.executeWorkflowDecision("solo", mergeReq.data!.occurrenceId, {
      resourceDigest: mergeReq.data!.resourceDigest,
    });
    assert.equal(mergeExec.ok, true, mergeExec.error ?? "pr_merge executed");
    assert.equal(mergeExec.data!.status, "consumed");
    assert.equal(mergeExec.data!.forgeAction?.outcome, "enqueued");
    // Replay is refused.
    const mergeReplay = await h.svc.executeWorkflowDecision("solo", mergeReq.data!.occurrenceId, {
      resourceDigest: mergeReq.data!.resourceDigest,
    });
    assert.equal(mergeReplay.status, 409);

    // 2. merged_branch_deletion (separate approval, one-shot execute; temporary deletion refused)
    const tempDel = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "temp-del-1",
      resourceKey: "temp-branch",
      resourceSnapshot: {
        category: "merged_branch_deletion",
        merged: false,
        repository: "team/repo",
        branch: "tmp/foo",
        headSha: HEAD_SHA,
        temporaryReceiptId: "receipt_1",
        dependentPullRequests: { checkedAt: 10, open: [] },
      },
    });
    assert.equal(tempDel.status, 409);

    const delSnap: WorkflowDecisionResourceSnapshot = {
      category: "merged_branch_deletion",
      merged: true,
      repository: "team/repo",
      branch: "feat/standalone",
      pullRequest: 7,
      headSha: HEAD_SHA,
      mergeCommitSha: HEAD_SHA,
      dependentPullRequests: { checkedAt: 10, open: [] },
    };
    const delReq = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "del-1",
      resourceKey: "team/repo:feat/standalone",
      resourceSnapshot: delSnap,
    });
    assert.equal(delReq.status, 201, delReq.error ?? "merged_branch_deletion created");
    assert.equal(h.svc.approve("solo", delReq.data!.occurrenceId, "approve", h.owner).ok, true);
    const delExec = await h.svc.executeWorkflowDecision("solo", delReq.data!.occurrenceId, {
      resourceDigest: delReq.data!.resourceDigest,
    });
    assert.equal(delExec.ok, true, delExec.error ?? "branch deletion executed");
    assert.equal(delExec.data!.status, "consumed");
    assert.equal(delExec.data!.forgeAction?.outcome, "deleted");
    assert.equal((await h.svc.executeWorkflowDecision("solo", delReq.data!.occurrenceId, {
      resourceDigest: delReq.data!.resourceDigest,
    })).status, 409, "branch deletion cannot replay");

    // 3. follow_up_issue_publication (exact payload bound; recommendationId refused; stale consume revokes)
    const withRec = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "pub-rec",
      resourceKey: "pub-rec",
      resourceSnapshot: {
        category: "follow_up_issue_publication",
        repository: "team/repo",
        sanitizedTitle: "Title",
        sanitizedBody: "Body",
        labels: ["bug"],
        recommendationId: "rec_1",
      },
    });
    assert.equal(withRec.status, 400);

    const pubSnap: WorkflowDecisionResourceSnapshot = {
      category: "follow_up_issue_publication",
      repository: "team/repo",
      sanitizedTitle: "Follow-up: tighten retry backoff",
      sanitizedBody: "Track exponential backoff after standalone fix.",
      labels: ["enhancement"],
    };
    const pubReq1 = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "pub-1",
      resourceKey: "pub-backoff",
      resourceSnapshot: pubSnap,
    });
    assert.equal(pubReq1.status, 201, pubReq1.error ?? "publication created");
    assert.equal(h.svc.approve("solo", pubReq1.data!.occurrenceId, "approve", h.owner).ok, true);
    // Changed body on consume is refused and revokes the stale approval.
    const pubTampered = await h.svc.consumeWorkflowDecision("solo", pubReq1.data!.occurrenceId, {
      resourceSnapshot: { ...pubSnap, sanitizedBody: "Tampered body!" },
    });
    assert.equal(pubTampered.status, 409);
    assert.equal(h.db.workflowDecisionByOccurrence(pubReq1.data!.occurrenceId)!.status, "revoked");

    // Fresh approval executes through Wollipog and consumes once.
    const pubReq2 = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "pub-2",
      resourceKey: "pub-backoff-2",
      resourceSnapshot: pubSnap,
    });
    assert.equal(pubReq2.status, 201, pubReq2.error ?? "publication 2 created");
    assert.equal(h.svc.approve("solo", pubReq2.data!.occurrenceId, "approve", h.owner).ok, true);
    const pubExec = await h.svc.executeWorkflowDecision("solo", pubReq2.data!.occurrenceId, {
      resourceDigest: pubReq2.data!.resourceDigest,
    });
    assert.equal(pubExec.ok, true, pubExec.error ?? "publication executed");
    assert.equal(pubExec.data!.status, "consumed");
    assert.equal(pubExec.data!.forgeAction?.publishedIssue, 88);
    assert.equal((await h.svc.executeWorkflowDecision("solo", pubReq2.data!.occurrenceId, {
      resourceDigest: pubReq2.data!.resourceDigest,
    })).status, 409, "publication cannot replay");

    // 4. ui_evidence_approval (session-owned artifact integrity verified at create, approve, and consume)
    h.db.createSession({
      id: "other-session", runnerId: "r", workspaceId: "w", agentId: "agent-acp",
      title: "Other", useWorktree: false, driver: "acp", role: "normal", now: 1, config: {},
    });
    const foreignDigest = h.attachPng("art_foreign", "other-session");
    const foreignReq = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "ui-foreign",
      resourceKey: "ui-foreign",
      resourceSnapshot: {
        category: "ui_evidence_approval",
        evidence: [{ evidenceId: "shot-1", artifactId: "art_foreign", mediaType: "image/png", sha256: foreignDigest }],
      },
    });
    assert.equal(foreignReq.status, 409, "foreign session artifact is refused");

    const ownDigest = h.attachPng("art_own", "solo");
    const uiSnap: WorkflowDecisionResourceSnapshot = {
      category: "ui_evidence_approval",
      evidence: [{ evidenceId: "shot-1", artifactId: "art_own", mediaType: "image/png", sha256: ownDigest }],
    };
    const uiReq = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "ui-1",
      resourceKey: "ui-modal",
      resourceSnapshot: uiSnap,
    });
    assert.equal(uiReq.status, 201, uiReq.error ?? "ui_evidence_approval created");
    assert.equal(h.svc.resolveWorkflowDecision("solo", "solo", uiReq.data!.occurrenceId,
      { outcome: "approve", evidenceReviewed: ["shot-1"] }, "human", h.owner, () => true).ok, true);
    const uiConsume = await h.svc.consumeWorkflowDecision("solo", uiReq.data!.occurrenceId, {
      resourceSnapshot: uiSnap,
    });
    assert.equal(uiConsume.ok, true, uiConsume.error ?? "ui_evidence_approval consumed");
    assert.equal(uiConsume.data!.status, "consumed");
    assert.equal((await h.svc.consumeWorkflowDecision("solo", uiReq.data!.occurrenceId, {
      resourceSnapshot: uiSnap,
    })).status, 409, "ui_evidence_approval cannot replay");

    // 5. issue_closure (inspect + approve + one-shot execute; dispositionRecommendationId refused)
    const badClosure = await h.svc.requestGithubIssueClosure("solo", {
      requestId: "cl-bad",
      issue: 42,
      reason: "not_planned",
      explanation: "Obsolete.",
      evidence: ["Verified."],
      dispositionRecommendationId: "rec_1",
    });
    assert.equal(badClosure.status, 400);

    const closureReq = await h.svc.requestGithubIssueClosure("solo", {
      requestId: "cl-1",
      issue: 42,
      repository: "team/repo",
      reason: "completed",
      explanation: "Delivered in PR #7.",
      evidence: ["PR #7 merged on main."],
      comment: "Closing as completed via PR #7.",
    });
    assert.equal(closureReq.ok, true, closureReq.error ?? "issue_closure created");
    const closureDecision = closureReq.data!.decision!;
    assert.equal(closureDecision.authority, "human");
    assert.equal(closureDecision.category, "issue_closure");
    const inspectMsg = [...h.runnerRequests].reverse().find((m) => m.type === "github_issue_closure" && m.operation === "inspect");
    assert.ok(inspectMsg && inspectMsg.type === "github_issue_closure" && inspectMsg.standalone === true);
    assert.equal(inspectMsg.expectedRepository, "team/repo");

    assert.equal(h.svc.approve("solo", closureDecision.occurrenceId, "approve", h.otherHuman).status, 403);
    assert.equal(h.svc.approve("solo", closureDecision.occurrenceId, "approve", h.owner).ok, true);
    const closureExec = await h.svc.executeGithubIssueClosure("solo", closureDecision.occurrenceId, closureDecision.resourceDigest);
    assert.equal(closureExec.ok, true, closureExec.error ?? "issue_closure executed");
    assert.equal(closureExec.data!.status, "consumed");
    assert.equal(closureExec.data!.issueClosureResult?.outcome, "closed");
    const execMsg = [...h.runnerRequests].reverse().find((m) => m.type === "github_issue_closure" && m.operation === "execute");
    assert.ok(execMsg && execMsg.type === "github_issue_closure" && execMsg.standalone === true);
    assert.equal(execMsg.expectedRepository, "team/repo");
    assert.equal((await h.svc.executeGithubIssueClosure("solo", closureDecision.occurrenceId, closureDecision.resourceDigest)).status, 409,
      "issue_closure cannot replay");
  } finally {
    h.db.close();
  }
});

test("standalone Claude Code pr_merge preserves arm-then-execute and revokes stale head (#4894)", async () => {
  const h = makeHarness({ driver: "claude-code" });
  try {
    const snap: WorkflowDecisionResourceSnapshot = {
      category: "pr_merge",
      repository: "team/repo",
      pullRequest: 9,
      headSha: HEAD_SHA,
      reviewResult: "merge",
      requiredChecks: {
        headSha: HEAD_SHA,
        status: "passed",
        checkedAt: 10,
        checks: [{ name: "CI", state: "passed" }],
      },
      intendedClosures: ["team/repo#42"],
    };
    const req = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "cc-merge-1",
      resourceKey: "team/repo#9",
      resourceSnapshot: snap,
    });
    assert.equal(req.status, 201, req.error ?? "created");
    assert.equal(h.svc.approve("solo", req.data!.occurrenceId, "approve", h.owner).ok, true);

    // Unarmed execute on claude-code still requires arming first.
    const unarmed = await h.svc.executeWorkflowDecision("solo", req.data!.occurrenceId, {
      resourceDigest: req.data!.resourceDigest,
    });
    assert.equal(unarmed.status, 409);
    assert.match(unarmed.error ?? "", /arm the merge first/u);

    // Arming with exact action succeeds, then execute runs once and consumes.
    const approved = h.svc.workflowDecision("solo", req.data!.occurrenceId).data!;
    assert.ok(approved.approvedAction);
    const armed = await h.svc.consumeWorkflowDecision("solo", req.data!.occurrenceId, {
      resourceSnapshot: snap,
      action: approved.approvedAction,
    });
    assert.equal(armed.ok, true, armed.error ?? "armed");
    assert.ok(armed.data!.actionAdmission);

    const exec = await h.svc.executeWorkflowDecision("solo", req.data!.occurrenceId, {
      resourceDigest: req.data!.resourceDigest,
    });
    assert.equal(exec.ok, true, exec.error ?? "executed");
    assert.equal(exec.data!.status, "consumed");

    // Stale head on consume is refused and revokes approval.
    const req2 = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "cc-merge-2",
      resourceKey: "team/repo#10",
      resourceSnapshot: { ...snap, pullRequest: 10 },
    });
    assert.equal(req2.status, 201);
    assert.equal(h.svc.approve("solo", req2.data!.occurrenceId, "approve", h.owner).ok, true);
    const stale = await h.svc.consumeWorkflowDecision("solo", req2.data!.occurrenceId, {
      resourceSnapshot: { ...snap, pullRequest: 10, headSha: OTHER_SHA, requiredChecks: { ...snap.requiredChecks, headSha: OTHER_SHA } },
    });
    assert.equal(stale.status, 409);
    assert.equal(h.db.workflowDecisionByOccurrence(req2.data!.occurrenceId)!.status, "revoked");
  } finally {
    h.db.close();
  }
});

test("standalone reconnect restores pending approvals and Owner Questions; unauthorized repo, malformed ancestry, campaign child, and older runner are refused (#4894)", async () => {
  const h = makeHarness();
  try {
    // 1. Reconnect / card restoration
    const q = await h.svc.createOwnerDecision("solo", {
      requestId: "rec-q",
      resourceKey: "rec-q",
      kind: "question",
      question: "Keep waiting after reconnect?",
      options: [{ optionId: "yes", label: "Yes" }],
    });
    assert.equal(q.status, 201);
    const m = await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "rec-m",
      resourceKey: "team/repo#55",
      resourceSnapshot: {
        category: "pr_merge",
        repository: "team/repo",
        pullRequest: 55,
        headSha: HEAD_SHA,
        reviewResult: "merge",
        requiredChecks: { headSha: HEAD_SHA, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] },
        intendedClosures: ["team/repo#42"],
      },
    });
    assert.equal(m.status, 201);

    // Simulate transient runner disconnect clearing projected cards, then reconnect reconciliation.
    h.svc.failRunnerSessions("r");
    assert.equal(h.db.getSession("solo")!.pendingApproval, null, "provisional disconnect clears projected cards");
    h.svc.reconcileRunnerSessions("r", ["solo"]);
    const restored = h.db.getSession("solo")!;
    assert.equal(restored.status, "input_required");
    const restoredIds = pendingRequests(restored.pendingApproval).map((r) => r.occurrenceId);
    assert.ok(restoredIds.includes(q.data!.occurrenceId), "Owner Question restored");
    assert.ok(restoredIds.includes(m.data!.occurrenceId), "pr_merge approval restored");
    assert.ok(pendingRequests(restored.pendingApproval).every((r) => !r.async), "restored standalone cards stay blocking");
    assert.equal(h.svc.answerQuestion("solo", q.data!.occurrenceId, { [OWNER_QUESTION_ANSWER_ID]: "Yes" },
      h.owner, "submit", undefined, q.data!.occurrenceId).ok, true);

    // 2. Unauthorized repository (outside Project Location's verified repo)
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "bad-repo-merge",
      resourceKey: "other/repo#1",
      resourceSnapshot: {
        category: "pr_merge", repository: "other/repo", pullRequest: 1, headSha: HEAD_SHA, reviewResult: "merge",
        requiredChecks: { headSha: HEAD_SHA, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] },
      },
    })).status, 403);
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "bad-repo-del",
      resourceKey: "other/repo:b",
      resourceSnapshot: {
        category: "merged_branch_deletion", merged: true, repository: "other/repo", branch: "b",
        pullRequest: 1, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA,
        dependentPullRequests: { checkedAt: 10, open: [] },
      },
    })).status, 403);
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "bad-repo-pub",
      resourceKey: "other/repo:pub",
      resourceSnapshot: {
        category: "follow_up_issue_publication", repository: "other/repo", sanitizedTitle: "T", sanitizedBody: "B", labels: [],
      },
    })).status, 403);
    assert.equal((await h.svc.requestGithubIssueClosure("solo", {
      requestId: "bad-repo-close", issue: 1, repository: "other/repo",
      reason: "completed", explanation: "Done.", evidence: ["PR #1."],
    })).status, 403);

    // 3. Malformed ancestry (missing parentSessionId)
    h.db.createSession({
      id: "broken-ancestry", runnerId: "r", workspaceId: "w", agentId: "agent-acp",
      title: "Broken", useWorktree: false, driver: "acp", role: "normal",
      projectId: h.project.id, projectLocationId: h.location!.id,
      now: 1, config: {},
    });
    h.db.raw().exec("PRAGMA foreign_keys = OFF;");
    h.db.raw().prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run("missing-parent", "broken-ancestry");
    h.db.raw().exec("PRAGMA foreign_keys = ON;");
    h.db.updateSessionStatus("broken-ancestry", "running", 2);
    assert.equal((await h.svc.createOwnerDecision("broken-ancestry", {
      requestId: "ba-q", resourceKey: "ba-q", kind: "question", question: "Q?", options: [],
    })).status, 409);
    assert.equal((await h.svc.requestGithubIssueClosure("broken-ancestry", {
      requestId: "ba-cl", issue: 1, reason: "completed", explanation: "Done.", evidence: ["PR."],
    })).status, 409);
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("broken-ancestry", {
      requestId: "ba-ui", resourceKey: "ba-ui",
      resourceSnapshot: { category: "ui_evidence_approval", evidence: [{ evidenceId: "e1", uri: "https://example.com/e1.png", sha256: PNG_SHA }] },
    })).status, 409);

    // 4. Campaign child remains refused on standalone owner-decision and issue-closure routes
    const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    h.db.createSession({
      id: "orch", runnerId: "r", workspaceId: "w", agentId: "agent-claude",
      title: "Orch", useWorktree: false, driver: "claude-code", role: "orchestrator",
      orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
      now: 1, config: {},
    });
    h.db.createSession({
      id: "child", runnerId: "r", workspaceId: "w", agentId: "agent-claude",
      title: "Child", useWorktree: false, driver: "claude-code", role: "normal",
      parentSessionId: "orch", projectId: h.project.id, projectLocationId: h.location!.id,
      now: 1, config: {},
    });
    h.db.updateSessionStatus("orch", "running", 2);
    h.db.updateSessionStatus("child", "running", 2);
    assert.equal((await h.svc.createOwnerDecision("child", {
      requestId: "ch-q", resourceKey: "ch-q", kind: "question", question: "Q?", options: [],
    })).status, 409);
    assert.equal((await h.svc.requestGithubIssueClosure("child", {
      requestId: "ch-cl", issue: 1, reason: "completed", explanation: "Done.", evidence: ["PR."],
    })).status, 403);
  } finally {
    h.db.close();
  }

  // 5. Older runner (< 412) receives actionable compatibility error
  const old = makeHarness({ runnerProtocol: 411 });
  try {
    const oldQ = await old.svc.createOwnerDecision("solo", {
      requestId: "old-q", resourceKey: "old-q", kind: "question", question: "Q?", options: [],
    });
    assert.equal(oldQ.status, 409);
    assert.match(oldQ.error ?? "", /runner|upgrade|compatible/iu);

    const oldMerge = await old.svc.createWorkflowDecisionWithVideo("solo", {
      requestId: "old-m", resourceKey: "team/repo#1",
      resourceSnapshot: {
        category: "pr_merge", repository: "team/repo", pullRequest: 1, headSha: HEAD_SHA, reviewResult: "merge",
        requiredChecks: { headSha: HEAD_SHA, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] },
      },
    });
    assert.equal(oldMerge.status, 409);
    assert.match(oldMerge.error ?? "", /runner|upgrade|compatible/iu);

    const oldClose = await old.svc.requestGithubIssueClosure("solo", {
      requestId: "old-cl", issue: 1, reason: "completed", explanation: "Done.", evidence: ["PR."],
    });
    assert.equal(oldClose.status, 409);
    assert.match(oldClose.error ?? "", /runner|upgrade|compatible/iu);
  } finally {
    old.db.close();
  }
});

test("Custom campaign root own-work approvals respect strictProjectIsolation and stay human-owned (#4894)", async () => {
  const h = makeHarness();
  try {
    const createCustomRoot = (id: string, strictProjectIsolation: boolean) => {
      const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
      policy.execution = { ...policy.execution, strictProjectIsolation };
      policy.issueScope = { repository: "team/repo", issueNumbers: [42], revision: 1, authorizedByUserId: h.principal.userId, authorizedAt: 1 };
      policy.issueNumbers = [42];
      h.db.createSession({
        id, runnerId: "r", workspaceId: "w", agentId: "agent-acp", title: id,
        useWorktree: false, driver: "acp", role: "orchestrator",
        projectId: h.project.id, projectLocationId: h.location!.id,
        orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
        now: 1, config: {},
      });
      h.db.updateSessionStatus(id, "running", 2);
    };

    // 1. Custom root with strictProjectIsolation: false can request its own implementation approvals & owner questions
    createCustomRoot("custom-open", false);
    const mergeSnap: WorkflowDecisionResourceSnapshot = {
      category: "pr_merge", repository: "team/repo", pullRequest: 11, headSha: HEAD_SHA, reviewResult: "merge",
      requiredChecks: { headSha: HEAD_SHA, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] },
      intendedClosures: ["team/repo#42"],
    };
    const rootMerge = await h.svc.createWorkflowDecisionWithVideo("custom-open", {
      requestId: "cm-1", resourceKey: "team/repo#11", resourceSnapshot: mergeSnap,
    });
    assert.equal(rootMerge.status, 201, rootMerge.error ?? "custom root pr_merge created");
    assert.equal(rootMerge.data!.authority, "human");
    // Root agent cannot approve its own request.
    assert.equal(h.svc.resolveWorkflowDecision("custom-open", "custom-open", rootMerge.data!.occurrenceId,
      { outcome: "approve" }, "orchestrator", { kind: "agent", id: "custom-open" }, () => true).status, 403);
    assert.equal(h.svc.approve("custom-open", rootMerge.data!.occurrenceId, "approve", h.owner).ok, true);

    const rootDel = await h.svc.createWorkflowDecisionWithVideo("custom-open", {
      requestId: "cd-1", resourceKey: "team/repo:feat/root",
      resourceSnapshot: {
        category: "merged_branch_deletion", merged: true, repository: "team/repo", branch: "feat/root",
        pullRequest: 11, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA,
        dependentPullRequests: { checkedAt: 10, open: [] },
      },
    });
    assert.equal(rootDel.status, 201, rootDel.error ?? "custom root deletion created");
    assert.equal(rootDel.data!.authority, "human");

    const digest = h.attachPng("art_custom_root", "custom-open");
    const rootUi = await h.svc.createWorkflowDecisionWithVideo("custom-open", {
      requestId: "cu-1", resourceKey: "ui-root",
      resourceSnapshot: {
        category: "ui_evidence_approval",
        evidence: [{ evidenceId: "shot-1", artifactId: "art_custom_root", mediaType: "image/png", sha256: digest }],
      },
    });
    assert.equal(rootUi.status, 201, rootUi.error ?? "custom root UI evidence created");
    assert.equal(rootUi.data!.authority, "human");

    const rootQuestion = await h.svc.createOwnerDecision("custom-open", {
      requestId: "cq-1", resourceKey: "cq-1", kind: "question",
      question: "Should the Custom root include migration docs?", options: [],
    });
    assert.equal(rootQuestion.status, 201, rootQuestion.error ?? "custom root question created");
    assert.equal(rootQuestion.data!.authority, "human");

    // Repository outside campaign scope is refused for Custom root own-work approvals.
    const outsideRepo = await h.svc.createWorkflowDecisionWithVideo("custom-open", {
      requestId: "cm-out", resourceKey: "other/repo#1",
      resourceSnapshot: { ...mergeSnap, repository: "other/repo", pullRequest: 1 },
    });
    assert.equal(outsideRepo.status, 403);

    // 2. Custom root with strictProjectIsolation: true refuses implementation approvals while keeping publication & owner_decision
    createCustomRoot("custom-strict", true);
    const strictMerge = await h.svc.createWorkflowDecisionWithVideo("custom-strict", {
      requestId: "sm-1", resourceKey: "team/repo#12", resourceSnapshot: { ...mergeSnap, pullRequest: 12 },
    });
    assert.equal(strictMerge.status, 409);
    assert.match(strictMerge.error ?? "", /Strict Project Isolation/u);

    const strictDel = await h.svc.createWorkflowDecisionWithVideo("custom-strict", {
      requestId: "sd-1", resourceKey: "team/repo:feat/strict",
      resourceSnapshot: {
        category: "merged_branch_deletion", merged: true, repository: "team/repo", branch: "feat/strict",
        pullRequest: 12, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA,
        dependentPullRequests: { checkedAt: 10, open: [] },
      },
    });
    assert.equal(strictDel.status, 409);
    assert.match(strictDel.error ?? "", /Strict Project Isolation/u);

    const strictDigest = h.attachPng("art_strict", "custom-strict");
    const strictUi = await h.svc.createWorkflowDecisionWithVideo("custom-strict", {
      requestId: "su-1", resourceKey: "ui-strict",
      resourceSnapshot: {
        category: "ui_evidence_approval",
        evidence: [{ evidenceId: "shot-1", artifactId: "art_strict", mediaType: "image/png", sha256: strictDigest }],
      },
    });
    assert.equal(strictUi.status, 409);
    assert.match(strictUi.error ?? "", /Strict Project Isolation/u);

    // Publication and Owner Question still succeed on a strict Custom root.
    const strictPub = await h.svc.createWorkflowDecisionWithVideo("custom-strict", {
      requestId: "sp-1", resourceKey: "sp-1",
      resourceSnapshot: {
        category: "follow_up_issue_publication", repository: "team/repo",
        sanitizedTitle: "Follow-up", sanitizedBody: "Details", labels: [],
      },
    });
    assert.equal(strictPub.status, 201, strictPub.error ?? "strict Custom root publication allowed");

    const strictQ = await h.svc.createOwnerDecision("custom-strict", {
      requestId: "sq-1", resourceKey: "sq-1", kind: "question",
      question: "Proceed with issue #42?", options: [],
    });
    assert.equal(strictQ.status, 201, strictQ.error ?? "strict Custom root question allowed");
  } finally {
    h.db.close();
  }
});

test("review round 1 regressions: Location switch revokes merge/deletion, Custom root verifies Location and v412 and stays async, standalone closure reconciles and refuses issueAdmission (#4894)", async () => {
  // Finding 1: standalone merge & deletion approvals cannot dispatch after a live Location switch to another repository.
  const h1 = makeHarness({ driver: "acp" });
  try {
    const mergeSnap: WorkflowDecisionResourceSnapshot = {
      category: "pr_merge", repository: "team/repo", pullRequest: 21, headSha: HEAD_SHA, reviewResult: "merge",
      requiredChecks: { headSha: HEAD_SHA, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] },
      intendedClosures: ["team/repo#42"],
    };
    const delSnap: WorkflowDecisionResourceSnapshot = {
      category: "merged_branch_deletion", merged: true, repository: "team/repo", branch: "feat/old-repo",
      pullRequest: 21, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA,
      dependentPullRequests: { checkedAt: 10, open: [] },
    };
    const m = await h1.svc.createWorkflowDecisionWithVideo("solo", { requestId: "sw-m", resourceKey: "team/repo#21", resourceSnapshot: mergeSnap });
    const d = await h1.svc.createWorkflowDecisionWithVideo("solo", { requestId: "sw-d", resourceKey: "team/repo:feat/old-repo", resourceSnapshot: delSnap });
    assert.equal(m.status, 201);
    assert.equal(d.status, 201);
    assert.equal(h1.svc.approve("solo", m.data!.occurrenceId, "approve", h1.owner).ok, true);
    assert.equal(h1.svc.approve("solo", d.data!.occurrenceId, "approve", h1.owner).ok, true);

    // Apply live Location switch to a second registered Project Location in repository B (preserving sessionId "solo").
    h1.db.registerRunner({
      runnerId: "r", hostname: "test-host", os: "linux", version: "test",
      workspaces: [{ id: "w", name: "Repo A", path: "/repos/project" }, { id: "w2", name: "Repo B", path: "/repos/other" }],
      agents: [{ id: "agent-acp", name: "Antigravity", command: "agy", args: [], env: {}, driver: "acp", context: { kind: "native" }, available: true }],
      runtime: { dataDir: "/tmp/wollipog-test", worktreeRoot: "/tmp/wollipog-test/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 4 } },
    }, 2, PROTOCOL_VERSION);
    const locB = h1.db.addProjectLocation(h1.project.id, { runnerId: "r", workspaceId: "w2", addedByUserId: h1.principal.userId }, 2);
    h1.db.raw().prepare("UPDATE sessions SET workspace_id = ?, project_location_id = ? WHERE id = ?").run("w2", locB.id, "solo");
    h1.setRepo("team/other-repo");

    const actionsBefore = h1.forgeActions.length;
    const mExec = await h1.svc.executeWorkflowDecision("solo", m.data!.occurrenceId, { resourceDigest: m.data!.resourceDigest });
    assert.equal(mExec.ok, true);
    assert.equal(mExec.data!.forgeAction?.outcome, "refused");
    assert.equal(h1.db.workflowDecisionByOccurrence(m.data!.occurrenceId)!.status, "revoked");

    const dExec = await h1.svc.executeWorkflowDecision("solo", d.data!.occurrenceId, { resourceDigest: d.data!.resourceDigest });
    assert.equal(dExec.ok, true);
    assert.equal(dExec.data!.forgeAction?.outcome, "refused");
    assert.equal(h1.db.workflowDecisionByOccurrence(d.data!.occurrenceId)!.status, "revoked");
    assert.equal(h1.forgeActions.length, actionsBefore, "no forge action may dispatch after Location switch");
  } finally {
    h1.db.close();
  }

  // Finding 2 & Finding 5: Custom root implementation approvals require matching verified checkout Location and stay async (non-parking).
  const h2 = makeHarness({ driver: "acp" });
  try {
    h2.db.registerRunner({
      runnerId: "r", hostname: "test-host", os: "linux", version: "test",
      workspaces: [{ id: "w", name: "Repo A", path: "/repos/project" }, { id: "w2", name: "Repo B", path: "/repos/second" }],
      agents: [{ id: "agent-acp", name: "Antigravity", command: "agy", args: [], env: {}, driver: "acp", context: { kind: "native" }, available: true }],
      runtime: { dataDir: "/tmp/wollipog-test", worktreeRoot: "/tmp/wollipog-test/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 4 } },
    }, 2, PROTOCOL_VERSION);
    const locSecond = h2.db.addProjectLocation(h2.project.id, { runnerId: "r", workspaceId: "w2", addedByUserId: h2.principal.userId }, 2);
    const policyMulti = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policyMulti.execution = { ...policyMulti.execution, strictProjectIsolation: false };
    policyMulti.issueNumbers = [42];
    policyMulti.issueScope = { repository: "team/repo", issueNumbers: [42], revision: 1, authorizedByUserId: h2.principal.userId, authorizedAt: 1 };
    policyMulti.repositories = [
      { repository: "team/repo", locationIds: [h2.location!.id] },
      { repository: "team/second-repo", locationIds: [locSecond.id] },
    ];
    h2.db.createSession({
      id: "custom-multi", runnerId: "r", workspaceId: "w", agentId: "agent-acp", title: "Custom Multi",
      useWorktree: false, driver: "acp", role: "orchestrator",
      projectId: h2.project.id, projectLocationId: h2.location!.id,
      orchestratorPolicy: policyMulti, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
      now: 1, config: {},
    });
    h2.db.updateSessionStatus("custom-multi", "running", 2);

    // Campaign lists team/second-repo, but Custom root's checkout Location is team/repo -> refused!
    const crossRepoDel = await h2.svc.createWorkflowDecisionWithVideo("custom-multi", {
      requestId: "cm-cross-del", resourceKey: "team/second-repo:feat/x",
      resourceSnapshot: {
        category: "merged_branch_deletion", merged: true, repository: "team/second-repo", branch: "feat/x",
        pullRequest: 5, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA, dependentPullRequests: { checkedAt: 10, open: [] },
      },
    });
    assert.equal(crossRepoDel.status, 403, `Custom root cannot delete branch in another campaign repository: ${crossRepoDel.error}`);

    // Custom root with no scope and no registered Project Location -> refused!
    const policyUnscoped = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policyUnscoped.execution = { ...policyUnscoped.execution, strictProjectIsolation: false };
    h2.db.createSession({
      id: "custom-unlocated", runnerId: "r", workspaceId: "w", agentId: "agent-acp", title: "Custom Unlocated",
      useWorktree: false, driver: "acp", role: "orchestrator",
      orchestratorPolicy: policyUnscoped, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
      now: 1, config: {},
    });
    h2.db.updateSessionStatus("custom-unlocated", "running", 2);
    const unlocatedDel = await h2.svc.createWorkflowDecisionWithVideo("custom-unlocated", {
      requestId: "cu-del", resourceKey: "team/second-repo:feat/y",
      resourceSnapshot: {
        category: "merged_branch_deletion", merged: true, repository: "team/second-repo", branch: "feat/y",
        pullRequest: 6, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA, dependentPullRequests: { checkedAt: 10, open: [] },
      },
    });
    assert.equal(unlocatedDel.status, 409, "Custom root without a registered Location is refused");

    // Finding 5: Non-isolated Custom root implementation approvals stay async and never park the Orchestrator (including after reconnect).
    const cMerge = await h2.svc.createWorkflowDecisionWithVideo("custom-multi", {
      requestId: "cm-async-m", resourceKey: "team/repo#31",
      resourceSnapshot: {
        category: "pr_merge", repository: "team/repo", pullRequest: 31, headSha: HEAD_SHA, reviewResult: "merge",
        requiredChecks: { headSha: HEAD_SHA, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] },
        intendedClosures: ["team/repo#42"],
      },
    });
    const cDel = await h2.svc.createWorkflowDecisionWithVideo("custom-multi", {
      requestId: "cm-async-d", resourceKey: "team/repo:feat/async",
      resourceSnapshot: {
        category: "merged_branch_deletion", merged: true, repository: "team/repo", branch: "feat/async",
        pullRequest: 31, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA, dependentPullRequests: { checkedAt: 10, open: [] },
      },
    });
    const cDigest = h2.attachPng("art_cm_async", "custom-multi");
    const cUi = await h2.svc.createWorkflowDecisionWithVideo("custom-multi", {
      requestId: "cm-async-u", resourceKey: "cm-async-ui",
      resourceSnapshot: {
        category: "ui_evidence_approval",
        evidence: [{ evidenceId: "shot-1", artifactId: "art_cm_async", mediaType: "image/png", sha256: cDigest }],
      },
    });
    assert.equal(cMerge.status, 201);
    assert.equal(cDel.status, 201);
    assert.equal(cUi.status, 201);
    const rootBefore = h2.db.getSession("custom-multi")!;
    assert.equal(rootBefore.status, "running", "Custom root stays running while its implementation approvals wait");
    const cardsBefore = pendingRequests(rootBefore.pendingApproval);
    assert.equal(cardsBefore.length, 3);
    assert.ok(cardsBefore.every((c) => c.async === true), "every Custom root implementation card is async");

    h2.svc.failRunnerSessions("r");
    h2.svc.reconcileRunnerSessions("r", ["custom-multi"]);
    const rootAfter = h2.db.getSession("custom-multi")!;
    assert.notEqual(rootAfter.status, "input_required", "reconnect keeps Custom root unparked");
    const cardsAfter = pendingRequests(rootAfter.pendingApproval);
    assert.equal(cardsAfter.length, 3);
    assert.ok(cardsAfter.every((c) => c.async === true), "restored Custom root implementation cards stay async");
  } finally {
    h2.db.close();
  }

  // Finding 3 (control plane): v411 scoped Custom root is refused on pr_merge, merged_branch_deletion, and ui_evidence_approval.
  const h3 = makeHarness({ runnerProtocol: 411 });
  try {
    const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policy.execution = { ...policy.execution, strictProjectIsolation: false };
    policy.issueNumbers = [42];
    policy.issueScope = { repository: "team/repo", issueNumbers: [42], revision: 1, authorizedByUserId: h3.principal.userId, authorizedAt: 1 };
    h3.db.createSession({
      id: "custom-old", runnerId: "r", workspaceId: "w", agentId: "agent-acp", title: "Custom Old",
      useWorktree: false, driver: "acp", role: "orchestrator",
      projectId: h3.project.id, projectLocationId: h3.location!.id,
      orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
      now: 1, config: {},
    });
    h3.db.updateSessionStatus("custom-old", "running", 2);
    const oldM = await h3.svc.createWorkflowDecisionWithVideo("custom-old", {
      requestId: "co-m", resourceKey: "team/repo#41",
      resourceSnapshot: {
        category: "pr_merge", repository: "team/repo", pullRequest: 41, headSha: HEAD_SHA, reviewResult: "merge",
        requiredChecks: { headSha: HEAD_SHA, status: "passed", checkedAt: 10, checks: [{ name: "CI", state: "passed" }] },
      },
    });
    assert.equal(oldM.status, 409);
    assert.match(oldM.error ?? "", /runner|upgrade|compatible/iu);
    const oldD = await h3.svc.createWorkflowDecisionWithVideo("custom-old", {
      requestId: "co-d", resourceKey: "team/repo:b",
      resourceSnapshot: {
        category: "merged_branch_deletion", merged: true, repository: "team/repo", branch: "b",
        pullRequest: 41, headSha: HEAD_SHA, mergeCommitSha: HEAD_SHA, dependentPullRequests: { checkedAt: 10, open: [] },
      },
    });
    assert.equal(oldD.status, 409);
    assert.match(oldD.error ?? "", /runner|upgrade|compatible/iu);
    const oldDigest = h3.attachPng("art_co", "custom-old");
    const oldU = await h3.svc.createWorkflowDecisionWithVideo("custom-old", {
      requestId: "co-u", resourceKey: "co-u",
      resourceSnapshot: {
        category: "ui_evidence_approval",
        evidence: [{ evidenceId: "shot-1", artifactId: "art_co", mediaType: "image/png", sha256: oldDigest }],
      },
    });
    assert.equal(oldU.status, 409);
    assert.match(oldU.error ?? "", /runner|upgrade|compatible/iu);
  } finally {
    h3.db.close();
  }

  // Finding 4 & Finding 6: standalone closure refuses extra issueAdmission (400, 0 runner calls), and uncertain closure enters scheduled retryDuePrompts reconciliation.
  const h4 = makeHarness();
  try {
    const reqsBefore = h4.runnerRequests.length;
    const withAdmission = await h4.svc.requestGithubIssueClosure("solo", {
      requestId: "cl-adm",
      issue: 42,
      repository: "team/repo",
      reason: "completed",
      explanation: "Done.",
      evidence: ["PR #7."],
      issueAdmission: { boundaryRevision: 1, evidenceDigest: "a".repeat(64) },
    } as unknown as Parameters<typeof h4.svc.requestGithubIssueClosure>[1]);
    assert.equal(withAdmission.status, 400, "extra issueAdmission is refused with 400");
    assert.equal(h4.runnerRequests.length, reqsBefore, "refused before any Location or issue inspection");

    // Create and approve a valid standalone closure, then fail the execute reply to leave it uncertain.
    const cl = await h4.svc.requestGithubIssueClosure("solo", {
      requestId: "cl-unc", issue: 42, repository: "team/repo",
      reason: "completed", explanation: "Delivered.", evidence: ["PR #7."],
    });
    assert.equal(cl.ok, true);
    const occId = cl.data!.decision!.occurrenceId;
    assert.equal(h4.svc.approve("solo", occId, "approve", h4.owner).ok, true);

    const origRequest = h4.hub.requestFromRunner;
    let executeCalls = 0;
    let reconcileCalls = 0;
    h4.hub.requestFromRunner = (async (runnerId: string, requestId: string, message: ControlPlaneToRunner, timeoutMs?: number) => {
      if (message.type === "github_issue_closure" && message.operation === "execute") {
        executeCalls++;
        throw new Error("runner disconnected mid-close");
      }
      if (message.type === "github_issue_closure" && message.operation === "reconcile") {
        reconcileCalls++;
        assert.equal(message.standalone, true, "reconcile carries standalone: true");
        return {
          type: "github_issue_closure_result", requestId: message.requestId, sessionId: message.sessionId,
          ok: true, reconciled: true,
        };
      }
      return origRequest(runnerId, requestId, message, timeoutMs);
    }) as Hub["requestFromRunner"];

    const unc = await h4.svc.executeGithubIssueClosure("solo", occId, cl.data!.decision!.resourceDigest);
    assert.equal(unc.ok, true);
    assert.equal(unc.data!.issueClosureResult?.outcome, "uncertain");
    assert.equal(executeCalls, 1);

    // Scheduled retryDuePrompts picks up the standalone uncertain closure and settles it read-only without re-executing.
    h4.svc.retryDuePrompts(Date.now(), "r");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(reconcileCalls, 1, "retryDuePrompts reconciled standalone uncertain closure");
    assert.equal(executeCalls, 1, "no second execute was ever dispatched");
    const settled = h4.db.workflowDecisionByOccurrence(occId)!;
    assert.equal(settled.issueClosureResult?.outcome, "closed");
    assert.equal(settled.issueClosureResult?.reconciliation?.verified, true);
  } finally {
    h4.db.close();
  }
});
