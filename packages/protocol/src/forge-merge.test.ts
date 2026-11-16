import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forgeMergeBlockers,
  parsePullRequestMergeRequest,
  pullRequestMergeMode,
  pullRequestMergeReadiness,
  sessionMergeBlockers,
  type PullRequestMergeFacts,
  type PullRequestMergeSessionFacts,
} from "./forge-merge.js";

const HEAD = "a".repeat(40);

const facts = (overrides: Partial<PullRequestMergeFacts> = {}): PullRequestMergeFacts => ({
  url: "https://github.com/o/r/pull/7", repository: "o/r", number: 7, state: "open", headSha: HEAD,
  isDraft: false, baseRef: "main", mergeQueueEnabled: true, inMergeQueue: false, mergeStateStatus: "CLEAN",
  requiredChecks: { state: "passed", failing: [], pending: [] }, viewerPermission: "write",
  mergeMethod: "squash", deleteBranchOnMerge: false, observedAt: 1, ...overrides,
});
const allowed: PullRequestMergeSessionFacts = { roleRefusal: null, runnerSupported: true, requiredFindingsOpen: 0 };

test("the gate is open only when every condition holds; the base's queue picks enqueue or merge", () => {
  const queued = pullRequestMergeReadiness(facts(), allowed);
  assert.deepEqual(queued, { mode: "enqueue", label: "Enqueue for Merge", ready: true, blockers: [], headSha: HEAD, mergeMethod: null });
  const direct = pullRequestMergeReadiness(facts({ mergeQueueEnabled: false, mergeMethod: "rebase" }), allowed);
  assert.deepEqual(direct, { mode: "merge", label: "Merge Pull Request", ready: true, blockers: [], headSha: HEAD, mergeMethod: "rebase" });
  for (const state of ["none"] as const) {
    assert.equal(pullRequestMergeReadiness(facts({ requiredChecks: { state, failing: [], pending: [] } }), allowed).ready, true,
      "a base with no required checks has nothing to wait for");
  }
});

test("each failing condition disables the action with its own sentence-case explanation", () => {
  const cases: Array<[Partial<PullRequestMergeFacts>, string, RegExp]> = [
    [{ requiredChecks: { state: "failed", failing: ["unit", "lint"], pending: [] } }, "checks_failed", /^Required checks failed on the current head: unit, lint\.$/u],
    [{ requiredChecks: { state: "pending", failing: [], pending: ["CI"] } }, "checks_pending", /^Required checks haven't passed on the current head yet: CI\.$/u],
    [{ requiredChecks: { state: "pending", failing: [], pending: [] } }, "checks_pending", /^Required checks haven't passed on the current head yet\.$/u],
    [{ requiredChecks: { state: "failed", failing: ["a", "b", "c", "d", "e"], pending: [] } }, "checks_failed", /a, b, c and 2 more\.$/u],
    [{ viewerPermission: "read" }, "forge_permission", /^This machine's GitHub account can't merge into o\/r\.$/u],
    [{ viewerPermission: null }, "forge_permission", /can't merge/u],
    [{ isDraft: true }, "draft", /^Draft pull requests can't be merged/u],
    [{ inMergeQueue: true }, "in_queue", /already in the merge queue/u],
    [{ mergeStateStatus: "DIRTY" }, "conflicts", /merge conflicts with main/u],
    [{ mergeQueueEnabled: false, mergeMethod: null }, "no_merge_method", /allows no merge method/u],
    [{ mergeQueueEnabled: null }, "unavailable", /did not say whether the base branch uses a merge queue/u],
  ];
  for (const [overrides, code, message] of cases) {
    const readiness = pullRequestMergeReadiness(facts(overrides), allowed);
    assert.equal(readiness.ready, false, code);
    const blocker = readiness.blockers.find((candidate) => candidate.code === code);
    assert.ok(blocker, `${code}: ${JSON.stringify(readiness.blockers)}`);
    assert.match(blocker.message, message);
  }
  // A queue applies its own method: no merge method is not a blocker there.
  assert.equal(pullRequestMergeReadiness(facts({ mergeMethod: null }), allowed).ready, true);
});

test("only GitHub's mergeable states pass, so an admin login never merges past the base branch's rules", () => {
  const codes = (overrides: Partial<PullRequestMergeFacts>) => forgeMergeBlockers(facts(overrides)).map((blocker) => blocker.code);
  for (const mergeStateStatus of ["CLEAN", "HAS_HOOKS", "UNSTABLE"]) {
    assert.deepEqual(codes({ mergeStateStatus }), [], mergeStateStatus);
    assert.deepEqual(codes({ mergeStateStatus, mergeQueueEnabled: false }), [], `${mergeStateStatus} direct`);
  }
  assert.deepEqual(codes({ mergeStateStatus: "BLOCKED" }), ["blocked"], "a required review GitHub still wants");
  assert.deepEqual(codes({ mergeStateStatus: "BLOCKED", requiredChecks: { state: "pending", failing: [], pending: ["CI"] } }),
    ["checks_pending"], "pending checks already explain a blocked state");
  assert.deepEqual(codes({ mergeStateStatus: "BEHIND" }), [], "a queue tests on the latest base anyway");
  assert.deepEqual(codes({ mergeStateStatus: "BEHIND", mergeQueueEnabled: false }), ["behind"]);
  for (const mergeStateStatus of ["UNKNOWN", "DRAFT", null, "SOMETHING_NEW"]) {
    assert.deepEqual(codes({ mergeStateStatus }), ["merge_state_unknown"], String(mergeStateStatus));
  }
  assert.match(forgeMergeBlockers(facts({ mergeStateStatus: "BLOCKED" }))[0]!.message, /^GitHub reports the base branch's rules are not met yet/u);
});

test("a merged, closed, or unread pull request explains itself and nothing else", () => {
  assert.deepEqual(forgeMergeBlockers(facts({ state: "merged" })), [{ code: "not_open", message: "This pull request is already merged." }]);
  assert.deepEqual(forgeMergeBlockers(facts({ state: "closed", isDraft: true })), [{ code: "not_open", message: "This pull request is already closed." }]);
  assert.deepEqual(forgeMergeBlockers(null, "Merging from Wollipog supports GitHub pull requests only; merge this merge request on GitLab."),
    [{ code: "unavailable", message: "Merging from Wollipog supports GitHub pull requests only; merge this merge request on GitLab." }]);
  const unread = pullRequestMergeReadiness(undefined, allowed);
  assert.equal(unread.ready, false);
  assert.equal(unread.mode, null);
  assert.equal(unread.headSha, null);
});

test("role, runner support and open Required findings come first, and unread findings fail closed", () => {
  const blocked = pullRequestMergeReadiness(facts({ viewerPermission: "read" }), {
    roleRefusal: "Merging requires an Admin or Owner role.", runnerSupported: false, requiredFindingsOpen: 2,
  });
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.code), ["role", "runner_unsupported", "required_findings", "forge_permission"]);
  assert.equal(blocked.blockers[0]!.message, "Merging requires an Admin or Owner role.");
  assert.equal(blocked.blockers[2]!.message, "Resolve the 2 open Required findings first.");
  assert.deepEqual(sessionMergeBlockers({ ...allowed, requiredFindingsOpen: 1 }),
    [{ code: "required_findings", message: "Resolve the open Required finding first." }]);
  assert.deepEqual(sessionMergeBlockers({ ...allowed, requiredFindingsOpen: null }),
    [{ code: "required_findings", message: "Open Required findings could not be read." }]);
  assert.deepEqual(sessionMergeBlockers(allowed), []);
});

test("every blocker message is one sentence in sentence case", () => {
  const all = [
    ...forgeMergeBlockers(facts({ isDraft: true, inMergeQueue: true, viewerPermission: "read", mergeStateStatus: "DIRTY",
      requiredChecks: { state: "failed", failing: ["x"], pending: [] } })),
    ...sessionMergeBlockers({ roleRefusal: "Your Viewer role is read-only.", runnerSupported: false, requiredFindingsOpen: 3 }),
  ];
  for (const blocker of all) assert.match(blocker.message, /^[A-Z][^]*\.$/u, blocker.code);
});

test("the mode follows the base's queue and is unknown when GitHub did not say", () => {
  assert.equal(pullRequestMergeMode(facts()), "enqueue");
  assert.equal(pullRequestMergeMode(facts({ mergeQueueEnabled: false })), "merge");
  assert.equal(pullRequestMergeMode(facts({ mergeQueueEnabled: null })), null);
  assert.equal(pullRequestMergeMode(null), null);
});

test("a merge request names one github.com pull request, a full head and a mode", () => {
  assert.deepEqual(parsePullRequestMergeRequest({ pullRequestUrl: "https://github.com/o/r/pull/7", headSha: HEAD, mode: "enqueue", extra: 1 }),
    { pullRequestUrl: "https://github.com/o/r/pull/7", headSha: HEAD, mode: "enqueue" });
  for (const body of [
    null, [], {},
    { pullRequestUrl: "https://gitlab.com/o/r/-/merge_requests/7", headSha: HEAD, mode: "merge" },
    { pullRequestUrl: "https://github.com/o/r/pull/7", headSha: "abc", mode: "merge" },
    { pullRequestUrl: "https://github.com/o/r/pull/7", headSha: HEAD, mode: "squash" },
  ]) {
    assert.ok("error" in parsePullRequestMergeRequest(body), JSON.stringify(body));
  }
});
