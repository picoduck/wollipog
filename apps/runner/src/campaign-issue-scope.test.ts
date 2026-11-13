import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignIssueScopeRefusal, inspectCampaignFailedRun, inspectCampaignIssueScope, inspectCampaignPublication } from "./campaign-issue-scope.js";

for (const scenario of ["merge failure", "required failure", "another PR", "passed", "cancelled", "skipped", "wrong head", "optional check", "wrong job", "passing check", "cancelled check", "skipped check"] as const) {
  test(`failed campaign run evidence: ${scenario}`, async () => {
    const evidence = { repository: "team/repo", pullRequest: 10, headSha: "a".repeat(40), runId: 123, jobId: 321 };
    const merge = scenario !== "required failure" && scenario !== "optional check";
    const run = async (command: string, args: string[]) => {
      if (command === "git") return "https://github.com/team/repo.git";
      const path = args[args.indexOf("github.com") + 1];
      if (path?.includes("/jobs?")) return JSON.stringify({ total_count: 0, jobs: [] });
      if (path === "graphql") return JSON.stringify({ data: { node: { databaseId: 456, isRequired: scenario !== "optional check" } } });
      if (path?.includes("actions/runs/")) return JSON.stringify({ id: 123, repository: { full_name: "team/repo" },
        status: "completed", conclusion: scenario === "passed" ? "success" : scenario === "cancelled" ? "cancelled" : scenario === "skipped" ? "skipped" : "failure", event: merge ? "merge_group" : "pull_request",
        head_sha: "b".repeat(40), check_suite_id: 789,
        head_branch: `gh-readonly-queue/main/pr-${scenario === "another PR" ? 11 : 10}-${scenario === "wrong head" ? "c".repeat(40) : evidence.headSha}`,
        pull_requests: [{ number: 10, head: { sha: evidence.headSha }, base: { repo: { full_name: "team/repo" } } }] });
      if (path?.includes("pulls/")) return JSON.stringify({ base: { ref: "main" } });
      if (path?.includes("compare/")) return JSON.stringify({ status: "ahead" });
      if (path?.includes("actions/jobs/")) return JSON.stringify({ id: 321, run_id: scenario === "wrong job" ? 124 : 123,
        status: "completed", conclusion: "failure", check_run_url: "https://api.github.com/repos/team/repo/check-runs/456" });
      if (path?.includes("check-runs/")) return JSON.stringify({ id: 456, node_id: "node456", head_sha: "b".repeat(40), name: "Broken Check",
        status: "completed", check_suite: { id: 789 }, conclusion: scenario === "passing check" ? "success"
          : scenario === "cancelled check" ? "cancelled" : scenario === "skipped check" ? "skipped" : "failure" });
      throw new Error(`Unexpected command ${args.join(" ")}`);
    };
    const result = await inspectCampaignFailedRun(run, evidence);
    assert.deepEqual(result.failedRun, scenario === "merge failure" || scenario === "required failure"
      ? { ...evidence, checkRunId: 456, checkName: "Broken Check",
        ...(scenario === "required failure" ? { requiredCheck: { checkRunId: 456, checkName: "Broken Check" } } : {}) } : undefined);
  });
}

for (const scenario of ["failed aggregator", "passing aggregator", "pending aggregator", "optional aggregator", "another PR",
  "another head", "aggregator head mismatch", "another run", "another suite", "overflow", "graphql error"] as const) {
  test(`branch campaign evidence with aggregator only: ${scenario}`, async () => {
    const evidence = { repository: "team/repo", pullRequest: 10, headSha: "a".repeat(40), runId: 123, jobId: 321 };
    const run = async (command: string, args: string[]) => {
      if (command === "git") return "https://github.com/team/repo.git";
      const path = args[args.indexOf("github.com") + 1];
      if (path === "graphql") {
        const aggregator = args.at(-1)!.includes("node789");
        return JSON.stringify({ ...(scenario === "graphql error" ? { errors: [{}] } : {}),
          data: { node: { databaseId: aggregator ? 789 : 456, isRequired: aggregator && scenario !== "optional aggregator" } } });
      }
      if (path?.endsWith("actions/runs/123")) return JSON.stringify({ id: 123, repository: { full_name: "team/repo" },
        status: "completed", conclusion: "failure", event: "pull_request", head_sha: "b".repeat(40), check_suite_id: 999,
        pull_requests: [{ number: scenario === "another PR" ? 11 : 10, head: { sha: scenario === "another head" ? "c".repeat(40) : evidence.headSha },
          base: { repo: { full_name: "team/repo" } } }] });
      const job = { id: 322, run_id: scenario === "another run" ? 124 : 123, status: "completed", conclusion: "failure",
        check_run_url: "https://api.github.com/repos/team/repo/check-runs/789" };
      if (path?.includes("/jobs?")) return JSON.stringify({ total_count: scenario === "overflow" ? 101 : 1, jobs: [job] });
      if (path?.includes("actions/jobs/")) return JSON.stringify({ ...job, id: 321, run_id: 123,
        check_run_url: "https://api.github.com/repos/team/repo/check-runs/456" });
      if (path?.includes("check-runs/")) {
        const aggregator = path.endsWith("789");
        return JSON.stringify({ id: aggregator ? 789 : 456, node_id: aggregator ? "node789" : "node456",
          name: aggregator ? "Required Summary" : "Unit Tests (2)",
          head_sha: aggregator && scenario === "aggregator head mismatch" ? "c".repeat(40) : "b".repeat(40),
          check_suite: { id: aggregator && scenario === "another suite" ? 998 : 999 },
          status: aggregator && scenario === "pending aggregator" ? "in_progress" : "completed",
          conclusion: aggregator && scenario === "passing aggregator" ? "success" : "failure" });
      }
      throw new Error(`Unexpected command ${args.join(" ")}`);
    };
    assert.deepEqual((await inspectCampaignFailedRun(run, evidence)).failedRun, scenario === "failed aggregator"
      ? { ...evidence, checkRunId: 456, checkName: "Unit Tests (2)", requiredCheck: { checkRunId: 789, checkName: "Required Summary" } } : undefined);
  });
}

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

test("a tagged publication searches by its subject and finds an older untagged duplicate (#2940)", async () => {
  const publication = {sanitizedTitle:"[Bug]: Related repair",sanitizedBody:"## Problem\nFailure\n## Proposed Behavior\nRepair\n## Acceptance Criteria\n- Works\n## Security and Compatibility\nNone",labels:[]};
  const queries: string[] = [];
  for (const existing of [true, false]) {
    const duplicate={number:123,title:"Related repair",html_url:"https://github.com/team/repo/issues/123"};
    // GitHub matches every search term, so a query carrying the tag's "Bug" term filters out the untagged issue.
    const run=async (command:string,args:string[]) => {
      if(command==="git") return "https://github.com/team/repo.git";
      if(args.some((arg)=>arg.includes("sort=created"))) return "[]";
      const query=args.find((arg)=>arg.startsWith("q="))!; queries.push(query);
      const items=existing && !/\bbug\b/iu.test(query) ? [duplicate] : [];
      return JSON.stringify({items,total_count:items.length,incomplete_results:false});
    };
    if(existing) await assert.rejects(inspectCampaignPublication(run,publication),/normalized title/u);
    else assert.equal((await inspectCampaignPublication(run,publication)).duplicateSearch,"subject");
  }
  assert.deepEqual(queries,Array(2).fill("q=repo:team/repo is:issue in:title Related repair"));
});

test("an untagged publication matches an existing tagged issue with the same subject (#2940)", async () => {
  const publication = {sanitizedTitle:"Related repair",sanitizedBody:"## Problem\nFailure\n## Proposed Behavior\nRepair\n## Acceptance Criteria\n- Works\n## Security and Compatibility\nNone",labels:[]};
  const tagged={number:123,title:"[Bug]: Related repair",html_url:"https://github.com/team/repo/issues/123"};
  const run=async (command:string,args:string[]) => {
    if(command==="git") return "https://github.com/team/repo.git";
    if(args.some((arg)=>arg.includes("sort=created"))) return "[]";
    return JSON.stringify({items:[tagged],total_count:1,incomplete_results:false});
  };
  await assert.rejects(inspectCampaignPublication(run,publication),/normalized title/u);
});

test("follow-up scope inspects exact title, body and labels rather than trusting its issue number", async () => {
  const publication={sanitizedTitle:"Exact",sanitizedBody:"Exact body",labels:["feature"]};
  for(const changed of ["none","title","body","labels"]) {
    const run=async(command:string)=>command==="git"?"https://github.com/team/repo.git":JSON.stringify({number:10,title:changed==="title"?"Changed":"Exact",body:changed==="body"?"Changed body":"Exact body",labels:[{name:changed==="labels"?"bug":"feature"}],html_url:"https://github.com/team/repo/issues/10"});
    if(changed!=="none") await assert.rejects(inspectCampaignIssueScope(run,undefined,[10],publication));
    else assert.equal((await inspectCampaignIssueScope(run,undefined,[10],publication)).candidates[0]!.issue.number,10);
  }
});

test("published bodies ignore only trailing whitespace, with content-free field refusals (#4404)", async () => {
  const publication = { sanitizedTitle: "Private title", sanitizedBody: "Private body\nSecond line", labels: ["feature"] };
  for (const [body, title, labels, field] of [
    [publication.sanitizedBody + "\n", publication.sanitizedTitle, ["feature"], null],
    [publication.sanitizedBody + " \t\r\n", publication.sanitizedTitle, ["feature"], null],
    [" " + publication.sanitizedBody, publication.sanitizedTitle, ["feature"], "body"],
    ["Private  body\nSecond line", publication.sanitizedTitle, ["feature"], "body"],
    ["Private body\nChanged line", publication.sanitizedTitle, ["feature"], "body"],
    [publication.sanitizedBody, publication.sanitizedTitle + " ", ["feature"], "title"],
    [publication.sanitizedBody, "Other title", ["feature"], "title"],
    [publication.sanitizedBody, publication.sanitizedTitle, ["bug"], "labels"],
  ] as const) {
    const run = async (command: string) => command === "git" ? "https://github.com/team/repo.git" : JSON.stringify({ number: 10,
      title, body, labels: labels.map((name) => ({ name })), html_url: "https://github.com/team/repo/issues/10" });
    if (field) await assert.rejects(inspectCampaignIssueScope(run, undefined, [10], publication), (error: Error) => {
      assert.match(error.message, new RegExp(field));
      assert.doesNotMatch(error.message, /Private|Second|feature|bug/);
      return true;
    });
    else assert.equal((await inspectCampaignIssueScope(run, undefined, [10], publication)).candidates.length, 1);
    // Compare both directions, including an approved trailing newline absent on the forge.
    if (!field) assert.equal((await inspectCampaignIssueScope(async (command) => command === "git" ? "https://github.com/team/repo.git" : JSON.stringify({
      number: 10, title, body: publication.sanitizedBody, labels: [{ name: "feature" }], html_url: "https://github.com/team/repo/issues/10" }),
      undefined, [10], { ...publication, sanitizedBody: body })).candidates.length, 1);
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

test("a facts read (#4103) reports each issue's state, labels and assignees, and a pull request instead of failing", async () => {
  const body = "x".repeat(3000);
  const rows: Record<number, unknown> = {
    5: { number: 5, title: "Open", body, state: "open", html_url: "https://github.com/owner/repo/issues/5",
      labels: [{ name: "bug" }, { name: "Security" }], assignees: [{ login: "octo" }] },
    6: { number: 6, title: "Closed", body: null, state: "closed", html_url: "https://github.com/owner/repo/issues/6", labels: [], assignees: [] },
    7: { number: 7, title: "A pull request", body: "", state: "open", html_url: "https://github.com/owner/repo/pull/7",
      pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/7" }, labels: [], assignees: [] },
  };
  const run = async (command: string, args: string[]) => {
    if (command === "git") return "git@github.com:owner/repo.git";
    const number = Number(/issues\/(\d+)$/u.exec(args.at(-1)!)?.[1]);
    return JSON.stringify(rows[number]);
  };
  const result = await inspectCampaignIssueScope(run, undefined, [5, 6, 7], undefined, true);
  assert.deepEqual(result.candidates.map((c) => c.issue.number), [5, 6], "a pull request is never a candidate");
  assert.deepEqual(result.issueFacts!.map(({ bodyExcerpt, ...fact }) => ({ ...fact, excerpt: bodyExcerpt.length })).sort((a, b) => a.number - b.number), [
    { number: 5, kind: "issue", state: "open", labels: ["bug", "Security"], assignees: ["octo"], title: "Open", excerpt: 2000 },
    { number: 6, kind: "issue", state: "closed", labels: [], assignees: [], title: "Closed", excerpt: 0 },
    { number: 7, kind: "pull_request", state: "open", labels: [], assignees: [], title: "A pull request", excerpt: 0 },
  ]);
  // Labels are never truncated: the Human Required floor reads every one, and an issue whose labels
  // exceed the bounds fails the read instead of reporting a partial list.
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `area-${i}` })).concat({ name: "security" });
  rows[8] = { number: 8, title: "Many labels", body: "", state: "open", html_url: "https://github.com/owner/repo/issues/8", labels: many, assignees: [] };
  assert.deepEqual((await inspectCampaignIssueScope(run, undefined, [8], undefined, true)).issueFacts![0]!.labels.at(-1), "security");
  rows[9] = { ...rows[8] as object, number: 9, html_url: "https://github.com/owner/repo/issues/9",
    labels: Array.from({ length: 101 }, (_, i) => ({ name: `area-${i}` })) };
  await assert.rejects(inspectCampaignIssueScope(run, undefined, [9], undefined, true), /could not be reported in full/);
  rows[10] = { ...rows[8] as object, number: 10, html_url: "https://github.com/owner/repo/issues/10", labels: [{ name: "x".repeat(256) }] };
  await assert.rejects(inspectCampaignIssueScope(run, undefined, [10], undefined, true), /could not be reported in full/);
  // Without facts a pull request still fails the whole read, as before.
  await assert.rejects(inspectCampaignIssueScope(run, undefined, [5, 7]), /could not verify/);
  assert.equal((await inspectCampaignIssueScope(run, undefined, [5])).issueFacts, undefined);
  // GitLab reports facts from the same read.
  const gitlab = await inspectCampaignIssueScope(gitlabScope({ 3: { title: "Three" } }).run, undefined, [3], undefined, true);
  assert.deepEqual(gitlab.issueFacts, [{ number: 3, kind: "issue", state: "open", labels: [], assignees: [], title: "Three", bodyExcerpt: "" }]);
});
