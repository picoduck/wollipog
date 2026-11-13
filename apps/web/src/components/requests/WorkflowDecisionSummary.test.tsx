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

const text = (snapshot: WorkflowDecisionResourceSnapshot, check?: PullRequestClosingReferenceCheck, authority: "human" | "orchestrator" = "orchestrator") =>
  renderToStaticMarkup(<WorkflowDecisionSummary snapshot={snapshot} authority={authority} {...(check ? { closingReferenceCheck: check } : {})} />)
    .replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();

test("temporary deletion shows its exact tip and receipt without claiming a merged pull request (#4535)", () => {
  const snapshot = { category: "merged_branch_deletion" as const, merged: false as const, repository: "picoduck/wollipog",
    branch: "temporary/check", headSha: "a".repeat(40), temporaryReceiptId: "tbr_receipt", dependentPullRequests: { checkedAt: 1, open: [] },
    creation: { sessionId: "s_retirement", sessionTitle: "Worktree Retirement", defaultBranch: "main", defaultHeadSha: "c".repeat(40), checkedAt: 1 } };
  const rendered = text(snapshot);
  assert.ok(rendered.includes(snapshot.headSha));
  assert.ok(rendered.includes(snapshot.creation.sessionTitle));
  assert.match(rendered, /Contained in main at/u);
  assert.match(rendered, /no open head or base pull requests/u);
  assert.match(rendered, /Orchestrator may delete/u);
  const ownerKept = text(snapshot, undefined, "human");
  assert.match(ownerKept, /This campaign keeps branch deletion with you/u);
  assert.match(ownerKept, /Orchestrator cannot approve deletion/u);
  assert.doesNotMatch(ownerKept, /Orchestrator may delete/u);
  assert.doesNotMatch(rendered, /Merge Commit/u);
  const unknown = text({ ...snapshot, temporaryReceiptId: undefined, creation: undefined });
  assert.match(unknown, /No matching creation receipt exists/u);
  assert.match(unknown, /Orchestrator cannot delete/u);
  assert.doesNotMatch(unknown, /Created Tip/u);
});

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

test("an owner decision's material renders as Markdown with working links, and an Owner Question reads as a question (#4270)", () => {
  const snapshot = { category: "owner_decision", kind: "question", question: "Which name should the bridge use?",
    material: "See [the design note](https://example.com/design) and **both** drafts.", options: [] } as const satisfies WorkflowDecisionResourceSnapshot;
  const markup = renderToStaticMarkup(<WorkflowDecisionSummary snapshot={snapshot} />);
  assert.doesNotMatch(markup, /code-well|<pre>/u, "not a monospace block");
  assert.match(markup, /<a [^>]*href="https:\/\/example\.com\/design"[^>]*>/u);
  assert.match(markup, /<strong>both<\/strong>/u);
  assert.doesNotMatch(markup, /<ul>/u, "a question with no suggestions lists none");
  assert.match(text(snapshot), /The Orchestrator asked you this question\. Only you can answer it, in your own words/u);
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
