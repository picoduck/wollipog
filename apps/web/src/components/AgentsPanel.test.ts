import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentDescriptor } from "../subagents.js";
import type { ChildSessionRegistryEntry, SessionView } from "@wollipog/protocol";
import { childRegistryProgressKey, mergeCompactAttentionOwners, mergeDurableAgents,
  mergeRegistrySnapshotPages } from "./AgentsPanel.js";

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

test("a durable page uses its safe identity set and merges only exact loaded matches", () => {
  const oldest = { ...child("oldest", "working", 1), title: "Subagent", toolCount: 1,
    latestTool: { title: "Old tool", active: true } };
  const loadedOldest = { ...child("oldest", "completed", 5), title: "Describe Index", toolCount: 4,
    completedAt: 6, latestTool: { title: "Done", active: false },
    directUsage: { inputTokens: 2, outputTokens: 3 } };
  const recent = child("recent-running", "working", 100);
  const merged = mergeDurableAgents([oldest], [loadedOldest, recent]);
  assert.deepEqual(merged.map((entry) => entry.id), ["oldest"]);
  assert.equal(merged[0]?.directUsage?.inputTokens, 2);
  assert.equal(merged[0]?.title, "Describe Index");
  assert.equal(merged[0]?.lifecycle, "completed");
  assert.equal(merged[0]?.toolCount, 4);
  assert.equal(merged[0]?.latestTool?.active, false);
  assert.equal(merged.some((entry) => entry.id === recent.id), false);
});

test("newer durable terminal evidence cannot be reopened by an older loaded window", () => {
  const durable = { ...child("child", "completed", 1), lastActivityAt: 200, completedAt: 200,
    toolStatus: "completed", availability: "recorded" as const,
    latestTool: { title: "Command", active: false } };
  const loaded = { ...child("child", "working", 2), lastActivityAt: 100,
    toolStatus: "running", availability: "live" as const,
    latestTool: { title: "Read", active: true } };
  const merged = mergeDurableAgents([durable], [loaded])[0]!;
  assert.equal(merged.lifecycle, "completed");
  assert.equal(merged.toolStatus, "completed");
  assert.equal(merged.availability, "recorded");
  assert.equal(merged.completedAt, 200);
  assert.deepEqual(merged.latestTool, { title: "Command", active: false });
});

test("durable terminal evidence cannot be reopened by a later loaded active observation", () => {
  const durable = { ...child("child", "completed", 1), lastActivityAt: 200, completedAt: 200,
    toolStatus: "completed", availability: "recorded" as const,
    latestTool: { title: "Command", active: false } };
  const loaded = { ...child("child", "working", 2), lastActivityAt: 300,
    toolStatus: "running", availability: "live" as const,
    latestTool: { title: "Read", active: true } };
  const merged = mergeDurableAgents([durable], [loaded])[0]!;
  assert.equal(merged.lifecycle, "completed");
  assert.equal(merged.toolStatus, "completed");
  assert.equal(merged.availability, "recorded");
  assert.equal(merged.completedAt, 200);
  assert.deepEqual(merged.latestTool, { title: "Command", active: false });
});

test("newer loaded terminal evidence settles older durable active evidence", () => {
  const durable = { ...child("child", "working", 1), lastActivityAt: 100,
    toolStatus: "running", latestTool: { title: "Read", active: true } };
  const loaded = { ...child("child", "completed", 2), lastActivityAt: 200, completedAt: 200,
    toolStatus: "completed", availability: "live" as const,
    latestTool: { title: "Command", active: false } };
  const merged = mergeDurableAgents([durable], [loaded])[0]!;
  assert.equal(merged.lifecycle, "completed");
  assert.equal(merged.toolStatus, "completed");
  assert.equal(merged.availability, "live");
  assert.equal(merged.completedAt, 200);
  assert.deepEqual(merged.latestTool, { title: "Command", active: false });
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

test("message progress invalidates the registry even inside one timestamp millisecond", () => {
  const session = { messageCount: 20, lastEventAt: 500, status: "running",
    pendingApproval: null } as unknown as SessionView;
  const next = { ...session, messageCount: 21 };
  assert.notEqual(childRegistryProgressKey(session), childRegistryProgressKey(next));
});
