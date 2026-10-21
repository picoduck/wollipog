/**
 * Campaign forge status for GitLab on the runner (#3600): merge requests read through `glab`,
 * validated into GitLab-shaped status data, with every failure reduced to a fixed reason, and never
 * at the expense of the GitHub refs read beside them. `glab` and `gh` are stubbed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignPullRequestRef } from "@wollipog/protocol";
import { observeForgeStatus, type GhOutcome, type GhRunner } from "./campaign-forge-status.js";
import {
  classifyGlabFailure,
  gitlabMergeRequestObservation,
  observeGitLabMergeRequests,
  type GlabRunner,
} from "./campaign-gitlab-status.js";

const HEAD = "5c1e0b7a90f2c3d4e5f60718293a4b5c6d7e8f90";
const MERGE = "a1b2c3d4e5f60718293a4b5c6d7e8f9001234567";
const SQUASH = "feedfacecafebeef0000000000000000deadbeef";
const PROJECT = "gitlab.example.com/platform/agents/wollipog";
const ENCODED = encodeURIComponent("platform/agents/wollipog");
const REF: CampaignPullRequestRef = { repository: PROJECT, number: 7 };

function detail(overrides: Record<string, unknown> = {}) {
  return {
    iid: 7, state: "opened", draft: false, sha: HEAD, target_branch: "main",
    merge_commit_sha: null, squash_commit_sha: null,
    head_pipeline: { id: 901, status: "running", sha: HEAD },
    web_url: `https://${PROJECT}/-/merge_requests/7`,
    ...overrides,
  };
}
const approvals = (overrides: Record<string, unknown> = {}) =>
  ({ approved: false, approvals_required: 2, approvals_left: 1, approved_by: [{ user: { id: 1 } }], ...overrides });

type Route = Partial<GhOutcome> | ((args: string[]) => Partial<GhOutcome>);

/** A `glab` stub routed by API path, recording each call. Unknown paths answer 404. */
function glabStub(routes: Record<string, Route>, configured = "https\n"): GlabRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const base = { stdout: "", stderr: "", code: null, timedOut: false };
    if (args[0] === "config") return { ...base, stdout: configured };
    const route = routes[args[1]!];
    if (!route) return { ...base, code: 1, stderr: "glab: 404 Not Found (HTTP 404)" };
    return { ...base, ...(typeof route === "function" ? route(args) : route) };
  }) as GlabRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}
const ok = (value: unknown): Partial<GhOutcome> => ({ stdout: JSON.stringify(value) });
const mrPath = (iid = 7) => `projects/${ENCODED}/merge_requests/${iid}`;
const carPath = (iid = 7) => `projects/${ENCODED}/merge_trains/merge_requests/${iid}`;
const trainPath = `projects/${ENCODED}/merge_trains/main?scope=active&sort=asc&per_page=100`;

test("an open merge request on a train reads its approvals, running pipeline, and train position", async () => {
  const glab = glabStub({
    [mrPath()]: ok(detail()),
    [`${mrPath()}/approvals`]: ok(approvals()),
    [carPath()]: ok({ id: 3, status: "fresh", merge_request: { iid: 7 } }),
    [trainPath]: ok([{ merge_request: { iid: 5 } }, { merge_request: { iid: 7 } }]),
  });
  const [read] = await observeGitLabMergeRequests([REF], glab);
  assert.deepEqual(read, {
    ok: true,
    observation: {
      forge: "gitlab", state: "open", draft: false, headSha: HEAD, baseRef: "main",
      approvals: { approved: false, approvedBy: 1, left: 1 },
      pipeline: { id: 901, status: "running" },
      mergeTrain: { status: "fresh", position: 2 },
      mergeCommitSha: null,
    },
  });
  assert.deepEqual(glab.calls[0], ["config", "get", "api_protocol", "--host", "gitlab.example.com", "--global"],
    "a self-managed host is checked locally before any network call");
  for (const call of glab.calls.slice(1)) {
    assert.deepEqual(call.slice(-2), ["--hostname", "gitlab.example.com"], "every API call names the host; never a bare path");
  }
});

test("a merged merge request reports its merge or squash commit and is not asked about the train", async () => {
  const merged = glabStub({
    [mrPath()]: ok(detail({ state: "merged", merge_commit_sha: MERGE, head_pipeline: { id: 902, status: "success" } })),
    [`${mrPath()}/approvals`]: ok(approvals({ approved: true, approvals_left: 0 })),
  });
  const [read] = await observeGitLabMergeRequests([REF], merged);
  assert.ok(read?.ok);
  assert.equal(read.observation.state, "merged");
  assert.equal(read.observation.mergeCommitSha, MERGE);
  assert.equal(read.observation.mergeTrain, null);
  assert.equal(merged.calls.some((call) => call[1]?.includes("merge_trains")), false);

  const squashed = glabStub({
    [mrPath()]: ok(detail({ state: "merged", squash_commit_sha: SQUASH })),
    [`${mrPath()}/approvals`]: ok(approvals()),
  });
  const [squash] = await observeGitLabMergeRequests([REF], squashed);
  assert.equal(squash?.ok && squash.observation.mergeCommitSha, SQUASH, "a squash merge without a merge commit names its squash commit");
});

test("an open merge request not on a train, or on a tier without trains, reads no train", async () => {
  for (const notOnTrain of [
    { code: 1, stderr: "glab: 404 Not Found (HTTP 404)" },
    { code: 1, stderr: "glab: 403 Forbidden (HTTP 403)" },
  ]) {
    const glab = glabStub({
      [mrPath()]: ok(detail({ head_pipeline: null })),
      [`${mrPath()}/approvals`]: ok(approvals({ approved: true, approvals_left: 0, approved_by: [] })),
      [carPath()]: notOnTrain,
    });
    const [read] = await observeGitLabMergeRequests([REF], glab);
    assert.ok(read?.ok, JSON.stringify(read));
    assert.equal(read.observation.mergeTrain, null);
    assert.equal(read.observation.pipeline, null);
    assert.deepEqual(read.observation.approvals, { approved: true, approvedBy: 0, left: 0 });
  }
});

test("pipeline statuses collapse without ever inventing a pass", () => {
  const status = (value: string) =>
    gitlabMergeRequestObservation(detail({ head_pipeline: { id: 1, status: value } }), approvals(), 7)?.pipeline?.status;
  assert.equal(status("success"), "success");
  for (const pending of ["created", "waiting_for_resource", "preparing", "pending", "scheduled"]) assert.equal(status(pending), "pending");
  for (const kept of ["failed", "running", "canceled", "skipped", "manual"]) assert.equal(status(kept), kept);
  assert.equal(status("something_new"), "unknown");
  // A locked merge request is mid-merge, still open; a work_in_progress flag stands in for draft.
  const locked = gitlabMergeRequestObservation({ ...detail({ state: "locked", draft: undefined }), work_in_progress: true }, approvals(), 7);
  assert.deepEqual([locked?.state, locked?.draft], ["open", true]);
  for (const malformed of [
    detail({ iid: 8 }),
    detail({ state: "reopened" }),
    detail({ sha: "not-a-sha" }),
    detail({ target_branch: "" }),
    detail({ merge_commit_sha: "zz" }),
    detail({ head_pipeline: { id: 0, status: "success" } }),
    detail({ draft: "no" }),
  ]) {
    assert.equal(gitlabMergeRequestObservation(malformed, approvals(), 7), null, JSON.stringify(malformed));
  }
  assert.equal(gitlabMergeRequestObservation(detail(), { approved: "yes", approved_by: [] }, 7), null);
  assert.equal(gitlabMergeRequestObservation(detail(), approvals({ approvals_left: -1 }), 7), null);
});

test("glab failures reduce to fixed reasons, and a host-wide failure is not retried within one read", async () => {
  assert.equal(classifyGlabFailure({ stdout: "", stderr: "", code: "ENOENT", timedOut: false }), "forge_cli_missing");
  assert.equal(classifyGlabFailure({ stdout: "", stderr: "execvpe(glab) failed: No such file", code: 1, timedOut: false }), "forge_cli_missing");
  assert.equal(classifyGlabFailure({ stdout: "", stderr: "", code: 1, timedOut: true }), "forge_unreachable");
  assert.equal(classifyGlabFailure({ stdout: "", stderr: "glab: 401 Unauthorized (HTTP 401)", code: 1, timedOut: false }), "forge_unauthenticated");
  assert.equal(classifyGlabFailure({ stdout: "", stderr: "glab: 429 Too Many Requests (HTTP 429)", code: 1, timedOut: false }), "forge_rate_limited");
  assert.equal(classifyGlabFailure({ stdout: '{"message":"404 Not found"}', stderr: "glab: 404 Not Found (HTTP 404)", code: 1, timedOut: false }), "forge_not_found");
  assert.equal(classifyGlabFailure({ stdout: "", stderr: "dial tcp: lookup gitlab.example.com: no such host", code: 1, timedOut: false }), "forge_unreachable");
  assert.equal(classifyGlabFailure({ stdout: "", stderr: "something else", code: 1, timedOut: false }), "forge_error");

  const unauthenticated = glabStub({
    [mrPath(7)]: { code: 1, stderr: "glab: 401 Unauthorized (HTTP 401)" },
    [mrPath(8)]: ok(detail({ iid: 8 })),
  });
  const reads = await observeGitLabMergeRequests([REF, { ...REF, number: 8 }, { ...REF, number: 9 }], unauthenticated);
  assert.deepEqual(reads.map((read) => read.ok ? "ok" : read.failure).filter((value) => value !== "ok"), reads.map(() => "forge_unauthenticated"),
    "a login the host refused fails that host's other merge requests without asking again");
  assert.equal(unauthenticated.calls.filter((call) => call[0] === "api").length, 1, "one call learned the host refused the login");
  // A merge request the login cannot see fails alone.
  const missing = glabStub({ [mrPath(7)]: ok(detail()), [`${mrPath(7)}/approvals`]: ok(approvals()) });
  const [found, notFound] = await observeGitLabMergeRequests([REF, { ...REF, number: 8 }], missing);
  assert.equal(found?.ok, true);
  assert.deepEqual(notFound, { ok: false, failure: "forge_not_found" });
});

test("a host glab is not configured for, and a ref that is not a GitLab project, are never read", async () => {
  const unconfigured = glabStub({}, "");
  const reads = await observeGitLabMergeRequests([REF, { repository: "group/sub/project", number: 1 }], unconfigured);
  assert.deepEqual(reads, [{ ok: false, failure: "forge_unsupported" }, { ok: false, failure: "forge_unsupported" }]);
  assert.deepEqual(unconfigured.calls.map((call) => call[0]), ["config"], "only the local configuration check ran");
  const gitlabCom = glabStub({});
  await observeGitLabMergeRequests([{ repository: "gitlab.com/group/project", number: 3 }], gitlabCom);
  assert.equal(gitlabCom.calls.some((call) => call[0] === "config"), false, "gitlab.com needs no configuration check");
  assert.deepEqual(gitlabCom.calls[0], ["api", `projects/${encodeURIComponent("group/project")}/merge_requests/3`, "--hostname", "gitlab.com"]);
});

const GITHUB_REF: CampaignPullRequestRef = { repository: "picoduck/wollipog", number: 2462 };
function ghFailing(): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    return { stdout: "", stderr: "HTTP 401: Bad credentials", code: 1, timedOut: false };
  }) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

test("GitLab refs are read only when the control plane asks, and neither forge's failure spills onto the other", async () => {
  const glab = glabStub({ [mrPath()]: ok(detail()), [`${mrPath()}/approvals`]: ok(approvals()) });
  const gh = ghFailing();
  // Without the control plane's request, an older control plane is never sent a GitLab observation.
  const legacy = await observeForgeStatus([GITHUB_REF, REF], gh);
  assert.deepEqual(legacy, { ok: false, failure: "forge_unauthenticated" }, "GitHub-only behavior is unchanged");
  assert.equal(glab.calls.length, 0);

  const mixed = await observeForgeStatus([GITHUB_REF, REF], gh, { glab });
  assert.ok(mixed.ok);
  assert.deepEqual(mixed.results[0], { ref: GITHUB_REF, ok: false, failure: "forge_unauthenticated" },
    "a GitHub login failure fails only the GitHub ref");
  assert.equal(mixed.results[1]?.ok && mixed.results[1].observation.forge, "gitlab");

  const gitlabDown = glabStub({ [mrPath()]: { code: 1, stderr: "dial tcp: i/o timeout" } });
  const gitlabOnlyFails = await observeForgeStatus([REF, { repository: "picoduck/wollipog", number: 1 }], ghFailing(), { glab: gitlabDown });
  assert.ok(gitlabOnlyFails.ok);
  assert.deepEqual(gitlabOnlyFails.results[0], { ref: REF, ok: false, failure: "forge_unreachable" });
  assert.equal(gitlabOnlyFails.results[1]?.ok === false && gitlabOnlyFails.results[1].failure, "forge_unauthenticated");
});
