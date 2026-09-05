import { useEffect, useId, useRef, useState } from "react";
import {
  isTerminal,
  normalizeSourcePath,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type CreateReviewFindingRequest,
  type CreateWorkspaceReferenceRequest,
  type GitCommitInfo,
  type GitDiffInfo,
  type GitDiffScope,
  type GitForgeInfo,
  type GitPrInfo,
  type ReviewFinding,
  type ReviewFindingSummary,
  type SessionView,
  type SourceLocation,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { titleCaseLabel } from "../format.js";
import {
  GitDiffViewer,
  type DiffLayout,
  type DiffPane,
  type StagingControls,
} from "./GitDiffViewer.js";
import type { GitStatus } from "./useGitStatus.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { useFeedback } from "./FeedbackProvider.js";
import { sessionAgentLabel } from "./agent-options.js";
import { safeExternalHref } from "../external-href.js";
import { sourceKind } from "../pinned-summary.js";

/**
 * Git / PR workflow for a worktree session: review the worktree status, commit the
 * agent's changes, and push a branch + open a PR — all run on the session's runner.
 * Hosted by the right side panel's "Review" mode (Ctrl+Shift+G). Status is the app-wide
 * shared read (useGitStatus); the diff and its staging state are owned here.
 */
export function ReviewPanel({
  session,
  runnerOnline,
  runnerProtocolVersion,
  git,
  forge,
  onOpenSourceLocation,
  onAttachWorkspaceReference,
}: {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  git: GitStatus;
  forge?: GitForgeInfo | null;
  onOpenSourceLocation: (location: SourceLocation) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [busy, setBusy] = useState<null | "commit" | "pr">(null);
  const [error, setError] = useState<string | null>(null);
  const status = git.status;
  const [commitMsg, setCommitMsg] = useState(session.title || "Agent changes");
  const [prTitle, setPrTitle] = useState(session.title || "Agent changes");
  const [prBody, setPrBody] = useState("");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState<GitCommitInfo | null>(null);
  const [pr, setPr] = useState<GitPrInfo | null>(null);
  // Rich-diff pane (Phase 2, PR-A). Branch-relative scopes only make sense for worktree sessions;
  // a WSL in-place session has no session branch to diff, so it gets Uncommitted only.
  const [scope, setScope] = useState<GitDiffScope>("uncommitted");
  const [pane, setPane] = useState<DiffPane>("combined");
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [diff, setDiff] = useState<GitDiffInfo | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Per-hunk staging (PR-B): the in-flight mutation's `${path}#${index}` key, and the amber
  // non-fatal notice shown when a stage raced the worktree/index (GIT_STALE / GIT_APPLY_FAILED).
  const [hunkBusy, setHunkBusy] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [findingSummary, setFindingSummary] = useState<ReviewFindingSummary | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [findingBusyId, setFindingBusyId] = useState<string | null>(null);
  const [creatingFinding, setCreatingFinding] = useState(false);
  const [bundlingFindings, setBundlingFindings] = useState(false);
  const [syncingGitHub, setSyncingGitHub] = useState(false);
  const [findingError, setFindingError] = useState<string | null>(null);
  const [findingNotice, setFindingNotice] = useState<string | null>(null);
  const findingReqRef = useRef(0);
  // Monotonic request token: switching scope fires overlapping loadDiff() calls, and their
  // responses can resolve out of order. Only the latest request may write state, so a slow
  // response for a scope the user already switched away from can't clobber the current one.
  const diffReqRef = useRef(0);
  // Live scope for callers running from stale closures: doCommit/doPr finish long after the
  // render that created them and then reload the diff — they must reload whatever scope is
  // selected *at that moment*. Reloading the captured scope would win the request race and
  // then be gated out of display below, leaving a silently blank pane.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const uid = useId();
  const commitId = `${uid}-commit`;

  const loadStatus = () => git.refresh();
  const diffSupported = runnerSupportsProtocol(runnerProtocolVersion, "richDiff");
  const stagingSupported = runnerSupportsProtocol(runnerProtocolVersion, "hunkStaging");
  const fineDiffSupported = runnerSupportsProtocol(runnerProtocolVersion, "fineGrainedDiff");
  const githubReviewSupported = runnerSupportsProtocol(runnerProtocolVersion, "githubReviewReconciliation");
  const forgeReviewSupported = runnerSupportsProtocol(runnerProtocolVersion, "forgeIntegration");
  const hostedGitLab = sourceKind(status?.remoteUrl) === "gitlab";
  const forgeProvider = forge?.provider ?? (hostedGitLab ? "gitlab" : "github");
  // A pre-v106 runner treats GitLab as generic Git. Preserve that established action surface until
  // the runner advertises the forge contract; otherwise the web client would promise MR creation
  // while dispatching to a runner that can only push a branch.
  const mergeRequest = forgeProvider === "gitlab" && forgeReviewSupported;
  const requestName = mergeRequest ? "Merge Request" : "Pull Request";
  const requestShortName = mergeRequest ? "MR" : "PR";
  const reviewSyncSupported = forgeReviewSupported || (!mergeRequest && githubReviewSupported);
  const diffHint = runnerCapabilityRequirement(runnerProtocolVersion, "richDiff", "Rich diff loading");
  const stagingHint = runnerCapabilityRequirement(runnerProtocolVersion, "hunkStaging", "Hunk staging");
  const fineDiffHint = runnerCapabilityRequirement(runnerProtocolVersion, "fineGrainedDiff", "Staged panes, line staging, and discard");
  const diffEnabled = runnerOnline && !!session.worktreePath && diffSupported;

  const loadDiff = async () => {
    if (!diffEnabled) return;
    const reqId = ++diffReqRef.current;
    setDiffBusy(true);
    setDiffError(null);
    try {
      const { diff: d } = await api.gitDiff(session.id, scopeRef.current);
      if (diffReqRef.current !== reqId) return; // superseded by a newer scope/refresh
      setDiff(d);
    } catch (e) {
      if (diffReqRef.current !== reqId) return;
      setDiff(null);
      setDiffError((e as Error).message);
    } finally {
      // Only the latest request owns the busy flag; a superseded one must not clear it.
      if (diffReqRef.current === reqId) setDiffBusy(false);
    }
  };

  const installFindings = (next: { findings: ReviewFinding[]; summary: ReviewFindingSummary }) => {
    setFindings(next.findings);
    setFindingSummary(next.summary);
    const unresolved = new Set(next.findings.filter((finding) => finding.status === "open" || finding.status === "sent").map((finding) => finding.findingId));
    setSelectedFindings((prior) => new Set([...prior].filter((findingId) => unresolved.has(findingId))));
  };

  const loadFindings = async (selectAll = false) => {
    const request = ++findingReqRef.current;
    try {
      const next = await api.reviewFindings(session.id);
      if (request !== findingReqRef.current) return;
      installFindings(next);
      if (selectAll) {
        setSelectedFindings(new Set(next.findings.filter((finding) => finding.status === "open" || finding.status === "sent").map((finding) => finding.findingId)));
      }
      setFindingError(null);
    } catch (cause) {
      if (request === findingReqRef.current) setFindingError((cause as Error).message);
    }
  };

  useEffect(() => {
    setFindings([]);
    setFindingSummary(null);
    setSelectedFindings(new Set());
    setFindingNotice(null);
    void loadFindings(true);
    return () => { findingReqRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session.id]);

  const createFinding = async (input: CreateReviewFindingRequest): Promise<boolean> => {
    setCreatingFinding(true);
    setFindingError(null);
    setFindingNotice(null);
    const before = new Set(findings.map((finding) => finding.findingId));
    try {
      const next = await api.createReviewFinding(session.id, input);
      findingReqRef.current += 1;
      installFindings(next);
      setSelectedFindings((prior) => new Set([
        ...prior,
        ...next.findings.filter((finding) => !before.has(finding.findingId)).map((finding) => finding.findingId),
      ]));
      return true;
    } catch (cause) {
      setFindingError((cause as Error).message);
      return false;
    } finally {
      setCreatingFinding(false);
    }
  };

  const updateFinding = async (finding: ReviewFinding, status: "open" | "resolved" | "dismissed") => {
    setFindingBusyId(finding.findingId);
    setFindingError(null);
    setFindingNotice(null);
    try {
      const next = await api.updateReviewFinding(session.id, finding.findingId, {
        status,
        expectedUpdatedAt: finding.updatedAt,
      });
      findingReqRef.current += 1;
      installFindings(next);
    } catch (cause) {
      setFindingError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) void loadFindings();
    } finally {
      setFindingBusyId(null);
    }
  };

  const bundleFindings = async () => {
    const selected = findings.filter((finding) => selectedFindings.has(finding.findingId) && (finding.status === "open" || finding.status === "sent"));
    if (!selected.length) return;
    setBundlingFindings(true);
    setFindingError(null);
    setFindingNotice(null);
    try {
      const next = await api.bundleReviewFindings(session.id, {
        findings: selected.map((finding) => ({ findingId: finding.findingId, expectedUpdatedAt: finding.updatedAt })),
      });
      findingReqRef.current += 1;
      installFindings(next);
      setSelectedFindings(new Set());
      const agent = session.agentName || session.agentId
        ? sessionAgentLabel(session.agentName, session.driver, session.agentId)
        : "the owning agent";
      setFindingNotice(`${selected.length} finding${selected.length === 1 ? "" : "s"} sent to ${agent}.`);
    } catch (cause) {
      setFindingError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) void loadFindings();
    } finally {
      setBundlingFindings(false);
    }
  };

  const syncForgeFindings = async () => {
    setSyncingGitHub(true);
    setFindingError(null);
    setFindingNotice(null);
    try {
      const data = await api.git(session.id, { action: forgeReviewSupported ? "forge_review_sync" : "github_review_sync" });
      const remote = data.forgeReview;
      if (!data.reviewFindings || !data.reviewReconciliation || (!remote && !data.githubReview)) {
        throw new Error("the runner returned an incomplete forge review sync");
      }
      findingReqRef.current += 1;
      installFindings(data.reviewFindings);
      const counts = data.reviewReconciliation;
      const changed = counts.imported + counts.updated + counts.dismissedMissing;
      setFindingNotice(
        remote
          ? `${remote.provider === "gitlab" ? "GitLab MR" : "GitHub PR"} #${remote.changeRequestNumber} synchronized: ${remote.threads.length} thread${remote.threads.length === 1 ? "" : "s"}, ${changed} local change${changed === 1 ? "" : "s"}.`
          : `GitHub PR #${data.githubReview!.pullRequestNumber} synchronized: ${data.githubReview!.threads.length} thread${data.githubReview!.threads.length === 1 ? "" : "s"}, ${changed} local change${changed === 1 ? "" : "s"}.`,
      );
    } catch (cause) {
      setFindingError((cause as Error).message);
    } finally {
      setSyncingGitHub(false);
    }
  };

  // Diff reads only make sense with an online runner and a worktree — an unguarded load would
  // 409 ("runner is offline") or fire a doomed request for worktree-less sessions.
  // Load the diff on mount and whenever the selected scope changes; ALSO when the guard
  // flips back on (runner reconnect), so the pane recovers from the offline error state
  // instead of wedging on it. While disabled, drop the stale error (the offline hint and
  // the disabled controls already say why nothing is loading).
  useEffect(() => {
    if (diffEnabled) void loadDiff();
    else setDiffError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope, diffEnabled]);

  // Re-read the diff when a turn settles while the panel is open: the agent may have
  // staged/edited files (its own git usage). Status re-reads live in useGitStatus.
  const turnActive = ["queued", "starting", "running", "input_required"].includes(session.status);
  useEffect(() => {
    if (diffEnabled && !turnActive && diff) void loadDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, turnActive]);

  /** `all` forces commit-everything even with staged hunks — the escape hatch out of a partial stage. */
  const doCommit = async (all = false) => {
    setBusy("commit");
    // Clear prior success so a failed retry can't show a stale "✓ committed"/"PR opened".
    setError(null);
    setCommit(null);
    setPr(null);
    try {
      const d = await api.git(session.id, {
        action: "commit",
        message: commitMsg,
        ...(all
          ? { all: true }
          : // State the button's meaning: the runner refuses (GIT_STALE) if the staged set moved
            // since this panel read it, instead of committing a different set than promised.
            { expectStaged: (status?.stagedCount ?? 0) > 0 }),
      });
      setCommit(d.commit ?? null);
      await loadStatus();
      await loadDiff();
    } catch (e) {
      if (e instanceof ApiError && e.code === "GIT_STALE") {
        setStageNotice(`${e.message} — the panel has been refreshed.`);
        void loadStatus();
        void loadDiff();
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  };

  /** Stage/unstage one hunk against the exact diff on screen; the reply carries a fresh read. */
  const doStageHunk = async (direction: "stage" | "unstage", filePath: string, hunkIndex: number) => {
    if (!diff || diff.scope !== "uncommitted") return;
    setHunkBusy(`${filePath}#${hunkIndex}`);
    setStageNotice(null);
    try {
      const d = await api.gitStageHunk(session.id, { direction, filePath, hunkIndex, diffHash: diff.diffHash });
      if (d.status) git.install(d.status);
      if (d.diff && scopeRef.current === "uncommitted") {
        // The reply IS a fresh read — supersede any in-flight loadDiff so a slower response
        // can't clobber it. Only when installing: if the user switched scope mid-stage, that
        // scope's own loadDiff must stay in charge (bumping here would orphan it and wedge the
        // pane on "Loading diff…").
        diffReqRef.current += 1;
        setDiffBusy(false);
        setDiff(d.diff);
        setDiffError(null);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.code === "GIT_STALE" || e.code === "GIT_APPLY_FAILED")) {
        // A race, not a failure: the worktree or index moved. Tell the user and refetch.
        setStageNotice(
          e.code === "GIT_STALE"
            ? "The changes on disk moved under this diff — refreshed it; check the hunk and try again."
            : `${e.message} — the diff has been refreshed.`,
        );
        void loadDiff();
        void loadStatus();
      } else {
        setDiffError((e as Error).message);
      }
    } finally {
      setHunkBusy(null);
    }
  };

  /** Move selected +/- lines between the canonical staged and unstaged panes. */
  const doStageLines = async (
    direction: "stage" | "unstage",
    filePath: string,
    hunkIndex: number,
    lineIndices: number[],
  ) => {
    if (!diff?.fineDiffHash || diff.scope !== "uncommitted") return;
    setHunkBusy(`${filePath}#${hunkIndex}:lines`);
    setStageNotice(null);
    try {
      const d = await api.gitStageLines(session.id, {
        direction, filePath, hunkIndex, lineIndices, diffHash: diff.fineDiffHash,
      });
      if (d.status) git.install(d.status);
      if (d.diff && scopeRef.current === "uncommitted") {
        diffReqRef.current += 1;
        setDiffBusy(false);
        setDiff(d.diff);
        setDiffError(null);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.code === "GIT_STALE" || e.code === "GIT_APPLY_FAILED")) {
        setStageNotice(`${e.message} — the canonical panes were refreshed; check the selected lines and try again.`);
        void loadDiff();
        void loadStatus();
      } else setDiffError((e as Error).message);
    } finally {
      setHunkBusy(null);
    }
  };

  /** Restore a reviewed tracked file to HEAD. Confirmation is intentionally file-specific. */
  const doDiscardFile = async (filePath: string) => {
    if (!diff?.fineDiffHash || diff.scope !== "uncommitted") return;
    if (!await confirm({
      title: "Discard file changes?",
      message: `All staged and unstaged changes to ${filePath} will be restored to HEAD. This cannot be undone.`,
      confirmLabel: "Discard Changes",
      tone: "danger",
    })) return;
    setHunkBusy(`${filePath}:discard`);
    setStageNotice(null);
    try {
      const d = await api.gitDiscardFile(session.id, { filePath, diffHash: diff.fineDiffHash });
      if (d.status) git.install(d.status);
      if (d.diff && scopeRef.current === "uncommitted") {
        diffReqRef.current += 1;
        setDiffBusy(false);
        setDiff(d.diff);
        setDiffError(null);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.code === "GIT_STALE" || e.code === "GIT_APPLY_FAILED")) {
        setStageNotice(`${e.message} — the diff was refreshed; review the file before retrying.`);
        void loadDiff();
        void loadStatus();
      } else setDiffError((e as Error).message);
    } finally {
      setHunkBusy(null);
    }
  };

  const doPr = async () => {
    setBusy("pr");
    setError(null);
    setPr(null);
    setCommit(null);
    try {
      // Pass the visible commit message so the one-click flow's auto-commit of any
      // pending changes uses it (not the PR title).
      const d = await api.git(session.id, { action: "open_pr", title: prTitle, body: prBody, branch, message: commitMsg });
      setPr(d.pr ?? null);
      await loadStatus();
      await loadDiff();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // hunkBusy included: a Commit clicked while a stage RPC is in flight would land AFTER the
  // stage (the runner queues mutations) and silently become a staged-only commit under a
  // plain "Commit" label.
  const disabled = !!busy || git.busy || hunkBusy !== null || !runnerOnline;
  const prHref = safeExternalHref(pr?.url);

  // Never render a diff under the wrong tab: a scope switch keeps the previous response in state
  // until the new one lands, so gate the viewer on the response's own scope. A same-scope refresh
  // still shows the current diff while reloading (stale-while-revalidate).
  const scopedDiff = diff && diff.scope === scope ? diff : null;
  const shownDiff = scopedDiff && scope === "uncommitted" && fineDiffSupported && pane !== "combined"
    ? {
        ...scopedDiff,
        diffHash: pane === "staged"
          ? scopedDiff.stagedDiffHash ?? scopedDiff.diffHash
          : scopedDiff.unstagedDiffHash ?? scopedDiff.diffHash,
        files: pane === "staged" ? scopedDiff.stagedFiles ?? [] : scopedDiff.unstagedFiles ?? [],
        stats: pane === "staged" ? scopedDiff.stagedStats ?? { filesChanged: 0, insertions: 0, deletions: 0 }
          : scopedDiff.unstagedStats ?? { filesChanged: 0, insertions: 0, deletions: 0 },
      }
    : scopedDiff;

  // Stage buttons exist only where the identity is defined (the uncommitted diff), the runner can
  // act, and no turn is running (an agent writing mid-stage would race the index). When undefined
  // the viewer renders read-only — no disabled-button noise on Branch/Last-turn/busy/offline.
  const staging: StagingControls | undefined =
    scope === "uncommitted" && runnerOnline && stagingSupported && !turnActive && !busy
      ? {
          onHunk: doStageHunk,
          onLines: doStageLines,
          onDiscard: doDiscardFile,
          pane: fineDiffSupported ? pane : "combined",
          fineGrained: fineDiffSupported,
          busyKey: hunkBusy,
        }
      : undefined;
  const stagedCount = status?.stagedCount ?? 0;

  // Review is meaningless without a working directory to diff — non-worktree chats get a hint.
  if (!session.worktreePath) {
    return <div className="hint">This session has no working directory — git review is unavailable.</div>;
  }

  return (
    <div className="review-panel">
      {!runnerOnline && <div className="hint warn">Runner is offline — git actions are unavailable.</div>}
      {!diffSupported && (
        <div className="hint warn" role="status">
          {diffHint}
        </div>
      )}
      {diffSupported && !stagingSupported && (
        <div className="hint warn" role="status">
          {stagingHint}
        </div>
      )}
      {diffSupported && stagingSupported && !fineDiffSupported && (
        <div className="hint warn" role="status">
          {fineDiffHint}
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      {/* A failed status refresh keeps the last-known numbers on screen — say so, or the
          stale branch/file count reads as current. */}
      {git.error && <div className="composer-error">Git status refresh failed: {git.error}</div>}

      <div className="git-status-row">
        <button className="btn ghost sm" onClick={loadStatus} disabled={disabled}>
          {git.busy ? "Updating Git Status" : "Refresh Git Status"}
        </button>
        {status && (
          <span className="muted">
            Branch <code>{status.branch}</code> · {status.files.length} Changed · {status.ahead} Commit
            {status.ahead === 1 ? "" : "s"} Ahead
          </span>
        )}
      </div>

      {status && status.files.length > 0 && (
        <ul className="git-files">
          {status.files.slice(0, 12).map((f) => (
            <li key={f.path}>
              <span className="gfs">{f.status || "·"}</span> {f.path}
            </li>
          ))}
          {status.files.length > 12 && <li className="muted">+{status.files.length - 12} More…</li>}
        </ul>
      )}

      <div className="git-diff-section" role="group" aria-label="Review Changes">
        <div className="git-diff-controls">
          <div className="scope-seg" role="radiogroup" aria-label="Diff Scope" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
            <button
              role="radio"
              aria-checked={scope === "uncommitted"}
              tabIndex={scope === "uncommitted" ? 0 : -1}
              className={`scope-opt${scope === "uncommitted" ? " is-active" : ""}`}
              onClick={() => setScope("uncommitted")}
              disabled={!diffSupported}
            >
              Uncommitted
            </button>
            {session.useWorktree && (
              <button
                role="radio"
                aria-checked={scope === "all_branch"}
                tabIndex={scope === "all_branch" ? 0 : -1}
                className={`scope-opt${scope === "all_branch" ? " is-active" : ""}`}
                onClick={() => setScope("all_branch")}
                disabled={!diffSupported}
              >
                Branch
              </button>
            )}
            {session.useWorktree && (
              <button
                role="radio"
                aria-checked={scope === "last_turn"}
                tabIndex={scope === "last_turn" ? 0 : -1}
                className={`scope-opt${scope === "last_turn" ? " is-active" : ""}`}
                onClick={() => setScope("last_turn")}
                disabled={!diffSupported}
              >
                Last Turn
              </button>
            )}
          </div>
          <button className="btn ghost sm" onClick={loadDiff} disabled={diffBusy || !runnerOnline || !diffSupported}>
            {diffBusy ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
        <div className="git-diff-view-controls">
          {scope === "uncommitted" && fineDiffSupported && (
            <div className="scope-seg" role="radiogroup" aria-label="Index Pane" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
              {(["combined", "unstaged", "staged"] as DiffPane[]).map((value) => (
                <button
                  role="radio"
                  aria-checked={pane === value}
                  tabIndex={pane === value ? 0 : -1}
                  className={`scope-opt${pane === value ? " is-active" : ""}`}
                  key={value}
                  onClick={() => setPane(value)}
                >
                  {value === "combined" ? "All Changes" : value === "unstaged" ? "Unstaged" : "Staged"}
                </button>
              ))}
            </div>
          )}
          <div className="scope-seg" role="radiogroup" aria-label="Diff Layout" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
            {(["unified", "split"] as DiffLayout[]).map((value) => (
              <button
                role="radio"
                aria-checked={layout === value}
                tabIndex={layout === value ? 0 : -1}
                className={`scope-opt${layout === value ? " is-active" : ""}`}
                key={value}
                onClick={() => setLayout(value)}
              >
                {value === "unified" ? "Unified" : "Side by Side"}
              </button>
            ))}
          </div>
        </div>
        {diffError && <div className="composer-error">{diffError}</div>}
        {stageNotice && <div className="hint warn">{stageNotice}</div>}
        {/* Keyed off !shownDiff (not diffBusy): after a tab click there is one paint before
            the load effect sets busy, and the pane must not flash blank in between. Gated on
            diffEnabled — with loading intentionally disabled (runner offline), an indefinite
            "Loading…" would be a lie; say what's actually happening. */}
        {!shownDiff && !diffError && diffEnabled && <div className="muted">Loading diff…</div>}
        {!shownDiff && !diffError && diffSupported && !diffEnabled && (
          <div className="muted">Diff unavailable while the runner is offline — it reloads on reconnect.</div>
        )}
        {shownDiff && (
          <GitDiffViewer
            diff={shownDiff}
            staging={staging}
            layout={layout}
            onOpenSourceLocation={onOpenSourceLocation}
            onAttachWorkspaceReference={onAttachWorkspaceReference}
            review={{
              findings,
              creating: creatingFinding,
              busyFindingId: findingBusyId,
              onCreate: createFinding,
              onStatus: updateFinding,
            }}
          />
        )}
      </div>

      <section className="review-findings" aria-label="Inline Review Findings">
        <div className="review-findings-head">
          <div>
            <strong>Review Findings</strong>
            {findingSummary && (
              <span className={`review-state review-state-${findingSummary.completion}`}>
                {findingSummary.completion === "blocked"
                  ? `${findingSummary.requiredUnresolved} required unresolved`
                  : findingSummary.completion === "in_review"
                    ? `${findingSummary.unresolved} optional unresolved`
                    : "complete"}
              </span>
            )}
          </div>
          <div className="review-findings-actions">
            <button className="btn ghost sm" disabled={bundlingFindings} onClick={() => void loadFindings()}>↻ Refresh</button>
            <button
              className="btn ghost sm"
              disabled={bundlingFindings || syncingGitHub || !runnerOnline || !session.worktreePath || !reviewSyncSupported}
              title={reviewSyncSupported
                ? `Import the current ${requestName}'s ${mergeRequest ? "GitLab" : "GitHub"} review threads (read-only)`
                : runnerCapabilityRequirement(runnerProtocolVersion, mergeRequest ? "forgeIntegration" : "githubReviewReconciliation", `${mergeRequest ? "GitLab" : "GitHub"} review reconciliation`)}
              onClick={() => void syncForgeFindings()}
            >
              {syncingGitHub ? `Syncing ${mergeRequest ? "GitLab" : "GitHub"}…` : `Sync ${mergeRequest ? "GitLab" : "GitHub"}`}
            </button>
            <button
              className="btn sm"
              disabled={bundlingFindings || selectedFindings.size === 0 || !runnerOnline || isTerminal(session.status)}
              onClick={() => void bundleFindings()}
            >
              {bundlingFindings ? "Sending…" : `Send Selected (${selectedFindings.size})`}
            </button>
          </div>
        </div>
        {findingError && <div className="composer-error">Review findings: {findingError}</div>}
        {findingNotice && <div className="git-ok">✓ {findingNotice}</div>}
        {findings.filter((finding) => finding.status === "open" || finding.status === "sent").length === 0 ? (
          <div className="muted review-findings-empty">Add a comment from any exact diff line to start a review.</div>
        ) : (
          <div className="review-findings-list">
            {findings.filter((finding) => finding.status === "open" || finding.status === "sent").map((finding) => {
              const stale = shownDiff?.diffHash !== finding.diffHash;
              const remoteOnly = finding.remote?.subjectType === "remote";
              const sourcePath = remoteOnly ? null : normalizeSourcePath(finding.filePath);
              const sourceLocation = sourcePath ? {
                path: sourcePath,
                ...(finding.remote?.subjectType === "file" || finding.side !== "right" ? {} : { line: finding.line }),
              } : null;
              const findingLocation = remoteOnly
                ? "Remote Discussion"
                : `${finding.filePath}${finding.remote?.subjectType === "file" ? " (file comment)" : `:${finding.line}`}`;
              return (
                <article className="review-finding-row" key={finding.findingId}>
                  <input
                    type="checkbox"
                    aria-label={remoteOnly
                      ? "Select Remote Discussion"
                      : finding.remote?.subjectType === "file"
                      ? `Select file-level finding on ${finding.filePath}`
                      : `Select finding on ${finding.filePath} line ${finding.line}`}
                    checked={selectedFindings.has(finding.findingId)}
                    disabled={bundlingFindings}
                    onChange={(event) => setSelectedFindings((prior) => {
                      const next = new Set(prior);
                      if (event.target.checked) next.add(finding.findingId); else next.delete(finding.findingId);
                      return next;
                    })}
                  />
                  <div className="review-finding-main">
                    <div className="review-finding-meta">
                      {sourceLocation ? (
                        <button type="button" className="source-path-link" onClick={() => onOpenSourceLocation(sourceLocation)}>
                          <code>{findingLocation}</code>
                        </button>
                      ) : (
                        <code>{findingLocation}</code>
                      )}
                      <span className={`review-severity review-severity-${finding.severity}`}>{titleCaseLabel(finding.severity)}</span>
                      {finding.required && <span className="review-required">Required</span>}
                      {finding.status === "sent" && <span>Sent</span>}
                      {stale && <span className="review-stale">Stale Diff Anchor</span>}
                    </div>
                    <div>{finding.body}</div>
                    <div className="review-finding-provenance">{finding.source === "gitlab" ? "GitLab" : titleCaseLabel(finding.source)} · {finding.author.id ?? titleCaseLabel(finding.author.kind)} · {titleCaseLabel(finding.scope.replaceAll("_", " "))} · {titleCaseLabel(finding.side)}</div>
                    {finding.remote && (
                      <div className="review-finding-provenance">
                        {finding.remote.provider === "gitlab" ? "MR" : "PR"} #{finding.remote.pullRequestNumber}{finding.remote.outdated ? " · Outdated" : ""}{" · "}
                        <a href={finding.remote.url} target="_blank" rel="noreferrer">Open on {finding.remote.provider === "gitlab" ? "GitLab" : "GitHub"}</a>
                      </div>
                    )}
                  </div>
                  <div className="review-finding-row-actions">
                    {finding.remote ? (
                      <span className="muted">Remote-Owned</span>
                    ) : (
                      <>
                        <button className="btn ghost sm" disabled={findingBusyId === finding.findingId} onClick={() => void updateFinding(finding, "resolved")}>Resolve</button>
                        <button className="btn ghost sm" disabled={findingBusyId === finding.findingId} onClick={() => void updateFinding(finding, "dismissed")}>Dismiss</button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="git-action">
        <label htmlFor={commitId}>Commit Message</label>
        <div className="git-inline">
          <input
            id={commitId}
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Describe the change"
          />
          <button className="btn sm" onClick={() => doCommit(false)} disabled={disabled}>
            {busy === "commit" ? "Committing…" : stagedCount > 0 ? "Commit staged" : "Commit"}
          </button>
          {stagedCount > 0 && (
            <button
              className="btn ghost sm"
              onClick={() => doCommit(true)}
              disabled={disabled}
              title="Ignore the staged selection and commit every change in the worktree"
            >
              Commit All
            </button>
          )}
        </div>
        {stagedCount > 0 && (
          <div className="hint">
            {stagedCount} file{stagedCount === 1 ? " has" : "s have"} staged changes — Commit commits only those; unstaged
            edits stay in the worktree.
          </div>
        )}
        {commit && (
          <div className="git-ok">
            ✓ Committed <code>{commit.sha}</code> ({commit.filesChanged} File{commit.filesChanged === 1 ? "" : "s"}
            {commit.stagedOnly ? ", Staged Only" : ""})
          </div>
        )}
      </div>

      <div className="git-action" role="group" aria-label={`Open a ${requestName}`}>
        <label>Open a {requestName}</label>
        <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder={mergeRequest ? "MR title" : "PR title"} aria-label={`${requestShortName} Title`} />
        <textarea
          value={prBody}
          onChange={(e) => setPrBody(e.target.value)}
          placeholder={mergeRequest ? "MR description (optional)" : "PR description (optional)"}
          aria-label={`${requestShortName} Description`}
          rows={2}
        />
        <div className="git-inline">
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="branch name (optional — defaults to the agent branch)"
            aria-label="Branch Name"
          />
          <button className="btn primary sm" onClick={doPr} disabled={disabled}>
            {busy === "pr" ? "Opening…" : `Push & Open ${requestName}`}
          </button>
        </div>
        <div className="hint">Commits any pending changes, pushes the branch, and opens a {requestName.toLowerCase()} (falls back to a validated prefilled link when authenticated forge tooling is unavailable). If you've staged hunks selectively, use Commit first — Push &amp; Open {requestName} won't guess at a partial stage.</div>
        {pr && (
          <div className="git-ok">
            ✓ {(pr.created ?? pr.createdWithGh) ? `${pr.kind === "merge_request" ? "Merge Request" : "Pull Request"} opened` : `Branch pushed — click to open the ${pr.kind === "merge_request" ? "Merge Request" : "Pull Request"}`}:{" "}
            {prHref ? (
              <a href={prHref} target="_blank" rel="noreferrer">{pr.url}</a>
            ) : (
              <code>{pr.url}</code>
            )}
          </div>
        )}
        {pr?.notice && <div className="hint warn">{pr.notice}</div>}
      </div>
    </div>
  );
}
