import type { GitDiffFile, GitDiffInfo } from "@wollipog/protocol";
import { buildDiffHunkRows, buildSplitDiffRows, type DiffHunkRow } from "./diff-view.js";
import { diffHunkContentKey } from "./review-anchors.js";

/**
 * Review's Select Lines (#2849): which diff lines are selected, and what the selection bar can do
 * with them. Pure, so the rules for Attach to Prompt and Stage Lines are tested apart from the DOM.
 */

/** Where a line was picked: the unified list, or one column of Side by Side. */
export type DiffLineColumn = "unified" | "left" | "right";

/** One selectable line, as it was on screen when it was picked. */
export interface DiffLineRef {
  /** File, hunk content, column and line: the same line in a refreshed diff keeps its key. */
  key: string;
  filePath: string;
  /** {@link diffHunkContentKey} of the line's hunk. A hunk the refresh rewrote drops its lines. */
  hunkKey: string;
  column: DiffLineColumn;
  /** Index into the hunk's `lines`, which line staging takes. */
  sourceIndex: number;
  status: " " | "+" | "-";
  /** The review anchor: removed lines (and Side by Side's left context) are on the left. */
  side: "left" | "right";
  line: number;
  text: string;
}

export function diffLineRef(filePath: string, hunkKey: string, column: DiffLineColumn, row: DiffHunkRow): DiffLineRef {
  return {
    key: `${filePath}\u0000${hunkKey}\u0000${column}\u0000${row.sourceIndex}`,
    filePath,
    hunkKey,
    column,
    sourceIndex: row.sourceIndex,
    status: row.status,
    side: row.anchor.side,
    line: row.anchor.line,
    text: row.text,
  };
}

/**
 * The line's name in controls: "Line 12" on the new side, "Removed Line 11" for a removal, and
 * "Base Line 11" for Side by Side's old-side copy of an unchanged line.
 */
export function diffLineLabel(ref: Pick<DiffLineRef, "side" | "status" | "line">): string {
  if (ref.side === "right") return `Line ${ref.line}`;
  return ref.status === "-" ? `Removed Line ${ref.line}` : `Base Line ${ref.line}`;
}

export interface DiffLineSelection {
  lines: ReadonlyMap<string, DiffLineRef>;
  /** Where a Shift-click range starts: the line last picked on its own. */
  anchor: string | null;
}

export const EMPTY_LINE_SELECTION: DiffLineSelection = Object.freeze({ lines: new Map(), anchor: null });

/** Every line of one file in one column, in reading order: what a Shift-click range runs over. */
export function fileLineRefs(file: GitDiffFile, column: DiffLineColumn): DiffLineRef[] {
  const refs: DiffLineRef[] = [];
  for (const hunk of file.hunks) {
    const hunkKey = diffHunkContentKey(hunk);
    if (column === "unified") {
      for (const row of buildDiffHunkRows(hunk)) refs.push(diffLineRef(file.path, hunkKey, column, row));
      continue;
    }
    for (const pair of buildSplitDiffRows(hunk)) {
      const row = column === "left" ? pair.left : pair.right;
      if (row) refs.push(diffLineRef(file.path, hunkKey, column, row));
    }
  }
  return refs;
}

export function toggleDiffLine(selection: DiffLineSelection, ref: DiffLineRef): DiffLineSelection {
  const lines = new Map(selection.lines);
  if (lines.delete(ref.key)) return { lines, anchor: selection.anchor === ref.key ? null : selection.anchor };
  lines.set(ref.key, ref);
  return { lines, anchor: ref.key };
}

/**
 * Shift-click: select every line from the anchor to this one, in the anchor's file and column. With
 * no anchor there, or the file gone, it picks this line on its own instead.
 */
export function extendDiffLineSelection(
  selection: DiffLineSelection,
  ref: DiffLineRef,
  file: GitDiffFile | undefined,
): DiffLineSelection {
  const anchor = selection.anchor === null ? undefined : selection.lines.get(selection.anchor);
  if (!file || !anchor || anchor.filePath !== ref.filePath || anchor.column !== ref.column) {
    const lines = new Map(selection.lines);
    lines.set(ref.key, ref);
    return { lines, anchor: ref.key };
  }
  const order = fileLineRefs(file, ref.column);
  const from = order.findIndex((candidate) => candidate.key === anchor.key);
  const to = order.findIndex((candidate) => candidate.key === ref.key);
  if (from < 0 || to < 0) return toggleDiffLine(selection, ref);
  const lines = new Map(selection.lines);
  for (const line of order.slice(Math.min(from, to), Math.max(from, to) + 1)) lines.set(line.key, line);
  // The anchor stays, so a second Shift-click re-ranges from the same line.
  return { lines, anchor: anchor.key };
}

/** A selected line placed in the diff on screen now: its file's and its hunk's current positions. */
export interface PlacedDiffLine {
  ref: DiffLineRef;
  fileIndex: number;
  hunkIndex: number;
}

/**
 * The selection as the diff on screen now holds it, in reading order. A line whose file or hunk the
 * refresh rewrote is gone, as the per-hunk boxes it replaced were; the rest keep their place, and
 * their hunk's index is read again, since staging a hunk above them renumbers it.
 */
export function placeDiffLineSelection(selection: DiffLineSelection, diff: GitDiffInfo | null): PlacedDiffLine[] {
  if (!diff || selection.lines.size === 0) return [];
  const hunks = new Map<string, { fileIndex: number; hunkIndex: number }>();
  diff.files.forEach((file, fileIndex) => {
    file.hunks.forEach((hunk, hunkIndex) => {
      hunks.set(`${file.path}\u0000${diffHunkContentKey(hunk)}`, { fileIndex, hunkIndex });
    });
  });
  const placed: PlacedDiffLine[] = [];
  for (const ref of selection.lines.values()) {
    const where = hunks.get(`${ref.filePath}\u0000${ref.hunkKey}`);
    if (where) placed.push({ ref, ...where });
  }
  const columnOrder: Record<DiffLineColumn, number> = { unified: 0, left: 1, right: 2 };
  return placed.sort((a, b) =>
    a.fileIndex - b.fileIndex || a.hunkIndex - b.hunkIndex || a.ref.sourceIndex - b.ref.sourceIndex ||
    columnOrder[a.ref.column] - columnOrder[b.ref.column]);
}

/** Only the lines {@link placeDiffLineSelection} still places; the same object when none went. */
export function liveDiffLineSelection(selection: DiffLineSelection, placed: readonly PlacedDiffLine[]): DiffLineSelection {
  if (placed.length === selection.lines.size) return selection;
  const lines = new Map(placed.map(({ ref }) => [ref.key, ref]));
  return { lines, anchor: selection.anchor !== null && lines.has(selection.anchor) ? selection.anchor : null };
}

/** The exact range Attach to Prompt sends: one file, one side, one continuous run of lines. */
export interface DiffLineAttachRange {
  path: string;
  side: "left" | "right";
  startLine: number;
  endLine: number;
}

export function diffLineAttachRange(placed: readonly PlacedDiffLine[]): DiffLineAttachRange | null {
  const first = placed[0]?.ref;
  if (!first) return null;
  if (placed.some(({ ref }) => ref.filePath !== first.filePath || ref.side !== first.side)) return null;
  const numbers = [...new Set(placed.map(({ ref }) => ref.line))].sort((a, b) => a - b);
  if (numbers.some((line, index) => index > 0 && line !== numbers[index - 1]! + 1)) return null;
  return { path: first.filePath, side: first.side, startLine: numbers[0]!, endLine: numbers.at(-1)! };
}

/**
 * What Stage Lines would send. Unchanged lines in a selection are ignored for staging; the changed
 * ones must all sit in one hunk, because line staging is per hunk.
 */
export type DiffLineStageTarget =
  | { kind: "lines"; filePath: string; hunkIndex: number; lineIndices: number[] }
  | { kind: "unchanged" }
  | { kind: "spread" };

export function diffLineStageTarget(placed: readonly PlacedDiffLine[]): DiffLineStageTarget {
  const changed = placed.filter(({ ref }) => ref.status !== " ");
  const first = changed[0];
  if (!first) return { kind: "unchanged" };
  if (changed.some(({ ref, hunkIndex }) => ref.filePath !== first.ref.filePath || hunkIndex !== first.hunkIndex)) {
    return { kind: "spread" };
  }
  const lineIndices = [...new Set(changed.map(({ ref }) => ref.sourceIndex))].sort((a, b) => a - b);
  return { kind: "lines", filePath: first.ref.filePath, hunkIndex: first.hunkIndex, lineIndices };
}

/** Copy Lines: the selected lines' text in reading order, unchanged lines included. */
export function diffLineCopyText(placed: readonly PlacedDiffLine[]): string {
  return placed.map(({ ref }) => ref.text).join("\n");
}
