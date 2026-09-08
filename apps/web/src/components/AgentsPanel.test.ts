import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentDescriptor } from "../subagents.js";
import type { ChildSessionRegistryEntry } from "@wollipog/protocol";
import { mergeCompactAttentionOwners, mergeDurableAgents, mergeRegistrySnapshotPages } from "./AgentsPanel.js";

const child = (id: string, lifecycle: SubagentDescriptor["lifecycle"], sourceIndex: number): SubagentDescriptor => ({
  id,
  childIds: [],
  title: id,
  depth: 0,
  sourceIndex,
  lifecycle,
  toolStatus: lifecycle,
  availability: "recorded",
  startedAt: sourceIndex,
  lastActivityAt: sourceIndex,
  toolCount: 0,
});

test("a partial durable page retains newer loaded active workers and merges exact matches", () => {
  const oldest = { ...child("oldest", "working", 1), title: "Subagent", toolCount: 1,
    latestTool: { title: "Old tool", active: true } };
  const loadedOldest = { ...child("oldest", "completed", 5), title: "Describe Index", toolCount: 4,
    completedAt: 6, latestTool: { title: "Done", active: false },
    directUsage: { inputTokens: 2, outputTokens: 3 } };
  const recent = child("recent-running", "working", 100);
  const merged = mergeDurableAgents([oldest], [loadedOldest, recent]);
  assert.deepEqual(merged.map((entry) => entry.id), ["oldest", "recent-running"]);
  assert.equal(merged[0]?.directUsage?.inputTokens, 2);
  assert.equal(merged[0]?.title, "Describe Index");
  assert.equal(merged[0]?.lifecycle, "completed");
  assert.equal(merged[0]?.toolCount, 4);
  assert.equal(merged[0]?.latestTool?.active, false);
  assert.equal(merged[1]?.lifecycle, "working");
});

test("an authoritative unresolved compact owner suppresses a misleading loaded descriptor", () => {
  const loaded = child("conflicted-owner", "working", 7);
  assert.deepEqual(mergeDurableAgents([], [loaded], new Set(["conflicted-owner"])), []);
  assert.deepEqual(mergeDurableAgents([loaded], [], new Set(["conflicted-owner"])), []);
  assert.deepEqual(mergeCompactAttentionOwners(
    [{ requestId: "ask", toolCallId: "conflicted-owner", resolved: false }],
    [{ requestId: "ask", toolCallId: "conflicted-owner", resolved: true, name: "Misleading" }],
  ), [{ requestId: "ask", toolCallId: "conflicted-owner", resolved: false }]);
});

test("a refreshed paged snapshot replaces stale child lifecycle and activity", () => {
  const entry = (status: string, lastActivityAt: number, completedAt?: number): ChildSessionRegistryEntry => ({
    toolCallId: "off-window-child", name: "Subagent", status, sourceSeq: 80,
    startedAt: 100, lastActivityAt, ...(completedAt === undefined ? {} : { completedAt }), toolCount: 1,
  });
  const first = mergeRegistrySnapshotPages([[entry("running", 120)], []]);
  const refreshed = mergeRegistrySnapshotPages([[entry("completed", 200, 200)], []]);
  assert.equal(first[0]?.completedAt, undefined);
  assert.deepEqual(refreshed, [entry("completed", 200, 200)]);
});
