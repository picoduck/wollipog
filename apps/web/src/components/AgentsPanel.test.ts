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
