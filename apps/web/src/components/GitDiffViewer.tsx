import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { normalizeSourcePath, REVIEW_ANCHOR_TEXT_MAX_LENGTH } from "@wollipog/protocol";
import { StatusBadge } from "./StatusBadge.js";
import { FindingSeverityBadge } from "./ReviewFindings.js";
import type {
  CreateReviewFindingRequest,
  CreateWorkspaceReferenceRequest,
  GitDiffFile,
  GitDiffInfo,
  GitHunk,
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewFindingStatus,
  SourceLocation,
} from "@wollipog/protocol";
import {
  buildDiffHunkRows,
  buildSplitDiffRows,
  groupHunksForDisplay,
  highlightDiffLine,
  type DiffHunkRow,
  type DiffWordSegment,
  type DisplayFile,
  type SplitDiffRow,
} from "../diff-view.js";
import { diffAnchorKey, diffHunkContentKey, type DiffAnchor } from "../review-anchors.js";
import { diffLineLabel, diffLineRef, type DiffLineRef } from "../diff-line-selection.js";
import { titleCaseLabel } from "../format.js";
import { Spinner } from "./common.js";
import { DiffFileActions, type DiffFileAction } from "./DiffFileActions.js";
import { CheckIcon, ChevronRightIcon, PlusIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { useIsCoarsePointer } from "./useIsMobile.js";

export type DiffLayout = "unified" | "split";
export type DiffPane = "combined" | "unstaged" | "staged";

/**
 * Rich-diff pane (Phase 2). Renders a parsed {@link GitDiffInfo} as flush file sections (#2848):
 * a sticky head with the disclosure chevron, the status letter, the path, the diffstat and the
 * file's actions menu, then the file's hunks as a monospace body with an old/new line-number
 * gutter and +/- coloring. The first few hunks of a file show expanded; the rest sit behind a
 * "N more hunks" row. Binary and untracked files render a short note instead of a patch.
 * Collapsed, the sections are the file index: one dense row each.
 *
 * When the optional `staging` prop is present (uncommitted scope, quiescent session), each
 * eligible hunk header carries a Stage/Unstage control; without it the viewer is read-only.
 */

/** Per-hunk stage/unstage wiring, present only when staging is currently possible. */
export interface StagingControls {
  onHunk: (direction: "stage" | "unstage", filePath: string, hunkIndex: number) => void;
  onLines: (direction: "stage" | "unstage", filePath: string, hunkIndex: number, lineIndices: number[]) => void;
  /** `newFile` is a file this change adds: discarding it deletes it. */
  onDiscard: (filePath: string, newFile: boolean) => void;
  pane: DiffPane;
  fineGrained: boolean;
  /** `${filePath}#${hunkIndex}` of the in-flight mutation, or null. One at a time. */
  busyKey: string | null;
  /** Why the signed-in person may not run Git actions (#1870), and the id of the element that
   * states it; every stage, unstage and discard control is then disabled and described by it. */
  refusal?: { reason: string; id: string } | null;
}

export interface DiffReviewControls {
  findings: ReviewFinding[];
  /**
   * `findingId`s still attached to the line they were written against, from
   * {@link reanchorFindings}. A finding whose own line is untouched keeps rendering inline across
   * an unrelated refresh, which a `diffHash` comparison could not express (#1203).
   */
  anchoredFindingIds: ReadonlySet<string>;
  /**
   * Identity of the change-set on screen — diff scope plus index pane. Unsent drafts are namespaced
   * by it so switching panes cannot re-target typed-but-unsent text at the other pane's same-numbered
   * line, which carries a different anchor identity.
   */
  lineage: string;
  creating: boolean;
  busyFindingId: string | null;
  onCreate: (finding: CreateReviewFindingRequest) => Promise<boolean>;
  onStatus: (finding: ReviewFinding, status: Exclude<ReviewFindingStatus, "sent">) => Promise<void>;
  /** Why the signed-in person may not add or change findings (#1864), and the id of the element
   * that states it; every finding control is then disabled and described by it. */
  refusal?: { reason: string; id: string } | null;
}

/**
 * Select Lines (#2849): which lines are selected, and the two ways to pick one. The selection itself
 * belongs to the host (Review), whose selection bar acts on it.
 */
export interface DiffLineSelectionControls {
  selecting: boolean;
  /** {@link DiffLineRef} keys of the selected lines. */
  selected: ReadonlySet<string>;
  /** A click on a line while selecting: toggle it, or with Shift extend the range to it. */
  onLine: (line: DiffLineRef, extend: boolean) => void;
  /** The line menu's Select Line: turn Select Lines on with this one line. */
  onSelectLine: (line: DiffLineRef) => void;
}

/** The fields of one unsent inline finding. */
export interface DiffDraft {
  body: string;
  severity: ReviewFindingSeverity;
  required: boolean;
  /**
   * The text of the anchored line when this draft was started.
   *
   * A draft survives a refresh as long as its file and line still exist (#1203), which means it can
   * outlive the content it was written about — the agent can rewrite that exact line underneath it.
   * Discarding the text would break the criterion; saying nothing would let the reviewer submit a
   * comment about text that is no longer there. So the draft remembers what it was aimed at and the
   * editor says so when it no longer matches.
   */
  anchorText: string;
}

/** Frozen: every editor with no stored draft seeds its state from this one object. */
const EMPTY_DRAFT: DiffDraft = Object.freeze({ body: "", severity: "major", required: true, anchorText: "" });

/**
 * Where the caret sat in a draft's body, as offsets into it. Collapsed when start equals end.
 *
 * The direction says which end is the anchor: a backwards selection restored as a forward one
 * covers the same text but moves the wrong end on the next Shift+Arrow (#1392).
 */
interface DraftSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

/**
 * Unsent inline-finding drafts, owned by the viewer root instead of by the hunk that renders them.
 *
 * A diff refresh remounts the file cards below (their content changed, or a whole new diff arrived),
 * and per-hunk draft state died with them — staging a hunk in one file discarded a finding being
 * typed in another (#1203). Holding drafts here outlives every such remount.
 *
 * Typed text lives in a ref, not in state: `open` changes identity only when an editor opens or
 * closes, so a keystroke re-renders the one editor rather than the entire diff. Each editor seeds
 * its own local state from {@link read} on mount, which is what restores the text after a remount.
 */
interface DraftStore {
  /** Anchor keys with an open editor. */
  open: ReadonlySet<string>;
  keyFor: (anchor: DiffAnchor) => string;
  read: (key: string) => DiffDraft;
  write: (key: string, draft: DiffDraft) => void;
  /**
   * Where this draft's caret sat when its editor was last torn down, or null if it never had one.
   * Restoring the text alone leaves the caret at the end of it, which is not where the reviewer was
   * writing (#1287), so the caret is carried across a rebuild alongside the text.
   */
  readSelection: (key: string) => DraftSelection | null;
  /** Record the caret of an editor being torn down. Ignored once the draft itself is gone. */
  rememberSelection: (key: string, selection: DraftSelection) => void;
  /** The + control: open the editor for this anchor, or close it if already open. */
  toggle: (key: string, anchorText: string) => void;
  /** The line menu's Add Finding…: open the editor for this anchor, or focus the one already open. */
  show: (key: string, anchorText: string) => void;
  /** Whether this anchor's editor was asked to take focus since it last did: once per ask. */
  takeFocus: (key: string) => boolean;
  /** Cancel — closes the editor but keeps the text, so a mis-click cannot destroy it. */
  dismiss: (key: string) => void;
  /** Submitted successfully — the draft is now a finding, so drop it. */
  clear: (key: string) => void;
}

/** Only plain text changes can be staged per-hunk: a rename's header block would stage the whole
 * rename, and binary/untracked/mode-only files carry no hunks. */
function stageEligible(file: GitDiffFile): boolean {
  return !file.binary && (file.status === "modified" || file.status === "added" || file.status === "deleted");
}

/** How many hunks per file render expanded before the rest collapse behind a "N more" row. */
const COLLAPSE_THRESHOLD = 3;

/** Each change kind's status letter and the word that names it (#2848). Added and Deleted sit in a
 * green and a red wash; the rest are neutral. */
const STATUS: Record<GitDiffFile["status"], { letter: string; word: string }> = {
  added: { letter: "A", word: "Added" },
  modified: { letter: "M", word: "Modified" },
  deleted: { letter: "D", word: "Deleted" },
  renamed: { letter: "R", word: "Renamed" },
  untracked: { letter: "U", word: "Untracked" },
};

/** A request to bring one file's card into view: a transcript edit's Open in Review (#2187). */
export interface DiffFileFocus {
  path: string;
  /** Increases with every request, so asking for the same file again scrolls to it again. */
  request: number;
}

/**
 * The newest stage race (#2848): a stage, unstage or discard the runner refused with `GIT_STALE` or
 * `GIT_APPLY_FAILED`. Shown at the top of the affected file's section; one at a time.
 */
export interface DiffFileNotice {
  path: string;
  message: string;
  onRefresh: () => void;
  /** The diff is reloading, so Refresh waits. */
  refreshing?: boolean;
}

const NO_COLLAPSED: ReadonlySet<string> = new Set<string>();

/** Added and removed line counts for one file's diffstat. */
function fileStat(file: GitDiffFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.status === "+") added += 1;
      else if (line.status === "-") removed += 1;
    }
  }
  return { added, removed };
}

export function GitDiffViewer({
  diff,
  staging,
  review,
  selection,
  focusFallback,
  onOpenSourceLocation,
  onAttachWorkspaceReference,
  layout = "unified",
  wrap = false,
  collapsedPaths,
  onCollapsedPathsChange,
  fileNotice = null,
  focus,
  focusSettled = true,
  onFocusHandled,
  empty,
}: {
  diff: GitDiffInfo;
  staging?: StagingControls;
  review?: DiffReviewControls;
  selection?: DiffLineSelectionControls;
  /** Where focus goes when an open line menu's line, and every file, left the diff. */
  focusFallback?: () => HTMLElement | null;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  layout?: DiffLayout;
  /** Wrap Long Lines: code wraps inside its column instead of scrolling sideways. */
  wrap?: boolean;
  /**
   * Which files are collapsed, by path, when the host owns that choice (Review's Collapse All Files).
   * Keyed by path, so the choice survives a refresh with the same files. Without it the viewer keeps
   * its own.
   */
  collapsedPaths?: ReadonlySet<string>;
  onCollapsedPathsChange?: (next: ReadonlySet<string>) => void;
  fileNotice?: DiffFileNotice | null;
  focus?: DiffFileFocus | null;
  /** This diff was read after the focus request, so a file missing from it is really absent. */
  focusSettled?: boolean;
  /** The focus request was met, or a diff read after it does not hold its file. */
  onFocusHandled?: () => void;
  /** What to show for a diff with no files, in place of the default line (Review's states, #2846).
   * The viewer stays mounted either way, so drafts and focus requests outlive an empty pane. */
  empty?: ReactNode;
}) {
  // Memoized on the diff object rather than repeated for every re-render the surrounding panel
  // causes (typing a commit message, a status poll landing).
  const files = useMemo(() => groupHunksForDisplay(diff.files, COLLAPSE_THRESHOLD), [diff]);
  const focusedPath = focus && files.some((display) => display.file.path === focus.path) ? focus.path : null;
  // A file a fresh read does not hold (committed since, or outside this scope) ends the request
  // rather than waiting to jump the reader later. A diff from before the request may simply
  // predate the edit, so it only waits.
  useEffect(() => {
    if (focus && !focusedPath && focusSettled) onFocusHandled?.();
  }, [focus, focusedPath, focusSettled, onFocusHandled]);
  const [ownCollapsed, setOwnCollapsed] = useState<ReadonlySet<string>>(NO_COLLAPSED);
  const collapsed = collapsedPaths ?? ownCollapsed;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const setCollapsed = onCollapsedPathsChange ?? setOwnCollapsed;
  const setFileExpanded = (path: string, expanded: boolean) => {
    const prior = collapsedRef.current;
    if (prior.has(path) !== expanded) return;
    const next = new Set(prior);
    if (expanded) next.delete(path); else next.add(path);
    collapsedRef.current = next;
    setCollapsed(next);
  };

  const lineage = review?.lineage ?? "";
  // Anchored findings grouped by their anchor, once per diff instead of a scan per rendered row.
  // Rows ask about two anchors each now (a context row carries both a left and a right one), and a
  // filter per row per anchor is the wrong shape for a diff of any size.
  const findingsByAnchor = useMemo(() => {
    const grouped = new Map<string, ReviewFinding[]>();
    for (const finding of review?.findings ?? []) {
      if (!review?.anchoredFindingIds.has(finding.findingId)) continue;
      const key = diffAnchorKey(finding);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(finding); else grouped.set(key, [finding]);
    }
    return grouped;
  }, [review?.findings, review?.anchoredFindingIds]);
  const draftValues = useRef(new Map<string, DiffDraft>());
  // Kept beside the draft text rather than inside it: a caret is editor state, not a field of the
  // finding being written, and holding it apart keeps `write` — which runs on every keystroke from
  // state that predates the current caret — from stamping a stale offset over a live one.
  const draftSelections = useRef(new Map<string, DraftSelection>());
  const [openDrafts, setOpenDrafts] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Never conditional: the hook keeps its own subscription (see useIsMobile).
  const coarse = useIsCoarsePointer();
  const [lineMenu, setLineMenu] = useState<LineMenuTarget | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Add Finding… on an editor that is already open focuses it: a mounted editor's autoFocus has run.
  const draftFocus = useRef<string | null>(null);
  const [, setDraftFocusAsks] = useState(0);
  const focusFallbackRef = useRef(focusFallback);
  focusFallbackRef.current = focusFallback;
  /**
   * A refresh that rewrote the line's hunk rebuilt its number button, or took its file or every file
   * away: the menu was about a line that is no longer there, so it closes rather than float over
   * nothing. Here at the root, so it also runs when the diff became empty and the menu went with it.
   * Focus that was in the menu, or dropped to the page with it, goes to the same line's new number,
   * else its file's head, else the first file's head, else the host's fallback, so it never stays on
   * the page, where Escape would no longer reach the panel.
   */
  useLayoutEffect(() => {
    if (!lineMenu || lineMenu.trigger.isConnected) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || active.closest(".menu")) {
      const label = `${diffLineLabel(lineMenu.ref)} Actions`;
      const sections = [...(rootRef.current?.querySelectorAll<HTMLElement>(".dfile") ?? [])];
      const section = sections.find((candidate) => candidate.dataset.path === lineMenu.ref.filePath);
      const number = [...(section?.querySelectorAll<HTMLButtonElement>("button.diff-num") ?? [])]
        .find((candidate) => candidate.getAttribute("aria-label") === label);
      const target = number ?? section?.querySelector<HTMLElement>(".dfile-toggle")
        ?? sections[0]?.querySelector<HTMLElement>(".dfile-toggle") ?? focusFallbackRef.current?.();
      target?.focus({ preventScroll: true });
    }
    setLineMenu(null);
  });
  const lines: LineControls = {
    selection,
    menuKey: lineMenu?.ref.key ?? null,
    onOpenMenu: setLineMenu,
    hoverAdd: !coarse,
    wrap,
  };
  const drafts: DraftStore = {
    open: openDrafts,
    keyFor: (anchor) => `${lineage}\u0000${diffAnchorKey(anchor)}`,
    read: (key) => draftValues.current.get(key) ?? EMPTY_DRAFT,
    write: (key, draft) => void draftValues.current.set(key, draft),
    readSelection: (key) => draftSelections.current.get(key) ?? null,
    rememberSelection: (key, selection) => {
      // Only while the draft itself survives. Submitting clears the draft in the same commit that
      // unmounts its editor, and a caret outliving its draft would land in the next one written
      // against this anchor.
      if (draftValues.current.has(key)) draftSelections.current.set(key, selection);
    },
    toggle: (key, anchorText) => {
      // Seeded on first open only: reopening an anchor the reviewer already typed against must keep
      // both their text and the line it was aimed at, or the changed-anchor notice below resets too.
      if (!draftValues.current.has(key)) draftValues.current.set(key, { ...EMPTY_DRAFT, anchorText });
      setOpenDrafts((prior) => {
        const next = new Set(prior);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    },
    show: (key, anchorText) => {
      if (!draftValues.current.has(key)) draftValues.current.set(key, { ...EMPTY_DRAFT, anchorText });
      draftFocus.current = key;
      setOpenDrafts((prior) => prior.has(key) ? prior : new Set(prior).add(key));
      setDraftFocusAsks((asks) => asks + 1);
    },
    takeFocus: (key) => {
      if (draftFocus.current !== key) return false;
      draftFocus.current = null;
      return true;
    },
    dismiss: (key) => setOpenDrafts((prior) => {
      if (!prior.has(key)) return prior;
      const next = new Set(prior);
      next.delete(key);
      return next;
    }),
    clear: (key) => {
      draftValues.current.delete(key);
      draftSelections.current.delete(key);
      setOpenDrafts((prior) => {
        if (!prior.has(key)) return prior;
        const next = new Set(prior);
        next.delete(key);
        return next;
      });
    },
  };

  if (files.length === 0) {
    // A race whose re-read left nothing to show still has to be read, above the empty state.
    return (
      <>
        {fileNotice && <StageRaceNotice notice={fileNotice} />}
        {empty !== undefined ? empty : (
          <div className="diff-empty muted">
            {diff.scope === "last_turn" ? "No changes in the last turn." : "No changes in this scope."}
          </div>
        )}
      </>
    );
  }

  // A notice whose file is no longer in this diff still has to be read: it goes above the sections.
  const orphanNotice = fileNotice && !files.some((display) => display.file.path === fileNotice.path) ? fileNotice : null;
  return (
    <div ref={rootRef} className={`diff-view${wrap ? " is-wrapped" : ""}${selection?.selecting ? " is-selecting" : ""}`}>
      {orphanNotice && <StageRaceNotice notice={orphanNotice} flush />}
      {files.map((display) => (
        // Key on the path alone, not the whole-change-set `diffHash`: a section must keep its
        // "show all hunks" toggle across a refresh it did not cause (#1203), and that does not
        // depend on content — `hiddenCount` is recomputed every render, so a carried `showAll`
        // stays meaningful whatever the hunk count becomes. The state that genuinely must reset when
        // content moves is per-hunk, and `HunkView` is keyed for exactly that.
        <DiffFileSection
          key={display.file.path}
          display={display}
          expanded={!collapsed.has(display.file.path)}
          onExpandedChange={setFileExpanded}
          notice={fileNotice?.path === display.file.path ? fileNotice : null}
          staging={staging}
          review={review}
          findingsByAnchor={findingsByAnchor}
          drafts={drafts}
          lines={lines}
          onOpenSourceLocation={onOpenSourceLocation}
          onAttachWorkspaceReference={onAttachWorkspaceReference}
          diffHash={diff.diffHash}
          scope={diff.scope}
          layout={layout}
          focusRequest={display.file.path === focusedPath ? focus?.request : undefined}
          onFocusHandled={onFocusHandled}
        />
      ))}
      {lineMenu && (
        <DiffLineMenu
          // One menu per opening, so a menu opened on another line starts from its first item.
          key={lineMenu.ref.key}
          target={lineMenu}
          onClose={() => setLineMenu(null)}
          review={review}
          drafts={drafts}
          selection={selection}
          onOpenSourceLocation={onOpenSourceLocation}
        />
      )}
    </div>
  );
}

/**
 * A stage race, compact, with Refresh (#2848). An alert: the action the person just took failed.
 * `flush` places it among the flush sections, which span the scroller's side padding.
 */
export function StageRaceNotice({ notice, flush = false }: { notice: DiffFileNotice; flush?: boolean }) {
  return (
    <Notice
      tone="warning"
      compact
      role="alert"
      className={flush ? "dfile-notice" : undefined}
      actions={(
        <button type="button" className="btn sm" disabled={notice.refreshing} onClick={notice.onRefresh}>
          Refresh
        </button>
      )}
    >
      {notice.message}
    </Notice>
  );
}

/** The path in mono, its folder faint and its file name whole: the folder gives way first (§11.3). */
function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="dfile-path" title={path}>
      {slash >= 0 && <span className="dfile-dir">{path.slice(0, slash + 1)}</span>}
      <span className="dfile-name">{path.slice(slash + 1)}</span>
    </span>
  );
}

function DiffFileSection({
  display,
  expanded,
  onExpandedChange,
  notice,
  staging,
  review,
  findingsByAnchor,
  drafts,
  lines,
  onOpenSourceLocation,
  onAttachWorkspaceReference,
  diffHash,
  scope,
  layout,
  focusRequest,
  onFocusHandled,
}: {
  display: DisplayFile;
  expanded: boolean;
  onExpandedChange: (path: string, expanded: boolean) => void;
  notice: DiffFileNotice | null;
  staging?: StagingControls;
  review?: DiffReviewControls;
  findingsByAnchor: ReadonlyMap<string, ReviewFinding[]>;
  drafts: DraftStore;
  lines: LineControls;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  diffHash: string;
  scope: GitDiffInfo["scope"];
  layout: DiffLayout;
  focusRequest?: number;
  onFocusHandled?: () => void;
}) {
  const { file, hunks, hiddenCount } = display;
  const sectionRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLButtonElement>(null);
  const stagedCount = file.hunks.filter((h) => h.staged).length;
  // A per-file "show the collapsed tail" toggle, separate from the whole-file collapse.
  const [showAll, setShowAll] = useState(false);
  // `?? modified` only satisfies noUncheckedIndexedAccess — STATUS is exhaustive over the status union.
  const status = STATUS[file.status] ?? STATUS.modified;
  const stat = fileStat(file);
  const sourcePath = normalizeSourcePath(file.path);
  const focusHandledRef = useRef(onFocusHandled);
  focusHandledRef.current = onFocusHandled;
  // Open in Review: open this file, scroll it to the top and focus its head, once per request.
  useLayoutEffect(() => {
    if (focusRequest === undefined) return;
    onExpandedChange(file.path, true);
    sectionRef.current?.scrollIntoView?.({ block: "start" });
    headRef.current?.focus({ preventScroll: true });
    focusHandledRef.current?.();
    // Once per request: `onExpandedChange` is rebuilt with every render of the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);
  // Choosing a collapsed file opens it at the top of the scroller, which is what makes the collapsed
  // sections an index (#2848). Only the person's own choice scrolls, once it has rendered open.
  const scrollOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (!expanded || !scrollOnOpen.current) return;
    scrollOnOpen.current = false;
    sectionRef.current?.scrollIntoView?.({ block: "start" });
  }, [expanded]);
  const toggle = () => {
    scrollOnOpen.current = !expanded;
    onExpandedChange(file.path, !expanded);
  };

  // The file's actions (#2848). An action that cannot run on this file stays listed with its reason.
  const gone = file.status === "deleted" ? "The file was deleted." : undefined;
  const openInFiles: DiffFileAction | undefined = onOpenSourceLocation && sourcePath
    ? { label: "Open in Files", run: () => onOpenSourceLocation({ path: sourcePath }), unavailableReason: gone }
    : undefined;
  const attach: DiffFileAction | undefined = onAttachWorkspaceReference
    ? { label: "Attach File to Prompt", run: () => void onAttachWorkspaceReference({ path: file.path, kind: "file" }), unavailableReason: gone }
    : undefined;
  // Discard returns a tracked file to its last commit, or deletes a file this change adds. An
  // untracked file has no state to return to and its content is not shown, so it is never offered.
  const newFile = file.status === "added";
  const discard: DiffFileAction | undefined = staging?.fineGrained && staging.pane === "combined" && file.status !== "untracked"
    ? {
        label: newFile ? "Discard New File…" : "Discard Changes…",
        run: () => staging.onDiscard(file.path, newFile),
        unavailableReason: staging.refusal?.reason
          ?? (staging.busyKey != null ? "Wait for the current change to finish." : undefined),
      }
    : undefined;

  return (
    <section className="dfile" ref={sectionRef} data-path={file.path}>
      <div className="dfile-head">
        <button
          ref={headRef}
          type="button"
          className="dfile-toggle"
          onClick={toggle}
          aria-expanded={expanded}
        >
          <ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
          <span
            className={file.status === "added" ? "dfile-status is-added" : file.status === "deleted" ? "dfile-status is-deleted" : "dfile-status"}
            title={status.word}
          >
            <span aria-hidden="true">{status.letter}</span>
            <span className="sr-only">{status.word}</span>
          </span>
          <FilePath path={file.path} />
          {file.status === "renamed" && file.oldPath && (
            <span className="dfile-from" title={file.oldPath}>from {file.oldPath}</span>
          )}
          {stagedCount > 0 && (
            <span className="dfile-staged">{stagedCount}/{file.hunks.length} Staged</span>
          )}
          {(stat.added > 0 || stat.removed > 0) && (
            <span className="dfile-stat">
              <span className="diff-ins" aria-hidden="true">+{stat.added}</span>
              <span className="diff-del" aria-hidden="true">−{stat.removed}</span>
              <span className="sr-only">{stat.added} added, {stat.removed} removed</span>
            </span>
          )}
        </button>
        <DiffFileActions path={file.path} openInFiles={openInFiles} attach={attach} discard={discard} />
      </div>
      {notice && <StageRaceNotice notice={notice} flush />}

      {expanded && (
        <div className="dfile-body">
          {file.binary ? (
            <p className="diff-note">Binary file, so there is no text to show.</p>
          ) : file.status === "untracked" ? (
            <p className="diff-note">New file, not tracked yet. Commit All Changes includes it.</p>
          ) : hunks.length === 0 ? (
            <p className="diff-note">
              {file.status === "renamed" ? "Renamed. Staging isn't available for renames yet." : "No text changes."}
            </p>
          ) : (
            <>
              {hunks
                .filter((h) => !h.isCollapsed || showAll)
                .map((h) => (
                  <HunkView
                    // Lineage first: a pane switch is a different change set, so nothing a hunk holds
                    // for one pane survives into the other, even where that file happens to be
                    // byte-identical in both. Then the file's change kind (it decides whether line
                    // staging is offered at all) and the hunk's own content, so a hunk the refresh did
                    // not touch is never rebuilt — that is what keeps an open draft editor's focus and
                    // caret.
                    key={`${review?.lineage ?? ""}|${file.status}|${diffHunkContentKey(h.hunk)}`}
                    hunk={h.hunk}
                    filePath={file.path}
                    fileStatus={file.status}
                    index={h.index}
                    staging={stageEligible(file) ? staging : undefined}
                    review={review}
                    findingsByAnchor={findingsByAnchor}
                    drafts={drafts}
                    lines={lines}
                    diffHash={diffHash}
                    scope={scope}
                    layout={layout}
                  />
                ))}
              {hiddenCount > 0 && !showAll && (
                <button type="button" className="diff-more" onClick={() => setShowAll(true)}>
                  {hiddenCount} More Hunk{hiddenCount === 1 ? "" : "s"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The inline finding editor for one anchor.
 *
 * Its own component, holding the fields in local state and mirroring every change into the viewer's
 * draft store. That keeps a keystroke's re-render to this editor — the store's typed text is a ref —
 * while the store is what survives a file card remount, reseeding this state on mount.
 */
function DiffCommentEditor({
  anchorKey,
  anchorText,
  drafts,
  review,
  scope,
  diffHash,
  filePath,
  anchor,
}: {
  anchorKey: string;
  /** The anchored line's text in the diff on screen right now. */
  anchorText: string;
  drafts: DraftStore;
  review: DiffReviewControls;
  scope: GitDiffInfo["scope"];
  diffHash: string;
  filePath: string;
  anchor: DiffAnchor;
}) {
  const [draft, setDraft] = useState<DiffDraft>(() => drafts.read(anchorKey));
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * The caret's hand-off across a rebuild.
   *
   * A refresh that rewrites the drafted hunk rebuilds this editor, and the restored body arrives
   * with the caret at the end of it — not where the reviewer was writing (#1287). So the outgoing
   * editor records its caret as it is torn down, which is the one moment the live offset is known
   * without watching every keystroke, and the incoming one puts it back.
   *
   * The offset is read from the store here rather than from the `draft` seeded above: that seed is
   * computed while rendering, and the outgoing editor's teardown does not run until the commit.
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const remembered = drafts.readSelection(anchorKey);
    if (remembered) {
      // Clamped to the text that actually came back, so an offset the body no longer reaches lands
      // at its end instead of throwing.
      const limit = body.value.length;
      const end = Math.min(remembered.end, limit);
      const start = Math.min(remembered.start, end);
      body.setSelectionRange(start, end, remembered.direction);
    }
    return () => {
      const { selectionStart, selectionEnd, selectionDirection } = body;
      if (selectionStart === null || selectionEnd === null) return;
      drafts.rememberSelection(anchorKey, {
        start: selectionStart,
        end: selectionEnd,
        direction: selectionDirection ?? "none",
      });
    };
    // Mount and teardown only: `anchorKey` is this editor's identity, and `drafts` is rebuilt on
    // every render of the viewer root while reading and writing nothing but refs.
  }, [anchorKey]);
  // The line menu's Add Finding… on this open editor: it takes focus, as a new one does on mount.
  useLayoutEffect(() => {
    if (drafts.takeFocus(anchorKey)) bodyRef.current?.focus();
  });
  // The draft survived a refresh that rewrote the very line it targets. Keeping the text is the
  // point (#1203), but submitting it silently would attach a comment written about content that is
  // no longer on that line, so say so and let the reviewer decide.
  const anchorMoved = draft.anchorText !== anchorText;
  const update = (changes: Partial<DiffDraft>) => {
    const next = { ...draft, ...changes };
    setDraft(next);
    drafts.write(anchorKey, next);
  };
  const submit = async () => {
    if (!draft.body.trim()) return;
    const created = await review.onCreate({
      scope,
      diffHash,
      filePath,
      side: anchor.side,
      line: anchor.line,
      // The line as it reads right now, not as it read when the draft was opened: the finding is
      // filed against the diff on screen, and `anchorMoved` above is what tells the reviewer the two
      // diverged. Stored so the finding can prove its own line is untouched after a reload, with no
      // client-side anchor history to consult (#1286) — omitted past the ceiling rather than
      // rejected there, which leaves such a finding on the pre-#1286 hash fallback.
      ...(anchorText.length <= REVIEW_ANCHOR_TEXT_MAX_LENGTH ? { anchorText } : {}),
      body: draft.body,
      severity: draft.severity,
      required: draft.required,
    });
    if (created) drafts.clear(anchorKey);
  };

  return (
    <div className="diff-comment-editor">
      {anchorMoved && (
        <div className="hint warn" role="status">
          This line changed after you started writing — check that the comment still applies.
        </div>
      )}
      <textarea
        ref={bodyRef}
        value={draft.body}
        onChange={(event) => update({ body: event.target.value })}
        rows={3}
        maxLength={4000}
        placeholder="Describe the concrete issue and expected fix"
        autoFocus
      />
      <div className="diff-comment-editor-controls">
        <label>
          Severity
          <select
            value={draft.severity}
            onChange={(event) => update({ severity: event.target.value as ReviewFindingSeverity })}
          >
            <option value="blocker">Blocker</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
            <option value="nit">Nit</option>
          </select>
        </label>
        <Checkbox className="review-required-toggle" label="Must Resolve Before Publish" checked={draft.required}
          onChange={(required) => update({ required })} />
        <button className="btn sm" disabled={review.creating || !draft.body.trim() || Boolean(review.refusal)}
          title={review.refusal?.reason} aria-describedby={review.refusal?.id} onClick={() => void submit()}>
          {review.creating ? "Adding…" : "Add Finding"}
        </button>
        <button className="btn ghost sm" disabled={review.creating} onClick={() => drafts.dismiss(anchorKey)}>Cancel</button>
      </div>
    </div>
  );
}

function HunkView({
  hunk,
  filePath,
  fileStatus,
  index,
  staging,
  review,
  findingsByAnchor,
  drafts,
  lines,
  diffHash,
  scope,
  layout,
}: {
  hunk: GitHunk;
  filePath: string;
  fileStatus: GitDiffFile["status"];
  index: number;
  staging?: StagingControls;
  review?: DiffReviewControls;
  findingsByAnchor: ReadonlyMap<string, ReviewFinding[]>;
  drafts: DraftStore;
  lines: LineControls;
  diffHash: string;
  scope: GitDiffInfo["scope"];
  layout: DiffLayout;
}) {
  const rows = buildDiffHunkRows(hunk);
  const hunkKey = diffHunkContentKey(hunk);
  const key = `${filePath}#${index}`;
  const inFlight = staging?.busyKey === key || staging?.busyKey === `${key}:lines`;
  // One mutation at a time — every hunk button disables while any one is in flight.
  const refusal = staging?.refusal ?? null;
  const disabled = staging?.busyKey != null || refusal !== null;
  const lineDirection = staging?.fineGrained && staging.pane !== "combined" && fileStatus === "modified"
    ? (staging.pane === "unstaged" ? "stage" : "unstage")
    : null;
  const changeIndices = hunk.lines
    .map((line, sourceIndex) => ({ line, sourceIndex }))
    .filter(({ line }) => line.status !== " ")
    .map(({ sourceIndex }) => sourceIndex);
  const mutateLines = (lineIndices: number[]) => {
    if (!staging || !lineDirection || lineIndices.length === 0) return;
    staging.onLines(lineDirection, filePath, index, lineIndices);
  };
  const selecting = lines.selection?.selecting === true;

  const syntax = (text: string) => highlightDiffLine(filePath, text).map((segment, segmentIndex) => (
    <span className={`diff-syntax-${segment.kind}`} key={segmentIndex}>{segment.text}</span>
  ));
  const lineText = (row: DiffHunkRow) => row.wordSegments
    ? row.wordSegments.map((part: DiffWordSegment, partIndex) => (
        <span className={part.changed ? "diff-word-changed" : undefined} key={partIndex}>{syntax(part.text)}</span>
      ))
    : syntax(row.text);
  /**
   * The inline findings and open draft editor belonging to ONE anchor, rendered under its row.
   *
   * Takes the anchor explicitly rather than reading `row.anchor`, because a row can carry two. A
   * context row anchors right in the unified layout and additionally left (from the old gutter) in
   * the split one, and re-anchoring can legitimately carry a finding onto the left side of a line
   * that used to be a deletion and is now unchanged context. With only `row.anchor` such a finding
   * was anchored — correctly, and so bore no stale marker — yet rendered nowhere at all.
   */
  const reviewExtras = (target: { side: "left" | "right"; line: number }, text: string, prefix: string) => {
    // Anchored by finding identity, not by `diffHash` equality: a finding whose own line is
    // byte-identical stays inline through a refresh caused by anything else (#1203).
    const anchored = findingsByAnchor.get(diffAnchorKey({ filePath, ...target })) ?? [];
    const anchorKey = drafts.keyFor({ filePath, ...target });
    return (
      <Fragment key={`${prefix}-extras`}>
        {anchored.map((finding) => (
          <div className={`diff-inline-finding diff-inline-finding-${finding.status}`} key={finding.findingId}>
            <div className="diff-inline-finding-head">
              <FindingSeverityBadge severity={finding.severity} />
              {finding.required && <StatusBadge tone="neutral" noDot label="Required" />}
              <span>{titleCaseLabel(finding.source)} · {finding.author.id ?? titleCaseLabel(finding.author.kind)} · {titleCaseLabel(finding.status)}</span>
            </div>
            <div className="diff-inline-finding-body">{finding.body}</div>
            <div className="diff-inline-finding-actions">
              {(finding.status === "open" || finding.status === "sent") ? (
                <>
                  <button className="btn ghost sm" disabled={review?.busyFindingId === finding.findingId || Boolean(review?.refusal)}
                    title={review?.refusal?.reason} aria-describedby={review?.refusal?.id}
                    onClick={() => void review?.onStatus(finding, "resolved")}>Resolve</button>
                  <button className="btn ghost sm" disabled={review?.busyFindingId === finding.findingId || Boolean(review?.refusal)}
                    title={review?.refusal?.reason} aria-describedby={review?.refusal?.id}
                    onClick={() => void review?.onStatus(finding, "dismissed")}>Dismiss</button>
                </>
              ) : (
                <button className="btn ghost sm" disabled={review?.busyFindingId === finding.findingId || Boolean(review?.refusal)}
                    title={review?.refusal?.reason} aria-describedby={review?.refusal?.id}
                    onClick={() => void review?.onStatus(finding, "open")}>Reopen</button>
              )}
            </div>
          </div>
        ))}
        {drafts.open.has(anchorKey) && review && (
          <DiffCommentEditor
            key={anchorKey}
            anchorKey={anchorKey}
            anchorText={text}
            drafts={drafts}
            review={review}
            scope={scope}
            diffHash={diffHash}
            filePath={filePath}
            anchor={{ filePath, ...target }}
          />
        )}
      </Fragment>
    );
  };

  /**
   * The line number is the line's one button (#2849). At rest it opens the line menu (a sheet on
   * phones), which is how touch acts on a line; while Select Lines is on it toggles the line, and is
   * where a click on the row leaves focus, so Escape still reaches the panel.
   */
  const lineNumber = (ref: DiffLineRef, numbers: ReactNode) => {
    const label = diffLineLabel(ref);
    const selected = lines.selection?.selected.has(ref.key) === true;
    return selecting ? (
      <button
        type="button"
        className="diff-num"
        aria-label={`Select ${label}`}
        aria-pressed={selected}
        onClick={(event) => lines.selection?.onLine(ref, event.shiftKey)}
      >
        {numbers}
      </button>
    ) : (
      <button
        type="button"
        className="diff-num"
        aria-label={`${label} Actions`}
        aria-haspopup="menu"
        aria-expanded={lines.menuKey === ref.key}
        onClick={(event) => lines.onOpenMenu({ ref, fileStatus, addFinding: findable(ref), trigger: event.currentTarget })}
      >
        {numbers}
      </button>
    );
  };
  // Side by Side's old-side copy of an unchanged line takes no new finding: its new side does.
  const findable = (ref: DiffLineRef) => ref.column !== "left" || ref.status !== " ";
  /**
   * Add Finding on hover (#2849): a mouse's shortcut to the line menu's Add Finding…, in the gutter
   * between the numbers and the change marker, never over the code. Its slot is always there, so
   * revealing it moves nothing. Touch has no hover, and uses the line menu instead.
   */
  const addSlot = (ref: DiffLineRef) => !lines.hoverAdd || !review ? null : (
    <span className="diff-add-slot">
      {!selecting && !review.refusal && findable(ref) && (
        <button
          type="button"
          className="diff-add"
          aria-label={`Add Finding on ${diffLineLabel(ref)}`}
          title="Add a finding on this line"
          onClick={() => drafts.toggle(drafts.keyFor({ filePath, side: ref.side, line: ref.line }), ref.text)}
        >
          <PlusIcon size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
  /** While selecting, a click anywhere on the row picks it, and leaves focus on its number. */
  const selectRow = (ref: DiffLineRef) => selecting ? {
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
      lines.selection?.onLine(ref, event.shiftKey);
      event.currentTarget.querySelector<HTMLButtonElement>(".diff-num")?.focus({ preventScroll: true });
    },
  } : {};
  const selectedClass = (ref: DiffLineRef) => lines.selection?.selected.has(ref.key) ? " is-selected" : "";

  const rowKind = (row: DiffHunkRow) => row.status === "+" ? "add" : row.status === "-" ? "del" : "ctx";
  // Whether an anchor carries a finding or an open editor, which renders full width under its row.
  const hasExtras = (target: { side: "left" | "right"; line: number }) =>
    findingsByAnchor.has(diffAnchorKey({ filePath, ...target })) || drafts.open.has(drafts.keyFor({ filePath, ...target }));
  const splitCell = (row: DiffHunkRow | null, sideIndex: 0 | 1, key: number) => {
    if (!row) return <div className="diff-split-cell diff-split-empty" key={key} />;
    const ref = diffLineRef(filePath, hunkKey, sideIndex === 0 ? "left" : "right", row);
    return (
      <div className={`diff-split-cell diff-line-${rowKind(row)}${selectedClass(ref)}`} key={key} {...selectRow(ref)}>
        {lineNumber(ref, <span className="diff-gutter">{sideIndex === 0 ? row.oldNo : row.newNo}</span>)}
        {addSlot(ref)}
        <span className="diff-sign">{row.status === " " ? "" : row.status}</span>
        <span className="diff-text">{lineText(row)}</span>
      </div>
    );
  };
  /* No `status !== " "` guard: `buildSplitDiffRows` gives a context row a left anchor at its old line
     number, and that anchor can hold a carried finding or draft. */
  const pairExtras = (pair: SplitDiffRow, pairIndex: number) => (
    <>
      {pair.left && reviewExtras(pair.left.anchor, pair.left.text, `split-left-${pairIndex}`)}
      {pair.right && reviewExtras(pair.right.anchor, pair.right.text, `split-right-${pairIndex}`)}
    </>
  );
  /**
   * Side by Side (#2848): two columns that each scroll sideways (`.dsplit` > `.side`), so a long line
   * on one side never pushes the other out of the panel. Rows stay level because every row is one
   * line high. A finding or an open editor spans both columns under its row, so the columns break
   * there and resume below it. Each run is keyed by the row it ends on, so opening an editor above
   * another never rebuilds the one below. Wrapped lines differ in height, so with Wrap Long Lines on
   * each pair is a row of its own instead.
   */
  const splitRuns = () => {
    const pairs = buildSplitDiffRows(hunk);
    if (lines.wrap) {
      return (
        <div className="dsplit is-wrapped">
          {pairs.map((pair, pairIndex) => (
            <Fragment key={pairIndex}>
              <div className="dsplit-pair">
                {splitCell(pair.left, 0, 0)}
                {splitCell(pair.right, 1, 1)}
              </div>
              {pairExtras(pair, pairIndex)}
            </Fragment>
          ))}
        </div>
      );
    }
    const runs: { pairs: { pair: SplitDiffRow; index: number }[]; end: number | null }[] = [];
    let run: { pair: SplitDiffRow; index: number }[] = [];
    pairs.forEach((pair, index) => {
      run.push({ pair, index });
      if ((pair.left && hasExtras(pair.left.anchor)) || (pair.right && hasExtras(pair.right.anchor))) {
        runs.push({ pairs: run, end: index });
        run = [];
      }
    });
    if (run.length > 0) runs.push({ pairs: run, end: null });
    return runs.map(({ pairs: runPairs, end }) => (
      <Fragment key={end ?? "tail"}>
        <div className="dsplit">
          <div className="side">{runPairs.map(({ pair, index }) => splitCell(pair.left, 0, index))}</div>
          <div className="side">{runPairs.map(({ pair, index }) => splitCell(pair.right, 1, index))}</div>
        </div>
        {end !== null && pairExtras(runPairs[runPairs.length - 1]!.pair, end)}
      </Fragment>
    ));
  };

  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">
        <span className="diff-hunk-header-text" title={hunk.header}>{hunk.header}</span>
        {staging && (
          <span className="hunk-actions">
            {/* At rest the header is the range and one action, on one line at every panel width
                (#2848); single lines are staged from the selection bar (#2849). */}
            {staging.pane === "combined" ? (
              <>
                {hunk.staged && (
                  <span className="hunk-staged"><CheckIcon size={14} aria-hidden="true" />Staged</span>
                )}
                <button
                  type="button"
                  className="btn sm ghost hunk-stage"
                  disabled={disabled}
                  aria-busy={inFlight || undefined}
                  title={refusal?.reason ?? (hunk.staged && fileStatus === "added" ? "Unstage (the file becomes untracked)" : undefined)}
                  aria-describedby={refusal?.id}
                  onClick={() => staging.onHunk(hunk.staged ? "unstage" : "stage", filePath, index)}
                >
                  {inFlight ? <Spinner /> : hunk.staged ? "Unstage Hunk" : "Stage Hunk"}
                </button>
              </>
            ) : lineDirection && (
              <button className="btn sm ghost hunk-stage" type="button" disabled={disabled} title={refusal?.reason}
                aria-busy={inFlight || undefined}
                aria-describedby={refusal?.id} onClick={() => mutateLines(changeIndices)}>
                {inFlight ? <Spinner /> : `${lineDirection === "stage" ? "Stage" : "Unstage"} Hunk`}
              </button>
            )}
          </span>
        )}
      </div>
      <div className={`diff-hunk-lines diff-layout-${layout}`}>
        {layout === "unified" ? rows.map((row, i) => {
          const ref = diffLineRef(filePath, hunkKey, "unified", row);
          return (
            <Fragment key={i}>
              <div className={`diff-line diff-line-${rowKind(row)}${selectedClass(ref)}`} {...selectRow(ref)}>
                {lineNumber(ref, (
                  <>
                    <span className="diff-gutter diff-gutter-old">{row.oldNo}</span>
                    <span className="diff-gutter diff-gutter-new">{row.newNo}</span>
                  </>
                ))}
                {addSlot(ref)}
                <span className="diff-sign">{row.status === " " ? "" : row.status}</span>
                <span className="diff-text">{lineText(row)}</span>
              </div>
              {reviewExtras(row.anchor, row.text, `unified-${i}`)}
              {/* A context row is anchorable from the old side too, and a carried finding or draft can
                  sit there — see `buildDiffAnchorIndex`, which indexes exactly this anchor. */}
              {row.status === " " && reviewExtras({ side: "left", line: Number(row.oldNo) }, row.text, `unified-${i}-left`)}
            </Fragment>
          );
        }) : splitRuns()}
        {hunk.noNewlineAtEof && <div className="diff-line diff-nonl muted">\ No newline at end of file</div>}
      </div>
    </div>
  );
}

/** The line a line menu is open for, and the number button that opened it. */
interface LineMenuTarget {
  ref: DiffLineRef;
  fileStatus: GitDiffFile["status"];
  /** Whether this line takes a new finding (not Side by Side's old-side copy of an unchanged line). */
  addFinding: boolean;
  trigger: HTMLButtonElement;
}

/** What every hunk shares for acting on one line: Select Lines, the line menu and the hover "+". */
interface LineControls {
  selection?: DiffLineSelectionControls;
  /** The key of the line whose menu is open, for its trigger's `aria-expanded`. */
  menuKey: string | null;
  onOpenMenu: (target: LineMenuTarget) => void;
  /** A fine pointer: the gutter "+" is offered. */
  hoverAdd: boolean;
  wrap: boolean;
}

/**
 * The line menu (#2849; docs/design-system.md §9.1), one for the whole diff: Add Finding…, Select
 * Line and Open in Files at Line, a bottom sheet on phones. An action this line cannot take stays
 * listed with its reason. It replaced the line number's hidden link to Files.
 */
function DiffLineMenu({ target, onClose, review, drafts, selection, onOpenSourceLocation }: {
  target: LineMenuTarget;
  onClose: () => void;
  review?: DiffReviewControls;
  drafts: DraftStore;
  selection?: DiffLineSelectionControls;
  onOpenSourceLocation?: (location: SourceLocation) => void;
}) {
  const [open, setOpen] = useState(true);
  const menu = useAccessibleMenu(open, setOpen, "diff-line-menu", "item", { reachUnavailable: true });
  // The menu belongs to the number button that opened it: focus goes back there as it closes.
  menu.triggerRef.current = target.trigger;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) closeRef.current();
  }, [open]);
  const { ref, fileStatus } = target;
  const label = `${diffLineLabel(ref)} Actions`;
  const sourcePath = normalizeSourcePath(ref.filePath);
  const filesReason = fileStatus === "deleted"
    ? "The file was deleted."
    : ref.side === "left"
      ? ref.status === "-" ? "This line was removed, so Files can't show it." : "Open the line from its new side."
      : undefined;
  const choose = (run: () => void, focusTrigger = true) => {
    if (focusTrigger) target.trigger.focus();
    menu.close(false);
    run();
  };
  return (
    <MenuSurface
      surfaceRef={menu.menuRef}
      anchor={{ trigger: menu.triggerRef }}
      id={menu.menuId}
      label={label}
      tabIndex={-1}
      onDismiss={() => menu.close(true)}
      onKeyDown={menu.onMenuKeyDown}
    >
      {review && target.addFinding && (
        <MenuItem
          data-menu-label="Add Finding…"
          aria-disabled={review.refusal ? true : undefined}
          description={review.refusal?.reason}
          // The editor opens under the line and takes focus itself.
          onClick={() => { if (!review.refusal) choose(() => drafts.show(drafts.keyFor({ filePath: ref.filePath, side: ref.side, line: ref.line }), ref.text), false); }}
        >
          Add Finding…
        </MenuItem>
      )}
      {selection && (
        <MenuItem data-menu-label="Select Line" onClick={() => choose(() => selection.onSelectLine(ref))}>
          Select Line
        </MenuItem>
      )}
      {onOpenSourceLocation && sourcePath && (
        <MenuItem
          data-menu-label="Open in Files at Line"
          aria-disabled={filesReason ? true : undefined}
          description={filesReason}
          onClick={() => { if (!filesReason) choose(() => onOpenSourceLocation({ path: sourcePath, line: ref.line })); }}
        >
          Open in Files at Line
        </MenuItem>
      )}
    </MenuSurface>
  );
}
