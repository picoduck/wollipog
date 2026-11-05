import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignIssueScopeView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { CampaignIssueScopePanel, SCOPE_RECONNECT_POLL_MS } from "./CampaignIssueScopePanel.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};

const DISCONNECTED = "The campaign runner is disconnected. Saved issue scope is shown; reconnect the runner to verify the repository and request changes.";
const view = (overrides: Partial<CampaignIssueScopeView> = {}): CampaignIssueScopeView => ({
  campaignSessionId: "s_root", repository: "team/repo", issueNumbers: [12], revision: 3, supported: true, canPropose: true,
  outsideScope: [], candidates: [], ...overrides });
const offline = (overrides: Partial<CampaignIssueScopeView> = {}) =>
  view({ supported: false, runnerDisconnected: true, compatibilityMessage: DISCONNECTED, ...overrides });

/** Mounts the panel over a queue of answers; the last one repeats. The panel's reconnect timer is
 * captured instead of scheduled, so a test fires it on demand. */
async function mount(answers: Array<CampaignIssueScopeView | Error | Promise<CampaignIssueScopeView>>) {
  let calls = 0;
  const timers = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 1;
  const original = { set: domWindow.setInterval, clear: domWindow.clearInterval };
  domWindow.setInterval = ((run: () => void, ms: number) => { timers.set(nextTimer, { run, ms }); return nextTimer++; }) as unknown as typeof domWindow.setInterval;
  domWindow.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof domWindow.clearInterval;
  const client = {
    ...api,
    campaignIssueScope: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as ApiClient;
  // The revision never changes: reconnection alone must refresh the mounted panel.
  const session = { id: "s_root", orchestratorPolicy: { issueScope: { revision: 3 } } } as unknown as SessionView;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ApiProvider client={client}><CampaignIssueScopePanel session={session} campaignId="s_root" /></ApiProvider>); });
  await settle();
  return {
    host, calls: () => calls, timers,
    tick: async () => { for (const timer of [...timers.values()]) await act(async () => timer.run()); await settle(); },
    unmount: async () => {
      await act(async () => root.unmount());
      domWindow.setInterval = original.set;
      domWindow.clearInterval = original.clear;
    },
  };
}

const facts = (host: HTMLElement) => Object.fromEntries([...host.querySelectorAll("dl.facts > div")].map((row) =>
  [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]));
const notice = (host: HTMLElement, title: string) => [...host.querySelectorAll(".notice")].find((node) => node.textContent?.includes(title));
const button = (root: Element, name: string) => [...root.querySelectorAll("button")].find((node) => node.textContent === name);

test("a mounted panel showing a disconnected runner's saved scope recovers after reconnection at the same revision (#2664)", async () => {
  const panel = await mount([offline(), offline(), view()]);
  try {
    assert.equal(panel.calls(), 1);
    assert.deepEqual(facts(panel.host), { "Repository": "team/repo", "Scope Revision": "3", "Authorized Issues": "team/repo#12" },
      "saved membership and its revision stay readable offline");
    assert.ok(notice(panel.host, "Scope Changes Unavailable"));
    assert.deepEqual([...panel.timers.values()].map((timer) => timer.ms), [SCOPE_RECONNECT_POLL_MS]);
    await panel.tick();
    assert.equal(panel.calls(), 2, "still disconnected: the panel keeps polling");
    assert.equal(panel.timers.size, 1);
    await panel.tick();
    assert.equal(panel.calls(), 3);
    assert.equal(notice(panel.host, "Scope Changes Unavailable"), undefined, "the reconnected view is verified again");
    assert.ok(button(panel.host, "Request Scope Approval"));
    assert.equal(panel.timers.size, 0, "a verified view stops polling");
  } finally { await panel.unmount(); }
});

test("a poll never cancels a reconnected runner's inspection that outlasts the interval (#2664)", async () => {
  let finish!: (value: CampaignIssueScopeView) => void;
  const slow = new Promise<CampaignIssueScopeView>((resolve) => { finish = resolve; });
  const panel = await mount([offline(), slow]);
  try {
    await panel.tick();
    assert.equal(panel.calls(), 2, "the first poll starts the reconnected read");
    for (let i = 0; i < 3; i += 1) await panel.tick();
    assert.equal(panel.calls(), 2, "polls wait for the read in flight instead of aborting it");
    await act(async () => finish(view()));
    await settle();
    assert.equal(notice(panel.host, "Scope Changes Unavailable"), undefined, "the slow inspection's answer is shown");
    assert.ok(button(panel.host, "Request Scope Approval"));
    assert.equal(panel.timers.size, 0);
  } finally { await panel.unmount(); }
});

test("a returning tab refreshes a disconnected panel at once, and a hidden one does not poll (#2664)", async () => {
  const panel = await mount([offline(), view()]);
  const visibility = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document), "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await panel.tick();
    assert.equal(panel.calls(), 1, "a hidden tab does not poll");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => { document.dispatchEvent(new domWindow.Event("visibilitychange") as unknown as Event); });
    await settle();
    assert.equal(panel.calls(), 2);
    assert.equal(notice(panel.host, "Scope Changes Unavailable"), undefined);
  } finally {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    if (visibility) Object.defineProperty(Object.getPrototypeOf(document), "visibilityState", visibility);
    await panel.unmount();
  }
});

test("unavailable and failed states each offer one accessible Refresh Scope action (#2664)", async () => {
  const panel = await mount([offline(), new Error("Campaign scope inspection requires an online runner with GitHub access. Reconnect the runner and retry."), view()]);
  try {
    const unavailable = notice(panel.host, "Scope Changes Unavailable")!;
    const refresh = button(unavailable, "Refresh Scope");
    assert.ok(refresh, "the unavailable notice offers Refresh Scope");
    assert.equal(refresh.getAttribute("type"), "button");
    await act(async () => { refresh.click(); });
    await settle();
    assert.equal(panel.calls(), 2);
    const failed = notice(panel.host, "Couldn't Load or Update Issue Scope")!;
    assert.equal(failed.getAttribute("role"), "alert");
    assert.equal([...panel.host.querySelectorAll("button")].filter((node) => node.textContent === "Refresh Scope").length, 1,
      "the failure's action replaces the unavailable notice's, never duplicating the accessible name");
    await act(async () => { button(failed, "Refresh Scope")!.click(); });
    await settle();
    assert.equal(panel.calls(), 3);
    assert.equal(notice(panel.host, "Couldn't Load or Update Issue Scope"), undefined);
    assert.ok(button(panel.host, "Request Scope Approval"));
  } finally { await panel.unmount(); }
});

test("an unknown repository shows saved numbers and their work as unverified, apart from confirmed outside-scope work (#2664)", async () => {
  const panel = await mount([offline({ repository: "", revision: 0,
    unverifiedWork: [{ workItemId: "w_member", title: "Member work", issue: { repository: "team/repo", number: 12 }, sessionId: null }],
    outsideScope: [{ workItemId: "w_stray", title: "Stray work", issue: { repository: "team/repo", number: 99 }, sessionId: null }] })]);
  try {
    assert.deepEqual(facts(panel.host), { "Repository": "Not Verified", "Scope Revision": "0", "Authorized Issues": "#12" },
      "saved numbers stay readable without implying a verified repository");
    assert.match(notice(panel.host, "Repository Not Verified")!.textContent!, /not confirmed to belong to any repository/u);
    const unverified = notice(panel.host, "Work Awaiting Repository Verification")!;
    assert.match(unverified.textContent!, /team\/repo#12: Member work/u);
    assert.match(unverified.textContent!, /neither confirmed in scope nor outside it/u);
    const outside = notice(panel.host, "Work Outside Authorized Scope")!;
    assert.match(outside.textContent!, /team\/repo#99: Stray work/u);
    assert.doesNotMatch(outside.textContent!, /#12/u, "an unknown repository alone is no mismatch");
  } finally { await panel.unmount(); }
});

test("a known repository shows no unverified notices (#2664)", async () => {
  const panel = await mount([view({ outsideScope: [{ workItemId: "w_other", title: "Other work", issue: { repository: "other/repo", number: 12 }, sessionId: null }] })]);
  try {
    assert.equal(notice(panel.host, "Repository Not Verified"), undefined);
    assert.equal(notice(panel.host, "Work Awaiting Repository Verification"), undefined);
    assert.match(notice(panel.host, "Work Outside Authorized Scope")!.textContent!, /other\/repo#12: Other work/u);
    assert.equal(panel.timers.size, 0, "a verified view never polls");
  } finally { await panel.unmount(); }
});
