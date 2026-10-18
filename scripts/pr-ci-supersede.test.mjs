import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { currentReadyHead, MAX_PAGES, supersede, supersededRuns, targetFromEvent } from "./pr-ci-supersede.mjs";

const repository = "example/project";
const head = "a".repeat(40);
const older = "b".repeat(40);
const branch = "fix/issue-3283";
const target = { repository, id: 200, workflowId: 7, headRepository: repository, branch, sha: head };
const workflowRun = (changes = {}) => ({
  id: 200, workflow_id: 7, run_attempt: 1, status: "in_progress", event: "pull_request",
  path: ".github/workflows/ci.yml", repository: { full_name: repository },
  head_repository: { full_name: repository }, head_branch: branch, head_sha: head, ...changes,
});
const event = (changes = {}) => ({ action: "requested", workflow_run: workflowRun({ status: "queued", ...changes }) });
const pull = (changes = {}) => ({
  draft: false, head: { sha: head, ref: branch, repo: { full_name: repository } }, ...changes,
});

function fakeApi({ pulls = [pull()], runs = [], pullsAfter, failCancel = new Set(), failPath } = {}) {
  const calls = [];
  let pullReads = 0;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (failPath && path.includes(failPath)) {
      const error = new Error("GitHub API request failed");
      error.status = 503;
      throw error;
    }
    if (path.includes("/pulls?")) return ++pullReads === 1 || !pullsAfter ? pulls : pullsAfter;
    if (path.includes("/actions/workflows/")) return { total_count: runs.length, workflow_runs: runs };
    if (path.endsWith("/cancel")) {
      const id = Number(path.split("/").at(-2));
      if (failCancel.has(id)) {
        const error = new Error("GitHub API request failed");
        error.status = 409;
        throw error;
      }
      return null;
    }
    throw new Error("unexpected " + path);
  };
  return { api, calls, cancels: () => calls.filter((call) => call.path.endsWith("/cancel")).map((call) => call.path) };
}

test("only requested CI or an in-progress rerun of same-repository pull-request CI is eligible", () => {
  assert.deepEqual(targetFromEvent(event(), repository), target);
  assert.deepEqual(targetFromEvent({ action: "in_progress", workflow_run: workflowRun({ run_attempt: 2 }) }, repository), target);
  assert.throws(() => targetFromEvent({ ...event(), action: "in_progress" }, repository),
    "initial in_progress must not duplicate requested cleanup");
  assert.deepEqual(targetFromEvent(event({ head_repository: { full_name: "fork/project" } }), repository),
    { ...target, headRepository: "fork/project" }, "a fork's pull request is still this repository's CI run");
  for (const changes of [
    { event: "merge_group" }, { event: "push" }, { event: "workflow_dispatch" },
    { path: ".github/workflows/platform-isolation.yml" },
    { repository: { full_name: "other/repo" } }, { head_repository: { full_name: "bad name" } },
    { head_branch: "-option" }, { head_branch: "a..b" }, { head_branch: "has space" }, { head_branch: "x\ny" },
    { head_sha: "bad" }, { id: 0 }, { workflow_id: 0 },
    { run_attempt: 0 }, { run_attempt: undefined }, { run_attempt: 1.5 }, { run_attempt: "2" },
  ]) assert.throws(() => targetFromEvent(event(changes), repository), JSON.stringify(changes));
  assert.throws(() => targetFromEvent({ ...event(), action: "completed" }, repository));
  assert.throws(() => targetFromEvent(event(), "not a repository"));
});

test("the target must be the current ready head of every open pull request from its branch", () => {
  assert.deepEqual(currentReadyHead([pull()], target), { current: true, reason: "current-ready-head" });
  assert.equal(currentReadyHead([], target).reason, "no-open-pull-request");
  assert.equal(currentReadyHead(null, target).reason, "no-open-pull-request");
  assert.equal(currentReadyHead([pull({ head: { ...pull().head, sha: older } })], target).reason, "head-moved");
  assert.equal(currentReadyHead([pull(), pull({ head: { ...pull().head, sha: older } })], target).reason, "head-moved",
    "a second pull request from the branch on another head is not proof");
  assert.equal(currentReadyHead([pull({ draft: true })], target).reason, "draft");
  assert.equal(currentReadyHead([pull({ draft: undefined })], target).reason, "draft");
  assert.equal(currentReadyHead([pull({ head: { ...pull().head, ref: "other" } })], target).reason,
    "pull-request-evidence-ambiguous");
  assert.equal(currentReadyHead([pull({ head: { ...pull().head, repo: { full_name: "fork/project" } } })], target).reason,
    "pull-request-evidence-ambiguous");
});

test("only active CI runs of the same branch on another head are superseded", () => {
  const keep = [
    workflowRun({ id: 200 }),
    workflowRun({ id: 201 }), // same head: a duplicate GitHub started for this head (#3283)
    workflowRun({ id: 202, head_sha: older, status: "completed" }),
    workflowRun({ id: 203, head_sha: older, event: "merge_group" }),
    workflowRun({ id: 204, head_sha: older, path: ".github/workflows/release.yml" }),
    workflowRun({ id: 205, head_sha: older, head_repository: { full_name: "fork/project" } }),
    workflowRun({ id: 206, head_sha: older, head_branch: "other" }),
    workflowRun({ id: 207, head_sha: older, repository: { full_name: "other/repo" } }),
    workflowRun({ id: 208, head_sha: "not-a-sha" }),
  ];
  const cancel = ["queued", "in_progress", "waiting", "pending", "requested"]
    .map((status, index) => workflowRun({ id: 300 + index, head_sha: older, status }));
  assert.deepEqual(supersededRuns([...keep, ...cancel], target).map((run) => run.id), cancel.map((run) => run.id));
});

test("a current ready head cancels older-head runs and never a same-head run", async () => {
  const runs = [workflowRun({ id: 199 }), workflowRun({ id: 150, head_sha: older }), workflowRun({ id: 151, head_sha: older, status: "queued" })];
  const fake = fakeApi({ runs });
  const logs = [];
  assert.deepEqual(await supersede(target, { api: fake.api, log: (line) => logs.push(JSON.parse(line)) }), [150, 151]);
  assert.deepEqual(fake.cancels(), [
    "/repos/example/project/actions/runs/150/cancel", "/repos/example/project/actions/runs/151/cancel",
  ]);
  assert.ok(fake.calls.some((call) => call.path === "/repos/example/project/pulls?state=open&per_page=100&head=example%3Afix%2Fissue-3283"));
  assert.ok(fake.calls.some((call) => call.path.startsWith("/repos/example/project/actions/workflows/7/runs?event=pull_request&branch=fix%2Fissue-3283")));
  assert.ok(logs.every((log) => log.entryPoint === "workflow_run" && log.runId === 200));
});

test("a fork's head is looked up under the fork owner", async () => {
  const fork = { ...target, headRepository: "contributor/project" };
  const fake = fakeApi({ pulls: [pull({ head: { ...pull().head, repo: { full_name: "contributor/project" } } })] });
  await supersede(fork, { api: fake.api, log: () => {} });
  assert.ok(fake.calls[0].path.endsWith("head=contributor%3Afix%2Fissue-3283"));
});

test("nothing is cancelled unless the head is still current immediately before cancelling", async () => {
  for (const pullsAfter of [[pull({ head: { ...pull().head, sha: "c".repeat(40) } })], [pull({ draft: true })], []]) {
    const fake = fakeApi({ runs: [workflowRun({ id: 150, head_sha: older })], pullsAfter });
    assert.deepEqual(await supersede(target, { api: fake.api, log: () => {} }), []);
    assert.deepEqual(fake.cancels(), []);
  }
  for (const pulls of [[pull({ draft: true })], [pull({ head: { ...pull().head, sha: older } })], []]) {
    const fake = fakeApi({ pulls, runs: [workflowRun({ id: 150, head_sha: older })] });
    assert.deepEqual(await supersede(target, { api: fake.api, log: () => {} }), []);
    assert.deepEqual(fake.cancels(), [], "a draft, moved or closed head supersedes nothing");
  }
});

test("the head is re-read before every cancel, so a push back to a candidate retains its run (#3285 review)", async () => {
  const c = "c".repeat(40);
  const runs = [workflowRun({ id: 150, head_sha: older }), workflowRun({ id: 151, head_sha: c })];
  let current = head;
  const cancels = [];
  const api = async (path) => {
    if (path.includes("/pulls?")) return [pull({ head: { ...pull().head, sha: current } })];
    if (path.includes("/actions/workflows/")) return { total_count: runs.length, workflow_runs: runs };
    if (path.endsWith("/cancel")) {
      cancels.push(path);
      current = c; // the contributor force-pushes back to C while the first cancel is in flight
      return null;
    }
    throw new Error("unexpected " + path);
  };
  const logs = [];
  assert.deepEqual(await supersede(target, { api, log: (line) => logs.push(JSON.parse(line)) }), [150]);
  assert.deepEqual(cancels, ["/repos/example/project/actions/runs/150/cancel"]);
  assert.ok(logs.some((log) => log.event === "pr_ci_supersede_skipped" && log.reason === "head-moved" && log.remaining === 1));

  let reads = 0;
  current = head;
  cancels.length = 0;
  const flaky = async (path) => {
    if (path.endsWith("/cancel")) {
      cancels.push(path);
      return null;
    }
    if (path.includes("/pulls?") && ++reads > 2) {
      const error = new Error("GitHub API request failed");
      error.status = 502;
      throw error;
    }
    return api(path);
  };
  const unreadable = [];
  assert.deepEqual(await supersede(target, { api: flaky, log: (line) => unreadable.push(JSON.parse(line)) }), [150],
    "the result names what was cancelled before the read failed");
  assert.deepEqual(cancels, ["/repos/example/project/actions/runs/150/cancel"], "a failed re-read stops before the next cancel");
  assert.equal(unreadable.at(-1).event, "pr_ci_supersede_evidence_unavailable");
});

test("unavailable evidence retains CI, and one refused cancel does not stop the rest", async () => {
  for (const failPath of ["/pulls?", "/actions/workflows/"]) {
    const fake = fakeApi({ runs: [workflowRun({ id: 150, head_sha: older })], failPath });
    const logs = [];
    assert.deepEqual(await supersede(target, { api: fake.api, log: (line) => logs.push(JSON.parse(line)) }), []);
    assert.deepEqual(fake.cancels(), []);
    assert.equal(logs.at(-1).event, "pr_ci_supersede_evidence_unavailable");
    assert.equal(logs.at(-1).status, 503);
  }
  const unreadable = fakeApi();
  const api = async (path, body) => path.includes("/actions/workflows/") ? { workflow_runs: "nope" } : unreadable.api(path, body);
  assert.deepEqual(await supersede(target, { api, log: () => {} }), []);
  const partial = fakeApi({
    runs: [workflowRun({ id: 150, head_sha: older }), workflowRun({ id: 151, head_sha: older })],
    failCancel: new Set([150]),
  });
  const logs = [];
  assert.deepEqual(await supersede(target, { api: partial.api, log: (line) => logs.push(JSON.parse(line)) }), [151]);
  assert.ok(logs.some((log) => log.event === "pr_ci_supersede_cancel_failed" && log.cancelledRunId === 150 && log.status === 409));
});

test("run listings are paged to a bound", async () => {
  let pages = 0;
  const api = async (path) => {
    if (path.includes("/pulls?")) return [pull()];
    if (path.endsWith("/cancel")) return null;
    pages += 1;
    return { total_count: 10_000, workflow_runs: [workflowRun({ id: 1000 + pages, head_sha: older })] };
  };
  assert.equal((await supersede(target, { api, log: () => {} })).length, MAX_PAGES);
  assert.equal(pages, MAX_PAGES);
});

// Evaluate the actual job admission before calling the actual selector against an inert API.
// This models event delivery and live PR changes, not GitHub's scheduler or runner availability.
const supersedeWorkflow = readFileSync(".github/workflows/pr-ci-supersede.yml", "utf8");
const activities = supersedeWorkflow.match(/types: \[([^\]]+)\]/)[1].split(", ");
const jobCondition = supersedeWorkflow.match(/^    if: (.+)$/m)[1];
async function deliver(wakeup, fake) {
  const admitted = activities.includes(wakeup.action) && vm.runInNewContext(jobCondition, {
    github: { repository, event: wakeup },
  }, { timeout: 1_000 });
  if (!admitted) return [];
  return supersede(targetFromEvent(wakeup, repository), { api: fake.api, log: () => {} });
}

test("requested cleanup acts while all CI jobs are queued and duplicate same-head wakeups retain each other", async () => {
  const runs = [workflowRun({ id: 150, head_sha: older, status: "queued" }),
    workflowRun({ id: 200, status: "queued" }), workflowRun({ id: 201, status: "queued" })];
  for (const id of [200, 201]) {
    const fake = fakeApi({ runs });
    assert.deepEqual(await deliver(event({ id }), fake), [150]);
    assert.equal(fake.cancels().length, 1, "neither current-head duplicate is cancelled");
  }
});

test("draft requests supersede nothing, but a ready-for-review request on the same head does", async () => {
  const runs = [workflowRun({ id: 150, head_sha: older })];
  const draft = fakeApi({ pulls: [pull({ draft: true })], runs });
  assert.deepEqual(await deliver(event(), draft), []);
  assert.deepEqual(draft.cancels(), []);
  // CI admits ready_for_review even when its own payload still says draft; cleanup must instead
  // use the PR API's live draft state. The triggering PR payload is not trusted evidence here.
  const ready = fakeApi({ pulls: [pull({ draft: false })], runs });
  assert.deepEqual(await deliver(event(), ready), [150]);
  const delayedDraft = fakeApi({ pulls: [pull({ draft: false })], runs });
  assert.deepEqual(await deliver(event(), delayedDraft), [150], "a delayed event uses live readiness");
});

test("reordered requests use the live head, and a later draft change stops a pending cancel", async () => {
  const newest = "c".repeat(40);
  const live = [pull({ head: { ...pull().head, sha: newest } })];
  const runs = [workflowRun({ id: 150, head_sha: older }), workflowRun({ id: 200 }),
    workflowRun({ id: 300, head_sha: newest }), workflowRun({ id: 301, head_sha: newest })];
  assert.deepEqual(await deliver(event({ id: 300, head_sha: newest }), fakeApi({ pulls: live, runs })), [150, 200]);
  const stale = fakeApi({ pulls: live, runs });
  assert.deepEqual(await deliver(event(), stale), []);
  assert.deepEqual(stale.cancels(), [], "the delayed older request cannot cancel the newer head");
  const becameDraft = fakeApi({ runs, pullsAfter: [pull({ draft: true })] });
  assert.deepEqual(await deliver(event(), becameDraft), []);
  assert.deepEqual(becameDraft.cancels(), [], "readiness is checked again before mutation");
});

test("A to B to A retains all current A runs when a B request is delivered late", async () => {
  const runs = [workflowRun({ id: 100 }), workflowRun({ id: 150, head_sha: older }), workflowRun()];
  const delayedB = fakeApi({ runs });
  assert.deepEqual(await deliver(event({ id: 150, head_sha: older }), delayedB), []);
  assert.deepEqual(delayedB.cancels(), []);
  assert.deepEqual(await deliver(event(), fakeApi({ runs })), [150], "only B is obsolete after returning to A");
  const pushedBackBeforeCancel = fakeApi({
    pulls: [pull({ head: { ...pull().head, sha: older } })], runs, pullsAfter: [pull()],
  });
  assert.deepEqual(await deliver(event({ id: 150, head_sha: older }), pushedBackBeforeCancel), []);
  assert.deepEqual(pushedBackBeforeCancel.cancels(), [], "the per-candidate live-head recheck protects A");
});

test("initial in_progress jobs are skipped before requesting a runner; reruns retain cleanup", async () => {
  const runs = [workflowRun({ id: 150, head_sha: older }), workflowRun({ id: 201, run_attempt: 2 })];
  const skipped = fakeApi({ runs });
  assert.deepEqual(await deliver({ ...event(), action: "in_progress" }, skipped), []);
  assert.deepEqual(skipped.calls, [], "job-level false must prevent any runner or API work");
  for (const run_attempt of [2, 3]) {
    assert.deepEqual(await deliver({ action: "in_progress", workflow_run: workflowRun({ run_attempt }) }, fakeApi({ runs })), [150]);
    const stale = fakeApi({ runs });
    assert.deepEqual(await deliver({ action: "in_progress", workflow_run: workflowRun({ run_attempt, head_sha: older }) }, stale), []);
    assert.deepEqual(stale.cancels(), [], "rerunning an obsolete head cannot supersede current CI");
  }
  const completed = fakeApi({ runs });
  assert.deepEqual(await deliver({ ...event(), action: "completed" }, completed), []);
  assert.deepEqual(completed.calls, []);
});

test("privileged superseding checks out only trusted workflow_run code and stays outside required CI", () => {
  const text = readFileSync(".github/workflows/pr-ci-supersede.yml", "utf8");
  assert.match(text, /workflows: \[CI\]\s+types: \[requested, in_progress\]/);
  assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.match(text, /persist-credentials: false/);
  assert.doesNotMatch(text, /workflow_run\.(head_sha|head_branch)|download-artifact|pull_request_target|github\.head_ref/);
  assert.match(text, /group: pr-ci-supersede-\$\{\{ github.event.workflow_run.id \}\}-\$\{\{ github.event.workflow_run.run_attempt \}\}/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /contents: read\s+pull-requests: read\s+actions: write/);
  assert.match(text, /workflow_run.event == 'pull_request' && github.event.workflow_run.repository.full_name == github.repository/);
  assert.match(text, /node scripts\/pr-ci-supersede.mjs/);
  assert.match(text, /timeout-minutes: 5/);
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /^  cancel-in-progress: \$\{\{ github.event_name != 'pull_request' \}\}$/m,
    "pull-request runs rely on this workflow, not concurrency, to stop older heads");
});
