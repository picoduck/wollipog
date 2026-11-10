/**
 * Merge closure watch (#4323): after a `pr_merge` is consumed, the runner reads what the pull request
 * or merge request would close in any state, and takes it out of the merge queue or train while it is
 * open at the approved head. `gh` and `glab` are fakes; no forge is contacted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome, GhRunner } from "./campaign-forge-status.js";
import type { GlabRunner } from "./campaign-gitlab-status.js";
import { dequeueMerge, readMergeClosures } from "./merge-closure-watch.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

const HEAD = "a".repeat(40);
const ok = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });
const failed: GhOutcome = { stdout: "", stderr: "HTTP 502", code: 1, timedOut: false };
const noGlab: GlabRunner = async (args) => { throw new Error(`unexpected glab ${args.join(" ")}`); };
const noGh: GhRunner = async (args) => { throw new Error(`unexpected gh ${args.join(" ")}`); };

/** A GitHub pull request whose state the fake mutations change, as GitHub would. */
function github(pr: { state?: string; headRefOid?: string; body?: string; queued?: boolean; autoMerge?: boolean }) {
  const state = { state: "OPEN", headRefOid: HEAD, body: "Refs #1.", queued: true, autoMerge: false, ...pr };
  const calls: string[] = [];
  const gh: GhRunner = async (args) => {
    const query = args.find((arg) => arg.startsWith("query="))!;
    if (query.includes("dequeuePullRequest")) { calls.push("dequeue"); state.queued = false; return ok({ data: { dequeuePullRequest: {} } }); }
    if (query.includes("disablePullRequestAutoMerge")) { calls.push("disable"); state.autoMerge = false; return ok({ data: {} }); }
    if (query.includes("closingIssuesReferences")) {
      calls.push("closures");
      return ok({ data: { repository: { nameWithOwner: "owner/app", pullRequest: { number: 5, state: state.state, headRefOid: state.headRefOid, body: state.body,
        closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
    }
    calls.push("queue");
    return ok({ data: { repository: { nameWithOwner: "owner/app", pullRequest: { id: "PR_1", number: 5, state: state.state, headRefOid: state.headRefOid,
      mergeQueueEntry: state.queued ? { id: "MQE_1" } : null, autoMergeRequest: state.autoMerge ? { enabledAt: "x" } : null } } } });
  };
  return { gh, calls, state };
}

const GITHUB = { repository: "owner/app", pullRequest: 5, headSha: HEAD };

test("a GitHub pull request is read in any state, with what it closes (#4323)", async () => {
  for (const [state, expected] of [["OPEN", "open"], ["MERGED", "merged"], ["CLOSED", "closed"]] as const) {
    const fake = github({ state, body: "This does not close #9." });
    const read = await readMergeClosures(GITHUB, { gh: fake.gh, glab: noGlab }, () => 7);
    assert.deepEqual(read, { ok: true, state: expected, headSha: HEAD,
      check: { checkedAt: 7, closures: [{ issue: "owner/app#9", sources: ["description"], excerpt: "This does not close #9." }] } });
  }
});

test("an unreadable forge is a fixed sentence, never unchanged (#4323)", async () => {
  const read = await readMergeClosures(GITHUB, { gh: async () => failed, glab: noGlab });
  assert.equal(read.ok, false);
  assert.ok(!read.ok && !read.reason.includes("502"));
});

test("a queued GitHub pull request is dequeued, and auto-merge turned off (#4323)", async () => {
  const fake = github({ queued: true, autoMerge: true });
  assert.deepEqual(await dequeueMerge(GITHUB, { gh: fake.gh, glab: noGlab }), { outcome: "dequeued" });
  assert.deepEqual(fake.calls, ["queue", "dequeue", "disable", "queue"]);
});

test("a GitHub dequeue writes nothing unless the pull request is open and queued at the approved head (#4323)", async () => {
  for (const [pr, outcome] of [[{ queued: false }, "not_queued"], [{ state: "MERGED" }, "merged"], [{ state: "CLOSED" }, "closed"],
    [{ headRefOid: "b".repeat(40) }, "head_changed"]] as const) {
    const fake = github(pr);
    assert.deepEqual(await dequeueMerge(GITHUB, { gh: fake.gh, glab: noGlab }), { outcome });
    assert.deepEqual(fake.calls, ["queue"], `${outcome}: only the read`);
  }
});

test("a GitHub dequeue that leaves the pull request queued is refused, and an unreadable answer after a write is uncertain (#4323)", async () => {
  const stuck = github({});
  const kept: GhRunner = async (args) => {
    const result = await stuck.gh(args);
    stuck.state.queued = true;
    return result;
  };
  assert.equal((await dequeueMerge(GITHUB, { gh: kept, glab: noGlab })).outcome, "refused");
  let reads = 0;
  const lost: GhRunner = async (args) => {
    if (args.some((arg) => arg.startsWith("query=") && arg.includes("autoMergeRequest")) && ++reads === 2) return failed;
    return github({}).gh(args);
  };
  assert.equal((await dequeueMerge(GITHUB, { gh: lost, glab: noGlab })).outcome, "uncertain");
});

const HOST = "gitlab.example.com";
const PROJECT = "group/app";
const MR_PATH = `projects/${encodeURIComponent(PROJECT)}/merge_requests/12`;
const GITLAB = { repository: `${HOST}/${PROJECT}`, pullRequest: 12, headSha: HEAD };

function gitlab(mr: { state?: string; sha?: string; description?: string; train?: boolean; keep?: boolean }) {
  const state = { state: "opened", sha: HEAD, description: "Refs #1.", train: true, keep: false, ...mr };
  const calls: string[] = [];
  const glab: GlabRunner = async (args) => {
    assert.ok(args.includes("--hostname") && args.includes(HOST), "every call names its host");
    if (args[1] === "--method" && args[3] === `${MR_PATH}/cancel_merge_when_pipeline_succeeds`) {
      calls.push("cancel");
      if (!state.keep) state.train = false;
      return ok({});
    }
    if (args[1] === `${MR_PATH}/closes_issues?per_page=100`) { calls.push("closes"); return ok([]); }
    if (args[1] === MR_PATH) {
      calls.push("read");
      return ok({ iid: 12, state: state.state, sha: state.sha, description: state.description, merge_when_pipeline_succeeds: state.train });
    }
    throw new Error(`unexpected glab ${args.join(" ")}`);
  };
  return { glab, calls };
}

test("a GitLab merge request is read in any state, with what it closes (#4323)", async () => {
  for (const [state, expected] of [["opened", "open"], ["locked", "open"], ["merged", "merged"], ["closed", "closed"]] as const) {
    const fake = gitlab({ state, description: "Closing #4 soon" });
    const read = await readMergeClosures(GITLAB, { gh: noGh, glab: fake.glab }, () => 3);
    assert.ok(read.ok);
    assert.equal(read.state, expected);
    assert.deepEqual(read.check.closures.map((closure) => closure.issue), [`${HOST}/${PROJECT}#4`]);
  }
});

test("a GitLab merge request on a merge train is taken off it; otherwise nothing is written (#4323)", async () => {
  const queued = gitlab({});
  assert.deepEqual(await dequeueMerge(GITLAB, { gh: noGh, glab: queued.glab }), { outcome: "dequeued" });
  assert.deepEqual(queued.calls, ["read", "cancel", "read"]);
  for (const [mr, outcome] of [[{ train: false }, "not_queued"], [{ state: "merged" }, "merged"], [{ state: "closed" }, "closed"],
    [{ sha: "c".repeat(40) }, "head_changed"]] as const) {
    const fake = gitlab(mr);
    assert.deepEqual(await dequeueMerge(GITLAB, { gh: noGh, glab: fake.glab }), { outcome });
    assert.deepEqual(fake.calls, ["read"]);
  }
  const kept = gitlab({ keep: true });
  assert.equal((await dequeueMerge(GITLAB, { gh: noGh, glab: kept.glab })).outcome, "refused");
});

test("a target the runner cannot name is refused before any forge call (#4323)", async () => {
  const forges = { gh: noGh, glab: noGlab };
  assert.equal((await readMergeClosures({ ...GITHUB, headSha: "short" }, forges)).ok, false);
  assert.equal((await dequeueMerge({ ...GITHUB, repository: "not a repository" }, forges)).outcome, "refused");
  assert.equal((await dequeueMerge({ ...GITHUB, pullRequest: 0 }, forges)).outcome, "refused");
});

test("the runner answers merge_closure_watch for its own session only, through that session's forge login (#4323)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-merge-closure-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(join(root, "sessions"));
  store.create({
    sessionId: "child", agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
    agentSessionId: null, status: "idle", title: "Child", config: {},
    tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  });
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  const message = { type: "merge_closure_watch" as const, requestId: "q", sessionId: "child", repository: "owner/app", pullRequest: 5, headSha: HEAD };
  const fake = github({ state: "MERGED", body: "Fixes #3" });
  const read = await manager.mergeClosureWatch({ ...message, operation: "read" }, { gh: fake.gh, glab: noGlab });
  assert.equal(read.type, "merge_closure_watch_result");
  assert.equal(read.operation, "read");
  assert.equal(read.ok, true);
  assert.equal(read.state, "merged");
  assert.deepEqual(read.check?.closures.map((closure) => closure.issue), ["owner/app#3"]);
  const queued = github({});
  const dequeued = await manager.mergeClosureWatch({ ...message, operation: "dequeue" }, { gh: queued.gh, glab: noGlab });
  assert.deepEqual({ ok: dequeued.ok, outcome: dequeued.outcome }, { ok: true, outcome: "dequeued" });
  const unknown = await manager.mergeClosureWatch({ ...message, sessionId: "elsewhere", operation: "dequeue" }, { gh: noGh, glab: noGlab });
  assert.deepEqual({ ok: unknown.ok, reason: unknown.reason }, { ok: false, reason: "The session is not known to this runner." });
});
