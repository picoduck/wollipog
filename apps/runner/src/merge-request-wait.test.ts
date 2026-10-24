/**
 * Merge request wait (#3602): one GitLab merge request watched through `glab` until its pipeline
 * or merge-train car reaches an outcome. `glab` and the clock are faked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome } from "./campaign-forge-status.js";
import type { GlabRunner } from "./campaign-gitlab-status.js";
import { waitForMergeRequest, type MergeRequestWaitDeps } from "./merge-request-wait.js";
import { parsePullRequestRef } from "./pull-request-wait.js";

const HOST = "gitlab.example.com";
const REPOSITORY = `${HOST}/platform/agents/wollipog`;
const ENCODED = encodeURIComponent("platform/agents/wollipog");
const HEAD = "5c1e0b7a90f2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER = "a".repeat(40);
const MERGE = "b".repeat(40);
const MR = `projects/${ENCODED}/merge_requests/7`;
const PROJECT = `projects/${ENCODED}`;
const CAR = `projects/${ENCODED}/merge_trains/merge_requests/7`;

const ok = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });
const failed = (stderr: string): GhOutcome => ({ stdout: "", stderr, code: 1, timedOut: false });
const NOT_FOUND = failed("glab: 404 Not Found (HTTP 404)");

function mr(overrides: Record<string, unknown> = {}) {
  return {
    iid: 7, state: "opened", draft: false, sha: HEAD, target_branch: "main", merge_commit_sha: null, squash_commit_sha: null,
    web_url: `https://${REPOSITORY}/-/merge_requests/7`, detailed_merge_status: "ci_still_running",
    head_pipeline: { id: 901, status: "running", web_url: `https://${REPOSITORY}/-/pipelines/901` },
    ...overrides,
  };
}

/** Each path answers from its own script, holding the last answer once the script runs out. */
function fakeGlab(scripts: Record<string, GhOutcome[]>): { glab: GlabRunner; calls: string[][] } {
  const calls: string[][] = [];
  const positions = new Map<string, number>();
  const glab: GlabRunner = async (args) => {
    calls.push(args);
    const script = scripts[args[1]!];
    if (!script) throw new Error(`unexpected glab ${args.join(" ")}`);
    const index = positions.get(args[1]!) ?? 0;
    positions.set(args[1]!, index + 1);
    return script[Math.min(index, script.length - 1)]!;
  };
  return { glab, calls };
}

function clock(): Required<Pick<MergeRequestWaitDeps, "now" | "sleep">> & { sleeps: number[] } {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return { sleeps, now: () => time, sleep: async (milliseconds) => { sleeps.push(milliseconds); time += milliseconds; } };
}

const wait = (glab: GlabRunner, input: Partial<Parameters<typeof waitForMergeRequest>[0]> = {}) =>
  waitForMergeRequest({ repository: REPOSITORY, number: 7, timeoutMs: 600_000, ...input }, { glab, ...clock() });

test("a running pipeline is waited on, then a successful one returns checks_passed with a bounded summary", async () => {
  const fake = fakeGlab({
    [MR]: [ok(mr()), ok(mr({ detailed_merge_status: "mergeable", head_pipeline: { id: 901, status: "success" } }))],
    [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: true })],
    [CAR]: [NOT_FOUND],
  });
  const result = await wait(fake.glab, { headSha: HEAD });
  assert.ok(result.ok);
  assert.deepEqual(result.summary, {
    forge: "gitlab", outcome: "checks_passed", repository: REPOSITORY, number: 7,
    url: `https://${REPOSITORY}/-/merge_requests/7`, state: "open", merged: false, mergeCommitSha: null, isDraft: false,
    headSha: HEAD, baseRef: "main", pipelineRequired: true, detailedMergeStatus: "mergeable",
    pipeline: { id: 901, status: "success" }, mergeTrain: null, waitedMs: 30_000, polls: 2,
  });
  assert.equal(fake.calls.filter((call) => call[1] === PROJECT).length, 1, "project settings are read once");
  for (const call of fake.calls) {
    assert.deepEqual([call[0], ...call.slice(-2)], ["api", "--hostname", HOST], "every read names the host; never a bare path");
  }
});

test("pipelines that will not pass return at once, and only a success passes", async () => {
  const outcome = async (status: string | null, required = true) => {
    const fake = fakeGlab({
      [MR]: [ok(mr({ head_pipeline: status === null ? null : { id: 3, status } }))],
      [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: required })],
      [CAR]: [NOT_FOUND],
    });
    const result = await wait(fake.glab, { timeoutMs: 60_000 });
    assert.ok(result.ok);
    return result.summary.outcome;
  };
  assert.equal(await outcome("failed"), "checks_failed");
  assert.equal(await outcome("canceled"), "checks_failed");
  assert.equal(await outcome("skipped"), "checks_blocked", "a skipped pipeline never passes");
  assert.equal(await outcome("manual"), "checks_blocked", "a pipeline waiting for a manual action never passes");
  assert.equal(await outcome("something_new"), "timeout", "an unknown status keeps waiting, never passes");
  assert.equal(await outcome(null, false), "no_required_checks", "no pipeline where none is required returns at once");
  assert.equal(await outcome(null, true), "timeout", "no pipeline where one is required is still waiting");
});

test("a merge request on a train waits for the train, reports its failure, and confirms a drop before saying so", async () => {
  const onTrain = (pipelineStatus: string) => ok({ id: 1, status: "fresh", pipeline: { id: 950, status: pipelineStatus } });
  const failedTrain = fakeGlab({
    [MR]: [ok(mr())], [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: true })],
    [CAR]: [onTrain("running"), onTrain("failed")],
  });
  const failure = await wait(failedTrain.glab);
  assert.ok(failure.ok);
  assert.equal(failure.summary.outcome, "queue_failed");
  assert.deepEqual(failure.summary.mergeTrain, { status: "fresh", pipeline: { id: 950, status: "failed" } });

  for (const blocked of ["manual", "skipped"]) {
    const stuck = fakeGlab({
      [MR]: [ok(mr())], [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: true })], [CAR]: [onTrain(blocked)],
    });
    const result = await wait(stuck.glab);
    assert.ok(result.ok);
    assert.equal(result.summary.outcome, "checks_blocked", `a ${blocked} train pipeline will not finish on its own`);
  }

  const dropped = fakeGlab({
    [MR]: [ok(mr())], [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: true })],
    [CAR]: [onTrain("running"), NOT_FOUND],
  });
  const time = clock();
  const ejected = await waitForMergeRequest({ repository: REPOSITORY, number: 7, timeoutMs: 600_000 }, { glab: dropped.glab, ...time });
  assert.ok(ejected.ok);
  assert.equal(ejected.summary.outcome, "queue_ejected");
  assert.ok(time.sleeps.includes(10_000), "a vanished car is confirmed for the whole interval first");

  const merged = fakeGlab({
    [MR]: [ok(mr()), ok(mr()), ok(mr({ state: "merged", merge_commit_sha: MERGE, head_pipeline: { id: 950, status: "success" } }))],
    [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: true })],
    [CAR]: [onTrain("running"), NOT_FOUND],
  });
  const landed = await wait(merged.glab);
  assert.ok(landed.ok);
  assert.equal(landed.summary.outcome, "merged", "a car that leaves because the merge request merged is not a drop");
  assert.equal(landed.summary.mergeCommitSha, MERGE);
});

test("merged, closed, and a moved head end the wait; a squash merge names its squash commit", async () => {
  const end = async (detail: Record<string, unknown>, headSha?: string) => {
    const fake = fakeGlab({ [MR]: [ok(mr(detail))], [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: true })], [CAR]: [NOT_FOUND] });
    const result = await wait(fake.glab, headSha ? { headSha } : {});
    assert.ok(result.ok);
    return { summary: result.summary, calls: fake.calls };
  };
  const squashed = await end({ state: "merged", squash_commit_sha: MERGE });
  assert.deepEqual([squashed.summary.outcome, squashed.summary.mergeCommitSha], ["merged", MERGE]);
  assert.equal(squashed.calls.length, 1, "a merged merge request is not asked about settings or the train");
  assert.equal((await end({ state: "closed" })).summary.outcome, "closed");
  assert.equal((await end({}, OTHER)).summary.outcome, "head_changed");
  assert.equal((await end({ state: "locked" })).summary.state, "open", "a locked merge request is mid-merge, still open");
});

test("transient failures are retried within the budget; a refused login and a bad answer are errors", async () => {
  const flaky = fakeGlab({
    [MR]: [failed("dial tcp: i/o timeout"), ok(mr({ head_pipeline: { id: 1, status: "success" } }))],
    [PROJECT]: [ok({ only_allow_merge_if_pipeline_succeeds: true })], [CAR]: [NOT_FOUND],
  });
  const recovered = await wait(flaky.glab);
  assert.ok(recovered.ok);
  assert.equal(recovered.summary.outcome, "checks_passed");

  const refused = await wait(fakeGlab({ [MR]: [failed("glab: 401 Unauthorized (HTTP 401)")] }).glab);
  assert.deepEqual(refused, { ok: false, error: `could not read ${REPOSITORY}!7: glab is not signed in to ${HOST}` });
  const missing = await wait(fakeGlab({ [MR]: [NOT_FOUND] }).glab);
  assert.match(missing.ok ? "" : missing.error, /does not exist or this glab login cannot see it/u);
  for (const bad of [mr({ iid: 8 }), mr({ sha: "nope" }), mr({ web_url: "https://elsewhere.test/x/-/merge_requests/7" }), mr({ state: "reopened" })]) {
    const result = await wait(fakeGlab({ [MR]: [ok(bad)] }).glab);
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(await waitForMergeRequest({ repository: "group/sub/project", number: 7 }, { glab: fakeGlab({}).glab }),
    { ok: false, error: "a host-qualified GitLab project and merge request IID are required" });
});

test("GitLab merge request references parse from URLs, the ! form, and a host-qualified repository", () => {
  assert.deepEqual(parsePullRequestRef(`https://${REPOSITORY}/-/merge_requests/7`, undefined), { repository: REPOSITORY, number: 7 });
  assert.deepEqual(parsePullRequestRef(`https://${REPOSITORY}/-/merge_requests/7/diffs?view=inline`, undefined),
    { repository: REPOSITORY, number: 7 });
  assert.deepEqual(parsePullRequestRef(`${REPOSITORY}!7`, undefined), { repository: REPOSITORY, number: 7 });
  assert.deepEqual(parsePullRequestRef("!7", REPOSITORY), { repository: REPOSITORY, number: 7 });
  assert.deepEqual(parsePullRequestRef(7, REPOSITORY), { repository: REPOSITORY, number: 7 });
  assert.match((parsePullRequestRef("group/sub/project!7", undefined) as { error: string }).error, /invalid repository/u,
    "a bare path names no host and is never guessed to be gitlab.com");
  assert.match((parsePullRequestRef(`https://${REPOSITORY}/-/merge_requests/7`, "other.example.com/a/b") as { error: string }).error,
    /not in repository/u);
});
