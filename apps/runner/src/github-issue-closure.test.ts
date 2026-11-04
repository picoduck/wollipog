import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubIssueClosureSnapshot } from "@wollipog/protocol";
import { executeGithubIssueClosure, inspectGithubIssueClosure, IssueClosureInspectionError, issueClosureRun } from "./github-issue-closure.js";

const connection = (nodes: unknown[] = []) => ({ nodes, pageInfo: { hasNextPage: false } });
test("#4164 merge-queue delivery survives a comparison larger than the command buffer", async () => {
  const f = fixture();
  const bounded = issueClosureRun({ kind: "native" }, process.cwd());
  const run = async (command: string, args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/"));
    if (path === "repos/team/repo") return JSON.stringify({ default_branch: "main" });
    if (path === "repos/team/repo/pulls/10") return JSON.stringify({ number: 10, state: "closed", merged: true,
      merge_commit_sha: "c".repeat(40), head: { sha: "b".repeat(40) }, base: { ref: "main", repo: { full_name: "team/repo" } } });
    if (path?.includes("/compare/")) {
      // Model gh's projection through the real bounded subprocess transport. Without it,
      // main's accumulated file patches exceed the unchanged 2 MiB command output bound.
      const projected = args.includes("--jq") && args.at(-1) === "{status: .status}";
      return bounded(process.execPath, ["-e", projected ? 'process.stdout.write(JSON.stringify({status:"ahead"}))'
        : 'process.stdout.write(JSON.stringify({status:"ahead",files:[{patch:"x".repeat(3*1024*1024)}]}))']);
    }
    return f.run(command, args);
  };
  const first = await inspectGithubIssueClosure(123, run);
  await assert.rejects(inspectGithubIssueClosure(123, (command, args) => {
    const jq = args.indexOf("--jq");
    return run(command, jq < 0 ? args : args.slice(0, jq));
  }, [{ number: 10, headSha: "b".repeat(40) }]), (error: unknown) => {
    assert.ok(error instanceof IssueClosureInspectionError);
    assert.deepEqual(error.deliveryVerificationFailure, { check: "comparison_read", pullRequest: 10 });
    return true;
  });
  const verified = await inspectGithubIssueClosure(123, run, [{ number: 10, headSha: "b".repeat(40) }]);
  assert.equal(verified.forgeDigest, first.forgeDigest);
  assert.deepEqual(verified.delivery, [{ number: 10, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }]);
});
function fixture() {
  const repository = { nameWithOwner: "team/repo", issue: {
    id: "issue-id", number: 123, title: "Obsolete task", body: "Original description",
    url: "https://github.com/team/repo/issues/123", state: "OPEN", updatedAt: "2026-10-01T10:00:00Z",
    labels: connection([{ name: "enhancement" }]), assignees: connection([{ login: "worker" }]),
    timelineItems: connection(),
  }, pullRequests: connection() };
  const calls: Array<{ command: string; args: string[] }> = [];
  let remote = "git@github.com:team/repo.git";
  let closeFailure = false;
  let verifyOpen = false;
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "git") return remote;
    if (args[0] === "issue") {
      if (closeFailure) throw new Error("connection lost after posting a comment");
      if (!verifyOpen) repository.issue.state = "CLOSED";
      return "";
    }
    return JSON.stringify({ data: { repository } });
  };
  return { repository, calls, run, setRemote: (value: string) => { remote = value; },
    failClose: () => { closeFailure = true; }, leaveOpen: () => { verifyOpen = true; } };
}
async function snapshot(f: ReturnType<typeof fixture>): Promise<GithubIssueClosureSnapshot> {
  const { state: _state, ...inspection } = await inspectGithubIssueClosure(123, f.run);
  return { ...inspection, category: "issue_closure", reason: "not_planned", explanation: "Retire obsolete work.",
    evidence: ["Superseded by the new design."], comment: "Retired. `literal` $(literal)\nSecond line.", activeChildren: [] };
}

test("issue and scope commands run with the Orchestrator agent's forge environment", async () => {
  const run = issueClosureRun({ kind: "native" }, process.cwd(), { GITLAB_TOKEN: "agent-token", GLAB_CONFIG_DIR: "/agent/glab" });
  const seen = (await run("sh", ["-c", 'printf "%s|%s|%s" "$GITLAB_TOKEN" "$GLAB_CONFIG_DIR" "$NO_PROMPT"'])).trim();
  assert.equal(seen, "agent-token|/agent/glab|1");
  // The prompt guards always win over an agent value.
  const guarded = issueClosureRun({ kind: "native" }, process.cwd(), { NO_PROMPT: "0", GH_PROMPT_DISABLED: "0" });
  assert.equal((await guarded("sh", ["-c", 'printf "%s|%s" "$NO_PROMPT" "$GH_PROMPT_DISABLED"'])).trim(), "1|1");
});

test("issue closure executes the exact argv once and verifies GitHub state", async () => {
  const f = fixture();
  const approved = await snapshot(f);
  let began = 0;
  assert.equal((await executeGithubIssueClosure(approved, f.run, () => ++began === 1)).outcome, "closed");
  const mutations = f.calls.filter((call) => call.args[0] === "issue");
  assert.deepEqual(mutations, [{ command: "gh", args: ["issue", "close", approved.url, "--reason", "not planned", "--comment", approved.comment!] }]);
  assert.equal((await executeGithubIssueClosure(approved, f.run, () => { began++; return true; })).outcome, "already_closed");
  assert.equal(began, 1, "already-closed issues never post another comment");
  assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 1);
});

test("issue closure refuses changed contents, labels, assignees, PR work, and repository scope", async () => {
  for (const [change, reason, pullRequests] of [
    [(f: ReturnType<typeof fixture>) => { f.repository.issue.body = "Edited description"; }, "issue_changed", undefined],
    [(f: ReturnType<typeof fixture>) => { f.repository.issue.updatedAt = "2026-10-01T11:00:00Z"; }, "issue_changed", undefined],
    [(f: ReturnType<typeof fixture>) => { f.repository.issue.labels.nodes = [{ name: "blocked" }]; }, "issue_changed", undefined],
    [(f: ReturnType<typeof fixture>) => { f.repository.issue.assignees.nodes = [{ login: "another-worker" }]; }, "issue_changed", undefined],
    [(f: ReturnType<typeof fixture>) => { f.repository.pullRequests.nodes = [relatedPullRequest(77, { title: "Fix #123" })]; }, "related_pull_requests_changed", [77]],
  ] as const) {
    const f = fixture(); const approved = await snapshot(f); change(f);
    const result = await executeGithubIssueClosure(approved, f.run, () => assert.fail("no mutation fence should begin"));
    assert.equal(result.outcome, "refused");
    assert.equal(result.refusal?.reason, reason);
    assert.deepEqual(result.refusal?.pullRequests, pullRequests);
    assert.equal(result.refusal?.forgeWritten, false);
    assert.equal(result.refusal?.nextStep, "request_new_closure");
    assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 0);
  }
  const f = fixture(); const approved = await snapshot(f); f.setRemote("git@github.com:other/repo.git");
  await assert.rejects(executeGithubIssueClosure(approved, f.run, () => true),
    (error: unknown) => error instanceof IssueClosureInspectionError && /identity changed/.test(error.message) && error.failure === "repository_changed");
  const renamed = fixture(); const before = await snapshot(renamed);
  const result = await executeGithubIssueClosure({ ...before, repository: "team/other" }, renamed.run, () => assert.fail("no mutation fence should begin"));
  assert.equal(result.refusal?.reason, "repository_changed");
});

function relatedPullRequest(number: number, change: { title?: string; body?: string; headRefOid?: string; updatedAt?: string; closes?: boolean } = {}) {
  return { number, title: change.title ?? "Work", body: change.body ?? "Refs #123", url: `https://github.com/team/repo/pull/${number}`,
    headRefOid: change.headRefOid ?? "a".repeat(40), updatedAt: change.updatedAt ?? "2026-11-01T16:55:00Z",
    closingIssuesReferences: connection(change.closes ? [{ number: 123, repository: { nameWithOwner: "team/repo" } }] : []) };
}

test("routine activity on a related open PR keeps an approved closure (#4059)", async () => {
  for (const activity of [
    { headRefOid: "b".repeat(40), updatedAt: "2026-11-01T17:28:30Z" },
    { body: "Refs #123\n\nMerged main and addressed review.", updatedAt: "2026-11-01T17:28:30Z" },
    { title: "Renamed Work", updatedAt: "2026-11-01T17:28:30Z" },
  ]) {
    const f = fixture();
    f.repository.pullRequests.nodes = [relatedPullRequest(77)];
    const approved = await snapshot(f);
    assert.deepEqual(approved.openPullRequests.map((pr) => [pr.number, pr.closesIssue]), [[77, false]]);
    f.repository.pullRequests.nodes = [relatedPullRequest(77, activity)];
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => true)).outcome, "closed", JSON.stringify(activity));
    assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 1);
  }
});

test("a changed related PR set or closing reference still refuses and names the PR (#4059)", async () => {
  for (const [before, after, reason, pullRequests] of [
    // The body edit drops the only mention, so the PR is no longer related.
    [[relatedPullRequest(77)], [relatedPullRequest(77, { body: "Unrelated work" })], "related_pull_requests_changed", [77]],
    [[relatedPullRequest(77)], [relatedPullRequest(77), relatedPullRequest(78)], "related_pull_requests_changed", [78]],
    [[relatedPullRequest(77)], [relatedPullRequest(77, { body: "Closes #123", closes: true })], "closing_reference_changed", [77]],
    [[relatedPullRequest(77, { closes: true })], [relatedPullRequest(77, { body: "Refs #123" })], "closing_reference_changed", [77]],
  ] as const) {
    const f = fixture();
    f.repository.pullRequests.nodes = [...before];
    const approved = await snapshot(f);
    f.repository.pullRequests.nodes = [...after];
    const result = await executeGithubIssueClosure(approved, f.run, () => assert.fail("no mutation fence should begin"));
    assert.equal(result.outcome, "refused");
    assert.equal(result.refusal?.reason, reason);
    assert.deepEqual(result.refusal?.pullRequests, pullRequests);
    assert.match(result.refusal?.summary ?? "", new RegExp(`#${pullRequests[0]}\\b.*Nothing was written; request a new closure`));
    assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 0);
  }
  // A snapshot from a runner that predates closing-reference attribution names only set changes.
  const f = fixture();
  f.repository.pullRequests.nodes = [relatedPullRequest(77)];
  const approved = await snapshot(f);
  const legacy = { ...approved, forgeDigest: "f".repeat(64), openPullRequests: approved.openPullRequests.map(({ closesIssue: _closes, ...pr }) => pr) };
  assert.equal((await executeGithubIssueClosure(legacy, f.run, () => assert.fail("no mutation fence should begin"))).refusal?.reason, "forge_evidence_changed");
});

test("an Orchestrator-owned closure names an open related PR and changed delivery (#4059)", async () => {
  const open = fixture();
  open.repository.pullRequests.nodes = [relatedPullRequest(77)];
  const admitted = { ...await snapshot(open), issueAdmission: { boundaryRevision: 1, evidenceDigest: "a".repeat(64) } };
  const result = await executeGithubIssueClosure(admitted, open.run, () => assert.fail("no mutation fence should begin"));
  assert.deepEqual([result.refusal?.reason, result.refusal?.pullRequests], ["related_pull_request_open", [77]]);

  const f = fixture();
  const run = async (command: string, args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? args.at(-1)!;
    if (path === "repos/team/repo") return JSON.stringify({ default_branch: "main" });
    if (path === "repos/team/repo/pulls/10") return JSON.stringify({ number: 10, state: "closed", merged: true, merge_commit_sha: "c".repeat(40),
      head: { sha: "b".repeat(40) }, base: { ref: "main", repo: { full_name: "team/repo" } } });
    if (path.includes("/compare/")) return JSON.stringify({ status: "ahead" });
    return f.run(command, args);
  };
  const delivered = { ...await snapshot(f), issueAdmission: { boundaryRevision: 1, evidenceDigest: "a".repeat(64) },
    delivery: [{ number: 10, headSha: "b".repeat(40), mergeCommitSha: "d".repeat(40) }] };
  const changed = await executeGithubIssueClosure(delivered, run, () => assert.fail("no mutation fence should begin"));
  assert.deepEqual([changed.refusal?.reason, changed.refusal?.pullRequests], ["delivery_changed", [10]]);
});

test("issue closure conflict inspection includes linked and cross-referenced PRs", async () => {
  const f = fixture();
  f.repository.issue.timelineItems.nodes = [{ source: { number: 78, url: "https://github.com/team/repo/pull/78", state: "OPEN", repository: { nameWithOwner: "team/repo" } } }];
  f.repository.pullRequests.nodes = [77, 78, 79].map((number) => ({ number, title: "Work", body: "No mention", url: `https://github.com/team/repo/pull/${number}`, headRefOid: "a".repeat(40), updatedAt: "now", closingIssuesReferences: connection(number === 77 ? [{ number: 123, repository: { nameWithOwner: "team/repo" } }] : []) }));
  assert.deepEqual((await inspectGithubIssueClosure(123, f.run)).openPullRequests.map((pr) => pr.number), [77, 78]);
});

test("issue closure fails closed for incomplete inspection and a rejected durable fence", async () => {
  for (const target of ["labels", "assignees", "timelineItems", "pullRequests"] as const) {
    const f = fixture();
    (target === "pullRequests" ? f.repository.pullRequests : f.repository.issue[target]).pageInfo.hasNextPage = true;
    await assert.rejects(inspectGithubIssueClosure(123, f.run), /bounded inspection limit/);
  }
  const f = fixture(); const approved = await snapshot(f);
  assert.equal((await executeGithubIssueClosure(approved, f.run, () => false)).refusal?.reason, "mutation_fence_unavailable");
  assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 0);
});

test("issue closure reports partial failures and unverified final state as uncertain without retry", async () => {
  for (const mode of ["failure", "unverified"] as const) {
    const f = fixture(); const approved = await snapshot(f);
    if (mode === "failure") f.failClose(); else f.leaveOpen();
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => true)).outcome, "uncertain");
    assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 1);
  }
});

test("completed closure verifies the delivered head, actual default-branch merge and commit containment", async () => {
  for (const mode of ["merged","queued","changed-head","feature-base","not-contained"]) {
    const f=fixture();
    const run=async(command:string,args:string[])=> {
      const path=args.find((arg) => arg.startsWith("repos/")) ?? args.at(-1)!;
      if(path==="repos/team/repo") return JSON.stringify({default_branch:"main"});
      if(path==="repos/team/repo/pulls/10") return JSON.stringify({number:10,state:mode==="queued"?"open":"closed",merged:mode!=="queued",merge_commit_sha:"c".repeat(40),
        head:{sha:(mode==="changed-head"?"d":"b").repeat(40)},base:{ref:mode==="feature-base"?"feature":"main",repo:{full_name:"team/repo"}}});
      if(path.includes("/compare/")) return JSON.stringify({status:mode==="not-contained"?"diverged":"ahead"});
      return f.run(command,args);
    };
    const inspect=inspectGithubIssueClosure(123,run,[{number:10,headSha:"b".repeat(40)}]);
    if(mode==="merged") assert.deepEqual((await inspect).delivery,[{number:10,headSha:"b".repeat(40),mergeCommitSha:"c".repeat(40)}]);
    else await assert.rejects(inspect, (error: unknown) => {
      assert.ok(error instanceof IssueClosureInspectionError);
      assert.deepEqual(error.deliveryVerificationFailure, { check: ({queued:"merged_state", "changed-head":"head", "feature-base":"base", "not-contained":"containment"} as Record<string,string>)[mode], pullRequest: 10 });
      assert.match(error.message, new RegExp(`failed at ${error.deliveryVerificationFailure!.check} for #10`));
      return true;
    });
  }
});

/** An epic fixture (#4060): sub-issues and checklist members the runner reads with their states. */
function epicFixture() {
  const f = fixture();
  f.repository.issue.body = "## Members\n- [x] #201\n- [ ] https://github.com/team/repo/issues/202\n- [ ] #123\n\n## Notes\n- [ ] #999";
  const subIssues: Array<Record<string, unknown>> = [{ number: 200, state: "closed", state_reason: "completed", html_url: "https://github.com/team/repo/issues/200" }];
  const issues = new Map<number, Record<string, unknown> | "fail">([
    [201, { number: 201, state: "closed", state_reason: "completed", html_url: "https://github.com/team/repo/issues/201" }],
    [202, { number: 202, state: "open", state_reason: null, html_url: "https://github.com/team/repo/issues/202" }],
  ]);
  let subIssuesFail = false;
  const run = async (command: string, args: string[]) => {
    const path = args.at(-1)!;
    if (path === "repos/team/repo/issues/123/sub_issues?per_page=100") {
      if (subIssuesFail) throw new Error("rate limited");
      return JSON.stringify(subIssues);
    }
    const member = /^repos\/team\/repo\/issues\/(\d+)$/u.exec(path);
    if (member) {
      const raw = issues.get(Number(member[1]));
      if (!raw || raw === "fail") throw new Error("not found");
      return JSON.stringify(raw);
    }
    return f.run(command, args);
  };
  return { ...f, run, subIssues, issues, failSubIssues: () => { subIssuesFail = true; } };
}

test("an epic's members come from its sub-issues and member checklist, with each member's state (#4060)", async () => {
  const f = epicFixture();
  const plain = await inspectGithubIssueClosure(123, f.run);
  assert.equal(plain.epicMembers, undefined, "members are read only when asked");
  assert.equal(f.calls.some((call) => call.args.at(-1)?.includes("sub_issues")), false);
  const read = await inspectGithubIssueClosure(123, f.run, undefined, true);
  // The epic itself and a row outside the member section are never members.
  assert.deepEqual(read.epicMembers, { readable: true, members: [
    { number: 200, state: "completed" }, { number: 201, state: "completed" }, { number: 202, state: "open" }] });
  assert.notEqual(read.forgeDigest, plain.forgeDigest, "the member read is bound into the digest");
  assert.equal((await inspectGithubIssueClosure(123, f.run, undefined, true)).forgeDigest, read.forgeDigest);

  f.issues.set(201, { number: 201, state: "closed", state_reason: "not_planned", html_url: "https://github.com/team/repo/issues/201" });
  f.issues.set(202, "fail");
  f.subIssues.push({ number: 203, state: "closed", state_reason: null, html_url: "https://github.com/team/repo/issues/203" });
  assert.deepEqual((await inspectGithubIssueClosure(123, f.run, undefined, true)).epicMembers?.members, [
    { number: 200, state: "completed" }, { number: 201, state: "closed_not_completed" }, { number: 202, state: "unreadable" },
    { number: 203, state: "closed_not_completed" }]);
});

test("an epic's member list is unreadable as a whole when its sub-issues cannot be read in full (#4060)", async () => {
  for (const change of [
    (f: ReturnType<typeof epicFixture>) => f.failSubIssues(),
    (f: ReturnType<typeof epicFixture>) => { f.subIssues.push({ number: 300, state: "open", html_url: "https://github.com/other/repo/issues/300" }); },
    (f: ReturnType<typeof epicFixture>) => { f.subIssues.push({ number: 301, state: "open", html_url: "https://github.com/team/repo/issues/301", pull_request: {} }); },
    (f: ReturnType<typeof epicFixture>) => { for (let n = 400; n < 500; n++) f.subIssues.push({ number: n, state: "open", html_url: `https://github.com/team/repo/issues/${n}` }); },
  ]) {
    const f = epicFixture(); change(f);
    assert.deepEqual((await inspectGithubIssueClosure(123, f.run, undefined, true)).epicMembers, { readable: false, members: [] });
  }
});

test("an approval proven from an epic's members is refused when a member joins or changes state (#4060)", async () => {
  for (const change of [
    (f: ReturnType<typeof epicFixture>) => { f.subIssues.push({ number: 204, state: "open", html_url: "https://github.com/team/repo/issues/204" }); },
    (f: ReturnType<typeof epicFixture>) => { f.issues.set(201, { number: 201, state: "open", html_url: "https://github.com/team/repo/issues/201" }); },
  ]) {
    const f = epicFixture();
    const { state: _state, ...inspection } = await inspectGithubIssueClosure(123, f.run, undefined, true);
    const approved: GithubIssueClosureSnapshot = { ...inspection, category: "issue_closure", reason: "completed", explanation: "Members delivered.",
      evidence: ["Every member closed."], activeChildren: [], issueAdmission: { boundaryRevision: 1, evidenceDigest: "a".repeat(64) } };
    change(f);
    const result = await executeGithubIssueClosure(approved, f.run, () => assert.fail("no mutation fence should begin"));
    assert.equal(result.refusal?.reason, "epic_members_changed");
    assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 0);
  }
  const f = epicFixture();
  const { state: _state, ...inspection } = await inspectGithubIssueClosure(123, f.run, undefined, true);
  const approved: GithubIssueClosureSnapshot = { ...inspection, category: "issue_closure", reason: "completed", explanation: "Members delivered.",
    evidence: ["Every member closed."], activeChildren: [] };
  assert.equal((await executeGithubIssueClosure(approved, f.run, () => true)).outcome, "closed", "an unchanged member read keeps the approval");
});
