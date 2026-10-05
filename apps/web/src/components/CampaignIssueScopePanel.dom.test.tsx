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
});
