import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignIssueScopeRefusal, inspectCampaignIssueScope, inspectCampaignPublication } from "./campaign-issue-scope.js";

/** GitLab answers for a nested project on a self-managed host (#3539). */
function gitlabScope(issues: Record<number, { title: string; description?: string | null; web_url?: string; project_id?: number }>) {
  const web = "https://gitlab.example.com/Platform/Backend/Service";
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "git") return "git@gitlab.example.com:platform/backend/service.git";
    assert.equal(command, "glab");
    assert.equal(args[args.indexOf("--hostname") + 1], "gitlab.example.com");
    const path = args[1]!.toLowerCase();
    const base = `projects/${encodeURIComponent("Platform/Backend/Service")}`.toLowerCase();
    if (path === base) return JSON.stringify({ id: 42, path_with_namespace: "Platform/Backend/Service", web_url: web, default_branch: "main" });
    const number = Number(/\/issues\/(\d+)$/u.exec(path)?.[1]);
    const issue = issues[number];
    if (!path.startsWith(`${base}/issues/`) || !issue) throw Object.assign(new Error("glab failed"), { stderr: "HTTP 404 Not Found", code: 1 });
    return JSON.stringify({ id: 9000 + number, iid: number, project_id: issue.project_id ?? 42, title: issue.title, description: issue.description ?? null,
      state: "opened", web_url: issue.web_url ?? `${web}/-/issues/${number}`, updated_at: "2026-10-01T10:00:00Z", assignees: [], labels: [] });
  };
  return { run, calls };
}

test("GitLab epics are checklist-only: #N and same-project issue URLs, never epics, links or other projects", async () => {
  const { run, calls } = gitlabScope({
    1: { title: "Umbrella", description: [
      "## Units", "- [ ] #3 Work (depends on #99)",
      "- [x] https://gitlab.example.com/platform/backend/service/-/issues/4 Done",
      "- [ ] https://gitlab.example.com/platform/other/-/issues/5 Other project",
      "- [ ] https://elsewhere.example.com/Platform/Backend/Service/-/issues/6 Other host",
      "## Dependencies", "- [ ] #98 Other"].join("\n") },
    3: { title: "Three" }, 4: { title: "Four" }, 7: { title: "Seven" },
  });
  const result = await inspectCampaignIssueScope(run, 1, [7]);
  assert.equal(result.repository, "gitlab.example.com/platform/backend/service");
  assert.deepEqual(result.candidates.map((c) => [c.issue.repository, c.issue.number, c.source, c.title]), [
    ["gitlab.example.com/platform/backend/service", 1, "umbrella", "Umbrella"],
    ["gitlab.example.com/platform/backend/service", 3, "member_checklist", "Three"],
    ["gitlab.example.com/platform/backend/service", 4, "member_checklist", "Four"],
    ["gitlab.example.com/platform/backend/service", 7, "member_checklist", "Seven"],
  ]);
  assert.ok(!calls.some((call) => call[0] === "gh"), "GitLab scope never runs gh");
  assert.ok(!calls.some((call) => call.some((arg) => /epics|links|\/(?:5|6|98|99)$/u.test(arg))));
});

test("GitLab scope reads nothing for a bare origin check and refuses unverifiable issues", async () => {
  const bare = gitlabScope({});
  assert.deepEqual(await inspectCampaignIssueScope(bare.run), { repository: "gitlab.example.com/platform/backend/service", candidates: [] });
  assert.deepEqual(bare.calls.map((call) => call[0]), ["git"], "the launch and synchronization origin check is local");
  for (const issue of [{ title: "Moved", web_url: "https://gitlab.example.com/other/project/-/issues/2" }, { title: "Foreign", project_id: 7 }]) {
    await assert.rejects(inspectCampaignIssueScope(gitlabScope({ 2: issue }).run, undefined, [2]), /GitLab issue identity is invalid/);
  }
  await assert.rejects(inspectCampaignIssueScope(gitlabScope({}).run, undefined, [2]), /GitLab has no such project, issue or merge request/);
});

test("campaign issue publication stays GitHub-only", async () => {
  const publication = {sanitizedTitle:"Related repair",sanitizedBody:"## Problem\nFailure\n## Proposed Behavior\nRepair\n## Acceptance Criteria\n- Works\n## Security and Compatibility\nNone",labels:[]};
  const { run, calls } = gitlabScope({ 10: { title: "Related repair" } });
  await assert.rejects(inspectCampaignPublication(run, publication), (error: Error) =>
    error instanceof CampaignIssueScopeRefusal && error.message === "Campaign issue publication supports GitHub repositories only");
  await assert.rejects(inspectCampaignIssueScope(run, undefined, [10], publication), CampaignIssueScopeRefusal);
  assert.ok(!calls.some((call) => call[0] === "glab"), "publication is refused before any GitLab read");
});

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
  for(const changed of ["none","title","body","labels"]) {
    const run=async(command:string)=>command==="git"?"https://github.com/team/repo.git":JSON.stringify({number:10,title:changed==="title"?"Changed":"Exact",body:changed==="body"?"Changed body":"Exact body",labels:[{name:changed==="labels"?"bug":"feature"}],html_url:"https://github.com/team/repo/issues/10"});
    if(changed!=="none") await assert.rejects(inspectCampaignIssueScope(run,undefined,[10],publication));
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
