/**
 * Files panel: list / read files under a session's root (worktreePath ?? repoPath from box meta).
 * The dashboard only ever names ROOT-RELATIVE paths (POSIX `/` separators on the wire); this module
 * validates them (no absolute paths, no `..` escape) before touching the filesystem, natively or in
 * a WSL distro. Symlinks inside the root can still point out of it — acceptable: the loopback
 * dashboard user owns the box, the guard is against accidents, not an adversary.
 */

import { readdirSync, readSync, openSync, closeSync, fstatSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext, SessionFileEntry } from "@wollipog/protocol";
import { run } from "./discovery/resolve.js";

/** Cap on returned file content — enough for any source/doc file the viewer should render. */
export const READ_FILE_CAP = 512 * 1024;

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

/* --------------------------------- native --------------------------------- */

function nativeList(root: string, rel: string): SessionFileListing {
  const abs = rel ? join(root, ...rel.split("/")) : root;
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
  const abs = join(root, ...rel.split("/"));
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

/* ---------------------------------- WSL ----------------------------------- */

/** wsl.exe argv for listing. Paths ride as POSITIONAL args ($1=root, $2=rel), NEVER interpolated
 * into the script (same injection stance as fs-browse.ts). One line per entry:
 * `d|f <TAB> size <TAB> name`. Exported for injection-shape tests. */
export function wslListArgs(distro: string, root: string, rel: string): string[] {
  const script =
    'cd "$1" 2>/dev/null || exit 3; [ -z "$2" ] || cd "./$2" 2>/dev/null || exit 3; ' +
    'for e in * .[!.]* ..?*; do [ -e "$e" ] || continue; [ "$e" = .git ] && continue; ' +
    'if [ -d "$e" ]; then printf "d\\t\\t%s\\n" "$e"; ' +
    'else s=$(stat -c %s -- "$e" 2>/dev/null); printf "f\\t%s\\t%s\\n" "$s" "$e"; fi; done';
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", root, rel];
}

/** wsl.exe argv for reading: prints `<size>\n` then up to $3 content bytes. */
export function wslReadArgs(distro: string, root: string, rel: string, cap: number): string[] {
  const script =
    'cd "$1" 2>/dev/null || exit 3; f="./$2"; [ -f "$f" ] || exit 4; ' +
    's=$(stat -c %s -- "$f" 2>/dev/null || echo 0); printf "%s\\n" "$s"; head -c "$3" -- "$f"';
  return ["-d", distro, "--exec", "sh", "-c", script, "sh", root, rel, String(cap)];
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
