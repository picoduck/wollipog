/**
 * Files panel: list / read files under a session's root (worktreePath ?? repoPath from box meta).
 * The dashboard only ever names ROOT-RELATIVE paths (POSIX `/` separators on the wire); this module
 * validates them (no absolute paths, no `..` escape) before touching the filesystem, natively or in
 * a WSL distro. Canonical-path checks reject symlinks that escape the exact session root.
 */

import { createReadStream, readdirSync, readSync, openSync, closeSync, fstatSync, statSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, sep } from "node:path";
import {
  MAX_WORKSPACE_REFERENCE_SEARCH_RESULTS,
  type AgentContext,
  type CreateWorkspaceReferenceRequest,
  type GitDiffInfo,
  type SessionFileEntry,
  type WorkspaceReference,
  type WorkspaceReferenceCandidate,
} from "@wollipog/protocol";
import { run } from "./discovery/resolve.js";

/** Cap on returned file content — enough for any source/doc file the viewer should render. */
export const READ_FILE_CAP = 512 * 1024;
const WORKSPACE_SEARCH_VISIT_CAP = 20_000;
const WORKSPACE_DIRECTORY_ENTRY_CAP = 2_000;

export interface SessionFileListing {
  path: string;
  entries: SessionFileEntry[];
}

export interface SessionFileContent {
  path: string;
  content?: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export interface WorkspaceReferenceSearch {
  results: WorkspaceReferenceCandidate[];
  truncated: boolean;
}

export interface WorkspaceDirectoryTree {
  content: string;
  truncated: boolean;
}

/** Normalize a root-relative wire path: `\` → `/`, collapse empty/`.` segments. Returns null for
 * anything that could escape the root — absolute paths (posix or drive-letter), `..` segments,
 * NUL. "" is valid and means the root itself. Pure; exported for tests. */
export function normalizeRelPath(rel: string): string | null {
  if (rel.includes("\0")) return null;
  const slashed = rel.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const parts = slashed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

function sortEntries(entries: SessionFileEntry[]): SessionFileEntry[] {
  return entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

/** List one directory level under `root` (a session root). `rel` "" = the root itself. */
export async function listSessionFiles(context: AgentContext, root: string, rel: string): Promise<SessionFileListing> {
  const norm = normalizeRelPath(rel);
  if (norm === null) throw new Error(`invalid path: ${rel}`);
  return context.kind === "wsl" ? wslList(context.distro, root, norm) : nativeList(root, norm);
}

/** Read one file under `root`, capped at READ_FILE_CAP bytes; binary (NUL in the head) ⇒ no content. */
export async function readSessionFile(context: AgentContext, root: string, rel: string): Promise<SessionFileContent> {
  const norm = normalizeRelPath(rel);
  if (norm === null || norm === "") throw new Error(`invalid path: ${rel}`);
  return context.kind === "wsl" ? wslRead(context.distro, root, norm) : nativeRead(root, norm);
}

/** Search names only, bounded by both visited entries and returned matches. */
export async function searchWorkspaceReferences(
  context: AgentContext,
  root: string,
  query: string,
): Promise<WorkspaceReferenceSearch> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    throw new Error("enter 1-256 searchable characters");
  }
  return context.kind === "wsl"
    ? wslSearch(context.distro, root, normalized)
    : nativeSearch(root, normalized);
}

/** Build the bounded directory-tree context a provider will actually receive. */
export async function workspaceDirectoryTree(
  context: AgentContext,
  root: string,
  directory: string,
): Promise<WorkspaceDirectoryTree> {
  const pending = [directory];
  const lines: string[] = [];
  let visited = 0;
  let truncated = false;
  while (pending.length && visited < WORKSPACE_DIRECTORY_ENTRY_CAP) {
    const current = pending.shift()!;
    let listing: SessionFileListing;
    try {
      listing = await listSessionFiles(context, root, current);
    } catch (error) {
      if (current === directory) throw error;
      lines.push(`${current}/ [unavailable]`);
      continue;
    }
    for (const entry of listing.entries) {
      if (visited >= WORKSPACE_DIRECTORY_ENTRY_CAP) {
        truncated = true;
        break;
      }
      visited += 1;
      lines.push(entry.isDir ? `${entry.path}/` : `${entry.path}${entry.size === undefined ? "" : ` (${entry.size} bytes)`}`);
      if (entry.isDir) pending.push(entry.path);
    }
  }
  if (pending.length) truncated = true;
  return { content: lines.join("\n"), truncated };
}

/** Resolve exactly one immutable diff-side selection into provider text. */
export function workspaceReferenceDiffContent(diff: GitDiffInfo, reference: WorkspaceReference): string {
  const file = diff.files.find((candidate) => candidate.path === reference.path ||
    (reference.side === "left" && candidate.oldPath === reference.path));
  if (!file || reference.startLine === undefined || reference.endLine === undefined || !reference.side) {
    throw new Error(`${reference.path} is no longer present in the selected diff`);
  }
  const matched = new Set<number>();
  const selected: string[] = [];
  for (const hunk of file.hunks) {
    let left = hunk.oldStart;
    let right = hunk.newStart;
    for (const line of hunk.lines) {
      const lineNumber = reference.side === "left" ? left : right;
      const existsOnSide = reference.side === "left" ? line.status !== "+" : line.status !== "-";
      if (existsOnSide && lineNumber >= reference.startLine && lineNumber <= reference.endLine) {
        matched.add(lineNumber);
        selected.push(`${lineNumber} ${line.status}${line.text}`);
      }
      if (line.status !== "+") left += 1;
      if (line.status !== "-") right += 1;
    }
  }
  for (let line = reference.startLine; line <= reference.endLine; line += 1) {
    if (!matched.has(line)) throw new Error(`${reference.path} no longer contains every selected diff line`);
  }
  return selected.join("\n");
}

/** Mint a content-free attachment. Diff targets are already validated against git by the caller;
 * their exact diff identity is the target fingerprint, so deleted/left-side paths remain valid. */
export async function createWorkspaceReference(
  context: AgentContext,
  root: string,
  target: CreateWorkspaceReferenceRequest,
): Promise<WorkspaceReference> {
  const rel = normalizeRelPath(target.path);
  if (!rel) throw new Error("invalid workspace reference path");
  validateReferenceRange(target);
  const rootFingerprint = context.kind === "wsl"
    ? await wslRootFingerprint(context.distro, root)
    : nativeRootFingerprint(root);
  if (target.kind === "file" || target.kind === "lines") {
    const file = await readSessionFile(context, root, rel);
    if (file.binary) throw new Error("binary files cannot be attached as prompt text");
    const availableLines = (file.content ?? "").split(/\r?\n/).length;
    if (target.kind === "lines" && target.endLine! > availableLines) {
      throw new Error(file.truncated
        ? "the selected lines are beyond the bounded file preview"
        : "the selected lines are no longer present in the file");
    }
  }
  const directoryTree = target.kind === "directory"
    ? await workspaceDirectoryTree(context, root, rel)
    : null;
  const targetFingerprint = target.kind === "diff"
    ? hashText([rootFingerprint, rel, target.diffScope, target.diffHash, target.side, target.startLine, target.endLine].join("\0"))
    : target.kind === "directory"
      ? hashText(`directory\0${rootFingerprint}\0${rel}\0${directoryTree!.truncated}\0${directoryTree!.content}`)
    : context.kind === "wsl"
      ? await wslTargetFingerprint(context.distro, root, rel, false)
      : await nativeTargetFingerprint(root, rel, false);
  return {
    artifactId: `workspace:${randomUUID()}`,
    mimeType: "application/vnd.wollipog.workspace-reference+json",
    sizeBytes: 0,
    sha256: targetFingerprint,
    referenceVersion: 1,
    kind: target.kind,
    path: rel,
    rootFingerprint,
    targetFingerprint,
    ...(target.startLine === undefined ? {} : { startLine: target.startLine }),
    ...(target.endLine === undefined ? {} : { endLine: target.endLine }),
    ...(target.side === undefined ? {} : { side: target.side }),
    ...(target.diffHash === undefined ? {} : { diffHash: target.diffHash }),
    ...(target.diffScope === undefined ? {} : { diffScope: target.diffScope }),
  };
}

function validateReferenceRange(target: CreateWorkspaceReferenceRequest): void {
  const ranged = target.kind === "lines" || target.kind === "diff";
  if (ranged && (!Number.isSafeInteger(target.startLine) || !Number.isSafeInteger(target.endLine) ||
      target.startLine! < 1 || target.endLine! < target.startLine! || target.endLine! > 1_000_000)) {
    throw new Error("the selected line range is invalid");
  }
  if (!ranged && (target.startLine !== undefined || target.endLine !== undefined)) {
    throw new Error("line ranges require a line reference");
  }
  if (target.kind === "diff" &&
      ((target.side !== "left" && target.side !== "right") ||
       !target.diffHash || !/^[a-f0-9]{64}$/.test(target.diffHash) ||
       (target.diffScope !== "uncommitted" && target.diffScope !== "all_branch" && target.diffScope !== "last_turn"))) {
    throw new Error("the diff reference identity is invalid");
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalNativeTarget(root: string, rel = ""): { root: string; target: string } {
  const canonicalRoot = realpathSync(root);
  const target = realpathSync(rel ? join(canonicalRoot, ...rel.split("/")) : canonicalRoot);
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`workspace path escapes the session root: ${rel || "."}`);
  }
  return { root: canonicalRoot, target };
}

function nativeRootFingerprint(root: string): string {
  const canonical = canonicalNativeTarget(root);
  const stat = statSync(canonical.root);
  return hashText(`native\0${canonical.root}\0${stat.dev}\0${stat.ino}`);
}

async function hashNativeFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function nativeTargetFingerprint(root: string, rel: string, expectDirectory: boolean): Promise<string> {
  const canonical = canonicalNativeTarget(root, rel);
  const stat = statSync(canonical.target);
  if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(expectDirectory ? `not a directory: ${rel}` : `not a file: ${rel}`);
  }
  return expectDirectory
    ? hashText(`directory\0${rel}\0${stat.dev}\0${stat.ino}\0${stat.mtimeMs}`)
    : hashText(`file\0${rel}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${await hashNativeFile(canonical.target)}`);
}

/* --------------------------------- native --------------------------------- */

function nativeList(root: string, rel: string): SessionFileListing {
  let abs: string;
  try {
    abs = canonicalNativeTarget(root, rel).target;
  } catch {
    throw new Error(`cannot read directory: ${rel || "."}`);
  }
  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch {
    throw new Error(`cannot read directory: ${rel || "."}`);
  }
  const entries: SessionFileEntry[] = [];
  for (const d of dirents) {
    if (d.name === ".git") continue; // internal — the Git panel owns that story
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: childRel, isDir: true });
    } else if (d.isFile() || d.isSymbolicLink()) {
      // stat (not open) for the size: on POSIX, openSync on a writer-less FIFO — reachable via a
      // symlink that passes isSymbolicLink() — blocks SYNCHRONOUSLY and would freeze the whole
      // runner event loop. statSync never blocks on special files.
      let size: number | undefined;
      try {
        const st = statSync(join(abs, d.name));
        if (st.isFile()) size = st.size;
      } catch {
        /* unreadable (broken symlink etc.) — still list it, sizeless */
      }
      entries.push({ name: d.name, path: childRel, isDir: false, size });
    }
  }
  return { path: rel, entries: sortEntries(entries) };
}

function nativeRead(root: string, rel: string): SessionFileContent {
  let abs: string;
  try {
    abs = canonicalNativeTarget(root, rel).target;
  } catch {
    throw new Error(`cannot read file: ${rel}`);
  }
  // Regular-file check BEFORE open: openSync on a writer-less FIFO blocks synchronously on POSIX
  // (freezing the runner event loop); statSync never blocks. The post-open fstat guard stays as a
  // race backstop for the boring cases.
  try {
    if (!statSync(abs).isFile()) throw new Error(`not a file: ${rel}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("not a file")) throw err;
    throw new Error(`cannot read file: ${rel}`);
  }
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch {
    throw new Error(`cannot read file: ${rel}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`not a file: ${rel}`);
    const cap = Math.min(st.size, READ_FILE_CAP);
    const buf = Buffer.alloc(cap);
    let read = 0;
    while (read < cap) {
      const n = readSync(fd, buf, read, cap - read, read);
      if (n <= 0) break;
      read += n;
    }
    const head = buf.subarray(0, Math.min(read, 8192));
    if (head.includes(0)) return { path: rel, size: st.size, truncated: false, binary: true };
    return {
      path: rel,
      content: buf.subarray(0, read).toString("utf8"),
      size: st.size,
      truncated: st.size > read,
      binary: false,
    };
  } finally {
    closeSync(fd);
  }
}

function nativeSearch(root: string, query: string): WorkspaceReferenceSearch {
  const canonicalRoot = canonicalNativeTarget(root).root;
  const pending = [""];
  const results: WorkspaceReferenceCandidate[] = [];
  let visited = 0;
  while (pending.length && visited < WORKSPACE_SEARCH_VISIT_CAP && results.length < MAX_WORKSPACE_REFERENCE_SEARCH_RESULTS) {
    const rel = pending.shift()!;
    const abs = rel ? join(canonicalRoot, ...rel.split("/")) : canonicalRoot;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > WORKSPACE_SEARCH_VISIT_CAP) break;
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory();
      if (entry.name.toLocaleLowerCase().includes(query) || path.toLocaleLowerCase().includes(query)) {
        results.push({ path, isDirectory });
        if (results.length >= MAX_WORKSPACE_REFERENCE_SEARCH_RESULTS) break;
      }
      if (isDirectory) pending.push(path);
    }
  }
  return { results, truncated: pending.length > 0 || visited >= WORKSPACE_SEARCH_VISIT_CAP };
}

/* ---------------------------------- WSL ----------------------------------- */

/** wsl.exe argv for listing. Paths ride as POSITIONAL args ($1=root, $2=rel), NEVER interpolated
 * into the script (same injection stance as fs-browse.ts). One line per entry:
 * `d|f <TAB> size <TAB> name`. Exported for injection-shape tests. */
export function wslListArgs(distro: string, root: string, rel: string): string[] {
  const script =
    'r=$(readlink -f -- "$1") || exit 3; rel=$2; [ -n "$rel" ] || rel=.; t=$(readlink -f -- "$1/$rel") || exit 3; case "$t" in "$r"|"$r"/*) ;; *) exit 5;; esac; cd "$t" || exit 3; ' +
    'for e in * .[!.]* ..?*; do [ -e "$e" ] || continue; [ "$e" = .git ] && continue; ' +
    'if [ -L "$e" ]; then x=$(readlink -f -- "$e") || continue; case "$x" in "$r"|"$r"/*) ;; *) printf "f\\t\\t%s\\n" "$e"; continue;; esac; fi; ' +
    'if [ -d "$e" ]; then printf "d\\t\\t%s\\n" "$e"; ' +
    'else s=$(stat -c %s -- "$e" 2>/dev/null); printf "f\\t%s\\t%s\\n" "$s" "$e"; fi; done';
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", root, rel];
}

/** wsl.exe argv for reading: prints `<size>\n` then up to $3 content bytes. */
export function wslReadArgs(distro: string, root: string, rel: string, cap: number): string[] {
  const script =
    'r=$(readlink -f -- "$1") || exit 3; f=$(readlink -f -- "$1/$2") || exit 4; case "$f" in "$r"/*) ;; *) exit 5;; esac; [ -f "$f" ] || exit 4; ' +
    's=$(stat -c %s -- "$f" 2>/dev/null || echo 0); printf "%s\\n" "$s"; head -c "$3" -- "$f"';
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", root, rel, String(cap)];
}

export function wslSearchArgs(distro: string, root: string, visitCap: number): string[] {
  const script =
    'r=$(readlink -f -- "$1") || exit 3; cd "$r" || exit 3; ' +
    'find . -path ./.git -prune -o -type l -prune -o \\( -type f -o -type d \\) -printf "%y\\t%P\\n" 2>/dev/null | head -n "$2"';
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", root, String(visitCap + 1)];
}

async function wslSearch(distro: string, root: string, query: string): Promise<WorkspaceReferenceSearch> {
  const r = await run("wsl.exe", wslSearchArgs(distro, root, WORKSPACE_SEARCH_VISIT_CAP), {
    timeoutMs: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (r.code !== 0) throw new Error(`cannot search the workspace in ${distro}`);
  return parseWslWorkspaceReferenceSearch(r.stdout, query);
}

export function parseWslWorkspaceReferenceSearch(
  output: string,
  query: string,
  visitCap = WORKSPACE_SEARCH_VISIT_CAP,
): WorkspaceReferenceSearch {
  const matches: WorkspaceReferenceCandidate[] = [];
  const rows = output.split("\n").filter(Boolean);
  for (const raw of rows.slice(0, visitCap)) {
    const [type, ...pathParts] = raw.replace(/\r$/, "").split("\t");
    const path = pathParts.join("\t");
    if (!path || !path.toLocaleLowerCase().includes(query)) continue;
    matches.push({ path, isDirectory: type === "d" });
  }
  return {
    results: matches.slice(0, MAX_WORKSPACE_REFERENCE_SEARCH_RESULTS),
    truncated: rows.length > visitCap || matches.length > MAX_WORKSPACE_REFERENCE_SEARCH_RESULTS,
  };
}

async function wslRootFingerprint(distro: string, root: string): Promise<string> {
  const script = 'r=$(readlink -f -- "$1") || exit 3; i=$(stat -Lc "%d:%i" -- "$r") || exit 3; printf "%s\\0%s" "$r" "$i"';
  const r = await run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", script, "sh", root], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error(`cannot identify the session root in ${distro}`);
  return hashText(`wsl:${distro}\0${r.stdout}`);
}

async function wslTargetFingerprint(distro: string, root: string, rel: string, expectDirectory: boolean): Promise<string> {
  const script =
    'r=$(readlink -f -- "$1") || exit 3; t=$(readlink -f -- "$1/$2") || exit 4; case "$t" in "$r"/*) ;; *) exit 5;; esac; ' +
    (expectDirectory
      ? '[ -d "$t" ] || exit 4; stat -Lc "directory\\0%d\\0%i\\0%Y" -- "$t"'
      : '[ -f "$t" ] || exit 4; printf "file\\0"; stat -Lc "%d\\0%i\\0%s\\0" -- "$t"; sha256sum -- "$t" | cut -d" " -f1');
  const r = await run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", script, "sh", root, rel], {
    timeoutMs: 30_000,
    maxBuffer: 64 * 1024,
  });
  if (r.code !== 0) throw new Error(`workspace target is missing, changed, or outside the session root: ${rel}`);
  return hashText(`${rel}\0${r.stdout}`);
}

async function wslList(distro: string, root: string, rel: string): Promise<SessionFileListing> {
  const r = await run("wsl.exe", wslListArgs(distro, root, rel), { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error(`cannot read directory in ${distro}: ${rel || "."}`);
  const entries: SessionFileEntry[] = [];
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) continue;
    const [kind, sizeStr, ...nameParts] = trimmed.split("\t");
    const name = nameParts.join("\t");
    if (!name || (kind !== "d" && kind !== "f")) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    if (kind === "d") entries.push({ name, path: childRel, isDir: true });
    else {
      const size = Number(sizeStr);
      entries.push({ name, path: childRel, isDir: false, size: Number.isFinite(size) && sizeStr !== "" ? size : undefined });
    }
  }
  return { path: rel, entries: sortEntries(entries) };
}

async function wslRead(distro: string, root: string, rel: string): Promise<SessionFileContent> {
  const r = await run("wsl.exe", wslReadArgs(distro, root, rel, READ_FILE_CAP), {
    timeoutMs: 15_000,
    maxBuffer: READ_FILE_CAP + 64 * 1024,
  });
  if (r.code !== 0) throw new Error(`cannot read file in ${distro}: ${rel}`);
  const nl = r.stdout.indexOf("\n");
  if (nl < 0) throw new Error(`cannot read file in ${distro}: ${rel}`);
  const size = Number(r.stdout.slice(0, nl).replace(/\r$/, "")) || 0;
  const content = r.stdout.slice(nl + 1);
  // Binary bytes arrive utf8-mangled through the pipe; a surviving NUL is the reliable tell.
  if (content.includes("\0")) return { path: rel, size, truncated: false, binary: true };
  // `truncated` compares byte sizes; content.length is chars — close enough for the ≫cap case,
  // so compare against the byte length of what we actually received.
  const received = Buffer.byteLength(content, "utf8");
  return { path: rel, content, size, truncated: size > received, binary: false };
}
