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

test("scope approval qualifies every repository's change by its own repository (#4118)",()=>{
  const markup=renderToStaticMarkup(<CampaignIssueScopeSummary snapshot={{category:"campaign_issue_scope",repository:"owner/app",expectedRevision:2,
    before:[5],additions:[],removals:[5],otherRepositories:[{repository:"owner/api",before:[5],additions:[40],removals:[]}],explanation:"Move work",
    affectedAssignments:[{sessionId:"app-child",issue:5},{sessionId:"api-child",issue:5,repository:"owner/api"}],affectedDecisions:[],activeChildren:[]}}/>);
  assert.match(markup,/<dt>Additions<\/dt><dd>owner\/api#40<\/dd>/u);
  assert.match(markup,/<dt>Removals<\/dt><dd>owner\/app#5<\/dd>/u);
  assert.match(markup,/<dt>Affected Assignments<\/dt><dd>owner\/app#5: app-child, owner\/api#5: api-child<\/dd>/u);
});
