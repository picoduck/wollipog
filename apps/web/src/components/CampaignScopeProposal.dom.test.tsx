import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignIssueScopeSnapshot, CampaignIssueScopeView, CampaignScopeProposalView, FullControlScopeGrant, SessionView } from "@wollipog/protocol";
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
  Node: domWindow.Node,
  Event: domWindow.Event,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};

const proposalGrant: FullControlScopeGrant = { version: 1, status: "proposal", namedIssues: [],
  ceilings: { repositories: ["team/repo"], maxIssues: 8, maxIssuesSource: "derived", operations: ["implementation_question", "pr_merge"] } };

const digest = "a".repeat(64);
const waiting: CampaignScopeProposalView = { occurrenceId: "wd_2", createdAt: 2, explanation: "Ranked by priority label, then age.", outcome: "waiting_for_owner",
  proposal: { initial: true, messageDigest: digest, requestedCount: 2, constraints: ["open"], withheldOperations: ["pr_merge"],
    checks: ["chosen_issues", "constraints", "withheld_operations"], route: "owner", ownerCause: "constraint_check_unavailable",
    ownerMessage: "Fix #12 and the most important open bug, but don't merge.",
    issues: [{ number: 12, origin: "owner_named", rationale: "The owner names #12.", title: "Crash on save" },
      { number: 31, origin: "orchestrator_chosen", rationale: "Highest priority label among open bugs.", title: "Slow sync" }] } };
const replacedEarlier: CampaignScopeProposalView = { occurrenceId: "wd_1", createdAt: 1, explanation: "First reading.", outcome: "replaced",
  proposal: { ...waiting.proposal, issues: [waiting.proposal.issues[0]!], checks: [], route: "admitted", ownerCause: undefined, ownerMessage: undefined,
    requestedCount: null, constraints: [], withheldOperations: [] } };

async function mount(proposals: CampaignScopeProposalView[]) {
  const client = {
    ...api,
    campaignIssueScope: async () => ({ campaignSessionId: "s_root", repository: "team/repo", issueNumbers: [], revision: 2, supported: true,
      canPropose: false, outsideScope: [], scopeGrant: proposalGrant, policyRevision: 3, scopeProposals: proposals }) satisfies CampaignIssueScopeView,
  } as ApiClient;
  const session = { id: "s_root", orchestratorPolicy: { issueScope: { revision: 2 } } } as unknown as SessionView;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ApiProvider client={client}><CampaignIssueScopePanel session={session} campaignId="s_root" /></ApiProvider>); });
  await settle();
  return { host, unmount: () => act(async () => root.unmount()) };
}

const section = (host: HTMLElement, title: string) => [...host.querySelectorAll("section")].find((s) =>
  s.querySelector("h3")?.textContent === title) as HTMLElement | undefined;
const facts = (scope: Element) => Object.fromEntries([...scope.querySelectorAll(":scope > dl.facts > div")].map((row) =>
  [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]));

test("Campaign Status shows the Scope Proposal in place of the Scope Grant, waiting for the Orchestrator until it proposes (#4282)", async () => {
  const { host, unmount } = await mount([]);
  try {
    const shown = section(host, "Scope Proposal");
    assert.ok(shown, "the Scope Proposal section is shown");
    assertNoDomNode(section(host, "Scope Grant") ?? null, "no Scope Grant: the server read nothing from the message");
    assert.match(shown.textContent ?? "", /Waiting for the Orchestrator's Proposal/u);
    assert.match(shown.textContent ?? "", /Nothing is dispatched until it is admitted\./u);
    assert.deepEqual(facts(shown), { "Maximum Issues": "8 Derived", "Repository": "team/repo", "Operations": "Implementation Questions, PR Merge" });
  } finally { await unmount(); }
});

test("each proposal shows its issues with who named or chose them and why, the count, constraints, rationale, checks and verdict (#4282)", async () => {
  const { host, unmount } = await mount([waiting, replacedEarlier]);
  try {
    const shown = section(host, "Scope Proposal")!;
    assertNoDomNode(shown.querySelector(".notice"), "a proposal exists, so nothing is waiting for one");
    const [latest, earlier] = [...shown.querySelectorAll("article")];
    assert.equal(latest!.getAttribute("aria-label"), "Latest Proposal");
    assert.equal(latest!.querySelector("h4")!.textContent, "Latest Proposal Waiting for You");
    const { Issues: issueText, ...latestFacts } = facts(latest!);
    assert.match(issueText!, /^team\/repo#12 Crash on save Named by You/u);
    assert.deepEqual(latestFacts, {
      "Scope": "Initial Scope",
      "Count You Asked For": "2",
      "Constraints It Read": "open",
      "Withheld Operations": "PR Merge",
      "Rationale": "Ranked by priority label, then age.",
      "Checked By": "Deterministic checks, then your approval: it includes issues the Orchestrator chose, constraints it read and operations it withholds, which no Decision Model checks yet.",
    });
    assert.deepEqual([...latest!.querySelectorAll("li")].map((item) => item.textContent), [
      "team/repo#12 Crash on save Named by You: The owner names #12.",
      "team/repo#31 Slow sync Chosen by Orchestrator: Highest priority label among open bugs.",
    ]);
    assert.equal(earlier!.getAttribute("aria-label"), "Earlier Proposal 1");
    assert.equal(earlier!.querySelector("h4")!.textContent, "Earlier Proposal Replaced");
    assert.match(facts(earlier!)["Checked By"]!, /no model was asked/u);
  } finally { await unmount(); }
});

test("the owner's scope approval card shows the proposal's facts instead of a bare rationale (#4282)", async () => {
  const snapshot = { category: "campaign_issue_scope", repository: "team/repo", expectedRevision: 2, before: [], additions: [12, 31], removals: [],
    explanation: waiting.explanation, affectedAssignments: [], affectedDecisions: [], activeChildren: [], scopeProposal: waiting.proposal } satisfies CampaignIssueScopeSnapshot;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<CampaignIssueScopeSummary snapshot={snapshot} />); });
    assert.match(host.textContent ?? "", /Chosen by Orchestrator/u);
    assert.match(host.textContent ?? "", /Count You Asked For2/u);
    assert.match(host.textContent ?? "", /Additionsteam\/repo#12, team\/repo#31/u);
  } finally { await act(async () => root.unmount()); }
});
