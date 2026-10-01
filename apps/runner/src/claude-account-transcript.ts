import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
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
  const sourceRoot = join(sourceHome, "projects");
  const targetRoot = join(targetHome, "projects");
  await requireDirectory(sourceRoot);
  const matches: string[] = [];
  for (const project of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const transcript = await lstat(join(sourceRoot, project.name, `${sessionId}.jsonl`)).catch(() => null);
    if (transcript?.isFile() && transcript.size > 0) matches.push(project.name);
  }
  if (matches.length !== 1) throw new Error("the source account has no unique saved conversation to resume");
  const project = matches[0]!;
  const source = join(sourceRoot, project);
  const target = join(targetRoot, project);
  await requireDirectory(targetHome);
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
target_root=$2/projects
id=$3
[ -d "$source_root" ] && [ ! -L "$source_root" ]
count=0
for project in "$source_root"/*; do
  [ -d "$project" ] && [ ! -L "$project" ] || continue
  file=$project/$id.jsonl
  [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || continue
  selected=$project
  count=$((count + 1))
done
[ "$count" = 1 ]
[ -d "$2" ] && [ ! -L "$2" ]
[ ! -L "$target_root" ]
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
