import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxView, GitStatusInfo, GitSummaryInfo, RunView, RunnerView, SessionView } from "@wollipog/protocol";
import {
  deriveChanges,
  deriveCommitAction,
  deriveDirtySummary,
  deriveGitHeadline,
  deriveGitPresentation,
  deriveHost,
  deriveRemoteFreshness,
  deriveSubagents,
  displayBaseRef,
  fixChecksPrompt,
  formatGitOperation,
  legacyLocalGitFacts,
  remoteHttpUrl,
  sourceKind,
} from "./pinned-summary.js";

const session = (over: Partial<SessionView>): SessionView =>
  ({ id: "s1", runnerId: "r1", runId: null, ...over }) as SessionView;

const status = (over: Partial<GitStatusInfo>): GitStatusInfo => ({
  branch: "agent/s1",
  files: [],
  hasChanges: false,
  ahead: 0,
  remoteUrl: null,
  ...over,
});

const summary = (over: Partial<GitSummaryInfo>): GitSummaryInfo => ({
  branch: "feature",
  ahead: 0,
  behind: 0,
  hasChanges: false,
  addedLines: 0,
  deletedLines: 0,
  remoteUrl: null,
  pr: null,
  checks: null,
  ...over,
});

const read = <T>(value: T | null, observation: number, over: Partial<{
  settled: boolean;
  busy: boolean;
  error: string | null;
  errorCode: string | null;
}> = {}) => ({
  value,
  observation,
  settled: true,
  busy: false,
  error: null,
  errorCode: null,
  ...over,
});

test("deriveHost: a box-backed runner is Remote with its ssh target", () => {
  const boxes: BoxView[] = [{ boxId: "b1", sshTarget: "misko@vps", runnerId: "r1", status: "online", lastError: null, createdAt: 0 }];
  assert.deepEqual(deriveHost(session({}), undefined, boxes), { kind: "remote", label: "Remote", detail: "misko@vps" });
});

test("deriveHost: no box → Local with the runner hostname (runnerId fallback)", () => {
  const runner = { hostname: "T14s" } as RunnerView;
  assert.deepEqual(deriveHost(session({}), runner, []), { kind: "local", label: "Local", detail: "T14s" });
  assert.deepEqual(deriveHost(session({}), undefined, []), { kind: "local", label: "Local", detail: "r1" });
});

test("legacy local Git facts stay aligned across response order, mixed versions, and session reset", () => {
  const initialSummary = summary({
    branch: "older-summary",
    hasChanges: true,
    addedLines: 12,
    deletedLines: 3,
    pr: { number: 221, title: "Keep forge facts", url: "https://example.test/221", state: "OPEN" },
  });
  assert.equal(legacyLocalGitFacts(null, initialSummary), initialSummary,
    "summary is the initial fallback before status settles");

  const freshStatus = status({ branch: "fresh-status", hasChanges: false, addedLines: 0, deletedLines: 0 });
  assert.equal(legacyLocalGitFacts(freshStatus, initialSummary), freshStatus);
  assert.deepEqual(deriveChanges(legacyLocalGitFacts(freshStatus, initialSummary)), {
    kind: "lines", added: 0, deleted: 0,
  });

  const lateSummary = summary({
    branch: "late-but-stale",
    hasChanges: true,
    addedLines: 50,
    deletedLines: 25,
  });
  assert.equal(legacyLocalGitFacts(freshStatus, lateSummary), freshStatus,
    "a later summary completion cannot replace the status sample");

  const legacyStatus = status({ branch: "pre-numstat", hasChanges: true, files: [{ status: "M", path: "src/app.ts" }] });
  assert.deepEqual(deriveChanges(legacyLocalGitFacts(legacyStatus, lateSummary), legacyStatus.files.length), {
    kind: "files", count: 1,
  }, "a pre-numstat status still owns local facts on an older runner");
  assert.equal(legacyLocalGitFacts(null, lateSummary), lateSummary,
    "clearing status for a session change restores summary-only fallback");
});

test("deriveChanges: line totals when meaningful", () => {
  assert.equal(deriveChanges(null), null);
  assert.deepEqual(deriveChanges(status({ hasChanges: true, addedLines: 12, deletedLines: 3 })), {
    kind: "lines",
    added: 12,
    deleted: 3,
  });
  assert.deepEqual(
    deriveChanges(status({ hasChanges: false, addedLines: 0, deletedLines: 0 })),
    { kind: "lines", added: 0, deleted: 0 },
    "clean tree with totals",
  );
  assert.deepEqual(
    deriveChanges(status({ hasChanges: false })),
    { kind: "lines", added: 0, deleted: 0 },
    "clean tree without totals (pre-v20) — 0/0 is still truthful",
  );
});

test("deriveChanges: dirty trees the numstat can't count fall back to the file count", () => {
  // Pre-v20 runner: dirty but no line totals at all.
  assert.deepEqual(deriveChanges(status({ hasChanges: true }), 4), { kind: "files", count: 4 });
  // Untracked-only / binary / mode-only changes: totals exist but are 0/0 despite changes.
  assert.deepEqual(deriveChanges(status({ hasChanges: true, addedLines: 0, deletedLines: 0 }), 2), {
    kind: "files",
    count: 2,
  });
  // No file count available (summary-only caller) — the row still shows, just unquantified.
  assert.deepEqual(deriveChanges(status({ hasChanges: true, addedLines: 0, deletedLines: 0 })), {
    kind: "files",
    count: null,
  });
});

test("deriveCommitAction: dirty → commit_or_push, clean+ahead → push, clean → up_to_date", () => {
  assert.equal(deriveCommitAction(null), null);
  assert.equal(deriveCommitAction(status({ hasChanges: true, ahead: 2 })), "commit_or_push");
  assert.equal(deriveCommitAction(status({ hasChanges: false, ahead: 2 })), "push");
  assert.equal(deriveCommitAction(status({ hasChanges: false, ahead: 0 })), "up_to_date");
});

test("deriveSubagents: siblings of the run, minus self, minus vanished sessions", () => {
  const runs = new Map<string, RunView>([
    ["run1", { id: "run1", sessionIds: ["s1", "s2", "s3"] } as RunView],
  ]);
  const sessions = new Map<string, SessionView>([
    ["s1", session({ id: "s1", runId: "run1" })],
    ["s2", session({ id: "s2", runId: "run1" })],
    // s3 deleted — must be skipped, not undefined
  ]);
  const subs = deriveSubagents(sessions.get("s1")!, runs, sessions);
  assert.deepEqual(subs.map((s) => s.id), ["s2"]);
  assert.deepEqual(deriveSubagents(session({ runId: null }), runs, sessions), [], "no run → no section");
  assert.deepEqual(deriveSubagents(session({ runId: "gone" }), runs, sessions), [], "unknown run id");
});

test("fixChecksPrompt: singular/plural + names woven in", () => {
  const one = fixChecksPrompt({ failing: 1, pending: 0, passing: 3, failingNames: ["test"], url: null });
  assert.match(one, /1 failing check \(test\)\./);
  assert.match(one, /Investigate the failure,/);
  const many = fixChecksPrompt({ failing: 3, pending: 1, passing: 0, failingNames: ["a", "b"], url: null });
  assert.match(many, /3 failing checks \(a, b\)\./);
  const nameless = fixChecksPrompt({ failing: 2, pending: 0, passing: 0, failingNames: [], url: null });
  assert.match(nameless, /2 failing checks\. /);
});

test("sourceKind: github means the HOST is exactly github.com", () => {
  assert.equal(sourceKind("git@github.com:o/r.git"), "github");
  assert.equal(sourceKind("https://github.com/o/r"), "github");
  assert.equal(sourceKind("https://gitlab.com/o/r.git"), "git");
  assert.equal(sourceKind(null), null);
  assert.equal(sourceKind(undefined), null);
  // Lookalike hosts must not get the GitHub badge.
  assert.equal(sourceKind("https://notgithub.com/o/r"), "git");
  assert.equal(sourceKind("git@mygithub.com:o/r.git"), "git");
  assert.equal(sourceKind("https://github.com.evil.example/o/r"), "git");
});

test("remoteHttpUrl: https passes through with .git stripped; scp-ssh converts; junk is null", () => {
  assert.equal(remoteHttpUrl("https://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(remoteHttpUrl("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(remoteHttpUrl("ssh://git@github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(remoteHttpUrl(null), null);
  assert.equal(remoteHttpUrl("file:///mnt/repos/r"), null);
  assert.equal(remoteHttpUrl("../relative/path"), null);
});

test("v76 Git presentation keeps upstream sync distinct from default-base divergence", () => {
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: "C:/repo/.agent-worktrees/session-a",
    status: read(status({
      branch: "feature/very-long-worktree-name",
      headSha: "abcdef123456",
      detached: false,
      upstreamBranch: "origin/feature/very-long-worktree-name",
      aheadUpstream: 0,
      behindUpstream: 0,
      baseRef: "origin/main",
      worktreeKind: "linked",
      stagedCount: 1,
      modifiedCount: 1,
      untrackedCount: 2,
      conflictedCount: 1,
      hasChanges: true,
      operation: "rebase",
      remoteRefsAt: 1_700_000_000_000,
    }), 2),
    summary: read(summary({
      branch: "feature/very-long-worktree-name",
      headSha: "abcdef123456",
      upstreamBranch: "origin/feature/very-long-worktree-name",
      aheadUpstream: 0,
      behindUpstream: 0,
      baseRef: "origin/main",
      worktreeKind: "linked",
      behind: 231,
      hasChanges: true,
      operation: "rebase",
      remoteRefsAt: 1_700_000_000_000,
    }), 3),
  });

  assert.equal(model.branchLabel, "feature/very-long-worktree-name");
  assert.equal(model.headSha, "abcdef123456");
  assert.deepEqual(model.upstream.map((row) => row.label), ["Upstream Synced"]);
  assert.deepEqual(model.base.map((row) => [row.label, row.detail]), [["Behind Main", "231"]]);
  assert.equal(model.worktree.label, "Linked Worktree");
  assert.equal(model.operation?.label, "Rebase in Progress");
  assert.equal(model.remoteFreshness.detail, "Remote Refs Updated 2023-11-14 22:13 UTC");
  const rowText = [...model.upstream, ...model.base]
    .map((row) => (row.detail ? `${row.label} ${row.detail}` : row.label))
    .join(" ");
  assert.doesNotMatch(rowText, /Up to Date/i);
});

test("status owns overlapping local facts and mismatched summary base is not paired", () => {
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({
      branch: "new-status",
      headSha: "222222222222",
      baseRef: "origin/trunk",
      worktreeKind: "primary",
    }), 9),
    summary: read(summary({
      branch: "old-summary",
      headSha: "111111111111",
      baseRef: "origin/main",
      behind: 400,
      worktreeKind: "primary",
    }), 10),
  });
  assert.equal(model.branchLabel, "new-status");
  assert.equal(model.headSha, "222222222222");
  assert.equal(model.behindBase, null);
  assert.deepEqual(model.base.map((row) => row.label), ["Trunk Comparison Unavailable"]);
  assert.equal(model.worktree.label, "Primary Checkout");
});

test("known ahead facts remain distinct when only the behind-base comparison is unavailable", () => {
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ baseRef: "origin/main", ahead: 3, worktreeKind: "primary" }), 1),
    summary: read(null, 0, { settled: false }),
  });
  assert.deepEqual(model.base.map((row) => [row.label, row.detail]), [
    ["Ahead of Main", "3"],
    ["Behind Main Unavailable", null],
  ]);
});

test("detached, rolling-skew, dirty overlaps, operation, and custom base copy remain explicit", () => {
  assert.deepEqual(deriveDirtySummary({
    hasChanges: true,
    stagedCount: 2,
    modifiedCount: 2,
    untrackedCount: 1,
    conflictedCount: 1,
  }), {
    label: "Dirty",
    detail: "1 Conflicted \u00b7 2 Staged \u00b7 2 Modified \u00b7 1 Untracked",
    tone: "warning",
  });
  assert.equal(displayBaseRef("refs/remotes/upstream/release/2026"), "upstream/release/2026");
  assert.equal(formatGitOperation("cherry_pick"), "Cherry-Pick in Progress");

  const detached = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ branch: "HEAD", detached: true, headSha: "abc123abc123", worktreeKind: "primary" }), 1),
    summary: read(null, 0, { settled: false }),
  });
  assert.equal(detached.branchLabel, "Detached");
  assert.deepEqual(detached.upstream.map((row) => row.label), ["Upstream Details Unavailable"]);
  assert.deepEqual(detached.base.map((row) => row.label), ["Base Comparison Unavailable"]);
});

test("Git availability states are explicit and preserve confirmed facts while updating or failed", () => {
  const empty = read<GitStatusInfo>(null, 0, { settled: false });
  const noSummary = read<GitSummaryInfo>(null, 0, { settled: false });
  assert.equal(deriveGitPresentation({
    runnerOnline: false,
    worktreePath: null,
    status: empty,
    summary: noSummary,
  }).stateDetail, "Git Unavailable While Disconnected");
  assert.equal(deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(null, 0, { error: "not a git repository" }),
    summary: read(null, 0),
  }).state, "not_repository");
  const codedDisappearance = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ branch: "gone" }), 1, {
      error: "the session's worktree is gone — it resolved to a different repository",
      errorCode: "GIT_NO_REPOSITORY",
    }),
    summary: noSummary,
  });
  assert.equal(codedDisappearance.state, "not_repository");
  assert.equal(codedDisappearance.stateDetail, "Not a Git Repository");
  assert.deepEqual(deriveGitHeadline(codedDisappearance), [], "a disappeared repository leaks no confirmed facts");
  const linkedDisappearance = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: "/repo/wt",
    status: read(status({ branch: "gone" }), 1, {
      error: "the session's worktree is gone — it resolved to a different repository",
    }),
    summary: noSummary,
  });
  assert.equal(linkedDisappearance.state, "not_repository");
  assert.equal(linkedDisappearance.stateDetail, "Not a Git Repository");
  assert.deepEqual(deriveGitHeadline(linkedDisappearance), [], "a gone worktree leaks no confirmed facts");
  assert.equal(deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ branch: "confirmed" }), 1, { error: "not a git repository" }),
    summary: noSummary,
  }).state, "not_repository");
  const disappeared = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ branch: "confirmed" }), 1, { error: "not a git repository" }),
    summary: noSummary,
  });
  assert.equal(disappeared.stateDetail, "Not a Git Repository");
  assert.deepEqual(deriveGitHeadline(disappeared), []);
  assert.equal(deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ branch: "confirmed" }), 1, { busy: true }),
    summary: noSummary,
  }).state, "updating");
  assert.equal(deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ branch: "confirmed" }), 1, { error: "transport failed" }),
    summary: noSummary,
  }).stateDetail, "Refresh Failed");
});

test("remote-ref freshness never claims a fetch and has truthful null semantics", () => {
  assert.deepEqual(deriveRemoteFreshness(null), {
    label: "Remote Status May Be Stale",
    detail: "Remote Ref Freshness Unavailable",
  });
  assert.equal(deriveRemoteFreshness(50).detail, "Remote Refs Updated 1970-01-01 00:00 UTC");
  assert.equal(deriveRemoteFreshness(9e15).detail, "Remote Ref Freshness Unavailable");
  assert.doesNotMatch(deriveRemoteFreshness(50).detail, /Fetched|Just Now|Ago/i);
});

test("deriveGitHeadline: collapsed facts compact to branch, identity, dirty, and one divergence", () => {
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: "C:/repo/.agent-worktrees/session-a",
    status: read(status({
      branch: "feature/deep-work",
      headSha: "abcdef123456",
      detached: false,
      upstreamBranch: "origin/feature/deep-work",
      aheadUpstream: 0,
      behindUpstream: 0,
      baseRef: "origin/main",
      worktreeKind: "linked",
      stagedCount: 0,
      modifiedCount: 2,
      untrackedCount: 0,
      conflictedCount: 0,
      hasChanges: true,
      ahead: 7,
      operation: null,
      remoteRefsAt: 1_700_000_000_000,
    }), 2),
    summary: read(summary({
      branch: "feature/deep-work",
      baseRef: "origin/main",
      ahead: 7,
      behind: 18,
      hasChanges: true,
    }), 1),
  });
  const segments = deriveGitHeadline(model);
  assert.deepEqual(segments.map((segment) => segment.text), [
    "feature/deep-work",
    "Linked Worktree",
    "Dirty",
    "Main +7 / -18",
  ]);
  const divergence = segments.at(-1)!;
  assert.equal(divergence.tone, "warning");
  assert.equal(divergence.expandedLabel, "Ahead of Main 7 · Behind Main 18");
  assert.equal(segments.find((segment) => segment.text === "Dirty")?.tone, "warning");
});

test("deriveGitHeadline: conflicts and operations stay visible collapsed; synced repos stay quiet", () => {
  const conflicted = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({
      branch: "main",
      headSha: "abcdef123456",
      detached: false,
      upstreamBranch: "origin/main",
      aheadUpstream: 0,
      behindUpstream: 3,
      baseRef: "origin/main",
      worktreeKind: "primary",
      stagedCount: 0,
      modifiedCount: 0,
      untrackedCount: 0,
      conflictedCount: 2,
      hasChanges: true,
      ahead: 0,
      operation: "merge",
      remoteRefsAt: null,
    }), 2),
    summary: read(null, 1),
  });
  const conflictTexts = deriveGitHeadline(conflicted).map((segment) => segment.text);
  assert.ok(conflictTexts.includes("Conflicts"));
  assert.ok(conflictTexts.includes("Merge in Progress"));
  assert.ok(conflictTexts.includes("Upstream -3"), "no base divergence → behind-upstream is the actionable warning");
  assert.equal(
    deriveGitHeadline(conflicted).find((segment) => segment.text === "Upstream -3")?.expandedLabel,
    "Behind Upstream 3",
  );

  const synced = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({
      branch: "main",
      headSha: "abcdef123456",
      detached: false,
      upstreamBranch: "origin/main",
      aheadUpstream: 0,
      behindUpstream: 0,
      baseRef: "origin/main",
      worktreeKind: "primary",
      stagedCount: 0,
      modifiedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      hasChanges: false,
      ahead: 0,
      operation: null,
      remoteRefsAt: null,
    }), 2),
    summary: read(summary({ branch: "main", baseRef: "origin/main", ahead: 0, behind: 0 }), 1),
  });
  assert.deepEqual(deriveGitHeadline(synced).map((segment) => segment.text), [
    "main",
    "Primary Checkout",
    "Clean",
  ], "a synced clean checkout carries no divergence or warning segments");

  const offline = deriveGitPresentation({
    runnerOnline: false,
    worktreePath: null,
    status: read(status({ branch: "main" }), 1),
    summary: read(null, 0),
  });
  assert.deepEqual(deriveGitHeadline(offline), [], "hidden-fact states surface no headline");
});

test("deriveGitHeadline: without a base comparison, upstream divergence shows both directions", () => {
  const upstreamOnly = (aheadUpstream: number, behindUpstream: number) => deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({
      branch: "feature/no-base",
      headSha: "abcdef123456",
      detached: false,
      upstreamBranch: "origin/feature/no-base",
      aheadUpstream,
      behindUpstream,
      baseRef: null,
      worktreeKind: "primary",
      stagedCount: 0,
      modifiedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      hasChanges: false,
      ahead: aheadUpstream,
      operation: null,
      remoteRefsAt: null,
    }), 1),
    summary: read(null, 0, { settled: false }),
  });

  // Unpushed commits must not vanish from the collapsed summary (regression coverage).
  const aheadOnly = deriveGitHeadline(upstreamOnly(2, 0)).at(-1)!;
  assert.equal(aheadOnly.text, "Upstream +2");
  assert.equal(aheadOnly.tone, "normal");
  assert.equal(aheadOnly.expandedLabel, "Ahead of Upstream 2");

  const bidirectional = deriveGitHeadline(upstreamOnly(2, 3)).at(-1)!;
  assert.equal(bidirectional.text, "Upstream +2 / -3");
  assert.equal(bidirectional.tone, "warning");
  assert.equal(bidirectional.expandedLabel, "Ahead of Upstream 2 · Behind Upstream 3");

  const synced = deriveGitHeadline(upstreamOnly(0, 0));
  assert.ok(!synced.some((segment) => segment.text.startsWith("Upstream")),
    "a synced upstream adds no divergence segment");
});

test("deriveGitHeadline: rolling-skew facts without aheadUpstream fall back to the legacy ahead", () => {
  // A rolling-skew producer can report baseRef: null while omitting the upstream counts;
  // the legacy non-null `ahead` then carries the upstream comparison (legacy contract) and
  // unpushed commits must still surface in the collapsed headline (regression coverage).
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({
      branch: "feature/skew",
      headSha: "abcdef123456",
      detached: false,
      baseRef: null,
      worktreeKind: "primary",
      hasChanges: false,
      ahead: 2,
    }), 1),
    summary: read(null, 0, { settled: false }),
  });
  const divergence = deriveGitHeadline(model).at(-1)!;
  assert.equal(divergence.text, "Upstream +2");
  assert.equal(divergence.tone, "normal");
  assert.equal(divergence.expandedLabel, "Ahead of Upstream 2");
});

test("deriveGitHeadline: pre-v76 omission of baseRef never mislabels base divergence as upstream", () => {
  // A pre-v76 producer omits both baseRef and the upstream counts while its legacy `ahead`
  // is relative to the resolved default base. That must not surface as "Upstream +2" —
  // the comparison target is unknown, so no divergence segment renders (regression coverage).
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({
      branch: "feature/legacy",
      hasChanges: false,
      ahead: 2,
    }), 1),
    summary: read(null, 0, { settled: false }),
  });
  assert.ok(!deriveGitHeadline(model).some((segment) => segment.text.startsWith("Upstream")),
    "omitted baseRef (pre-v76) must not produce an upstream divergence segment");
});
