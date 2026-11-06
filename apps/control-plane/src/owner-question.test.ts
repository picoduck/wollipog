import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, OWNER_QUESTION_ANSWER_ID, OWNER_QUESTION_NOTE_ID,
  PROTOCOL_VERSION, pendingRequests, presentOwnerQuestionRequest, sessionAttentionStatus,
  type ControlPlaneToRunner, type RunnerMetadata, type WorkflowDecisionView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";

/** Owner Questions (#4270): a Full Control root asks its owner a design or clarification question,
 * presented as an agent question, answered in the owner's own words, and never revoked by a scope,
 * boundary or policy change because it grants nothing. */
function harness(options: { runnerProtocol?: number } = {}) {
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
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  svc.setDecisionRuntime(fakeScreenRuntime(db, () => ({ verdict: "discusses" })).runtime);
  const control = { mode: "full_control" as const, objective: "Implement #100",
    operations: ["implementation_question", "pr_merge", "question", "tool_approval", "policy_ask"] as Array<"implementation_question" | "pr_merge" | "question" | "tool_approval" | "policy_ask">,
    delegatablePolicyIds: [] };
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
  return { db, svc, principal, owner, control, material, askQuestion, askApproval, card, prompts, answer, toRunner };
}

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
