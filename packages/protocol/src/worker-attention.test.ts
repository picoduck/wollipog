import assert from "node:assert/strict";
import test from "node:test";
import {
  addPendingRequest,
  attentionRequestRank,
  pendingRequests,
  prioritizedPendingRequests,
  removePendingRequest,
  sessionAttentionBreakdown,
  sessionAttentionStatus,
  type PendingApproval,
} from "./index.js";

const ask = (requestId: string, ownerToolUseId?: string): PendingApproval => ({
  requestId, title: "Approve Command", options: [{ optionId: "deny", name: "Reject" }],
  ...(ownerToolUseId ? { ownerToolUseId } : {}),
});

test("concurrent nested worker requests retain independent identities and survive JSON persistence", () => {
  let pending: PendingApproval | null = addPendingRequest(null, ask("parent"));
  pending = addPendingRequest(pending, ask("child-a", "agent-a"));
  pending = addPendingRequest(pending, { ...ask("child-b", "agent-b"), kind: "question", questions: [] });
  pending = JSON.parse(JSON.stringify(pending));
  assert.deepEqual(pendingRequests(pending).map((request) => request.requestId), ["parent", "child-a", "child-b"]);
  pending = removePendingRequest(pending, "child-a");
  assert.deepEqual(pendingRequests(pending).map((request) => request.requestId), ["parent", "child-b"]);
  pending = removePendingRequest(pending, "parent");
  assert.equal(pending?.requestId, "child-b");
  assert.equal(pending?.additionalRequests, undefined);
  assert.equal(sessionAttentionStatus({ status: "running", pendingApproval: pending })?.label, "Child Answer Required");
  assert.equal(removePendingRequest(pending, "child-b"), null);
});

test("legacy replacement and stale child resolutions do not erase a newer request", () => {
  const pending = addPendingRequest(ask("old"), ask("new"));
  assert.deepEqual(pendingRequests(pending).map((request) => request.requestId), ["new"]);
  assert.deepEqual(removePendingRequest(pending, "old"), pending);
});

test("root replacement preserves children but not obsolete roots or policy cards", () => {
  const mixed = addPendingRequest(ask("root-old"), ask("child", "owner"));
  const replaced = addPendingRequest(mixed, ask("root-new"));
  assert.deepEqual(pendingRequests(replaced).map((request) => request.requestId), ["child", "root-new"]);
  const guarded = addPendingRequest({ ...ask("policy"), kind: "cost_budget" }, ask("child", "owner"));
  assert.equal(guarded.requestId, "child");
  assert.equal(guarded.additionalRequests, undefined);
  const attention = sessionAttentionStatus({ status: "running", pendingApproval: replaced })!;
  assert.equal(attention.label, "2 Actions Required");
  assert.match(attention.description, /2 approvals, 0 questions, 0 authentication requests; 1 belong/);
});

test("the action list rejects recursive expansion and duplicate identities", () => {
  const first = ask("a", "child");
  first.additionalRequests = [first, { ...ask("b"), additionalRequests: [ask("hidden")] }];
  assert.deepEqual(pendingRequests(first).map((request) => request.requestId), ["a", "b"]);
  assert.ok(pendingRequests(first).every((request) => !request.additionalRequests));
});

test("requests order by how much of the session they block, then by arrival", () => {
  const permission = ask("permission-late");
  const question: PendingApproval = { ...ask("question"), kind: "question", questions: [] };
  const recovery: PendingApproval = { ...question, requestId: "recovery", recoveryReason: "provider_restart" };
  const auth: PendingApproval = { ...ask("auth"), kind: "authentication" };
  const budget: PendingApproval = { ...ask("budget"), kind: "cost_budget" };
  const early = ask("permission-early");
  assert.deepEqual([recovery, auth, budget, question, permission].map(attentionRequestRank), [0, 1, 2, 3, 4]);
  const pending: PendingApproval = { ...early, additionalRequests: [permission, question, budget, auth, recovery] };
  assert.deepEqual(prioritizedPendingRequests(pending).map((request) => request.requestId),
    ["recovery", "auth", "budget", "question", "permission-early", "permission-late"]);
  assert.deepEqual(prioritizedPendingRequests(null), []);
});

test("the attention breakdown groups requests by kind in priority order and names each owner", () => {
  const pending: PendingApproval = { ...ask("root"), additionalRequests: [
    { ...ask("child-a", "agent-a") },
    { ...ask("child-q", "agent-q"), kind: "question", questions: [] },
    { ...ask("orphan", "agent-gone") },
  ] };
  const groups = sessionAttentionBreakdown({ status: "input_required", pendingApproval: pending,
    attentionOwners: [
      { requestId: "child-a", toolCallId: "agent-a", resolved: true, name: "Audit", role: "reviewer" },
      { requestId: "child-q", toolCallId: "agent-q", resolved: true, name: "Planner" },
      { requestId: "orphan", toolCallId: "agent-gone", resolved: false },
    ] });
  assert.deepEqual(groups.map((group) => [group.kind, group.label, group.count, group.owners]), [
    ["answer_required", "Answer Required", 1, ["Planner"]],
    ["approval_required", "Approval Required", 3, ["Main Agent", "Audit · Reviewer", "Child Owner Unavailable"]],
  ]);
  assert.deepEqual(groups[1]!.requests.map((request) => request.requestId), ["root", "child-a", "orphan"]);
  const single = sessionAttentionBreakdown({ status: "input_required", pendingApproval: ask("only") });
  assert.deepEqual(single.map((group) => [group.label, group.count]), [["Approval Required", 1]]);
  assert.deepEqual(sessionAttentionBreakdown({ status: "running", pendingApproval: null }), []);
  const legacy = sessionAttentionBreakdown({ status: "input_required", pendingApproval: null });
  assert.deepEqual(legacy.map((group) => [group.label, group.count]), [["Input Required", 0]]);
});
