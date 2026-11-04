/**
 * GitHub merge preflight (#3713): what merging a pull request would close, read-only, before a
 * GitHub `pr_merge` is requested or armed. `gh` is faked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhOutcome, GhRunner } from "./campaign-forge-status.js";
import { githubMergePreflight, inspectPullRequestClosures, pullRequestClosures } from "./github-merge-preflight.js";

const HEAD = "5c1e0b7a90f2c3d4e5f60718293a4b5c6d7e8f90";
const REQUEST = { repository: "Picoduck/Wollipog", pullRequest: 3729, headSha: HEAD };

function pullRequest(overrides: Record<string, unknown> = {}, linked: unknown[] = [], hasNextPage = false) {
  return { data: { repository: { nameWithOwner: "picoduck/wollipog", pullRequest: {
    number: 3729, state: "OPEN", headRefOid: HEAD, body: "Refs #3713.",
    closingIssuesReferences: { nodes: linked, pageInfo: { hasNextPage } }, ...overrides,
  } } } };
}

function gh(answer: unknown | GhOutcome, calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args);
    if (answer && typeof answer === "object" && "code" in answer) return answer as GhOutcome;
    return { stdout: JSON.stringify(answer), stderr: "", code: null, timedOut: false };
  };
}

test("a negated closing phrase in the description is reported with its line, as #3635 should have been", async () => {
  const calls: string[][] = [];
  const result = await githubMergePreflight(REQUEST, gh(pullRequest({
    body: "Slice one of two. Refs #3635.\n\nThis PR does not close #3635, and must not auto-close #3633.",
  }), calls), () => 42);
  assert.deepEqual(result, { ok: true, check: { checkedAt: 42, closures: [
    { issue: "picoduck/wollipog#3633", sources: ["description"], excerpt: "This PR does not close #3635, and must not auto-close #3633." },
    { issue: "picoduck/wollipog#3635", sources: ["description"], excerpt: "This PR does not close #3635, and must not auto-close #3633." },
  ] } });
  // One read-only GraphQL call, naming github.com and the exact pull request.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 3), ["api", "graphql", "--hostname"]);
  assert.ok(calls[0]!.includes("owner=Picoduck") && calls[0]!.includes("name=Wollipog") && calls[0]!.includes("number=3729"));
  assert.match(calls[0]!.find((arg) => arg.startsWith("query="))!, /closingIssuesReferences\(first:100\)/u);
});

test("GitHub's own links are reported too, including an issue linked by hand or in another repository", async () => {
  const result = await githubMergePreflight(REQUEST, gh(pullRequest({ body: "Closes #3713. Code: `closes #1`." }, [
    { number: 3713, repository: { nameWithOwner: "picoduck/wollipog" } },
    { number: 7, repository: { nameWithOwner: "Other/Tools" } },
  ])), () => 1);
  assert.ok(result.ok);
  assert.deepEqual(result.check.closures, [
    { issue: "other/tools#7", sources: ["linked"] },
    { issue: "picoduck/wollipog#3713", sources: ["description", "linked"], excerpt: "Closes #3713. Code: `closes #1`." },
  ]);
});

test("a pull request that closes nothing reports no closures", async () => {
  const result = await githubMergePreflight(REQUEST, gh(pullRequest({ body: "Refs #3713. Fixes are described below." })));
  assert.ok(result.ok);
  assert.deepEqual(result.check.closures, []);
});

test("a moved head or a pull request that is no longer open is stale", async () => {
  assert.deepEqual(await githubMergePreflight(REQUEST, gh(pullRequest({ headRefOid: "f".repeat(40) }))),
    { ok: false, refusal: "stale_head", reason: "The pull request's head is no longer the decision's head." });
  assert.deepEqual(await githubMergePreflight(REQUEST, gh(pullRequest({ state: "MERGED" }))),
    { ok: false, refusal: "stale_head", reason: "The pull request is already merged." });
  assert.deepEqual(await githubMergePreflight(REQUEST, gh(pullRequest({ state: "CLOSED" }))),
    { ok: false, refusal: "stale_head", reason: "The pull request is already closed." });
});

test("anything GitHub does not prove is unavailable with a fixed sentence, never gh output", async () => {
  const failed = (stderr: string, code: number | string = 1): GhOutcome => ({ stdout: "", stderr, code, timedOut: false });
  const cases: Array<[unknown, string]> = [
    [failed("", "ENOENT"), "gh is not installed in this session's context."],
    [failed("HTTP 401: Bad credentials secret-token-text"), "gh in this session's context is not signed in to github.com."],
    [failed("API rate limit exceeded"), "github.com rate-limited this gh login."],
    [failed("something odd secret-token-text"), "GitHub returned an error."],
    [{ errors: [{ message: "nope" }] }, "GitHub returned an unexpected answer for the pull request."],
    [{ data: { repository: { nameWithOwner: "picoduck/wollipog", pullRequest: null } } }, "GitHub has no such pull request, or this gh login cannot see it."],
    [{ data: { repository: { nameWithOwner: "someone/else", pullRequest: pullRequest().data.repository.pullRequest } } }, "GitHub returned an unexpected answer for the pull request."],
    [pullRequest({ number: 1 }), "GitHub returned an unexpected answer for the pull request."],
    [pullRequest({ body: null }), "GitHub returned an unexpected answer for the pull request."],
    [pullRequest({ state: "DRAFT" }), "GitHub returned an unexpected answer for the pull request."],
    [pullRequest({}, [], true), "GitHub returned an unexpected answer for the pull request."],
    [pullRequest({}, [{ number: 0, repository: { nameWithOwner: "picoduck/wollipog" } }]), "GitHub returned an unexpected answer for the pull request."],
    [pullRequest({}, [{ number: 5, repository: {} }]), "GitHub returned an unexpected answer for the pull request."],
    [pullRequest({ body: Array.from({ length: 101 }, (_, i) => `closes #${i + 1}`).join("\n") }),
      "The pull request would close more than 100 issues, more than this runner checks."],
  ];
  for (const [answer, reason] of cases) {
    const result = await githubMergePreflight(REQUEST, gh(answer));
    assert.deepEqual(result, { ok: false, refusal: "unavailable", reason }, JSON.stringify(answer).slice(0, 120));
  }
  const unparsable: GhRunner = async () => ({ stdout: "not json", stderr: "", code: null, timedOut: false });
  assert.equal((await githubMergePreflight(REQUEST, unparsable)).ok, false);
  for (const request of [{ ...REQUEST, headSha: "HEAD" }, { ...REQUEST, pullRequest: 0 }, { ...REQUEST, repository: "nope" }]) {
    assert.deepEqual(await githubMergePreflight(request, gh(pullRequest())), { ok: false, refusal: "unavailable",
      reason: "The decision does not name a GitHub pull request this runner can check." });
  }
});

test("the inspection serves a merged pull request too, for checking after the fact", async () => {
  const inspected = await inspectPullRequestClosures("picoduck/wollipog", 3729, gh(pullRequest({ state: "MERGED", body: "fixes #9" })));
  assert.deepEqual(inspected, { ok: true, state: "MERGED", headSha: HEAD,
    closures: [{ issue: "picoduck/wollipog#9", sources: ["description"], excerpt: "fixes #9" }] });
});

test("closures merge one entry per issue in issue order", () => {
  assert.deepEqual(pullRequestClosures("Closes #12 and fixes #3; resolves #12 again.", "a/b", ["a/b#3", "a/a#40"]), [
    { issue: "a/a#40", sources: ["linked"] },
    { issue: "a/b#3", sources: ["description", "linked"], excerpt: "Closes #12 and fixes #3; resolves #12 again." },
    { issue: "a/b#12", sources: ["description"], excerpt: "Closes #12 and fixes #3; resolves #12 again." },
  ]);
});
