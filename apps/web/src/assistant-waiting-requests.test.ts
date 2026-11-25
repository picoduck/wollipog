import assert from "node:assert/strict";
import test from "node:test";
import type { PendingApproval } from "@wollipog/protocol";
import { assistantInlineQuestion, assistantToolOptions, assistantWorkRequestKey } from "./assistant-waiting-requests.js";

const tool: PendingApproval = {
  kind: "permission", requestId: "one", occurrenceId: "first", title: "Install Dependencies",
  options: [
    { optionId: "allow", name: "Allow Once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
};

test("a dock request is identified by both the session and the occurrence", () => {
  assert.notEqual(assistantWorkRequestKey("other-session", tool), assistantWorkRequestKey("session", tool));
  assert.notEqual(assistantWorkRequestKey("session", { ...tool, occurrenceId: "second" }), assistantWorkRequestKey("session", tool));
  assert.notEqual(assistantWorkRequestKey("session", { ...tool, occurrenceId: undefined }), assistantWorkRequestKey("session", tool));
});

test("inline tool actions bind to the original once-only options", () => {
  assert.deepEqual(assistantToolOptions(tool), { approve: tool.options[0], deny: tool.options[1] });
  assert.equal(assistantToolOptions({ ...tool, options: [...tool.options, { ...tool.options[0]!, optionId: "other" }] }), undefined);
  assert.equal(assistantToolOptions({ ...tool, kind: "workflow_decision" }), undefined);
  assert.equal(assistantToolOptions({ ...tool, context: { providerPermissionExpansion: true } }), undefined);
});

test("the dock answers an ordinary choice question and leaves richer forms to the session", () => {
  const question = { id: "lockfile", question: "Which lockfile should I keep?", options: [{ label: "Workspace" }] };
  const request: PendingApproval = { ...tool, kind: "question", options: [], questions: [question] };
  assert.equal(assistantInlineQuestion(request), question);
  assert.equal(assistantInlineQuestion({ ...request, questions: [question, { ...question, id: "other" }] }), undefined);
  assert.equal(assistantInlineQuestion({ ...request, questions: [{ ...question, multiSelect: true }] }), undefined);
  assert.equal(assistantInlineQuestion({ ...request, questions: [{ ...question, secret: true }] }), undefined);
  assert.equal(assistantInlineQuestion({ ...request, recoveryReason: "provider_restart" }), undefined);
});
