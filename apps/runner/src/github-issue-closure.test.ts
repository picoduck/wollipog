import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubIssueClosureSnapshot } from "@wollipog/protocol";
import { executeGithubIssueClosure, inspectGithubIssueClosure } from "./github-issue-closure.js";

const connection = (nodes: unknown[] = []) => ({ nodes, pageInfo: { hasNextPage: false } });
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
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.repository.issue.body = "Edited description"; },
    (f: ReturnType<typeof fixture>) => { f.repository.issue.updatedAt = "2026-10-01T11:00:00Z"; },
    (f: ReturnType<typeof fixture>) => { f.repository.issue.labels.nodes = [{ name: "blocked" }]; },
    (f: ReturnType<typeof fixture>) => { f.repository.issue.assignees.nodes = [{ login: "another-worker" }]; },
    (f: ReturnType<typeof fixture>) => { f.repository.pullRequests.nodes = [{ number: 77, title: "Fix #123", body: "Work", url: "https://github.com/team/repo/pull/77", headRefOid: "a".repeat(40), updatedAt: "now", closingIssuesReferences: connection() }]; },
  ]) {
    const f = fixture(); const approved = await snapshot(f); change(f);
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => assert.fail("no mutation fence should begin"))).outcome, "refused");
    assert.equal(f.calls.filter((call) => call.args[0] === "issue").length, 0);
  }
  const f = fixture(); const approved = await snapshot(f); f.setRemote("git@github.com:other/repo.git");
  await assert.rejects(executeGithubIssueClosure(approved, f.run, () => true), /identity changed/);
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
  assert.equal((await executeGithubIssueClosure(approved, f.run, () => false)).outcome, "refused");
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
