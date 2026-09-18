import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  type GitStatusInfo,
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
import {
  changeSetSignature,
  reanchorFindingStore,
  EMPTY_FINDING_ANCHOR_STORE,
  type FindingAnchorStore,
} from "../review-anchors.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { useFeedback } from "./FeedbackProvider.js";
import { sessionAgentLabel } from "./agent-options.js";
import { safeExternalHref } from "../external-href.js";
import { sourceKind } from "../pinned-summary.js";
import { usePanelScratchChoice, usePanelScratchScope, usePanelScratchText } from "../right-panel-scratch.js";

/** No diff on screen means nothing is anchored; one shared empty set keeps that allocation-free. */
const NO_ANCHORED_FINDINGS: ReadonlySet<string> = new Set<string>();

/**
 * How often the diff re-reads itself while a turn is running. The status reader deliberately stops
 * polling during a turn, so its observation cannot drive the refresh; this bounded cadence is what
 * keeps the pane showing the agent's edits as they land instead of freezing until the turn settles
 * (#1204). Staging controls are withheld during a turn, so nothing here can race a stage reply.
 */
const ACTIVE_TURN_DIFF_RELOAD_MS = 10_000;

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
  // Everything the reviewer typed or chose outlives this mount: the panel is unmounted by any
  // mode switch and by closing the panel, and losing a pull request description to a glance at
  // Files is exactly the defect in #1202.
  const panelScratch = usePanelScratchScope(session.id);
  const defaultMessage = session.title || "Agent changes";
  const [commitMsg, setCommitMsg] = usePanelScratchText(panelScratch, "review.commitMessage", defaultMessage);
  const [prTitle, setPrTitle] = usePanelScratchText(panelScratch, "review.requestTitle", defaultMessage);
  const [prBody, setPrBody] = usePanelScratchText(panelScratch, "review.requestBody");
  const [branch, setBranch] = usePanelScratchText(panelScratch, "review.branch");
  const [commit, setCommit] = useState<GitCommitInfo | null>(null);
  const [pr, setPr] = useState<GitPrInfo | null>(null);
  // Rich-diff pane (Phase 2, PR-A). Branch-relative scopes only make sense for worktree sessions;
  // a WSL in-place session has no session branch to diff, so it gets Uncommitted only — which is
  // also why restoring a remembered scope re-checks that this session still offers it.
  const [scope, setScope] = usePanelScratchChoice<GitDiffScope>(
    panelScratch,
    "review.diffScope",
    "uncommitted",
    (raw) => raw === "uncommitted" || (session.useWorktree === true && (raw === "all_branch" || raw === "last_turn")),
  );
  const [pane, setPane] = usePanelScratchChoice<DiffPane>(
    panelScratch, "review.indexPane", "combined",
    (raw) => raw === "combined" || raw === "unstaged" || raw === "staged",
  );
  const [layout, setLayout] = usePanelScratchChoice<DiffLayout>(
    panelScratch, "review.diffLayout", "unified", (raw) => raw === "unified" || raw === "split",
  );
  const [diff, setDiff] = useState<GitDiffInfo | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Per-hunk staging (PR-B): the in-flight mutation's `${path}#${index}` key, and the amber
  // non-fatal notice shown when a stage raced the worktree/index (GIT_STALE / GIT_APPLY_FAILED).
  const [hunkBusy, setHunkBusy] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  // An automatic reload (#1204) never hijacks the error surface — but it must not fail silently
  // either, or the diff below would keep contradicting the header with nothing to say why. This
  // drives the manual refresh affordance instead.
  const [autoReloadFailed, setAutoReloadFailed] = useState(false);
  // Which findings are still attached to the line they were written against, per lineage (#1203).
  // One slot per scope+pane, so leaving a lineage and coming back does not lose what it carried.
  const [anchors, setAnchors] = useState<FindingAnchorStore>(EMPTY_FINDING_ANCHOR_STORE);
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
  // Which change set the loaded diff describes, as the status reader saw it (#1204). Set from the
  // signature captured when the read was *launched*, so a write that landed mid-read still counts
  // as unobserved and schedules another pass.
  const diffSignatureRef = useRef<string | null>(null);
  const statusSignatureRef = useRef<string | null>(null);
  // The busy flag belongs to the newest FOREGROUND read. Any newer request takes ownership away,
  // and whoever takes it must clear the flag: a background reload that superseded a pending
  // foreground one would otherwise leave Refresh stuck on "Loading…" forever, because the
  // superseded request is barred from clearing it and the background winner never sets it.
  const busyOwnerRef = useRef<number | null>(null);
  // How many diff reads are in flight. The active-turn cadence skips a tick while one is pending,
  // so a read slower than the interval cannot have every response superseded by the next request
  // (the pane would never update) or pile up unbounded for the length of the turn.
  const pendingDiffReadsRef = useRef(0);
  const statusSignature = useMemo(() => changeSetSignature(status), [status]);
  statusSignatureRef.current = statusSignature;
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

  /**
   * Read the diff for the scope selected *right now* (see `scopeRef`).
   *
   * `background` marks a reload nobody asked for — a status observation moved the change set, or
   * the active-turn cadence came round. Those skip the busy flag, so the Refresh control and the
   * disabled-while-loading surface don't flicker under the reader, and they leave the current diff
   * on screen when the read fails: a transient error must not blank the pane and take the unsent
   * drafts and anchored findings attached to it with it (#1203). A user-driven read keeps the old
   * behaviour of surfacing the failure.
   */
  const loadDiff = async (options?: { background?: boolean }) => {
    if (!diffEnabled) return;
    const background = options?.background === true;
    const observed = statusSignatureRef.current;
    const reqId = ++diffReqRef.current;
    if (background) {
      // This request just superseded whatever the foreground read was going to render, so the
      // foreground read's busy flag has no owner left to clear it.
      if (busyOwnerRef.current !== null) {
        busyOwnerRef.current = null;
        setDiffBusy(false);
      }
    } else {
      busyOwnerRef.current = reqId;
      setDiffBusy(true);
      setDiffError(null);
    }
    pendingDiffReadsRef.current += 1;
    try {
      const { diff: d } = await api.gitDiff(session.id, scopeRef.current);
      if (diffReqRef.current !== reqId) return; // superseded by a newer scope/refresh
      diffSignatureRef.current = observed;
      setDiff(d);
      setDiffError(null);
      setAutoReloadFailed(false);
    } catch (e) {
      if (diffReqRef.current !== reqId) return;
      if (background) {
        setAutoReloadFailed(true);
        return;
      }
      setAutoReloadFailed(false);
      setDiff(null);
      setDiffError((e as Error).message);
    } finally {
      pendingDiffReadsRef.current -= 1;
      // Only the request that set the flag clears it, so a superseded foreground read cannot report
      // "done" while a newer foreground read is still loading.
      if (busyOwnerRef.current === reqId) {
        busyOwnerRef.current = null;
        setDiffBusy(false);
      }
    }
  };

  /**
   * Install the fresh read a stage / line-stage / discard reply carried.
   *
   * Shared by all three so they agree on what a reply means: the status and the diff in it come
   * from one runner read, so recording that change set keeps the observation watcher below from
   * immediately re-reading a diff that is already current.
   */
  const installMutationRead = (payload: { status?: GitStatusInfo | null; diff?: GitDiffInfo | null }) => {
    if (payload.status) git.install(payload.status);
    if (!payload.diff || scopeRef.current !== "uncommitted") return;
    // The reply IS a fresh read — supersede any in-flight loadDiff so a slower response
    // can't clobber it. Only when installing: if the user switched scope mid-stage, that
    // scope's own loadDiff must stay in charge (bumping here would orphan it and wedge the
    // pane on "Loading diff…").
    diffReqRef.current += 1;
    if (payload.status) diffSignatureRef.current = changeSetSignature(payload.status);
    busyOwnerRef.current = null;
    setDiffBusy(false);
    setDiff(payload.diff);
    setDiffError(null);
    // This reply IS a successful paired read of both halves, so any earlier warning that the diff
    // had fallen behind the file list is now answered.
    setAutoReloadFailed(false);
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

  // A stage / line-stage / discard reply is itself a fresh read, and a Commit or PR run reloads on
  // completion — so a reload launched underneath one would either be superseded by it or supersede
  // it. Defer instead: every deferring condition is a dependency of the watcher below, which runs
  // again the moment the mutation settles (#1204).
  const reloadDeferred = hunkBusy !== null || busy !== null;
  // A diff read that finished before the status reader had reported anything is recorded against a
  // null observation, and stays unread until a real one confirms it. Adopting that first observation
  // instead would be unverified: the status read completes AFTER the diff read, so it can legitimately
  // describe a change set the diff does not have, and the header would sit ahead of the diff in
  // silence. One extra read on panel open is the cheaper mistake.
  const observationUnread = statusSignature !== null && statusSignature !== diffSignatureRef.current;

  // #1204: the branch line, changed-file count, and file list come from the shared status reader;
  // the diff came from its own mount-and-turn-boundary schedule, so an edit from an editor, the
  // terminal dock, or the agent moved one and not the other and the panel contradicted itself.
  // Follow the same observation: when the status reader reports a change set this diff does not
  // describe, re-read it in the background.
  useEffect(() => {
    if (!diffEnabled || !diff) return;
    if (!observationUnread || reloadDeferred) return;
    void loadDiff({ background: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, diffEnabled, diff, observationUnread, reloadDeferred, statusSignature]);

  // During an active turn the status reader stops polling, so the watcher above has nothing to
  // observe — the diff would sit frozen while the agent rewrites the worktree. Re-read it on a
  // bounded cadence instead, and only while the tab is visible so a backgrounded panel is free.
  const reloadDeferredRef = useRef(reloadDeferred);
  reloadDeferredRef.current = reloadDeferred;
  useEffect(() => {
    if (!diffEnabled || !turnActive) return;
    const reload = () => {
      if (reloadDeferredRef.current || pendingDiffReadsRef.current > 0) return;
      if (document.visibilityState !== "visible") return;
      void loadDiff({ background: true });
    };
    const timer = setInterval(reload, ACTIVE_TURN_DIFF_RELOAD_MS);
    // Foregrounding catches up at once rather than waiting out a tick the hidden tab skipped.
    document.addEventListener("visibilitychange", reload);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, diffEnabled, turnActive]);

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
      installMutationRead(d);
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
      installMutationRead(d);
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
      installMutationRead(d);
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
  // Memoized on the response plus the pane that projects it: the viewer keys its file cards and its
  // anchor bookkeeping off this object's identity, so re-minting it for unrelated panel state (a
  // keystroke in the commit message) would throw that work away every render.
  const shownDiff = useMemo(
    () => scopedDiff && scope === "uncommitted" && fineDiffSupported && pane !== "combined"
      ? {
          ...scopedDiff,
          diffHash: pane === "staged"
            ? scopedDiff.stagedDiffHash ?? scopedDiff.diffHash
            : scopedDiff.unstagedDiffHash ?? scopedDiff.diffHash,
          files: pane === "staged" ? scopedDiff.stagedFiles ?? [] : scopedDiff.unstagedFiles ?? [],
          stats: pane === "staged" ? scopedDiff.stagedStats ?? { filesChanged: 0, insertions: 0, deletions: 0 }
            : scopedDiff.unstagedStats ?? { filesChanged: 0, insertions: 0, deletions: 0 },
        }
      : scopedDiff,
    [fineDiffSupported, pane, scope, scopedDiff],
  );

  // Which change set the findings and the unsent drafts belong to. A pane switch is a different
  // lineage even at the same line number: pane-local anchor identities exist so a finding authored
  // against the staged pane is never re-attached to the unstaged one.
  const diffLineage = `${scope}:${scope === "uncommitted" && fineDiffSupported ? pane : "combined"}`;
  // Derived during render and committed with `setState`, the sanctioned way to adjust state when
  // the inputs change: React discards this render and re-runs it immediately, so no frame of
  // wrongly-stale findings is ever painted — and because it is state rather than a ref, an
  // interrupted render's conclusions are abandoned with it instead of becoming the starting point
  // for a render of a diff that was never replaced. `reanchorFindingStore` returns the same store
  // when nothing observable moved, which is what terminates this.
  const nextAnchors = shownDiff
    ? reanchorFindingStore(anchors, shownDiff, diffLineage, findings)
    : anchors;
  if (nextAnchors !== anchors) setAnchors(nextAnchors);
  const anchoredFindingIds = shownDiff
    ? nextAnchors.get(diffLineage)?.anchored ?? NO_ANCHORED_FINDINGS
    : NO_ANCHORED_FINDINGS;

  // Automatic reloads cover the ordinary cases; this is the escape hatch for the two they cannot.
  // Either a reload is deferred behind a mutation reply that owns the pane, or the last automatic
  // one failed — both leave the diff behind a header that already moved, which #1204 requires the
  // panel to admit rather than show silently.
  const diffLagsStatus = !!shownDiff && (autoReloadFailed || (observationUnread && reloadDeferred));

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
          <button className="btn ghost sm" onClick={() => void loadDiff()} disabled={diffBusy || !runnerOnline || !diffSupported}>
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
        {diffLagsStatus && (
          // Amber only for the failure: it persists until the user acts, while a deferred reload
          // heals itself the moment the mutation settles and must not flash a warning to say so.
          <div className={autoReloadFailed ? "hint warn" : "hint"} role="status">
            {autoReloadFailed
              ? "The last automatic refresh of this diff did not land, so it may be older than the file list above."
              : "The changes on disk moved since this diff was read — it reloads once the action in progress finishes."}{" "}
            <button className="btn ghost sm" onClick={() => void loadDiff()} disabled={diffBusy || !runnerOnline || !diffSupported}>
              ↻ Refresh Diff
            </button>
          </div>
        )}
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
              anchoredFindingIds,
              lineage: diffLineage,
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
              // Stale means the anchored content actually moved — not merely that the change-set
              // hash advanced, which every unrelated stage and agent edit does (#1203).
              const stale = !anchoredFindingIds.has(finding.findingId);
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
