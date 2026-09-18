import assert from "node:assert/strict";
import test from "node:test";
import { deriveSubagentDescriptors, type SubagentDescriptor } from "../subagents.js";
import { MAX_TRACKED_TOOL_CALL_STATEMENTS, TimelineBuilder } from "../timeline.js";
import type { ChildSessionRegistryEntry, ChildSessionRegistryPage, SessionEventPayload,
  SessionView } from "@wollipog/protocol";
import { changedRosterIds, childRegistryAgentFingerprints, childRegistryProgressKey,
  childRegistryRefreshDelay, childRegistryRosterKey, mergeCompactAttentionOwners, mergeDurableAgents,
  mergeRefreshedRegistryPages, readRegistryRefresh, registryRefreshPlan,
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

  // `child-120` sits on the third page: after the last entry of the second, through its own last.
  assert.deepEqual(registryRefreshPlan(registry, new Set(["child-120"]), loaded, 50),
    { kind: "targeted", pages: [{ after: 100, through: 150 }, { after: 450, through: 500 }] });
  assert.deepEqual(registryRefreshPlan(registry, new Set(), loaded, 50),
    { kind: "targeted", pages: [{ after: 450, through: 500 }] },
    "with nothing to chase, only the page a new spawn would land on is worth a request");
  assert.deepEqual(registryRefreshPlan(registry, new Set(["child-1"]), loaded, 50),
    { kind: "targeted", pages: [{ after: 0, through: 50 }, { after: 450, through: 500 }] },
    "the first page's cursor is the start of the registry, not a child's sourceSeq");
  assert.deepEqual(registryRefreshPlan([], new Set(), new Set(), 50), { kind: "sweep", pageCount: 1 },
    "an empty registry still reads its first page");
});

/**
 * The control plane can sort a child in behind entries the panel already holds: a newly observed
 * spawn recovers its own pre-spawn evidence from seq 0, so its `sourceSeq` can precede the tail.
 * A changed child with no page therefore cannot be chased by the tail cursor, and a child absent
 * from the registry is absent from the roster entirely, because `mergeDurableAgents` renders the
 * registry's children rather than the transcript's.
 */
test("a changed child the registry has not placed sweeps every page rather than losing it", () => {
  const settled = (index: number): ChildSessionRegistryEntry => ({
    toolCallId: `child-${index}`, name: `Child ${index}`, status: "completed", lifecycle: "completed",
    sourceSeq: index, startedAt: 100, lastActivityAt: 200, completedAt: 200, toolCount: 1,
  });
  const registry = Array.from({ length: 150 }, (_value, index) => settled(index + 1));
  const loaded = new Set(registry.map((entry) => entry.toolCallId));

  assert.deepEqual(registryRefreshPlan(registry, new Set(["not-yet-placed"]), loaded, 50),
    { kind: "sweep", pageCount: 3 }, "with no page to target, the whole registry is re-read");
  assert.deepEqual(registryRefreshPlan(registry, new Set(["child-60", "not-yet-placed"]), loaded, 50),
    { kind: "sweep", pageCount: 3 }, "one unplaced child is enough: the others cannot be targeted around it");
  assert.deepEqual(registryRefreshPlan(registry, new Set(["child-60"]), loaded, 50),
    { kind: "targeted", pages: [{ after: 50, through: 100 }, { after: 100, through: 150 }] },
    "a placed child is still targeted");
});

/**
 * A sweep exists for the case where the held registry is no longer a reliable map, so it must not
 * steer by that map. Here the control plane has sorted a recovered child in ahead of the first page
 * boundary and dropped the child sitting on it. Cursors read off the held registry would ask for
 * the first page and then everything after the old boundary entry; the first page now ends one
 * entry earlier, so the old boundary entry falls between the two ranges and would be kept forever.
 * Following the control plane's own `nextAfter` leaves no such gap.
 */
test("a sweep chains the control plane's own cursors, so no entry falls between two pages", async () => {
  const entry = (id: string, sourceSeq: number): ChildSessionRegistryEntry => ({
    toolCallId: id, name: id, status: "completed", lifecycle: "completed",
    sourceSeq, startedAt: 100, lastActivityAt: 200, completedAt: 200, toolCount: 1,
  });
  // Held: 150 children at sourceSeq 10, 20, …, 1500; the first page ends on `child-50` at 500.
  const held = Array.from({ length: 150 }, (_value, index) => entry(`child-${index + 1}`, (index + 1) * 10));
  // Served: a recovered child at 245 sorts into the first page, and `child-50` is no longer identified.
  const served = [...held.filter((child) => child.toolCallId !== "child-50"), entry("recovered", 245)]
    .sort((a, b) => a.sourceSeq - b.sourceSeq);
  const requested: number[] = [];
  const fetchPage = async (after: number): Promise<ChildSessionRegistryPage> => {
    requested.push(after);
    const eligible = served.filter((child) => child.sourceSeq > after);
    const children = eligible.slice(0, 50);
    const truncated = eligible.length > children.length;
    return { children, attentionOwners: [], unidentifiedChildren: 1, eventEpoch: 0,
      nextAfter: truncated ? children.at(-1)!.sourceSeq : null, truncated };
  };

  const plan = registryRefreshPlan(held, new Set(["recovered"]), new Set(), 50);
  assert.deepEqual(plan, { kind: "sweep", pageCount: 3 });
  const { pages, last } = await readRegistryRefresh(plan, fetchPage);
  assert.deepEqual(requested, [0, 490, 1000],
    "the second page starts where the first one actually ended, not at the held boundary entry");
  const merged = mergeRefreshedRegistryPages(held, pages).map((child) => child.toolCallId);
  assert.ok(merged.includes("recovered"), "the recovered child is placed");
  assert.ok(!merged.includes("child-50"), "the child the control plane dropped is dropped here too");
  assert.equal(merged.length, 150);
  assert.equal(last.nextAfter, null, "the sweep reached the end, so there is nothing left to Load More");
});

/**
 * A targeted read has the same stale-boundary exposure, from the other side. A child the transcript
 * cannot show is recovered ahead of the first page, pushing that page's last held entry onto the
 * second — and that entry is the one whose change the refresh was sent for. A single read at the
 * held cursor would return a page that ends just short of it and bank the change unfetched, so the
 * read continues until the held range is covered.
 */
test("a targeted page keeps reading until it covers the held range it was chosen for", async () => {
  const entry = (id: string, sourceSeq: number, status = "completed"): ChildSessionRegistryEntry => ({
    toolCallId: id, name: id, status, sourceSeq, startedAt: 100, lastActivityAt: 200, toolCount: 1,
    ...(status === "completed" ? { lifecycle: "completed" as const, completedAt: 200 } : {}),
  });
  // Held: 150 children at sourceSeq 10, 20, …, 1500; `child-50` at 500 ends the first page, running.
  const held = Array.from({ length: 150 }, (_value, index) =>
    entry(`child-${index + 1}`, (index + 1) * 10, index === 49 ? "running" : "completed"));
  // Served: `child-50` has since failed, and a recovered child at 245 sorts in ahead of it.
  const served = [...held.map((child) => child.toolCallId === "child-50" ? entry("child-50", 500, "failed") : child),
    entry("recovered", 245)].sort((a, b) => a.sourceSeq - b.sourceSeq);
  const requested: number[] = [];
  const fetchPage = async (after: number): Promise<ChildSessionRegistryPage> => {
    requested.push(after);
    const eligible = served.filter((child) => child.sourceSeq > after);
    const children = eligible.slice(0, 50);
    const truncated = eligible.length > children.length;
    return { children, attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0,
      nextAfter: truncated ? children.at(-1)!.sourceSeq : null, truncated };
  };

  // Every row is loaded, so `child-50`'s own change is the only evidence behind the first page.
  const loaded = new Set(held.map((child) => child.toolCallId));
  const plan = registryRefreshPlan(held, new Set(["child-50"]), loaded, 50);
  assert.deepEqual(plan, { kind: "targeted", pages: [{ after: 0, through: 500 }, { after: 1000, through: 1500 }] });
  const { pages } = await readRegistryRefresh(plan, fetchPage);
  assert.deepEqual(requested, [0, 490, 1000],
    "the first page ended at 490, one entry short of its held range, so the read continued from there");
  const merged = mergeRefreshedRegistryPages(held, pages);
  assert.equal(merged.find((child) => child.toolCallId === "child-50")?.status, "failed",
    "the child the refresh was sent for is refreshed, not banked unfetched");
  assert.ok(merged.some((child) => child.toolCallId === "recovered"), "the recovered child is placed too");
});

/**
 * Responses are not an atomic snapshot: the control plane is live between two requests of one
 * refresh. Where two responses overlap, the later one is the fresher account of that range, so a
 * child it omits is gone even though the earlier response still listed it.
 */
test("where two responses overlap, the later one's omission wins over the earlier one's listing", () => {
  const entry = (id: string, sourceSeq: number): ChildSessionRegistryEntry => ({
    toolCallId: id, name: id, status: "completed", sourceSeq, startedAt: 100, lastActivityAt: 200, toolCount: 1,
  });
  const held = [entry("alpha", 10), entry("beta", 20), entry("gamma", 30)];
  const merged = mergeRefreshedRegistryPages(held, [
    { after: 0, children: [entry("alpha", 10), entry("beta", 20), entry("gamma", 30)], truncated: true },
    // `beta` was dropped between the two requests.
    { after: 15, children: [entry("gamma", 30)], truncated: false },
  ]);
  assert.deepEqual(merged.map((child) => child.toolCallId), ["alpha", "gamma"]);
});

/**
 * Adjacent targets after an insertion: the first page's continuation runs past the second page's
 * held start. Restarting the second page at that stale start would read the overlap twice — and,
 * across many adjacent pages, cost nearly double a sweep — so each target resumes where the reads
 * before it stopped, and a target they already cover costs nothing.
 */
test("a target resumes where earlier reads stopped rather than re-reading the overlap", async () => {
  const entry = (id: string, sourceSeq: number): ChildSessionRegistryEntry => ({
    toolCallId: id, name: id, status: "completed", lifecycle: "completed",
    sourceSeq, startedAt: 100, lastActivityAt: 200, completedAt: 200, toolCount: 1,
  });
  const held = Array.from({ length: 150 }, (_value, index) => entry(`child-${index + 1}`, (index + 1) * 10));
  const served = [...held, entry("recovered", 245)].sort((a, b) => a.sourceSeq - b.sourceSeq);
  const requested: number[] = [];
  const fetchPage = async (after: number): Promise<ChildSessionRegistryPage> => {
    requested.push(after);
    const eligible = served.filter((child) => child.sourceSeq > after);
    const children = eligible.slice(0, 50);
    const truncated = eligible.length > children.length;
    return { children, attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0,
      nextAfter: truncated ? children.at(-1)!.sourceSeq : null, truncated };
  };

  const loaded = new Set(held.map((child) => child.toolCallId));
  const plan = registryRefreshPlan(held, new Set(["child-10", "child-60"]), loaded, 50);
  assert.deepEqual(plan, { kind: "targeted", pages: [
    { after: 0, through: 500 }, { after: 500, through: 1000 }, { after: 1000, through: 1500 }] });
  const { pages, last } = await readRegistryRefresh(plan, fetchPage);
  assert.deepEqual(requested, [0, 490, 990, 1490],
    "every read starts where the one before it ended; none restarts at a held boundary already passed");
  assert.equal(new Set(requested).size, requested.length, "no cursor is read twice");
  assert.equal(mergeRefreshedRegistryPages(held, pages).length, 151);
  assert.equal(last.nextAfter, null);
});

/**
 * The control plane's `nextAfter` is always past the cursor it answered, but the loop that follows
 * it must not depend on that for termination: a cursor that fails to advance ends the read.
 */
test("a cursor that fails to advance ends a targeted read instead of looping on it", async () => {
  const requested: number[] = [];
  const fetchPage = async (after: number): Promise<ChildSessionRegistryPage> => {
    requested.push(after);
    if (requested.length > 5) throw new Error("the read did not stop");
    return { children: [{ toolCallId: "stuck", name: "stuck", status: "running", sourceSeq: 5,
      startedAt: 100, lastActivityAt: 200, toolCount: 0 }],
    attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0, nextAfter: 5, truncated: true };
  };
  await readRegistryRefresh({ kind: "targeted", pages: [{ after: 5, through: 500 }] }, fetchPage);
  assert.deepEqual(requested, [5]);
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

  assert.deepEqual(registryRefreshPlan(registry, new Set(), new Set(), 50),
    { kind: "targeted", pages: [
      { after: 0, through: 50 }, { after: 50, through: 100 }, { after: 100, through: 150 }] },
    "an unsettled child nobody can see in the transcript still earns its page a request");
  assert.deepEqual(registryRefreshPlan(registry, new Set(), new Set(["child-1", "child-61"]), 50),
    { kind: "targeted", pages: [{ after: 100, through: 150 }] },
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
