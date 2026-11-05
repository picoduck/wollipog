import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignIssueScopeSnapshot, CampaignIssueScopeView, FullControlScopeGrant, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { CampaignIssueScopePanel, CampaignIssueScopeSummary } from "./CampaignIssueScopePanel.js";

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

const TARGET = { source: "automatic", runnerId: "r", machineName: "Studio", agentId: "claude", harnessName: "Claude Code",
  driver: "claude-code", provider: "claude", model: "claude-haiku-4-5", effort: "low" } as const;

const granted: FullControlScopeGrant = {
  version: 1, status: "granted", occurrenceId: "dec_1", reason: "The owner names #12 and asks for 3 more high-priority issues.",
  target: TARGET, namedIssues: [12],
  dropped: [{ repository: "team/repo", number: 99, reason: "not_in_message" }],
  selection: { repository: "team/repo", count: 3, defaulted: true, criteria: "highest priority", constraints: ["open", "UI only"] },
  ceilings: { repositories: ["team/repo"], maxIssues: 6, maxIssuesSource: "derived", operations: ["implementation_question", "pr_merge"],
    removedOperations: ["issue_closure"] },
};

async function mount(scopeGrant: FullControlScopeGrant | undefined, options: { owner?: boolean; policyRevision?: number } = {}) {
  let current = scopeGrant;
  const loads: number[] = [];
  const counts: Array<{ id: string; count: number; expectedRevision: number }> = [];
  const client = {
    ...api,
    campaignIssueScope: async () => {
      loads.push(loads.length);
      return { campaignSessionId: "s_root", repository: "team/repo", issueNumbers: current?.namedIssues ?? [], revision: 2, supported: true,
        canPropose: options.owner ?? false, outsideScope: [], ...(current ? { scopeGrant: current } : {}) } satisfies CampaignIssueScopeView;
    },
    setScopeGrantSelectionCount: async (id: string, count: number, expectedRevision: number) => {
      counts.push({ id, count, expectedRevision });
      current = { ...current!, selection: { ...current!.selection!, count, defaulted: false, setByOwner: true } };
      return {} as SessionView;
    },
  } as ApiClient;
  const session = { id: "s_root", orchestratorPolicy: { issueScope: { revision: 2 } } } as unknown as SessionView;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ApiProvider client={client}><CampaignIssueScopePanel session={session} campaignId="s_root"
    {...(options.policyRevision === undefined ? {} : { policyRevision: options.policyRevision })} /></ApiProvider>); });
  await settle();
  return { host, loads, counts, unmount: () => act(async () => root.unmount()) };
}

const button = (host: HTMLElement, name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined;

const section = (host: HTMLElement, title: string) => [...host.querySelectorAll("section")].find((s) =>
  s.querySelector("h3")?.textContent === title) as HTMLElement | undefined;
const facts = (host: HTMLElement) => Object.fromEntries([...host.querySelectorAll("dl.facts > div")].map((row) =>
  [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]));

test("Campaign Status shows the Scope Grant with its named issues, selection, ceilings and the Decision Model's reason (#4102)", async () => {
  const { host, unmount } = await mount(granted);
  try {
    const grant = section(host, "Scope Grant");
    assert.ok(grant, "the Scope Grant section is shown");
    assert.ok(section(host, "Authorized Issue Scope"), "beside the authorized scope");
    assert.deepEqual(facts(grant), {
      "Named Issues": "team/repo#12",
      "Selection Count": "3 Defaulted",
      "Selection Criteria": "highest priority",
      "Selection Constraints": "open; UI only",
      "Maximum Issues": "6 Derived",
      "Repository": "team/repo",
      "Operations": "Implementation Questions, PR Merge",
      "Withheld by Your Message": "Issue Closure",
      "Not Granted": "team/repo#99 (not written in the message)",
      "Decision Model": "claude-haiku-4-5 (low) · Claude Code on Studio",
      "Reason": "The owner names #12 and asks for 3 more high-priority issues.",
    });
    assertNoDomNode(grant.querySelector("[role=alert], .notice"), "a healthy grant raises no notice");
  } finally { await unmount(); }
});

test("a failed or uncertain grant says why, grants nothing, and points to the owner's approval of the Orchestrator's proposal (#4102)", async () => {
  for (const [grant, title, sentence] of [
    [{ ...granted, status: "failed", failureClass: "provider_overloaded", reason: undefined, namedIssues: [], dropped: undefined, selection: undefined },
      "Scope Grant Unavailable", "The Decision Model's provider was overloaded."],
    [{ ...granted, status: "uncertain", reason: "It is unclear which issues the owner wants.", namedIssues: [], dropped: undefined, selection: undefined },
      "Scope Grant Uncertain", "couldn't tell which issues"],
  ] as Array<[FullControlScopeGrant, string, string]>) {
    const { host, unmount } = await mount(grant);
    try {
      const shown = section(host, "Scope Grant")!;
      assert.ok(shown.textContent!.includes(title));
      assert.ok(shown.textContent!.includes(sentence));
      assert.match(shown.textContent!, /The Orchestrator's scope proposal comes to you for approval\./u);
      assert.equal(facts(shown)["Named Issues"], "None");
      assert.equal(facts(shown)["Selection Count"], "None");
      if (grant.status === "failed") assert.equal(facts(shown)["Failure"], "The Decision Model's provider was overloaded.");
      else assert.equal(facts(shown)["Reason"], "It is unclear which issues the owner wants.");
    } finally { await unmount(); }
  }
});

test("a campaign without a scope grant shows no Scope Grant section", async () => {
  const { host, unmount } = await mount(undefined);
  try { assert.ok(section(host, "Scope Grant") === undefined); } finally { await unmount(); }
});

test("the owner's scope approval shows their first message, the proposal's rationale and why it is theirs (#4102)", async () => {
  const snapshot: CampaignIssueScopeSnapshot = { category: "campaign_issue_scope", repository: "team/repo", expectedRevision: 2, before: [],
    additions: [12, 13], removals: [], explanation: "The two oldest open UI bugs.", affectedAssignments: [], affectedDecisions: [], activeChildren: [],
    grantReview: { cause: "grant_uncertain", ownerMessage: "Fix whatever matters most in the UI.", messageDigest: "d".repeat(64),
      grantOccurrenceId: "dec_1", reason: "It is unclear which issues the owner wants." } };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<CampaignIssueScopeSummary snapshot={snapshot} />); });
    assert.equal(facts(host)["Your First Message"], "Fix whatever matters most in the UI.");
    assert.equal(facts(host)["Uncertain Reason"], "It is unclear which issues the owner wants.");
    assert.equal(facts(host)["Additions"], "team/repo#12, team/repo#13");
    assert.match(host.textContent!, /no grant to check this proposal against/u);
    assert.match(host.textContent!, /The two oldest open UI bugs\./u);
  } finally { await act(async () => root.unmount()); }
});

const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
};

test("the owner changes the defaulted selection count from the Scope Grant section, against the campaign's policy revision (#4102)", async () => {
  const { host, loads, counts, unmount } = await mount(granted, { owner: true, policyRevision: 7 });
  try {
    const grant = section(host, "Scope Grant")!;
    await act(async () => { button(grant, "Change Count")!.click(); });
    const input = grant.querySelector("input") as unknown as HTMLInputElement;
    assert.equal(input.value, "3");
    assert.match(grant.textContent!, /Maximum Issues moves by the same amount\./u);
    await typeInto(input, "twelve");
    await act(async () => { button(grant, "Save Count")!.click(); });
    assert.equal(counts.length, 0, "an invalid count is never sent");
    assert.match(grant.querySelector("[role=alert]")!.textContent!, /whole number from 0 to 100/u);
    await typeInto(input, "5");
    const before = loads.length;
    await act(async () => { button(grant, "Save Count")!.click(); });
    await settle();
    assert.deepEqual(counts, [{ id: "s_root", count: 5, expectedRevision: 7 }]);
    assert.ok(loads.length > before, "the scope reloads after saving");
    const saved = section(host, "Scope Grant")!;
    assert.equal(facts(saved)["Selection Count"], "5 Set by You");
    assert.ok(button(saved, "Change Count") !== undefined, "the editor closes after saving");
  } finally { await unmount(); }
});

test("only the owner on the campaign's own session sees Change Count, and only for a granted selection (#4102)", async () => {
  for (const [label, grant, options] of [
    ["someone who can't propose scope", granted, { owner: false, policyRevision: 7 }],
    ["another session's Campaign Status", granted, { owner: true }],
    ["a grant without a selection", { ...granted, selection: undefined }, { owner: true, policyRevision: 7 }],
    ["a failed grant", { ...granted, status: "failed", selection: undefined, namedIssues: [] }, { owner: true, policyRevision: 7 }],
  ] as Array<[string, FullControlScopeGrant, { owner?: boolean; policyRevision?: number }]>) {
    const { host, unmount } = await mount(grant, options);
    try { assert.ok(button(section(host, "Scope Grant")!, "Change Count") === undefined, label); } finally { await unmount(); }
  }
});

test("under an explicit Maximum Issues the editor says the limit stays as it is (#4102)", async () => {
  const explicit: FullControlScopeGrant = { ...granted, ceilings: { ...granted.ceilings, maxIssues: 4, maxIssuesSource: "explicit" } };
  const { host, unmount } = await mount(explicit, { owner: true, policyRevision: 7 });
  try {
    const grant = section(host, "Scope Grant")!;
    await act(async () => { button(grant, "Change Count")!.click(); });
    assert.match(grant.textContent!, /The Maximum Issues you set at launch \(4\) stays as it is, so the count must fit within it\./u);
  } finally { await unmount(); }
});
