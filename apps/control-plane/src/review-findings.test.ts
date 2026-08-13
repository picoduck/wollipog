import assert from "node:assert/strict";
import test from "node:test";
import { formatReviewFindingsPrompt, parseBundleReviewFindings, parseCreateReviewFinding, parseUpdateReviewFinding, validateGitHubReviewSync } from "./review-findings.js";

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
