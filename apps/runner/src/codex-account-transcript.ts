import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const HEADER_LIMIT = 1024 * 1024;

/** Transfer one Codex rollout and its descendant threads, never the account's databases,
 * credentials, configuration, memories, or unrelated conversations. False means neither
 * account has a saved rollout; only the caller can prove an unused thread may start fresh. */
export async function transferCodexAccountTranscript(
  context: AgentContext, id: string, sourceHome: string, targetHome: string,
): Promise<boolean> {
  if (!SAFE_ID.test(id)) throw new Error("unsafe Codex conversation id");
  if (context.kind === "wsl") {
    const result = await runContextCommand(context, "sh", ["-c", WSL_CODEX_TRANSFER, "sh", sourceHome, targetHome, id], {
      cwd: "/", timeoutMs: 60_000, maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim() !== "missing";
  }
  const target = await realpath(targetHome);
  const sharedLeaves = new Set<string>();
  for (const leaf of ["sessions", "archived_sessions"]) {
    const sourceRoot = await realpath(join(sourceHome, leaf)).catch(() => null);
    if (sourceRoot && sourceRoot === await realpath(join(target, leaf)).catch(() => null)) sharedLeaves.add(leaf);
  }
  const files = await inventory(sourceHome, sharedLeaves);
  const matches = files.filter((file) => file.endsWith(`-${id}.jsonl`));
  if (!matches.length) {
    const existing = (await inventory(target, sharedLeaves)).filter((file) => file.endsWith(`-${id}.jsonl`));
    if (existing.length > 1) throw new Error("ambiguous saved Codex conversation");
    return existing.length === 1;
  }
  if (matches.length !== 1) throw new Error("ambiguous saved Codex conversation");
  const selected = new Map<string, string>([[id, matches[0]!]]);
  const children: Array<{ id: string; parent: string; file: string }> = [];
  for (const file of files) {
    const header = await rolloutHeader(file);
    const childId = header?.id;
    const parent = header?.parent_thread_id ?? header?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (typeof childId === "string" && SAFE_ID.test(childId) && typeof parent === "string" &&
        file.endsWith(`-${childId}.jsonl`)) children.push({ id: childId, parent, file });
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const child of children) {
      if (!selected.has(child.parent)) continue;
      const prior = selected.get(child.id);
      if (prior && prior !== child.file) throw new Error("ambiguous Codex descendant history");
      if (!prior) { selected.set(child.id, child.file); changed = true; }
    }
  }
  // Reuse each target's existing path: its private index may point at an archived or
  // differently dated rollout. Creating a second copy can resume stale history.
  const targetFiles = await inventory(target, sharedLeaves);
  const destinations = new Map<string, string>();
  for (const [threadId, file] of selected) {
    const existing = targetFiles.filter((candidate) => candidate.endsWith(`-${threadId}.jsonl`));
    if (existing.length > 1) throw new Error("ambiguous target Codex conversation");
    destinations.set(file, existing[0] ?? join(target, relative(sourceHome, file)));
  }
  // Publish descendants first; no replacement provider can run until every copy completes.
  for (const file of [...selected.values()].reverse()) {
    const destination = destinations.get(file)!;
    if (await realpath(file) === await realpath(destination).catch(() => null)) continue;
    await ensureDirectories(target, relative(target, dirname(destination)));
    const existing = await lstat(destination).catch(() => null);
    if (existing && !existing.isFile()) throw new Error("Codex destination is not a regular file");
    const temporary = join(dirname(destination), `.account-transfer-${randomUUID()}.tmp`);
    try { await cp(file, temporary); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
  }
  return true;
}

async function inventory(home: string, sharedLeaves: Set<string>): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (!info.isDirectory() && !(depth === 0 && sharedLeaves.has(basename(path)))) {
      throw new Error("Codex rollout store is not a real directory");
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory() && depth < 6) await visit(file, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") &&
          (await lstat(file)).size > 0) files.push(file);
    }
  }
  for (const leaf of ["sessions", "archived_sessions"]) await visit(join(home, leaf), 0);
  return files;
}

async function rolloutHeader(file: string): Promise<Record<string, any> | null> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEADER_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) return null;
    const record = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    return record?.type === "session_meta" ? record.payload : null;
  } catch { return null; }
  finally { await handle.close(); }
}

async function ensureDirectories(home: string, path: string): Promise<void> {
  let current = home;
  for (const part of path.split(/[\\/]/)) {
    current = join(current, part);
    await mkdir(current, { recursive: true });
    if (!(await lstat(current)).isDirectory()) throw new Error("Codex destination directory is not a real directory");
  }
}

// Only bounded session_meta headers determine descendants. Shell arguments stay positional.
export const WSL_CODEX_TRANSFER = `set -eu
source_home=$1
target_home=$(readlink -f -- "$2")
[ -d "$target_home" ]
id=$3
inventory() {
  for leaf in sessions archived_sessions; do
    root=$1/$leaf
    if [ -L "$root" ]; then
      other=$source_home
      [ "$1" != "$source_home" ] || other=$target_home
      [ "$(readlink -f -- "$root")" = "$(readlink -f -- "$other/$leaf" || true)" ]
    fi
    [ -e "$root" ] || continue
    [ -d "$root" ]
    find -H "$root" -maxdepth 7 -type f -name 'rollout-*.jsonl' -size +0c
  done
}
all=$(inventory "$source_home")
target_all=$(inventory "$target_home")
scan() {
  printf '%s\\n' "$1" | while IFS= read -r file; do
    case "$file" in *-"$2".jsonl) printf '%s\\n' "$file";; esac
  done
}
matches=$(scan "$all" "$id")
if [ -z "$matches" ]; then
  existing=$(scan "$target_all" "$id")
  if [ -z "$existing" ]; then printf 'missing\\n'; exit 0; fi
  [ "$(printf '%s\\n' "$existing" | wc -l)" = 1 ]
  exit 0
fi
copy_thread() (
  current_id=$1
  ancestors=$2
  case " $ancestors " in *" $current_id "*) exit 0;; esac
  selected=$(scan "$all" "$current_id")
  [ -n "$selected" ] && [ "$(printf '%s\\n' "$selected" | wc -l)" = 1 ]
  existing=$(scan "$target_all" "$current_id")
  if [ -n "$existing" ]; then
    [ "$(printf '%s\\n' "$existing" | wc -l)" = 1 ]
    destination=$existing
  else
    relative=\${selected#"$source_home/"}
    destination=$target_home/$relative
  fi
  printf '%s\\n' "$all" | while IFS= read -r child; do
    [ -n "$child" ] || continue
    header=$(dd if="$child" bs=1048576 count=1 2>/dev/null | head -n 1)
    printf '%s' "$header" | grep -Eq '^[[:space:]]*[{][^{}]*"type"[[:space:]]*:[[:space:]]*"session_meta"' || continue
    prefix='^[[:space:]]*[{][^{}]*"payload"[[:space:]]*:[[:space:]]*[{][^{}]*'
    parent='"parent_thread_id"[[:space:]]*:[[:space:]]*"'"$current_id"'"'
    legacy='"source"[[:space:]]*:[[:space:]]*[{][[:space:]]*"subagent"[[:space:]]*:[[:space:]]*[{][[:space:]]*"thread_spawn"[[:space:]]*:[[:space:]]*[{][^{}]*'
    printf '%s' "$header" | grep -Eq "$prefix$parent|$prefix$legacy$parent" || continue
    child_id=$(printf '%s' "$header" | sed -n 's/^[[:space:]]*{[^{}]*"payload"[[:space:]]*:[[:space:]]*{[^{}]*"id"[[:space:]]*:[[:space:]]*"\\([a-zA-Z0-9_-]*\\)".*/\\1/p')
    [ -n "$child_id" ] || exit 1
    case "$child" in *-"$child_id".jsonl) ;; *) exit 1;; esac
    copy_thread "$child_id" "$ancestors $current_id"
  done
  if [ "$(readlink -f -- "$selected")" = "$(readlink -f -- "$destination" || true)" ]; then exit 0; fi
  directory=\${destination%/*}
  remainder=\${directory#"$target_home/"}
  current=$target_home
  while [ -n "$remainder" ]; do
    part=\${remainder%%/*}
    current=$current/$part
    [ ! -L "$current" ]
    mkdir -p -- "$current"
    [ -d "$current" ]
    case "$remainder" in */*) remainder=\${remainder#*/};; *) remainder=;; esac
  done
  [ ! -L "$destination" ]
  [ ! -e "$destination" ] || [ -f "$destination" ]
  temporary=$(mktemp "$directory/.account-transfer.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  cp -- "$selected" "$temporary"
  mv -f -- "$temporary" "$destination"
)
copy_thread "$id" ''
`;
