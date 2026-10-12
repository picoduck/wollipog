import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCampaignIssueScope, inspectCampaignPublication } from "./campaign-issue-scope.js";

test("runner resolves native and checklist members, includes the umbrella, and never expands dependencies", async () => {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    if (command === "git") return "git@github.com:Team/Repo.git";
    const path = args.at(-1)!; calls.push(path);
    if (path.includes("sub_issues")) return JSON.stringify([{ number: 2, title: "Native", html_url: "https://github.com/Team/Repo/issues/2" }]);
    const number = Number(path.split("/").at(-1));
    return JSON.stringify({ number, title: `Issue ${number}`, html_url: `https://github.com/team/repo/issues/${number}`,
      body: number === 1 ? "## Units\n- [ ] #3 Work (depends on #99)\n## Dependencies\n- [ ] #98 Other" : "" });
  };
  const result = await inspectCampaignIssueScope(run, 1);
  assert.deepEqual(result.candidates.map((c) => [c.issue.number, c.source]), [[1,"umbrella"],[2,"sub_issue"],[3,"member_checklist"]]);
  assert.ok(!calls.some((p) => p.endsWith("/99") || p.endsWith("/98")));
});

test("publication duplicate inspection covers open, closed, newest issues and search overflow", async () => {
  const publication = {sanitizedTitle:"Related repair",sanitizedBody:"## Problem\nFailure\n## Proposed Behavior\nRepair\n## Acceptance Criteria\n- Works\n## Security and Compatibility\nNone",labels:[]};
  for (const mode of ["clean","recent","closed","overflow","incomplete","private"]) {
    const calls: string[] = [];
    const match={number:123,title:"  RELATED   repair ",html_url:"https://github.com/team/repo/issues/123",state:"closed"};
    const run=async (command:string,args:string[]) => {
      if(command==="git") return "https://github.com/team/repo.git";
      const recent=args.some((arg)=>arg.includes("sort=created")); calls.push(recent?"recent":"search");
      return JSON.stringify(recent ? mode==="recent"?[match]:[] : {items:mode==="closed"?[match]:[],total_count:mode==="overflow"?101:mode==="closed"?1:0,incomplete_results:mode==="incomplete"});
    };
    if(mode==="clean") { assert.ok((await inspectCampaignPublication(run,publication)).publicationDigest); assert.deepEqual(calls,["recent","search"]); }
    else await assert.rejects(inspectCampaignPublication(run,{...publication,sanitizedBody:publication.sanitizedBody+(mode==="private"?"\n/home/person/private": "")}));
  }
});

test("follow-up scope inspects exact title, body and labels rather than trusting its issue number", async () => {
  const publication={sanitizedTitle:"Exact",sanitizedBody:"Exact body",labels:["feature"]};
  for(const changed of [false,true]) {
    const run=async(command:string)=>command==="git"?"https://github.com/team/repo.git":JSON.stringify({number:10,title:changed?"Changed":"Exact",body:"Exact body",labels:[{name:"feature"}],html_url:"https://github.com/team/repo/issues/10"});
    if(changed) await assert.rejects(inspectCampaignIssueScope(run,undefined,[10],publication));
    else assert.equal((await inspectCampaignIssueScope(run,undefined,[10],publication)).candidates[0]!.issue.number,10);
  }
});

test("runner fails closed on incomplete, external or excessive membership", async () => {
  for (const members of [null, [{ number: 2, title: "Other", html_url: "https://github.com/other/repo/issues/2" }], Array(100).fill({})]) {
    const run = async (command: string, args: string[]) => command === "git" ? "https://github.com/team/repo.git"
      : JSON.stringify(args.at(-1)!.includes("sub_issues") ? members : { number: 1, title: "Epic", body: "", html_url: "https://github.com/team/repo/issues/1" });
    await assert.rejects(inspectCampaignIssueScope(run, 1));
  }
});

test("large explicit scope validation bounds concurrent GitHub reads and preserves exact issue order", async () => {
  let inFlight=0, maximum=0;
  const issues=Array.from({length:100},(_,i)=>i+1);
  const run=async (command:string,args:string[])=> {
    if(command==="git") return "https://github.com/team/repo.git";
    inFlight++;maximum=Math.max(maximum,inFlight);
    await new Promise<void>((resolve)=>setImmediate(resolve));
    inFlight--;
    const number=Number(args.at(-1)!.split("/").at(-1));
    return JSON.stringify({number,title:`Issue ${number}`,body:null,html_url:`https://github.com/team/repo/issues/${number}`});
  };
  const result=await inspectCampaignIssueScope(run,undefined,issues);
  assert.deepEqual(result.candidates.map((candidate)=>candidate.issue.number),issues);
  assert.equal(maximum,4,"avoid both serial timeout amplification and unbounded subprocess fanout");
});
