import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand, type ContextCommandResult } from "./context-command.js";

export interface ClaudeTaskArtifact {
  id: string;
  outputFile: string;
}

export interface ClaudeTaskDiscoveryRoots {
  tempRoot?: string;
  claudeHome?: string;
  projectsRoot?: string;
}

export type ClaudeTaskLifecycleState = "terminal" | "incomplete" | "unknown";

export interface ClaudeBackgroundWorkInspection {
  incompleteArtifacts: ClaudeTaskArtifact[];
  terminalTaskIds: Set<string>;
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/** Claude uses the same lossy path key for its project transcript and per-session temp tree. */
export function claudeProjectPathKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Return task artifacts whose latest durable provider evidence does not prove terminal completion.
 * This is deliberately conservative: an unreadable transcript means every artifact is incomplete.
 */
export function discoverIncompleteClaudeTasks(
  cwd: string,
  sessionId: string,
  roots: ClaudeTaskDiscoveryRoots = {},
): ClaudeTaskArtifact[] {
  return inspectClaudeBackgroundWork(cwd, sessionId, [], roots).incompleteArtifacts;
}

/** One bounded native ledger read classifies both newly discovered artifacts and already-known ids. */
export function inspectClaudeBackgroundWork(
  cwd: string,
  sessionId: string,
  knownTaskIds: Iterable<string>,
  roots: ClaudeTaskDiscoveryRoots = {},
): ClaudeBackgroundWorkInspection {
  const knownIds = [...knownTaskIds];
  const key = claudeProjectPathKey(cwd);
  const tasksDir = join(roots.tempRoot ?? tmpdir(), "claude", key, sessionId, "tasks");
  let files: string[];
  try {
    files = readdirSync(tasksDir).filter((name) => name.endsWith(".output"));
  } catch {
    files = [];
  }

  // Startup/reconnect scans every stored Claude session. Avoid a synchronous ledger read (up to
  // 64 MiB) when there is neither an artifact to classify nor a retained id to reconcile.
  if (files.length === 0 && knownIds.length === 0) {
    return { incompleteArtifacts: [], terminalTaskIds: new Set() };
  }

  const transcriptPath = join(roots.projectsRoot ?? join(roots.claudeHome ?? join(homedir(), ".claude"), "projects"), key, `${sessionId}.jsonl`);
  let transcript: string | null = null;
  try {
    if (statSync(transcriptPath).size <= MAX_TRANSCRIPT_BYTES) transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    // The artifact proves work existed; without the provider ledger there is no safe completion
    // inference. The lifecycle policy's fixed tie-break is therefore to keep/recover it.
  }

  const incompleteArtifacts = files
    .map((name) => ({ id: name.slice(0, -".output".length), outputFile: join(tasksDir, name) }))
    .filter(({ id }) => transcript == null || !providerTranscriptProvesTaskTerminal(transcript, id));
  const terminalTaskIds = new Set<string>();
  if (transcript != null) {
    for (const id of knownIds) if (providerTranscriptProvesTaskTerminal(transcript, id)) terminalTaskIds.add(id);
  }
  return { incompleteArtifacts, terminalTaskIds };
}

type ContextCommandRunner = (
  context: AgentContext,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number; maxBuffer?: number },
) => Promise<ContextCommandResult>;

export interface ClaudeContextDiscoveryOptions {
  env?: Record<string, string>;
  projectsRoot?: string;
  run?: ContextCommandRunner;
}

/** Context-aware startup fallback. WSL paths are resolved inside the selected distro and all
 * caller-controlled values are positional shell arguments, never interpolated into the script. */
export async function discoverIncompleteClaudeTasksInContext(
  context: AgentContext,
  cwd: string,
  sessionId: string,
  options: ClaudeContextDiscoveryOptions = {},
): Promise<ClaudeTaskArtifact[]> {
  return (await inspectClaudeBackgroundWorkInContext(context, cwd, sessionId, [], options)).incompleteArtifacts;
}

export async function inspectClaudeBackgroundWorkInContext(
  context: AgentContext,
  cwd: string,
  sessionId: string,
  knownTaskIds: Iterable<string>,
  options: ClaudeContextDiscoveryOptions = {},
): Promise<ClaudeBackgroundWorkInspection> {
  const knownIds = [...knownTaskIds];
  const env = options.env ?? {};
  if (context.kind === "native") {
    return inspectClaudeBackgroundWork(cwd, sessionId, knownIds, {
      tempRoot: env.TMPDIR ?? env.TEMP ?? env.TMP,
      claudeHome: env.HOME ? join(env.HOME, ".claude") : undefined,
      projectsRoot: options.projectsRoot,
    });
  }
  const run = options.run ?? runContextCommand;
  const listScript = [
    'key=$(printf %s "$1" | sed "s/[^A-Za-z0-9]/-/g")',
    'tasks="${TMPDIR:-/tmp}/claude/$key/$2/tasks"',
    '[ -d "$tasks" ] || exit 0',
    'find "$tasks" -maxdepth 1 -type f -name "*.output" -printf "%f\\n" 2>/dev/null',
  ].join("; ");
  let listing: ContextCommandResult;
  try {
    listing = await run(context, "sh", ["-c", listScript, "wollipog", cwd, sessionId], {
      cwd: "/",
      env,
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return { incompleteArtifacts: [], terminalTaskIds: new Set() };
  }
  const names = listing.stdout.split(/\r?\n/).filter((name) => /^[A-Za-z0-9_-]+\.output$/.test(name));
  if (names.length === 0 && knownIds.length === 0) {
    return { incompleteArtifacts: [], terminalTaskIds: new Set() };
  }
  const transcriptScript = [
    'key=$(printf %s "$1" | sed "s/[^A-Za-z0-9]/-/g")',
    'if [ -n "$3" ]; then cat "$3/$key/$2.jsonl" 2>/dev/null; else cat "$HOME/.claude/projects/$key/$2.jsonl" 2>/dev/null; fi',
  ].join("; ");
  let transcript: string | null = null;
  try {
    transcript = (await run(context, "sh", ["-c", transcriptScript, "wollipog", cwd, sessionId,
      ...(options.projectsRoot ? [options.projectsRoot] : [])], {
      cwd: "/",
      env,
      timeoutMs: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    })).stdout;
  } catch {
    // Listing proves the artifacts exist. An unreadable or oversized ledger proves nothing.
  }
  const key = claudeProjectPathKey(cwd);
  const tempRoot = (env.TMPDIR || "/tmp").replace(/\/+$/, "") || "/";
  const tasksDir = `${tempRoot === "/" ? "" : tempRoot}/claude/${key}/${sessionId}/tasks`;
  const incompleteArtifacts = names
    .map((name) => ({ id: name.slice(0, -".output".length), outputFile: `${tasksDir}/${name}` }))
    .filter(({ id }) => transcript == null || !providerTranscriptProvesTaskTerminal(transcript, id));
  const terminalTaskIds = new Set<string>();
  if (transcript != null) {
    for (const id of knownIds) if (providerTranscriptProvesTaskTerminal(transcript, id)) terminalTaskIds.add(id);
  }
  return { incompleteArtifacts, terminalTaskIds };
}

/** Read only the provider ledger when reconciling an already-known task. Output text is never
 * terminal proof: it may quote another task or describe work that has not durably settled. */
export function discoverClaudeTaskLifecycle(
  cwd: string,
  sessionId: string,
  taskId: string,
  roots: ClaudeTaskDiscoveryRoots = {},
): ClaudeTaskLifecycleState {
  const key = claudeProjectPathKey(cwd);
  const transcriptPath = join(roots.projectsRoot ?? join(roots.claudeHome ?? join(homedir(), ".claude"), "projects"), key, `${sessionId}.jsonl`);
  let transcript: string;
  try {
    if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) return "unknown";
    transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    return "unknown";
  }
  return providerTranscriptProvesTaskTerminal(transcript, taskId) ? "terminal" : "incomplete";
}

function providerTranscriptProvesTaskTerminal(transcript: string, taskId: string): boolean {
  let latestTerminal = -1;
  const marker = `<task-id>${taskId}</task-id>`;
  for (let cursor = transcript.indexOf(marker); cursor >= 0; cursor = transcript.indexOf(marker, cursor + marker.length)) {
    const end = transcript.indexOf("</task-notification>", cursor);
    if (end < 0) break;
    const notification = transcript.slice(cursor, end);
    if (/<status>(?:completed|failed|killed)<\/status>/i.test(notification)) latestTerminal = cursor;
  }
  if (latestTerminal < 0) return false;

  // A stopped task explicitly has no completion record and remains recoverable. A later launch or
  // resume of the same id also invalidates an earlier terminal notification.
  const latestLaunch = Math.max(
    transcript.lastIndexOf(`"agentId":"${taskId}"`),
    transcript.lastIndexOf(`"taskId":"${taskId}"`),
    transcript.lastIndexOf(`"resumedAgentId":"${taskId}"`),
  );
  return latestTerminal >= latestLaunch;
}
