import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GitHunk, SkillFile } from "@wollipog/protocol";
import {
  buildDiffHunkRows,
  buildSplitDiffRows,
  highlightDiffLine,
  type DiffHunkRow,
} from "../diff-view.js";
import {
  diffSkillFiles,
  formatBytes,
  lineEndingLabel,
  type SkillFileChange,
  type SkillFileDiffEntry,
} from "../skill-file-diff.js";
import { ChevronRightIcon } from "./Icons.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

/**
 * Split is offered once the diff's container is this wide: a `.modal.lg` review dialog at full width
 * (#1948). The card, not the body, is measured: an 800px card's body is 798px, so a body rule would
 * never offer Split in the dialogs it exists for. Phone sheets and narrow windows stay Unified.
 */
export const SKILL_DIFF_SPLIT_MIN_WIDTH_PX = 800;

/**
 * Marks the pane a diff is read in when it shares its dialog with another pane, such as a list
 * beside the review (#2292). The diff measures that pane instead of the whole card, so Split is
 * offered only when the pane itself is wide enough. Like the card, the pane is measured with its
 * padding, so the same width leaves the diff about as much room in either.
 */
export const SKILL_DIFF_PANE_CLASS = "skill-diff-pane";

type Layout = "unified" | "split";

const CHANGE_LABEL: Record<SkillFileChange, string> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
  unchanged: "Unchanged",
};
const CHANGE_TONE: Record<SkillFileChange, string> = {
  added: "t-success",
  changed: "t-info",
  removed: "t-danger",
  unchanged: "t-neutral",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Whether the diff's container is wide enough for Split: its review pane in a two-pane dialog, else
 * the enclosing dialog card, else (outside a dialog) this element.
 */
function useSplitAvailable(root: React.RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    // The container, never the diff itself: the diff's width follows its content's scrollbar and
    // Split's own height, so measuring it could flip the layout back and forth.
    let target: HTMLElement | null = null;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    const measure = () => {
      // Resolved on every measurement: a dialog's panel moves between its card and a phone sheet.
      const next = element.closest<HTMLElement>(`.${SKILL_DIFF_PANE_CLASS}, .modal`) ?? element;
      if (next !== target) {
        if (target && target !== element) observer?.unobserve(target);
        if (next !== element) observer?.observe(next);
        target = next;
      }
      // Layout width, not the painted box: the dialog opens scaled to 0.98, and a transform never
      // reaches a ResizeObserver, so a transformed measurement would keep Split hidden. It includes
      // the container's scrollbar, so the diff growing or shrinking inside it never changes it.
      setWide(target.offsetWidth >= SKILL_DIFF_SPLIT_MIN_WIDTH_PX);
    };
    measure();
    // The diff itself is observed too, only to learn when it is first placed in a container or moved
    // to another one (a sheet), which neither the old container nor a window resize reports.
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [root]);
  return wide;
}

/** The file's whole content as numbered context, for reading a file that did not change. */
function contextHunk(content: string): GitHunk | null {
  if (content === "") return null;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return {
    header: `@@ -1,${lines.length} +1,${lines.length} @@`,
    oldStart: 1, oldCount: lines.length, newStart: 1, newCount: lines.length,
    lines: lines.map((line) => ({ status: " " as const, text: line.endsWith("\r") ? line.slice(0, -1) : line })),
  };
}

/**
 * Every file of a skill review as one highlighted diff (#1948): a collapsible block per file whose
 * header names the path, whether it is a script, its change and its `+N −M` counts, then its hunks
 * with three lines of context, in Unified or (in a wide dialog or pane) Split layout.
 *
 * Hunks are computed here from the whole-file contents the review APIs return, and drawn with the
 * Git diff's row builders and row classes, so a change reads the same in both places. Colour is
 * never the only signal: every changed line keeps its `+`/`−` sign and is announced as an added or
 * removed line. Reviewing never runs anything: contents are rendered as text.
 */
export function SkillFileDiff({ previousFiles, files, executablePaths, label = "File Changes", collapsed = false }: {
  /** The version being replaced; empty for a new skill, so every file reads as Added. */
  previousFiles: readonly SkillFile[];
  files: readonly SkillFile[];
  /** Paths the source marks executable; they carry the Script flag whatever they are named. */
  executablePaths?: readonly string[];
  /** Accessible name of the whole diff. */
  label?: string;
  /** Every file starts closed, under its counts: for a review read beside a choice (#1984). */
  collapsed?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const entries = useMemo(
    () => diffSkillFiles(previousFiles, files, executablePaths),
    [previousFiles, files, executablePaths],
  );
  const splitAvailable = useSplitAvailable(root);
  const [chosen, setChosen] = useState<Layout>("unified");
  const layout: Layout = splitAvailable ? chosen : "unified";
  const changed = entries.filter((entry) => entry.change !== "unchanged");
  const added = changed.reduce((sum, entry) => sum + entry.added, 0);
  const removed = changed.reduce((sum, entry) => sum + entry.removed, 0);
  return (
    <div className="skill-diff" ref={root} role="group" aria-label={label}>
      <div className="skill-diff-bar">
        <p className="skill-diff-summary">
          {changed.length === 0
            ? `No file changes in ${plural(entries.length, "file", "files")}.`
            : `${plural(changed.length, "file", "files")} changed, ${plural(added, "line", "lines")} added, ${plural(removed, "line", "lines")} removed.`}
        </p>
        {splitAvailable && (
          <SegmentedControl<Layout>
            className="sm"
            label="Diff Layout"
            value={layout}
            onChange={setChosen}
            options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]}
          />
        )}
      </div>
      {entries.map((entry) => (
        <SkillFileDiffBlock
          key={entry.path}
          entry={entry}
          layout={layout}
          collapsed={collapsed}
          unchangedContent={entry.change === "unchanged" ? files.find((file) => file.path === entry.path) : undefined}
        />
      ))}
    </div>
  );
}

function SkillFileDiffBlock({ entry, layout, collapsed, unchangedContent }: {
  entry: SkillFileDiffEntry;
  layout: Layout;
  collapsed: boolean;
  unchangedContent?: SkillFile;
}) {
  const counts = entry.binary === null && entry.change !== "unchanged";
  // A body is mounted only while its file is open: a collapsed file (every unchanged one, to start)
  // would otherwise render each of its lines, which for a long reference file is tens of thousands
  // of rows nobody asked to read.
  const [open, setOpen] = useState(!collapsed && entry.change !== "unchanged");
  return (
    <details className="skill-diff-file disclosure" open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="skill-diff-file-head">
        <ChevronRightIcon className="disclosure-chevron" />
        <span className="skill-diff-path">{entry.path}</span>
        {entry.script && <span className="status no-dot t-warning">Script</span>}
        <span className={`status no-dot ${CHANGE_TONE[entry.change]}`}>{CHANGE_LABEL[entry.change]}</span>
        {counts && (
          <span className="skill-diff-counts">
            <span aria-hidden="true">
              <span className="skill-diff-count-add">+{entry.added}</span>{" "}
              <span className="skill-diff-count-del">−{entry.removed}</span>
            </span>
            <span className="sr-only">
              {`, ${plural(entry.added, "added line", "added lines")}, ${plural(entry.removed, "removed line", "removed lines")}`}
            </span>
          </span>
        )}
      </summary>
      {open && (
        <div className="skill-diff-file-body">
          <FileBody entry={entry} layout={layout} unchangedContent={unchangedContent} />
        </div>
      )}
    </details>
  );
}

function FileBody({ entry, layout, unchangedContent }: {
  entry: SkillFileDiffEntry;
  layout: Layout;
  unchangedContent?: SkillFile;
}): ReactNode {
  if (entry.binary) {
    const { beforeBytes, afterBytes } = entry.binary;
    const sentence = entry.change === "added"
      ? `Binary file added (${formatBytes(afterBytes ?? 0)}).`
      : entry.change === "removed"
        ? `Binary file removed (${formatBytes(beforeBytes ?? 0)}).`
        : entry.change === "unchanged"
          ? `Binary file unchanged (${formatBytes(afterBytes ?? 0)}).`
          : `Binary file changed (${formatBytes(beforeBytes ?? 0)} to ${formatBytes(afterBytes ?? 0)}).`;
    return <p className="skill-diff-note">{sentence}</p>;
  }
  if (entry.change === "unchanged") {
    const hunk = unchangedContent ? contextHunk(unchangedContent.content) : null;
    return hunk
      ? <HunkLines hunk={hunk} path={entry.path} layout={layout} entry={entry} />
      : <p className="skill-diff-note">Empty file.</p>;
  }
  if (entry.hunks.length === 0) return <p className="skill-diff-note">Empty file.</p>;
  return (
    <>
      {entry.lineEndings && (
        <p className="skill-diff-note">
          Line endings change from {lineEndingLabel(entry.lineEndings.before)} to {lineEndingLabel(entry.lineEndings.after)}.
        </p>
      )}
      {entry.hunks.map((hunk, index) => (
        <div className="skill-diff-hunk" key={index}>
          <div className="diff-hunk-header" aria-hidden="true">
            <span className="diff-hunk-header-text">{hunk.header}</span>
          </div>
          <HunkLines hunk={hunk} path={entry.path} layout={layout} entry={entry} />
        </div>
      ))}
    </>
  );
}

const rowKind = (row: DiffHunkRow) => row.status === "+" ? "add" : row.status === "-" ? "del" : "ctx";
const ROW_NAME = { "+": "Added line", "-": "Removed line", " ": "" } as const;

function HunkLines({ hunk, path, layout, entry }: {
  hunk: GitHunk;
  path: string;
  layout: Layout;
  entry: SkillFileDiffEntry;
}) {
  const syntax = (text: string) => highlightDiffLine(path, text).map((segment, index) => (
    <span className={`diff-syntax-${segment.kind}`} key={index}>{segment.text}</span>
  ));
  const lineText = (row: DiffHunkRow) => row.wordSegments
    ? row.wordSegments.map((part, index) => (
        <span className={part.changed ? "diff-word-changed" : undefined} key={index}>{syntax(part.text)}</span>
      ))
    : syntax(row.text);
  // The old side's last line, or the new side's, when that side ends without a newline.
  const noEol = (row: DiffHunkRow) =>
    (row.status !== "+" && entry.oldNoEol && row.oldNo === String(entry.oldLineCount)) ||
    (row.status !== "-" && entry.newNoEol && row.newNo === String(entry.newLineCount));
  const text = (row: DiffHunkRow) => (
    <span className="diff-text">
      {lineText(row)}
      {noEol(row) && <span className="skill-diff-nonl"> No newline at end of file</span>}
    </span>
  );
  // Announced first, so a line reads "Added line 100 …"; the sign itself is decorative.
  const name = (row: DiffHunkRow) => row.status !== " " && <span className="sr-only">{ROW_NAME[row.status]} </span>;
  const sign = (row: DiffHunkRow) =>
    <span className="diff-sign" aria-hidden="true">{row.status === "-" ? "−" : row.status === "+" ? "+" : ""}</span>;
  if (layout === "split") {
    return (
      <div className="diff-hunk-lines skill-diff-lines">
        {buildSplitDiffRows(hunk).map((pair, index) => (
          <div className="diff-split-row" key={index}>
            {[pair.left, pair.right].map((row, side) => row ? (
              <div className={`diff-split-cell diff-line-${rowKind(row)}`} key={side}>
                {name(row)}
                <span className="diff-gutter">{side === 0 ? row.oldNo : row.newNo}</span>
                {sign(row)}
                {text(row)}
              </div>
            ) : <div className="diff-split-cell diff-split-empty" key={side} />)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="diff-hunk-lines skill-diff-lines">
      {buildDiffHunkRows(hunk).map((row, index) => (
        <div className={`diff-line diff-line-${rowKind(row)}`} key={index}>
          {name(row)}
          <span className="diff-gutter diff-gutter-old">{row.oldNo}</span>
          <span className="diff-gutter">{row.newNo}</span>
          {sign(row)}
          {text(row)}
        </div>
      ))}
    </div>
  );
}
