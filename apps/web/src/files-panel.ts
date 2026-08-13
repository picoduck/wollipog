/** Pure logic for the session Files panel (kept out of the component for unit tests —
 * @wollipog/web has no component-render harness, pure-logic tests only). */

import type { EditorInfo, EditorLocationPrecision, EditorSourceLocation, SourceLocation } from "@wollipog/protocol";

/** Extensions the viewer renders through the Markdown component (everything else is <pre> text). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** "1.2 KB" style size label; empty string when size is unknown. */
export function formatBytes(size: number | undefined): string {
  if (size == null || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let v = size;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export interface Crumb {
  name: string;
  /** Root-relative path to navigate to when clicked ("" = the root). */
  path: string;
}

/** Breadcrumb segments for a root-relative dir path; always starts with the root crumb. */
export function crumbsFor(path: string, rootName = "root"): Crumb[] {
  const crumbs: Crumb[] = [{ name: rootName, path: "" }];
  if (!path) return crumbs;
  const parts = path.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    crumbs.push({ name: parts[i]!, path: parts.slice(0, i + 1).join("/") });
  }
  return crumbs;
}

export interface ResolvedSourceTarget {
  line: number;
  column?: number;
  matchLength?: number;
  error?: string;
}

const PRECISION_RANK: Record<EditorLocationPrecision, number> = { file: 0, line: 1, column: 2 };

/** UI preflight only: the runner performs the authoritative context-specific check. */
export function editorSupportsSourceLocation(editor: EditorInfo, location: EditorSourceLocation): boolean {
  const requested: EditorLocationPrecision = location.column !== undefined
    ? "column"
    : location.line !== undefined ? "line" : "file";
  return [editor.locations?.native, editor.locations?.wsl].some(
    (precision) => precision !== undefined && PRECISION_RANK[precision] >= PRECISION_RANK[requested],
  );
}

/** Resolve a route's line/column or exact symbol against the bounded file preview. Coordinates are
 * one-based UTF-16 positions, matching browser strings and the supported editor CLI contracts. */
export function resolveSourceTarget(content: string, location: SourceLocation): ResolvedSourceTarget | null {
  if (location.line === undefined && location.symbol === undefined) return null;
  const lines = content.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (location.line !== undefined && location.line > lines.length) {
    return { line: location.line, error: `Line ${location.line} is outside this ${lines.length}-line preview.` };
  }
  if (location.symbol !== undefined) {
    if (location.line !== undefined) {
      const text = lines[location.line - 1] ?? "";
      const start = Math.max(0, (location.column ?? 1) - 1);
      const found = text.indexOf(location.symbol, start);
      if (found >= 0) return { line: location.line, column: found + 1, matchLength: location.symbol.length };
      return { line: location.line, column: location.column, error: `Symbol “${location.symbol}” was not found on line ${location.line}.` };
    }
    for (let index = 0; index < lines.length; index += 1) {
      const found = lines[index]!.indexOf(location.symbol);
      if (found >= 0) return { line: index + 1, column: found + 1, matchLength: location.symbol.length };
    }
    return { line: 1, error: `Symbol “${location.symbol}” was not found in this preview.` };
  }
  const text = lines[location.line! - 1] ?? "";
  if (location.column !== undefined && location.column > text.length + 1) {
    return { line: location.line!, column: location.column, error: `Column ${location.column} is outside line ${location.line}.` };
  }
  return { line: location.line!, ...(location.column === undefined ? {} : { column: location.column, matchLength: 1 }) };
}
