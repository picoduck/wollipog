import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import { governanceDecisions, type GovernanceAnchorEvent } from "../governance.js";
import { ApiProvider } from "../api-context.js";
import type { ApiClient } from "../api.js";
import type { TimelineItem } from "../timeline.js";
import { useGovernanceAudit, useGovernanceTimeline, type GovernanceAuditState } from "./useGovernanceAudit.js";

const domWindow = new Window();
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const entry: GovernanceAuditEntry = {
  auditId: "h",
  requestId: "hook-1",
  approvalKind: "policy_hook",
  stage: "resolution",
  outcome: "allowed",
  actor: { kind: "human", id: "device-1" },
  scope: { sessionId: "session-1", runnerId: "runner-1" },
  timestamp: 250,
};
const decisions = governanceDecisions([entry]);
const anchors: GovernanceAnchorEvent[] = [{ seq: 1, ts: 100 }, { seq: 2, ts: 200 }, { seq: 3, ts: 300 }];
const items: TimelineItem[] = [
  { kind: "agent_message", id: 1, text: "m1" } as TimelineItem,
  { kind: "agent_thought", id: 2, text: "t2" } as TimelineItem,
  { kind: "agent_thought", id: 3, text: "t3" } as TimelineItem,
];

test("transcript-window backfill follows cursors until the oldest visible activity is covered", async () => {
  const calls: Array<{ id: string; limit: number; before?: string }> = [];
  const audit = (auditId: string, timestamp: number): GovernanceAuditEntry => ({
    ...entry, auditId, requestId: `hook-${auditId}`, timestamp,
  });
  const client = {
    governanceAudit: async (id: string, limit: number, before?: string) => {
      calls.push({ id, limit, ...(before ? { before } : {}) });
      return before
        ? { entries: [audit("older", 900), audit("tie-first", 1_000)], hasMore: false }
        : { entries: [audit("tie-second", 1_000), audit("newest", 1_100)], nextBefore: "tie-second", hasMore: true };
    },
  } as unknown as ApiClient;
  let latest: GovernanceAuditState | undefined;
  function Probe() {
    latest = useGovernanceAudit("session-1", "revision-1", true, 950);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe /></ApiProvider>);
    for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(calls, [
    { id: "session-1", limit: 200 },
    { id: "session-1", limit: 200, before: "tie-second" },
  ]);
  assert.deepEqual(latest?.decisions.map((decision) => decision.auditId), [
    "older", "tie-first", "tie-second", "newest",
  ]);
  assert.equal(latest?.hasMore, false);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("manual governance-history paging prepends the next older page", async () => {
  const calls: Array<string | undefined> = [];
  const audit = (auditId: string, timestamp: number): GovernanceAuditEntry => ({
    ...entry, auditId, requestId: `hook-${auditId}`, timestamp,
  });
  const client = {
    governanceAudit: async (_id: string, _limit: number, before?: string) => {
      calls.push(before);
      return before
        ? { entries: [audit("old", 100)], hasMore: false }
        : { entries: [audit("new", 200)], nextBefore: "new", hasMore: true };
    },
  } as unknown as ApiClient;
  let latest: GovernanceAuditState | undefined;
  function Probe() {
    latest = useGovernanceAudit("session-1", "revision-1", true);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(latest?.hasMore, true);
  await act(async () => {
    latest!.loadOlder();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(calls, [undefined, "new"]);
  assert.deepEqual(latest?.decisions.map((decision) => decision.auditId), ["old", "new"]);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("revision refreshes retain loaded history and a session switch drops the prior snapshot", async () => {
  const audit = (sessionId: string, auditId: string, timestamp: number): GovernanceAuditEntry => ({
    ...entry,
    auditId,
    requestId: `hook-${auditId}`,
    scope: { sessionId, runnerId: "runner-1" },
    timestamp,
  });
  let sessionOneTail = 0;
  const client = {
    governanceAudit: async (id: string, _limit: number, before?: string) => {
      if (id === "session-2") return { entries: [audit(id, "session-2", 300)], hasMore: false };
      if (before) return { entries: [audit(id, "old", 100)], hasMore: false };
      sessionOneTail += 1;
      return sessionOneTail === 1
        ? { entries: [audit(id, "new", 200)], nextBefore: "new", hasMore: true }
        : { entries: [audit(id, "new", 200), audit(id, "newer", 250)], hasMore: false };
    },
  } as unknown as ApiClient;
  let latest: GovernanceAuditState | undefined;
  function Probe({ id, revision }: { id: string; revision: string }) {
    latest = useGovernanceAudit(id, revision, true);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe id="session-1" revision="revision-1" /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    latest!.loadOlder();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe id="session-1" revision="revision-2" /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(latest?.decisions.map((decision) => decision.auditId), ["old", "new", "newer"]);

  await act(async () => {
    root.render(<ApiProvider client={client}><Probe id="session-2" revision="revision-1" /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(latest?.decisions.map((decision) => decision.auditId), ["session-2"]);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("a pruned older cursor rebases on the newest page and remains pageable", async () => {
  const calls: Array<string | undefined> = [];
  const audit = (auditId: string, timestamp: number): GovernanceAuditEntry => ({
    ...entry, auditId, requestId: `hook-${auditId}`, timestamp,
  });
  const client = {
    governanceAudit: async (_id: string, _limit: number, before?: string) => {
      calls.push(before);
      if (before === "pruned") throw new Error("cursor was pruned");
      if (before === "fresh") return { entries: [audit("older", 100)], hasMore: false };
      return calls.length === 1
        ? { entries: [audit("stale-head", 200)], nextBefore: "pruned", hasMore: true }
        : { entries: [audit("fresh-head", 300)], nextBefore: "fresh", hasMore: true };
    },
  } as unknown as ApiClient;
  let latest: GovernanceAuditState | undefined;
  function Probe() {
    latest = useGovernanceAudit("session-1", "revision-1", true);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    latest!.loadOlder();
    for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(latest?.decisions.map((decision) => decision.auditId), ["fresh-head"]);
  assert.equal(latest?.hasMore, true);
  await act(async () => {
    latest!.loadOlder();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(calls, [undefined, "pruned", undefined, "fresh"]);
  assert.deepEqual(latest?.decisions.map((decision) => decision.auditId), ["older", "fresh-head"]);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("a non-overlapping newest window drops retained pages so its gap remains reachable", async () => {
  const audit = (auditId: string, timestamp: number): GovernanceAuditEntry => ({
    ...entry, auditId, requestId: `hook-${auditId}`, timestamp,
  });
  let revision = 0;
  const client = {
    governanceAudit: async (_id: string, _limit: number, before?: string) => {
      if (before === "old-head") return { entries: [audit("old", 100)], hasMore: false };
      if (before === "burst-101") return { entries: [audit("bridge", 250)], hasMore: false };
      revision += 1;
      if (revision === 1) return {
        entries: [audit("old-head", 200)], nextBefore: "old-head", hasMore: true,
      };
      return {
        entries: Array.from({ length: 200 }, (_, index) => audit(`burst-${index + 101}`, 301 + index)),
        nextBefore: "burst-101",
        hasMore: true,
      };
    },
  } as unknown as ApiClient;
  let latest: GovernanceAuditState | undefined;
  function Probe({ auditRevision }: { auditRevision: string }) {
    latest = useGovernanceAudit("session-1", auditRevision, true);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe auditRevision="one" /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    latest!.loadOlder();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(latest?.decisions.map((decision) => decision.auditId), ["old", "old-head"]);
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe auditRevision="two" /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(latest?.decisions.length, 200);
  assert.equal(latest?.decisions.some((decision) => decision.auditId === "old"), false);
  assert.equal(latest?.hasMore, true);
  await act(async () => {
    latest!.loadOlder();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(latest?.decisions[0]?.auditId, "bridge");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("raw audit rows do not expose an empty Governance tab", async () => {
  const client = {
    governanceAudit: async () => ({
      entries: [{ ...entry, approvalKind: "permission" as const }],
      hasMore: false,
    }),
  } as unknown as ApiClient;
  let latest: GovernanceAuditState | undefined;
  function Probe() {
    latest = useGovernanceAudit("session-1", "revision-1", true);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><Probe /></ApiProvider>);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(latest?.decisions.length, 0);
  assert.equal(latest?.available, false);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("a governance row flushed by a settled turn survives the next turn starting", async () => {
  const seen: string[][] = [];
  function Probe({ running }: { running: boolean }) {
    const merged = useGovernanceTimeline(items, decisions, anchors, running);
    seen.push(merged.map((item) => item.kind));
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  for (const running of [true, false, true]) {
    await act(async () => { root.render(<Probe running={running} />); });
  }
  assert.deepEqual(seen.at(0), ["agent_message", "agent_thought", "agent_thought"], "held while the first turn streams");
  assert.deepEqual(seen.at(1), ["agent_message", "agent_thought", "agent_thought", "governance_decision"], "lands when the turn settles");
  assert.deepEqual(seen.at(-1), ["agent_message", "agent_thought", "agent_thought", "governance_decision"],
    "stays visible when the next turn starts before its first event");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("landed ids are bounded by the audit snapshot", async () => {
  const seen: number[] = [];
  const snapshots = [0, 1, 2].map((round) => governanceDecisions(
    Array.from({ length: 3 }, (_, i) => ({ ...entry, auditId: `r${round}-${i}`, requestId: `hook-${round}-${i}`, timestamp: 250 + i })),
  ));
  function Probe({ round }: { round: number }) {
    const merged = useGovernanceTimeline(items, snapshots[round]!, anchors, false);
    seen.push(merged.filter((item) => item.kind === "governance_decision").length);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  for (const round of [0, 1, 2]) {
    await act(async () => { root.render(<Probe round={round} />); });
  }
  assert.deepEqual(seen.slice(-1), [3], "only the current snapshot's rows render");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("frozen anchors are dropped when the event history is replaced", async () => {
  // A replaced history restarts sequence numbers, so an anchor from the old epoch would compare
  // against unrelated new events and drag the row to the tail.
  const seen: string[][] = [];
  const oldItems: TimelineItem[] = [
    { kind: "agent_message", id: 101, text: "m101" } as TimelineItem,
    { kind: "agent_message", id: 102, text: "m102" } as TimelineItem,
  ];
  const oldAnchors: GovernanceAnchorEvent[] = [{ seq: 101, ts: 100 }, { seq: 102, ts: 300 }];
  const newItems: TimelineItem[] = [
    { kind: "agent_message", id: 1, text: "m1" } as TimelineItem,
    { kind: "agent_message", id: 2, text: "m2" } as TimelineItem,
    { kind: "agent_message", id: 3, text: "m3" } as TimelineItem,
  ];
  const newAnchors: GovernanceAnchorEvent[] = [{ seq: 1, ts: 1_000 }, { seq: 2, ts: 1_100 }, { seq: 3, ts: 1_200 }];
  function Probe({ epoch }: { epoch: number }) {
    const merged = useGovernanceTimeline(
      epoch === 0 ? oldItems : newItems,
      decisions,
      epoch === 0 ? oldAnchors : newAnchors,
      false,
      `session:${epoch}`,
    );
    seen.push(merged.map((item) => item.kind === "governance_decision" ? "g" : String(item.id)));
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  for (const epoch of [0, 1]) {
    await act(async () => { root.render(<Probe epoch={epoch} />); });
  }
  assert.deepEqual(seen.at(0), ["101", "g", "102"], "landed in the old history after seq 101");
  assert.deepEqual(seen.at(-1), ["g", "1", "2", "3"],
    "re-anchored at the head of the replaced history (its timestamp predates every new event)");
  await act(async () => { root.unmount(); });
  container.remove();
});
