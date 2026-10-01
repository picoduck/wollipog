/**
 * Pure derivation for the Pinned Summary, the session's fact sheet beside the transcript (#2160).
 * Presentation lives in components/PinnedSummary.tsx and components/GitVisibility.tsx; everything
 * that can be unit-tested without a DOM lives here.
 */

import type {
  BoxView,
  GitChecksSummary,
  GitRepositoryFacts,
  GitStatusInfo,
  GitSummaryInfo,
  RunnerView,
  RunView,
  SessionView,
} from "@wollipog/protocol";

export interface VisibleForgeFacts {
  forge: GitSummaryInfo["forge"] | undefined;
  remoteUrl: string | null;
  pr: GitSummaryInfo["pr"] | null;
  checks: GitSummaryInfo["checks"] | null;
}

/** Apply one current-repository decision to every retained forge-derived summary field. */
export function visibleForgeFacts(
  summary: GitSummaryInfo | null | undefined,
  fallbackRemoteUrl: string | null | undefined,
  visible: boolean,
): VisibleForgeFacts {
  if (!visible) return { forge: undefined, remoteUrl: null, pr: null, checks: null };
  return {
    forge: summary?.forge ?? undefined,
    remoteUrl: summary?.remoteUrl ?? fallbackRemoteUrl ?? null,
    pr: summary?.pr ?? null,
    checks: summary?.checks ?? null,
  };
}

/** Where this session's working directory actually lives. */
export interface HostRow {
  kind: "local" | "remote";
  label: string;
  /** ssh target for boxes, hostname for local runners. */
  detail: string | null;
}

export interface GitReadValue<T> {
  value: T | null;
  /** Client completion sequence for diagnostics. This is not repository sample freshness:
   * summary performs its local read before a slower forge lookup and can settle later. */
  observation: number;
  settled: boolean;
  busy: boolean;
  error: string | null;
  errorCode: string | null;
}

export type GitPresentationState =
  | "loading"
  | "ready"
  | "updating"
  | "offline"
  | "unavailable"
  | "not_repository"
  | "error";

export interface GitPresentationRow {
  label: string;
  detail: string | null;
  title?: string;
  tone?: "normal" | "warning";
}

export interface GitDirtyPresentation {
  label: "Clean" | "Dirty";
  /** The changed files by kind, in sentence case ("1 conflicted, 2 untracked"). */
  detail: string | null;
  tone: "normal" | "warning";
}

/** One sentence-case line of the Git Details "Sync" fact ("231 behind origin/main"). */
export interface GitSyncLine {
  text: string;
  tone: "normal" | "warning";
}

export function isGitNoRepositoryError(
  error: string | null | undefined,
  errorCode: string | null | undefined,
): boolean {
  return errorCode === "GIT_NO_REPOSITORY" ||
    (!!error && /not a git repository|repository is missing|no longer a git repository|worktree is gone/i.test(error));
}

export interface GitPresentation {
  state: GitPresentationState;
  stateDetail: string | null;
  facts: (GitStatusInfo | GitSummaryInfo) | null;
  behindBase: number | null;
  branchLabel: string | null;
  headSha: string | null;
  /** Whether the session's folder is a linked worktree or the repository's primary checkout. */
  worktreeKind: "linked" | "primary" | null;
  dirty: GitDirtyPresentation | null;
  /** Conflicted files: an attention row of its own. */
  conflicts: number;
  operation: GitPresentationRow | null;
  /** The upstream branch; null when there is none, undefined when the runner does not say. */
  upstreamBranch: string | null | undefined;
  upstream: GitSyncLine[];
  base: GitSyncLine[];
  /** When the remote refs were last updated, as "2023-11-14 22:13 UTC"; null when unknown. */
  remoteRefsAt: string | null;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export function displayBaseRef(baseRef: string): string {
  const normalized = baseRef
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/heads\//, "");
  if (/^(?:origin\/)?main$/i.test(normalized)) return "Main";
  if (/^(?:origin\/)?master$/i.test(normalized)) return "Master";
  if (/^(?:origin\/)?trunk$/i.test(normalized)) return "Trunk";
  return normalized;
}

export function deriveDirtySummary(
  facts: Pick<GitRepositoryFacts, "hasChanges" | "stagedCount" | "modifiedCount" | "untrackedCount" | "conflictedCount">,
): GitDirtyPresentation {
  if (!facts.hasChanges) return { label: "Clean", detail: null, tone: "normal" };
  const categories = [
    ["conflicted", facts.conflictedCount],
    ["staged", facts.stagedCount],
    ["modified", facts.modifiedCount],
    ["untracked", facts.untrackedCount],
  ] as const;
  const detail = categories
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
  return { label: "Dirty", detail: detail || null, tone: "warning" };
}

export function formatGitOperation(operation: GitRepositoryFacts["operation"]): string | null {
  if (operation === "cherry_pick") return "Cherry-Pick in Progress";
  if (operation === "merge") return "Merge in Progress";
  if (operation === "rebase") return "Rebase in Progress";
  if (operation === "revert") return "Revert in Progress";
  if (operation === "bisect") return "Bisect in Progress";
  return null;
}

/** The remote refs' last update as a UTC minute. It never claims a fetch: refs also move on push. */
export function formatRemoteRefsAt(remoteRefsAt: number | null | undefined): string | null {
  if (typeof remoteRefsAt !== "number" || !Number.isFinite(remoteRefsAt) ||
      remoteRefsAt < 0 || remoteRefsAt > 8.64e15) {
    return null;
  }
  return `${new Date(remoteRefsAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A ref as Git names it, without the `refs/remotes/` or `refs/heads/` prefix. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
}

function deriveUpstreamLines(facts: GitStatusInfo | GitSummaryInfo): GitSyncLine[] {
  if (!hasOwn(facts, "upstreamBranch")) {
    // A rolling-skew producer reports `baseRef: null` and omits the upstream fields; its legacy
    // `ahead` is then the upstream comparison, and unpushed commits must still show. A pre-v76
    // producer omits `baseRef` too, and its `ahead` is base-relative, so it says nothing here.
    return hasOwn(facts, "baseRef") && facts.baseRef == null && facts.ahead > 0
      ? [{ text: `${facts.ahead} ahead of upstream`, tone: "normal" }]
      : [];
  }
  if (facts.upstreamBranch == null) return [];
  if (facts.aheadUpstream == null || facts.behindUpstream == null) {
    return [{ text: "Comparison with upstream unavailable", tone: "normal" }];
  }
  const lines: GitSyncLine[] = [];
  if (facts.behindUpstream > 0) lines.push({ text: `${facts.behindUpstream} behind upstream`, tone: "warning" });
  if (facts.aheadUpstream > 0) lines.push({ text: `${facts.aheadUpstream} ahead of upstream`, tone: "normal" });
  if (lines.length === 0) lines.push({ text: "In sync with upstream", tone: "normal" });
  return lines;
}

function deriveBaseLines(
  facts: GitStatusInfo | GitSummaryInfo,
  behindBase: number | null,
): GitSyncLine[] {
  if (!hasOwn(facts, "baseRef") || facts.baseRef == null) {
    return [{ text: "Base comparison unavailable", tone: "normal" }];
  }
  const name = shortRef(facts.baseRef);
  const lines: GitSyncLine[] = [];
  if (behindBase != null && behindBase > 0) lines.push({ text: `${behindBase} behind ${name}`, tone: "warning" });
  if (facts.ahead > 0) lines.push({ text: `${facts.ahead} ahead of ${name}`, tone: "normal" });
  if (lines.length === 0 && behindBase === 0) {
    lines.push({ text: `In sync with ${name}`, tone: "normal" });
  } else if (behindBase === null) {
    lines.push({
      text: lines.length > 0 ? `Commits behind ${name} unavailable` : `Comparison with ${name} unavailable`,
      tone: "normal",
    });
  }
  return lines;
}

/**
 * Status owns overlapping local facts because summary performs a slower forge lookup after its
 * local read and can finish later without being fresher. Summary supplies its unique behind fact
 * only when it compares the same base ref, plus initial fallback before status is available.
 */
export function deriveGitPresentation(input: {
  runnerOnline: boolean;
  worktreePath: string | null;
  status: GitReadValue<GitStatusInfo>;
  summary: GitReadValue<GitSummaryInfo>;
}): GitPresentation {
  const { status, summary } = input;
  const facts = status.value ?? summary.value;
  const behindBase = summary.value && (
    !status.value || summary.value.baseRef === status.value.baseRef
  ) ? summary.value.behind : null;
  const busy = status.busy || summary.busy;
  const error = status.error ?? summary.error;
  const notRepository = isGitNoRepositoryError(status.error, status.errorCode) ||
    isGitNoRepositoryError(summary.error, summary.errorCode);
  let state: GitPresentationState;
  let stateDetail: string | null = null;
  if (!input.runnerOnline) {
    state = "offline";
    stateDetail = "Git Unavailable While Disconnected";
  } else if (notRepository) {
    // A disappeared repository invalidates the last confirmed facts. Keep them in the
    // controller for a recoverable retry, but never present them as the current repository.
    state = "not_repository";
    stateDetail = "Not a Git Repository";
  } else if (facts) {
    state = error ? "error" : busy ? "updating" : "ready";
    stateDetail = error ? "Refresh Failed" : busy ? "Updating Git Status" : null;
  } else if (error) {
    state = "error";
    stateDetail = "Git Status Unavailable";
  } else if (busy || (!status.settled && !summary.settled)) {
    state = "loading";
    stateDetail = "Loading Git Status";
  } else {
    state = "unavailable";
    stateDetail = "Git Status Unavailable";
  }

  const branchLabel = facts
    ? facts.detached === true ? "Detached" : facts.branch || null
    : null;
  const headSha = facts && hasOwn(facts, "headSha") ? facts.headSha ?? null : null;
  const worktreeKind = facts?.worktreeKind === "linked" || facts?.worktreeKind === "primary"
    ? facts.worktreeKind
    : null;
  const operationLabel = facts ? formatGitOperation(facts.operation) : null;
  const conflicts = facts && hasOwn(facts, "conflictedCount") && typeof facts.conflictedCount === "number"
    ? Math.max(0, facts.conflictedCount)
    : 0;

  return {
    state,
    stateDetail,
    facts,
    behindBase,
    branchLabel,
    headSha,
    worktreeKind,
    dirty: facts ? deriveDirtySummary(facts) : null,
    conflicts,
    operation: operationLabel
      ? { label: operationLabel, detail: null, tone: "warning" }
      : null,
    upstreamBranch: facts && hasOwn(facts, "upstreamBranch") ? facts.upstreamBranch ?? null : undefined,
    upstream: facts ? deriveUpstreamLines(facts) : [],
    base: facts ? deriveBaseLines(facts, behindBase) : [],
    remoteRefsAt: formatRemoteRefsAt(facts?.remoteRefsAt),
  };
}

export function deriveHost(
  session: SessionView,
  runner: RunnerView | undefined,
  boxes: Iterable<BoxView>,
): HostRow {
  for (const b of boxes) {
    if (b.runnerId === session.runnerId) return { kind: "remote", label: "Remote", detail: b.sshTarget };
  }
  return { kind: "local", label: "Local", detail: runner?.hostname ?? session.runnerId };
}

/** Legacy pinned cards use status for every overlapping local repository fact once that faster
 * read settles. Summary remains the initial fallback because its later completion can reflect
 * forge latency rather than a fresher repository sample. */
export function legacyLocalGitFacts(
  status: GitStatusInfo | null,
  summary: GitSummaryInfo | null,
): GitStatusInfo | GitSummaryInfo | null {
  return status ?? summary;
}

/** The Changes row model: line totals when they're meaningful, else a changed-file-count
 * fallback. Accepts either a GitStatusInfo or a GitSummaryInfo. */
export type ChangesRow = { kind: "lines"; added: number; deleted: number } | { kind: "files"; count: number | null };

export function deriveChanges(
  status: { hasChanges: boolean; addedLines?: number; deletedLines?: number } | null,
  /** Changed-file count for the fallback (from GitStatusInfo.files; summaries don't carry it). */
  fileCount?: number,
): ChangesRow | null {
  if (!status) return null;
  const { addedLines, deletedLines, hasChanges } = status;
  const haveTotals = addedLines != null && deletedLines != null;
  if (haveTotals && (addedLines + deletedLines > 0 || !hasChanges)) {
    return { kind: "lines", added: addedLines, deleted: deletedLines };
  }
  // A dirty tree with no line totals (pre-v20 runner) or 0/0 totals (untracked-only,
  // binary, or mode-only changes — numstat can't count them): fall back to file count
  // rather than hiding the row or lying with "+0 -0".
  if (hasChanges) return { kind: "files", count: fileCount ?? null };
  return { kind: "lines", added: 0, deleted: 0 }; // clean tree — 0/0 is truthful even pre-v20
}

/** The Commit-or-push row's contextual label (Codex behavior). Null hides the row.
 * Accepts either a GitStatusInfo or a GitSummaryInfo — both carry the two inputs. */
export type CommitAction = "commit_or_push" | "push" | "up_to_date";
export function deriveCommitAction(status: { hasChanges: boolean; ahead: number } | null): CommitAction | null {
  if (!status) return null;
  if (status.hasChanges) return "commit_or_push";
  if (status.ahead > 0) return "push";
  return "up_to_date";
}

/**
 * The prompt the "Fix" button sends when checks are failing — the Codex affordance: hand the
 * failing-check names to the agent and let it investigate.
 */
export function fixChecksPrompt(
  checks: GitChecksSummary,
  kind: "pull_request" | "merge_request" = "pull_request",
): string {
  const n = checks.failing;
  const names = checks.failingNames.length ? ` (${checks.failingNames.join(", ")})` : "";
  const requestName = kind === "merge_request" ? "merge request" : "pull request";
  return (
    `The ${requestName} has ${n} failing check${n === 1 ? "" : "s"}${names}. ` +
    `Investigate the failure${n === 1 ? "" : "s"}, fix the underlying issue, and push the fix.`
  );
}

export const COMMIT_ACTION_LABELS: Record<CommitAction, string> = {
  commit_or_push: "Commit or Push",
  push: "Push",
  up_to_date: "Up to Date",
};

/** Sibling sessions of a multi-agent run — the Subagents section. */
export function deriveSubagents(
  session: SessionView,
  runs: Map<string, RunView>,
  sessions: Map<string, SessionView>,
): SessionView[] {
  if (!session.runId) return [];
  const run = runs.get(session.runId);
  if (!run) return [];
  return run.sessionIds
    .filter((id) => id !== session.id)
    .map((id) => sessions.get(id))
    .filter((s): s is SessionView => !!s);
}

/** Which forge the remote is: Git Details names it, and Review offers GitLab's own flow. GitHub
 * means the remote HOST is exactly github.com — `notgithub.com` / `mygithub.com` must not match. */
export function sourceKind(remoteUrl: string | null | undefined): "github" | "gitlab" | "git" | null {
  if (!remoteUrl) return null;
  const http = remoteHttpUrl(remoteUrl);
  if (http) {
    try {
      const host = new URL(http).hostname.toLowerCase();
      if (host === "github.com" || host === "www.github.com") return "github";
      if (host === "gitlab.com" || host === "www.gitlab.com") return "gitlab";
    } catch {
      /* unparseable — treat as a generic remote */
    }
  }
  return "git";
}

/**
 * A clickable https URL for the repo remote, or null when it can't be derived safely.
 * Handles the two shapes git actually emits: https URLs (pass through, `.git` stripped)
 * and scp-like ssh (`git@host:owner/repo.git`).
 */
export function remoteHttpUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  const scp = trimmed.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+)$/);
  // The captured host must actually look like one (dot-separated labels) — this is what
  // keeps file:// URLs and relative paths from being "converted".
  if (scp && /^[\w-]+(\.[\w-]+)+$/.test(scp[1]!)) return `https://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`;
  return null;
}
