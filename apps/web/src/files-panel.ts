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

/**
 * The name the Files panel calls the session's root by (#2852): the last segment of its working
 * folder, POSIX or Windows, else the workspace's name. The first crumb and Go to File's count line
 * use it, so neither says "root".
 */
export function workspaceFolderName(folderPath: string | null | undefined, workspaceName?: string | null): string {
  const last = (folderPath ?? "").split(/[\\/]+/).filter(Boolean).pop();
  return last || workspaceName?.trim() || "Workspace";
}

/** The parent of a root-relative path ("" for a top-level entry and for the root itself). */
export function parentPath(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

/** The last segment of a root-relative path. */
export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export type FileIconKind = "folder" | "code" | "image" | "file";

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const CODE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cjs", "cpp", "cs", "css", "cts", "dart", "ex", "exs", "go", "h", "hpp", "html", "java", "js",
  "json", "jsonc", "jsx", "kt", "kts", "less", "lua", "mjs", "mts", "php", "pl", "py", "rb", "rs", "sass", "scala",
  "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "vue", "xml", "yaml", "yml", "zig", "zsh",
]);

/** Which §18 icon a Files row shows: a folder, source code, an image, or any other file. */
export function fileIconKind(name: string, isDir: boolean): FileIconKind {
  if (isDir) return "folder";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (CODE_EXTENSIONS.has(extension) || name === "Dockerfile" || name === "Makefile") return "code";
  return "file";
}

/** A changed file's quiet marker in the listing (#2852): added, modified, or untracked. */
export type GitMarker = "A" | "M" | "U";

export const GIT_MARKER_LABEL: Record<GitMarker, string> = { A: "Added", M: "Modified", U: "Untracked" };

/**
 * The marker for each changed path in a git status read, keyed by root-relative path. Porcelain codes
 * arrive trimmed ("M", "MM", "A", "AM", "??", "R"); a rename's path is "old -> new" and marks the new
 * path as added. A deleted file is not in the listing, so it has no marker.
 */
export function gitMarkers(files: readonly { status: string; path: string }[] | null | undefined): Map<string, GitMarker> {
  const markers = new Map<string, GitMarker>();
  for (const { status, path } of files ?? []) {
    const code = status.trim();
    const target = unquotePorcelainPath(path.includes(" -> ") ? path.slice(path.lastIndexOf(" -> ") + 4) : path);
    if (!target) continue;
    if (code === "??") markers.set(target, "U");
    else if (code.includes("A") || code.includes("R") || code.includes("C")) markers.set(target, "A");
    else if (code === "D" || code === "DD") continue;
    else markers.set(target, "M");
  }
  return markers;
}

/** Git quotes a porcelain path holding unusual characters; the listing has the plain name. */
function unquotePorcelainPath(path: string): string {
  if (!(path.length >= 2 && path.startsWith("\"") && path.endsWith("\""))) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

/** One Go to File result, ranked and split for display. */
export interface GoToFileMatch {
  path: string;
  name: string;
  /** The containing folder, root-relative ("" at the root). */
  folder: string;
  /** Where the query matched: the name, or (only) the folder part of the path. */
  matchIn: "name" | "folder" | "path";
  /** The matched range within `name` or `folder`, for underlining; absent for a path-only match. */
  range?: { start: number; end: number };
}

/**
 * Ranks the runner's bounded search for Go to File (#2852): files only; git-changed files and files
 * opened earlier in this session first; then name matches before path matches. Ties keep the
 * runner's order, which is breadth-first, so shallower files come first.
 */
export function rankGoToFileResults(
  results: readonly { path: string; isDirectory: boolean }[],
  query: string,
  priority: (path: string) => boolean,
): GoToFileMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  return results
    .filter((result) => !result.isDirectory)
    .map((result, index) => {
      const name = baseName(result.path);
      const folder = parentPath(result.path);
      const inName = needle ? name.toLocaleLowerCase().indexOf(needle) : -1;
      const inFolder = inName < 0 && needle ? folder.toLocaleLowerCase().indexOf(needle) : -1;
      const match: GoToFileMatch = inName >= 0
        ? { path: result.path, name, folder, matchIn: "name", range: { start: inName, end: inName + needle.length } }
        : inFolder >= 0
          ? { path: result.path, name, folder, matchIn: "folder", range: { start: inFolder, end: inFolder + needle.length } }
          : { path: result.path, name, folder, matchIn: "path" };
      return { match, index, first: priority(result.path) ? 0 : 1, nameFirst: inName >= 0 ? 0 : 1 };
    })
    .sort((a, b) => a.first - b.first || a.nameFirst - b.nameFirst || a.index - b.index)
    .map(({ match }) => match);
}

/** Breadcrumb segments for a root-relative dir path; always starts with the root crumb, named by
 * `rootName` (the workspace folder's name, `workspaceFolderName`). */
export function crumbsFor(path: string, rootName: string): Crumb[] {
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
