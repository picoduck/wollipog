import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignIssueScopeRequest, CampaignIssueScopeView, SessionView, WorkflowDecisionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { CampaignIssueScopePanel } from "./CampaignIssueScopePanel.js";

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

const view = (overrides: Partial<CampaignIssueScopeView> = {}): CampaignIssueScopeView => ({
  campaignSessionId: "s_root", repository: "team/repo", issueNumbers: [31, 32, 33], revision: 2, supported: true, canPropose: true,
  outsideScope: [], candidates: [], contextIssueNumbers: [90, 91], ...overrides });

async function mount(scope: CampaignIssueScopeView) {
  const proposals: CampaignIssueScopeRequest[] = [];
  const client = {
    ...api,
    campaignIssueScope: async () => scope,
    proposeCampaignIssueScope: async (_id: string, request: CampaignIssueScopeRequest) => {
      proposals.push(request);
      return { status: "pending" } as WorkflowDecisionView;
    },
  } as ApiClient;
  const session = { id: "s_root", orchestratorPolicy: { issueScope: { revision: scope.revision } } } as unknown as SessionView;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ApiProvider client={client}><CampaignIssueScopePanel session={session} campaignId="s_root" /></ApiProvider>); });
  await settle();
  return { host, proposals, unmount: () => act(async () => root.unmount()) };
}

const facts = (host: HTMLElement) => Object.fromEntries([...host.querySelectorAll("dl.facts > div")].map((row) =>
  [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]));

const contextGroup = (host: HTMLElement) => [...host.querySelectorAll("[role=group]")].find((group) =>
  document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent === "Context-Only References");

test("Campaign Status shows the derived scope beside the first message's context-only references, and promotes one through scope approval (#3920)", async () => {
  const { host, proposals, unmount } = await mount(view());
  try {
    // The owner sees the context list once: as the selectable group, not also as a fact row.
    assert.deepEqual(facts(host), { "Repository": "team/repo", "Scope Revision": "2", "Authorized Issues": "team/repo#31, team/repo#32, team/repo#33" });
    const group = contextGroup(host);
    assert.ok(group, "the owner can select a context reference");
    assert.equal(host.textContent!.split("Context-Only References").length - 1, 1);
    assert.match(document.getElementById(group.getAttribute("aria-describedby")!)!.textContent!, /grant no authority/u);
    assert.equal(group.querySelectorAll("input[type=checkbox]").length, 2);
    const box = [...group.querySelectorAll("input[type=checkbox]")].find((input) => input.closest("label")?.textContent?.includes("team/repo#90")) as HTMLInputElement;
    assert.ok(box);
    await act(async () => { box.click(); });
    const removals = [...host.querySelectorAll("label.field")].find((label) => label.textContent?.startsWith("Issue Removals"))!.querySelector("input")!;
    await act(async () => {
      removals.focus();
      Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(removals, "team/repo#33");
      removals.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      removals.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    const request = [...host.querySelectorAll("button")].find((button) => button.textContent === "Request Scope Approval")!;
    await act(async () => { request.click(); });
    await settle();
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0]!.additions, [{ repository: "team/repo", number: 90 }]);
    assert.deepEqual(proposals[0]!.removals, [{ repository: "team/repo", number: 33 }]);
    assert.equal(proposals[0]!.expectedRevision, 2);
  } finally { await unmount(); }
});

test("someone who cannot propose reads the context-only references as a fact row, without a selection (#3920)", async () => {
  const { host, unmount } = await mount(view({ canPropose: false }));
  try {
    assert.equal(facts(host)["Context-Only References"], "team/repo#90, team/repo#91");
    assert.equal(contextGroup(host), undefined);
    assert.equal(host.querySelectorAll("input[type=checkbox]").length, 0);
  } finally { await unmount(); }
});

test("a campaign with no context-only references shows neither the row nor the selection (#3920)", async () => {
  const { host, unmount } = await mount(view({ contextIssueNumbers: undefined }));
  try {
    assert.equal("Context-Only References" in facts(host), false);
    assert.equal(contextGroup(host), undefined);
  } finally { await unmount(); }
});
