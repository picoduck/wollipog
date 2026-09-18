import assert from "node:assert/strict";
import test from "node:test";
import { deriveSubagentDescriptors, type SubagentDescriptor } from "../subagents.js";
import { MAX_TRACKED_TOOL_CALL_STATEMENTS, TimelineBuilder } from "../timeline.js";
import type { ChildSessionRegistryEntry, SessionEventPayload, SessionView } from "@wollipog/protocol";
import { changedRosterIds, childRegistryAgentFingerprints, childRegistryProgressKey,
  childRegistryRefreshDelay, childRegistryRosterKey, mergeCompactAttentionOwners, mergeDurableAgents,
  mergeRefreshedRegistryPages, registryRefreshCursors,
  shouldOpenPrimaryRequestInSession } from "./AgentsPanel.js";

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

test("a refreshed page replaces stale child lifecycle and activity across the range it covers", () => {
  const entry = (status: string, lastActivityAt: number, completedAt?: number): ChildSessionRegistryEntry => ({
    toolCallId: "off-window-child", name: "Subagent", status, sourceSeq: 80,
    startedAt: 100, lastActivityAt, ...(completedAt === undefined ? {} : { completedAt }), toolCount: 1,
  });
  const first = mergeRefreshedRegistryPages([],
    [{ after: 0, children: [entry("running", 120)], truncated: false }]);
  const refreshed = mergeRefreshedRegistryPages(first,
    [{ after: 0, children: [entry("completed", 200, 200)], truncated: false }]);
  assert.equal(first[0]?.completedAt, undefined);
  assert.deepEqual(refreshed, [entry("completed", 200, 200)]);
});

/**
 * #1289 made a child stop being identified mid-session, and #1290 stops re-reading every page, so
 * the two meet here: the page that lost the child answers for its own range and drops it, while the
 * entries beyond that range survive precisely because nobody re-read them.
 */
test("a page that no longer returns a child drops it without disturbing the pages it does not cover", () => {
  const entry = (id: string, sourceSeq: number): ChildSessionRegistryEntry => ({
    toolCallId: id, name: id, status: "running", sourceSeq,
    startedAt: 100, lastActivityAt: 100, toolCount: 0,
  });
  const held = [entry("alpha", 10), entry("beta", 20), entry("gamma", 30)];
  const merged = mergeRefreshedRegistryPages(held,
    [{ after: 0, children: [entry("alpha", 10)], truncated: true }]);
  assert.deepEqual(merged.map((child) => child.toolCallId), ["alpha", "beta", "gamma"],
    "a truncated page answers only up to its last entry");
  const settled = mergeRefreshedRegistryPages(held,
    [{ after: 0, children: [entry("alpha", 10)], truncated: false }]);
  assert.deepEqual(settled.map((child) => child.toolCallId), ["alpha"],
    "an untruncated page answers for everything after its cursor, so a vanished child is dropped");
});

test("the changed-child set covers arrivals, departures and a folded re-statement", () => {
  const previous = childRegistryAgentFingerprints([child("alpha", "working", 1), child("beta", "working", 2)]);
  const restated = childRegistryAgentFingerprints([
    { ...child("alpha", "working", 1), statementCount: 2 }, child("beta", "working", 2)]);
  assert.deepEqual([...changedRosterIds(previous, restated)], ["alpha"]);
  const departed = childRegistryAgentFingerprints([child("alpha", "working", 1)]);
  assert.deepEqual([...changedRosterIds(previous, departed)], ["beta"]);
  const arrived = childRegistryAgentFingerprints([
    child("alpha", "working", 1), child("beta", "working", 2), child("gamma", "working", 3)]);
  assert.deepEqual([...changedRosterIds(previous, arrived)], ["gamma"]);
  assert.deepEqual([...changedRosterIds(previous, previous)], []);
});

/**
 * #1290: the refresh used to cost one request per loaded page whatever moved. A page earns its
 * request from its own contents, so a single child's change reaches the page holding it and the
 * tail page where a new spawn would land — two requests against a ten-page registry, not ten.
 */
test("a single child's change re-reads its own page and the tail, not every loaded page", () => {
  const settled = (index: number): ChildSessionRegistryEntry => ({
    toolCallId: `child-${index}`, name: `Child ${index}`, status: "completed", lifecycle: "completed",
    sourceSeq: index, startedAt: 100, lastActivityAt: 200, completedAt: 200, toolCount: 1,
  });
  const registry = Array.from({ length: 500 }, (_value, index) => settled(index + 1));
  const loaded = new Set(registry.map((entry) => entry.toolCallId));
  const pageCount = Math.ceil(registry.length / 50);
  assert.equal(pageCount, 10);

  // `child-120` sits on the third page, whose cursor is the last entry of the second.
  assert.deepEqual(registryRefreshCursors(registry, new Set(["child-120"]), loaded, 50), [100, 450]);
  assert.deepEqual(registryRefreshCursors(registry, new Set(), loaded, 50), [450],
    "with nothing to chase, only the page a new spawn would land on is worth a request");
  assert.deepEqual(registryRefreshCursors(registry, new Set(["child-1"]), loaded, 50), [0, 450],
    "the first page's cursor is the start of the registry, not a child's sourceSeq");
  assert.deepEqual(registryRefreshCursors([], new Set(), new Set(), 50), [0],
    "an empty registry still reads its first page");
});

/**
 * The idle cadence exists for a child whose durable state moves with nothing observable in the
 * loaded transcript (#1207). Only an unsettled child outside that window can do so, so only its
 * page keeps costing an idle request.
 */
test("only an unsettled child outside the loaded transcript keeps its page in the idle sweep", () => {
  const entry = (index: number, settled: boolean): ChildSessionRegistryEntry => ({
    toolCallId: `child-${index}`, name: `Child ${index}`, status: settled ? "completed" : "running",
    ...(settled ? { lifecycle: "completed" as const, completedAt: 200 } : { lifecycle: "running" as const }),
    sourceSeq: index, startedAt: 100, lastActivityAt: 200, toolCount: 1,
  });
  // Three pages: one unsettled child on the first, one on the second, and the rest settled.
  const registry = Array.from({ length: 150 }, (_value, index) =>
    entry(index + 1, index !== 0 && index !== 60));

  assert.deepEqual(registryRefreshCursors(registry, new Set(), new Set(), 50), [0, 50, 100],
    "an unsettled child nobody can see in the transcript still earns its page a request");
  assert.deepEqual(registryRefreshCursors(registry, new Set(), new Set(["child-1", "child-61"]), 50), [100],
    "those same children rendered from the loaded transcript need no registry read at all");
});

test("message progress invalidates the registry even inside one timestamp millisecond", () => {
  const session = { messageCount: 20, lastEventAt: 500, status: "running",
    pendingApproval: null } as unknown as SessionView;
  const next = { ...session, messageCount: 21 };
  assert.notEqual(childRegistryProgressKey(session), childRegistryProgressKey(next));
});

test("the roster fingerprint moves only on evidence that the child roster itself changed", () => {
  const session = { status: "running", pendingApproval: null, attentionOwners: [] } as unknown as SessionView;
  const roster = [child("alpha", "working", 1)];
  const key = childRegistryRosterKey(session, roster);
  assert.equal(childRegistryRosterKey(session, [{ ...roster[0]!, toolCount: 9, lastActivityAt: 900 }]), key,
    "activity counters on an unchanged child are rendered from the loaded projection, not the registry");
  assert.notEqual(childRegistryRosterKey(session, [...roster, child("beta", "working", 2)]), key,
    "a new subagent tool call is roster-affecting");
  assert.notEqual(childRegistryRosterKey(session, [child("alpha", "completed", 1)]), key,
    "a child lifecycle transition is roster-affecting");
  assert.notEqual(childRegistryRosterKey({ ...session, status: "idle" } as SessionView, roster), key,
    "the parent reaching a new status is roster-affecting");
  assert.notEqual(childRegistryRosterKey({ ...session,
    attentionOwners: [{ requestId: "ask", toolCallId: "alpha", resolved: false }] } as SessionView, roster), key,
    "a child request appearing is roster-affecting");
  assert.equal(childRegistryRosterKey(session, [{ ...roster[0]!, statementCount: 1 }]), key,
    "one statement is the ordinary case the absent field already means");
  assert.notEqual(childRegistryRosterKey(session, [{ ...roster[0]!, statementCount: 2 }]), key,
    "a folded re-statement can change the control plane's classification and is roster-affecting");
  assert.notEqual(childRegistryRosterKey(session, [{ ...roster[0]!, statementCount: 3 }]),
    childRegistryRosterKey(session, [{ ...roster[0]!, statementCount: 2 }]),
    "the second re-statement is the one that makes the id permanently ambiguous");
});

test("the re-statement signal saturates, so it can never become a per-event refresh", () => {
  const builder = new TimelineBuilder();
  const spawn = { kind: "tool_call", toolCallId: "child", title: "Agent: Audit",
    toolKind: "agent", status: "in_progress" } as const;
  const keys = new Set<string>();
  const session = { status: "running", pendingApproval: null, attentionOwners: [] } as unknown as SessionView;
  for (let statement = 1; statement <= 20; statement += 1) {
    builder.push({ id: statement, sessionId: "orchestrator", seq: statement, ts: 1_000 + statement, payload: spawn });
    keys.add(childRegistryRosterKey(session, deriveSubagentDescriptors(builder.snapshot(), {
      sessionStatus: "running", runnerOnline: true, availability: "live",
    })));
  }
  assert.equal(keys.size, MAX_TRACKED_TOOL_CALL_STATEMENTS,
    "twenty identical statements can move the fingerprint at most as often as the registry can reclassify");
});

test("only a re-stated tool call counts, never the updates a streaming turn emits freely", () => {
  const builder = new TimelineBuilder();
  const push = (seq: number, payload: SessionEventPayload) =>
    builder.push({ id: seq, sessionId: "orchestrator", seq, ts: 1_000 + seq, payload });
  // An update that arrives before any statement creates the row; the first real statement after it
  // must still read as one statement, not as a re-statement of a row nobody stated.
  push(1, { kind: "tool_call_update", toolCallId: "child", status: "in_progress" });
  push(2, { kind: "tool_call", toolCallId: "child", title: "Agent: Audit", toolKind: "agent", status: "in_progress" });
  for (let tick = 3; tick <= 10; tick += 1) {
    push(tick, { kind: "tool_call_update", toolCallId: "child", status: "in_progress" });
  }
  const folded = builder.snapshot().find((item) => item.kind === "tool_call")!;
  assert.equal("statementCount" in folded ? folded.statementCount : undefined, undefined,
    "one statement plus any number of updates is the ordinary single-observation case");
});

test("evidence-free event progress waits for the idle cadence, roster evidence does not", () => {
  assert.equal(childRegistryRefreshDelay(false, 0), 15_000);
  assert.equal(childRegistryRefreshDelay(false, 3_000), 12_000,
    "the cadence is an absolute deadline measured from the last request, so a burst cannot push it out");
  assert.equal(childRegistryRefreshDelay(false, 20_000), 0);
  assert.equal(childRegistryRefreshDelay(true, 0), 1_000, "roster evidence is still coalesced to one refresh per second");
  assert.equal(childRegistryRefreshDelay(true, 1_500), 0);
  assert.equal(childRegistryRefreshDelay(true, -5), 1_000, "a clock that went backwards never yields a negative wait");
});

test("a worker-owned primary approval stays actionable in the Agents panel", () => {
  const primary = {
    requestId: "worker-permission",
    kind: "permission",
    title: "Allow Command",
    options: [],
    ownerToolUseId: "worker-tool",
  } as NonNullable<SessionView["pendingApproval"]>;
  assert.equal(shouldOpenPrimaryRequestInSession(primary, primary.requestId, true), false);
  assert.equal(shouldOpenPrimaryRequestInSession(
    { ...primary, ownerToolUseId: undefined },
    primary.requestId,
    true,
  ), true);
  assert.equal(shouldOpenPrimaryRequestInSession(
    { ...primary, kind: "question", questions: [] },
    primary.requestId,
    true,
  ), true);
});
