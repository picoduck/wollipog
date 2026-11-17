import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantOwnerConfirmation, AssistantThread } from "@wollipog/protocol";
import { assistantConfirmationOutcome, pendingAssistantConfirmations, withAssistantThread } from "./assistant-confirmations.js";

const request = (id: string, createdAt: number, overrides: Partial<AssistantOwnerConfirmation> = {}): AssistantOwnerConfirmation => ({
  id, threadId: "thr_1", operation: "session_archive", title: "Archive Session", target: { kind: "session", id: "s", label: "S" },
  impact: [], arguments: [], status: "pending", createdAt, expiresAt: 10_000, resolvedAt: null, ...overrides,
});
const thread = (id: string, confirmations: AssistantOwnerConfirmation[], status: AssistantThread["status"] = "needs_you"): AssistantThread => ({
  id, assistant: "wollipog", title: `Thread ${id}`, harness: "codex", sessionId: `s_${id}`, status, access: { level: "full_access", destructive: "ask" },
  connectionId: null, launchedSessionIds: [], confirmations, lastActivityAt: 0, createdAt: 0, archivedAt: null,
});

test("pending confirmations come from live threads, oldest first, without expired or answered ones", () => {
  const pending = pendingAssistantConfirmations([
    thread("a", [request("aoc_2", 20), request("aoc_expired", 1, { expiresAt: 100 })]),
    thread("b", [request("aoc_1", 10), request("aoc_done", 5, { status: "executed" })]),
    thread("c", [request("aoc_archived", 1)], "archived"),
  ], 500);
  assert.deepEqual(pending.map((item) => [item.confirmation.id, item.threadTitle]), [["aoc_1", "Thread b"], ["aoc_2", "Thread a"]]);
});

test("an announced thread replaces its earlier copy", () => {
  const before = new Map([["a", thread("a", [request("aoc_1", 1)])]]);
  const after = withAssistantThread(before, thread("a", [], "done"));
  assert.equal(after.get("a")?.confirmations?.length, 0);
  assert.equal(before.get("a")?.confirmations?.length, 1);
});

test("each outcome reads as what happened", () => {
  assert.deepEqual(assistantConfirmationOutcome(request("x", 0, { status: "executed", outcome: { receiptStatus: "succeeded" } })),
    { tone: "success", message: "Archive Session ran once." });
  assert.match(assistantConfirmationOutcome(request("x", 0, { status: "executed", outcome: { receiptStatus: "uncertain" } })).message, /uncertain/);
  assert.match(assistantConfirmationOutcome(request("x", 0, { status: "refused", outcome: { reason: "It changed." } })).message, /did not run: It changed\./);
  assert.match(assistantConfirmationOutcome(request("x", 0, { status: "denied" })).message, /Nothing ran/);
});
