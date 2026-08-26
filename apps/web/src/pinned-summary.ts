/**
 * Pure derivation for the pinned summary (the Codex-style floating environment card in the
 * session view's top-right). Presentation lives in components/PinnedSummary.tsx; everything
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
  detail: string | null;
  tone: "normal" | "warning";
}

export interface GitRemoteFreshness {
  label: "Remote Status May Be Stale";
  detail: string;
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
  worktree: GitPresentationRow;
  dirty: GitDirtyPresentation | null;
  upstream: GitPresentationRow[];
  base: GitPresentationRow[];
  operation: GitPresentationRow | null;
  remoteFreshness: GitRemoteFreshness;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export interface GitHeadlineSegment {
  text: string;
  tone: "normal" | "warning";
  /** Full phrasing when the visible text is compacted (tooltip + screen readers). */
  expandedLabel?: string;
}

/**
 * The collapsed Git section's scannable headline (IDEA-009 2026-08-10): branch or detached
 * state, worktree identity, dirty/conflict state, any active operation, and the single most
 * actionable divergence compacted to `Main +7 / -18` arithmetic. Everything else stays behind
 * Show Git Details.
 */
export function deriveGitHeadline(model: GitPresentation): GitHeadlineSegment[] {
  const hideFacts = model.state === "offline" ||
    model.state === "loading" ||
    model.state === "unavailable" ||
    model.state === "not_repository";
  if (hideFacts || !model.facts) return [];
  const facts = model.facts;
  const segments: GitHeadlineSegment[] = [];
  if (model.branchLabel) segments.push({ text: model.branchLabel, tone: "normal" });
  if (model.worktree.label !== "Worktree Type Unavailable") {
    segments.push({ text: model.worktree.label, tone: "normal" });
  }
  if (model.dirty) segments.push({ text: model.dirty.label, tone: model.dirty.tone });
  if (hasOwn(facts, "conflictedCount") && typeof facts.conflictedCount === "number" && facts.conflictedCount > 0) {
    segments.push({
      text: "Conflicts",
      tone: "warning",
      expandedLabel: `${facts.conflictedCount} Conflicted`,
    });
  }
  if (model.operation) segments.push({ text: model.operation.label, tone: "warning" });
  const baseName = hasOwn(facts, "baseRef") && facts.baseRef != null ? displayBaseRef(facts.baseRef) : null;
  const behindBase = model.behindBase ?? 0;
  if (baseName && (facts.ahead > 0 || behindBase > 0)) {
    segments.push({
      text: `${baseName} ${[
        facts.ahead > 0 ? `+${facts.ahead}` : null,
        behindBase > 0 ? `-${behindBase}` : null,
      ].filter(Boolean).join(" / ")}`,
      tone: behindBase > 0 ? "warning" : "normal",
      expandedLabel: [
        facts.ahead > 0 ? `Ahead of ${baseName} ${facts.ahead}` : null,
        behindBase > 0 ? `Behind ${baseName} ${behindBase}` : null,
      ].filter(Boolean).join(" · "),
    });
  } else {
    // No base comparison: upstream divergence is the one actionable summary, and it must not
    // hide unpushed commits (regression coverage) — show both directions compacted. When a producer
    // EXPLICITLY reported no default-base ref, the legacy non-null `ahead` carries the
    // upstream comparison (legacy contract); when `baseRef` is omitted entirely (pre-v76
    // shape), `ahead` is base-relative and must not be labelled as upstream divergence.
    const aheadUpstream = hasOwn(facts, "aheadUpstream") && typeof facts.aheadUpstream === "number"
      ? facts.aheadUpstream
      : hasOwn(facts, "baseRef") ? facts.ahead : 0;
    const behindUpstream = hasOwn(facts, "behindUpstream") && typeof facts.behindUpstream === "number"
      ? facts.behindUpstream
      : 0;
    if (aheadUpstream > 0 || behindUpstream > 0) {
      segments.push({
        text: `Upstream ${[
          aheadUpstream > 0 ? `+${aheadUpstream}` : null,
          behindUpstream > 0 ? `-${behindUpstream}` : null,
        ].filter(Boolean).join(" / ")}`,
        tone: behindUpstream > 0 ? "warning" : "normal",
        expandedLabel: [
          aheadUpstream > 0 ? `Ahead of Upstream ${aheadUpstream}` : null,
          behindUpstream > 0 ? `Behind Upstream ${behindUpstream}` : null,
        ].filter(Boolean).join(" · "),
      });
    }
  }
  return segments;
}

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
    ["Conflicted", facts.conflictedCount],
    ["Staged", facts.stagedCount],
    ["Modified", facts.modifiedCount],
    ["Untracked", facts.untrackedCount],
  ] as const;
  const detail = categories
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(" \u00b7 ");
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

export function deriveRemoteFreshness(
  remoteRefsAt: number | null | undefined,
): GitRemoteFreshness {
  let detail = "Remote Ref Freshness Unavailable";
  if (typeof remoteRefsAt === "number" && Number.isFinite(remoteRefsAt) &&
      remoteRefsAt >= 0 && remoteRefsAt <= 8.64e15) {
    detail = `Remote Refs Updated ${new Date(remoteRefsAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
  return { label: "Remote Status May Be Stale", detail };
}

function deriveUpstreamRows(facts: GitStatusInfo | GitSummaryInfo): GitPresentationRow[] {
  if (!hasOwn(facts, "upstreamBranch")) {
    return [{ label: "Upstream Details Unavailable", detail: null }];
  }
  const upstreamBranch = facts.upstreamBranch ?? null;
  if (upstreamBranch === null) return [{ label: "No Upstream", detail: null }];
  if (facts.aheadUpstream == null || facts.behindUpstream == null) {
    return [{
      label: "Upstream Comparison Unavailable",
      detail: upstreamBranch,
      title: upstreamBranch,
    }];
  }
  const rows: GitPresentationRow[] = [];
  if (facts.behindUpstream > 0) {
    rows.push({
      label: "Behind Upstream",
      detail: String(facts.behindUpstream),
      title: upstreamBranch,
      tone: "warning",
    });
  }
  if (facts.aheadUpstream > 0) {
    rows.push({
      label: "Ahead of Upstream",
      detail: String(facts.aheadUpstream),
      title: upstreamBranch,
    });
  }
  if (rows.length === 0) {
    rows.push({
      label: "Upstream Synced",
      detail: upstreamBranch,
      title: upstreamBranch,
    });
  }
  return rows;
}

function deriveBaseRows(
  facts: GitStatusInfo | GitSummaryInfo,
  behindBase: number | null,
): GitPresentationRow[] {
  if (!hasOwn(facts, "baseRef") || facts.baseRef == null) {
    return [{ label: "Base Comparison Unavailable", detail: null }];
  }
  const name = displayBaseRef(facts.baseRef);
  const rows: GitPresentationRow[] = [];
  if (behindBase != null && behindBase > 0) {
    rows.push({
      label: `Behind ${name}`,
      detail: String(behindBase),
      title: facts.baseRef,
      tone: "warning",
    });
  }
  if (facts.ahead > 0) {
    rows.push({
      label: `Ahead of ${name}`,
      detail: String(facts.ahead),
      title: facts.baseRef,
    });
  }
  if (rows.length === 0 && behindBase === 0) {
    rows.push({ label: `Synced With ${name}`, detail: null, title: facts.baseRef });
  } else if (behindBase === null) {
    rows.push({
      label: rows.length > 0 ? `Behind ${name} Unavailable` : `${name} Comparison Unavailable`,
      detail: null,
      title: facts.baseRef,
    });
  }
  return rows;
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
    stateDetail = "Runner Offline";
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
  const worktreeKind = facts?.worktreeKind;
  const worktree: GitPresentationRow = worktreeKind === "linked"
    ? {
        label: "Linked Worktree",
        detail: input.worktreePath,
        title: input.worktreePath ?? undefined,
      }
    : worktreeKind === "primary"
      ? { label: "Primary Checkout", detail: null }
      : { label: "Worktree Type Unavailable", detail: null };
  const operationLabel = facts ? formatGitOperation(facts.operation) : null;

  return {
    state,
    stateDetail,
    facts,
    behindBase,
    branchLabel,
    headSha,
    worktree,
    dirty: facts ? deriveDirtySummary(facts) : null,
    upstream: facts ? deriveUpstreamRows(facts) : [],
    base: facts ? deriveBaseRows(facts, behindBase) : [],
    operation: operationLabel
      ? { label: operationLabel, detail: null, tone: "warning" }
      : null,
    remoteFreshness: deriveRemoteFreshness(facts?.remoteRefsAt),
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
export function fixChecksPrompt(checks: GitChecksSummary): string {
  const n = checks.failing;
  const names = checks.failingNames.length ? ` (${checks.failingNames.join(", ")})` : "";
  return (
    `The PR has ${n} failing check${n === 1 ? "" : "s"}${names}. ` +
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

/** Which forge icon the Sources section shows. Null hides the section. GitHub means the
 * remote HOST is exactly github.com — `notgithub.com` / `mygithub.com` must not match. */
export function sourceKind(remoteUrl: string | null | undefined): "github" | "git" | null {
  if (!remoteUrl) return null;
  const http = remoteHttpUrl(remoteUrl);
  if (http) {
    try {
      const host = new URL(http).hostname.toLowerCase();
      if (host === "github.com" || host === "www.github.com") return "github";
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
