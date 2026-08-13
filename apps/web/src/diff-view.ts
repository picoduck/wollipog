/**
 * Presentation grouping for the rich-diff pane (Phase 2, PR-A). Pure + framework-free so it
 * unit-tests with `node:test` — the React viewer just maps over the result.
 *
 * A file's first `collapseThreshold` hunks render expanded; the rest start collapsed behind a
 * "N more hunks" row. Binary and untracked files carry no hunks, so they collapse to nothing.
 */

import type { GitDiffFile, GitHunk } from "@wollipog/protocol";

/** One hunk positioned for display, carrying its ORIGINAL index into `file.hunks`. */
export interface DisplayHunk {
  hunk: GitHunk;
  /** Index into the source `GitDiffFile.hunks` — stable across collapse for a later stage/unstage. */
  index: number;
  /** True for hunks past the collapse threshold (rendered behind the "N more" row). */
  isCollapsed: boolean;
}

/** A file laid out for display: its hunks tagged with collapse state, plus the hidden-tail count. */
export interface DisplayFile {
  file: GitDiffFile;
  hunks: DisplayHunk[];
  /** How many hunks start collapsed (the length of the tail past the threshold). */
  hiddenCount: number;
}

export interface DiffHunkRow {
  status: " " | "+" | "-";
  text: string;
  oldNo: string;
  newNo: string;
  /** Stable review anchor: deletions target the left side; additions/context target the right. */
  anchor: { side: "left" | "right"; line: number };
  /** Index into the source GitHunk.lines; required for stale-safe line staging. */
  sourceIndex: number;
  /** Word-level emphasis for paired replacement lines. */
  wordSegments?: DiffWordSegment[];
}

export interface DiffWordSegment { text: string; changed: boolean }

export interface SplitDiffRow {
  left: DiffHunkRow | null;
  right: DiffHunkRow | null;
}

export interface SyntaxSegment {
  text: string;
  kind: "plain" | "keyword" | "string" | "number" | "comment" | "literal";
}

/** Resolve old/new gutters and the exact GitHub-compatible side/line anchor for every patch row. */
export function buildDiffHunkRows(hunk: GitHunk): DiffHunkRow[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const rows = hunk.lines.map((line, sourceIndex) => {
    if (line.status === "+") {
      const row: DiffHunkRow = {
        status: "+", text: line.text, oldNo: "", newNo: String(newLine), anchor: { side: "right", line: newLine }, sourceIndex,
      };
      newLine += 1;
      return row;
    }
    if (line.status === "-") {
      const row: DiffHunkRow = {
        status: "-", text: line.text, oldNo: String(oldLine), newNo: "", anchor: { side: "left", line: oldLine }, sourceIndex,
      };
      oldLine += 1;
      return row;
    }
    const row: DiffHunkRow = {
      status: " ", text: line.text, oldNo: String(oldLine), newNo: String(newLine), anchor: { side: "right", line: newLine }, sourceIndex,
    };
    oldLine += 1;
    newLine += 1;
    return row;
  });
  return annotateWordChanges(rows);
}

function wordTokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu) ?? [];
}

/** LCS-based word emphasis. Bounded to keep pathological minified lines off the quadratic path. */
export function wordDiff(oldText: string, newText: string): { old: DiffWordSegment[]; new: DiffWordSegment[] } {
  const oldTokens = wordTokens(oldText);
  const newTokens = wordTokens(newText);
  if (oldTokens.length > 160 || newTokens.length > 160) {
    return { old: [{ text: oldText, changed: true }], new: [{ text: newText, changed: true }] };
  }
  const dp = Array.from({ length: oldTokens.length + 1 }, () => new Uint16Array(newTokens.length + 1));
  for (let i = oldTokens.length - 1; i >= 0; i--) {
    for (let j = newTokens.length - 1; j >= 0; j--) {
      dp[i]![j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const oldChanged = new Array<boolean>(oldTokens.length).fill(true);
  const newChanged = new Array<boolean>(newTokens.length).fill(true);
  let i = 0;
  let j = 0;
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      oldChanged[i] = false;
      newChanged[j] = false;
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1;
    else j += 1;
  }
  const merge = (tokens: string[], changed: boolean[]): DiffWordSegment[] => {
    const out: DiffWordSegment[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const prior = out[out.length - 1];
      const current = changed[k]!;
      if (prior && prior.changed === current) prior.text += tokens[k]!;
      else out.push({ text: tokens[k]!, changed: current });
    }
    return out;
  };
  return { old: merge(oldTokens, oldChanged), new: merge(newTokens, newChanged) };
}

/** Pair adjacent deletion/addition blocks as replacements and add word-level annotations. */
export function annotateWordChanges(rows: DiffHunkRow[]): DiffHunkRow[] {
  const out = rows.map((row) => ({ ...row }));
  for (let i = 0; i < out.length;) {
    if (out[i]!.status !== "-") { i += 1; continue; }
    const deletedStart = i;
    while (i < out.length && out[i]!.status === "-") i += 1;
    const addedStart = i;
    while (i < out.length && out[i]!.status === "+") i += 1;
    const pairs = Math.min(addedStart - deletedStart, i - addedStart);
    for (let offset = 0; offset < pairs; offset++) {
      const oldRow = out[deletedStart + offset]!;
      const newRow = out[addedStart + offset]!;
      const words = wordDiff(oldRow.text, newRow.text);
      oldRow.wordSegments = words.old;
      newRow.wordSegments = words.new;
    }
  }
  return out;
}

/** Align a unified hunk into optional side-by-side cells without losing source-line identities. */
export function buildSplitDiffRows(hunk: GitHunk): SplitDiffRow[] {
  const rows = buildDiffHunkRows(hunk);
  const out: SplitDiffRow[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i]!;
    if (row.status === " ") {
      out.push({
        left: { ...row, anchor: { side: "left", line: Number(row.oldNo) } },
        right: row,
      });
      i += 1;
      continue;
    }
    const deleted: DiffHunkRow[] = [];
    while (i < rows.length && rows[i]!.status === "-") deleted.push(rows[i++]!);
    const added: DiffHunkRow[] = [];
    while (i < rows.length && rows[i]!.status === "+") added.push(rows[i++]!);
    const count = Math.max(deleted.length, added.length);
    for (let offset = 0; offset < count; offset++) {
      out.push({ left: deleted[offset] ?? null, right: added[offset] ?? null });
    }
    if (deleted.length === 0 && added.length === 0) i += 1;
  }
  return out;
}

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "do", "else",
  "enum", "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "in",
  "interface", "let", "match", "new", "package", "private", "protected", "public", "return", "static", "struct",
  "switch", "throw", "try", "type", "var", "while", "with", "yield",
]);
const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False"]);

/** Safe, dependency-free line lexer for the diff pane. It returns text segments, never HTML. */
export function highlightDiffLine(filePath: string, text: string): SyntaxSegment[] {
  const codeLike = /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|php|cs|cpp|cc|cxx|c|h|hpp|sh|bash|zsh|fish|json|ya?ml|toml|css|scss|less|html?|vue|svelte)$/i.test(filePath);
  if (!codeLike || !text) return [{ text, kind: "plain" }];
  const hashComments = /\.(?:py|rb|sh|bash|zsh|fish|ya?ml|toml)$/i.test(filePath);
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|#[^\r\n]*$|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  const out: SyntaxSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) out.push({ text: text.slice(cursor, index), kind: "plain" });
    const token = match[0];
    let kind: SyntaxSegment["kind"] = "plain";
    if (token.startsWith("//") || (hashComments && token.startsWith("#"))) kind = "comment";
    else if (/^["'`]/.test(token)) kind = "string";
    else if (/^\d/.test(token)) kind = "number";
    else if (KEYWORDS.has(token)) kind = "keyword";
    else if (LITERALS.has(token)) kind = "literal";
    out.push({ text: token, kind });
    cursor = index + token.length;
    if (kind === "comment") break;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), kind: "plain" });
  return out.length ? out : [{ text, kind: "plain" }];
}

/**
 * Group each file's hunks for display: the first `collapseThreshold` stay expanded, the remainder
 * collapse. `index` is preserved from the source order so collapse never renumbers a hunk. Binary
 * and untracked files (empty `hunks`) yield `{hunks: [], hiddenCount: 0}`. Empty input ⇒ `[]`.
 */
export function groupHunksForDisplay(files: GitDiffFile[], collapseThreshold: number): DisplayFile[] {
  return files.map((file) => {
    const hunks: DisplayHunk[] = file.hunks.map((hunk, index) => ({
      hunk,
      index,
      isCollapsed: index >= collapseThreshold,
    }));
    const hiddenCount = Math.max(0, file.hunks.length - collapseThreshold);
    return { file, hunks, hiddenCount };
  });
}
