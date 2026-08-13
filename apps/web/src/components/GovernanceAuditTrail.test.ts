import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import {
  GovernanceAuditOutcomes,
  governanceAuditPresentation,
} from "./GovernanceAuditTrail.js";

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

test("hook governance audit has four visibly distinct user-facing outcomes", () => {
  assert.equal(governanceAuditPresentation(entry({
    stage: "policy_decision",
    outcome: "denied",
    actor: { kind: "policy", id: "deny-shell" },
  }))?.label, "Blocked by Policy");
  assert.equal(governanceAuditPresentation(entry({
    outcome: "denied",
  }))?.label, "Denied by You");
  assert.equal(governanceAuditPresentation(entry({
    outcome: "timed_out",
    actor: { kind: "system", id: "policy-ask-timeout" },
  }))?.label, "Approval Timed Out");
  assert.equal(governanceAuditPresentation(entry({
    outcome: "allowed",
  }))?.label, "Approved by You");
});

test("non-hook audit entries do not appear in the hook outcome strip", () => {
  assert.equal(governanceAuditPresentation(entry({ approvalKind: "permission" })), null);
});

test("governance outcomes render the newest four entries in existing newest-first order", () => {
  const entries = Array.from({ length: 5 }, (_, index) => entry({
    auditId: `audit-newest-${index + 1}`,
    requestId: `hook-${index + 1}`,
    timestamp: 5 - index,
  }));
  const html = renderToStaticMarkup(React.createElement(GovernanceAuditOutcomes, { entries }));

  const renderedIds = Array.from(
    html.matchAll(/data-audit-id="([^"]+)"/g),
    (match) => match[1],
  );
  assert.deepEqual(renderedIds, [
    "audit-newest-1",
    "audit-newest-2",
    "audit-newest-3",
    "audit-newest-4",
  ]);
  assert.doesNotMatch(html, /audit-newest-5/);
});
