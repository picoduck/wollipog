import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingApproval } from "@wollipog/protocol";
import { attentionAskers, attentionBadge, attentionSentence, attentionTitle, offlineAttentionSentence } from "./worker-attention.js";

const permission = (requestId: string, ownerToolUseId?: string, extra: Partial<PendingApproval> = {}): PendingApproval =>
  ({ requestId, ...(ownerToolUseId ? { ownerToolUseId } : {}), title: "Bash: ls", options: [], ...extra }) as PendingApproval;
const question = (requestId: string, ownerToolUseId?: string): PendingApproval =>
  ({ requestId, ...(ownerToolUseId ? { ownerToolUseId } : {}), kind: "question", title: "Which?", options: [],
    questions: [{ id: "q", question: "Which?", options: [{ label: "A" }] }] }) as unknown as PendingApproval;
const signIn = (requestId: string, ownerToolUseId?: string): PendingApproval =>
  ({ requestId, ...(ownerToolUseId ? { ownerToolUseId } : {}), kind: "authentication", title: "Sign in", options: [] }) as unknown as PendingApproval;
const pending = (...requests: PendingApproval[]): PendingApproval =>
  ({ ...requests[0]!, ...(requests.length > 1 ? { additionalRequests: requests.slice(1) } : {}) });
const names: Record<string, string> = { audit: "Audit Storage", parser: "Inspect Parser" };
const askers = (...requests: PendingApproval[]) => attentionAskers(pending(...requests), (id) => names[id]);

test("askers are one per worker with its most urgent request, the session counting once for its own (#2861)", () => {
  const result = askers(permission("a1", "audit"), question("a2", "audit"), permission("own"), question("own-ask"),
    permission("restored", "gone", { recoveryReason: "provider_restart" } as Partial<PendingApproval>));
  assert.deepEqual(result.map((asker) => [asker.ownerId, asker.kind, asker.request?.requestId]), [
    // A question outranks a permission on the request dock, and a restored request is the session's.
    ["audit", "answer_required", "a2"],
    [null, "answer_required", "own-ask"],
  ]);
});

test("the sentence names one asker and counts several by kind, most first (#2861)", () => {
  assert.equal(attentionSentence(askers(permission("a", "audit"))), "Audit Storage is waiting for your approval.");
  assert.equal(attentionSentence(askers(question("a", "audit"))), "Audit Storage has a question for you.");
  assert.equal(attentionSentence(askers(signIn("p", "parser"))), "Inspect Parser needs you to sign in.");
  assert.equal(attentionSentence(askers(question("own"))), "The session has a question for you.");
  assert.equal(attentionSentence(askers(permission("x", "unknown"))), "A subagent is waiting for your approval.");
  assert.equal(attentionSentence(askers(permission("a", "audit"), permission("p", "parser"))), "2 workers are waiting for your approval.");
  assert.equal(attentionSentence(askers(question("a", "audit"), question("p", "parser"))), "2 workers have a question for you.");
  assert.equal(attentionSentence(askers(permission("a", "audit"), permission("p", "parser"), question("d", "docs"))),
    "3 workers need you: 2 approvals, 1 answer.");
  assert.equal(attentionSentence(askers(permission("own"), permission("a", "audit"))), "The session and 1 worker are waiting for your approval.");
  assert.equal(attentionSentence(askers(signIn("own"), permission("a", "audit"), permission("p", "parser"))),
    "The session and 2 workers need you: 2 approvals, 1 sign-in.");
});

test("the +N More line is Title Case and names who needs you (#2861)", () => {
  assert.equal(attentionTitle(askers(permission("a", "audit"))), "Audit Storage Needs You");
  assert.equal(attentionTitle(askers(permission("own"))), "The Session Needs You");
  assert.equal(attentionTitle(askers(permission("a", "audit"), permission("p", "parser"))), "2 Workers Need You");
  assert.equal(attentionTitle(askers(permission("own"), permission("a", "audit"))), "The Session and 1 Worker Need You");
});

test("offline, the count stays with the reason nothing can be answered now (#2861)", () => {
  assert.equal(offlineAttentionSentence(1, "Build Box"), "1 request is waiting. You can answer it when Build Box reconnects.");
  assert.equal(offlineAttentionSentence(2, "Build Box"), "2 requests are waiting. You can answer them when Build Box reconnects.");
});

test("the badge keeps one kind's word, counts mixed kinds as Awaiting Input, and goes neutral and hollow offline (#2861)", () => {
  assert.equal(attentionBadge([]), null);
  const one = attentionBadge(["approval_required", "approval_required"])!;
  assert.deepEqual([one.label, one.meta.tone, one.description], ["2 Approval Required", "warning", "2 Approval Required"]);
  const mixed = attentionBadge(["answer_required", "approval_required", "approval_required"])!;
  assert.deepEqual([mixed.label, mixed.meta.tone, mixed.description],
    ["3 Awaiting Input", "warning", "2 Approval Required, 1 Answer Required"]);
  assert.equal(attentionBadge(["recovery_required", "approval_required"])!.meta.tone, "danger");
  const offline = attentionBadge(["answer_required", "approval_required"], false)!;
  assert.deepEqual([offline.label, offline.meta.tone, offline.meta.hollow], ["2 Awaiting Input", "neutral", true]);
});
