import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentDescriptor } from "../subagents.js";
import { mergeDurableAgents } from "./AgentsPanel.js";

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
  const oldest = child("oldest", "completed", 1);
  const loadedOldest = { ...oldest, directUsage: { inputTokens: 2, outputTokens: 3 } };
  const recent = child("recent-running", "working", 100);
  const merged = mergeDurableAgents([oldest], [loadedOldest, recent]);
  assert.deepEqual(merged.map((entry) => entry.id), ["oldest", "recent-running"]);
  assert.equal(merged[0]?.directUsage?.inputTokens, 2);
  assert.equal(merged[1]?.lifecycle, "working");
});
