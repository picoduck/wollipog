import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullRequestClosingReferenceCheck, WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { WorkflowDecisionSummary } from "./WorkflowDecisionSummary.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });

const MERGE = {
  category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 3729, headSha: "d".repeat(40),
  reviewResult: "merge", requiredChecks: { headSha: "d".repeat(40), status: "passed", checkedAt: 1, checks: [] },
} as const satisfies WorkflowDecisionResourceSnapshot;

const text = (snapshot: WorkflowDecisionResourceSnapshot, check?: PullRequestClosingReferenceCheck) =>
  renderToStaticMarkup(<WorkflowDecisionSummary snapshot={snapshot} {...(check ? { closingReferenceCheck: check } : {})} />)
    .replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();

test("a GitHub merge shows the issues it would close, as the runner read them (#3713)", () => {
  assert.match(text(MERGE, { checkedAt: 1, closures: [] }), /Closes on Merge None/u);
  assert.match(text({ ...MERGE, intendedClosures: ["picoduck/wollipog#3713", "picoduck/wollipog#9"] }, { checkedAt: 1, closures: [
    { issue: "picoduck/wollipog#9", sources: ["linked"] },
    { issue: "picoduck/wollipog#3713", sources: ["description"], excerpt: "Closes #3713." },
  ] }), /Closes on Merge picoduck\/wollipog#9 \(linked on GitHub\) picoduck\/wollipog#3713: Closes #3713\./u);
});

test("a merge requested through a runner without the check says so, with what it declared", () => {
  assert.match(text(MERGE), /Closes on Merge Not checked: the runner predates this check\.$/u);
  assert.match(text({ ...MERGE, intendedClosures: ["picoduck/wollipog#3713"] }),
    /Not checked: the runner predates this check\. Declared: picoduck\/wollipog#3713\.$/u);
});

test("a GitLab merge shows the issues GitLab would close, or that an older runner did not check them (#3762)", () => {
  const gitlab = { ...MERGE, repository: "gitlab.example.com/group/project", mergeMethod: "merge_train",
    squash: false, removeSourceBranch: false } as const satisfies WorkflowDecisionResourceSnapshot;
  assert.match(text(gitlab, { checkedAt: 1, closures: [] }), /Closes on Merge None/u);
  assert.match(text({ ...gitlab, intendedClosures: ["gitlab.example.com/group/project#5", "gitlab.example.com/group/project#9"] },
    { checkedAt: 1, closures: [
      { issue: "gitlab.example.com/group/project#5", sources: ["description"], excerpt: "Implements #5." },
      { issue: "gitlab.example.com/group/project#9", sources: ["linked"] },
    ] }), /Closes on Merge gitlab\.example\.com\/group\/project#5: Implements #5\. gitlab\.example\.com\/group\/project#9 \(reported by GitLab\)/u);
  assert.match(text(gitlab), /Closes on Merge Not checked: the runner predates this check\.$/u);
});

test("an owner decision shows the question, its material and its options, and says only the owner decides (#4064)", () => {
  const rendered = text({ category: "owner_decision", question: "Which credential design should the provider bridge use?",
    material: "PR #7 at head abc1234; both designs pass CI.", recommendedOptionId: "lease",
    options: [{ optionId: "lease", label: "Short-Lived Lease" }, { optionId: "broker", label: "Broker Process", description: "Adds a helper process." }] });
  assert.equal(rendered, "Which credential design should the provider bridge use? PR #7 at head abc1234; both designs pass CI. " +
    "Short-Lived Lease (Recommended) Broker Process: Adds a helper process. " +
    "You kept this decision, so only you can make it. The Orchestrator keeps working while it waits.");
});

test("a repository addition shows the inspected Location, its repository, the work and the Orchestrator's quoted reason (#4117)", () => {
  const html = renderToStaticMarkup(<WorkflowDecisionSummary snapshot={{ category: "campaign_repository_addition", locationId: "loc_docs",
    locationName: "Docs on Laptop", repository: "picoduck/docs", reason: "The follow-up changes the docs site.",
    work: { kind: "follow_up", id: "fu_1", title: "Document Location Switching" } }} />);
  assert.match(html, /<dt>Orchestrator&#x27;s Reason<\/dt><dd><q>The follow-up changes the docs site\.<\/q><\/dd>/u,
    "the reason is shown as the Orchestrator's quoted words");
  assert.equal(text({ category: "campaign_repository_addition", locationId: "loc_docs", locationName: "Docs on Laptop", repository: "picoduck/docs",
    reason: "The follow-up changes the docs site.", work: { kind: "work_item", id: "cwi_1", title: "Document Location Switching" } }),
  "Location Docs on Laptop Repository picoduck/docs Work Item Document Location Switching Orchestrator&#x27;s Reason " +
    "The follow-up changes the docs site. Approving adds this repository to the campaign, so the Orchestrator can work in it like its " +
    "other repositories. Declining changes nothing, and the work that needs it stays blocked on you.");
});
