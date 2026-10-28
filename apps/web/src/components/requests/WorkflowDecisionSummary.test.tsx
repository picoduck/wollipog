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

test("a GitLab merge closes issues by GitLab's rules, so it shows no closures row", () => {
  assert.doesNotMatch(text({ ...MERGE, repository: "gitlab.example.com/group/project", mergeMethod: "merge_train",
    squash: false, removeSourceBranch: false }), /Closes on Merge/u);
});
