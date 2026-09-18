import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { normalizeSourcePath, REVIEW_ANCHOR_TEXT_MAX_LENGTH } from "@wollipog/protocol";
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
} from "../diff-view.js";
import { diffAnchorKey, diffHunkContentKey, type DiffAnchor } from "../review-anchors.js";
import { titleCaseLabel } from "../format.js";
import { Spinner } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";

export type DiffLayout = "unified" | "split";
export type DiffPane = "combined" | "unstaged" | "staged";

/**
 * Rich-diff pane (Phase 2). Renders a parsed {@link GitDiffInfo} as a stack of per-file cards:
 * a status badge + path header with an expand/collapse toggle, then the file's hunks as a
 * monospace body with an old/new line-number gutter and +/- coloring. The first few hunks of a
 * file show expanded; the rest sit behind a "N more hunks" row. Binary and untracked files
 * render a short note instead of a patch.
 *
 * When the optional `staging` prop is present (uncommitted scope, quiescent session), each
 * eligible hunk header carries a Stage/Unstage control; without it the viewer is read-only.
 */

/** Per-hunk stage/unstage wiring, present only when staging is currently possible. */
export interface StagingControls {
  onHunk: (direction: "stage" | "unstage", filePath: string, hunkIndex: number) => void;
  onLines: (direction: "stage" | "unstage", filePath: string, hunkIndex: number, lineIndices: number[]) => void;
  onDiscard: (filePath: string) => void;
  pane: DiffPane;
  fineGrained: boolean;
  /** `${filePath}#${hunkIndex}` of the in-flight mutation, or null. One at a time. */
  busyKey: string | null;
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

/** Where the caret sat in a draft's body, as offsets into it. Collapsed when start equals end. */
interface DraftSelection {
  start: number;
  end: number;
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

/** Short badge letter + class suffix for each change kind (drives the badge color in CSS). */
const BADGE: Record<GitDiffFile["status"], { label: string; kind: string }> = {
  added: { label: "A", kind: "added" },
  modified: { label: "M", kind: "modified" },
  deleted: { label: "D", kind: "deleted" },
  renamed: { label: "R", kind: "renamed" },
  untracked: { label: "??", kind: "untracked" },
};

export function GitDiffViewer({
  diff,
  staging,
  review,
  onOpenSourceLocation,
  onAttachWorkspaceReference,
  layout = "unified",
}: {
  diff: GitDiffInfo;
  staging?: StagingControls;
  review?: DiffReviewControls;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  layout?: DiffLayout;
}) {
  // Memoized on the diff object rather than repeated for every re-render the surrounding panel
  // causes (typing a commit message, a status poll landing).
  const files = useMemo(() => groupHunksForDisplay(diff.files, COLLAPSE_THRESHOLD), [diff]);

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
    return (
      <div className="diff-empty muted">
        {diff.scope === "last_turn" ? "No changes in the last turn." : "No changes in this scope."}
      </div>
    );
  }

  return (
    <div className="diff-view">
      <div className="diff-summary muted">
        {diff.stats.filesChanged} File{diff.stats.filesChanged === 1 ? "" : "s"} Changed
        {diff.stats.insertions > 0 && <span className="diff-ins"> +{diff.stats.insertions}</span>}
        {diff.stats.deletions > 0 && <span className="diff-del"> −{diff.stats.deletions}</span>}
      </div>
      {files.map((display) => (
        // Key on the path alone, not the whole-change-set `diffHash`: a card must keep its collapse
        // state and "show all hunks" toggle across a refresh it did not cause (#1203), and neither
        // depends on content — `hiddenCount` is recomputed every render, so a carried `showAll`
        // stays meaningful whatever the hunk count becomes. The state that genuinely must reset when
        // content moves is per-hunk, and `HunkView` is keyed for exactly that.
        <DiffFileCard
          key={display.file.path}
          display={display}
          staging={staging}
          review={review}
          findingsByAnchor={findingsByAnchor}
          drafts={drafts}
          onOpenSourceLocation={onOpenSourceLocation}
          onAttachWorkspaceReference={onAttachWorkspaceReference}
          diffHash={diff.diffHash}
          scope={diff.scope}
          layout={layout}
        />
      ))}
    </div>
  );
}

function DiffFileCard({
  display,
  staging,
  review,
  findingsByAnchor,
  drafts,
  onOpenSourceLocation,
  onAttachWorkspaceReference,
  diffHash,
  scope,
  layout,
}: {
  display: DisplayFile;
  staging?: StagingControls;
  review?: DiffReviewControls;
  findingsByAnchor: ReadonlyMap<string, ReviewFinding[]>;
  drafts: DraftStore;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  diffHash: string;
  scope: GitDiffInfo["scope"];
  layout: DiffLayout;
}) {
  const { file, hunks, hiddenCount } = display;
  const stagedCount = file.hunks.filter((h) => h.staged).length;
  const [expanded, setExpanded] = useState(true);
  // A per-file "show the collapsed tail" toggle, separate from the whole-file collapse above.
  const [showAll, setShowAll] = useState(false);
  // `?? modified` only satisfies noUncheckedIndexedAccess — BADGE is exhaustive over the status union.
  const badge = BADGE[file.status] ?? BADGE.modified;
  const sourcePath = normalizeSourcePath(file.path);

  return (
    <div className="diff-file">
      <div className="diff-file-head-row">
        <button
          className="diff-file-head"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          title={expanded ? "Collapse file" : "Expand file"}
        >
          <span className="chev">{expanded ? "▾" : "▸"}</span>
          <span className={`diff-badge diff-badge-${badge.kind}`}>{badge.label}</span>
          <span className="diff-file-path">
            {file.status === "renamed" && file.oldPath ? (
              <>
                <span className="diff-oldpath">{file.oldPath}</span>
                <span className="diff-arrow"> → </span>
                {file.path}
              </>
            ) : (
              file.path
            )}
          </span>
          {stagedCount > 0 && (
            <span className="diff-staged-count muted">
              {stagedCount}/{file.hunks.length} Staged
            </span>
          )}
        </button>
        {onOpenSourceLocation && sourcePath && file.status !== "deleted" && (
          <button
            type="button"
            className="diff-open-source"
            title={`Open ${file.path}`}
            aria-label={`Open ${file.path}`}
            onClick={() => onOpenSourceLocation({ path: sourcePath })}
          >
            ↗
          </button>
        )}
        {staging?.fineGrained && staging.pane === "combined" && file.status !== "untracked" && (
          <button
            type="button"
            className="diff-discard"
            disabled={staging.busyKey != null}
            title="Discard all staged and unstaged changes to this tracked file"
            onClick={() => staging.onDiscard(file.path)}
          >
            Discard
          </button>
        )}
      </div>

      {expanded && (
        <div className="diff-file-body">
          {file.binary ? (
            <div className="diff-note muted">Binary — Not Patchable</div>
          ) : file.status === "untracked" ? (
            <div className="diff-note muted">untracked file — included by Commit all, or by Commit when nothing is staged</div>
          ) : hunks.length === 0 ? (
            <div className="diff-note muted">
              {file.status === "renamed" ? "renamed — stage/unstage isn't available for renames yet" : "no textual changes"}
            </div>
          ) : (
            <>
              {hunks
                .filter((h) => !h.isCollapsed || showAll)
                .map((h) => (
                  <HunkView
                    // Lineage first: a pane switch is a different change set, so per-hunk line and
                    // reference selections made against one pane must not survive into the other,
                    // even where that file happens to be byte-identical in both. Then the file's
                    // change kind (it decides whether line staging is offered at all) and the hunk's
                    // own content, so a hunk the refresh did not touch is never rebuilt — that is
                    // what keeps an open draft editor's focus and caret.
                    key={`${review?.lineage ?? ""}|${file.status}|${diffHunkContentKey(h.hunk)}`}
                    hunk={h.hunk}
                    filePath={file.path}
                    fileStatus={file.status}
                    index={h.index}
                    staging={stageEligible(file) ? staging : undefined}
                    review={review}
                    findingsByAnchor={findingsByAnchor}
                    drafts={drafts}
                    onOpenSourceLocation={onOpenSourceLocation}
                    onAttachWorkspaceReference={onAttachWorkspaceReference}
                    diffHash={diffHash}
                    scope={scope}
                    layout={layout}
                  />
                ))}
              {hiddenCount > 0 && !showAll && (
                <button className="diff-more" onClick={() => setShowAll(true)}>
                  {hiddenCount} More Hunk{hiddenCount === 1 ? "" : "s"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
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
      body.setSelectionRange(start, end);
    }
    return () => {
      const { selectionStart, selectionEnd } = body;
      if (selectionStart === null || selectionEnd === null) return;
      drafts.rememberSelection(anchorKey, { start: selectionStart, end: selectionEnd });
    };
    // Mount and teardown only: `anchorKey` is this editor's identity, and `drafts` is rebuilt on
    // every render of the viewer root while reading and writing nothing but refs.
  }, [anchorKey]);
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
        <label className="review-required-toggle">
          <input type="checkbox" checked={draft.required} onChange={(event) => update({ required: event.target.checked })} />
          Must Resolve Before Publish
        </label>
        <button className="btn sm" disabled={review.creating || !draft.body.trim()} onClick={() => void submit()}>
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
  onOpenSourceLocation,
  onAttachWorkspaceReference,
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
  onOpenSourceLocation?: (location: SourceLocation) => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  diffHash: string;
  scope: GitDiffInfo["scope"];
  layout: DiffLayout;
}) {
  const rows = buildDiffHunkRows(hunk);
  const key = `${filePath}#${index}`;
  const inFlight = staging?.busyKey === key || staging?.busyKey === `${key}:lines`;
  // One mutation at a time — every hunk button disables while any one is in flight.
  const disabled = staging?.busyKey != null;
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());
  const [selectedReferenceLines, setSelectedReferenceLines] = useState<{ side: "left" | "right"; lines: Set<number> } | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
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
    setSelectedLines(new Set());
  };
  const toggleLine = (sourceIndex: number) => setSelectedLines((prior) => {
    const next = new Set(prior);
    if (next.has(sourceIndex)) next.delete(sourceIndex); else next.add(sourceIndex);
    return next;
  });
  const toggleReferenceLine = (row: DiffHunkRow) => setSelectedReferenceLines((prior) => {
    const lines = prior?.side === row.anchor.side ? new Set(prior.lines) : new Set<number>();
    if (lines.has(row.anchor.line)) lines.delete(row.anchor.line); else lines.add(row.anchor.line);
    return lines.size ? { side: row.anchor.side, lines } : null;
  });
  const referenceLineList = selectedReferenceLines ? [...selectedReferenceLines.lines].sort((a, b) => a - b) : [];
  const referenceSelectionContiguous = referenceLineList.every((line, position) =>
    position === 0 || line === referenceLineList[position - 1]! + 1);
  const attachSelectedLines = async () => {
    if (!onAttachWorkspaceReference || !selectedReferenceLines || !referenceLineList.length || !referenceSelectionContiguous) return;
    setAttachBusy(true);
    try {
      await onAttachWorkspaceReference({
        path: filePath,
        kind: "diff",
        startLine: referenceLineList[0],
        endLine: referenceLineList[referenceLineList.length - 1],
        side: selectedReferenceLines.side,
        diffHash,
        diffScope: scope,
      });
      setSelectedReferenceLines(null);
    } finally {
      setAttachBusy(false);
    }
  };
  const referenceCheckbox = (row: DiffHunkRow) => onAttachWorkspaceReference ? (
    <Checkbox
      checked={selectedReferenceLines?.side === row.anchor.side && selectedReferenceLines.lines.has(row.anchor.line)}
      disabled={attachBusy}
      label={`Select ${row.anchor.side === "left" ? "base" : "worktree"} line ${row.anchor.line} for prompt`}
      onChange={() => toggleReferenceLine(row)}
    />
  ) : null;

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
              <span className={`review-severity review-severity-${finding.severity}`}>{titleCaseLabel(finding.severity)}</span>
              {finding.required && <span className="review-required">Required</span>}
              <span>{titleCaseLabel(finding.source)} · {finding.author.id ?? titleCaseLabel(finding.author.kind)} · {titleCaseLabel(finding.status)}</span>
            </div>
            <div className="diff-inline-finding-body">{finding.body}</div>
            <div className="diff-inline-finding-actions">
              {(finding.status === "open" || finding.status === "sent") ? (
                <>
                  <button className="btn ghost sm" disabled={review?.busyFindingId === finding.findingId} onClick={() => void review?.onStatus(finding, "resolved")}>Resolve</button>
                  <button className="btn ghost sm" disabled={review?.busyFindingId === finding.findingId} onClick={() => void review?.onStatus(finding, "dismissed")}>Dismiss</button>
                </>
              ) : (
                <button className="btn ghost sm" disabled={review?.busyFindingId === finding.findingId} onClick={() => void review?.onStatus(finding, "open")}>Reopen</button>
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

  const commentButton = (row: DiffHunkRow) => review ? (
    <button
      type="button"
      className="diff-comment-add"
      aria-label={`Comment on ${filePath} ${row.anchor.side} line ${row.anchor.line}`}
      title="Add inline review finding"
      onClick={() => drafts.toggle(drafts.keyFor({ filePath, ...row.anchor }), row.text)}
    >
      +
    </button>
  ) : null;
  const sourcePath = normalizeSourcePath(filePath);
  const sourceGutter = (row: DiffHunkRow, value: string, className: string) =>
    onOpenSourceLocation && sourcePath && fileStatus !== "deleted" && row.anchor.side === "right" && value ? (
      <button
        type="button"
        className={`${className} diff-source-gutter`}
        title={`Open ${filePath}:${row.anchor.line}`}
        aria-label={`Open ${filePath} line ${row.anchor.line}`}
        onClick={() => onOpenSourceLocation({ path: sourcePath, line: row.anchor.line })}
      >
        {value}
      </button>
    ) : <span className={className}>{value}</span>;

  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">
        <span className="diff-hunk-header-text">{hunk.header}</span>
        {onAttachWorkspaceReference && (
          <button
            className="hunk-act"
            type="button"
            disabled={attachBusy || referenceLineList.length === 0 || !referenceSelectionContiguous}
            title={!referenceSelectionContiguous ? "Select a contiguous range on one diff side" : "Attach Selected Lines to Prompt"}
            onClick={() => void attachSelectedLines()}
          >
            {attachBusy ? <Spinner /> : `Attach Selected (${referenceLineList.length})`}
          </button>
        )}
        {staging && (
          <span className="hunk-actions">
            {staging.pane === "combined" ? (
              <>
                {hunk.staged && <span className="hunk-staged-chip">Staged ✓</span>}
                <button
                  type="button"
                  className="hunk-act"
                  disabled={disabled}
                  title={hunk.staged && fileStatus === "added" ? "Unstage (the file becomes untracked)" : undefined}
                  onClick={() => staging.onHunk(hunk.staged ? "unstage" : "stage", filePath, index)}
                >
                  {inFlight ? <Spinner /> : hunk.staged ? "Unstage" : "Stage"}
                </button>
              </>
            ) : lineDirection && (
              <>
                <button className="hunk-act" type="button" disabled={disabled} onClick={() => mutateLines(changeIndices)}>
                  {inFlight ? <Spinner /> : `${lineDirection === "stage" ? "Stage" : "Unstage"} hunk`}
                </button>
                <button className="hunk-act" type="button" disabled={disabled || selectedLines.size === 0} onClick={() => mutateLines([...selectedLines].sort((a, b) => a - b))}>
                  {lineDirection === "stage" ? "Stage" : "Unstage"} Selected ({selectedLines.size})
                </button>
              </>
            )}
          </span>
        )}
      </div>
      <div className={`diff-hunk-lines diff-layout-${layout}`}>
        {layout === "unified" ? rows.map((row, i) => (
          <Fragment key={i}>
            <div className={`diff-line diff-line-${row.status === "+" ? "add" : row.status === "-" ? "del" : "ctx"}`}>
              <span className="diff-line-select">
                {referenceCheckbox(row)}
                {lineDirection && row.status !== " " && (
                  <input type="checkbox" checked={selectedLines.has(row.sourceIndex)} disabled={disabled} aria-label={`Select ${row.status === "+" ? "added" : "removed"} line ${row.anchor.line}`} onChange={() => toggleLine(row.sourceIndex)} />
                )}
              </span>
              <span className="diff-gutter diff-gutter-old">{row.oldNo}</span>
              {sourceGutter(row, row.newNo, "diff-gutter diff-gutter-new")}
              <span className="diff-sign">{row.status === " " ? "" : row.status}</span>
              <span className="diff-text">{lineText(row)}</span>
              {commentButton(row)}
            </div>
            {reviewExtras(row.anchor, row.text, `unified-${i}`)}
            {/* A context row is anchorable from the old side too, and a carried finding or draft can
                sit there — see `buildDiffAnchorIndex`, which indexes exactly this anchor. */}
            {row.status === " " && reviewExtras({ side: "left", line: Number(row.oldNo) }, row.text, `unified-${i}-left`)}
          </Fragment>
        )) : buildSplitDiffRows(hunk).map((pair, pairIndex) => (
          <Fragment key={pairIndex}>
            <div className="diff-split-row">
              {[pair.left, pair.right].map((row, sideIndex) => row ? (
                <div className={`diff-split-cell diff-line-${row.status === "+" ? "add" : row.status === "-" ? "del" : "ctx"}`} key={sideIndex}>
                  <span className="diff-line-select">
                    {referenceCheckbox(row)}
                    {lineDirection && row.status !== " " && (
                      <input type="checkbox" checked={selectedLines.has(row.sourceIndex)} disabled={disabled} aria-label={`Select ${row.status === "+" ? "added" : "removed"} line ${row.anchor.line}`} onChange={() => toggleLine(row.sourceIndex)} />
                    )}
                  </span>
                  {sourceGutter(row, sideIndex === 0 ? row.oldNo : row.newNo, "diff-gutter")}
                  <span className="diff-sign">{row.status === " " ? "" : row.status}</span>
                  <span className="diff-text">{lineText(row)}</span>
                  {(row.status !== " " || sideIndex === 1) && commentButton(row)}
                </div>
              ) : <div className="diff-split-cell diff-split-empty" key={sideIndex} />)}
            </div>
            {/* No `status !== " "` guard: `buildSplitDiffRows` gives a context row a left anchor at
                its old line number, and that anchor can hold a carried finding or draft. */}
            {pair.left && reviewExtras(pair.left.anchor, pair.left.text, `split-left-${pairIndex}`)}
            {pair.right && reviewExtras(pair.right.anchor, pair.right.text, `split-right-${pairIndex}`)}
          </Fragment>
        ))}
        {hunk.noNewlineAtEof && <div className="diff-line diff-nonl muted">\ No newline at end of file</div>}
      </div>
    </div>
  );
}
