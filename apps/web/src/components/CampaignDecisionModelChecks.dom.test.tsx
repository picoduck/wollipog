import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignDecisionsResponse, DecisionKind } from "@wollipog/protocol";
import { api } from "../api.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { CampaignDecisionModelChecks } from "./CampaignDecisionModelChecks.js";
import { CampaignDecisions } from "./CampaignDecisions.js";
import { TYPED_ADMITTED, TYPED_REFUSED, TYPED_UNCERTAIN } from "../e2e/decision-model-fixtures.js";

const dom = new Window({ url: "http://localhost/" });
// Campaign Status › Decision Model refreshes on a repeating timer.
installDomTestCleanup(dom);
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
const decision = (occurrenceId: string, extra: Partial<CampaignDecisionsResponse["decisions"][number]>): CampaignDecisionsResponse["decisions"][number] => ({
  occurrenceId, kind: "credential_screen", promptVersion: "credential_screen.v1", state: "decided", inputDigests: {}, attempts: [],
  usage, createdAt: 1, subject: { sessionId: "child-1", surface: "implementation_question", requestId: occurrenceId }, ...extra,
});

function facts(item: Element): Record<string, string> {
  return Object.fromEntries([...item.querySelectorAll("dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]));
}

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

test("Campaign Status shows each screen's verdict, reason and failure beside the request, and the owner only classifies a failed one (#4104)", async () => {
  const read = api.campaignDecisions;
  const classify = api.classifyCampaignDecision;
  const classified: Array<[string, string, string]> = [];
  let decisions = [
    decision("dec_ok", { verdict: "discusses", reason: "It asks which keyboard keys to show." }),
    decision("dec_ask", { verdict: "ask", reason: "It asks for the token's value.", subject: { sessionId: "child-1", surface: "provider_question", requestId: "q-1" } }),
    decision("dec_failed", { state: "failed", failureClass: "timed_out" }),
    decision("probe", { kind: "probe", verdict: "confirm" }),
  ];
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions, usage: { ...usage, calls: decisions.length, unpricedCalls: 0 } });
  api.classifyCampaignDecision = async (id, occurrenceId, classification) => {
    classified.push([id, occurrenceId, classification]);
    decisions = decisions.map((item) => item.occurrenceId === occurrenceId ? { ...item, subject: { ...item.subject!, classification } } : item);
    return decisions.find((item) => item.occurrenceId === occurrenceId)!.subject!;
  };
  const opened: string[] = [];
  const view = await render(<CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={(id) => opened.push(id)} />);
  try {
    const { container } = view;
    assert.equal(container.querySelector("h3")?.textContent, "Decision Model Checks");
    const items = [...container.querySelectorAll("li")];
    assert.equal(items.length, 3, "only the question screen's checks");
    assert.ok(items.every((item) => item.classList.contains("campaign-screen-item")), "each screened request is its own group");
    assert.deepEqual(facts(items[0]!), { "Implementation Question": "The Orchestrator decides it.", Verdict: "Only Discusses",
      Reason: "It asks which keyboard keys to show." });
    assert.deepEqual(facts(items[1]!), { "Provider Question": "Declined and recorded as blocked work.", Verdict: "Asks for Access",
      Reason: "It asks for the token's value." });
    assert.deepEqual(facts(items[2]!), { "Implementation Question": "Waiting for you to classify it.", Verdict: "None", Failure: "Timed Out" });
    const buttons = (item: Element) => [...item.querySelectorAll("button")].map((node) => node.textContent);
    assert.deepEqual(buttons(items[0]!), ["Open Session"], "a settled check offers no classification");
    assert.deepEqual(buttons(items[2]!), ["Decline", "Let the Orchestrator Answer", "Open Session"]);
    await act(async () => { [...items[2]!.querySelectorAll("button")].find((node) => node.textContent === "Let the Orchestrator Answer")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(classified, [["root-1", "dec_failed", "orchestrator"]]);
    const after = [...container.querySelectorAll("li")][2]!;
    assert.equal(facts(after)["Implementation Question"], "You let the Orchestrator answer it.");
    assert.deepEqual(buttons(after), ["Open Session"]);
    await act(async () => { (after.querySelector("button") as HTMLButtonElement).click(); });
    assert.deepEqual(opened, ["child-1"]);
  } finally {
    view.unmount();
    api.campaignDecisions = read;
    api.classifyCampaignDecision = classify;
  }
});

test("an owner decision whose screen failed stays the owner's: they decline it or answer it themselves", async () => {
  const read = api.campaignDecisions;
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions: [decision("dec_owner", { state: "uncertain", verdict: "uncertain",
    reason: "It may ask the owner to sign in.", subject: { sessionId: "root-1", surface: "owner_decision", requestId: "ask-owner" } })],
    usage: { ...usage, calls: 1, unpricedCalls: 0 } });
  const view = await render(<CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={() => {}} />);
  try {
    const item = view.container.querySelector("li")!;
    assert.equal(facts(item)["Owner Decision"], "Waiting for you to classify it.");
    assert.deepEqual([...item.querySelectorAll("button")].map((node) => node.textContent), ["Decline", "Let Me Answer", "Open Session"]);
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});

test("follow-up relatedness and closure-reason checks show their verdict beside the request, and never offer classification (#4104)", async () => {
  const read = api.campaignDecisions;
  const followUp = { sessionId: "child-1", surface: "follow_up_publication" as const, requestId: "rec_1" };
  const closure = { sessionId: "root-1", surface: "issue_closure" as const, requestId: "team/repo#7" };
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions: [
    decision("rel_ok", { kind: "follow_up_relatedness", verdict: "related", reason: "It fixes a defect the work exposed.", subject: followUp }),
    decision("rel_no", { kind: "follow_up_relatedness", verdict: "unrelated", reason: "It starts a different feature.", subject: followUp }),
    decision("rel_failed", { kind: "follow_up_relatedness", state: "failed", failureClass: "timed_out", subject: followUp }),
    decision("why_fits", { kind: "closure_reason", verdict: "fits", reason: "The work was cancelled as a duplicate.", subject: closure }),
    decision("why_not", { kind: "closure_reason", verdict: "does_not_fit", reason: "The work was only paused.", subject: closure }),
    decision("why_unsure", { kind: "closure_reason", state: "uncertain", verdict: "uncertain", reason: "Unclear.", subject: closure }),
  ], usage: { ...usage, calls: 6, unpricedCalls: 0 } });
  const view = await render(<CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={() => {}} />);
  try {
    const items = [...view.container.querySelectorAll("li")];
    assert.deepEqual(items.map((item) => [Object.keys(facts(item))[0], facts(item)[Object.keys(facts(item))[0]!], facts(item).Verdict]), [
      ["Follow-Up Publication", "The Orchestrator may publish it.", "Related"],
      ["Follow-Up Publication", "Refused back to the Orchestrator.", "Unrelated"],
      ["Follow-Up Publication", "Waiting for you to decide the publication.", "None"],
      ["Issue Closure", "The Orchestrator may close it.", "Reason Fits"],
      ["Issue Closure", "Refused back to the Orchestrator.", "Reason Doesn't Fit"],
      ["Issue Closure", "Waiting for you to decide the closure.", "Uncertain"],
    ]);
    assert.equal(facts(items[2]!).Failure, "Timed Out");
    for (const item of items) assert.deepEqual([...item.querySelectorAll("button")].map((node) => node.textContent), ["Open Session"]);
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});

test("each selection proposal shows its outcome, issues, rationale and the Decision Model's reason in the same list (#4103)", async () => {
  const read = api.campaignDecisions;
  const proposal = (outcome: NonNullable<CampaignDecisionsResponse["decisions"][number]["selectionProposal"]>["outcome"], numbers: number[], explanation: string) =>
    ({ outcome, explanation, issues: numbers.map((number) => ({ repository: "team/repo", number, title: `Issue ${number}` })) });
  api.campaignDecisions = async () => ({ campaignSessionId: "root-1", decisions: [
    decision("sel_admit", { kind: "scope_review", promptVersion: "scope_review.v1", subject: undefined, verdict: "admit",
      reason: "Both are labeled priority/high.", selectionProposal: proposal("applied", [30, 31], "The two highest-priority open issues.") }),
    decision("sel_refuse", { kind: "scope_review", promptVersion: "scope_review.v1", subject: undefined, verdict: "refuse",
      reason: "Issue 40 is a typo fix, not a priority.", selectionProposal: proposal("refused", [40], "Next in the backlog.") }),
    decision("sel_unsure", { kind: "scope_review", promptVersion: "scope_review.v1", subject: undefined, state: "uncertain", verdict: "uncertain",
      reason: "The owner didn't say whether UI work counts.",
      selectionProposal: { ...proposal("waiting_for_owner", [41], "A UI regression users report."), requestOccurrenceId: "wd_scope" } }),
    decision("sel_failed", { kind: "scope_review", promptVersion: "scope_review.v1", subject: undefined, state: "failed", failureClass: "authentication",
      selectionProposal: proposal("owner_declined", [42], "An old crash report.") }),
  ], usage: { ...usage, calls: 4, unpricedCalls: 0 } });
  const opened: string[] = [];
  const requests: string[] = [];
  const view = await render(<CampaignDecisionModelChecks sessionId="member-1" canClassify={false} refreshKey={1} onOpenSession={(id) => opened.push(id)}
    findRequest={(target) => target.occurrenceId === "wd_scope" && target.sessionId === null ? "request:wd_scope" : null}
    onOpenRequest={(key) => requests.push(key)} />);
  try {
    const items = [...view.container.querySelectorAll("li")];
    assert.deepEqual(items.map(facts), [
      { "Selection Proposal": "Admitted and added to the scope.", Issues: "#30 Issue 30; #31 Issue 31", Rationale: "The two highest-priority open issues.",
        Verdict: "Fits Your Selection", Reason: "Both are labeled priority/high." },
      { "Selection Proposal": "Refused back to the Orchestrator.", Issue: "#40 Issue 40", Rationale: "Next in the backlog.",
        Verdict: "Doesn't Fit Your Selection", Reason: "Issue 40 is a typo fix, not a priority." },
      { "Selection Proposal": "Waiting for your approval of the scope change.", Issue: "#41 Issue 41", Rationale: "A UI regression users report.",
        Verdict: "Uncertain", Reason: "The owner didn't say whether UI work counts." },
      { "Selection Proposal": "You declined the scope change.", Issue: "#42 Issue 42", Rationale: "An old crash report.", Verdict: "None",
        Failure: "Sign-In Required" },
    ]);
    // Each item opens the campaign's Orchestrator session; the pending one also opens the owner's
    // scope approval card. A selection is never classified here.
    assert.deepEqual(items.map((item) => [...item.querySelectorAll("button")].map((node) => node.textContent)),
      [["Open Session"], ["Open Session"], ["Open Request", "Open Session"], ["Open Session"]]);
    await act(async () => { (items[2]!.querySelector("button") as HTMLButtonElement).click(); });
    await act(async () => { ([...items[0]!.querySelectorAll("button")].at(-1) as HTMLButtonElement).click(); });
    assert.deepEqual(requests, ["request:wd_scope"]);
    assert.deepEqual(opened, ["root-1"], "the campaign root, not the member session showing the list");
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});

test("a Custom campaign's epic seed shows its reading beside the scope it affects; Full Control's scope grant stays in its own section (#4104)", async () => {
  const read = api.campaignDecisions;
  const seed = { sessionId: "root-1", surface: "issue_scope_seed" as const, requestId: "issue_scope_seed:abc" };
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions: [
    decision("seed_read", { kind: "scope_grant", verdict: "grant", reason: "The person names epic #40 to orchestrate.", subject: { ...seed, seed: "seeded" } }),
    decision("seed_none", { kind: "scope_grant", verdict: "grant", reason: "No issue is named.", subject: { ...seed, seed: "none" } }),
    decision("seed_pending", { kind: "scope_grant", state: "pending", subject: { ...seed, seed: "pending" } }),
    decision("seed_failed", { kind: "scope_grant", state: "failed", failureClass: "authentication", subject: { ...seed, seed: "owner" } }),
    decision("seed_released", { kind: "scope_grant", state: "uncertain", verdict: "uncertain", reason: "Unclear.",
      subject: { ...seed, seed: "none", classification: "orchestrator" } }),
    decision("seed_scoped", { kind: "scope_grant", state: "failed", failureClass: "timed_out", subject: { ...seed, seed: "scoped" } }),
    decision("grant_full_control", { kind: "scope_grant", verdict: "grant", reason: "Named issues." }),
  ], usage: { ...usage, calls: 7, unpricedCalls: 0 } });
  const view = await render(<CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={() => {}} />);
  try {
    const items = [...view.container.querySelectorAll("li")];
    assert.deepEqual(items.map((item) => [Object.keys(facts(item))[0], facts(item)["Epic Seed"], facts(item).Verdict]), [
      ["Epic Seed", "It seeded the epic's issues; approve the issue scope before work is delegated.", "Message Read"],
      ["Epic Seed", "It named no epic, so nothing waits.", "Message Read"],
      ["Epic Seed", "Work waits to be delegated until the check finishes.", "Checking"],
      ["Epic Seed", "Waiting for you: approve the campaign's issue scope, or continue without an epic.", "None"],
      ["Epic Seed", "You let the Orchestrator delegate without an epic.", "Uncertain"],
      ["Epic Seed", "You approved the campaign's issue scope, so nothing waits.", "None"],
    ]);
    assert.equal(facts(items[3]!).Failure, "Sign-In Required");
    assert.deepEqual(items.map((item) => [...item.querySelectorAll("button")].map((node) => node.textContent)), [
      ["Open Session"], ["Open Session"], ["Open Session"], ["Continue Without an Epic", "Open Session"], ["Open Session"], ["Open Session"],
    ], "only a seed still left to the owner offers to continue without an epic");
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});

test("Campaign Status lists each Decision Model call in exactly one section: checks beside their request, every other call in Decision Model (#4265)", async () => {
  const read = api.campaignDecisions;
  type Section = "Decision Model Checks" | "Decision Model";
  // One decision of every kind, keyed by kind so a new kind fails to typecheck until its section is chosen here.
  const byKind: Record<DecisionKind, [Section, CampaignDecisionsResponse["decisions"][number]]> = {
    credential_screen: ["Decision Model Checks", decision("credential_screen", { verdict: "discusses", reason: "[credential_screen]" })],
    follow_up_relatedness: ["Decision Model Checks", decision("follow_up_relatedness", { kind: "follow_up_relatedness", verdict: "related",
      reason: "[follow_up_relatedness]", subject: { sessionId: "child-1", surface: "follow_up_publication", requestId: "rec_1" } })],
    closure_reason: ["Decision Model Checks", decision("closure_reason", { kind: "closure_reason", verdict: "fits", reason: "[closure_reason]",
      subject: { sessionId: "root-1", surface: "issue_closure", requestId: "team/repo#7" } })],
    scope_review: ["Decision Model Checks", decision("scope_review", { kind: "scope_review", verdict: "admit", reason: "[scope_review]", subject: undefined })],
    // Full Control's scope grant has no section of its own, so Decision Model lists it.
    scope_grant: ["Decision Model", decision("scope_grant", { kind: "scope_grant", verdict: "grant", reason: "[scope_grant]", subject: undefined })],
    probe: ["Decision Model", decision("probe", { kind: "probe", verdict: "confirm", reason: "[probe]", subject: undefined })],
  };
  const listed: Array<[Section, CampaignDecisionsResponse["decisions"][number]]> = [
    ...Object.values(byKind),
    // A Custom campaign's epic-seed reading is a scope grant too, but a check shown beside the scope it affects.
    ["Decision Model Checks", decision("epic_seed", { kind: "scope_grant", verdict: "grant", reason: "[epic_seed]",
      subject: { sessionId: "root-1", surface: "issue_scope_seed", requestId: "issue_scope_seed:abc", seed: "seeded" } })],
  ];
  const decisions = listed.map(([, item]) => item);
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions, usage: { ...usage, calls: decisions.length, unpricedCalls: 0 } });
  const view = await render(<>
    <CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={() => {}} />
    <CampaignDecisions campaignId="root-1" />
  </>);
  try {
    const sections = [...view.container.querySelectorAll("section")].map((node) => ({
      title: node.querySelector("h3")?.textContent ?? "",
      items: [...node.querySelectorAll("li")].map((item) => item.textContent ?? ""),
    }));
    assert.deepEqual(sections.map(({ title }) => title), ["Decision Model Checks", "Decision Model"]);
    assert.equal(sections.reduce((total, { items }) => total + items.length, 0), decisions.length, "one list item per decision across both sections");
    for (const [expected, item] of listed) {
      const listedIn = sections.flatMap(({ title, items }) => items.filter((text) => text.includes(item.reason!)).map(() => title));
      assert.deepEqual(listedIn, [expected], `${item.occurrenceId} is listed once, in ${expected}`);
    }
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});

test("a member session sees the checks but never the classification buttons", async () => {
  const read = api.campaignDecisions;
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions: [decision("dec_failed", { state: "uncertain", verdict: "uncertain", reason: "Unclear." })],
    usage: { ...usage, calls: 1, unpricedCalls: 0 } });
  const view = await render(<CampaignDecisionModelChecks sessionId="child-1" canClassify={false} refreshKey={1} onOpenSession={() => {}} />);
  try {
    const item = view.container.querySelector("li")!;
    assert.equal(facts(item).Verdict, "Uncertain");
    assert.deepEqual([...item.querySelectorAll("button")].map((node) => node.textContent), ["Open Session"]);
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});

test("a typed check shows its answers as a short checklist beside the server's verdict and reason (#4283)", async () => {
  const read = api.campaignDecisions;
  const decisions = [
    decision("sel_refused", { kind: "scope_review", promptVersion: "scope_review.v2", verdict: "refuse", subject: undefined,
      reason: "Issue 140 violates 'Skip Security'.", typedAnswers: TYPED_REFUSED,
      selectionProposal: { outcome: "refused", explanation: "Next in the backlog.",
        issues: [{ repository: "team/repo", number: 140, title: "Reword the Settings footer" }] } }),
    decision("sel_uncertain", { kind: "scope_review", promptVersion: "scope_review.v2", state: "uncertain", verdict: "uncertain", subject: undefined,
      reason: "Issue 141 on 'UI Only' is below the 80% confidence threshold.", typedAnswers: TYPED_UNCERTAIN }),
    decision("dec_typed_call", { kind: "probe", verdict: "confirm", subject: undefined,
      reason: "Every answer is satisfied with at least 80% confidence.", typedAnswers: TYPED_ADMITTED }),
    decision("dec_legacy", { kind: "probe", verdict: "confirm", subject: undefined, reason: "Listed in the boundary." }),
  ];
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions, usage: { ...usage, calls: decisions.length, unpricedCalls: 0 } });
  const view = await render(<>
    <CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={() => {}} />
    <CampaignDecisions campaignId="root-1" />
  </>);
  try {
    const lists = [...view.container.querySelectorAll("ul[aria-label='Answers']")];
    assert.equal(lists.length, 3, "only typed decisions show answers; a single-verdict decision keeps its form");
    const lines = (list: Element) => [...list.querySelectorAll("li")].map((item) => ({
      standing: item.getAttribute("data-standing"),
      claim: item.querySelector(".decision-answer-claim")?.textContent,
      detail: item.querySelector(".campaign-status-meta")?.textContent,
    }));
    assert.deepEqual(lines(lists[0]!), [
      { standing: "satisfies", claim: "Satisfies 'Count Matches'",
        detail: "Answered yes with 96% confidence. The owner asked for one more; one is proposed." },
      { standing: "satisfies", claim: "Issue 140 Satisfies 'UI Only'", detail: "Answered satisfies with 90% confidence. It rewords the Settings footer." },
      { standing: "violates", claim: "Issue 140 Violates 'Skip Security'",
        detail: "Answered violates with 92% confidence; this answer decided the verdict. It is labeled security." },
    ]);
    // An answer below the threshold reads as unsure, whatever its value.
    assert.deepEqual(lines(lists[1]!)[1], { standing: "unsure", claim: "Issue 141 Unsure About 'UI Only'",
      detail: "Answered satisfies with 55% confidence; this answer decided the verdict. A layout bug, but the label is area/sidebar, not area/ui." });
    assert.ok(lines(lists[2]!).every((line) => line.standing === "satisfies"));
    const refused = lists[0]!.closest("li.campaign-screen-item")!;
    assert.equal(facts(refused).Verdict, "Doesn't Fit Your Selection");
    assert.equal(facts(refused).Reason, "Issue 140 violates 'Skip Security'.");
    assert.ok(facts(refused).Answers?.startsWith("Answers count at 80% confidence or more."));
    // Every icon is decorative; the claim carries the standing in words.
    assert.ok([...view.container.querySelectorAll(".decision-answer-icon")].every((icon) => icon.getAttribute("aria-hidden") === "true"));
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});
