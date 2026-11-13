import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CampaignIssueScopeSummary } from "./CampaignIssueScopePanel.js";

test("an all proposal explains its ceiling without claiming missing lineage (#4532)", () => {
  const markup = renderToStaticMarkup(<CampaignIssueScopeSummary snapshot={{
    category: "campaign_issue_scope", repository: "team/repo", expectedRevision: 1, before: [], additions: [12, 13], removals: [],
    explanation: "Every match", affectedAssignments: [], affectedDecisions: [], activeChildren: [],
    ownerReview: { cause: "lineage_missing", maxIssuesIncrease: { from: 1, increase: 1 } },
    scopeProposal: { initial: true, messageDigest: "a".repeat(64), requestedCount: "all", constraints: ["open"], withheldOperations: [],
      checks: ["requested_count", "chosen_issues"], route: "owner", ownerCause: "issue_ceiling_exceeded", ownerMessage: "Fix all open issues.",
      constraintCheck: { occurrenceId: "check", verdict: "admit" },
      issues: [12, 13].map((number) => ({ number, title: "Issue", origin: "orchestrator_chosen", rationale: "Matches" })) },
  }} />).replace(/<!-- -->/gu, "");
  assert.ok(markup.includes("matching issues exceed Maximum Issues"));
  assert.ok(markup.includes("raises Maximum Issues from 1 to 2"));
  assert.equal(markup.includes("No authorized epic, published follow-up or issue selection admits it"), false);
});

test("scope approval displays exact qualified changes, revision and affected authority",()=>{
  const markup=renderToStaticMarkup(<CampaignIssueScopeSummary snapshot={{category:"campaign_issue_scope",repository:"team/repo",expectedRevision:3,
    before:[123],additions:[124,125],removals:[123],explanation:"Include members <literal>",
    affectedAssignments:[{sessionId:"child",issue:123}],affectedDecisions:["closure-old"],activeChildren:[{sessionId:"untracked-child",title:"Active Untracked Work",assignmentDigest:"a".repeat(64)}]}}/>);
  for(const expected of ["team/repo#124", "team/repo#125", "team/repo#123", "3 to 4", "child", "closure-old", "&lt;literal&gt;", "Issue closure still requires its own human approval"]) assert.ok(markup.includes(expected),expected);
  assert.equal(markup.includes("Maximum Issues"), false, "a change without an owner review states no limit");
  assert.ok(markup.includes("Under Full Control, approving revokes every decision outstanding at that moment, including any filed after this request"),
    "the list is what the request saw; the approval revokes what is outstanding when it happens (#4332)");
});

test("an Orchestrator's proposal without lineage says why it waits for the owner and the Maximum Issues increase approving applies (#4267)", () => {
  const base = { category: "campaign_issue_scope" as const, repository: "team/repo", expectedRevision: 2, before: [100], additions: [101, 102], removals: [],
    explanation: "The owner asked for these in chat.", affectedAssignments: [], affectedDecisions: ["merge-1"], activeChildren: [] };
  const raised = renderToStaticMarkup(<CampaignIssueScopeSummary snapshot={{ ...base, ownerReview: { cause: "lineage_missing", maxIssuesIncrease: { from: 2, increase: 1 } } }} />).replace(/<!-- -->/gu, "");
  for (const expected of ["The Orchestrator proposed this change. No authorized epic, published follow-up or issue selection admits it, so it needs your approval.",
    "It needs 1 issue more than Maximum Issues allows. Approving adds the issues and raises Maximum Issues from 2 to 3; denying leaves both unchanged.",
    "<dt>Maximum Issues</dt><dd>2 to 3</dd>", "team/repo#101, team/repo#102", "merge-1", "The owner asked for these in chat."]) {
    assert.ok(raised.includes(expected), expected);
  }
  const plain = renderToStaticMarkup(<CampaignIssueScopeSummary snapshot={{ ...base, ownerReview: { cause: "lineage_missing" } }} />);
  assert.ok(plain.includes("so it needs your approval. Denying leaves the scope unchanged."));
  assert.equal(plain.includes("<dt>Maximum Issues</dt>"), false);
});

test("scope approval qualifies every repository's change by its own repository (#4118)",()=>{
  const markup=renderToStaticMarkup(<CampaignIssueScopeSummary snapshot={{category:"campaign_issue_scope",repository:"owner/app",expectedRevision:2,
    before:[5],additions:[],removals:[5],otherRepositories:[{repository:"owner/api",before:[5],additions:[40],removals:[]}],explanation:"Move work",
    affectedAssignments:[{sessionId:"app-child",issue:5},{sessionId:"api-child",issue:5,repository:"owner/api"}],affectedDecisions:[],activeChildren:[]}}/>);
  assert.match(markup,/<dt>Additions<\/dt><dd>owner\/api#40<\/dd>/u);
  assert.match(markup,/<dt>Removals<\/dt><dd>owner\/app#5<\/dd>/u);
  assert.match(markup,/<dt>Affected Assignments<\/dt><dd>owner\/app#5: app-child, owner\/api#5: api-child<\/dd>/u);
});
