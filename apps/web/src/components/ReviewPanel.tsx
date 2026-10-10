import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Notice } from "./Notice.js";
import {
  isPolicyApproval,
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type CreateReviewFindingRequest,
  type CreateWorkspaceReferenceRequest,
  type GitDiffInfo,
  type GitDiffScope,
  type GitForgeInfo,
  type GitPrInfo,
  type GitStatusInfo,
  type GitChecksSummary,
  type GitPrSummary,
  type ReviewFinding,
  type ReviewFindingsResponse,
  type SessionView,
  type SourceLocation,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { describeGitFailure, type GitFailure } from "../git-failure.js";
import { useApi } from "../api-context.js";
import { formatClock } from "../format.js";
import {
  GitDiffViewer,
  StageRaceNotice,
  type DiffFileFocus,
  type DiffFileNotice,
  type DiffLayout,
  type DiffPane,
  type StagingControls,
} from "./GitDiffViewer.js";
import { SPLIT_MIN_PANEL_PX, usePanelAtLeast } from "./usePanelWidth.js";
import type { GitStatus } from "./useGitStatus.js";
import {
  changeSetSignature,
  reanchorFindingStore,
  EMPTY_FINDING_ANCHOR_STORE,
  type FindingAnchorStore,
} from "../review-anchors.js";
import { useFeedback } from "./FeedbackProvider.js";
import { CommitBar, type CommitBarBusy, type CommitBarNotice, type RequestLink } from "./CommitBar.js";
import { OpenRequestDialog } from "./OpenRequestDialog.js";
import { sessionAgentLabel } from "./agent-options.js";
import { safeExternalHref } from "../external-href.js";
import { sourceKind } from "../pinned-summary.js";
import { runnerDisplay } from "../runners.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { useOptionalStoreSelector } from "../store.js";
import { Spinner } from "./common.js";
import { DiffIcon, FolderIcon, RefreshIcon } from "./Icons.js";
// RightPanel renders this module too; the slot is only read at render time, so the cycle is inert.
import { PanelHeaderActions } from "./RightPanel.js";
import { PanelToolLayout } from "./PanelToolLayout.js";
import { FindingSelectionBar, ReviewFindings, type FindingSyncControl } from "./ReviewFindings.js";
import { forgeName, isOpenFinding } from "../review-finding-copy.js";
import { ReviewSummary } from "./ReviewSummary.js";
import { ReviewToolbar } from "./ReviewToolbar.js";
import { StaleContent } from "./StaleContent.js";
import { State } from "./State.js";
import {
  clearPanelScratchIf,
  panelScratchRevision,
  readPanelScratch,
  usePanelScratchChoice,
  usePanelScratchDraft,
  usePanelScratchScope,
} from "../right-panel-scratch.js";

/** No diff on screen means nothing is anchored; one shared empty set keeps that allocation-free. */
const NO_ANCHORED_FINDINGS: ReadonlySet<string> = new Set<string>();
const NO_COLLAPSED_FILES: ReadonlySet<string> = new Set<string>();

/** The last segment of a path, which a stage race notice names. */
const fileNameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * How often the diff re-reads itself while a turn is running. The status reader deliberately stops
 * polling during a turn, so its observation cannot drive the refresh; this bounded cadence is what
 * keeps the pane showing the agent's edits as they land instead of freezing until the turn settles
 * (#1204). Staging controls are withheld during a turn, so nothing here can race a stage reply.
 */
const ACTIVE_TURN_DIFF_RELOAD_MS = 10_000;

const COMMIT_MESSAGE_KEY = "review.commitMessage";
const REQUEST_TITLE_KEY = "review.requestTitle";
const REQUEST_BODY_KEY = "review.requestBody";
const BRANCH_KEY = "review.branch";
const DIFF_SCOPE_KEY = "review.diffScope";

/** The drafts a submit sent, as they stood when it was sent. */
interface SubmittedDrafts {
  scope: string;
  drafts: { key: string; value: string; revision: number }[];
}

/**
 * Taken before the request goes out, for the reason Side Chat takes its own: anything the reviewer
 * types while it is in flight is a new draft, and must survive the submit that went before it.
 */
function captureSubmitted(scope: string, values: Record<string, string>): SubmittedDrafts {
  return {
    scope,
    drafts: Object.entries(values).map(([key, value]) => ({ key, value, revision: panelScratchRevision(scope, key) })),
  };
}

/**
 * Give up the drafts a successful submit consumed (#1375). They are unsent text only until the
 * forge or git holds them; left in scratch, they would keep this session's scope exempt from
 * eviction forever and restore already-submitted text after a reload.
 *
 * The pull request fields reset, through the same consumed-draft path Side Chat uses (#1284), so a
 * body remounted while the request was in flight is emptied too; the result line and its link are
 * what remains. The commit message stays on screen because the next commit usually reuses it — its
 * stored copy goes, so a remount or reload shows the default again.
 */
function releaseSubmitted({ scope, drafts }: SubmittedDrafts): void {
  for (const { key, value, revision } of drafts) {
    clearPanelScratchIf(scope, key, value, revision, { leaveShown: key === COMMIT_MESSAGE_KEY });
  }
}

/** A request the forge still lists as open, so the next push updates it. */
function isOpenRequest(pr: GitPrSummary | null | undefined): boolean {
  return !!pr && ["OPEN", "OPENED", "DRAFT"].includes(pr.state.toUpperCase());
}

/**
 * The summary row for a request this panel just opened (#2847). The forge summary is cached on the
 * runner for a few seconds, so its next read can still say the branch has none; the row shows from
 * the creation result until that read catches up, and the forge's own row replaces it.
 */
function openedRequestSummary(pr: GitPrInfo, title: string): GitPrSummary | null {
  const number = /\/(?:pull|merge_requests)\/(\d+)/.exec(pr.url)?.[1];
  if (!number) return null;
  return {
    number: Number(number),
    title,
    url: pr.url,
    state: "OPEN",
    ...(pr.provider ? { provider: pr.provider } : {}),
    ...(pr.kind ? { kind: pr.kind } : {}),
  };
}

/** Where a request result's link goes, named for the button: "Open on GitHub". */
function requestLink(pr: GitPrInfo, fallbackProvider: "github" | "gitlab" | null): RequestLink {
  const provider = pr.provider ?? fallbackProvider;
  return {
    href: safeExternalHref(pr.url),
    url: pr.url,
    forge: provider === "gitlab" ? "GitLab" : provider === "github" ? "GitHub" : null,
  };
}

/** File-section placeholders while the first diff of a scope loads (§12.3). */
function DiffSkeleton() {
  return (
    <div className="skeleton review-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading changes…</span>
      {[0, 1, 2].map((index) => (
        <div className="review-skeleton-file" key={index} aria-hidden="true">
          <span className="skeleton-bar title" />
          <span className="skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

/**
 * Git / PR workflow for a worktree session: review the worktree status, commit the
 * agent's changes, and push a branch + open a PR — all run on the session's runner.
 * Hosted by the right side panel's "Review" mode (Ctrl+Shift+G). Status is the app-wide
 * shared read (useGitStatus); the diff and its staging state are owned here.
 *
 * Laid out on the panel's slots (#2846): the toolbar fixed above, one scroller holding the notices,
 * the summary, the diff and the findings, and the commit bar fixed in the foot (#2847), whose Open
 * Pull Request… opens a dialog. Its one Refresh is in the panel header.
 */
export function ReviewPanel({
  session,
  runnerOnline,
  runnerProtocolVersion,
  git,
  forge,
  forgeFacts,
  onOpenSourceLocation,
  onAttachWorkspaceReference,
  focus,
  onFocusHandled,
}: {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  git: GitStatus;
  forge?: GitForgeInfo | null;
  /** The branch's pull request and its checks, from the forge summary (`visibleForgeFacts`). */
  forgeFacts?: { pr: GitPrSummary | null; checks: GitChecksSummary | null } | null;
  onOpenSourceLocation: (location: SourceLocation) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  /** A file to bring into view: a transcript edit's Open in Review (#2187). */
  focus?: DiffFileFocus | null;
  onFocusHandled?: () => void;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [busy, setBusy] = useState<CommitBarBusy | null>(null);
  // What the commit bar's buttons last did (#2847): one notice, beside the buttons, newest first.
  const [barNotice, setBarNotice] = useState<CommitBarNotice | null>(null);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const requestDialogOpenRef = useRef(false);
  requestDialogOpenRef.current = requestDialogOpen;
  const [requestFailure, setRequestFailure] = useState<GitFailure | null>(null);
  const [openedRequest, setOpenedRequest] = useState<GitPrSummary | null>(null);
  const openRequestButtonRef = useRef<HTMLButtonElement | null>(null);
  const commitInputRef = useRef<HTMLInputElement | null>(null);
  // Where the dialog returns focus as it closes: its opener, unless that is disabled by then — a
  // successful submit closes it while the status refresh holds the bar — when the commit message,
  // which is never disabled, keeps keyboard position in the bar.
  const [requestDialogReturn] = useState(() => ({
    get current(): HTMLElement | null {
      const opener = openRequestButtonRef.current;
      return opener && opener.isConnected && !opener.disabled ? opener : commitInputRef.current;
    },
  }));
  // The branch's request: one this panel just opened, until the forge reports that same request, else
  // the forge's own. The forge's may be an older, closed request on the same branch, which must not
  // hide the new one.
  const summaryPr = openedRequest ?? forgeFacts?.pr ?? null;
  const forgeRequestNumber = forgeFacts?.pr?.number;
  useEffect(() => {
    if (forgeRequestNumber !== undefined && forgeRequestNumber === openedRequest?.number) setOpenedRequest(null);
  }, [forgeRequestNumber, openedRequest?.number]);
  // The panel stays mounted across a session switch, so the bar's results belong to the session they
  // were for: switching clears them, and a result that lands after the switch is not shown.
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  useEffect(() => {
    setBarNotice(null);
    setOpenedRequest(null);
    setRequestFailure(null);
    setRequestDialogOpen(false);
  }, [session.id]);
  const status = git.status;
  // Everything the reviewer typed or chose outlives this mount: the panel is unmounted by any
  // mode switch and by closing the panel, and losing a pull request description to a glance at
  // Files is exactly the defect in #1202. The four fields of the unsubmitted commit and pull
  // request forms are drafts rather than plain scratch, so visiting other sessions cannot evict
  // this one out from under half a written description either (#1283). Submitting them is what
  // ends that claim (#1375): see `releaseSubmitted`.
  const panelScratch = usePanelScratchScope(session.id);
  const defaultMessage = session.title || "Agent changes";
  const [commitMsg, setCommitMsg] = usePanelScratchDraft(panelScratch, COMMIT_MESSAGE_KEY, defaultMessage);
  const [prTitle, setPrTitle] = usePanelScratchDraft(panelScratch, REQUEST_TITLE_KEY, defaultMessage);
  const [prBody, setPrBody] = usePanelScratchDraft(panelScratch, REQUEST_BODY_KEY);
  const [branch, setBranch] = usePanelScratchDraft(panelScratch, BRANCH_KEY);
  // Rich-diff pane (Phase 2, PR-A). Branch-relative scopes only make sense for worktree sessions;
  // a WSL in-place session has no session branch to diff, so it gets Uncommitted only — which is
  // also why restoring a remembered scope re-checks that this session still offers it.
  // Review opens where the work is (#2846): with nothing uncommitted and the branch ahead, the first
  // scope is Branch. The opening scope is decided once, from the first status read, and is only the
  // choice's default: it is never written to scratch, so the next visit decides again, while any
  // scope the reviewer picks that differs from it (Uncommitted after opening on Branch included) is
  // remembered and wins from then on.
  const [scopeRemembered] = useState(
    () => session.useWorktree !== true || readPanelScratch(panelScratch, DIFF_SCOPE_KEY) !== undefined,
  );
  // A scope the reviewer picks before the first status read lands decides it too: their choice
  // loads at once, and the opening rule never overrides it afterwards.
  const [scopePicked, setScopePicked] = useState(false);
  const [openingScope, setOpeningScope] = useState<GitDiffScope | null>(null);
  useLayoutEffect(() => {
    if (scopeRemembered || scopePicked || openingScope !== null) return;
    if (!status && !git.settled) return;
    setOpeningScope(status && status.files.length === 0 && status.ahead > 0 ? "all_branch" : "uncommitted");
  }, [git.settled, openingScope, scopePicked, scopeRemembered, status]);
  const scopeDecided = scopeRemembered || scopePicked || openingScope !== null;
  const [scope, setStoredScope] = usePanelScratchChoice<GitDiffScope>(
    panelScratch,
    DIFF_SCOPE_KEY,
    openingScope ?? "uncommitted",
    (raw) => raw === "uncommitted" || (session.useWorktree === true && (raw === "all_branch" || raw === "last_turn")),
  );
  const setScope = (next: GitDiffScope) => {
    setScopePicked(true);
    setStoredScope(next);
  };
  const [pane, setPane] = usePanelScratchChoice<DiffPane>(
    panelScratch, "review.indexPane", "combined",
    (raw) => raw === "combined" || raw === "unstaged" || raw === "staged",
  );
  const [layout, setLayout] = usePanelScratchChoice<DiffLayout>(
    panelScratch, "review.diffLayout", "unified", (raw) => raw === "unified" || raw === "split",
  );
  // View Options' Wrap Long Lines and Collapse All Files (#2848). Side by Side is offered only while
  // the panel can hold its two columns; narrower, the stored choice waits and Unified renders.
  const [wrapChoice, setWrapChoice] = usePanelScratchChoice<"wrap" | "scroll">(
    panelScratch, "review.wrapLines", "scroll", (raw) => raw === "wrap" || raw === "scroll",
  );
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const splitFits = usePanelAtLeast(scrollElement, SPLIT_MIN_PANEL_PX);
  const shownLayout: DiffLayout = splitFits ? layout : "unified";
  // Collapsed files by path, so a refresh with the same files keeps them; another session starts open.
  const [collapsed, setCollapsed] = useState<{ sessionId: string; paths: ReadonlySet<string> }>(
    () => ({ sessionId: session.id, paths: new Set<string>() }),
  );
  const collapsedPaths = collapsed.sessionId === session.id ? collapsed.paths : NO_COLLAPSED_FILES;
  const setCollapsedPaths = (paths: ReadonlySet<string>) => setCollapsed({ sessionId: session.id, paths });
  const [diff, setDiff] = useState<GitDiffInfo | null>(null);
  /** Completed diff reads, so a request can tell a read that landed after it from one before. */
  const [diffReads, setDiffReads] = useState(0);
  const [diffBusy, setDiffBusy] = useState(false);
  /** When the diff on screen was read, for the offline notice's "This review is from". */
  const [diffReadAt, setDiffReadAt] = useState<number | null>(null);
  /** The header Refresh's own reload of status, diff and findings together. */
  const [refreshing, setRefreshing] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Per-hunk staging (PR-B): the in-flight mutation's `${path}#${index}` key.
  const [hunkBusy, setHunkBusy] = useState<string | null>(null);
  // The newest stage race, at the top of its file's section (#2848): one at a time, the newest wins.
  const [fileNotice, setFileNotice] = useState<{ sessionId: string; path: string; message: string } | null>(null);
  // An automatic reload (#1204) never hijacks the error surface — but it must not fail silently
  // either, or the diff below would keep contradicting the header with nothing to say why. This
  // drives the manual refresh affordance instead.
  const [autoReloadFailed, setAutoReloadFailed] = useState(false);
  // Which findings are still attached to the line they were written against, per lineage (#1203).
  // One slot per scope+pane, so leaving a lineage and coming back does not lose what it carried.
  const [anchors, setAnchors] = useState<FindingAnchorStore>(EMPTY_FINDING_ANCHOR_STORE);
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [findingsLoaded, setFindingsLoaded] = useState(false);
  // Nothing is selected until the reviewer selects it (#2850): a selection hands the panel's foot to
  // the selection bar, so a default selection would hide the commit bar whenever findings are open.
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [findingBusyId, setFindingBusyId] = useState<string | null>(null);
  const [creatingFinding, setCreatingFinding] = useState(false);
  const [bundlingFindings, setBundlingFindings] = useState(false);
  // How many findings the running send carries, which the bar keeps showing even if a reload
  // settles some of them meanwhile.
  const [sendingCount, setSendingCount] = useState(0);
  const [syncingGitHub, setSyncingGitHub] = useState(false);
  const [findingError, setFindingError] = useState<string | null>(null);
  const [findingNotice, setFindingNotice] = useState<string | null>(null);
  // Send to Agent's result and failure, shown in the selection bar beside the button (#2850).
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const findingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectionBarWasShown = useRef(false);
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

  const loadStatus = () => git.refresh();
  const diffSupported = runnerSupportsProtocol(runnerProtocolVersion, "richDiff");
  const stagingSupported = runnerSupportsProtocol(runnerProtocolVersion, "hunkStaging");
  const fineDiffSupported = runnerSupportsProtocol(runnerProtocolVersion, "fineGrainedDiff");
  const githubReviewSupported = runnerSupportsProtocol(runnerProtocolVersion, "githubReviewReconciliation");
  const forgeReviewSupported = runnerSupportsProtocol(runnerProtocolVersion, "forgeIntegration");
  const remoteKind = sourceKind(status?.remoteUrl);
  const hostedGitLab = remoteKind === "gitlab";
  const forgeProvider = forge?.provider ?? (hostedGitLab ? "gitlab" : "github");
  // A pre-v106 runner treats GitLab as generic Git. Preserve that established action surface until
  // the runner advertises the forge contract; otherwise the web client would promise MR creation
  // while dispatching to a runner that can only push a branch.
  const mergeRequest = forgeProvider === "gitlab" && forgeReviewSupported;
  const requestName = mergeRequest ? "Merge Request" : "Pull Request";
  // Names a result's link for an older runner that doesn't say which forge it used.
  const linkProvider = forge?.provider ?? (remoteKind === "github" || remoteKind === "gitlab" ? remoteKind : null);
  // Findings sync only with a forge this repository has a remote on (#2850): the forge facts the
  // runner reports, else a github.com or gitlab.com remote URL. A plain Git remote has nothing to sync.
  const syncForge = forge?.provider ?? (remoteKind === "github" || remoteKind === "gitlab" ? remoteKind : null);
  // GitLab threads need the forge contract; GitHub ones also come through the older reconciliation.
  const reviewSyncSupported = syncForge === "gitlab" ? forgeReviewSupported : forgeReviewSupported || githubReviewSupported;
  const diffHint = runnerCapabilityRequirement(runnerProtocolVersion, "richDiff", "rich diff loading");
  const stagingHint = runnerCapabilityRequirement(runnerProtocolVersion, "hunkStaging", "hunk staging");
  const fineDiffHint = runnerCapabilityRequirement(runnerProtocolVersion, "fineGrainedDiff", "staged panes, line staging, and discard");
  const diffEnabled = runnerOnline && !!session.worktreePath && diffSupported && scopeDecided;
  // Every Git action below is refused to a person the server would refuse (#1870). The ref is read
  // after Discard's confirmation closes, so a refusal that arrives while it is open sends nothing.
  const gitRefusal = sessionCommandRefusal(session, "gitActions");
  const gitRefusalId = `${uid}-git-refusal`;
  const gitRefusalRef = useRef(gitRefusal);
  gitRefusalRef.current = gitRefusal;

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
      setDiffReadAt(Date.now());
      setDiffReads((reads) => reads + 1);
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
    setDiffReadAt(Date.now());
    setDiffReads((reads) => reads + 1);
    setDiffError(null);
    // This reply IS a successful paired read of both halves, so any earlier warning that the diff
    // had fallen behind the file list is now answered.
    setAutoReloadFailed(false);
  };

  const installFindings = (next: ReviewFindingsResponse) => {
    setFindings(next.findings);
    setFindingsLoaded(true);
    const unresolved = new Set(next.findings.filter(isOpenFinding).map((finding) => finding.findingId));
    setSelectedFindings((prior) => {
      const kept = [...prior].filter((findingId) => unresolved.has(findingId));
      return kept.length === prior.size ? prior : new Set(kept);
    });
  };

  const loadFindings = async () => {
    const request = ++findingReqRef.current;
    try {
      const next = await api.reviewFindings(session.id);
      if (request !== findingReqRef.current) return;
      installFindings(next);
      setFindingError(null);
    } catch (cause) {
      if (request === findingReqRef.current) setFindingError((cause as Error).message);
    }
  };

  useEffect(() => {
    setFindings([]);
    setFindingsLoaded(false);
    setSelectedFindings(new Set());
    setFindingNotice(null);
    setSentNotice(null);
    setSendError(null);
    void loadFindings();
    return () => { findingReqRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session.id]);

  const findingRefusal = sessionCommandRefusal(session, "manageReviewFindings");
  const findingRefusalId = "review-findings-refusal";
  const createFinding = async (input: CreateReviewFindingRequest): Promise<boolean> => {
    if (findingRefusal !== null) return false;
    setCreatingFinding(true);
    setFindingError(null);
    setFindingNotice(null);
    try {
      const next = await api.createReviewFinding(session.id, input);
      findingReqRef.current += 1;
      installFindings(next);
      return true;
    } catch (cause) {
      setFindingError((cause as Error).message);
      return false;
    } finally {
      setCreatingFinding(false);
    }
  };

  const updateFinding = async (finding: ReviewFinding, status: "open" | "resolved" | "dismissed") => {
    if (findingRefusal !== null) return;
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

  const agentLabel = session.agentName || session.agentId
    ? sessionAgentLabel(session.agentName, session.driver, session.agentId)
    : "the owning agent";
  // Send to Agent posts into the session (#2850). With the panel expanded over the chat column
  // (#2845) that message lands out of sight, so the selection bar says what was sent, to whom,
  // in the panel itself; the panel stays expanded over the review the person is working through.
  const sendUnavailable = !runnerOnline
    ? "Reconnect to send findings to the agent."
    : isTerminal(session.status) ? "This session has ended, so it can't take findings." : null;
  const bundleFindings = async () => {
    const selected = findings.filter((finding) => selectedFindings.has(finding.findingId) && isOpenFinding(finding));
    if (!selected.length || findingRefusal !== null || sendUnavailable !== null) return;
    setBundlingFindings(true);
    setSendingCount(selected.length);
    setSendError(null);
    setSentNotice(null);
    const startedFor = session.id;
    try {
      const next = await api.bundleReviewFindings(session.id, {
        findings: selected.map((finding) => ({ findingId: finding.findingId, expectedUpdatedAt: finding.updatedAt })),
      });
      if (sessionIdRef.current !== startedFor) return;
      findingReqRef.current += 1;
      installFindings(next);
      setSelectedFindings(new Set());
      setSentNotice(`Sent ${selected.length} finding${selected.length === 1 ? "" : "s"} to ${agentLabel}.`);
    } catch (cause) {
      if (sessionIdRef.current !== startedFor) return;
      setSendError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) void loadFindings();
    } finally {
      setBundlingFindings(false);
    }
  };
  const selectFinding = (findingId: string, checked: boolean) => {
    // A new selection is a new action: the last send's result goes.
    setSentNotice(null);
    setSendError(null);
    setSelectedFindings((prior) => {
      const next = new Set(prior);
      if (checked) next.add(findingId); else next.delete(findingId);
      return next;
    });
  };
  // The selection bar replaces the commit bar while findings are selected, while a send runs (a
  // Sync or Refresh that settles the selected findings meanwhile must not take the busy button
  // away), and while it holds the result of the last send.
  const selectionBarShown = selectedFindings.size > 0 || bundlingFindings || sentNotice !== null || sendError !== null;
  // Clear, a notice's Dismiss, or a reload that settles every selected finding takes the bar away
  // under the focus it may hold; focus then goes back to the findings it was about, not to the page.
  useLayoutEffect(() => {
    const wasShown = selectionBarWasShown.current;
    selectionBarWasShown.current = selectionBarShown;
    if (!wasShown || selectionBarShown) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    findingsTriggerRef.current?.focus({ preventScroll: true });
  });

  const syncForgeFindings = async () => {
    if (gitRefusal !== null) return;
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
    if (barUnavailable()) return;
    setBusy(all ? "commit_all" : "commit");
    // The bar's last result goes as the next action starts, so a stale one never reads as this one's.
    setBarNotice(null);
    const startedFor = session.id;
    const current = () => sessionIdRef.current === startedFor;
    const submitted = captureSubmitted(panelScratch, { [COMMIT_MESSAGE_KEY]: commitMsg });
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
      if (current()) setBarNotice(d.commit ? { kind: "committed", commit: d.commit } : null);
      releaseSubmitted(submitted);
      await loadStatus();
      await loadDiff();
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && e.code === "GIT_STALE") {
        // The staged set moved under the button's label: refresh, and say so beside the button.
        setBarNotice({ kind: "stale" });
        void loadStatus();
        void loadDiff();
      } else {
        setBarNotice({
          kind: "failed",
          failure: describeGitFailure("commit", (e as Error).message, requestName),
          onRetry: () => void gitActionsRef.current.doCommit(all),
        });
      }
    } finally {
      setBusy(null);
    }
  };

  /** Stage/unstage one hunk against the exact diff on screen; the reply carries a fresh read. */
  const doStageHunk = async (direction: "stage" | "unstage", filePath: string, hunkIndex: number) => {
    if (!diff || diff.scope !== "uncommitted" || gitRefusal !== null) return;
    setHunkBusy(`${filePath}#${hunkIndex}`);
    setFileNotice(null);
    try {
      const d = await api.gitStageHunk(session.id, { direction, filePath, hunkIndex, diffHash: diff.diffHash });
      installMutationRead(d);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "GIT_STALE" || e.code === "GIT_APPLY_FAILED")) {
        // A race, not a failure: the worktree or index moved. Say so on the file, and refetch.
        setFileNotice({
          sessionId: session.id,
          path: filePath,
          message: `${fileNameOf(filePath)} changed after this diff loaded, so the hunk wasn't ${direction === "stage" ? "staged" : "unstaged"}.`,
        });
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
    if (!diff?.fineDiffHash || diff.scope !== "uncommitted" || gitRefusal !== null) return;
    setHunkBusy(`${filePath}#${hunkIndex}:lines`);
    setFileNotice(null);
    try {
      const d = await api.gitStageLines(session.id, {
        direction, filePath, hunkIndex, lineIndices, diffHash: diff.fineDiffHash,
      });
      installMutationRead(d);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "GIT_STALE" || e.code === "GIT_APPLY_FAILED")) {
        setFileNotice({
          sessionId: session.id,
          path: filePath,
          message: `${fileNameOf(filePath)} changed after this diff loaded, so the lines weren't ${direction === "stage" ? "staged" : "unstaged"}.`,
        });
        void loadDiff();
        void loadStatus();
      } else setDiffError((e as Error).message);
    } finally {
      setHunkBusy(null);
    }
  };

  /**
   * Restore a reviewed tracked file to its last commit, or delete a file this change adds (§7.4).
   * The confirmation names the file as a row, and says which of the two will happen (#2848).
   */
  const doDiscardFile = async (filePath: string, newFile: boolean) => {
    if (!diff?.fineDiffHash || diff.scope !== "uncommitted" || gitRefusal !== null) return;
    const detailRows = [{ label: filePath, labelStyle: "mono" as const }];
    const confirmed = newFile
      ? await confirm({
          title: "Discard New File",
          message: "This file isn't in any commit yet, so discarding it deletes it. This can't be undone.",
          detailRows,
          confirmLabel: "Discard New File",
          tone: "danger",
        })
      : await confirm({
          title: "Discard Changes",
          message: "All staged and unstaged changes to this file go back to its last commit. This can't be undone.",
          detailRows,
          confirmLabel: "Discard Changes",
          tone: "danger",
        });
    if (!confirmed) return;
    if (gitRefusalRef.current !== null) return;
    setHunkBusy(`${filePath}:discard`);
    setFileNotice(null);
    try {
      const d = await api.gitDiscardFile(session.id, { filePath, diffHash: diff.fineDiffHash });
      installMutationRead(d);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "GIT_STALE" || e.code === "GIT_APPLY_FAILED")) {
        setFileNotice({
          sessionId: session.id,
          path: filePath,
          message: `${fileNameOf(filePath)} changed after this diff loaded, so ${newFile ? "it wasn't deleted" : "its changes weren't discarded"}.`,
        });
        void loadDiff();
        void loadStatus();
      } else setDiffError((e as Error).message);
    } finally {
      setHunkBusy(null);
    }
  };

  /**
   * Open a request from the dialog's fields, or push to the branch's open one. Both are the runner's
   * one `open_pr` flow: it commits any pending changes with the bar's message, pushes, and returns
   * the request (an existing one when the branch already has it). Pushing to an open request sends
   * no branch, so it can never rename the branch under it.
   */
  const doPr = async (mode: "open" | "push") => {
    if (barUnavailable()) return;
    setBusy(mode);
    setBarNotice(null);
    setRequestFailure(null);
    const startedFor = session.id;
    const current = () => sessionIdRef.current === startedFor;
    // The request a push goes to, as it stood when the push was sent.
    const pushTarget = mode === "push" ? summaryPr : null;
    const title = pushTarget?.title || prTitle;
    // The commit message goes with both: `open_pr` commits any pending changes with it. Pushing to an
    // open request sends none of the dialog's fields, so they stay the reviewer's drafts.
    const submitted = captureSubmitted(panelScratch, mode === "open"
      ? {
          [COMMIT_MESSAGE_KEY]: commitMsg,
          [REQUEST_TITLE_KEY]: prTitle,
          [REQUEST_BODY_KEY]: prBody,
          [BRANCH_KEY]: branch,
        }
      : { [COMMIT_MESSAGE_KEY]: commitMsg });
    try {
      // Pass the visible commit message so the one-click flow's auto-commit of any
      // pending changes uses it (not the PR title).
      const d = await api.git(session.id, mode === "open"
        ? { action: "open_pr", title, body: prBody, branch, message: commitMsg }
        : { action: "open_pr", title, body: "", branch: "", message: commitMsg });
      const pr = d.pr;
      const created = pr?.created ?? pr?.createdWithGh;
      // Only a request that was actually opened holds the text. The fallback link GitHub gets when
      // forge tooling is unavailable carries neither title nor description, so the reviewer still
      // needs both to paste into the page it opens. A push to an open request succeeded once the
      // runner answers, even when forge tooling could not confirm the request: the message it
      // committed with is spent either way. Drafts are released even after a session switch: the
      // captured scope and revisions keep that from touching anything newer.
      if (mode === "push" ? !!pr : created) releaseSubmitted(submitted);
      if (pr && current()) {
        if (mode === "push") {
          // Without forge tooling the runner returns a creation page; the request already exists.
          const url = created ? pr.url : pushTarget?.url ?? pr.url;
          setBarNotice({ kind: "pushed", link: requestLink({ ...pr, url }, linkProvider) });
        } else if (created) {
          setOpenedRequest(openedRequestSummary(pr, title));
          setBarNotice({ kind: "opened", link: requestLink(pr, linkProvider) });
        } else {
          setBarNotice({ kind: "finish", link: requestLink(pr, linkProvider), ...(pr.notice ? { detail: pr.notice } : {}) });
        }
      }
      if (current()) setRequestDialogOpen(false);
      await loadStatus();
      await loadDiff();
    } catch (e) {
      if (!current()) return;
      const failure = describeGitFailure("push", (e as Error).message, requestName);
      // The dialog shows its own failure while it is open; otherwise the bar does, beside the button.
      if (mode === "open" && requestDialogOpenRef.current) setRequestFailure(failure);
      else setBarNotice({ kind: "failed", failure, onRetry: () => void gitActionsRef.current.doPr(mode) });
    } finally {
      setBusy(null);
    }
  };
  // A notice's Try Again runs the action as it is now, with the message and fields on screen.
  const gitActionsRef = useRef({ doCommit, doPr });
  gitActionsRef.current = { doCommit, doPr };

  // The commit bar waits on reads and on the other mutations. hunkBusy included: a Commit clicked
  // while a stage RPC is in flight would land AFTER the stage (the runner queues mutations) and
  // silently become a staged-only commit under a plain "Commit" label. Its own running action is
  // `busy`, which the bar shows on the button that started it.
  const barHeld = git.busy || hunkBusy !== null;
  // A retry or a dialog submit can arrive after the bar's own buttons were disabled, so the actions
  // check the same gates themselves.
  function barUnavailable(): boolean {
    return gitRefusal !== null || !runnerOnline || barHeld || busy !== null;
  }
  // Why the dialog can't open the request right now, as the footer's visible reason (§7.3).
  const requestUnavailable = gitRefusal ?? (runnerOnline ? null : `Reconnect to open the ${requestName.toLowerCase()}.`);

  // Never render a diff under the wrong tab: a scope switch keeps the previous response in state
  // until the new one lands, so gate the viewer on the response's own scope. A same-scope refresh
  // still shows the current diff while reloading (stale-while-revalidate).
  // Open in Review (#2187): each request re-reads the diff, because the one on screen may predate
  // the edit. Only a read that lands after the request may decide the file is absent.
  const [focusRead, setFocusRead] = useState<{ request: number; readsBefore: number } | null>(null);
  useEffect(() => {
    if (!focus) return;
    setFocusRead({ request: focus.request, readsBefore: diffReads });
    void loadDiff({ background: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.request]);
  const focusSettled = focus != null && focusRead?.request === focus.request && diffReads > focusRead.readsBefore;
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
          refusal: gitRefusal === null ? null : { reason: gitRefusal, id: gitRefusalId },
        }
      : undefined;
  const stagedCount = status?.stagedCount ?? 0;
  const fileCount = status?.files.length ?? 0;

  const refreshReview = async () => {
    setRefreshing(true);
    try {
      await Promise.all([runnerOnline ? git.refresh() : null, loadDiff(), loadFindings()]);
    } finally {
      setRefreshing(false);
    }
  };
  // Busy for its own reload and for any read someone asked for (a scope switch, the out-of-date
  // notice's Refresh); a background reload never shows here.
  const refreshBusy = refreshing || diffBusy;
  const machineName = useOptionalStoreSelector((state) => runnerDisplay(
    state.runners.get(session.runnerId),
    [...state.boxes.values()].find((box) => box.runnerId === session.runnerId),
    session.runnerId,
  ).name) || "The machine";
  const canPrompt = runnerOnline && !isTerminal(session.status) && !isPolicyApproval(session.pendingApproval);
  // An older runner limits Review in nested steps; only the most limiting one is worth saying.
  const runnerLimit = !diffSupported ? diffHint : !stagingSupported ? stagingHint : !fineDiffSupported ? fineDiffHint : null;
  const readAt = Math.max(diffReadAt ?? 0, git.observedAt ?? 0) || null;
  // A race is about the Uncommitted changes of this session: another scope's diff may hold a file at
  // the same path, which the warning is not about.
  const fileNoticeShown: DiffFileNotice | null = fileNotice?.sessionId !== session.id || scope !== "uncommitted" ? null : {
    path: fileNotice.path,
    message: fileNotice.message,
    refreshing: refreshBusy,
    onRefresh: () => {
      setFileNotice(null);
      void refreshReview();
    },
  };
  const paneShown: DiffPane = scope === "uncommitted" && fineDiffSupported ? pane : "combined";

  const syncControl: FindingSyncControl | null = syncForge === null ? null : {
    forge: syncForge,
    busy: syncingGitHub,
    disabled: bundlingFindings || !runnerOnline || gitRefusal !== null,
    unavailable: reviewSyncSupported
      ? null
      : runnerCapabilityRequirement(
        runnerProtocolVersion,
        syncForge === "gitlab" ? "forgeIntegration" : "githubReviewReconciliation",
        `${forgeName(syncForge)} review sync`,
      ),
    refusal: gitRefusal === null ? null : { reason: gitRefusal, id: gitRefusalId },
    onSync: () => void syncForgeFindings(),
  };

  // Review is meaningless without a working directory to diff (§12.1).
  if (!session.worktreePath) {
    return (
      <PanelToolLayout>
        <State compact icon={<FolderIcon />} title="No Working Folder">
          This session has no folder to compare, so there is nothing to review.
        </State>
      </PanelToolLayout>
    );
  }

  // The scope's own state when its diff is empty (§12.1), each with the sentence that says why.
  const emptyState = scope === "all_branch"
    ? <State compact icon={<DiffIcon />} title="No Changes on This Branch">Nothing on this branch differs from its base.</State>
    : scope === "last_turn"
      ? <State compact icon={<DiffIcon />} title="No Changes in the Last Turn">The agent didn't change any files in its last turn.</State>
      : paneShown === "staged"
        ? <State compact icon={<DiffIcon />} title="No Staged Changes">Nothing is staged yet.</State>
        : paneShown === "unstaged"
          ? <State compact icon={<DiffIcon />} title="No Unstaged Changes">Every change is staged.</State>
          : (
            <State
              compact
              icon={<DiffIcon />}
              title="No Uncommitted Changes"
              actions={session.useWorktree && (status?.ahead ?? 0) > 0 && (
                <button type="button" className="btn sm" onClick={() => setScope("all_branch")}>Show Branch Changes</button>
              )}
            >
              Everything is committed.
            </State>
          );

  return (
    <>
      <PanelHeaderActions>
        <button
          type="button"
          className="icon-btn"
          aria-label="Refresh Review"
          title="Refresh Review"
          aria-busy={refreshBusy || undefined}
          disabled={refreshBusy}
          onClick={() => void refreshReview()}
        >
          {refreshBusy ? <Spinner decorative /> : <RefreshIcon aria-hidden="true" />}
        </button>
      </PanelHeaderActions>
      <PanelToolLayout
        scrollRef={setScrollElement}
        toolbar={(
          <ReviewToolbar
            scope={scope}
            onScopeChange={setScope}
            branchScopes={session.useWorktree === true}
            unavailableReason={diffSupported ? null : diffHint}
            pane={scope === "uncommitted" && fineDiffSupported ? pane : null}
            onPaneChange={setPane}
            layout={layout}
            onLayoutChange={setLayout}
            splitUnavailableReason={splitFits ? null : "Expand the panel to compare side by side."}
            wrap={wrapChoice === "wrap"}
            onWrapChange={(wrap) => setWrapChoice(wrap ? "wrap" : "scroll")}
            files={shownDiff && shownDiff.files.length > 0 ? {
              collapsed: shownDiff.files.every((file) => collapsedPaths.has(file.path)),
              onCollapseAll: (collapse) => setCollapsedPaths(
                collapse ? new Set(shownDiff.files.map((file) => file.path)) : NO_COLLAPSED_FILES,
              ),
            } : null}
            refusal={gitRefusal === null ? null : { reason: gitRefusal, id: gitRefusalId }}
          />
        )}
        // Selecting findings hands the foot to the selection bar (#2850). It replaces the commit bar
        // rather than stacking on it, so the foot never takes two bars' height from the diff; the
        // commit bar's message, notice and running action live in this panel and are all still
        // there when it comes back.
        foot={selectionBarShown ? (
          <FindingSelectionBar
            count={bundlingFindings ? sendingCount : selectedFindings.size}
            busy={bundlingFindings}
            unavailable={sendUnavailable}
            refusal={findingRefusal === null ? null : { reason: findingRefusal, id: findingRefusalId }}
            notice={sentNotice}
            error={sendError}
            onClear={() => setSelectedFindings(new Set())}
            onSend={() => void bundleFindings()}
            onDismissNotice={() => setSentNotice(null)}
            onDismissError={() => setSendError(null)}
          />
        ) : (
          <CommitBar
            message={commitMsg}
            onMessageChange={setCommitMsg}
            stagedCount={stagedCount}
            fileCount={{ count: fileCount, label: `${fileCount}${status?.filesTruncated ? "+" : ""}` }}
            hasChanges={status ? status.hasChanges : null}
            requestName={requestName}
            requestOpen={isOpenRequest(summaryPr)}
            busy={busy}
            disabled={barHeld}
            offline={!runnerOnline}
            refusal={gitRefusal === null ? null : { reason: gitRefusal, id: gitRefusalId }}
            notice={barNotice}
            onDismissNotice={() => setBarNotice(null)}
            onCommit={(all) => void doCommit(all)}
            onOpenRequest={() => {
              setRequestFailure(null);
              setRequestDialogOpen(true);
            }}
            onPushToRequest={() => void doPr("push")}
            openRequestRef={openRequestButtonRef}
            inputRef={commitInputRef}
          />
        )}
      >
        <div className="review-panel">
          {/* Notices first, at the top of the scroller (§13.2): each is one compact line. */}
          {!runnerOnline && (
            <Notice tone="warning" compact role="status">
              {readAt
                ? `${machineName} is offline. This review is from ${formatClock(readAt)}.`
                : `${machineName} is offline. Review loads when it reconnects.`}
            </Notice>
          )}
          {runnerLimit && <Notice tone="neutral" compact role="status">{runnerLimit}</Notice>}
          {/* A failed status refresh keeps the last-known numbers on screen — say so, or the
              stale branch/file count reads as current. */}
          {git.error && (
            <Notice tone="danger" details={<div className="code-well"><pre>{git.error}</pre></div>}>
              {status
                ? "Git status could not be read. The status shown below is the last known result and may be out of date."
                : "Git status could not be read. The current status is unknown."}
            </Notice>
          )}
          {diffError && <Notice tone="danger" compact>{diffError}</Notice>}
          {diffLagsStatus && (
            // Warning only for the failure: it persists until the reviewer acts, while a deferred
            // reload heals itself the moment the mutation settles and must not flash a warning.
            <Notice
              tone={autoReloadFailed ? "warning" : "neutral"}
              compact
              role="status"
              actions={(
                <button type="button" className="btn sm" onClick={() => void loadDiff()} disabled={diffBusy || !runnerOnline || !diffSupported}>
                  Refresh
                </button>
              )}
            >
              These changes may be out of date.
            </Notice>
          )}

          {/* While the runner is offline the last-known review stays readable, dimmed (§12.5). */}
          <StaleContent stale={!runnerOnline} className="review-content">
            <ReviewSummary
              session={session}
              status={status}
              stats={shownDiff?.stats ?? null}
              pr={summaryPr}
              // The forge's checks belong to the forge's request, never to one this panel just opened.
              checks={summaryPr === forgeFacts?.pr ? forgeFacts?.checks ?? null : null}
              canPrompt={canPrompt}
            />
            {/* The review's result, above the diff it is about (#2850). Keyed by session so a switch
                starts from the new session's own default fold. */}
            <ReviewFindings
              key={session.id}
              findings={findings}
              loaded={findingsLoaded}
              anchoredFindingIds={anchoredFindingIds}
              anchorsKnown={shownDiff !== null}
              scope={shownDiff ? scope : null}
              selected={selectedFindings}
              onSelect={selectFinding}
              selectionDisabled={bundlingFindings}
              busyFindingId={findingBusyId}
              refusal={findingRefusal === null ? null : { reason: findingRefusal, id: findingRefusalId }}
              onStatus={(finding, next) => void updateFinding(finding, next)}
              onOpenSourceLocation={onOpenSourceLocation}
              agentLabel={agentLabel}
              sync={syncControl}
              notice={findingNotice}
              error={findingError}
              onDismissNotice={() => setFindingNotice(null)}
              triggerRef={findingsTriggerRef}
            />
            <div className="git-diff-section" role="group" aria-label="Changes">
              {/* Keyed off !shownDiff (not diffBusy): after a scope switch there is one paint before
                  the load effect sets busy, and the pane must not flash blank in between. Nothing
                  loads while the runner is offline or too old, and their notices say so. */}
              {/* An empty diff still mounts the viewer: its unsent comment drafts and a pending
                  Open in Review request must outlive a visit to an empty pane or scope. */}
              {shownDiff
                ? (
                  <GitDiffViewer
                    diff={shownDiff}
                    staging={staging}
                    layout={shownLayout}
                    wrap={wrapChoice === "wrap"}
                    collapsedPaths={collapsedPaths}
                    onCollapsedPathsChange={setCollapsedPaths}
                    fileNotice={fileNoticeShown}
                    onOpenSourceLocation={onOpenSourceLocation}
                    onAttachWorkspaceReference={onAttachWorkspaceReference}
                    focus={focus}
                    focusSettled={focusSettled}
                    onFocusHandled={onFocusHandled}
                    empty={emptyState}
                    review={{
                      findings,
                      anchoredFindingIds,
                      lineage: diffLineage,
                      creating: creatingFinding,
                      busyFindingId: findingBusyId,
                      onCreate: createFinding,
                      onStatus: updateFinding,
                      refusal: findingRefusal === null ? null : { reason: findingRefusal, id: findingRefusalId },
                    }}
                  />
                )
                : (
                  <>
                    {/* The viewer shows a race on its file. With no diff on screen (its re-read failed,
                        so the diff error says why), the warning still stands on its own. */}
                    {fileNoticeShown && <StageRaceNotice notice={fileNoticeShown} />}
                    {!diffError && runnerOnline && diffSupported && <DiffSkeleton />}
                  </>
                )}
            </div>
          </StaleContent>

        </div>
      </PanelToolLayout>
      {requestDialogOpen && (
        <OpenRequestDialog
          requestName={requestName}
          title={prTitle}
          onTitleChange={setPrTitle}
          body={prBody}
          onBodyChange={setPrBody}
          branch={branch}
          onBranchChange={setBranch}
          partialStage={stagedCount > 0 && stagedCount < fileCount}
          busy={busy === "open"}
          held={barHeld || (busy !== null && busy !== "open")}
          unavailable={requestUnavailable}
          failure={requestFailure}
          onSubmit={() => void doPr("open")}
          onClose={() => setRequestDialogOpen(false)}
          returnFocusRef={requestDialogReturn}
        />
      )}
    </>
  );
}
