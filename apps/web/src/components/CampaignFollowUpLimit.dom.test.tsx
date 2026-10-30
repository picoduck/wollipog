import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignBudgetView } from "@wollipog/protocol";
import { api, ApiError } from "../api.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { CampaignFollowUpLimit } from "./CampaignFollowUpLimit.js";
import { followUpLimitText } from "../follow-up-limit.js";
import { WorkflowDecisionSummary } from "./requests/WorkflowDecisionSummary.js";

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const budget = (extra: Partial<CampaignBudgetView> = {}): CampaignBudgetView => ({
  authority: { version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency: 3, acceptedFollowUps: 4 },
  state: "active",
  actual: { costUsd: 0, toolCalls: 0 },
  outstanding: { costUsd: 0, toolCalls: 0 },
  remaining: { costUsd: null, toolCalls: null },
  occupied: 0,
  acceptedFollowUps: 4,
  followUpApprovals: { pending: [{ occurrenceId: "workflow_pending", title: "Retry the merge group on a red main" }], approved: 1 },
  reachedCheckpointsUsd: [],
  enforcement: "admission_and_best_effort_cancellation",
  externalWorkers: "unsupported",
  ...extra,
});

function value(container: HTMLElement, term: string): string {
  const dt = [...container.querySelectorAll("dt")].find((node) => node.textContent === term);
  assert.ok(dt, `${term} is shown`);
  return dt.nextElementSibling!.textContent ?? "";
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label);

function setInput(input: HTMLInputElement, text: string) {
  input.focus();
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new dom.InputEvent("input", { bubbles: true }) as unknown as Event);
  input.dispatchEvent(new dom.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
}

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

test("the follow-up limit reads as a threshold: N of M without approval, the next one needing approval, and what waits", () => {
  assert.equal(followUpLimitText(2, 4), "2 of 4 follow-ups without approval");
  assert.equal(followUpLimitText(1, 1), "1 of 1 follow-up without approval");
  assert.equal(followUpLimitText(3, undefined), "3 follow-ups accepted, no approval limit");
  assert.equal(followUpLimitText(1, null), "1 follow-up accepted, no approval limit");
  // Past the limit, never "4 of 3": what started without approval, and how many are past it.
  assert.equal(followUpLimitText(4, 3), "3 of 3 follow-ups without approval, 1 past the limit");
  assert.equal(followUpLimitText(4, 0), "0 of 0 follow-ups without approval, 4 past the limit");
});

test("Campaign Status shows the limit, pending approvals with their requests, and saves a new limit only through the Human route", async () => {
  const save = api.setCampaignFollowUpLimit;
  const calls: Array<[string, number | null, number]> = [];
  const opened: string[] = [];
  api.setCampaignFollowUpLimit = async (id, limit, revision) => { calls.push([id, limit, revision]); return {} as never; };
  const view = await render(<CampaignFollowUpLimit campaignId="root-1" budget={budget()} policyRevision={7} canEdit
    findRequest={(occurrenceId) => occurrenceId === "workflow_pending" ? "request-key" : null} onOpenRequest={(key) => opened.push(key)} />);
  try {
    const { container } = view;
    assert.equal(container.querySelector("h3")?.textContent, "Follow-Ups");
    assert.equal(value(container, "Follow-Up Limit"),
      "4 of 4 follow-ups without approvalThe next follow-up needs your approval.You approved 1 follow-up past the limit.");
    assert.match(value(container, "Awaiting Your Approval"), /Retry the merge group on a red main/);
    const open = container.querySelector<HTMLButtonElement>("button[aria-label='Open Request: Retry the merge group on a red main']");
    assert.ok(open, "each pending approval opens its request");
    assert.equal(open.className, "btn sm", "a visible secondary button");
    assert.equal(button(container, "Change Limit")!.className, "btn sm", "a visible secondary button, not plain text");
    await act(async () => open.click());
    assert.deepEqual(opened, ["request-key"]);

    await act(async () => button(container, "Change Limit")!.click());
    const input = [...container.querySelectorAll<HTMLInputElement>("input[type=text]")][0]!;
    assert.equal(input.value, "4", "starts from the current limit");
    assert.equal(container.querySelector("legend")?.textContent, "Change Follow-Up Limit");
    assert.match(container.textContent ?? "", /Lowering it keeps follow-ups already accepted\. Saving re-authorizes Full Control\. Any request or approval the Orchestrator hasn't used yet is withdrawn, and it asks again\./);
    await act(async () => setInput(input, "-2"));
    await act(async () => button(container, "Save Limit")!.click());
    assert.match(container.querySelector("[role=alert]")?.textContent ?? "", /Enter a whole number from 0 to 1000, or choose No Limit\./);
    assert.equal(calls.length, 0, "an invalid limit is never sent");

    await act(async () => setInput(input, "6"));
    await act(async () => button(container, "Save Limit")!.click());
    assert.deepEqual(calls, [["root-1", 6, 7]], "compare-and-set on the shown policy revision");
    assert.ok(button(container, "Change Limit"), "the editor closes once the server accepts it");
    assertNoDomNode(container.querySelector("[role=alert]"), "nothing failed");

    await act(async () => button(container, "Change Limit")!.click());
    const noLimit = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => noLimit.click());
    assert.equal(container.querySelector<HTMLInputElement>("input[type=text]")!.disabled, true, "No Limit replaces the number");
    await act(async () => button(container, "Save Limit")!.click());
    assert.deepEqual(calls.at(-1), ["root-1", null, 7], "No Limit clears it");
  } finally {
    view.unmount();
    api.setCampaignFollowUpLimit = save;
  }
});

test("a refused change keeps the editor open with the server's reason, and a member's view offers no editor", async () => {
  const save = api.setCampaignFollowUpLimit;
  api.setCampaignFollowUpLimit = async () => { throw new ApiError("Campaign authority changed; refresh and try again.", 409); };
  const editable = await render(<CampaignFollowUpLimit campaignId="root-1" budget={budget({ followUpApprovals: { pending: [], approved: 0 } })}
    policyRevision={7} canEdit findRequest={() => null} onOpenRequest={() => {}} />);
  try {
    const { container } = editable;
    assert.equal(value(container, "Awaiting Your Approval"), "None");
    await act(async () => button(container, "Change Limit")!.click());
    await act(async () => button(container, "Save Limit")!.click());
    const alert = container.querySelector("[role=alert]");
    assert.match(alert?.textContent ?? "", /Couldn't Change the Follow-Up Limit/);
    assert.match(alert?.textContent ?? "", /Campaign authority changed; refresh and try again\./);
    assert.ok(button(container, "Save Limit"), "still editing");
  } finally {
    editable.unmount();
    api.setCampaignFollowUpLimit = save;
  }
  const member = await render(<CampaignFollowUpLimit campaignId="root-1" budget={budget({ authority: { version: 1, accounting: "managed_workers_only",
    unpriced: "stop", concurrency: 3 }, acceptedFollowUps: 9, followUpApprovals: { pending: [], approved: 0 } })} policyRevision={7} canEdit={false} findRequest={() => null} onOpenRequest={() => {}} />);
  try {
    assert.equal(value(member.container, "Follow-Up Limit"), "9 follow-ups accepted, no approval limit");
    assert.equal(button(member.container, "Change Limit"), undefined, "only the campaign's own session edits it");
  } finally {
    member.unmount();
  }
});

test("the Human's request card names the one follow-up an approval admits, its issue and the limit it passed", async () => {
  const view = await render(<WorkflowDecisionSummary snapshot={{ category: "campaign_follow_up_admission",
    subject: { kind: "recommendation", recommendationId: "rec_123" }, title: "Retry <the> merge group",
    issue: { repository: "picoduck/wollipog", number: 3770 }, identityDigest: "d".repeat(64), acceptedFollowUps: 4, limit: 4 }} />);
  try {
    assert.equal(value(view.container, "Follow-Up"), "Retry <the> merge group", "the title is text, never markup");
    assert.equal(value(view.container, "Issue"), "picoduck/wollipog#3770");
    assert.equal(value(view.container, "Follow-Up Limit"), "4 of 4 follow-ups without approval");
    assert.doesNotMatch(view.container.textContent ?? "", /rec_123/, "the raw id stays under Request Details");
    assert.match(view.container.textContent ?? "", /Approving admits only this follow-up\./);
  } finally {
    view.unmount();
  }
  const change = await render(<WorkflowDecisionSummary snapshot={{ category: "campaign_follow_up_admission",
    subject: { kind: "work_item", key: "follow-up-2" }, title: "A New Title", issue: null, identityDigest: "e".repeat(64), acceptedFollowUps: 6, limit: null, revises: "workflow_1" }} />);
  try {
    assert.equal(value(change.container, "Follow-Up Limit"), "6 follow-ups accepted, no approval limit");
    assert.equal([...change.container.querySelectorAll("dt")].some((dt) => dt.textContent === "Issue"), false, "no issue, no row");
    assert.match(change.container.textContent ?? "", /Approving this change lets the Orchestrator give it this title and issue\./);
  } finally {
    change.unmount();
  }
  // Another recommendation accepted into an admitted follow-up names both and says what it replaces (CR-2.1).
  const rebinding = await render(<WorkflowDecisionSummary snapshot={{ category: "campaign_follow_up_admission",
    subject: { kind: "recommendation", recommendationId: "rec_b" }, title: "Retry the merge group on a red main", issue: null,
    recommendationTitle: "Delete every stale branch", identityDigest: "f".repeat(64), acceptedFollowUps: 2, limit: 1,
    revises: "workflow_a", rebinds: true }} />);
  try {
    const text = rebinding.container.textContent ?? "";
    assert.match(text, /Replaces the approved follow-up “?Retry the merge group on a red main”? with the recommendation “?Delete every stale branch”?\./u);
    assert.equal(value(rebinding.container, "Recommendation"), "Delete every stale branch");
    assert.equal(value(rebinding.container, "Approved Follow-Up"), "Retry the merge group on a red main");
    assert.equal(value(rebinding.container, "Follow-Up Limit"), "1 of 1 follow-up without approval, 1 past the limit", "never 2 of 1");
    assert.match(text, /accept this recommendation as that follow-up's work instead\./);
    assert.doesNotMatch(text, /give it this title and issue/, "it is not described as a title or issue change");
    assert.doesNotMatch(text, /rec_b|workflow_a/, "ids stay under Request Details");
  } finally {
    rebinding.unmount();
  }
});

test("Campaign Status past the limit shows what started without approval and how many are past it, never 5 of 4", async () => {
  const view = await render(<CampaignFollowUpLimit campaignId="root-1" budget={budget({ acceptedFollowUps: 5 })} policyRevision={7}
    canEdit={false} findRequest={() => null} onOpenRequest={() => {}} />);
  try {
    assert.equal(value(view.container, "Follow-Up Limit"),
      "4 of 4 follow-ups without approval, 1 past the limitThe next follow-up needs your approval.You approved 1 follow-up past the limit.");
  } finally {
    view.unmount();
  }
});

test("the request card names a GitLab issue as the work ledger does (CR-4.1)", async () => {
  const view = await render(<WorkflowDecisionSummary snapshot={{ category: "campaign_follow_up_admission",
    subject: { kind: "work_item", key: "follow-up-gitlab" }, title: "Fix the GitLab runner",
    issue: { repository: "gitlab.com/team/project", number: 7 }, identityDigest: "c".repeat(64), acceptedFollowUps: 1, limit: 1 }} />);
  try {
    assert.equal(value(view.container, "Issue"), "gitlab.com/team/project#7");
  } finally {
    view.unmount();
  }
});
