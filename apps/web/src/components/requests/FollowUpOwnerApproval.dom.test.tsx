import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { api } from "../../api.js";
import { installDomTestCleanup } from "../../dom-test-cleanup.js";
import { FollowUpOwnerApproval } from "./FollowUpOwnerApproval.js";

const dom = new Window({ url: "http://localhost/" });
installDomTestCleanup(dom);
for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  React, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const session = { id: "root", status: "running", runnerId: "runner" } as SessionView;
const publication = (id: string): PendingApproval => ({ requestId: id, occurrenceId: id, kind: "workflow_decision", title: "Publication", options: [],
  workflowDecision: { requestId: id, occurrenceId: id, sessionId: "root", controllingSessionId: "root", category: "follow_up_issue_publication",
    resourceKey: id, resourceDigest: id, policyRevision: 1, authority: "human", status: "pending", createdAt: Date.now(),
    resourceSnapshot: { category: "follow_up_issue_publication", repository: "picoduck/wollipog", sanitizedTitle: `Track ${id}`,
      sanitizedBody: `Exact body for ${id}\n\n\`literal\` <body>`, labels: ["bug"] } } });
const admission = (id = "admission"): PendingApproval => {
  const request = publication(id);
  return { ...request, workflowDecision: { ...request.workflowDecision!, category: "campaign_follow_up_admission",
    resourceSnapshot: { category: "campaign_follow_up_admission", subject: { kind: "work_item", key: id },
      title: "Retry Publication", issue: null, acceptedFollowUps: 1, limit: 1, identityDigest: "d".repeat(64) } } };
};
const button = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => label.test(node.textContent ?? ""))!;
async function mount(requests: PendingApproval[]) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = async (next: PendingApproval[]) => { await act(async () => root.render(<FollowUpOwnerApproval session={session} requests={next} />)); };
  await render(requests);
  return { render, close: () => { act(() => root.unmount()); container.remove(); } };
}

test("one Owner Approval shows exact mixed payloads and approves only the frozen occurrences individually", async () => {
  const saved = api.approve;
  const calls: string[] = [];
  api.approve = async (id, request) => { assert.equal(id, "root"); assert.equal(request.optionId, "approve"); calls.push(request.requestId); return session; };
  const originals = [admission(), admission("second-admission"), publication("one"), publication("two")];
  const view = await mount(originals);
  try {
    await act(async () => button(/^Review 4/).click());
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent!, /Owner Approval/);
    assert.match(dialog.textContent!, /Retry Publication/);
    assert.deepEqual([...dialog.querySelectorAll("pre")].map(node => node.textContent), ["Exact body for one\n\n`literal` <body>", "Exact body for two\n\n`literal` <body>"]);
    assert.match(dialog.textContent!, /picoduck\/wollipog/);
    assert.match(dialog.textContent!, /bug/);
    await view.render([...originals, publication("late")]);
    assert.doesNotMatch(dialog.textContent!, /Track late/);
    await act(async () => button(/^Approve All 4/).click());
    assert.deepEqual(calls, ["admission", "second-admission", "one", "two"]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { view.close(); api.approve = saved; }
});

test("a partial or uncertain result stops the batch, reports confirmed approvals and refuses blind replay", async () => {
  const saved = api.approve;
  const calls: string[] = [];
  api.approve = async (_id, request) => { calls.push(request.requestId); if (calls.length === 2) throw new Error("response lost"); return session; };
  const view = await mount([publication("one"), publication("two"), publication("three")]);
  try {
    await act(async () => button(/^Review 3/).click());
    await act(async () => { const approve = button(/^Approve All 3/); approve.click(); approve.click(); });
    assert.deepEqual(calls, ["one", "two"], "no duplicate click and nothing after an uncertain result");
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /1 of 3 approvals were confirmed/);
    assert.equal(button(/^Approve All 3/).disabled, true);
  } finally { view.close(); api.approve = saved; }
});

test("Orchestrator-owned and non-follow-up gates are not included in the owner review", async () => {
  const orchestrator = publication("orchestrator"); orchestrator.workflowDecision!.authority = "orchestrator";
  const view = await mount([admission(), orchestrator, { requestId: "permission", kind: "permission", title: "Run Command", options: [] }]);
  try { assert.equal(button(/^Review/), undefined); } finally { view.close(); }
});

test("a frozen review stops if a live card is removed or its occurrence or digest changes", async () => {
  const saved = api.approve;
  const calls: string[] = [];
  api.approve = async (_id, request) => { calls.push(request.requestId); return session; };
  try {
    for (const change of ["removed", "occurrence", "digest"] as const) {
      calls.length = 0;
      const original = publication("one");
      const view = await mount([original, publication("two")]);
      try {
        await act(async () => button(/^Review 2/).click());
        const replacement = publication("one");
        if (change === "occurrence") replacement.workflowDecision!.occurrenceId = "replacement";
        if (change === "digest") replacement.workflowDecision!.resourceDigest = "replacement";
        await view.render(change === "removed" ? [publication("two")] : [replacement, publication("two")]);
        await act(async () => button(/^Approve All 2/).click());
        assert.deepEqual(calls, [], change);
        assert.equal(button(/^Approve All 2/).disabled, true);
      } finally { view.close(); }
    }
  } finally { api.approve = saved; }
});
