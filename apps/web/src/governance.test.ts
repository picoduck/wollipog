import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import {
  governanceAnchorSeq,
  governanceAuditPresentation,
  governanceDecisions,
  mergeGovernanceDecisions,
  sameGovernanceSnapshot,
  transcriptGovernanceDecisions,
} from "./governance.js";
import { GovernanceHistoryPanel } from "./components/GovernanceHistoryPanel.js";
import { isCollapsibleWorkItem, type TimelineItem } from "./timeline.js";

function entry(overrides: Partial<GovernanceAuditEntry>): GovernanceAuditEntry {
  return {
    auditId: "audit-1",
    requestId: "hook-1",
    approvalKind: "policy_hook",
    stage: "resolution",
    outcome: "allowed",
    actor: { kind: "human", id: "device-1" },
    scope: { sessionId: "session-1", runnerId: "runner-1" },
    timestamp: 1,
    ...overrides,
  };
}

const events = [
  { seq: 1, ts: 100 },
  { seq: 2, ts: 200 },
  { seq: 3, ts: 300 },
];

function message(id: number): TimelineItem {
  return { kind: "agent_message", id, text: `m${id}` } as TimelineItem;
}

/** A collapsible "work" item — the kind groupTimeline folds into a "Worked" block. */
function work(id: number): TimelineItem {
  return { kind: "agent_thought", id, text: `t${id}` } as TimelineItem;
}

test("hook governance audit has four visibly distinct user-facing outcomes", () => {
  assert.equal(governanceAuditPresentation(entry({
    stage: "policy_decision",
    outcome: "denied",
    actor: { kind: "policy", id: "deny-shell" },
  }))?.label, "Blocked by Policy");
  assert.equal(governanceAuditPresentation(entry({ outcome: "denied" }))?.label, "Denied by You");
  assert.equal(governanceAuditPresentation(entry({
    outcome: "timed_out",
    actor: { kind: "system", id: "policy-ask-timeout" },
  }))?.label, "Approval Timed Out");
  assert.equal(governanceAuditPresentation(entry({ outcome: "allowed" }))?.label, "Approved by You");
  assert.equal(governanceAuditPresentation(entry({
    approvalKind: "question",
    stage: "policy_decision",
    outcome: "answered",
    actor: { kind: "policy", id: "questions:review" },
  }))?.label, "Answered by Policy");
});

test("non-hook audit entries produce no governance outcome", () => {
  assert.equal(governanceAuditPresentation(entry({ approvalKind: "permission" })), null);
});

test("decisions are deduplicated and totally ordered oldest-first", () => {
  const decisions = governanceDecisions([
    entry({ auditId: "c", requestId: "hook-c", timestamp: 300 }),
    entry({ auditId: "b", requestId: "hook-b", timestamp: 200 }),
    entry({ auditId: "a", requestId: "hook-a", timestamp: 200 }),
    entry({ auditId: "c", requestId: "hook-c", timestamp: 300 }),
  ]);
  assert.deepEqual(decisions.map((d) => d.auditId), ["a", "b", "c"]);
  assert.equal(decisions[0]!.decidedBy, "You · device-1");
});

test("decisions never carry request content, answers, or credentials", () => {
  const [decision] = governanceDecisions([entry({
    contentDigest: "sha256:deadbeef",
    governancePolicyId: "deny-shell",
  })]);
  assert.deepEqual(Object.keys(decision!).sort(), [
    "auditId", "decidedBy", "detail", "label", "policyId", "requestId", "timestamp", "tone",
  ]);
  assert.doesNotMatch(JSON.stringify(decision), /deadbeef/);
});

test("an unchanged newest-N snapshot is recognised so the transcript is not re-derived", () => {
  const a = [entry({ auditId: "x" }), entry({ auditId: "y" })];
  assert.equal(sameGovernanceSnapshot(a, [entry({ auditId: "x" }), entry({ auditId: "y" })]), true);
  assert.equal(sameGovernanceSnapshot(a, [entry({ auditId: "x" })]), false);
  assert.equal(sameGovernanceSnapshot(a, [entry({ auditId: "z" }), entry({ auditId: "y" })]), false);
});

test("outcomes whose request already renders in place are not annotated twice", () => {
  const decisions = governanceDecisions([
    entry({ auditId: "q", requestId: "question-1", approvalKind: "question", outcome: "answered", actor: { kind: "policy", id: "p" } }),
    entry({ auditId: "h", requestId: "hook-1" }),
  ]);
  const items: TimelineItem[] = [
    { kind: "question", id: 1, requestId: "question-1", questions: [], answered: true } as TimelineItem,
  ];
  assert.deepEqual(transcriptGovernanceDecisions(decisions, items).map((d) => d.auditId), ["h"]);
});

test("a governance row lands after the last event at or before its timestamp", () => {
  assert.equal(governanceAnchorSeq(events, 250), 2);
  assert.equal(governanceAnchorSeq(events, 300), 3);
  assert.equal(governanceAnchorSeq(events, 99), Number.NEGATIVE_INFINITY);

  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 250 })]);
  const merged = mergeGovernanceDecisions([message(1), message(2), message(3)], decisions, events);
  assert.deepEqual(merged.map((item) => item.kind), [
    "agent_message", "agent_message", "governance_decision", "agent_message",
  ]);
});

test("an outcome older than the loaded window pins to the window head instead of being dropped", () => {
  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 10 })]);
  const merged = mergeGovernanceDecisions([message(2), message(3)], decisions, events.slice(1));
  assert.equal(merged[0]!.kind, "governance_decision");
  assert.equal(merged.length, 3);
});

test("appending live events keeps existing governance rows in place and adds no duplicates", () => {
  const decisions = governanceDecisions([
    entry({ auditId: "h1", requestId: "hook-1", timestamp: 150 }),
    entry({ auditId: "h2", requestId: "hook-2", timestamp: 250, outcome: "denied" }),
  ]);
  const before = mergeGovernanceDecisions([message(1), message(2)], decisions, events.slice(0, 2));
  const after = mergeGovernanceDecisions([message(1), message(2), message(3)], decisions, events);
  const ids = (items: TimelineItem[]) =>
    items.map((item) => item.kind === "governance_decision" ? `g:${item.decision.auditId}` : `e:${item.id}`);
  assert.deepEqual(ids(before), ["e:1", "g:h1", "e:2", "g:h2"]);
  assert.deepEqual(ids(after), ["e:1", "g:h1", "e:2", "g:h2", "e:3"]);
  // Stable synthetic ids: the row keeps its virtual-list identity (and open disclosure) across
  // refetches of the snapshot.
  assert.deepEqual(
    before.filter((i) => i.kind === "governance_decision").map((i) => i.id),
    after.filter((i) => i.kind === "governance_decision").map((i) => i.id),
  );
});

test("a transcript with no governance activity keeps its array identity", () => {
  const items = [message(1)];
  assert.equal(mergeGovernanceDecisions(items, [], events), items);
});

test("governance history renders every outcome newest-first behind a closed disclosure", () => {
  const decisions = governanceDecisions([
    entry({ auditId: "a", requestId: "hook-a", timestamp: 100 }),
    entry({ auditId: "b", requestId: "hook-b", timestamp: 200, outcome: "denied" }),
    entry({ auditId: "c", requestId: "hook-c", timestamp: 300, stage: "policy_decision", actor: { kind: "policy", id: "deny-shell" }, outcome: "denied" }),
  ]);
  const html = renderToStaticMarkup(React.createElement(GovernanceHistoryPanel, { decisions }));
  assert.deepEqual(
    Array.from(html.matchAll(/data-audit-id="([^"]+)"/g), (match) => match[1]),
    ["c", "b", "a"],
  );
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /Blocked by Policy/);
});

test("a governance row never splits a collapsible work run", () => {
  // Splitting a run would fragment the "Worked" block; only the first fragment keeps the original
  // disclosure key, so an open block would silently collapse its tail when the audit settled.
  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 210 })]);
  const items = [message(1), work(2), work(3), work(4), message(5)];
  const merged = mergeGovernanceDecisions(items, decisions, [
    { seq: 1, ts: 100 }, { seq: 2, ts: 200 }, { seq: 3, ts: 300 }, { seq: 4, ts: 400 }, { seq: 5, ts: 500 },
  ]);
  assert.deepEqual(merged.map((item) => item.kind), [
    "agent_message", "agent_thought", "agent_thought", "agent_thought", "governance_decision", "agent_message",
  ]);
  for (let index = 1; index < merged.length - 1; index += 1) {
    const splitsWork = merged[index]!.kind === "governance_decision" &&
      isCollapsibleWorkItem(merged[index - 1]!) && isCollapsibleWorkItem(merged[index + 1]!);
    assert.equal(splitsWork, false, "a governance row must not land inside a work run");
  }
});

test("a governance row never becomes a work block's boundary", () => {
  // Landing immediately before a run would make the row that block's boundary key instead of the
  // preceding standalone item, which loses the block's disclosure state just as a split does.
  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 110 })]);
  const merged = mergeGovernanceDecisions(
    [message(1), work(2), work(3), message(4)],
    decisions,
    [{ seq: 1, ts: 100 }, { seq: 2, ts: 200 }, { seq: 3, ts: 300 }, { seq: 4, ts: 400 }],
  );
  const governanceIndex = merged.findIndex((item) => item.kind === "governance_decision");
  assert.equal(isCollapsibleWorkItem(merged[governanceIndex + 1]!), false);
});

test("unchanged decisions keep their item identity so the row projector stays incremental", () => {
  // A fresh wrapper per merge would mark every governance slot dirty on every streamed chunk and
  // force a full transcript re-projection for the rest of the session.
  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 150 })]);
  const first = mergeGovernanceDecisions([message(1), message(2)], decisions, events.slice(0, 2));
  const second = mergeGovernanceDecisions([message(1), message(2), message(3)], decisions, events);
  const governanceOf = (items: TimelineItem[]) => items.find((item) => item.kind === "governance_decision");
  assert.equal(governanceOf(first), governanceOf(second));
});

test("anchoring stays well defined when a recovered history steps backwards in time", () => {
  // Hydrated pages validate contiguous seq and a non-negative ts and nothing more, so timestamps
  // are not guaranteed to be non-decreasing. Searching them raw is not merely inaccurate, it is
  // undefined: the answer depends on which slots the search happens to probe. The anchor is the
  // last event at or before the decision, so an outcome never lands before the request it
  // resolves when that request is the latest qualifying event.
  const jumbled = [{ seq: 1, ts: 100 }, { seq: 2, ts: 300 }, { seq: 3, ts: 200 }, { seq: 4, ts: 400 }];
  assert.equal(governanceAnchorSeq(jumbled, 250), 3);
  assert.equal(governanceAnchorSeq(jumbled, 350), 3);
  assert.equal(governanceAnchorSeq(jumbled, 100), 1);
  assert.equal(governanceAnchorSeq(jumbled, 50), Number.NEGATIVE_INFINITY);
  assert.equal(governanceAnchorSeq(jumbled, 400), 4);
  // Well-behaved histories are unaffected.
  assert.equal(governanceAnchorSeq(events, 250), 2);

  // The resolved tool call (seq 3) recorded an earlier timestamp than the message before it; the
  // outcome still follows it.
  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 250 })]);
  const merged = mergeGovernanceDecisions([message(1), message(2), work(3), message(4)], decisions, jumbled);
  assert.deepEqual(merged.map((item) => item.kind), [
    "agent_message", "agent_message", "agent_thought", "governance_decision", "agent_message",
  ]);
});

test("a decision inside a still-growing tail run is held so streamed work stays a pure append", () => {
  // Emitting the row at the tail would make every later work item an insertion in front of it,
  // which knocks the row projector off its append fast path for the rest of the turn.
  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 250 })]);
  const anchors = [{ seq: 1, ts: 100 }, { seq: 2, ts: 200 }, { seq: 3, ts: 300 }, { seq: 4, ts: 400 }, { seq: 5, ts: 500 }];
  const running = { holdTrailingRun: true };
  const first = [message(1), work(2), work(3)];
  assert.equal(mergeGovernanceDecisions(first, decisions, anchors.slice(0, 3), running), first);
  const second = [message(1), work(2), work(3), work(4)];
  assert.equal(mergeGovernanceDecisions(second, decisions, anchors.slice(0, 4), running), second);
  // A standalone row closes the run and the held decision lands before it.
  const third = [message(1), work(2), work(3), work(4), message(5)];
  assert.deepEqual(mergeGovernanceDecisions(third, decisions, anchors, running).map((item) => item.kind), [
    "agent_message", "agent_thought", "agent_thought", "agent_thought", "governance_decision", "agent_message",
  ]);
  // Once the turn has settled, a transcript that ends in a run still shows the outcome.
  assert.deepEqual(mergeGovernanceDecisions(second, decisions, anchors.slice(0, 4)).map((item) => item.kind), [
    "agent_message", "agent_thought", "agent_thought", "agent_thought", "governance_decision",
  ]);
});

test("a row that already landed stays put when the next turn starts before its first event", () => {
  // The status flips to running before the new turn's user message arrives; with unchanged items
  // the hold would otherwise pull an already-visible tail row back out.
  const decisions = governanceDecisions([entry({ auditId: "h", timestamp: 250 })]);
  const anchors = [{ seq: 1, ts: 100 }, { seq: 2, ts: 200 }, { seq: 3, ts: 300 }];
  const items = [message(1), work(2), work(3)];
  const settled = mergeGovernanceDecisions(items, decisions, anchors);
  assert.equal(settled.at(-1)!.kind, "governance_decision");
  const landed = new Set(["h"]);
  const nextTurn = mergeGovernanceDecisions(items, decisions, anchors, { holdTrailingRun: true, landed });
  assert.deepEqual(nextTurn.map((item) => item.kind), settled.map((item) => item.kind));
  assert.equal(nextTurn.at(-1), settled.at(-1), "the landed row keeps its identity");
  // A decision that never landed is still held.
  const fresh = governanceDecisions([entry({ auditId: "h2", requestId: "hook-2", timestamp: 260 })]);
  assert.equal(mergeGovernanceDecisions(items, fresh, anchors, { holdTrailingRun: true, landed }), items);
});
