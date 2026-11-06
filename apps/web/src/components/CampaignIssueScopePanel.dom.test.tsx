import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CampaignIssueScopeSummary } from "./CampaignIssueScopePanel.js";

test("scope approval displays exact qualified changes, revision and affected authority",()=>{
  const markup=renderToStaticMarkup(<CampaignIssueScopeSummary snapshot={{category:"campaign_issue_scope",repository:"team/repo",expectedRevision:3,
    before:[123],additions:[124,125],removals:[123],explanation:"Include members <literal>",
    affectedAssignments:[{sessionId:"child",issue:123}],affectedDecisions:["closure-old"],activeChildren:[{sessionId:"untracked-child",title:"Active Untracked Work",assignmentDigest:"a".repeat(64)}]}}/>);
  for(const expected of ["team/repo#124", "team/repo#125", "team/repo#123", "3 to 4", "child", "closure-old", "&lt;literal&gt;", "Issue closure still requires its own human approval"]) assert.ok(markup.includes(expected),expected);
  assert.equal(markup.includes("Maximum Issues"), false, "a change without an owner review states no limit");
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
