/**
 * Line diffs for the skill review dialogs (#1948). Pure and framework-free, so it unit-tests with
 * `node:test`; `SkillFileDiff` renders the result with the Git diff's row builders.
 *
 * The APIs return each file's whole current and proposed content, never a patch, so the hunks are
 * computed here: a Myers shortest edit script over lines, grouped into `GitHunk`s with three lines
 * of context, the shape `buildDiffHunkRows` and `buildSplitDiffRows` already render. It is a few
 * dozen lines rather than a text-diff package because only line granularity is needed, word
 * emphasis already exists in `diff-view.ts`, and skill files are small (512 KiB each at most).
 */

import { isSkillScriptFile, type GitDiffLine, type GitHunk, type SkillFile } from "@wollipog/protocol";

export type SkillFileChange = "added" | "changed" | "removed" | "unchanged";
export type LineEnding = "lf" | "crlf" | "mixed" | "none";

export interface SkillFileDiffEntry {
  path: string;
  change: SkillFileChange;
  /** Script-like by path, mode or content on either side (the same test the dialogs used). */
  script: boolean;
  /** Present when either side is not UTF-8 text: the dialog shows sizes instead of lines. */
  binary: { beforeBytes: number | null; afterBytes: number | null } | null;
  hunks: GitHunk[];
  added: number;
  removed: number;
  /** The old/new side's last line has no newline after it; shown on that line when it is in a hunk. */
  oldNoEol: boolean;
  newNoEol: boolean;
  oldLineCount: number;
  newLineCount: number;
  /** Present only when the file's line-ending style changes, which otherwise reads as identical lines. */
  lineEndings?: { before: LineEnding; after: LineEnding };
}

/** Lines around each change, as `git diff` shows them. */
export const DIFF_CONTEXT_LINES = 3;
/** Beyond this many edits the file is shown as fully replaced rather than searched further. */
const MAX_EDIT_DISTANCE = 2000;

interface SplitText {
  /** Each line with its terminator removed; `\r` of a CRLF is kept so a line-ending change is a change. */
  keys: string[];
  /** Each line as shown: no terminator and no trailing `\r`. */
  display: string[];
  noEol: boolean;
  endings: LineEnding;
}

function splitText(text: string): SplitText {
  if (text === "") return { keys: [], display: [], noEol: false, endings: "none" };
  const keys = text.split("\n");
  const noEol = keys[keys.length - 1] !== "";
  if (!noEol) keys.pop();
  let crlf = 0;
  let lf = 0;
  keys.forEach((line, index) => {
    if (noEol && index === keys.length - 1) return;
    if (line.endsWith("\r")) crlf += 1;
    else lf += 1;
  });
  const endings: LineEnding = crlf && lf ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none";
  return { keys, display: keys.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line), noEol, endings };
}

type Edit = " " | "-" | "+";

/**
 * Myers' O(ND) shortest edit script between two line lists, as one op per line. Common prefix and
 * suffix are trimmed first, so a one-line change in a long file costs almost nothing.
 */
export function lineEditScript(a: readonly string[], b: readonly string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const middle = middleScript(a.slice(start, endA), b.slice(start, endB));
  return [
    ...new Array<Edit>(start).fill(" "),
    ...middle,
    ...new Array<Edit>(a.length - endA).fill(" "),
  ];
}

function middleScript(a: readonly string[], b: readonly string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return new Array<Edit>(m).fill("+");
  if (m === 0) return new Array<Edit>(n).fill("-");
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  // Each step keeps only the diagonals it can reach (-d..d), so memory is O(D²), not O(D·(N+M)).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      next[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    v = next;
  }
  // Too different to be worth aligning: show every old line removed and every new line added.
  if (found < 0) return [...new Array<Edit>(n).fill("-"), ...new Array<Edit>(m).fill("+")];
  const out: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prior = trace[d]!;
    const at = (diagonal: number) => prior[diagonal + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push(" "); x -= 1; y -= 1; }
    out.push(prevK === k + 1 ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { out.push(" "); x -= 1; y -= 1; }
  return out.reverse();
}

/** Group an edit script into hunks with `context` unchanged lines around each run of changes. */
function hunksFromScript(script: Edit[], oldLines: string[], newLines: string[], context: number): GitHunk[] {
  // Each op with the old and new line index it sits at.
  const ops: Array<{ op: Edit; oldIndex: number; newIndex: number }> = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const op of script) {
    ops.push({ op, oldIndex, newIndex });
    if (op !== "+") oldIndex += 1;
    if (op !== "-") newIndex += 1;
  }
  const hunks: GitHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.op === " ") i += 1;
    if (i >= ops.length) break;
    const first = Math.max(0, i - context);
    let last = i;
    // Extend while the next change starts within twice the context, so hunks never overlap.
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.op === " ") continue;
      if (j - last > 2 * context) break;
      last = j;
    }
    const end = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(first, end + 1);
    const lines: GitDiffLine[] = slice.map(({ op, oldIndex: o, newIndex: n }) => ({
      status: op,
      text: op === "+" ? newLines[n]! : oldLines[o]!,
    }));
    const oldCount = slice.filter(({ op }) => op !== "+").length;
    const newCount = slice.filter(({ op }) => op !== "-").length;
    // Git's convention: an empty side's start is the line before the hunk (0 for a new file).
    const oldStart = oldCount ? slice[0]!.oldIndex + 1 : slice[0]!.oldIndex;
    const newStart = newCount ? slice[0]!.newIndex + 1 : slice[0]!.newIndex;
    hunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart, oldCount, newStart, newCount, lines,
    });
    i = end + 1;
  }
  return hunks;
}

/** Hunks, counts and end-of-file facts for one text file's old and new content. */
export function diffTextLines(oldText: string, newText: string, context = DIFF_CONTEXT_LINES) {
  const before = splitText(oldText);
  const after = splitText(newText);
  // A last line without a newline differs from the same line with one, as in `git diff`.
  const key = (side: SplitText) => side.keys.map((line, index) =>
    side.noEol && index === side.keys.length - 1 ? `${line}\u0000` : line);
  const script = lineEditScript(key(before), key(after));
  const hunks = hunksFromScript(script, before.display, after.display, context);
  return {
    hunks,
    added: script.filter((op) => op === "+").length,
    removed: script.filter((op) => op === "-").length,
    oldNoEol: before.noEol,
    newNoEol: after.noEol,
    oldLineCount: before.keys.length,
    newLineCount: after.keys.length,
    endings: { before: before.endings, after: after.endings },
  };
}

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(content: string): number {
  const clean = content.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function fileBytes(file: SkillFile): number {
  return file.encoding === "base64" ? base64Bytes(file.content) : new TextEncoder().encode(file.content).length;
}

/**
 * Every path in either version, sorted, with its change, flags and hunks. `before` is empty for a
 * new skill, so every file is Added and every line a `+`.
 */
export function diffSkillFiles(
  before: readonly SkillFile[],
  after: readonly SkillFile[],
  executablePaths: readonly string[] = [],
): SkillFileDiffEntry[] {
  const paths = [...new Set([...before, ...after].map((file) => file.path))].sort();
  return paths.map((path) => {
    const old = before.find((file) => file.path === path);
    const next = after.find((file) => file.path === path);
    const change: SkillFileChange = !old ? "added" : !next ? "removed"
      : old.encoding === next.encoding && old.content === next.content ? "unchanged" : "changed";
    const executable = executablePaths.includes(path);
    const script = [old, next].some((file) => file !== undefined && isSkillScriptFile(file, executable));
    const binary = [old, next].some((file) => file?.encoding === "base64");
    const base = { path, change, script, oldNoEol: false, newNoEol: false };
    if (binary) {
      return {
        ...base,
        binary: { beforeBytes: old ? fileBytes(old) : null, afterBytes: next ? fileBytes(next) : null },
        hunks: [], added: 0, removed: 0, oldLineCount: 0, newLineCount: 0,
      };
    }
    const text = diffTextLines(old?.content ?? "", next?.content ?? "");
    const { endings, ...lines } = text;
    return {
      ...base,
      ...lines,
      binary: null,
      ...(old && next && endings.before !== endings.after && endings.before !== "none" && endings.after !== "none"
        ? { lineEndings: endings } : {}),
    };
  });
}

/** "CRLF", "LF" or "mixed" for the line-ending note. */
export function lineEndingLabel(ending: LineEnding): string {
  return ending === "crlf" ? "CRLF" : ending === "lf" ? "LF" : ending === "mixed" ? "mixed" : "none";
}

/** "1.2 KB" style sizes for binary files. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
