/**
 * A unified diff as the transcript shows it (#2187): files, hunks and numbered lines, with Git's
 * metadata (`diff --git`, `index`, `new file mode`, `---`, `+++`, "\ No newline") dropped.
 *
 * Harnesses send three shapes: Git diffs with hunk headers (Codex, the runner's per-turn capture,
 * which can span several files), a header pair followed by a bare body with no hunk header (ACP's
 * old and new text), and nothing at all (Claude Code names the path only). A bare body is the
 * whole text, so it is numbered from line 1.
 */
export type DiffLineKind = "added" | "removed" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** The new-side line number for added and context lines, the old-side one for removed lines. */
  number: number;
}

export interface DiffHunk {
  /** False for a bare body that had no `@@` header: its range and scope are unknown. */
  header: boolean;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The text after the closing `@@`, often the enclosing function's signature. */
  section?: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** The new-side path with Git's `b/` prefix removed, when the diff names one. */
  path?: string;
  /** The path a rename or copy started from. */
  oldPath?: string;
  isNew: boolean;
  isDeleted?: boolean;
  /** A binary change: Git describes it, but it has no lines to show. */
  binary?: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const METADATA = /^(?:new file mode|deleted file mode|index |old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files |GIT binary patch)/;

const headerPath = (value: string): string | undefined => {
  const path = value.replace(/\t.*$/, "").trim();
  if (!path || path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
};

/**
 * The two sides of "Binary files X and Y differ". Either side is `/dev/null` or a prefixed path, and
 * a path may itself contain " and ", so the separator is found from what each side must look like:
 * equal paths split evenly, a null side anchors its end, and only then the last " and b/".
 */
export function binaryMarkerSides(line: string): { oldPath?: string; newPath?: string } | null {
  const match = /^Binary files (.+) differ$/.exec(line);
  if (!match) return null;
  const body = match[1]!;
  const strip = (side: string) => (side === "/dev/null" ? undefined : side.replace(/^[ab]\//, ""));
  if (body.startsWith("/dev/null and ")) return { newPath: strip(body.slice("/dev/null and ".length)) };
  if (body.endsWith(" and /dev/null")) return { oldPath: strip(body.slice(0, -" and /dev/null".length)) };
  const half = (body.length - " and ".length) / 2;
  if (Number.isInteger(half) && body.slice(half, half + " and ".length) === " and ") {
    const [left, right] = [body.slice(0, half), body.slice(half + " and ".length)];
    if (strip(left) === strip(right)) return { oldPath: strip(left), newPath: strip(right) };
  }
  const separator = body.lastIndexOf(" and b/");
  if (separator < 0) return {};
  return { oldPath: strip(body.slice(0, separator)), newPath: strip(body.slice(separator + " and ".length)) };
}

/** The new-side path of "diff --git a/X b/Y". A path may contain " b/", so equal sides split evenly
 * first; a rename (its "rename to" line overrides this anyway) falls back to the last " b/". */
function gitHeaderPath(line: string): string | undefined {
  const match = /^diff --git (a\/.+)$/.exec(line);
  if (!match) return / b\/(.+)$/.exec(line)?.[1];
  const body = match[1]!;
  const half = (body.length - 1) / 2;
  if (Number.isInteger(half) && body[half] === " " && body.slice(2, half) === body.slice(half + 3) && body.startsWith("b/", half + 1)) {
    return body.slice(half + 3);
  }
  const separator = body.lastIndexOf(" b/");
  return separator < 0 ? undefined : body.slice(separator + 3);
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldAt = 1;
  let newAt = 1;
  // A `GIT binary patch` is base85 data up to the next file, never lines to show.
  let binaryPatch = false;
  // The current file has only its header so far: the next header line or binary marker completes
  // it rather than opening another file.
  let headerOnly = false;
  // A file has one "---"/"+++" pair. A second one before any body line is the body: ACP's bare body
  // for old text "-- x" and new text "++ x" opens with exactly such a pair.
  let pairSeen = false;
  const startFile = (): DiffFile => {
    file = { isNew: false, hunks: [] };
    files.push(file);
    hunk = null;
    oldLeft = 0;
    newLeft = 0;
    binaryPatch = false;
    headerOnly = true;
    pairSeen = false;
    return file;
  };
  const bodyLine = (line: string) => {
    headerOnly = false;
    if (!hunk) {
      // A bare body: the whole text, numbered from line 1.
      const current: DiffFile = file ?? startFile();
      hunk = { header: false, oldStart: 1, oldCount: 0, newStart: 1, newCount: 0, lines: [] };
      current.hunks.push(hunk);
      oldAt = 1;
      newAt = 1;
    }
    const sign = line[0];
    if (sign === "+") {
      hunk.lines.push({ kind: "added", text: line.slice(1), number: newAt++ });
      newLeft -= 1;
    } else if (sign === "-") {
      hunk.lines.push({ kind: "removed", text: line.slice(1), number: oldAt++ });
      oldLeft -= 1;
    } else {
      hunk.lines.push({ kind: "context", text: sign === " " ? line.slice(1) : line, number: newAt++ });
      oldAt += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  };
  const lines = diff.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("\\")) continue;
    // Inside a counted hunk every line is the hunk's, even "---counter;".
    if (hunk?.header && (oldLeft > 0 || newLeft > 0)) {
      bodyLine(line);
      continue;
    }
    if (binaryPatch && !line.startsWith("diff ")) continue;
    if (line.startsWith("diff ")) {
      const current = startFile();
      const target = gitHeaderPath(line);
      if (target) current.path = target;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      const current: DiffFile = file ?? startFile();
      headerOnly = false;
      const [, oldStart, oldCount, newStart, newCount, section] = header;
      hunk = {
        header: true,
        oldStart: Number(oldStart),
        oldCount: oldCount === undefined ? 1 : Number(oldCount),
        newStart: Number(newStart),
        newCount: newCount === undefined ? 1 : Number(newCount),
        ...(section?.trim() ? { section: section.trim() } : {}),
        lines: [],
      };
      current.hunks.push(hunk);
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      oldAt = hunk.oldStart;
      newAt = hunk.newStart;
      continue;
    }
    // A "---"/"+++" pair outside a hunk names a file; one with no "diff" line opens the next file.
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ") && !(hunk && !hunk.header) &&
        !(file && headerOnly && pairSeen)) {
      const current: DiffFile = file && headerOnly ? file : startFile();
      pairSeen = true;
      if (line.slice(4).trim() === "/dev/null") current.isNew = true;
      if (lines[index + 1]!.slice(4).trim() === "/dev/null") current.isDeleted = true;
      const target = headerPath(lines[index + 1]!.slice(4)) ?? headerPath(line.slice(4));
      if (target) current.path = target;
      index += 1;
      continue;
    }
    // A binary change is a file of its own even with no `diff --git` line before it; a bare body's
    // text is never read as one.
    if ((line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) && !(hunk && !hunk.header)) {
      const current: DiffFile = file && headerOnly ? file : startFile();
      current.binary = true;
      headerOnly = false;
      binaryPatch = line.startsWith("GIT binary patch");
      const sides = binaryMarkerSides(line);
      if (sides) {
        if (!sides.oldPath && sides.newPath) current.isNew = true;
        if (sides.oldPath && !sides.newPath) current.isDeleted = true;
        current.path ??= sides.newPath ?? sides.oldPath;
      }
      continue;
    }
    if (!hunk && METADATA.test(line)) {
      const current = file as DiffFile | null;
      if (current) {
        if (line.startsWith("new file mode")) current.isNew = true;
        else if (line.startsWith("deleted file mode")) current.isDeleted = true;
        else if (line.startsWith("rename from ") || line.startsWith("copy from ")) current.oldPath = line.replace(/^(?:rename|copy) from /, "");
        else if (line.startsWith("rename to ") || line.startsWith("copy to ")) current.path = line.replace(/^(?:rename|copy) to /, "");
      }
      continue;
    }
    bodyLine(line);
  }
  for (const each of files) {
    const lines = each.hunks.flatMap((part) => part.lines);
    if (each.isNew || lines.length === 0) continue;
    const created = each.hunks.every((part) => part.header ? part.oldStart === 0 && part.oldCount === 0 : true) &&
      lines.every((line) => line.kind === "added");
    if (created) each.isNew = true;
  }
  return files;
}

/** The widest line number in a diff, for its number column; a loop, since a diff can hold more
 * lines than a spread call can take arguments. */
export function diffMaxLineNumber(files: readonly DiffFile[]): number {
  let max = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) if (line.number > max) max = line.number;
    }
  }
  return max;
}

/** A file whose every line is new carries no information in a wash: it shows as plain code. */
export function diffFileIsPlain(file: DiffFile): boolean {
  return file.isNew || file.hunks.every((hunk) => hunk.lines.every((line) => line.kind === "added"));
}

/** "+12 −3" from a unified diff's change lines; headers are not changes. */
export function diffLineCounts(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null;
  let added = 0;
  let removed = 0;
  for (const file of parseUnifiedDiff(diff)) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") added += 1;
        else if (line.kind === "removed") removed += 1;
      }
    }
  }
  return { added, removed };
}

const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "return", "function", "def", "fn", "func", "async", "await", "new", "typeof"]);

/** The enclosing function or type a hunk header names: "Header()" or "Store". */
function scopeName(section: string): string | null {
  for (const match of section.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!NOT_A_NAME.has(match[1]!)) return `${match[1]}()`;
  }
  const declaration = /\b(?:class|struct|interface|enum|impl|module|namespace|trait|type)\s+([A-Za-z_$][\w$]*)/.exec(section);
  return declaration ? declaration[1]! : null;
}

/** "Lines 12–40 in Header()": the hunk's new-side lines (its old ones for a pure removal). A bare
 * body's range is unknown, so it has no label. */
export function hunkLabel(hunk: DiffHunk): string | null {
  if (!hunk.header) return null;
  const [start, count] = hunk.newCount > 0 ? [hunk.newStart, hunk.newCount] : [hunk.oldStart, hunk.oldCount];
  const range = count <= 1 ? `Line ${start}` : `Lines ${start}–${start + count - 1}`;
  const scope = hunk.section ? scopeName(hunk.section) : null;
  return scope ? `${range} in ${scope}` : range;
}
