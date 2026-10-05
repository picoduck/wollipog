import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { decisionHistory, type GovernanceDecision } from "../governance.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";
import {
  DECISION_HISTORY_SKELETON_DELAY_MS,
  decisionDayLabel,
  DecisionHistoryPanel,
  filterDecisions,
} from "./DecisionHistoryPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

installDomTestCleanup(domWindow);

const NOW = new Date(2026, 9, 5, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const viewer: ViewerIdentity = { userId: "user-ada", shared: false, names: new Map() };

function entry(overrides: Partial<GovernanceAuditEntry>): GovernanceAuditEntry {
  return {
    auditId: "audit",
    requestId: "request",
    approvalKind: "permission",
    stage: "resolution",
    outcome: "allowed",
    actor: { kind: "human", id: "user-ada" },
    scope: { sessionId: "session-1", runnerId: "runner-1" },
    timestamp: NOW,
    ...overrides,
  };
}

/** A person allowed one permission, rejected another and answered a question; a policy blocked a tool. */
const fourDecisions = decisionHistory([
  entry({ auditId: "allow", requestId: "perm-allow", timestamp: NOW - 4 * HOUR }),
  entry({ auditId: "reject", requestId: "perm-reject", outcome: "denied", timestamp: NOW - 3 * HOUR }),
  entry({ auditId: "answer", requestId: "question-1", approvalKind: "question", outcome: "answered", timestamp: NOW - 2 * HOUR }),
  entry({
    auditId: "block", requestId: "hook-1", approvalKind: "policy_hook", stage: "policy_decision", outcome: "denied",
    actor: { kind: "policy", id: "deny-shell" }, governancePolicyId: "deny-shell", timestamp: NOW - HOUR,
  }),
]);

async function mount(element: React.ReactElement): Promise<{ container: HTMLElement; root: Root; dispose: () => Promise<void> }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ViewerIdentityContext.Provider value={viewer}>{element}</ViewerIdentityContext.Provider>);
  });
  return {
    container,
    root,
    dispose: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const outcomes = (container: HTMLElement) =>
  [...container.querySelectorAll(".tl-decision-outcome")].map((node) => node.textContent);

function filterTo(container: HTMLElement, label: string) {
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((candidate) => candidate.textContent === label);
  assert.ok(option, `the ${label} filter exists`);
  option.click();
}

test("Decision History lists every decision newest first, and filters to You or Policies (#2213)", async () => {
  const view = await mount(<DecisionHistoryPanel decisions={fourDecisions} now={NOW} />);
  try {
    assert.deepEqual(outcomes(view.container), ["Blocked", "Answered", "Rejected", "Allowed"]);
    assert.equal(view.container.querySelectorAll("details.tl-decision").length, 4, "rows are Decision Records");
    const group = view.container.querySelector('[role="radiogroup"]');
    assert.ok(group);
    assert.deepEqual([...group.querySelectorAll('[role="radio"]')].map((option) => option.textContent), ["All", "You", "Policies"]);

    await act(async () => filterTo(view.container, "You"));
    assert.deepEqual(outcomes(view.container), ["Answered", "Rejected", "Allowed"]);
    await act(async () => filterTo(view.container, "Policies"));
    assert.deepEqual(outcomes(view.container), ["Blocked"]);
    await act(async () => filterTo(view.container, "All"));
    assert.equal(outcomes(view.container).length, 4);
  } finally {
    await view.dispose();
  }
});

test("the filter is kept while the panel stays open as decisions refresh", async () => {
  function Refreshing() {
    const [decisions, setDecisions] = useState<readonly GovernanceDecision[]>(fourDecisions.slice(0, 3));
    return <>
      <button type="button" id="refresh" onClick={() => setDecisions(fourDecisions)}>Refresh</button>
      <DecisionHistoryPanel decisions={decisions} now={NOW} />
    </>;
  }
  const view = await mount(<Refreshing />);
  try {
    await act(async () => filterTo(view.container, "Policies"));
    assert.deepEqual(outcomes(view.container), []);
    await act(async () => view.container.querySelector<HTMLButtonElement>("#refresh")!.click());
    assert.deepEqual(outcomes(view.container), ["Blocked"]);
  } finally {
    await view.dispose();
  }
});

test("another member's decision is not the viewer's in a shared organization", () => {
  const shared: ViewerIdentity = { userId: "user-ada", shared: true, names: new Map([["user-grace", "Grace Hopper"]]) };
  const decisions = decisionHistory([
    entry({ auditId: "mine", requestId: "mine" }),
    entry({ auditId: "theirs", requestId: "theirs", actor: { kind: "human", id: "user-grace" }, timestamp: NOW + 1 }),
  ]);
  assert.deepEqual(filterDecisions(decisions, "you", shared).map((decision) => decision.auditId), ["mine"]);
  assert.deepEqual(filterDecisions(decisions, "policies", shared), []);
  assert.deepEqual(filterDecisions(decisions, "you", null).map((decision) => decision.auditId), ["mine", "theirs"],
    "before the viewer is known, a person's decision reads as the viewer's, as its row's by You does");
});

test("rows are grouped under Today, Yesterday and then the date", async () => {
  const decisions = decisionHistory([
    entry({ auditId: "older", requestId: "older", timestamp: NOW - 3 * 24 * HOUR }),
    entry({ auditId: "yesterday", requestId: "yesterday", timestamp: NOW - 24 * HOUR }),
    entry({ auditId: "today", requestId: "today", timestamp: NOW - HOUR }),
  ]);
  const view = await mount(<DecisionHistoryPanel decisions={decisions} now={NOW} />);
  try {
    const headers = [...view.container.querySelectorAll(".decision-history-day-label")].map((node) => node.textContent);
    assert.deepEqual(headers, ["Today", "Yesterday", decisionDayLabel(NOW - 3 * 24 * HOUR, NOW)]);
    assert.doesNotMatch(headers[2]!, /Today|Yesterday/);
  } finally {
    await view.dispose();
  }
});

test("an open row offers Show in Transcript and Copy Audit ID, and Show in Transcript reveals the request's row", async () => {
  const shown: number[] = [];
  const view = await mount(<DecisionHistoryPanel
    decisions={fourDecisions}
    now={NOW}
    transcriptItemFor={(decision) => decision.requestId === "perm-reject" ? 42 : undefined}
    onShowInTranscript={(itemId) => shown.push(itemId)}
  />);
  try {
    const rows = [...view.container.querySelectorAll<HTMLDetailsElement>("details.tl-decision")];
    const rejected = rows.find((row) => row.dataset.auditId === "reject")!;
    const actions = [...rejected.querySelectorAll<HTMLButtonElement>(".tl-decision-actions button")];
    assert.deepEqual(actions.map((button) => button.textContent), ["Show in Transcript", "Copy Audit ID"]);
    await act(async () => actions[0]!.click());
    assert.deepEqual(shown, [42]);

    const allowed = rows.find((row) => row.dataset.auditId === "allow")!;
    const show = allowed.querySelector<HTMLButtonElement>(".tl-decision-actions button")!;
    assert.equal(show.getAttribute("aria-disabled"), "true");
    const reason = domWindow.document.getElementById(show.getAttribute("aria-describedby")!);
    assert.equal(reason?.textContent, "Not in the loaded transcript.");
    await act(async () => show.click());
    assert.deepEqual(shown, [42], "an unavailable row reveals nothing");
  } finally {
    await view.dispose();
  }
});

test("Load Older Decisions keeps its label while loading", async () => {
  const view = await mount(<DecisionHistoryPanel decisions={fourDecisions} now={NOW} hasMore loadingOlder onLoadOlder={() => {}} />);
  try {
    const more = view.container.querySelector<HTMLButtonElement>(".decision-history-more")!;
    assert.equal(more.textContent, "Load Older Decisions");
    assert.ok(more.classList.contains("btn") && more.classList.contains("sm"));
    assert.equal(more.getAttribute("aria-busy"), "true");
    assert.equal(more.getAttribute("aria-disabled"), "true");
    assert.equal(more.disabled, false, "focus stays on the control while it loads");
    assert.match(view.container.textContent ?? "", /Loading older decisions…/, "the progress is announced");
  } finally {
    await view.dispose();
  }
});

test("with no decisions the panel shows No Decisions Yet", async () => {
  const view = await mount(<DecisionHistoryPanel decisions={[]} />);
  try {
    assert.equal(view.container.querySelector(".state-title")?.textContent, "No Decisions Yet");
    assert.match(view.container.textContent ?? "", /Decisions you and your approval policies make in this session appear here\./);
    assertNoDomNode(view.container.querySelector('[role="radiogroup"]'), "nothing to filter");
  } finally {
    await view.dispose();
  }
});

test("a failed load is a danger notice with Retry", async () => {
  let retried = 0;
  const view = await mount(<DecisionHistoryPanel decisions={[]} status="error" onRetry={() => { retried += 1; }} />);
  try {
    const notice = view.container.querySelector(".notice.t-danger");
    assert.ok(notice);
    assert.equal(notice.getAttribute("role"), "alert");
    const retry = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    assert.equal(retried, 1);
  } finally {
    await view.dispose();
  }
});

test("loading renders nothing for 300ms, then skeleton rows", async () => {
  const view = await mount(<DecisionHistoryPanel decisions={[]} status="loading" />);
  try {
    assertNoDomNode(view.container.querySelector(".skeleton"), "nothing new before 300ms");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, DECISION_HISTORY_SKELETON_DELAY_MS + 50)); });
    const skeleton = view.container.querySelector(".decision-history-skeleton");
    assert.ok(skeleton);
    assert.equal(skeleton.querySelectorAll(".skeleton-row").length, 4);
    assert.match(skeleton.textContent ?? "", /Loading decisions…/);
  } finally {
    await view.dispose();
  }
});
