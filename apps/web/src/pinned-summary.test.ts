import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxView, GitStatusInfo, GitSummaryInfo, RunView, RunnerView, SessionView } from "@wollipog/protocol";
import {
  deriveChanges,
  deriveCommitAction,
  deriveDirtySummary,
  deriveGitPresentation,
  deriveHost,
  formatRemoteRefsAt,
  deriveSubagents,
  displayBaseRef,
  fixChecksPrompt,
  formatGitOperation,
  legacyLocalGitFacts,
  remoteHttpUrl,
  sourceKind,
  visibleForgeFacts,
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

test("retained forge facts transition into and out of the current repository visibility gate", () => {
  const retainedSummary = {
    remoteUrl: "https://gitlab.example.test/team/project.git",
    pr: {
      number: 7,
      title: "Retained merge request",
      url: "https://gitlab.example.test/team/project/-/merge_requests/7",
      state: "OPENED",
      provider: "gitlab",
      kind: "merge_request",
    },
    checks: { passing: 1, pending: 0, failing: 0, failingNames: [], url: null },
    forge: {
      provider: "gitlab",
      host: "gitlab.example.test",
      project: "team/project",
      authenticated: false,
      authenticationError: "Sign in to GitLab.",
      statusError: "GitLab status unavailable.",
    },
  } as GitSummaryInfo;

  assert.deepEqual(visibleForgeFacts(retainedSummary, "https://stale.example.test/repo", false), {
    forge: undefined,
    remoteUrl: null,
    pr: null,
    checks: null,
  }, "retained forge facts stay hidden outside a repository presentation");

  const currentSummary = {
    ...retainedSummary,
    forge: { ...retainedSummary.forge!, authenticationError: undefined, statusError: undefined },
  };
  const restored = visibleForgeFacts(currentSummary, null, true);
  assert.equal(restored.forge?.provider, "gitlab");
  assert.equal(restored.remoteUrl, "https://gitlab.example.test/team/project.git");
  assert.equal(restored.pr?.state, "OPENED");
  assert.equal(restored.checks?.passing, 1);
  assert.equal(restored.forge?.authenticationError, undefined,
    "returning to a repository uses current forge information rather than stale errors");
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
  const mergeRequest = fixChecksPrompt(
    { failing: 1, pending: 0, passing: 0, failingNames: [], url: null },
    "merge_request",
  );
  assert.match(mergeRequest, /^The merge request has 1 failing check\./u);
});

test("sourceKind: hosted forge badges require an exact host", () => {
  assert.equal(sourceKind("git@github.com:o/r.git"), "github");
  assert.equal(sourceKind("https://github.com/o/r"), "github");
  assert.equal(sourceKind("https://gitlab.com/o/r.git"), "gitlab");
  assert.equal(sourceKind(null), null);
  assert.equal(sourceKind(undefined), null);
  // Lookalike hosts must not get the GitHub badge.
  assert.equal(sourceKind("https://notgithub.com/o/r"), "git");
  assert.equal(sourceKind("git@mygithub.com:o/r.git"), "git");
  assert.equal(sourceKind("https://github.com.evil.example/o/r"), "git");
  assert.equal(sourceKind("https://gitlab.com.evil.example/o/r"), "git");
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
  assert.equal(model.upstreamBranch, "origin/feature/very-long-worktree-name");
  assert.deepEqual(model.upstream, [{ text: "In sync with upstream", tone: "normal" }]);
  assert.deepEqual(model.base, [{ text: "231 behind origin/main", tone: "warning" }]);
  assert.equal(model.worktreeKind, "linked");
  assert.equal(model.conflicts, 1);
  assert.equal(model.operation?.label, "Rebase in Progress");
  assert.equal(model.remoteRefsAt, 1_700_000_000_000);
  assert.equal(formatRemoteRefsAt(model.remoteRefsAt), "2023-11-14 22:13 UTC");
  assert.doesNotMatch([...model.upstream, ...model.base].map((line) => line.text).join(" "), /Up to Date/i);
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
  assert.deepEqual(model.base.map((line) => line.text), ["Comparison with origin/trunk unavailable"]);
  assert.equal(model.worktreeKind, "primary");
});

test("known ahead facts remain distinct when only the behind-base comparison is unavailable", () => {
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ baseRef: "origin/main", ahead: 3, worktreeKind: "primary" }), 1),
    summary: read(null, 0, { settled: false }),
  });
  assert.deepEqual(model.base.map((line) => line.text), [
    "3 ahead of origin/main",
    "Commits behind origin/main unavailable",
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
    detail: "1 conflicted, 2 staged, 2 modified, 1 untracked",
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
  assert.equal(detached.upstreamBranch, undefined, "an unreported upstream is unknown, not absent");
  assert.deepEqual(detached.upstream, []);
  assert.deepEqual(detached.base.map((line) => line.text), ["Base comparison unavailable"]);
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
  assert.equal(formatRemoteRefsAt(null), null);
  assert.equal(formatRemoteRefsAt(50), "1970-01-01 00:00 UTC");
  assert.equal(formatRemoteRefsAt(9e15), null);
  assert.doesNotMatch(formatRemoteRefsAt(50)!, /Fetched|Just Now|Ago/i);
});

test("Git Details sync lines: upstream divergence both ways, and an explicit no-upstream", () => {
  const upstream = (aheadUpstream: number, behindUpstream: number) => deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({
      branch: "feature/upstream",
      upstreamBranch: "origin/feature/upstream",
      aheadUpstream,
      behindUpstream,
      baseRef: "origin/main",
      worktreeKind: "primary",
    }), 1),
    summary: read(summary({ branch: "feature/upstream", baseRef: "origin/main", behind: 0 }), 2),
  });
  assert.deepEqual(upstream(2, 3).upstream, [
    { text: "3 behind upstream", tone: "warning" },
    { text: "2 ahead of upstream", tone: "normal" },
  ]);
  assert.deepEqual(upstream(0, 0).base, [{ text: "In sync with origin/main", tone: "normal" }]);
  const none = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ upstreamBranch: null, baseRef: "origin/main", worktreeKind: "primary" }), 1),
    summary: read(null, 0, { settled: false }),
  });
  assert.equal(none.upstreamBranch, null);
  assert.deepEqual(none.upstream, []);
});

test("rolling-skew facts without aheadUpstream still show unpushed commits", () => {
  // A rolling-skew producer can report baseRef: null while omitting the upstream counts; the
  // legacy non-null `ahead` then carries the upstream comparison (legacy contract), and unpushed
  // commits must still surface (regression coverage).
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
  assert.deepEqual(model.upstream, [{ text: "2 ahead of upstream", tone: "normal" }]);
});

test("pre-v76 omission of baseRef never mislabels base divergence as upstream", () => {
  // A pre-v76 producer omits both baseRef and the upstream counts while its legacy `ahead` is
  // relative to the resolved default base. The comparison target is unknown, so no upstream line
  // renders (regression coverage).
  const model = deriveGitPresentation({
    runnerOnline: true,
    worktreePath: null,
    status: read(status({ branch: "feature/legacy", hasChanges: false, ahead: 2 }), 1),
    summary: read(null, 0, { settled: false }),
  });
  assert.deepEqual(model.upstream, []);
  assert.deepEqual(model.base.map((line) => line.text), ["Base comparison unavailable"]);
});
