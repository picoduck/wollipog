import assert from "node:assert/strict";
import test from "node:test";
import { addPendingRequest, pendingRequests, removePendingRequest, sessionAttentionStatus, type PendingApproval } from "./index.js";

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
