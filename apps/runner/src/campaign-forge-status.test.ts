/**
 * Campaign forge status on the runner (#2417 slice 8): one GraphQL read per batch through `gh`,
 * validated into status data, with every failure reduced to a fixed reason. `gh` is stubbed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPAIGN_FORGE_OBSERVATION, type CampaignForgePullRequestObservation, type CampaignPullRequestRef } from "@wollipog/protocol";
import {
  checkRollups,
  classifyGhFailure,
  forgeStatusQuery,
  githubRepository,
  observeForgeStatus,
  type GhOutcome,
  type GhRunner,
} from "./campaign-forge-status.js";

const HEAD = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
const MERGE = "dd08b41b0000000000000000000000000000beef";

function check(name: string, conclusion: string | null, isRequired: boolean, status = conclusion ? "COMPLETED" : "IN_PROGRESS") {
  return { __typename: "CheckRun", name, status, conclusion, isRequired };
}

function pr(overrides: Record<string, unknown> = {}, contexts: unknown[] = [check("Typecheck, Test & Sidecar Bundle", "SUCCESS", true)], rollupState = "SUCCESS", hasNextPage = false) {
  return {
    state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main", reviewDecision: null, mergeStateStatus: "CLEAN",
    mergeCommit: null, mergeQueueEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: rollupState, contexts: { pageInfo: { hasNextPage }, nodes: contexts } } } }] },
    ...overrides,
  };
}

/** A `gh` stub that records each call and answers with one fixed outcome. */
function stub(outcome: Partial<GhOutcome>): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    return { stdout: "", stderr: "", code: null, timedOut: false, ...outcome };
  }) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const answer = (data: Record<string, unknown>, errors?: unknown[]) =>
  ({ stdout: JSON.stringify({ data, ...(errors ? { errors } : {}) }), code: errors ? 1 : null });

const REF: CampaignPullRequestRef = { repository: "picoduck/wollipog", number: 2462 };

test("a merge-queue wait reads open, queued with its position, required checks passing, and no review decision", async () => {
  const gh = stub(answer({ r0: { pullRequest: pr({ mergeQueueEntry: { position: 2, state: "AWAITING_CHECKS" } }, [
    check("Typecheck, Unit Tests & Bundles", "SUCCESS", false),
    check("Browser End-to-End Tests (1)", null, false),
    check("Typecheck, Test & Sidecar Bundle", "SUCCESS", true),
  ], "PENDING") } }));
  const outcome = await observeForgeStatus([REF], gh);
  assert.deepEqual(outcome, {
    ok: true,
    results: [{
      ref: REF,
      ok: true,
      observation: {
        state: "open", draft: false, headSha: HEAD, baseRef: "main", reviewDecision: "none",
        checks: { state: "pending", passing: 2, failing: 0, pending: 1 },
        requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
        mergeQueue: { state: "awaiting_checks", position: 2 },
        mergeCommitSha: null,
      },
    }],
  });
  assert.equal(gh.calls.length, 1, "one gh call reads the whole batch");
  assert.deepEqual(gh.calls[0]!.slice(0, 5), ["api", "graphql", "--hostname", "github.com", "-f"],
    "always github.com, whatever GH_HOST says");
});

test("no required check reported is `none`, never passing, and a truncated page leaves required checks unknown", async () => {
  const none = checkRollups({ state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [check("Lint", "SUCCESS", false)] } })!;
  assert.equal(none.requiredChecks.state, "none");
  assert.equal(none.checks.state, "passing");
  const truncated = checkRollups({ state: "SUCCESS", contexts: { pageInfo: { hasNextPage: true }, nodes: [check("Required", "SUCCESS", true)] } })!;
  assert.equal(truncated.requiredChecks.state, "unknown", "an unseen required check could be failing");
  assert.equal(truncated.checks.state, "passing", "GitHub's own rollup covers every check");
  const failingRequired = checkRollups({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: true }, nodes: [check("Required", "FAILURE", true)] } })!;
  assert.equal(failingRequired.requiredChecks.state, "failing", "a seen failure is a failure even on a truncated page");
  const strange = checkRollups({ state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [check("Required", "STARTUP_FAILURE", true)] } })!;
  assert.equal(strange.requiredChecks.state, "failing", "an unrecognized conclusion fails closed");
  assert.equal(strange.checks.state, "failing");
  const empty = checkRollups(null)!;
  assert.deepEqual([empty.checks.state, empty.requiredChecks.state], ["none", "none"]);
  const statusContext = checkRollups({ state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "StatusContext", context: "ci", state: "PENDING", isRequired: true }] } })!;
  assert.equal(statusContext.requiredChecks.state, "pending");
});

/** A check run as the campaign query reads it, with its creation-ordered id (#4263). */
function run(name: string, conclusion: string | null, isRequired: boolean, databaseId: number, startedAt: string) {
  return { ...check(name, conclusion, isRequired), databaseId, startedAt };
}

test("a cancelled run superseded by a newer passing run reads passing and raises no failure (#4263)", async () => {
  // PR #4231 replaced the closed #4228 on the same head: #4228's run was cancelled, #4231's passed.
  // GitHub's own rollup state still counts the cancelled run.
  const contexts = [
    run("Typecheck, Test & Sidecar Bundle", "CANCELLED", true, 127339808509, "2026-11-05T15:24:47Z"),
    run("Unit Tests (1)", "CANCELLED", false, 127338879088, "2026-11-05T15:23:14Z"),
    run("Unit Tests (1)", "SUCCESS", false, 127367279079, "2026-11-05T16:14:33Z"),
    run("Typecheck, Test & Sidecar Bundle", "SUCCESS", true, 127374358123, "2026-11-05T16:27:37Z"),
  ];
  const outcome = await observeForgeStatus([REF], stub(answer({ r0: { pullRequest: pr({ mergeQueueEntry: { position: 0, state: "AWAITING_CHECKS" } }, contexts, "FAILURE") } })));
  assert.ok(outcome.ok && outcome.results[0]!.ok);
  const observation = outcome.results[0]!.observation as CampaignForgePullRequestObservation;
  assert.deepEqual(observation.checks, { state: "passing", passing: 2, failing: 0, pending: 0 });
  assert.deepEqual(observation.requiredChecks, { state: "passing", passing: 1, failing: 0, pending: 0 });
});

test("a check whose most recent run failed or was cancelled still reads failing (#4263)", () => {
  const nodes = [
    run("Typecheck, Test & Sidecar Bundle", "SUCCESS", true, 100, "2026-11-05T15:00:00Z"),
    run("Typecheck, Test & Sidecar Bundle", "CANCELLED", true, 200, "2026-11-05T16:00:00Z"),
    run("Lint", "FAILURE", false, 150, "2026-11-05T15:30:00Z"),
  ];
  const rollups = checkRollups({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes } }, true)!;
  assert.deepEqual(rollups.checks, { state: "failing", passing: 0, failing: 2, pending: 0 });
  assert.deepEqual(rollups.requiredChecks, { state: "failing", passing: 0, failing: 1, pending: 0 });
  // The check run id is creation order: an earlier start time does not make a re-run older.
  const rerun = checkRollups({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    run("Lint", "SUCCESS", true, 100, "2026-11-05T16:00:00Z"),
    run("Lint", "FAILURE", true, 200, "2026-11-05T15:59:00Z"),
  ] } }, true)!;
  assert.equal(rerun.requiredChecks.state, "failing");
  assert.equal(rerun.checks.state, "failing");
});

test("check runs and status contexts each keep only their latest entry per check (#4263)", () => {
  const nodes = [
    { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", createdAt: "2026-11-05T15:00:00Z", isRequired: true },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", createdAt: "2026-11-05T16:00:00Z", isRequired: true },
    run("ci/legacy", "CANCELLED", false, 100, "2026-11-05T15:00:00Z"),
    run("ci/legacy", "SUCCESS", false, 200, "2026-11-05T16:00:00Z"),
    run("Unit", "SUCCESS", false, 300, "2026-11-05T16:00:00Z"),
  ];
  const rollups = checkRollups({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes } }, true)!;
  assert.deepEqual(rollups.checks, { state: "passing", passing: 3, failing: 0, pending: 0 });
  assert.deepEqual(rollups.requiredChecks, { state: "passing", passing: 1, failing: 0, pending: 0 });
  // A newer failing status context still fails beside a passing check run of the same name.
  const failing = checkRollups({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", createdAt: "2026-11-05T15:00:00Z", isRequired: true },
    { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", createdAt: "2026-11-05T16:00:00Z", isRequired: true },
    run("ci/legacy", "SUCCESS", false, 200, "2026-11-05T16:00:00Z"),
  ] } }, true)!;
  assert.deepEqual(failing.checks, { state: "failing", passing: 1, failing: 1, pending: 0 });
  assert.equal(failing.requiredChecks.state, "failing");
});

test("past a truncated page, GitHub's failing rollup still reads failing: an unseen check could be failing (#4263)", () => {
  const nodes = [
    run("Lint", "CANCELLED", false, 100, "2026-11-05T15:00:00Z"),
    run("Lint", "SUCCESS", false, 200, "2026-11-05T16:00:00Z"),
  ];
  const truncated = checkRollups({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: true }, nodes } })!;
  assert.deepEqual(truncated.checks, { state: "failing", passing: 1, failing: 0, pending: 0 });
  const complete = checkRollups({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes } })!;
  assert.equal(complete.checks.state, "passing");
  // GitHub's pending states are still honored on a complete page.
  const expected = checkRollups({ state: "EXPECTED", contexts: { pageInfo: { hasNextPage: false }, nodes } })!;
  assert.equal(expected.checks.state, "pending");
});

test("the query reads what orders a check's runs (#4263)", () => {
  const query = forgeStatusQuery([{ owner: "picoduck", name: "wollipog", number: 7 }]);
  assert.match(query, /\.\.\. on CheckRun\{databaseId name status conclusion startedAt isRequired\(pullRequestNumber:7\)\}/u);
  assert.match(query, /\.\.\. on StatusContext\{context state createdAt isRequired\(pullRequestNumber:7\)\}/u);
});

test("a merged pull request carries its merge commit, approval, and draft and closed states map exactly", async () => {
  const gh = stub(answer({
    r0: { pullRequest: pr({ state: "MERGED", reviewDecision: "APPROVED", mergeCommit: { oid: MERGE } }) },
    r1: { pullRequest: pr({ isDraft: true, reviewDecision: "REVIEW_REQUIRED" }) },
    r2: { pullRequest: pr({ state: "CLOSED", reviewDecision: "CHANGES_REQUESTED", mergeQueueEntry: { position: null, state: "SOMETHING_NEW" } }) },
  }));
  const outcome = await observeForgeStatus([REF, { ...REF, number: 1 }, { ...REF, number: 2 }], gh);
  assert.ok(outcome.ok);
  const values = outcome.results.map((result) => result.ok ? result.observation as CampaignForgePullRequestObservation : null);
  assert.deepEqual([values[0]?.state, values[0]?.reviewDecision, values[0]?.mergeCommitSha], ["merged", "approved", MERGE]);
  assert.deepEqual([values[1]?.draft, values[1]?.reviewDecision], [true, "review_required"]);
  assert.deepEqual([values[2]?.state, values[2]?.reviewDecision, values[2]?.mergeQueue], ["closed", "changes_requested", { state: "unknown", position: null }]);
});

test("per pull request: not found or forbidden is forge_not_found, a malformed node is forge_error", async () => {
  const gh = stub(answer({
    r0: { pullRequest: null },
    r1: null,
    r2: { pullRequest: pr({ headRefOid: "not-a-sha" }) },
    r3: { pullRequest: pr() },
  }, [
    { type: "NOT_FOUND", path: ["r0", "pullRequest"], message: "Could not resolve to a PullRequest" },
    { type: "FORBIDDEN", path: ["r1"], message: "Resource not accessible" },
  ]));
  const refs = [1, 2, 3, 4].map((number) => ({ ...REF, number }));
  const outcome = await observeForgeStatus(refs, gh);
  assert.ok(outcome.ok, "partial data is still an answer");
  assert.deepEqual(outcome.results.map((result) => result.ok ? "ok" : result.failure),
    ["forge_not_found", "forge_not_found", "forge_error", "ok"]);
});

test("whole-request failures reduce to fixed reasons and never echo gh output", async () => {
  const cases: Array<[Partial<GhOutcome>, string]> = [
    [{ code: "ENOENT", stderr: "spawn gh ENOENT" }, "forge_cli_missing"],
    [{ code: 1, stderr: "<3>WSL ERROR: execvpe(gh) failed: No such file or directory" }, "forge_cli_missing"],
    [{ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" }, "forge_unauthenticated"],
    [{ code: 1, stdout: "{\"message\":\"Bad credentials\",\"status\":\"401\"}", stderr: "gh: Bad credentials (HTTP 401)" }, "forge_unauthenticated"],
    [{ code: 1, stderr: "Post \"https://api.github.com/graphql\": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused" }, "forge_unreachable"],
    [{ code: 1, stderr: "error connecting to api.github.com\ncheck your internet connection" }, "forge_unreachable"],
    [{ code: "ETIMEDOUT", timedOut: true, stderr: "" }, "forge_unreachable"],
    [{ code: 1, stdout: "{\"message\":\"API rate limit exceeded for user ID 1.\"}", stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)" }, "forge_rate_limited"],
    [{ code: 1, stderr: "gh: Something unexpected (HTTP 502)" }, "forge_error"],
    [{ code: null, stdout: "not json" }, "forge_error"],
  ];
  for (const [outcome, reason] of cases) {
    assert.deepEqual(await observeForgeStatus([REF], stub(outcome)), { ok: false, failure: reason }, JSON.stringify(outcome));
  }
  assert.deepEqual(await observeForgeStatus([REF], stub(answer({ r0: null }, [{ type: "RATE_LIMITED", path: ["r0"] }]))),
    { ok: false, failure: "forge_rate_limited" });
  assert.equal(classifyGhFailure({ code: 1, stderr: "gh: Could not resolve to a Repository with the name 'x/y'.", timedOut: false }), "forge_error",
    "a GraphQL not-found is not mistaken for a DNS failure");
});

test("a repository that is not a GitHub owner/name is unsupported and never reaches gh or the query", async () => {
  for (const repository of ["picoduck", "a/b/c", "bad owner/x", "-lead/x", "o/..", "o\"){x}/y", "gitlab.com/o/r"]) {
    assert.equal(githubRepository({ repository, number: 1 }), null, repository);
  }
  assert.equal(githubRepository({ repository: "picoduck/wollipog", number: 0 }), null);
  const gh = stub(answer({ r0: { pullRequest: pr() } }));
  const outcome = await observeForgeStatus([{ repository: "o\"){x}/y", number: 1 }, REF], gh);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.results.map((result) => result.ok ? "ok" : result.failure), ["forge_unsupported", "ok"]);
  assert.equal(gh.calls.length, 1);
  assert.ok(!gh.calls[0]!.join(" ").includes("{x}"));
  const none = stub(answer({}));
  assert.deepEqual((await observeForgeStatus([{ repository: "nope", number: 1 }], none)), {
    ok: true, results: [{ ref: { repository: "nope", number: 1 }, ok: false, failure: "forge_unsupported" }],
  });
  assert.equal(none.calls.length, 0, "nothing readable, nothing run");
});

test("the batch is bounded and the query inlines only validated values", async () => {
  const tooMany = Array.from({ length: CAMPAIGN_FORGE_OBSERVATION.refsPerRequest + 1 }, (_, index) => ({ ...REF, number: index + 1 }));
  const gh = stub(answer({}));
  assert.deepEqual(await observeForgeStatus(tooMany, gh), { ok: false, failure: "forge_error" });
  assert.equal(gh.calls.length, 0);
  const query = forgeStatusQuery([{ owner: "picoduck", name: "wollipog", number: 7 }]);
  assert.match(query, /r0: repository\(owner:"picoduck",name:"wollipog"\)/u);
  assert.match(query, /isRequired\(pullRequestNumber:7\)/u);
  assert.match(query, /mergeQueueEntry\{position state\}/u);
  assert.match(query, /defaultBranchRef\{name\}/u);
});

test("an observation carries the repository's default branch when GitHub reports a usable one (#4070)", async () => {
  const read = async (repository: Record<string, unknown>) => {
    const outcome = await observeForgeStatus([REF], stub(answer({ r0: { ...repository, pullRequest: pr({ state: "MERGED", mergeCommit: { oid: MERGE } }) } })));
    assert.ok(outcome.ok && outcome.results[0]!.ok);
    return outcome.results[0]!.ok ? outcome.results[0]!.observation as CampaignForgePullRequestObservation : null;
  };
  assert.equal((await read({ defaultBranchRef: { name: "main" } }))?.defaultBranch, "main");
  for (const repository of [{}, { defaultBranchRef: null }, { defaultBranchRef: { name: "" } }, { defaultBranchRef: { name: 7 } }]) {
    const observation = await read(repository);
    assert.ok(observation, "a missing default branch never fails the observation");
    assert.equal("defaultBranch" in observation, false);
  }
});

test("an observation carries its own repository's head branch and tip, null once deleted (#4067)", async () => {
  assert.match(forgeStatusQuery([{ owner: "picoduck", name: "wollipog", number: 7 }]), /headRefName isCrossRepository headRef\{target\{oid\}\}/u);
  const read = async (fields: Record<string, unknown>) => {
    const outcome = await observeForgeStatus([REF], stub(answer({ r0: { pullRequest: pr({ state: "MERGED", mergeCommit: { oid: MERGE }, ...fields }) } })));
    assert.ok(outcome.ok && outcome.results[0]!.ok);
    return outcome.results[0]!.ok ? outcome.results[0]!.observation as CampaignForgePullRequestObservation : null;
  };
  const tip = "e".repeat(40);
  assert.deepEqual((await read({ headRefName: "agent/s_1", isCrossRepository: false, headRef: { target: { oid: tip } } }))?.headBranch,
    { name: "agent/s_1", tipSha: tip });
  assert.deepEqual((await read({ headRefName: "agent/s_1", isCrossRepository: false, headRef: null }))?.headBranch,
    { name: "agent/s_1", tipSha: null });
  // Any branch name Git accepts is reported, so its cleanup is tracked.
  for (const name of ["feature/foo+bar", "fix/issue#4067"]) {
    assert.deepEqual((await read({ headRefName: name, isCrossRepository: false, headRef: { target: { oid: tip } } }))?.headBranch,
      { name, tipSha: tip }, name);
  }
  for (const fields of [{}, { headRefName: "agent/s_1", isCrossRepository: true, headRef: null },
    { headRefName: "-x", isCrossRepository: false, headRef: null }, { headRefName: "agent/s_1", isCrossRepository: false, headRef: { target: {} } }]) {
    const observation = await read(fields);
    assert.ok(observation, "an untracked head branch never fails the observation");
    assert.equal("headBranch" in observation, false, JSON.stringify(fields));
    // Whether it is a fork is reported on its own, so an unusable same-repository name stays owed.
    assert.equal(observation.crossRepository, "isCrossRepository" in fields ? fields.isCrossRepository : undefined, JSON.stringify(fields));
  }
});

test("required checks read passing only when GitHub's merge state confirms none is still missing", async () => {
  // The repository requires a check that has not reported yet: it has no node, and only the seen
  // required check passed. GitHub reports the pull request BLOCKED.
  const seen = [check("Lint", "SUCCESS", true), check("Unit", "SUCCESS", false)];
  for (const [mergeStateStatus, expected] of [
    ["BLOCKED", "unknown"], ["UNKNOWN", "unknown"], ["BEHIND", "unknown"], ["DRAFT", "unknown"], ["DIRTY", "unknown"],
    [undefined, "unknown"], ["CLEAN", "passing"], ["HAS_HOOKS", "passing"], ["UNSTABLE", "passing"],
  ] as const) {
    const outcome = await observeForgeStatus([REF], stub(answer({ r0: { pullRequest: pr({ mergeStateStatus }, seen) } })));
    assert.ok(outcome.ok && outcome.results[0]!.ok);
    assert.equal(outcome.results[0]!.ok && (outcome.results[0]!.observation as CampaignForgePullRequestObservation).requiredChecks.state, expected, String(mergeStateStatus));
  }
  // A seen failure, a pending check, or no required check at all are reported as they are.
  const failing = await observeForgeStatus([REF], stub(answer({ r0: { pullRequest: pr({ mergeStateStatus: "BLOCKED" }, [check("Lint", "FAILURE", true)], "FAILURE") } })));
  assert.equal(failing.ok && failing.results[0]!.ok && (failing.results[0]!.observation as CampaignForgePullRequestObservation).requiredChecks.state, "failing");
  const pending = await observeForgeStatus([REF], stub(answer({ r0: { pullRequest: pr({ mergeStateStatus: "BLOCKED" }, [check("Lint", null, true)], "PENDING") } })));
  assert.equal(pending.ok && pending.results[0]!.ok && (pending.results[0]!.observation as CampaignForgePullRequestObservation).requiredChecks.state, "pending");
  const none = await observeForgeStatus([REF], stub(answer({ r0: { pullRequest: pr({ mergeStateStatus: "BLOCKED" }, [check("Unit", "SUCCESS", false)]) } })));
  assert.equal(none.ok && none.results[0]!.ok && (none.results[0]!.observation as CampaignForgePullRequestObservation).requiredChecks.state, "none");
});

test("gh runs with the Orchestrator's agent environment, so its configured login is the one used", { skip: process.platform === "win32" }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { contextGhRunner } = await import("./campaign-forge-status.js");
  const dir = mkdtempSync(join(tmpdir(), "forge-gh-"));
  try {
    // A fake gh that reports which login settings reached it.
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf '%s|%s|%s' \"$GH_TOKEN\" \"$GH_CONFIG_DIR\" \"$GH_PROMPT_DISABLED\"\n");
    chmodSync(join(dir, "gh"), 0o755);
    const run = contextGhRunner({ kind: "native" }, dir, {
      PATH: [dir, process.env.PATH ?? ""].join(":"), GH_TOKEN: "agent-token", GH_CONFIG_DIR: "/agent/gh", GH_PROMPT_DISABLED: "0",
    });
    const outcome = await run(["api", "graphql"]);
    assert.equal(outcome.code, null);
    assert.equal(outcome.stdout, "agent-token|/agent/gh|1", "the agent's login reaches gh; prompts stay disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
