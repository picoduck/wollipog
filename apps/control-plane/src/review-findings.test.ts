import assert from "node:assert/strict";
import test from "node:test";
import { formatReviewFindingsPrompt, parseBundleReviewFindings, parseCreateReviewFinding, parseUpdateReviewFinding, validateForgeReviewSync, validateGitHubReviewSync } from "./review-findings.js";

const create = {
  scope: "uncommitted",
  diffHash: "a".repeat(64),
  filePath: "src/example.ts",
  side: "right",
  line: 12,
  body: "  Preserve the retry invariant.  ",
  severity: "major",
  required: true,
} as const;

test("review finding creation validates an exact, line-anchored snapshot", () => {
  const parsed = parseCreateReviewFinding(create);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.body, "Preserve the retry invariant.");
  for (const patch of [
    { filePath: "../secret" },
    { filePath: "C:/secret" },
    { diffHash: "z".repeat(64) },
    { line: 0 },
    { body: " " },
    { extra: true },
  ]) assert.equal(parseCreateReviewFinding({ ...create, ...patch }).ok, false);
});

test("review finding updates and bundles require stale-safe exact identities", () => {
  assert.deepEqual(parseUpdateReviewFinding({ status: "resolved", expectedUpdatedAt: 4 }), {
    ok: true,
    value: { status: "resolved", expectedUpdatedAt: 4 },
  });
  assert.equal(parseUpdateReviewFinding({ status: "sent", expectedUpdatedAt: 4 }).ok, false);
  const identity = { findingId: "rf_abcdefgh", expectedUpdatedAt: 4 };
  assert.equal(parseBundleReviewFindings({ findings: [identity] }).ok, true);
  assert.equal(parseBundleReviewFindings({ findings: [identity, identity] }).ok, false);
  assert.equal(parseBundleReviewFindings({ findings: [] }).ok, false);
});

test("review bundle prompt retains requirement, provenance id, and exact location", () => {
  const prompt = formatReviewFindingsPrompt([{
    findingId: "rf_abcdefgh",
    sessionId: "s1",
    ...create,
    body: "Preserve the retry invariant.",
    status: "open",
    source: "local",
    author: { kind: "human", id: "local" },
    createdAt: 1,
    updatedAt: 1,
  }]);
  assert.match(prompt, /\[REQUIRED\] \[MAJOR\] src\/example\.ts:12 \(right, uncommitted\)/);
  assert.match(prompt, /Review finding id: rf_abcdefgh/);
  assert.match(prompt, /reviewer will verify and resolve/);
});

test("review bundle prompt describes remote-only GitLab discussions without a fabricated file", () => {
  const prompt = formatReviewFindingsPrompt([{
    findingId: "rf_gitlab01",
    sessionId: "s1",
    ...create,
    filePath: "__remote__/gitlab-discussion-101",
    line: 1,
    body: "General merge-request feedback.",
    status: "open",
    source: "gitlab",
    author: { kind: "human", id: "reviewer" },
    createdAt: 1,
    updatedAt: 1,
    remote: {
      provider: "gitlab",
      repository: "team/repo",
      pullRequestNumber: 7,
      threadId: "discussion-1",
      commentId: 101,
      url: "https://gitlab.com/team/repo/-/merge_requests/7#note_101",
      commitId: "a".repeat(40),
      outdated: true,
      subjectType: "remote",
      synchronizedAt: 2,
    },
  }]);
  assert.match(prompt, /Remote GitLab discussion \(https:\/\/gitlab\.com\/team\/repo\/-\/merge_requests\/7#note_101\)/);
  assert.doesNotMatch(prompt, /__remote__/);
});

test("GitHub review snapshots are revalidated at the control-plane trust boundary", () => {
  const sync = {
    repository: "acme/repo", pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/acme/repo/pull/7",
    pullRequestHeadOid: "a".repeat(40), pullRequestBaseOid: "b".repeat(40),
    localHeadOid: "a".repeat(40), diffHash: "d".repeat(64), synchronizedAt: 2_000,
    threads: [{
      threadId: "PRRT_1", commentId: 101,
      url: "https://github.com/acme/repo/pull/7#discussion_r101",
      path: "src/a.ts", side: "right", line: 4, body: "Remote issue", author: "reviewer",
      createdAt: 1_000, updatedAt: 1_100, commitId: "c".repeat(40), subjectType: "line", resolved: false, outdated: false,
    }],
  } as const;
  assert.equal(validateGitHubReviewSync(sync), true);
  assert.equal(validateGitHubReviewSync({ ...sync, threads: [{ ...sync.threads[0], url: "javascript:alert(1)" }] }), false);
  assert.equal(validateGitHubReviewSync({ ...sync, threads: [{ ...sync.threads[0], path: "../secret" }] }), false);
  assert.equal(validateGitHubReviewSync({ ...sync, threads: [sync.threads[0], sync.threads[0]] }), false);
  assert.equal(validateGitHubReviewSync({ ...sync, diffHash: "not-a-hash" }), false);
});

test("GitLab review snapshots enforce exact self-managed host/project provenance", () => {
  const sync = {
    provider: "gitlab", host: "gitlab.example.test", project: "team/sub/repo", changeRequestNumber: 19,
    changeRequestUrl: "https://gitlab.example.test/team/sub/repo/-/merge_requests/19",
    changeRequestHeadOid: "a".repeat(40), changeRequestBaseOid: "b".repeat(40),
    localHeadOid: "a".repeat(40), diffHash: "d".repeat(64), synchronizedAt: 2_000,
    threads: [{
      threadId: "discussion-1", commentId: 101,
      url: "https://gitlab.example.test/team/sub/repo/-/merge_requests/19#note_101",
      path: "src/a.ts", side: "right", line: 4, body: "Remote issue", author: "reviewer",
      createdAt: 1_000, updatedAt: 1_100, commitId: "c".repeat(40), subjectType: "line", resolved: false, outdated: false,
    }],
  } as const;
  assert.equal(validateForgeReviewSync(sync), true);
  assert.equal(validateForgeReviewSync({ ...sync, host: "evil.test" }), false);
  assert.equal(validateForgeReviewSync({ ...sync, changeRequestUrl: `${sync.changeRequestUrl}.evil.test` }), false);
  assert.equal(validateForgeReviewSync({ ...sync, changeRequestUrl: "https://token@gitlab.example.test/team/sub/repo/-/merge_requests/19" }), false);
  assert.equal(validateForgeReviewSync({ ...sync, threads: [{ ...sync.threads[0], url: "https://evil.test/#note_101" }] }), false);
  assert.equal(validateForgeReviewSync({ ...sync, threads: [{ ...sync.threads[0], subjectType: "remote", path: "__remote__/discussion-101" }] }), true);
  assert.equal(validateForgeReviewSync({ ...sync, provider: "github", host: "github.com", threads: [{ ...sync.threads[0], subjectType: "remote" }] }), false);
});
