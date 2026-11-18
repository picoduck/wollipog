import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantOwnerConfirmation, AssistantThread } from "@wollipog/protocol";
import {
  assistantConfirmationOutcome,
  assistantThreadPendingKey,
  pendingAssistantConfirmations,
  pendingAssistantConfirmationsByThread,
} from "./assistant-confirmations.js";

const request = (id: string, createdAt: number, overrides: Partial<AssistantOwnerConfirmation> = {}): AssistantOwnerConfirmation => ({
  id, threadId: "thr_1", operation: "session_archive", title: "Archive Session", summary: "Archives it.", target: { kind: "session", id: "s", label: "S" },
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

test("pending confirmations group by thread: oldest request's thread first, with its count and earliest expiry", () => {
  const groups = pendingAssistantConfirmationsByThread([
    thread("a", [request("aoc_a2", 30, { expiresAt: 9_000 }), request("aoc_a1", 20, { expiresAt: 7_000 }), request("aoc_a_done", 1, { status: "denied" })]),
    thread("b", [request("aoc_b1", 10, { expiresAt: 8_000 }), request("aoc_b_expired", 5, { expiresAt: 100 })]),
    thread("c", []),
    thread("d", [request("aoc_d1", 1)], "archived"),
  ], 500);
  assert.deepEqual(groups.map((group) => ({
    threadId: group.threadId, threadTitle: group.threadTitle, ids: group.confirmations.map((item) => item.id), expiresAt: group.expiresAt,
  })), [
    { threadId: "b", threadTitle: "Thread b", ids: ["aoc_b1"], expiresAt: 8_000 },
    { threadId: "a", threadTitle: "Thread a", ids: ["aoc_a1", "aoc_a2"], expiresAt: 7_000 },
  ]);
  assert.deepEqual(pendingAssistantConfirmationsByThread([thread("a", [request("aoc_1", 1, { expiresAt: 100 })])], 500), []);
});

test("a thread's pending key changes only with its pending requests", () => {
  const key = assistantThreadPendingKey;
  assert.equal(key(thread("a", [request("aoc_2", 1), request("aoc_1", 2)])), key(thread("a", [request("aoc_1", 2), request("aoc_2", 1)])));
  assert.notEqual(key(thread("a", [request("aoc_1", 1)])), key(thread("a", [])));
  assert.equal(key(thread("a", [request("aoc_1", 1)], "archived")), "");
  assert.equal(key(thread("a", [request("aoc_1", 1, { status: "denied" })])), "");
});

test("each outcome reads as what happened", () => {
  assert.deepEqual(assistantConfirmationOutcome(request("x", 0, { status: "executed", outcome: { receiptStatus: "succeeded" } })),
    { tone: "success", message: "Archive Session ran once." });
  assert.match(assistantConfirmationOutcome(request("x", 0, { status: "executed", outcome: { receiptStatus: "uncertain" } })).message, /uncertain/);
  assert.match(assistantConfirmationOutcome(request("x", 0, { status: "refused", outcome: { reason: "It changed." } })).message, /did not run: It changed\./);
  assert.match(assistantConfirmationOutcome(request("x", 0, { status: "denied" })).message, /Nothing ran/);
});
