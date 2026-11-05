import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullRequestClosingReferenceCheck, WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { OwnerRuleSummary, WorkflowDecisionSummary } from "./WorkflowDecisionSummary.js";

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

test("a GitLab merge closes issues by GitLab's rules, so it shows no closures row", () => {
  assert.doesNotMatch(text({ ...MERGE, repository: "gitlab.example.com/group/project", mergeMethod: "merge_train",
    squash: false, removeSourceBranch: false }), /Closes on Merge/u);
});

test("an owner decision shows the question, its material and its options, and says only the owner decides (#4064)", () => {
  const rendered = text({ category: "owner_decision", question: "Which credential design should the provider bridge use?",
    material: "PR #7 at head abc1234; both designs pass CI.", recommendedOptionId: "lease",
    options: [{ optionId: "lease", label: "Short-Lived Lease" }, { optionId: "broker", label: "Broker Process", description: "Adds a helper process." }] });
  assert.equal(rendered, "Which credential design should the provider bridge use? PR #7 at head abc1234; both designs pass CI. " +
    "Short-Lived Lease (Recommended) Broker Process: Adds a helper process. " +
    "You kept this decision, so only you can make it. The Orchestrator keeps working while it waits.");
});

test("an owner rule shows its source and quote as plain text, whoever reads the card (#4137)", () => {
  const markup = renderToStaticMarkup(<OwnerRuleSummary rule={{ source: "~/.claude/skills/issue-workflow/SKILL.md",
    quote: "Ask <script>alert(1)</script> & wait for \"yes\"." }} />);
  assert.doesNotMatch(markup, /<script>/u, "the quote is never rendered as markup");
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; wait/u);
  assert.equal(markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim(),
    "An installed or user-authored rule keeps this decision for a person, so no agent can make it. " +
    "Rule Source ~/.claude/skills/issue-workflow/SKILL.md Rule Ask &lt;script&gt;alert(1)&lt;/script&gt; &amp; wait for &quot;yes&quot;.");
});
