/**
 * GitLab merge closures (#3762): every issue merging a GitLab merge request would close, read-only,
 * from GitLab's closing pattern on the description and GitLab's own `closes_issues` list. `glab` is
 * faked by path; no GitLab instance is contacted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome } from "./campaign-forge-status.js";
import type { GlabRunner } from "./campaign-gitlab-status.js";
import { gitlabMergeClosures, inspectMergeRequestClosures } from "./gitlab-merge-closures.js";

const HOST = "gitlab.example.com";
const PROJECT = "platform/agents/wollipog";
const ENCODED = encodeURIComponent(PROJECT);
const HEAD = "5c1e0b7a90f2c3d4e5f60718293a4b5c6d7e8f90";
const REQUEST = { repository: `${HOST}/${PROJECT}`, pullRequest: 7, headSha: HEAD };
const ok = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });
const issue = (n: number, path = PROJECT) => ({ id: 1000 + n, iid: n, project_id: 1, title: `Issue ${n}`, state: "opened",
  web_url: `https://${HOST}/${path}/-/issues/${n}`, references: { short: `#${n}`, relative: `#${n}`, full: `${path}#${n}` } });
const at = (n: number) => `${HOST}/${PROJECT}#${n}`;

function fake(overrides: { mr?: Record<string, unknown> | GhOutcome; closes?: unknown[] | GhOutcome } = {}) {
  const calls: string[][] = [];
  const glab: GlabRunner = async (args) => {
    calls.push(args);
    if (args[1] === `projects/${ENCODED}/merge_requests/7`) {
      const mr = overrides.mr;
      return mr && "code" in mr ? mr as GhOutcome
        : ok({ iid: 7, state: "opened", sha: HEAD, title: "Refs #1", description: "Refs #3762.", ...(mr ?? {}) });
    }
    if (args[1] === `projects/${ENCODED}/merge_requests/7/closes_issues?per_page=100`) {
      const closes = overrides.closes;
      return closes && !Array.isArray(closes) ? closes as GhOutcome : ok(closes ?? []);
    }
    throw new Error(`unexpected glab ${args.join(" ")}`);
  };
  return { glab, calls };
}

test("a merge request that closes nothing is read with two GETs naming the host", async () => {
  const { glab, calls } = fake();
  assert.deepEqual(await gitlabMergeClosures(REQUEST, glab, () => 42), { ok: true, check: { checkedAt: 42, closures: [] } });
  assert.deepEqual(calls, [
    ["api", `projects/${ENCODED}/merge_requests/7`, "--hostname", HOST],
    ["api", `projects/${ENCODED}/merge_requests/7/closes_issues?per_page=100`, "--hostname", HOST],
  ]);
});

test("negated, -ing, Implements and multi-reference descriptions report each issue with its line", async () => {
  const description = [
    "This MR does not close #12.",
    "Implementing #13 here.",
    "Closes #14, sibling#15 and other/project#16",
  ].join("\n");
  const result = await gitlabMergeClosures(REQUEST, fake({ mr: { description } }).glab, () => 1);
  assert.ok(result.ok);
  assert.deepEqual(result.check.closures, [
    { issue: `${HOST}/other/project#16`, sources: ["description"], excerpt: "Closes #14, sibling#15 and other/project#16" },
    { issue: `${HOST}/platform/agents/sibling#15`, sources: ["description"], excerpt: "Closes #14, sibling#15 and other/project#16" },
    { issue: at(12), sources: ["description"], excerpt: "This MR does not close #12." },
    { issue: at(13), sources: ["description"], excerpt: "Implementing #13 here." },
    { issue: at(14), sources: ["description"], excerpt: "Closes #14, sibling#15 and other/project#16" },
  ]);
});

test("GitLab's own list is authoritative alongside the description: either source alone is a closure", async () => {
  // #20 is closed through a title, a commit or an instance's own pattern; #21 by both sources.
  const result = await gitlabMergeClosures(REQUEST, fake({ mr: { description: "Fixes #21" },
    closes: [issue(20), issue(21), issue(5, "platform/other")] }).glab, () => 1);
  assert.ok(result.ok);
  assert.deepEqual(result.check.closures, [
    { issue: at(20), sources: ["linked"] },
    { issue: at(21), sources: ["description", "linked"], excerpt: "Fixes #21" },
    { issue: `${HOST}/platform/other#5`, sources: ["linked"] },
  ]);
  // Without `references`, the issue's URL names it.
  const byUrl = await gitlabMergeClosures(REQUEST, fake({ closes: [{ ...issue(22), references: undefined }] }).glab, () => 1);
  assert.deepEqual(byUrl.ok && byUrl.check.closures, [{ issue: at(22), sources: ["linked"] }]);
  // A null description is an empty one.
  assert.deepEqual(await gitlabMergeClosures(REQUEST, fake({ mr: { description: null } }).glab, () => 1),
    { ok: true, check: { checkedAt: 1, closures: [] } });
});

test("a merge request that is not open at the decision's head is stale", async () => {
  for (const [state, words] of [["merged", "already merged"], ["closed", "closed"], ["locked", "being merged already"]] as const) {
    assert.deepEqual(await gitlabMergeClosures(REQUEST, fake({ mr: { state } }).glab),
      { ok: false, refusal: "stale_head", reason: `The merge request is ${words}.` });
  }
  assert.deepEqual(await gitlabMergeClosures(REQUEST, fake({ mr: { sha: "f".repeat(40) } }).glab),
    { ok: false, refusal: "stale_head", reason: "The merge request's head is no longer the decision's head." });
});

test("anything unreadable proves nothing, in fixed sentences that never repeat glab output", async () => {
  const unauthenticated = await gitlabMergeClosures(REQUEST,
    fake({ closes: { stdout: "", stderr: "glab: 401 Unauthorized (HTTP 401) token=glpat-secret", code: 1, timedOut: false } }).glab);
  assert.deepEqual(unauthenticated, { ok: false, refusal: "unavailable", reason: `glab in this session's context is not signed in to ${HOST}.` });
  for (const overrides of [
    { mr: { iid: 8 } }, { mr: { sha: "short" } }, { mr: { state: "reopened" } }, { mr: { description: 3 } },
    { mr: { stdout: "not json", stderr: "", code: null, timedOut: false } },
    { closes: ok({ message: "not a list" }) as unknown as unknown[] },
    { closes: [{ ...issue(3), references: { full: "platform/agents/wollipog#4" } }] },
    { closes: [{ ...issue(3), references: undefined, web_url: "https://other.example.com/a/b/-/issues/3" }] },
  ]) {
    const result = await gitlabMergeClosures(REQUEST, fake(overrides as Parameters<typeof fake>[0]).glab);
    assert.equal(result.ok === false && result.refusal, "unavailable", JSON.stringify(overrides));
  }
  const external = await gitlabMergeClosures(REQUEST, fake({ closes: [{ id: "ABC-1", title: "Jira issue" }] }).glab);
  assert.match(external.ok ? "" : external.reason, /not a GitLab issue this runner can name/u);
  const full = await gitlabMergeClosures(REQUEST, fake({ closes: Array.from({ length: 100 }, (_, i) => issue(i + 1)) }).glab);
  assert.match(full.ok ? "" : full.reason, /at least 100 issues/u);
  for (const request of [{ ...REQUEST, headSha: "abc" }, { ...REQUEST, repository: "platform/wollipog" }, { ...REQUEST, pullRequest: 0 }]) {
    const refused = await gitlabMergeClosures(request, fake().glab);
    assert.equal(refused.ok === false && refused.refusal, "unavailable", JSON.stringify(request));
  }
  const inspected = await inspectMergeRequestClosures(REQUEST.repository, 7, fake().glab);
  assert.deepEqual(inspected, { ok: true, state: "opened", headSha: HEAD, closures: [] });
});
