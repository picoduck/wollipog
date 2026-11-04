import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activeTargets, githubApi, MONITOR_MS, monitor, obsoleteEvidence, POLL_MS, REQUEST_MS, RUN_PAGE, targetFromEvent, targetFromRun,
} from "./merge-group-cleanup.mjs";

const repository = "example/project";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const thirdSha = "e".repeat(40);
const branch = "gh-readonly-queue/main/pr-42-" + "c".repeat(40);
const otherBranch = "gh-readonly-queue/main/pr-43-" + "d".repeat(40);
const target = { repository, id: 123, attempt: 1, branch, sha };
const run = (changes = {}) => ({
  id: target.id, run_attempt: 1, status: "in_progress", event: "merge_group",
  path: ".github/workflows/ci.yml", repository: { full_name: repository },
  head_repository: { full_name: repository }, head_branch: branch, head_sha: sha, ...changes,
});
// A second integration that stays in the queue throughout.
const liveRun = () => run({ id: 456, head_branch: otherBranch, head_sha: otherSha });
const listing = (...runs) => ({ total_count: runs.length, workflow_runs: runs });
const event = () => ({ action: "in_progress", workflow_run: run() });
const connection = (nodes) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false } });
const proof = () => ({ data: { repository: {
  nameWithOwner: repository,
  refs: connection([{ name: "pr-43-" + "d".repeat(40), target: { oid: otherSha } }]),
  mergeQueue: { entries: connection([{ state: "AWAITING_CHECKS", headCommit: { oid: otherSha } }]) },
} } });

test("only an exact same-repository main merge-group CI attempt is a target", () => {
  assert.deepEqual(targetFromRun(run(), repository), target);
  assert.deepEqual(targetFromEvent(event(), repository), target);
  assert.deepEqual(targetFromEvent({ ...event(), action: "completed" }, repository), target);
  for (const changes of [
    { event: "pull_request" }, { event: "push" }, { event: "workflow_dispatch" },
    { path: ".github/workflows/platform-isolation.yml" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "fork/repo" } },
    { head_branch: "gh-readonly-queue/other/pr-42-" + "c".repeat(40) },
    { head_branch: "main" }, { head_sha: "bad" }, { id: 0 }, { run_attempt: 0 },
  ]) {
    assert.equal(targetFromRun(run(changes), repository), null);
    assert.throws(() => targetFromEvent({ ...event(), workflow_run: run(changes) }, repository));
  }
  assert.equal(targetFromRun(run(), "not a repository"), null);
  assert.throws(() => targetFromEvent({ ...event(), action: "requested" }, repository));
});

test("the active listing keeps only recognised, unfinished merge-group attempts", async () => {
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    return listing(run(), liveRun(), run({ id: 7, status: "completed" }), run({ id: 8, event: "push" }), run({ id: 9, status: "mystery" }));
  };
  assert.deepEqual((await activeTargets(api, repository)).map((t) => t.id), [123, 456]);
  assert.equal(paths[0], `/repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&exclude_pull_requests=true&per_page=${RUN_PAGE}`);
  await assert.rejects(activeTargets(async () => ({ message: "nope" }), repository));
});

test("a deleted integration absent from complete live evidence is obsolete", () => {
  assert.equal(obsoleteEvidence(proof(), target).obsolete, true);
  const empty = proof();
  empty.data.repository.refs = connection([]);
  empty.data.repository.mergeQueue.entries = connection([]);
  assert.equal(obsoleteEvidence(empty, target).obsolete, true);
});

test("explicitly unbuilt queued entries do not mask obsolete integrations", () => {
  const payload = proof();
  const entries = payload.data.repository.mergeQueue.entries;
  entries.nodes.push({ state: "QUEUED", headCommit: null });
  entries.totalCount++;
  assert.equal(obsoleteEvidence(payload, target).obsolete, true);
  entries.nodes[1].headCommit = { oid: sha };
  assert.equal(obsoleteEvidence(payload, target).reason, "integration-still-needed");
  for (const entry of [
    { state: "QUEUED" }, { state: "QUEUED", headCommit: {} },
    ...["AWAITING_CHECKS", "MERGEABLE", "LOCKED", "UNMERGEABLE", "UNKNOWN"]
      .map((state) => ({ state, headCommit: null })),
  ]) {
    entries.nodes[1] = entry;
    assert.equal(obsoleteEvidence(payload, target).obsolete, false);
  }
});

test("all live queue entries and refs protect an integration, including another PR", () => {
  for (const source of ["ref", "entry", "own-ref"]) {
    const payload = proof();
    if (source === "ref") payload.data.repository.refs.nodes[0].target.oid = sha;
    if (source === "entry") payload.data.repository.mergeQueue.entries.nodes[0].headCommit.oid = sha;
    // The integration's own ref, even pointing somewhere unexpected, keeps it.
    if (source === "own-ref") payload.data.repository.refs = connection([
      ...payload.data.repository.refs.nodes, { name: "pr-42-" + "c".repeat(40), target: { oid: thirdSha } },
    ]);
    assert.equal(obsoleteEvidence(payload, target).obsolete, false, source);
  }
  // Complete evidence reaches the membership check itself, not the completeness guard (#3343 review).
  const own = proof();
  own.data.repository.refs = connection([{ name: "pr-42-" + "c".repeat(40), target: { oid: thirdSha } }]);
  assert.deepEqual(obsoleteEvidence(own, target), { obsolete: false, reason: "integration-ref-present" });
});

test("partial, unauthorized, malformed, or uncomputed evidence cannot authorize cancellation", () => {
  const edits = [
    (p) => { p.errors = [{ message: "denied" }]; },
    (p) => { p.data.repository = null; },
    (p) => { p.data.repository.nameWithOwner = "another/repo"; },
    (p) => { delete p.data.repository.refs; },
    (p) => { p.data.repository.mergeQueue = null; },
    (p) => { p.data.repository.refs.pageInfo.hasNextPage = true; },
    (p) => { p.data.repository.mergeQueue.entries.pageInfo.hasNextPage = true; },
    (p) => { p.data.repository.refs.totalCount = 2; },
    (p) => { p.data.repository.mergeQueue.entries.totalCount = 2; },
    (p) => { p.data.repository.mergeQueue.entries.nodes[0].headCommit = null; },
    (p) => { p.data.repository.mergeQueue.entries.nodes[0].state = "UNKNOWN"; },
    (p) => { p.data.repository.refs.nodes[0].name = "other"; },
    (p) => { p.data.repository.refs.nodes[0].target.oid = "unknown"; },
  ];
  for (const edit of edits) {
    const payload = proof(); edit(payload);
    assert.equal(obsoleteEvidence(payload, target).obsolete, false);
  }
  assert.equal(obsoleteEvidence(null, target).obsolete, false);
});

/**
 * Drives the monitor against scripted responses. `listings` are the active-run listings in poll
 * order (the last repeats), `runs` the per-run re-reads, `proofs` the queue snapshots.
 */
async function simulate({ listings = [listing(run(), liveRun())], runs = [], proofs = [], polls = 3, failCancel = false } = {}) {
  const calls = [], waits = [], logs = [];
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/cancel")) {
      if (failCancel) throw Object.assign(new Error("secret error"), { status: 403 });
      return null;
    }
    let value;
    if (path === "/graphql") value = proofs.length ? proofs.shift() : proof();
    else if (path.includes("/workflows/ci.yml/runs")) value = listings.length > 1 ? listings.shift() : listings[0];
    else value = runs.length ? runs.shift() : run();
    if (value instanceof Error) throw value;
    return value;
  };
  const result = await monitor(repository, { api, polls, wait: async (ms) => waits.push(ms), log: (line) => logs.push(JSON.parse(line)) });
  return { result, calls, waits, logs, cancels: calls.filter((call) => call.path.endsWith("/cancel")) };
}

test("two separated observations plus a fresh recheck cancel only the obsolete run", async () => {
  const result = await simulate();
  assert.deepEqual(result.cancels, [{ path: "/repos/example/project/actions/runs/123/cancel", body: {} }]);
  assert.deepEqual(result.waits, [POLL_MS, POLL_MS]);
  // One snapshot per poll, plus the recheck before the cancellation.
  assert.equal(result.calls.filter((c) => c.path === "/graphql").length, 4);
  const requested = result.logs.filter((log) => log.event === "merge_group_cancel_requested");
  assert.deepEqual(requested.map((log) => [log.runId, log.runAttempt, log.headSha]), [[123, 1, sha]]);
  assert.ok(result.logs.every((log) => log.entryPoint === "workflow_run"));
  assert.ok(result.logs.some((log) => log.runId === 456 && log.reason === "integration-ref-present"));
  assert.equal(result.result, "retained");
});

test("unbuilt entries preserve the two-observation and immediate live-head recheck", async () => {
  const unbuilt = proof();
  unbuilt.data.repository.mergeQueue.entries.nodes.push({ state: "QUEUED", headCommit: null });
  unbuilt.data.repository.mergeQueue.entries.totalCount++;
  const result = await simulate({ proofs: [unbuilt, unbuilt, unbuilt] });
  assert.equal(result.calls.filter((c) => c.path.endsWith("/cancel")).length, 1);
  const becomesLive = structuredClone(unbuilt);
  becomesLive.data.repository.mergeQueue.entries.nodes[1].headCommit = { oid: sha };
  const retained = await simulate({ proofs: [unbuilt, unbuilt, becomesLive], polls: 2 });
  assert.equal(retained.calls.filter((c) => c.path.endsWith("/cancel")).length, 0);
  assert.ok(retained.logs.some((l) => l.reason === "integration-still-needed"));
});

test("an attempt asked to stop is not asked again while it is still listed", async () => {
  const result = await simulate({ polls: 6 });
  assert.equal(result.cancels.length, 1);
});

test("the monitor exits as soon as no merge-group CI is active", async () => {
  const result = await simulate({ listings: [listing(run({ status: "completed" }))] });
  assert.equal(result.result, "idle");
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.waits, []);
  assert.equal(result.logs.at(-1).reason, "no-active-merge-group-ci");
  const later = await simulate({ listings: [listing(liveRun()), listing()], polls: 5 });
  assert.equal(later.result, "idle");
  assert.deepEqual(later.waits, [POLL_MS]);
});

test("live or uncomputed groups retain CI and stop at the monitor budget", async () => {
  for (const unknown of [false, true]) {
    const payload = proof();
    payload.data.repository.mergeQueue.entries.nodes[0].headCommit = unknown ? null : { oid: sha };
    const result = await simulate({ proofs: [payload, payload, payload] });
    assert.equal(result.cancels.length, 0);
    assert.equal(result.logs.at(-1).reason, "monitor-budget-exhausted");
  }
});

test("transient errors and live observations reset the consecutive-observation proof", async () => {
  const live = proof();
  live.data.repository.refs = connection([...live.data.repository.refs.nodes, { name: "pr-42-" + "c".repeat(40), target: { oid: sha } }]);
  for (const middle of [new Error("secret error"), live]) {
    const result = await simulate({ proofs: [proof(), middle, proof()] });
    assert.equal(result.cancels.length, 0);
    assert.equal(result.waits.length, 2);
    assert.ok(!JSON.stringify(result.logs).includes("secret error"));
  }
  const listingFailure = await simulate({ listings: [listing(run()), new Error("secret error"), listing(run())] });
  assert.equal(listingFailure.cancels.length, 0);
  assert.ok(listingFailure.logs.some((log) => log.event === "merge_group_evidence_unavailable" && log.runId === undefined));
});

test("an attempt that drops out of the listing must earn two fresh observations", async () => {
  const result = await simulate({ listings: [listing(run(), liveRun()), listing(liveRun()), listing(run(), liveRun())] });
  assert.equal(result.cancels.length, 0);
});

test("reappearance immediately before cancellation invalidates the proof", async () => {
  const live = proof(); live.data.repository.refs.nodes[0].target.oid = sha;
  const result = await simulate({ proofs: [proof(), proof(), live], polls: 2 });
  assert.equal(result.cancels.length, 0);
  assert.ok(result.logs.some((log) => log.event === "merge_group_cancel_withheld" && log.runId === 123));
});

test("a final API failure keeps checks intact", async () => {
  const result = await simulate({ proofs: [proof(), proof(), new Error("unavailable")], polls: 2 });
  assert.equal(result.cancels.length, 0);
  assert.ok(result.logs.some((log) => log.event === "merge_group_evidence_unavailable" && log.runId === 123));
});

test("completed or replaced attempts are not cancelled at the final check", async () => {
  for (const changes of [{ status: "completed" }, { status: "unknown" }, { run_attempt: 2 }, { head_sha: otherSha }, { event: "push" }]) {
    const result = await simulate({ runs: [run(changes)], polls: 2 });
    assert.equal(result.cancels.length, 0);
    assert.ok(result.logs.some((log) => log.reason === "run-changed-before-cancel"));
  }
});

test("each attempt of one run is judged separately", async () => {
  const rerun = run({ run_attempt: 2 });
  const result = await simulate({ listings: [listing(run()), listing(rerun)], polls: 2 });
  assert.equal(result.cancels.length, 0);
  const later = await simulate({ listings: [listing(run()), listing(rerun)], runs: [rerun] });
  assert.deepEqual(later.cancels.map((call) => call.path), ["/repos/example/project/actions/runs/123/cancel"]);
});

test("cancellation failure is diagnosed as retained, never as successful", async () => {
  const result = await simulate({ failCancel: true, polls: 2 });
  assert.equal(result.result, "retained");
  assert.ok(result.logs.some((log) => log.event === "merge_group_evidence_unavailable" && log.status === 403));
  assert.ok(!result.logs.some((log) => log.event === "merge_group_cancel_requested"));
});

test("HTTP transport is bounded, refuses redirects, and does not leak error bodies", async () => {
  const calls = [];
  const api = githubApi("test-token", async (url, options) => {
    calls.push({ url, options });
    return { ok: false, status: 403, json: () => { throw new Error("must not read error body"); } };
  });
  await assert.rejects(api("/graphql", { query: "query" }), (error) => error.status === 403 && !error.message.includes("test-token"));
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.method, "POST");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const accepted = githubApi("test-token", async () => ({ ok: true, status: 202 }));
  assert.equal(await accepted("/repos/example/project/actions/runs/123/cancel", {}), null);
});

test("privileged monitoring checks out only trusted workflow_run code and stays outside required CI", () => {
  const text = readFileSync(".github/workflows/merge-group-cleanup.yml", "utf8");
  assert.match(text, /workflows: \[CI\]\s+types: \[in_progress, completed\]/);
  assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.match(text, /persist-credentials: false/);
  assert.doesNotMatch(text, /workflow_run\.(head_sha|head_branch)|download-artifact|pull_request_target/);
  assert.match(text, /contents: read\s+pull-requests: read\s+actions: write/);
  assert.match(text, /workflow_run.event == 'merge_group'/);
  assert.match(text, /node scripts\/merge-group-cleanup.mjs/);
  // One shared monitor: job-level concurrency (so skipped pull-request invocations cannot replace
  // a waiting monitor), never cancelling the running one, and no per-run workflow concurrency.
  assert.match(text, /\n    concurrency:\n      group: merge-group-cleanup\n      cancel-in-progress: false\n/);
  assert.doesNotMatch(text, /^concurrency:/m);
  // A monotonic wall budget bounds slow API responses as well as polling sleeps.
  assert.ok(MONITOR_MS + 5 * REQUEST_MS < 40 * 60_000);
  assert.match(text, /timeout-minutes: 40/);
});

test("slow requests cannot extend polling beyond the wall budget", async () => {
  let elapsed = 0;
  const mutations = [];
  const result = await monitor(repository, {
    polls: 1000, now: () => elapsed, wait: async (ms) => { elapsed += ms; }, log: () => {},
    api: async (path) => {
      elapsed += REQUEST_MS;
      if (path.endsWith("/cancel")) mutations.push(path);
      if (path === "/graphql") {
        const live = proof(); live.data.repository.mergeQueue.entries.nodes[0].headCommit.oid = sha;
        return live;
      }
      return path.includes("/workflows/ci.yml/runs") ? listing(run()) : run();
    },
  });
  assert.equal(result, "retained");
  assert.equal(mutations.length, 0);
  assert.ok(elapsed < MONITOR_MS + 5 * REQUEST_MS);
});

test("a final proof arriving after the wall deadline cannot authorize cancellation", async () => {
  let elapsed = 0, snapshots = 0, cancelled = false;
  await monitor(repository, {
    now: () => elapsed, wait: async (ms) => { elapsed += ms; }, log: () => {},
    api: async (path) => {
      if (path.endsWith("/cancel")) cancelled = true;
      if (path === "/graphql" && ++snapshots === 3) elapsed = MONITOR_MS;
      if (path === "/graphql") return proof();
      return path.includes("/workflows/ci.yml/runs") ? listing(run()) : run();
    },
  });
  assert.equal(cancelled, false);
});
