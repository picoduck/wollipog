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
      "Checked By": "Deterministic checks, then your approval: it includes issues the Orchestrator chose, constraints it read and operations it withholds, which no Decision Model checked.",
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

test("a checked proposal shows the Decision Model's verdict and each typed question with its answer and confidence (#4282)", async () => {
  const typedAnswers = {
    confidenceThreshold: 0.8,
    questions: [
      { questionId: "count_consistent", label: "Count Matches Your Message", text: "…", answer: { type: "choice" as const, values: ["consistent", "inconsistent", "cannot_tell"] } },
      { questionId: "constraint_met__1", label: "team/repo#31 Slow sync — open", text: "…", parameter: "team/repo#31 Slow sync — open",
        answer: { type: "choice" as const, values: ["satisfies", "violates", "cannot_tell"] } },
    ],
    answers: [
      { questionId: "count_consistent", value: "consistent", confidence: 0.95, evidence: "The owner asks for two.", assessment: "satisfied" as const },
      { questionId: "constraint_met__1", value: "cannot_tell", confidence: 0.6, evidence: "The body doesn't say.", assessment: "unknown" as const },
    ],
    decisive: { questionId: "constraint_met__1" },
  };
  const uncertain: CampaignScopeProposalView = { ...waiting, proposal: { ...waiting.proposal, ownerCause: "constraint_check_uncertain",
    constraintCheck: { occurrenceId: "dec_1", verdict: "uncertain", reason: "The answer can't be settled for 'team/repo#31 Slow sync — open'." } },
    check: { occurrenceId: "dec_1", state: "uncertain", verdict: "uncertain", reason: "The answer can't be settled for 'team/repo#31 Slow sync — open'.", typedAnswers } };
  const admitted: CampaignScopeProposalView = { ...waiting, occurrenceId: "wd_3", outcome: "applied", proposal: { ...waiting.proposal, route: "admitted",
    ownerCause: undefined, ownerMessage: undefined, constraintCheck: { occurrenceId: "dec_2", verdict: "admit" } },
    check: { occurrenceId: "dec_2", state: "decided", verdict: "admit", reason: "Every answer is satisfied with at least 80% confidence.",
      typedAnswers: { ...typedAnswers, answers: [typedAnswers.answers[0]!, { ...typedAnswers.answers[1]!, value: "satisfies", confidence: 0.9, assessment: "satisfied" as const }],
        decisive: undefined } } };
  const { host, unmount } = await mount([admitted, uncertain]);
  try {
    const [latest, earlier] = [...section(host, "Scope Proposal")!.querySelectorAll("article")];
    assert.equal(facts(latest!)["Checked By"],
      "Deterministic checks, then the Decision Model confirmed issues the Orchestrator chose, constraints it read and operations it withholds against your message.");
    const verdictRow = (article: Element) => [...article.querySelectorAll("dl.facts > div")].find((row) => row.querySelector("dt")?.textContent === "Decision Model Verdict");
    assert.match(verdictRow(latest!)!.querySelector("dd")!.textContent!, /^Within Your Message Every answer is satisfied/u);
    // The checklist sits in an Answers row's value column, as in Decision Model Checks.
    assert.ok(facts(latest!).Answers?.startsWith("Answers count at 80% confidence or more."));
    assert.equal(latest!.querySelectorAll(":scope > dl.facts > div > dd .decision-answer-list").length, 1);
    assert.deepEqual([...latest!.querySelectorAll(".decision-answer-claim")].map((node) => node.textContent),
      ["Satisfies 'Count Matches Your Message'", "Satisfies 'team/repo#31 Slow sync — open'"]);
    assert.equal(facts(earlier!)["Checked By"],
      "Deterministic checks, then the Decision Model couldn't confirm issues the Orchestrator chose, constraints it read and operations it withholds, so it needs your approval.");
    assert.match(verdictRow(earlier!)!.querySelector("dd")!.textContent!, /^Uncertain The answer can't be settled/u);
    const lines = [...earlier!.querySelectorAll(".decision-answer")].map((node) => node.textContent);
    assert.match(lines[1]!, /Unsure About 'team\/repo#31 Slow sync — open'Can't tell \(60% confidence\); this answer decided the verdict\./u);
    assert.match(lines[0]!, /Satisfies 'Count Matches Your Message'Consistent \(95% confidence\)\./u);
  } finally { await unmount(); }
});

test("with the Full Control section showing the ceilings, the Scope Proposal leaves out Maximum Issues and Operations (#4282)", async () => {
  const client = { ...api, campaignIssueScope: async () => ({ campaignSessionId: "s_root", repository: "team/repo", issueNumbers: [], revision: 2,
    supported: true, canPropose: false, outsideScope: [], scopeGrant: proposalGrant, policyRevision: 3, scopeProposals: [] }) satisfies CampaignIssueScopeView } as ApiClient;
  const session = { id: "s_root", orchestratorPolicy: { issueScope: { revision: 2 } } } as unknown as SessionView;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ApiProvider client={client}><CampaignIssueScopePanel session={session} campaignId="s_root" boundaryShown /></ApiProvider>); });
    await settle();
    assert.deepEqual(facts(section(host, "Scope Proposal")!), { "Repository": "team/repo" });
  } finally { await act(async () => root.unmount()); }
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
