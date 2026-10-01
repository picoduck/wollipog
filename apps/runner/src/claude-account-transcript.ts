import { cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";

/** Copy only the selected conversation's history into the chosen credential context. Account
 * configuration, credentials, other conversations, and source history stay untouched. Call
 * after the old provider retires, before the replacement can accept a prompt. */
export async function transferClaudeAccountTranscript(
  context: AgentContext,
  sessionId: string,
  sourceHome: string,
  targetHome: string,
): Promise<void> {
  if (sourceHome === targetHome) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("the provider conversation id is unsafe for transcript transfer");
  if (context.kind === "wsl") {
    await runContextCommand(context, "sh", ["-c", WSL_TRANSFER, "sh", sourceHome, targetHome, sessionId], {
      cwd: "/", timeoutMs: 60_000,
    });
    return;
  }
  // Configured homes may be aliases chosen by the operator. Transcript entries themselves
  // still cannot redirect a copy through symlinks.
  const canonicalTargetHome = await realpath(targetHome);
  const sourceRoot = join(sourceHome, "projects");
  const targetRoot = join(canonicalTargetHome, "projects");
  const canonicalSourceRoot = await realpath(sourceRoot).catch(() => null);
  const canonicalTargetRoot = await realpath(targetRoot).catch(() => null);
  if (canonicalSourceRoot && canonicalSourceRoot === canonicalTargetRoot) {
    if ((await conversationProjects(canonicalSourceRoot, sessionId)).length !== 1) {
      throw new Error("the shared account store has no unique saved conversation to resume");
    }
    return;
  }
  const matches = await conversationProjects(sourceRoot, sessionId);
  // Older runners changed the account binding without moving history. Returning to the
  // account that already owns the exact conversation remains a valid recovery operation.
  if (matches.length === 0 && (await conversationProjects(targetRoot, sessionId)).length === 1) return;
  if (matches.length !== 1) throw new Error("the source account has no unique saved conversation to resume");
  const project = matches[0]!;
  const source = join(sourceRoot, project);
  const target = join(targetRoot, project);
  await requireDirectory(canonicalTargetHome);
  await requireDirectory(targetRoot, true);
  await requireDirectory(target, true);
  // Claude stores subagent transcripts in the directory named for this conversation.
  const companions = await lstat(join(source, sessionId)).catch(() => null);
  if (companions) {
    await requireTree(join(source, sessionId));
    const existing = await lstat(join(target, sessionId)).catch(() => null);
    if (existing) await requireTree(join(target, sessionId));
    await cp(join(source, sessionId), join(target, sessionId), { recursive: true });
  }
  const filename = `${sessionId}.jsonl`;
  const existing = await lstat(join(target, filename)).catch(() => null);
  if (existing && !existing.isFile()) throw new Error("the destination transcript is not a regular file");
  const temporary = join(target, `.${filename}.${randomUUID()}.tmp`);
  try {
    await cp(join(source, filename), temporary);
    await rename(temporary, join(target, filename));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function conversationProjects(root: string, sessionId: string): Promise<string[]> {
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return [];
  if (!info.isDirectory()) throw new Error("the conversation store is not a real directory");
  const matches: string[] = [];
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const transcript = await lstat(join(root, project.name, `${sessionId}.jsonl`)).catch(() => null);
    if (transcript?.isFile() && transcript.size > 0) matches.push(project.name);
  }
  return matches;
}

async function requireDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error("the conversation store is not a real directory");
}

async function requireTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isFile()) return;
  if (!info.isDirectory()) throw new Error("the conversation history contains a non-regular entry");
  for (const entry of await readdir(path)) await requireTree(join(path, entry));
}

// Homes and session ids remain positional arguments, including shell metacharacters.
export const WSL_TRANSFER = `set -eu
source_root=$1/projects
target_home=$(readlink -f -- "$2")
[ -d "$target_home" ]
target_root=$target_home/projects
id=$3
scan() {
  count=0
  for project in "$1"/*; do
    [ -d "$project" ] && [ ! -L "$project" ] || continue
    file=$project/$id.jsonl
    [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || continue
    selected=$project
    count=$((count + 1))
  done
}
source_real=$(readlink -f -- "$source_root" || true)
target_real=$(readlink -f -- "$target_root" || true)
if [ -n "$source_real" ] && [ "$source_real" = "$target_real" ]; then
  scan "$source_real"
  [ "$count" = 1 ]
  exit 0
fi
[ ! -L "$source_root" ]
[ ! -L "$target_root" ]
if [ -e "$source_root" ]; then [ -d "$source_root" ]; fi
if [ -e "$target_root" ]; then [ -d "$target_root" ]; fi
scan "$source_root"
if [ "$count" = 0 ]; then
  scan "$target_root"
  [ "$count" = 1 ]
  exit 0
fi
[ "$count" = 1 ]
mkdir -p -- "$target_root"
project_name=\${selected##*/}
target=$target_root/$project_name
[ ! -L "$target" ]
mkdir -p -- "$target"
if [ -e "$selected/$id" ] || [ -L "$selected/$id" ]; then
  [ -d "$selected/$id" ] && [ ! -L "$selected/$id" ]
  [ -z "$(find "$selected/$id" ! -type d ! -type f -print -quit)" ]
  [ ! -L "$target/$id" ]
  if [ -e "$target/$id" ]; then
    [ -d "$target/$id" ]
    [ -z "$(find "$target/$id" ! -type d ! -type f -print -quit)" ]
  fi
  mkdir -p -- "$target/$id"
  cp -R -- "$selected/$id/." "$target/$id/"
fi
[ ! -L "$target/$id.jsonl" ]
[ ! -e "$target/$id.jsonl" ] || [ -f "$target/$id.jsonl" ]
temporary=$(mktemp "$target/.$id.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
cp -- "$selected/$id.jsonl" "$temporary"
mv -f -- "$temporary" "$target/$id.jsonl"
`;
