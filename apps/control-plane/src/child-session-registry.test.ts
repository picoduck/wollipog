import assert from "node:assert/strict";
import test from "node:test";
import type { PendingApproval, SessionEvent } from "@wollipog/protocol";
import { ChildSessionRegistryProjector, projectChildSessionRegistry } from "./child-session-registry.js";

const event = (seq: number, payload: SessionEvent["payload"]): SessionEvent => ({
  id: seq,
  sessionId: "session",
  seq,
  ts: seq * 10,
  payload,
});

test("projects exact nested children from complete structured history with bounded paging", () => {
  const events = [
    event(1, { kind: "tool_call", toolCallId: "outer", toolKind: "agent", title: "Task", status: "running",
      subagentName: "Audit\u0000 Child", subagentRole: "reviewer" }),
    event(2, { kind: "tool_call", toolCallId: "read", parentToolUseId: "outer", toolKind: "read", title: "Read", status: "completed" }),
    event(3, { kind: "tool_call", toolCallId: "inner", parentToolUseId: "outer", toolKind: "agent", title: "Task", status: "running" }),
    event(4, { kind: "tool_call_update", toolCallId: "inner", parentToolUseId: "outer", status: "completed", subagentLifecycle: "completed" }),
  ];
  const page = projectChildSessionRegistry(events, null, 7, 0, 1);
  assert.equal(page.children.length, 1);
  assert.deepEqual(page.children[0], {
    toolCallId: "outer", name: "Audit Child", role: "reviewer", status: "running", sourceSeq: 1,
    startedAt: 10, lastActivityAt: 40, toolCount: 2, latestTool: { title: "Task", active: true },
  });
  assert.equal(page.nextAfter, 1);
  assert.equal(page.truncated, true);
  const second = projectChildSessionRegistry(events, null, 7, page.nextAfter!, 1);
  assert.equal(second.children[0]?.toolCallId, "inner");
  assert.equal(second.children[0]?.parentToolUseId, "outer");
  assert.equal(second.children[0]?.completedAt, 40);
});

test("projects pending owners on every bounded page and leaves missing or duplicate owners unresolved", () => {
  const events = [
    event(1, { kind: "tool_call", toolCallId: "first", toolKind: "agent", title: "Task", status: "completed" }),
    event(2, { kind: "tool_call", toolCallId: "owner", toolKind: "agent", title: "Task", status: "running", subagentName: "Owner" }),
    event(3, { kind: "tool_call", toolCallId: "duplicate", toolKind: "agent", title: "Task", status: "running" }),
    event(4, { kind: "tool_call", toolCallId: "duplicate", toolKind: "agent", title: "Task", status: "running" }),
  ];
  const pending: PendingApproval = { requestId: "known", ownerToolUseId: "owner", title: "Known", options: [],
    additionalRequests: [
      { requestId: "missing", ownerToolUseId: "missing", title: "Missing", options: [] },
      { requestId: "duplicate", ownerToolUseId: "duplicate", title: "Duplicate", options: [] },
    ] };
  const page = projectChildSessionRegistry(events, pending, 0, 0, 1);
  assert.deepEqual(page.children.map((child) => child.toolCallId), ["first"]);
  assert.equal(page.children.length <= 1, true);
  assert.equal(page.unidentifiedChildren, 1);
  assert.deepEqual(page.attentionOwners, [
    { requestId: "known", toolCallId: "owner", resolved: true, name: "Owner" },
    { requestId: "missing", toolCallId: "missing", resolved: false },
    { requestId: "duplicate", toolCallId: "duplicate", resolved: false },
  ]);
});

test("does not infer children from parented prose and clears cyclic parent claims", () => {
  const events = [
    event(1, { kind: "agent_message", text: "spawn child maybe", parentToolUseId: "prose-only" }),
    event(2, { kind: "tool_call", toolCallId: "a", parentToolUseId: "b", toolKind: "agent", title: "Task", status: "running" }),
    event(3, { kind: "tool_call", toolCallId: "b", parentToolUseId: "a", toolKind: "agent", title: "Task", status: "running" }),
  ];
  const page = projectChildSessionRegistry(events, null, 0, 0, 10);
  assert.deepEqual(page.children.map((child) => [child.toolCallId, child.parentToolUseId]), [["a", undefined], ["b", undefined]]);
  assert.equal(page.children.some((child) => child.toolCallId === "prose-only"), false);
});

test("incremental projection appends only new history while retaining exact aggregates", () => {
  const projector = new ChildSessionRegistryProjector();
  projector.append([
    event(1, { kind: "tool_call", toolCallId: "child", toolKind: "agent", title: "Task", status: "running" }),
    event(2, { kind: "tool_call", toolCallId: "read", parentToolUseId: "child", toolKind: "read", title: "Read", status: "running" }),
  ]);
  projector.append([
    event(3, { kind: "tool_call_update", toolCallId: "read", parentToolUseId: "child", status: "completed" }),
    event(4, { kind: "tool_call_update", toolCallId: "child", status: "completed", subagentLifecycle: "completed" }),
  ]);
  const child = projector.page(null, 0, 0, 10).children[0];
  assert.equal(child?.toolCount, 1);
  assert.equal(child?.lastActivityAt, 40);
  assert.equal(child?.completedAt, 40);
  assert.equal(child?.lifecycle, "completed");
});

test("incremental projection never retains raw tool input or output previews", () => {
  const projector = new ChildSessionRegistryProjector();
  projector.append([
    event(1, { kind: "tool_call", toolCallId: "shell", toolKind: "shell", title: "Shell", status: "running",
      text: "secret-input-preview" }),
    event(2, { kind: "tool_call", toolCallId: "child", toolKind: "agent", title: "Task", status: "running",
      subagentName: "Safe Name", text: "secret-agent-prompt" }),
    event(3, { kind: "tool_call_update", toolCallId: "child", status: "completed",
      subagentLifecycle: "completed", text: "secret-agent-output" }),
  ]);
  const retained = projector as unknown as {
    spawns: Map<string, unknown>;
    updates: Map<string, unknown>;
    directTools: Map<string, unknown>;
  };
  const serialized = JSON.stringify([
    ...retained.spawns.values(),
    ...retained.updates.values(),
    ...retained.directTools.values(),
  ]);
  assert.doesNotMatch(serialized, /secret-(?:input|agent)/);
  assert.match(serialized, /Safe Name/);
});
