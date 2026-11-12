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
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
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

for (const repository of ["team/repo", "gitlab.example/team/repo", "gitlab.example/group/subgroup/project"]) {
  test(`typed additions and removals match ${repository} exactly, ignoring case (#4248)`, async () => {
    const { host, proposals, unmount } = await mount(view({ repository, contextIssueNumbers: undefined }));
    const type = async (label: string, value: string) => act(async () => {
      const input = [...host.querySelectorAll("label.field")].find((node) => node.textContent?.startsWith(label))!.querySelector("input")!;
      input.focus();
      Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    const submit = async () => {
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Request Scope Approval")!.click(); });
      await settle();
    };
    try {
      await type("Issue Additions", `${repository.toUpperCase()}#54, ${repository}#54 ${repository}#55`);
      await type("Issue Removals", `${repository.toUpperCase()}#33`);
      await submit();
      assert.equal(proposals.length, 1);
      assert.deepEqual(proposals[0]!.additions, [{ repository, number: 54 }, { repository, number: 55 }]);
      assert.deepEqual(proposals[0]!.removals, [{ repository, number: 33 }]);
      assert.equal(proposals[0]!.expectedRevision, 2);
      // Invalid entries prevent the entire request, including valid entries in the other field.
      for (const label of ["Issue Additions", "Issue Removals"]) {
        for (const invalid of [
          `prefix${repository}#54`, `${repository}suffix#54`, `${repository}/extra#54`, "other/repo#54",
          `${repository}//extra#54`, `${repository}/#54`, `/${repository}#54`,
          `${repository}#0`, `${repository}#01`, `${repository}#-1`, `${repository}#1.5`,
          `${repository}#9007199254740992`, `${repository}#54junk`, `${repository}##54`,
          `https://${repository}#54`, "#54",
        ]) {
          await type("Issue Additions", `${repository}#56`);
          await type("Issue Removals", `${repository}#31`);
          await type(label, invalid);
          await submit();
          assert.equal(proposals.length, 1, `${label}: ${invalid}`);
          assert.ok(host.querySelector("[role=alert]")!.textContent!.includes(
            `Use repository-qualified issues from ${repository}, such as ${repository}#123.`), invalid);
        }
      }
    } finally { await unmount(); }
  });
}

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

test("an epic is resolved in the chosen repository, and its members are selected by repository, not number (#4118)", async () => {
  const resolved = view({ repository: "owner/app", issueNumbers: [5], contextIssueNumbers: undefined,
    repositories: [{ repository: "owner/app", issueNumbers: [5], state: "verified" }, { repository: "owner/api", issueNumbers: [], state: "verified" }],
    candidates: [{ issue: { repository: "owner/api", number: 5 }, title: "Same number, another issue", source: "umbrella" }] });
  const reads: unknown[][] = [];
  const proposals: CampaignIssueScopeRequest[] = [];
  const client = { ...api,
    campaignIssueScope: async (...args: unknown[]) => { reads.push(args); return { ...resolved, candidates: args[1] === undefined ? [] : resolved.candidates }; },
    proposeCampaignIssueScope: async (_id: string, request: CampaignIssueScopeRequest) => { proposals.push(request); return { status: "pending" } as WorkflowDecisionView; },
  } as unknown as ApiClient;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ApiProvider client={client}><CampaignIssueScopePanel session={{ id: "s_root", orchestratorPolicy: { issueScope: { revision: 2 } } } as unknown as SessionView} campaignId="s_root" /></ApiProvider>); });
  await settle();
  try {
    const label = [...host.querySelectorAll("div.field > span")].find((node) => node.textContent === "Epic Repository");
    assert.ok(label, "the field is offered only with several repositories");
    await act(async () => { label!.parentElement!.querySelector("button")!.click(); });
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) => item.textContent === "owner/api")!;
    await act(async () => { option.click(); });
    const input = [...host.querySelectorAll("label.field")].find((node) => node.textContent?.startsWith("Epic Issue Number"))!.querySelector("input")!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, "5");
      input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    await settle();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Resolve Epic Members")!.click(); });
    await settle();
    assert.deepEqual(reads.at(-1)!.slice(0, 2), ["s_root", 5]);
    assert.equal(reads.at(-1)![3], "owner/api");
    // owner/app#5 is held, but owner/api#5 is another issue and stays selectable.
    const member = [...host.querySelectorAll<HTMLInputElement>("fieldset input[type=checkbox]")][0]!;
    assert.equal(member.disabled, false);
    await act(async () => { member.click(); });
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Request Scope Approval")!.click(); });
    await settle();
    assert.deepEqual(proposals[0]!.additions, [{ repository: "owner/api", number: 5 }]);
  } finally { await act(async () => root.unmount()); }
});

test("a multi-repository scope is grouped under Repositories, and a proposal may name any of them (#4118)", async () => {
  const { host, proposals, unmount } = await mount(view({ repository: "owner/app", issueNumbers: [5], contextIssueNumbers: undefined,
    repositories: [{ repository: "owner/app", issueNumbers: [5], state: "verified" }, { repository: "owner/api", issueNumbers: [5, 40], state: "no_location_online" }] }));
  try {
    assert.deepEqual(facts(host), { "Repositories": "owner/app: #5owner/api (No Location Online): #5, #40", "Scope Revision": "2" });
    const items = [...host.querySelectorAll("dl.facts li")].map((item) => item.textContent);
    assert.deepEqual(items, ["owner/app: #5", "owner/api (No Location Online): #5, #40"]);
    const field = (label: string) => [...host.querySelectorAll("label.field")].find((node) => node.textContent?.startsWith(label))!.querySelector("input")!;
    const type = async (input: HTMLInputElement, value: string) => act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    // owner/app#40 is new even though owner/api#40 is held; owner/api#5 is removed, owner/app#5 stays.
    await type(field("Issue Additions"), "owner/api#41, Owner/App#40, owner/api#40");
    await type(field("Issue Removals"), "owner/api#5");
    const request = [...host.querySelectorAll("button")].find((button) => button.textContent === "Request Scope Approval")!;
    await act(async () => { request.click(); });
    await settle();
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0]!.additions, [{ repository: "owner/api", number: 41 }, { repository: "owner/app", number: 40 }]);
    assert.deepEqual(proposals[0]!.removals, [{ repository: "owner/api", number: 5 }]);
    // A repository outside the campaign is refused in the browser before any request.
    await type(field("Issue Additions"), "third/repo#1");
    await act(async () => { request.click(); });
    await settle();
    assert.equal(proposals.length, 1);
    assert.match(host.querySelector("[role=alert]")!.textContent!, /this campaign's repositories \(owner\/app, owner\/api\)/u);
  } finally { await unmount(); }
});
