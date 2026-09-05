import { Fragment, useState } from "react";
import { normalizeSourcePath } from "@wollipog/protocol";
import type {
  CreateReviewFindingRequest,
  CreateWorkspaceReferenceRequest,
  GitDiffFile,
  GitDiffInfo,
  GitHunk,
  ReviewFinding,
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
  creating: boolean;
  busyFindingId: string | null;
  onCreate: (finding: CreateReviewFindingRequest) => Promise<boolean>;
  onStatus: (finding: ReviewFinding, status: Exclude<ReviewFindingStatus, "sent">) => Promise<void>;
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
  const files = groupHunksForDisplay(diff.files, COLLAPSE_THRESHOLD);

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
      {files.map((df) => (
        // Key on the diff hash so a file's ephemeral collapse state (expand / "show all")
        // resets whenever the underlying diff changes — otherwise a same-path file returning
        // with a different hunk count across a scope switch or refresh would keep a stale
        // showAll toggle. A byte-identical refetch reuses the same hash, preserving state.
        <DiffFileCard
          key={`${diff.diffHash}:${df.file.path}`}
          display={df}
          staging={staging}
          review={review}
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
  onOpenSourceLocation,
  onAttachWorkspaceReference,
  diffHash,
  scope,
  layout,
}: {
  display: DisplayFile;
  staging?: StagingControls;
  review?: DiffReviewControls;
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
                    key={h.index}
                    hunk={h.hunk}
                    filePath={file.path}
                    fileStatus={file.status}
                    index={h.index}
                    staging={stageEligible(file) ? staging : undefined}
                    review={review}
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

function HunkView({
  hunk,
  filePath,
  fileStatus,
  index,
  staging,
  review,
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
  const [draftTarget, setDraftTarget] = useState<{ side: "left" | "right"; line: number } | null>(null);
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<CreateReviewFindingRequest["severity"]>("major");
  const [required, setRequired] = useState(true);
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
  const submitFinding = async () => {
    if (!review || !draftTarget || !body.trim()) return;
    const created = await review.onCreate({
      scope,
      diffHash,
      filePath,
      side: draftTarget.side,
      line: draftTarget.line,
      body,
      severity,
      required,
    });
    if (created) {
      setDraftTarget(null);
      setBody("");
      setSeverity("major");
      setRequired(true);
    }
  };

  const syntax = (text: string) => highlightDiffLine(filePath, text).map((segment, segmentIndex) => (
    <span className={`diff-syntax-${segment.kind}`} key={segmentIndex}>{segment.text}</span>
  ));
  const lineText = (row: DiffHunkRow) => row.wordSegments
    ? row.wordSegments.map((part: DiffWordSegment, partIndex) => (
        <span className={part.changed ? "diff-word-changed" : undefined} key={partIndex}>{syntax(part.text)}</span>
      ))
    : syntax(row.text);
  const reviewExtras = (row: DiffHunkRow, prefix: string) => {
    const target = row.anchor;
    const anchored = review?.findings.filter((finding) =>
      finding.diffHash === diffHash && finding.filePath === filePath &&
      finding.side === target.side && finding.line === target.line,
    ) ?? [];
    const drafting = draftTarget?.side === target.side && draftTarget.line === target.line;
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
        {drafting && review && (
          <div className="diff-comment-editor">
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} maxLength={4000} placeholder="Describe the concrete issue and expected fix" autoFocus />
            <div className="diff-comment-editor-controls">
              <label>
                Severity
                <select value={severity} onChange={(event) => setSeverity(event.target.value as CreateReviewFindingRequest["severity"])}>
                  <option value="blocker">Blocker</option>
                  <option value="major">Major</option>
                  <option value="minor">Minor</option>
                  <option value="nit">Nit</option>
                </select>
              </label>
              <label className="review-required-toggle">
                <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
                Must Resolve Before Publish
              </label>
              <button className="btn sm" disabled={review.creating || !body.trim()} onClick={() => void submitFinding()}>
                {review.creating ? "Adding…" : "Add Finding"}
              </button>
              <button className="btn ghost sm" disabled={review.creating} onClick={() => setDraftTarget(null)}>Cancel</button>
            </div>
          </div>
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
      onClick={() => setDraftTarget(
        draftTarget?.side === row.anchor.side && draftTarget.line === row.anchor.line ? null : row.anchor,
      )}
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
            {reviewExtras(row, `unified-${i}`)}
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
            {pair.left && pair.left.status !== " " && reviewExtras(pair.left, `split-left-${pairIndex}`)}
            {pair.right && reviewExtras(pair.right, `split-right-${pairIndex}`)}
          </Fragment>
        ))}
        {hunk.noNewlineAtEof && <div className="diff-line diff-nonl muted">\ No newline at end of file</div>}
      </div>
    </div>
  );
}

export default GitDiffViewer;
