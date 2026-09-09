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
import type { TimelineItem } from "./timeline.js";

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
