import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { githubApi, MONITOR_MS, monitor, obsoleteEvidence, POLL_MS, REQUEST_MS, targetFromEvent } from "./merge-group-cleanup.mjs";

const repository = "example/project";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const branch = "gh-readonly-queue/main/pr-42-" + "c".repeat(40);
const target = { repository, id: 123, attempt: 1, branch, sha };
const run = () => ({
  id: target.id, run_attempt: 1, status: "in_progress", event: "merge_group",
  path: ".github/workflows/ci.yml", repository: { full_name: repository },
  head_repository: { full_name: repository }, head_branch: branch, head_sha: sha,
});
const event = () => ({ action: "in_progress", workflow_run: run() });
const connection = (nodes) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false } });
const proof = () => ({ data: { repository: {
  nameWithOwner: repository, ref: null,
  refs: connection([{ name: "pr-43-" + "d".repeat(40), target: { oid: otherSha } }]),
  mergeQueue: { entries: connection([{ state: "AWAITING_CHECKS", headCommit: { oid: otherSha } }]) },
} } });

test("only an exact same-repository main merge-group CI attempt is eligible", () => {
  assert.deepEqual(targetFromEvent(event(), repository), target);
  for (const changes of [
    { event: "pull_request" }, { event: "push" }, { event: "workflow_dispatch" },
    { path: ".github/workflows/platform-isolation.yml" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "fork/repo" } },
    { head_branch: "gh-readonly-queue/other/pr-42-" + "c".repeat(40) },
    { head_branch: "main" }, { head_sha: "bad" }, { id: 0 }, { run_attempt: 0 },
  ]) assert.throws(() => targetFromEvent({ ...event(), workflow_run: { ...run(), ...changes } }, repository));
  assert.throws(() => targetFromEvent({ ...event(), action: "completed" }, repository));
});

test("a deleted integration absent from complete live evidence is obsolete", () => {
  assert.equal(obsoleteEvidence(proof(), target).obsolete, true);
  const empty = proof();
  empty.data.repository.refs = connection([]);
  empty.data.repository.mergeQueue.entries = connection([]);
  assert.equal(obsoleteEvidence(empty, target).obsolete, true);
});

test("all live queue entries and refs protect an integration, including another PR", () => {
  for (const source of ["ref", "entry", "own-ref"]) {
    const payload = proof();
    if (source === "ref") payload.data.repository.refs.nodes[0].target.oid = sha;
    if (source === "entry") payload.data.repository.mergeQueue.entries.nodes[0].headCommit.oid = sha;
    if (source === "own-ref") payload.data.repository.ref = { target: { oid: sha } };
    assert.equal(obsoleteEvidence(payload, target).obsolete, false, source);
  }
});

test("partial, unauthorized, malformed, or uncomputed evidence cannot authorize cancellation", () => {
  const edits = [
    (p) => { p.errors = [{ message: "denied" }]; },
    (p) => { p.data.repository = null; },
    (p) => { p.data.repository.nameWithOwner = "another/repo"; },
    (p) => { delete p.data.repository.ref; },
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

async function simulate({ runs = [], proofs = [], polls = 3, failCancel = false } = {}) {
  const calls = [], waits = [], logs = [];
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/cancel")) {
      if (failCancel) throw Object.assign(new Error("secret error"), { status: 403 });
      return null;
    }
    const value = path === "/graphql" ? (proofs.length ? proofs.shift() : proof()) : (runs.length ? runs.shift() : run());
    if (value instanceof Error) throw value;
    return value;
  };
  const result = await monitor(target, { api, polls, wait: async (ms) => waits.push(ms), log: (line) => logs.push(JSON.parse(line)) });
  return { result, calls, waits, logs, cancels: calls.filter((call) => call.path.endsWith("/cancel")) };
}

test("two separated observations plus a fresh recheck cancel only the named run", async () => {
  const result = await simulate();
  assert.equal(result.result, "cancel-requested");
  assert.deepEqual(result.waits, [POLL_MS]);
  assert.deepEqual(result.cancels, [{ path: "/repos/example/project/actions/runs/123/cancel", body: {} }]);
  assert.equal(result.calls.filter((c) => c.path === "/graphql").length, 3);
  assert.ok(result.logs.every((log) => log.runId === 123 && log.entryPoint === "workflow_run"));
  assert.equal(result.logs.at(-1).event, "merge_group_cancel_requested");
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
  const live = proof(); live.data.repository.ref = { target: { oid: sha } };
  for (const middle of [new Error("secret error"), live]) {
    const result = await simulate({ proofs: [proof(), middle, proof()] });
    assert.equal(result.cancels.length, 0);
    assert.equal(result.waits.length, 2);
    assert.ok(!JSON.stringify(result.logs).includes("secret error"));
  }
});

test("reappearance immediately before cancellation invalidates the proof", async () => {
  const live = proof(); live.data.repository.refs.nodes[0].target.oid = sha;
  const result = await simulate({ proofs: [proof(), proof(), live], polls: 2 });
  assert.equal(result.cancels.length, 0);
  assert.ok(result.logs.some((log) => log.event === "merge_group_cancel_withheld"));
});

test("a final API failure keeps checks intact", async () => {
  const result = await simulate({ proofs: [proof(), proof(), new Error("unavailable")], polls: 2 });
  assert.equal(result.cancels.length, 0);
  assert.ok(result.logs.some((log) => log.event === "merge_group_evidence_unavailable"));
});

test("completed or replaced attempts are not cancelled, including at the final check", async () => {
  for (const changes of [{ status: "completed" }, { status: "unknown" }, { run_attempt: 2 }, { head_sha: otherSha }, { event: "push" }]) {
    for (const final of [false, true]) {
      const changed = { ...run(), ...changes };
      const result = await simulate({ runs: final ? [run(), run(), changed] : [changed], polls: final ? 2 : 1 });
      assert.equal(result.cancels.length, 0);
    }
  }
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
  assert.match(text, /workflows: \[CI\]\s+types: \[in_progress\]/);
  assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.match(text, /persist-credentials: false/);
  assert.doesNotMatch(text, /workflow_run\.(head_sha|head_branch)|download-artifact|pull_request_target/);
  assert.match(text, /group: merge-group-cleanup-\$\{\{ github.event.workflow_run.id \}\}-\$\{\{ github.event.workflow_run.run_attempt \}\}/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /contents: read\s+pull-requests: read\s+actions: write/);
  assert.match(text, /workflow_run.event == 'merge_group'/);
  assert.match(text, /node scripts\/merge-group-cleanup.mjs/);
  // A monotonic wall budget bounds slow API responses as well as polling sleeps.
  assert.ok(MONITOR_MS + 5 * REQUEST_MS < 40 * 60_000);
});

test("slow requests cannot extend polling beyond the wall budget", async () => {
  let elapsed = 0;
  const mutations = [];
  const result = await monitor(target, {
    polls: 1000, now: () => elapsed, wait: async (ms) => { elapsed += ms; }, log: () => {},
    api: async (path) => {
      elapsed += REQUEST_MS;
      if (path.endsWith("/cancel")) mutations.push(path);
      const live = proof(); live.data.repository.ref = { target: { oid: sha } };
      return path === "/graphql" ? live : run();
    },
  });
  assert.equal(result, "retained");
  assert.equal(mutations.length, 0);
  assert.ok(elapsed < MONITOR_MS + 5 * REQUEST_MS);
});

test("a final proof arriving after the wall deadline cannot authorize cancellation", async () => {
  let elapsed = 0, snapshots = 0, cancelled = false;
  await monitor(target, {
    now: () => elapsed, wait: async (ms) => { elapsed += ms; }, log: () => {},
    api: async (path) => {
      if (path.endsWith("/cancel")) cancelled = true;
      if (path === "/graphql" && ++snapshots === 3) elapsed = MONITOR_MS;
      return path === "/graphql" ? proof() : run();
    },
  });
  assert.equal(cancelled, false);
});
