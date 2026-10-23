import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ALERT_LABEL, ALERT_TITLE, alertBody, githubApi, reconcile as reconcileActual, REQUEST_MS, targetFromEvent,
} from "./main-ci-health.mjs";

const repository = "example/project";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const ciRun = (overrides = {}) => ({
  id: 123, run_attempt: 1, status: "completed", conclusion: "failure", event: "push",
  path: ".github/workflows/ci.yml", head_branch: "main", head_sha: sha,
  html_url: `https://github.com/${repository}/actions/runs/${overrides.id ?? 123}`,
  repository: { full_name: repository }, head_repository: { full_name: repository },
  ...overrides,
});
const event = (overrides = {}) => ({ action: "completed", workflow_run: ciRun(overrides) });
// These fixtures isolate issue transport from forge observation (covered separately).
const reconcile = (target, options) => reconcileActual(target, { ...options, persist: false,
  collect: async () => {
    const run = (await options.api(`/repos/${repository}/actions/workflows/ci.yml/runs?fixture`)).workflow_runs[0];
    const record = run && { runId: run.id, attempt: 1, testedSha: run.head_sha, url: run.html_url,
      certification: run.conclusion === "success" ? "full" : "none",
      inventory: (await options.api(`/repos/${repository}/actions/runs/${run.id}/jobs?fixture`)).jobs };
    return { status: run?.conclusion === "success" ? "passing" : "failing", evidence: record ? [record] : [], legacyEvidence: [], resolvedRunIds: [123],
      unresolvedFailures: run?.conclusion === "failure" ? [record] : [], latestPassingSnapshot: run?.conclusion === "success" ? record : null };
  } });
const alert = (latest = 123, overrides = {}) => ({
  number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
  user: { login: "github-actions[bot]", type: "Bot" },
  body: alertBody({ repository, run: ciRun({ id: latest }), jobs: ["Unit Tests"], author: null }),
  ...overrides,
});

/** A fake API: GET routes return fixtures, and every mutation is recorded. */
function fakeApi({ runs = [ciRun()], issues = [], jobs = [{ name: "Unit Tests", conclusion: "failure" }], author = { login: "maintainer", type: "User" } } = {}) {
  const mutations = [];
  const api = async (path, options = {}) => {
    const method = options.method ?? "GET";
    if (method !== "GET") {
      mutations.push({ method, path, body: options.body });
      return path.endsWith("/issues") ? { number: 9 } : {};
    }
    if (path.startsWith(`/repos/${repository}/actions/workflows/ci.yml/runs?`)) return { workflow_runs: runs };
    if (path.startsWith(`/repos/${repository}/issues?`)) return issues;
    if (path.startsWith(`/repos/${repository}/actions/runs/`) && path.includes("/jobs?")) return { jobs };
    if (path.startsWith(`/repos/${repository}/commits/`)) return { author };
    throw new Error(`unexpected path ${path}`);
  };
  return { api, mutations };
}

test("only a completed same-repository CI run for a main push is eligible", () => {
  assert.deepEqual(targetFromEvent(event(), repository), { repository });
  for (const changes of [
    { event: "pull_request" }, { event: "merge_group" }, { head_branch: "feature" },
    { path: ".github/workflows/platform-isolation.yml" }, { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "fork/repo" } }, { head_sha: "bad" },
  ]) assert.throws(() => targetFromEvent(event(changes), repository));
  assert.deepEqual(targetFromEvent({ ...event(), action: "in_progress" }, repository), { repository });
  assert.throws(() => targetFromEvent(event(), "not a repository"));
});

test("the alert names the run, the commit, the failing jobs and what to do, and records the latest run", () => {
  const body = alertBody({ repository, run: ciRun(), jobs: ["Typecheck, Unit Tests & Bundles"], author: "maintainer" });
  assert.match(body, /<!-- main-ci-health latest:123 -->/);
  assert.match(body, new RegExp(`\\[\`aaaaaaaaa\`\\]\\(https://github.com/${repository}/commit/${sha}\\)`));
  assert.match(body, new RegExp(`\\(https://github.com/${repository}/actions/runs/123\\)`));
  assert.match(body, /^- Typecheck, Unit Tests & Bundles$/m);
  assert.match(body, /docs\/main-ci-health\.md/);
  assert.match(body, /^cc @maintainer$/m);
  assert.doesNotMatch(alertBody({ repository, run: ciRun(), jobs: [], author: null }), /cc @/);
  // Job names come from the workflow file, but a name never starts a new Markdown block.
  assert.match(alertBody({ repository, run: ciRun(), jobs: ["a\n# b"], author: null }), /^- a # b$/m);
});

test("opening an alert ensures the label, creates one issue and mentions the head commit's author", async () => {
  const { api, mutations } = fakeApi();
  const log = [];
  assert.equal(await reconcile({ repository }, { api, log: (line) => log.push(JSON.parse(line)) }), "opened");
  assert.deepEqual(mutations.map(({ method, path }) => `${method} ${path}`), [
    `POST /repos/${repository}/labels`, `POST /repos/${repository}/issues`,
  ]);
  const issue = mutations[1].body;
  assert.equal(issue.title, ALERT_TITLE);
  assert.deepEqual(issue.labels, [ALERT_LABEL]);
  assert.match(issue.body, /^cc @maintainer$/m);
  assert.match(issue.body, /^- Unit Tests$/m);
  assert.ok(log.some((entry) => entry.event === "main_ci_alert_opened" && entry.runId === 123));
});

test("an existing label is not an error, and a bot or unknown author is never mentioned", async () => {
  const { api, mutations } = fakeApi({ author: { login: "dependabot[bot]", type: "Bot" } });
  const withLabel = async (path, options) => {
    if (options?.method === "POST" && path.endsWith("/labels")) {
      const error = new Error("GitHub API request failed"); error.status = 422; throw error;
    }
    return api(path, options);
  };
  assert.equal(await reconcile({ repository }, { api: withLabel, log: () => {} }), "opened");
  assert.doesNotMatch(mutations.at(-1).body.body, /cc @/);
});

test("a new failing run comments on the open alert and then records it; a repeat does nothing", async () => {
  const fresh = fakeApi({ runs: [ciRun({ id: 150, html_url: `https://github.com/${repository}/actions/runs/150` })], issues: [alert(123)] });
  assert.equal(await reconcile({ repository }, { api: fresh.api, log: () => {} }), "updated");
  assert.deepEqual(fresh.mutations.map(({ method, path }) => `${method} ${path}`), [
    `POST /repos/${repository}/issues/7/comments`, `PATCH /repos/${repository}/issues/7`,
  ]);
  assert.match(fresh.mutations[0].body.body, /actions\/runs\/150/);
  assert.match(fresh.mutations[1].body.body, /<!-- main-ci-health latest:150 -->/);

  const repeat = fakeApi({ issues: [alert(123)] });
  assert.equal(await reconcile({ repository }, { api: repeat.api, log: () => {} }), "unchanged");
  assert.equal(repeat.mutations.length, 0);
});

test("a passing main comments and closes the alert as completed", async () => {
  const green = ciRun({ id: 200, conclusion: "success", head_sha: otherSha, html_url: `https://github.com/${repository}/actions/runs/200` });
  const { api, mutations } = fakeApi({ runs: [green], issues: [alert(123)] });
  assert.equal(await reconcile({ repository }, { api, log: () => {} }), "closed");
  assert.deepEqual(mutations.map(({ method, path }) => `${method} ${path}`), [
    `POST /repos/${repository}/issues/7/comments`, `PATCH /repos/${repository}/issues/7`,
  ]);
  assert.match(mutations[0].body.body, /passed again/);
  assert.deepEqual(mutations[1].body, { state: "closed", state_reason: "completed" });
});

test("only an open, labelled alert written by Actions counts; pull requests and look-alikes are ignored", async () => {
  for (const impostor of [
    alert(123, { pull_request: {} }),
    alert(123, { user: { login: "someone", type: "User" } }),
    alert(123, { title: "Something Else" }),
  ]) {
    const { api, mutations } = fakeApi({ issues: [impostor] });
    assert.equal(await reconcile({ repository }, { api, log: () => {} }), "opened");
    assert.equal(mutations.at(-1).path, `/repos/${repository}/issues`);
  }
});

test("API failures change nothing and are reported without response bodies", async () => {
  const log = [];
  const failing = async () => { const error = new Error("secret body"); error.status = 502; throw error; };
  await assert.rejects(reconcile({ repository }, { api: failing, log: (line) => log.push(line) }));
  assert.ok(log.every((line) => !line.includes("secret body")));
});

test("the transport is bounded, refuses redirects and never echoes the token or body", async () => {
  const calls = [];
  const api = githubApi("test-token", async (url, options) => {
    calls.push({ url, options });
    return { ok: false, status: 403, json: async () => ({ message: "test-token leaked" }) };
  });
  await assert.rejects(api("/repos/example/project/issues", { method: "POST", body: { title: "x" } }),
    (error) => error.status === 403 && !error.message.includes("test-token"));
  assert.equal(calls[0].url, "https://api.github.com/repos/example/project/issues");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.body, JSON.stringify({ title: "x" }));
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(REQUEST_MS <= 10_000);
});

test("the workflow runs trusted default-branch code on main push CI only, serialized, with issue access", () => {
  const text = readFileSync(".github/workflows/main-ci-health.yml", "utf8");
  assert.match(text, /workflows: \[CI, Main Rolling Validation\]\s+types: \[requested, in_progress, completed\]/);
  assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.match(text, /persist-credentials: false/);
  assert.doesNotMatch(text, /workflow_run\.(head_sha)|download-artifact|pull_request_target|pnpm install/);
  // Every CI completion starts this workflow. Concurrency belongs to the eligible job: at workflow
  // level, a skipped pull-request invocation could replace a pending main reconciliation.
  assert.doesNotMatch(text, /^concurrency:/m);
  assert.match(text, /\n {4}concurrency:\n {6}group: main-ci-health\n {6}cancel-in-progress: false/);
  assert.match(text, /contents: write\s+actions: read\s+issues: write/);
  assert.match(text, /workflow_run.event == 'push'/);
  assert.match(text, /workflow_run.head_branch == 'main'/);
  assert.match(text, /node scripts\/main-ci-health.mjs/);
});
