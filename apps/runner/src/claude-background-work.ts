import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand, type ContextCommandResult } from "./context-command.js";
import { InspectionCache, InspectionLimiter, inspectionFileVersion } from "./inspection-cache.js";

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
  terminalTaskStatuses?: Map<string, "completed" | "failed" | "killed">;
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
type TerminalStatus = "completed" | "failed" | "killed";
const terminalCache = new InspectionCache<Map<string, TerminalStatus>>();
const inspectionLimiter = new InspectionLimiter();
const MAX_CACHE_RECORD_CHARS = 64 * 1024;

function classifyTranscript(transcript: string, ids: string[]): Map<string, TerminalStatus> {
  const statuses = new Map<string, TerminalStatus>();
  for (const id of ids) {
    const status = providerTranscriptTaskTerminalStatus(transcript, id);
    if (status) statuses.set(id, status);
  }
  return statuses;
}

function cacheClassification(key: string, version: string | null, statuses: Map<string, TerminalStatus>, cache = terminalCache): void {
  if (version && key.length + JSON.stringify([...statuses]).length <= MAX_CACHE_RECORD_CHARS) {
    cache.set(key, version, statuses);
  }
}

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
  const ids = [...new Set([...knownIds, ...files.map((name) => name.slice(0, -7))])].sort();
  const cacheKey = JSON.stringify(["native", cwd, sessionId, transcriptPath, tasksDir, ids]);
  const version = inspectionFileVersion(transcriptPath);
  let statuses = terminalCache.get(cacheKey, version);
  if (!statuses) {
    statuses = new Map();
    try {
      if (statSync(transcriptPath).size <= MAX_TRANSCRIPT_BYTES) {
        statuses = classifyTranscript(readFileSync(transcriptPath, "utf8"), ids);
        if (inspectionFileVersion(transcriptPath) === version) cacheClassification(cacheKey, version, statuses);
        else statuses = new Map();
      }
    } catch {
      // Missing/unreadable evidence is not completion proof and must not reuse stale results.
    }
  }

  const incompleteArtifacts = files
    .map((name) => ({ id: name.slice(0, -".output".length), outputFile: join(tasksDir, name) }))
    .filter(({ id }) => !statuses.has(id));
  const terminalTaskIds = new Set<string>();
  const terminalTaskStatuses = new Map<string, "completed" | "failed" | "killed">();
  for (const id of knownIds) {
    const status = statuses.get(id);
    if (status) { terminalTaskIds.add(id); terminalTaskStatuses.set(id, status); }
  }
  return { incompleteArtifacts, terminalTaskIds, terminalTaskStatuses };
}

type ContextCommandRunner = (
  context: AgentContext,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number; maxBuffer?: number },
) => Promise<ContextCommandResult>;
const injectedCaches = new WeakMap<ContextCommandRunner, InspectionCache<Map<string, TerminalStatus>>>();

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
  return inspectionLimiter.run(() => inspectInContext(context, cwd, sessionId, knownIds, options));
}

async function inspectInContext(
  context: AgentContext, cwd: string, sessionId: string, knownIds: string[],
  options: ClaudeContextDiscoveryOptions,
): Promise<ClaudeBackgroundWorkInspection> {
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
    'if [ -d "$tasks" ]; then find "$tasks" -maxdepth 1 -type f -name "*.output" -printf "%f\\n" 2>/dev/null; fi',
    'ledger="${3:-$HOME/.claude/projects}/$key/$2.jsonl"',
    'stat -Lc "__WOLLIPOG_LEDGER__:%d:%i:%s:%y:%z:%a" "$ledger" 2>/dev/null || true',
  ].join("; ");
  let listing: ContextCommandResult;
  try {
    listing = await run(context, "sh", ["-c", listScript, "wollipog", cwd, sessionId,
      ...(options.projectsRoot ? [options.projectsRoot] : [])], {
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
    'stat -Lc "__WOLLIPOG_LEDGER__:%d:%i:%s:%y:%z:%a" "${3:-$HOME/.claude/projects}/$key/$2.jsonl" >&2',
  ].join("; ");
  const ids = [...new Set([...knownIds, ...names.map((name) => name.slice(0, -7))])].sort();
  const cacheKey = JSON.stringify(["context", context, cwd, sessionId, env, options.projectsRoot, ids]);
  const version = listing.stdout.split(/\r?\n/).find((line) => line.startsWith("__WOLLIPOG_LEDGER__:")) ?? null;
  // Injected command runners are independent contexts too; never share their cached proof.
  let cache = terminalCache;
  if (options.run) {
    cache = injectedCaches.get(options.run) ?? new InspectionCache();
    injectedCaches.set(options.run, cache);
  }
  let statuses = cache.get(cacheKey, version);
  if (!statuses) {
    statuses = new Map();
    try {
      const result = await run(context, "sh", ["-c", transcriptScript, "wollipog", cwd, sessionId,
      ...(options.projectsRoot ? [options.projectsRoot] : [])], {
      cwd: "/",
      env,
      timeoutMs: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      });
      statuses = classifyTranscript(result.stdout, ids);
      if (result.stderr.trim() === version) cacheClassification(cacheKey, version, statuses, cache);
      else if (version !== null) statuses = new Map();
    } catch {
      // Listing proves the artifacts exist. An unreadable or oversized ledger proves nothing.
    }
  }
  const key = claudeProjectPathKey(cwd);
  const tempRoot = (env.TMPDIR || "/tmp").replace(/\/+$/, "") || "/";
  const tasksDir = `${tempRoot === "/" ? "" : tempRoot}/claude/${key}/${sessionId}/tasks`;
  const incompleteArtifacts = names
    .map((name) => ({ id: name.slice(0, -".output".length), outputFile: `${tasksDir}/${name}` }))
    .filter(({ id }) => !statuses.has(id));
  const terminalTaskIds = new Set<string>();
  const terminalTaskStatuses = new Map<string, "completed" | "failed" | "killed">();
  for (const id of knownIds) {
    const status = statuses.get(id);
    if (status) { terminalTaskIds.add(id); terminalTaskStatuses.set(id, status); }
  }
  return { incompleteArtifacts, terminalTaskIds, terminalTaskStatuses };
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
  return providerTranscriptTaskTerminalStatus(transcript, taskId) !== undefined;
}

function providerTranscriptTaskTerminalStatus(
  transcript: string, taskId: string,
): "completed" | "failed" | "killed" | undefined {
  let latestTerminal = -1;
  let status: "completed" | "failed" | "killed" | undefined;
  const marker = `<task-id>${taskId}</task-id>`;
  for (let cursor = transcript.indexOf(marker); cursor >= 0; cursor = transcript.indexOf(marker, cursor + marker.length)) {
    const end = transcript.indexOf("</task-notification>", cursor);
    if (end < 0) break;
    const notification = transcript.slice(cursor, end);
    const match = /<status>(completed|failed|killed)<\/status>/i.exec(notification);
    if (match) {
      latestTerminal = cursor;
      status = match[1]!.toLowerCase() as typeof status;
    }
  }
  if (latestTerminal < 0) return undefined;

  // A stopped task explicitly has no completion record and remains recoverable. A later launch or
  // resume of the same id also invalidates an earlier terminal notification.
  const latestLaunch = Math.max(
    transcript.lastIndexOf(`"agentId":"${taskId}"`),
    transcript.lastIndexOf(`"taskId":"${taskId}"`),
    transcript.lastIndexOf(`"resumedAgentId":"${taskId}"`),
  );
  return latestTerminal >= latestLaunch ? status : undefined;
}
