import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { claudeProjectPathKey } from "./claude-background-work.js";
import { runContextCommand } from "./context-command.js";
import { githubSlug, parseForgeRemote } from "./git-ops.js";

/** Fixed, non-sensitive reasons a live Location switch is refused or fails (#4138). */
export const LOCATION_SWITCH_FAILURES = {
  not_supported: "This session's harness cannot keep its conversation across a Location switch; start a new session there instead.",
  not_native: "Only sessions running directly on their machine can switch Locations; start a new session there instead.",
  unknown_workspace: "The target Location's folder is not one of this machine's workspaces.",
  path_changed: "The target Location's folder changed since it was approved; ask again.",
  not_repository: "The target Location's folder is not a git repository.",
  repository_changed: "The target Location's folder no longer belongs to the approved repository; ask again.",
  same_repository: "This session is already in that repository.",
  busy: "Another Location switch is already waiting for this session.",
  not_resumable: "This session's conversation cannot be resumed, so it cannot move without losing it; start a new session there instead.",
} as const;
export type LocationSwitchFailure = keyof typeof LOCATION_SWITCH_FAILURES;

export class LocationSwitchRefusal extends Error {
  constructor(readonly failure: LocationSwitchFailure) {
    super(LOCATION_SWITCH_FAILURES[failure]);
  }
}

/** Whether `origin` names `repository` the way the control plane's inspection reported it: a GitHub
 * `owner/name`, or a GitLab `host/group/project`, compared case-insensitively. */
export function originNamesRepository(origin: string, repository: string): boolean {
  const wanted = repository.toLowerCase();
  const github = githubSlug(origin);
  if (github) return github.toLowerCase() === wanted;
  const remote = parseForgeRemote(origin);
  return !!remote && (`${remote.host}/${remote.project}`.toLowerCase() === wanted || remote.project.toLowerCase() === wanted);
}

/** Re-verify an approved target on this runner, immediately before it is used: the workspace is
 * this runner's own, its folder is the approved one and a Git checkout, and its origin still names
 * the approved repository. Returns the canonical repository path. */
export async function verifyLocationSwitchTarget(
  context: AgentContext,
  workspaces: readonly { id: string; path: string }[],
  target: { workspaceId: string; workspacePath: string; repository: string },
): Promise<string> {
  const workspace = workspaces.find((candidate) => candidate.id === target.workspaceId);
  if (!workspace) throw new LocationSwitchRefusal("unknown_workspace");
  const [configured, approved] = await Promise.all([
    realpath(workspace.path).catch(() => null),
    realpath(target.workspacePath).catch(() => null),
  ]);
  if (!configured || !approved || configured !== approved) throw new LocationSwitchRefusal("path_changed");
  const git = async (args: string[]) => (await runContextCommand(context, "git", args, { cwd: configured, timeoutMs: 15_000 })).stdout.trim();
  try {
    if (await git(["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("not a work tree");
  } catch {
    throw new LocationSwitchRefusal("not_repository");
  }
  const origin = await git(["remote", "get-url", "origin"]).catch(() => "");
  if (!originNamesRepository(origin, target.repository)) throw new LocationSwitchRefusal("repository_changed");
  return configured;
}

/** The project directories that hold `sessionId`'s transcript under one Claude projects root. */
async function transcriptProjects(root: string, sessionId: string): Promise<string[]> {
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory()) return [];
  const found: string[] = [];
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const transcript = await lstat(join(root, project.name, `${sessionId}.jsonl`)).catch(() => null);
    if (transcript?.isFile() && transcript.size > 0) found.push(project.name);
  }
  return found;
}

async function realTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isFile()) return;
  if (!info.isDirectory()) throw new Error("the conversation history contains a non-regular entry");
  for (const entry of await readdir(path)) await realTree(join(path, entry));
}

/**
 * Claude Code keeps each conversation under a directory named for the working directory it ran
 * in, and resumes only from the current working directory's. Copy exactly this conversation, and
 * the companion directory holding its subagent transcripts, into the new working directory's
 * project in the same root, so the provider resumes it there. The source stays where it is, so
 * the earlier Location's history is untouched. Call only after the old provider has retired.
 *
 * A session that already moved has a copy in every working directory it ran in, and only the one
 * in `sourceCwd`, where its provider last ran, is current. That copy replaces any older one already
 * in the target, such as when a session returns to a Location it left. Returns whether a
 * transcript was found in any of `roots`.
 */
export async function moveClaudeTranscriptToCwd(
  roots: readonly string[], sessionId: string, sourceCwd: string, cwd: string,
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error("the provider conversation id is unsafe to copy");
  const sourceKey = claudeProjectPathKey(sourceCwd);
  const targetKey = claudeProjectPathKey(cwd);
  for (const root of roots) {
    const projects = await transcriptProjects(root, sessionId);
    if (projects.length === 0) continue;
    // A single copy is the conversation wherever it was saved; with several, only the source's is current.
    const current = projects.includes(sourceKey) ? sourceKey : projects.length === 1 ? projects[0]! : undefined;
    if (current === undefined) {
      throw new Error("the conversation has several saved copies and none where the session last ran");
    }
    if (current === targetKey) return true;
    const source = join(root, current);
    const target = join(root, targetKey);
    await mkdir(target, { recursive: true });
    if (!(await lstat(target)).isDirectory()) throw new Error("the conversation store is not a real directory");
    const companions = join(source, sessionId);
    if (await lstat(companions).catch(() => null)) {
      await realTree(companions);
      await cp(companions, join(target, sessionId), { recursive: true, errorOnExist: false, force: true });
    }
    const filename = `${sessionId}.jsonl`;
    const temporary = join(target, `.${filename}.${randomUUID()}.tmp`);
    try {
      await cp(join(source, filename), temporary);
      await rename(temporary, join(target, filename));
    } finally {
      await rm(temporary, { force: true });
    }
    return true;
  }
  return false;
}
