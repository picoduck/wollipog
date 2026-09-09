import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import { governanceDecisions, type GovernanceAnchorEvent } from "../governance.js";
import type { TimelineItem } from "../timeline.js";
import { useGovernanceTimeline } from "./useGovernanceAudit.js";

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
