import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, OWNER_QUESTION_ANSWER_ID, OWNER_QUESTION_NOTE_ID,
  PROTOCOL_VERSION, pendingRequests, presentOwnerQuestionRequest, sessionAttentionStatus,
  type ControlPlaneToRunner, type RunnerMetadata, type WorkflowDecisionView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService, auditDigest } from "./sessions.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";

/** Owner Questions (#4270): a Full Control root asks its owner a design or clarification question,
 * presented as an agent question, answered in the owner's own words, and never revoked by a scope,
 * boundary or policy change because it grants nothing. */
function harness(options: { runnerProtocol?: number; issueScope?: boolean } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, options.runnerProtocol ?? PROTOCOL_VERSION);
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
  const toRunner: ControlPlaneToRunner[] = [];
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  hub.sendToRunner = (_runner, message) => { toRunner.push(message); return true; };
  // The runner's campaign issue scope commands (#3915), answered the way a healthy runner does.
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type !== "campaign_issue_scope" || message.operation === "publication_inspect") {
      throw new Error(`unexpected runner command ${message.type}`);
    }
    return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo",
      ...(message.operation === "synchronize" ? { revision: message.scope.revision }
        : message.operation === "grant_issue_numbers" ? { issueNumbersGrant: "applied" as const }
        : { candidates: (message.issues ?? [100, 101]).map((number) =>
          ({ issue: { repository: "team/repo", number }, title: `Issue ${number}`, source: "sub_issue" as const })) }) };
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  // A fake Decision Model: `uncertain` for request texts a test lists, `discusses` otherwise.
  const uncertain = new Set<string>();
  svc.setDecisionRuntime(fakeScreenRuntime(db, (request) =>
    [...uncertain].some((text) => JSON.stringify(request).includes(text)) ? { verdict: "uncertain" } : { verdict: "discusses" }).runtime);
  const control = { mode: "full_control" as const, objective: "Implement #100",
    operations: ["implementation_question", "pr_merge", "question", "tool_approval", "policy_ask",
      ...(options.issueScope ? ["campaign_issue_scope" as const] : [])] as Array<"implementation_question" | "pr_merge" | "question" | "tool_approval" | "policy_ask" | "campaign_issue_scope">,
    delegatablePolicyIds: [],
    ...(options.issueScope ? { issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 5, closureReasons: ["completed" as const] } } : {}) };
  const enabled = svc.setCampaignControl("root", control, 1, principal);
  assert.ok(enabled.ok, enabled.error ?? "Full Control enabled");
  const owner = { kind: "human" as const, id: principal.userId };
  const material = "Both designs pass CI. See [the design note](https://example.com/design) and PR https://github.com/team/repo/pull/7.";
  const askQuestion = (requestId = "credential-design", withOptions = true) => svc.createOwnerDecision("root", { requestId, resourceKey: requestId,
    kind: "question", question: "Which credential design should the provider bridge use?", material,
    options: withOptions ? [{ optionId: "lease", label: "Short-Lived Lease" }, { optionId: "broker", label: "Broker Process", description: "Adds a helper" }] : [],
    ...(withOptions ? { recommendedOptionId: "lease" } : {}) });
  const askApproval = (requestId = "risk-consent") => svc.createOwnerDecision("root", { requestId, resourceKey: requestId,
    question: "May the campaign merge #7 with the acknowledged risk?",
    options: [{ optionId: "merge", label: "Merge" }, { optionId: "hold", label: "Hold" }] });
  const card = (decision: WorkflowDecisionView) =>
    pendingRequests(db.getSession("root")!.pendingApproval).find((request) => request.occurrenceId === decision.occurrenceId);
  /** Prompts sent to a session, directly or through the durable prompt outbox. */
  const prompts = (sessionId: string) => [
    ...toRunner.flatMap((message) => message.type === "prompt_session" && message.sessionId === sessionId ? [message.text] : []),
    ...(db.raw().prepare("SELECT payload_json FROM session_prompt_commands WHERE session_id=?").all(sessionId) as Array<{ payload_json: string }>)
      .map((row) => (JSON.parse(row.payload_json) as { text: string }).text),
  ];
  const answer = (decision: WorkflowDecisionView, answers: Record<string, string>, actor: { kind: "human" | "agent"; id: string } = owner) =>
    svc.answerQuestion("root", decision.occurrenceId, answers, actor, "submit", undefined, decision.occurrenceId);
  return { db, svc, principal, owner, control, material, askQuestion, askApproval, card, prompts, answer, toRunner, uncertain };
}

test("the owner's Decline of an Owner Question the screen could not settle dismisses it and tells the root (#4270 review)", async () => {
  const h = harness();
  try {
    h.uncertain.add("Which credential design should the provider bridge use?");
    const asked = await h.askQuestion();
    assert.ok(asked.ok && asked.data, asked.error ?? "created");
    assert.equal(asked.data.authorityEvaluation?.reason, "credential_screen_review");
    assert.equal(presentOwnerQuestionRequest(h.card(asked.data)!).kind, "workflow_decision", "it is classified on its own card first");
    assert.equal(h.answer(asked.data, { [OWNER_QUESTION_ANSWER_ID]: "Broker Process" }).status, 409, "nobody answers it before it is classified");
    const screen = h.db.raw().prepare("SELECT occurrence_id FROM decision_occurrences").all() as Array<{ occurrence_id: string }>;
    const screenId = screen.map((row) => row.occurrence_id).find((id) => h.db.campaignDecisionSubject(id)?.requestId === "credential-design")!;
    const declined = h.svc.classifyCampaignDecision("root", screenId, { classification: "decline" }, h.owner);
    assert.ok(declined.ok, declined.error ?? "declined");
    const resolved = h.db.workflowDecisionByOccurrence(asked.data.occurrenceId)!;
    assert.equal(resolved.status, "denied");
    assert.equal(h.card(asked.data), undefined, "its card leaves the root");
    const prompt = h.prompts("root").find((text) => text.includes(asked.data!.occurrenceId))!;
    assert.match(prompt, /dismissed your owner question/u);
    assert.match(prompt, /classified it as a request for credentials/u);
  } finally { h.db.close(); }
});

test("an Owner Question's options must read as distinct labels, its Recommended mark included (#4270 review)", async () => {
  const h = harness();
  try {
    const duplicate = await h.svc.createOwnerDecision("root", { requestId: "d", resourceKey: "d", kind: "question", question: "Which one?",
      options: [{ optionId: "a", label: "Same" }, { optionId: "b", label: "Same" }] });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error!, /distinct labels/u);
    const collision = await h.svc.createOwnerDecision("root", { requestId: "c", resourceKey: "c", kind: "question", question: "Which one?",
      recommendedOptionId: "a", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "A (Recommended)" }] });
    assert.equal(collision.ok, false, "a recommended label cannot collide with another option's label");
    // Distinct labels resolve to their own option, the second included.
    const distinct = await h.svc.createOwnerDecision("root", { requestId: "ok", resourceKey: "ok", kind: "question", question: "Which one?",
      recommendedOptionId: "a", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] });
    assert.ok(distinct.ok && distinct.data);
    assert.ok(h.answer(distinct.data, { [OWNER_QUESTION_ANSWER_ID]: "B" }).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(distinct.data.occurrenceId)!.selectedOptionId, "b");
  } finally { h.db.close(); }
});

test("an Owner Question is presented as an agent question with Markdown background, Recommended, Other and a note (#4270)", async () => {
  const h = harness();
  try {
    const asked = await h.askQuestion();
    assert.ok(asked.ok && asked.data, asked.error ?? "created");
    const decision = asked.data;
    assert.deepEqual([decision.category, decision.authority, decision.authorityEvaluation?.reason], ["owner_decision", "human", "owner_kept"]);
    assert.equal(decision.resourceSnapshot.category === "owner_decision" && decision.resourceSnapshot.kind, "question");
    const stored = h.card(decision)!;
    assert.equal(stored.kind, "workflow_decision", "the server keeps it a typed decision");
    assert.equal(stored.async, true, "the root keeps working while it waits");
    assert.equal(stored.title, "Owner Question");
    const presented = presentOwnerQuestionRequest(stored);
    assert.equal(presented.kind, "question");
    assert.equal(presented.occurrenceId, decision.occurrenceId);
    const [question, note] = presented.questions!;
    assert.equal(question!.question, "Which credential design should the provider bridge use?");
    assert.equal(question!.context, h.material, "the background is the question's Markdown context, links intact");
    assert.deepEqual(question!.options.map((option) => option.label), ["Short-Lived Lease (Recommended)", "Broker Process"]);
    assert.equal(question!.allowOther, true);
    assert.deepEqual([note!.id, note!.required, note!.options.length], [OWNER_QUESTION_NOTE_ID, false, 0]);
    // Its badge asks for input, not an approval.
    const status = sessionAttentionStatus({ status: "running", pendingApproval: stored });
    assert.deepEqual([status?.kind, status?.label], ["input_required", "Needs Your Input"]);
    // Campaign Status still lists it as waiting on the owner.
    assert.deepEqual(h.db.campaignProjection("root")!.ownerDecisions?.items.map((item) => [item.occurrenceId, item.summary]),
      [[decision.occurrenceId, "Which credential design should the provider bridge use?"]]);
    // An Owner Approval keeps its approval form.
    const approval = await h.askApproval();
    assert.ok(approval.ok && approval.data);
    const approvalCard = h.card(approval.data)!;
    assert.equal(approvalCard.title, "Owner Decision Required");
    assert.equal(presentOwnerQuestionRequest(approvalCard), approvalCard);
    assert.equal(sessionAttentionStatus({ status: "running", pendingApproval: approvalCard })?.label, "Approval Required");
  } finally { h.db.close(); }
});

test("the owner's free-text answer reaches the root as a prompt, exactly as typed (#4270)", async () => {
  const h = harness();
  try {
    const asked = await h.askQuestion();
    assert.ok(asked.ok && asked.data);
    const words = "Neither as proposed: use the lease, but cap it at 15 minutes and log every rotation.\nAsk me again before the broker.";
    const answered = h.answer(asked.data, { [OWNER_QUESTION_ANSWER_ID]: words });
    assert.ok(answered.ok, answered.error ?? "answered");
    const resolved = h.db.workflowDecisionByOccurrence(asked.data.occurrenceId)!;
    assert.deepEqual([resolved.status, resolved.selectedOptionId, resolved.childMessage], ["approved", undefined, words]);
    assert.equal(h.card(asked.data), undefined, "the card leaves the root");
    const prompt = h.prompts("root").find((text) => text.includes(asked.data!.occurrenceId));
    assert.ok(prompt, "the answer reaches the root");
    assert.ok(prompt!.includes(`Their answer, in their own words:\n${words}\n`), prompt);
    assert.match(prompt!, /It grants no authority/u);
    assert.ok(!h.toRunner.some((message) => message.type === "answer_question"), "no runner is asked to answer it");
  } finally { h.db.close(); }
});

test("an option plus a note delivers both, and a question with no options takes free text (#4270)", async () => {
  const h = harness();
  try {
    const asked = await h.askQuestion();
    assert.ok(asked.ok && asked.data);
    const note = "But also keep the broker design in the follow-up notes.";
    assert.ok(h.answer(asked.data, { [OWNER_QUESTION_ANSWER_ID]: "Short-Lived Lease (Recommended)", [OWNER_QUESTION_NOTE_ID]: note }).ok);
    const resolved = h.db.workflowDecisionByOccurrence(asked.data.occurrenceId)!;
    assert.deepEqual([resolved.selectedOptionId, resolved.childMessage], ["lease", note]);
    const prompt = h.prompts("root").find((text) => text.includes(asked.data!.occurrenceId))!;
    assert.ok(prompt.includes('They chose option "lease": "Short-Lived Lease".'), prompt);
    assert.ok(prompt.includes(`They added, in their own words:\n${note}\n`), prompt);

    const open = await h.askQuestion("naming", false);
    assert.ok(open.ok && open.data, open.error ?? "a question may suggest no options");
    assert.deepEqual(presentOwnerQuestionRequest(h.card(open.data)!).questions!.map((question) => question.id), [OWNER_QUESTION_ANSWER_ID]);
    assert.equal(h.answer(open.data, {}).status, 400, "an empty answer is refused");
    assert.equal(h.answer(open.data, { [OWNER_QUESTION_ANSWER_ID]: "   " }).status, 400);
    assert.ok(h.answer(open.data, { [OWNER_QUESTION_ANSWER_ID]: "Call it the provider bridge." }).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(open.data.occurrenceId)!.childMessage, "Call it the provider bridge.");
  } finally { h.db.close(); }
});

test("only the campaign's owner answers an Owner Question, and a refused attempt leaves it pending (#4270)", async () => {
  const h = harness();
  try {
    const asked = await h.askQuestion();
    assert.ok(asked.ok && asked.data);
    const decision = asked.data;
    const words = { [OWNER_QUESTION_ANSWER_ID]: "Broker Process" };
    assert.equal(h.answer(decision, words, { kind: "agent", id: "root" }).status, 403, "the root cannot answer itself");
    assert.equal(h.answer(decision, words, { kind: "agent", id: "child" }).status, 403, "a child cannot answer");
    assert.equal(h.answer(decision, words, { kind: "human", id: "someone-else" }).status, 403, "another person cannot answer");
    assert.equal(h.svc.resolveDescendantRequest("root", "root", decision.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "broker" }, () => true).ok, false);
    assert.equal(h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve", selectedOptionId: "broker" },
      "orchestrator", { kind: "agent", id: "root" }, () => true).status, 403);
    assert.equal(h.svc.resolveDescendantRequest("child", "root", decision.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true).ok, false, "a child is never its controller");
    assert.equal(h.svc.approve("root", decision.occurrenceId, "broker", { kind: "agent", id: "root" }).status, 403);
    assert.equal(h.svc.approve("root", decision.occurrenceId, "broker", { kind: "human", id: "someone-else" }).status, 403);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "pending");
    assert.ok(h.card(decision), "its card still waits for the owner");
    // An older client answers from the options card: the chosen option is the answer.
    assert.ok(h.svc.approve("root", decision.occurrenceId, "broker", h.owner).ok);
    const resolved = h.db.workflowDecisionByOccurrence(decision.occurrenceId)!;
    assert.deepEqual([resolved.status, resolved.selectedOptionId], ["approved", "broker"]);
  } finally { h.db.close(); }
});

test("the owner may dismiss an Owner Question unanswered (#4270)", async () => {
  const h = harness();
  try {
    const asked = await h.askQuestion();
    assert.ok(asked.ok && asked.data);
    assert.ok(h.svc.answerQuestion("root", asked.data.occurrenceId, {}, h.owner, "dismiss", undefined, asked.data.occurrenceId).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(asked.data.occurrenceId)!.status, "denied");
    const prompt = h.prompts("root").find((text) => text.includes(asked.data!.occurrenceId))!;
    assert.match(prompt, /dismissed your owner question .* without answering it/u);
  } finally { h.db.close(); }
});

test("a scope or policy change leaves an Owner Question pending and answerable but revokes an Owner Approval (#4270)", async () => {
  const h = harness();
  try {
    const question = await h.askQuestion();
    const approval = await h.askApproval();
    assert.ok(question.ok && question.data && approval.ok && approval.data);
    // The owner re-authorizes Full Control with a new objective: a boundary and policy change.
    const revision = () => h.db.getSession("root")!.parentControlPolicy!.revision;
    const before = revision();
    const changed = h.svc.setCampaignControl("root", { ...h.control, objective: "Implement #100 carefully" }, before, h.principal);
    assert.ok(changed.ok, changed.error ?? "re-authorized");
    assert.ok(revision() > before, "the policy revision moved");
    assert.equal(h.db.workflowDecisionByOccurrence(approval.data.occurrenceId)!.status, "revoked", "the approval is revoked as today");
    assert.equal(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.status, "pending");
    assert.ok(h.card(question.data), "its card still waits on the root");
    assert.deepEqual(h.db.campaignProjection("root")!.ownerDecisions?.items.map((item) => item.occurrenceId), [question.data.occurrenceId]);
    const waiting = h.svc.descendantRequests("root", () => true, "human");
    assert.deepEqual(waiting.data?.requests.map((request) => request.occurrenceId), [question.data.occurrenceId],
      "it stays among the owner's Waiting for You requests");
    // A refused agent attempt after the change does not revoke it either.
    assert.equal(h.svc.resolveWorkflowDecision("root", "root", question.data.occurrenceId, { outcome: "approve", selectedOptionId: "lease" },
      "orchestrator", { kind: "agent", id: "root" }, () => true).status, 403);
    assert.equal(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.status, "pending");
    assert.ok(h.answer(question.data, { [OWNER_QUESTION_ANSWER_ID]: "Short-Lived Lease (Recommended)" }).ok, "the owner still answers it");
    assert.equal(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.selectedOptionId, "lease");
  } finally { h.db.close(); }
});

test("a root withdraws its Owner Question, and a newer one under the same key replaces it (#4270)", async () => {
  const h = harness();
  try {
    const first = await h.askQuestion("design");
    assert.ok(first.ok && first.data);
    const second = await h.svc.createOwnerDecision("root", { requestId: "design-2", resourceKey: "design", kind: "question",
      question: "Which credential design, now that the broker is ruled out?", options: [] });
    assert.ok(second.ok && second.data, second.error ?? "replaced");
    assert.notEqual(h.db.workflowDecisionByOccurrence(first.data.occurrenceId)!.status, "pending", "the older question is replaced");
    assert.ok(h.svc.withdrawWorkflowDecision("root", second.data.occurrenceId, { reason: "Decided by the design doc" }).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(second.data.occurrenceId)!.status, "revoked");
  } finally { h.db.close(); }
});

test("Owner Questions need a current root runner, and an approval keeps 2 to 12 options (#4270)", async () => {
  const older = harness({ runnerProtocol: 302 });
  try {
    const refused = await older.askQuestion();
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /owner questions/u);
    assert.ok((await older.askApproval()).ok, "an older root keeps the approval form");
  } finally { older.db.close(); }
  const h = harness();
  try {
    assert.equal((await h.svc.createOwnerDecision("root", { requestId: "x", resourceKey: "x", question: "Q?", options: [] })).ok, false,
      "an approval needs options");
    assert.equal((await h.svc.createOwnerDecision("root", { requestId: "y", resourceKey: "y", question: "Q?", options: [],
      kind: "other" as never })).status, 400);
  } finally { h.db.close(); }
});

test("an Owner Question suggests 0 to 12 options and refuses a 13th; an approval refuses a 13th too (#4270)", async () => {
  const h = harness();
  try {
    const options = (count: number) => Array.from({ length: count }, (_, index) => ({ optionId: `o${index + 1}`, label: `Option ${index + 1}` }));
    const ask = (requestId: string, count: number, kind?: "question") => h.svc.createOwnerDecision("root", { requestId, resourceKey: requestId,
      question: "Which one?", options: options(count), ...(kind ? { kind } : {}) });
    const none = await ask("none", 0, "question");
    assert.ok(none.ok && none.data, none.error ?? "no options");
    assert.deepEqual(presentOwnerQuestionRequest(h.card(none.data)!).questions!.map((question) => [question.id, question.options.length]),
      [[OWNER_QUESTION_ANSWER_ID, 0]], "only the free-text answer, with no note");
    const twelve = await ask("twelve", 12, "question");
    assert.ok(twelve.ok && twelve.data, twelve.error ?? "twelve options");
    assert.equal(presentOwnerQuestionRequest(h.card(twelve.data)!).questions![0]!.options.length, 12);
    for (const [requestId, kind] of [["thirteen-question", "question"], ["thirteen-approval", undefined]] as const) {
      const refused = await ask(requestId, 13, kind);
      assert.equal(refused.ok, false, `${requestId} is refused`);
      assert.match(refused.error!, /to 12 options/u);
      assert.ok(!pendingRequests(h.db.getSession("root")!.pendingApproval).some((request) => request.requestId === requestId), "no card is shown");
    }
    assert.ok((await ask("twelve-approval", 12)).ok, "an approval still takes 12");
  } finally { h.db.close(); }
});

test("the audit records an Owner Question's answer and its dismissal by the owner, without the owner's words (#4270)", async () => {
  const h = harness();
  try {
    const entries = (occurrenceId: string) => h.svc.governanceAudit("root").filter((entry) => entry.requestId === occurrenceId);
    const answered = await h.askQuestion("answered");
    assert.ok(answered.ok && answered.data);
    const asked = entries(answered.data.occurrenceId);
    assert.deepEqual(asked.map((entry) => [entry.stage, entry.outcome]), [["request", "pending"]], "asking it is recorded");
    const note = "Cap the lease at 15 minutes.";
    assert.ok(h.answer(answered.data, { [OWNER_QUESTION_ANSWER_ID]: "Short-Lived Lease (Recommended)", [OWNER_QUESTION_NOTE_ID]: note }).ok);
    const answer = entries(answered.data.occurrenceId).find((entry) => entry.stage === "resolution");
    assert.ok(answer, "the answer is recorded");
    assert.equal(answer.outcome, "answered");
    assert.deepEqual(answer.actor, h.owner, "it names the owner who answered");
    assert.equal(answer.optionId, "lease");
    assert.equal(answer.approvalKind, "workflow_decision");
    assert.deepEqual([answer.workflowDecision?.occurrenceId, answer.workflowDecision?.category, answer.workflowDecision?.parentSessionId,
      answer.workflowDecision?.childSessionId, answer.workflowDecision?.resourceDigest],
    [answered.data.occurrenceId, "owner_decision", "root", "root", answered.data.resourceDigest]);
    assert.equal(answer.workflowDecision?.childMessageDigest, auditDigest(note), "the owner's words are bound by digest");
    assert.ok(!JSON.stringify(entries(answered.data.occurrenceId)).includes(note), "the audit never stores the owner's words");

    const dismissed = await h.askQuestion("dismissed");
    assert.ok(dismissed.ok && dismissed.data);
    assert.ok(h.svc.answerQuestion("root", dismissed.data.occurrenceId, {}, h.owner, "dismiss", undefined, dismissed.data.occurrenceId).ok);
    const dismissal = entries(dismissed.data.occurrenceId).find((entry) => entry.stage === "resolution");
    assert.ok(dismissal, "the dismissal is recorded");
    assert.equal(dismissal.outcome, "denied");
    assert.deepEqual(dismissal.actor, h.owner);
    assert.equal(dismissal.optionId, undefined);
    assert.deepEqual([dismissal.workflowDecision?.occurrenceId, dismissal.workflowDecision?.category],
      [dismissed.data.occurrenceId, "owner_decision"]);
    assert.equal(dismissal.workflowDecision?.childMessageDigest, undefined, "a dismissal carries no words");

    // A refused attempt by an agent leaves no resolution in the audit.
    const refused = await h.askQuestion("refused");
    assert.ok(refused.ok && refused.data);
    assert.equal(h.answer(refused.data, { [OWNER_QUESTION_ANSWER_ID]: "Broker Process" }, { kind: "agent", id: "root" }).status, 403);
    assert.deepEqual(entries(refused.data.occurrenceId).map((entry) => entry.outcome), ["pending"]);
  } finally { h.db.close(); }
});

test("an approved issue-scope change revokes a pending Owner Approval but leaves an Owner Question pending and answerable (#4270)", async () => {
  for (const route of ["orchestrator", "owner"] as const) {
    const h = harness({ issueScope: true });
    try {
      const question = await h.askQuestion();
      const approval = await h.askApproval();
      assert.ok(question.ok && question.data && approval.ok && approval.data);
      const revision = () => h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision;
      const before = revision();
      // An epic member the Orchestrator may admit itself, or additions without lineage only the owner may approve (#4267).
      const proposed = await h.svc.proposeCampaignIssueScope("root", { requestId: `scope-${route}`, expectedRevision: 1,
        additions: [{ repository: "team/repo", number: 101 }], removals: [], explanation: "Verified intended member",
        ...(route === "orchestrator" ? { lineage: { kind: "epic" as const, epic: 100 } } : {}) });
      assert.ok(proposed.ok && proposed.data, proposed.error ?? "proposed");
      assert.equal(proposed.data.authority, route === "orchestrator" ? "orchestrator" : "human");
      const snapshot = proposed.data.resourceSnapshot;
      assert.ok(snapshot.category === "campaign_issue_scope");
      assert.deepEqual(snapshot.affectedDecisions, [approval.data.occurrenceId], "the request lists the approval it revokes, never the question");
      const resolved = h.svc.resolveWorkflowDecision("root", "root", proposed.data.occurrenceId, { outcome: "approve" }, proposed.data.authority,
        proposed.data.authority === "human" ? h.owner : { kind: "agent", id: "root" }, () => true);
      assert.ok(resolved.ok, resolved.error ?? "approved");
      assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101], "the scope changed");
      assert.ok(revision() > before, "the issue scope revision moved");
      assert.equal(h.db.workflowDecisionByOccurrence(approval.data.occurrenceId)!.status, "revoked", `${route}: the approval is revoked as today`);
      assert.equal(h.card(approval.data), undefined);
      assert.equal(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.status, "pending", `${route}: the question stays pending`);
      assert.ok(h.card(question.data), "its card still waits on the root");
      assert.deepEqual(h.db.campaignProjection("root")!.ownerDecisions?.items.map((item) => item.occurrenceId), [question.data.occurrenceId],
        "Campaign Status still lists it as Waiting for You");
      assert.ok(h.answer(question.data, { [OWNER_QUESTION_ANSWER_ID]: "Broker Process" }).ok, "the owner still answers it");
      assert.equal(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.selectedOptionId, "broker");
    } finally { h.db.close(); }
  }
});

test("a runner reconnect restores a pending Owner Question's card from an older policy revision, but not a revoked Owner Approval's (#4270)", async () => {
  const h = harness();
  try {
    const question = await h.askQuestion();
    const approval = await h.askApproval();
    assert.ok(question.ok && question.data && approval.ok && approval.data);
    const revision = () => h.db.getSession("root")!.parentControlPolicy!.revision;
    assert.ok(h.svc.setCampaignControl("root", { ...h.control, objective: "Implement #100 carefully" }, revision(), h.principal).ok);
    assert.notEqual(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.policyRevision, revision(),
      "the question was asked under the previous policy revision");
    assert.equal(h.db.workflowDecisionByOccurrence(approval.data.occurrenceId)!.status, "revoked");
    // An Owner Approval asked under the current revision is restored too, as every current decision is.
    const current = await h.askApproval("current-approval");
    assert.ok(current.ok && current.data);

    h.svc.failRunnerSessions("r");
    assert.equal(h.db.getSession("root")!.pendingApproval, null, "a provisional disconnect clears the projected cards");
    h.svc.reconcileRunnerSessions("r", ["root", "child"]);
    const restored = pendingRequests(h.db.getSession("root")!.pendingApproval).map((request) => request.occurrenceId).sort();
    assert.deepEqual(restored, [question.data.occurrenceId, current.data.occurrenceId].sort(),
      "the question and the current approval come back; the revoked approval does not");
    assert.equal(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.status, "pending", "restoring never revokes the question");
    assert.equal(h.card(question.data)!.async, true, "the restored question does not park the root");
    assert.equal(presentOwnerQuestionRequest(h.card(question.data)!).kind, "question", "it is still presented as a question");
    assert.ok(h.answer(question.data, { [OWNER_QUESTION_ANSWER_ID]: "Use the lease." }).ok, "the owner answers the restored question");
    assert.equal(h.db.workflowDecisionByOccurrence(question.data.occurrenceId)!.childMessage, "Use the lease.");
  } finally { h.db.close(); }
});
