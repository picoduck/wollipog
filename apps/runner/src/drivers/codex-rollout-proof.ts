import type { AgentContext } from "@wollipog/protocol";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { run } from "../discovery/resolve.js";
import { codexCliAdmission } from "./codex-cli-admission.js";
import type {
  CompletedCommandReconciliationFence,
  CompletedCommandReconciliationProof,
} from "./driver.js";

const MAX_ROLLOUT_BYTES = 128 * 1024 * 1024;
const MAX_CORRELATION_ID = 512;
const PROVIDER_SHELLS = new Set(["ash", "bash", "dash", "ksh", "sh", "zsh"]);

type Json = Record<string, unknown>;

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CORRELATION_ID &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

function object(value: unknown): Json | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function parseLine(line: string): Json | null {
  try {
    return object(JSON.parse(line));
  } catch {
    return null;
  }
}

function shellScript(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "string" ||
      (value[1] !== "-c" && value[1] !== "-lc") || typeof value[2] !== "string") return null;
  const shell = basename(value[0]);
  return isAbsolute(value[0]) && PROVIDER_SHELLS.has(shell)
    ? value[2] : null;
}

function completedCommandItem(payload: Json, threadId: string): {
  turnId: string;
  itemId: string;
  script: string;
  stdout: string;
} | null {
  if (payload.type !== "item_completed" || payload.thread_id !== threadId || !boundedId(payload.turn_id)) return null;
  const item = object(payload.item);
  if (!item || item.type !== "CommandExecution" || item.status !== "completed" ||
      item.exit_code !== 0 || !boundedId(item.id)) return null;
  const script = shellScript(item.command);
  if (!script) return null;
  return {
    turnId: payload.turn_id,
    itemId: item.id,
    script,
    stdout: typeof item.aggregated_output === "string" ? item.aggregated_output :
      typeof item.stdout === "string" ? item.stdout : "",
  };
}

function legacyAdmission(item: ReturnType<typeof completedCommandItem>, occurrenceId: string): boolean {
  if (!item) return false;
  const lines = item.script.split("\n");
  const prefix = `curl --silent --show-error --fail-with-body -X POST ` +
    `-H "authorization: Bearer $task_token" ` +
    `-H "x-wollipog-agent-session: $WOLLIPOG_SESSION_ID" ` +
    `-H "content-type: application/json" --data-binary @`;
  const suffix = ` "$WOLLIPOG_CONTROL_PLANE_URL/api/sessions/$WOLLIPOG_SESSION_ID/` +
    `workflow-decisions/${occurrenceId}/consume" | jq '{occurrenceId,status,authority,action,consumedAt}'`;
  if (lines.length !== 2 || lines[0] !== 'task_token=$(<"$WOLLIPOG_SESSION_TOKEN_FILE")' ||
      !lines[1]!.startsWith(prefix) || !lines[1]!.endsWith(suffix)) return false;
  const bodyPath = lines[1]!.slice(prefix.length, -suffix.length);
  if (!/^\/tmp\/[+._0-9A-Za-z-]{1,128}\.json$/u.test(bodyPath)) return false;
  try {
    const response = object(JSON.parse(item.stdout));
    return response?.occurrenceId === occurrenceId && response.status === "approved" &&
      response.authority === "orchestrator" && response.consumedAt === null;
  } catch {
    return false;
  }
}

/** Parse the provider's append-only rollout, not its post-restart in-memory thread projection.
 * Raw command/output remain local; callers receive only content-safe identities. */
export function parseCodexRolloutCompletedCommand(
  content: string,
  threadId: string,
  occurrenceId: string,
  command: string,
  fence?: CompletedCommandReconciliationFence,
  onFailure?: (reason: string) => void,
): CompletedCommandReconciliationProof | null {
  if (!boundedId(threadId) || !boundedId(occurrenceId) || !command || command.length > 2000) return null;
  let sessionIdentityMatches = false;
  const items: Array<ReturnType<typeof completedCommandItem> & { ordinal: number }> = [];
  const completedTurns = new Map<string, number[]>();
  const mcpBoundaries: Array<{ ordinal: number; occurrenceId: unknown }> = [];
  const exactCommandStatuses = new Map<string, unknown>();
  let ordinal = 0;
  for (const line of content.split("\n")) {
    const row = parseLine(line);
    if (!row) continue;
    const payload = object(row.payload);
    if (row.type === "session_meta" && payload?.id === threadId) sessionIdentityMatches = true;
    if (row.type !== "event_msg" || !payload) continue;
    const nativeItem = object(payload.item);
    if (nativeItem?.type === "CommandExecution" && boundedId(nativeItem.id) &&
        shellScript(nativeItem.command) === command) exactCommandStatuses.set(nativeItem.id, nativeItem.status);
    if (payload.type === "item_completed" && nativeItem?.type === "McpToolCall" &&
        nativeItem.server === "wollipog" && nativeItem.tool === "consume_workflow_decision") {
      const args = object(nativeItem.arguments);
      if (!args || object(args.action)?.command === command) {
        mcpBoundaries.push({ ordinal, occurrenceId: args?.occurrenceId });
      }
    }
    if (payload.type === "task_complete" && boundedId(payload.turn_id)) {
      const completions = completedTurns.get(payload.turn_id) ?? [];
      completions.push(ordinal);
      completedTurns.set(payload.turn_id, completions);
    }
    const item = completedCommandItem(payload, threadId);
    if (item) items.push({ ...item, ordinal });
    ordinal += 1;
  }
  if (!sessionIdentityMatches) return null;
  if ([...exactCommandStatuses.values()].some((status) => !["completed", "failed", "interrupted"].includes(status as string))) {
    // Unknown provider statuses are not evidence of a terminal non-enqueue. Retain the
    // conservative veto until that status has a documented terminal meaning.
    onFailure?.("provider rollout contains an unfinished or unrecognized exact-command status");
    return null;
  }
  const commands = items.filter((item) => item.script === command);
  if (!commands.length) {
    onFailure?.("provider rollout did not prove successful completion of the exact command");
    return null;
  }
  const cliAdmissions = items.flatMap((item) => {
    const cli = codexCliAdmission(item.script, item.stdout, threadId, item.turnId);
    if (!cli && item.script.includes(" decision consume ")) {
      mcpBoundaries.push({ ordinal: item.ordinal, occurrenceId: undefined });
    }
    return cli?.command === command ? [{ item, cli }] : [];
  });
  const ownCli = cliAdmissions.filter(({ cli }) => cli.occurrenceId === occurrenceId && cli.approved);
  const own = ownCli.length === 1 ? ownCli[0] : undefined;
  const next = own && cliAdmissions.find(({ item, cli }) => item.ordinal > own.item.ordinal &&
    cli.occurrenceId !== occurrenceId);
  const nextMcp = own && mcpBoundaries.sort((a, b) => a.ordinal - b.ordinal).find((boundary) => boundary.ordinal > own.item.ordinal &&
    boundary.occurrenceId !== occurrenceId);
  const window = own && commands.filter((item) => item.ordinal > own.item.ordinal &&
    (!next || item.ordinal < next.item.ordinal) && (!nextMcp || item.ordinal < nextMcp.ordinal));
  const completed = own ? window?.length === 1 && window[0] === commands.at(-1) ? window[0] : undefined :
    commands.length === 1 ? commands[0] : undefined;
  if (!completed || ownCli.length > 1) {
    onFailure?.("provider rollout could not uniquely bind the successful command to its action admission");
    return null;
  }
  const turnCompletions = completedTurns.get(completed.turnId) ?? [];
  if (turnCompletions.length !== 1 || turnCompletions[0]! <= completed.ordinal) {
    onFailure?.("provider rollout did not prove completion of the command's turn");
    return null;
  }
  if (fence) {
    if (commands.length !== 1) return null;
    if (fence.providerThreadId !== threadId || completed.turnId !== fence.providerTurnId ||
        completed.itemId !== fence.providerItemId) return null;
    return {
      commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
      providerThreadId: threadId,
      providerTurnId: completed.turnId,
      providerItemId: completed.itemId,
    };
  }
  if (own) {
    if (own.item.turnId !== completed.turnId) return null;
    return {
      commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
      providerThreadId: threadId,
      providerTurnId: completed.turnId,
      providerAdmissionItemId: own.item.itemId,
      providerItemId: completed.itemId,
    };
  }
  const admissions = items.filter((item) => item.turnId === completed.turnId &&
    item.ordinal < completed.ordinal && legacyAdmission(item, occurrenceId));
  if (admissions.length !== 1) {
    onFailure?.("provider rollout did not prove the exact action admission before the successful command");
    return null;
  }
  return {
    commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
    providerThreadId: threadId,
    providerTurnId: completed.turnId,
    providerAdmissionItemId: admissions[0]!.itemId,
    providerItemId: completed.itemId,
  };
}

function walkRollouts(root: string, threadId: string, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 1) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkRollouts(path, threadId, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) out.push(path);
    if (out.length > 1) return;
  }
}

function nativeRollout(threadId: string, codexHome?: string): string | null {
  const root = codexHome && isAbsolute(codexHome)
    ? join(codexHome, "sessions")
    : codexHome ? null : join(homedir(), ".codex", "sessions");
  if (!root) return null;
  const matches: string[] = [];
  walkRollouts(root, threadId, matches);
  walkRollouts(join(codexHome && isAbsolute(codexHome) ? codexHome : join(homedir(), ".codex"),
    "archived_sessions"), threadId, matches);
  if (matches.length !== 1) return null;
  try {
    const size = statSync(matches[0]!).size;
    return size > 0 && size <= MAX_ROLLOUT_BYTES ? readFileSync(matches[0]!, "utf8") : null;
  } catch {
    return null;
  }
}

async function wslRollout(distro: string, threadId: string, codexHome?: string): Promise<string | null> {
  const script = [
    'root="$1"',
    'id="$2"',
    '[ -n "$root" ] || root="$HOME/.codex"',
    'matches=$(find "$root/sessions" "$root/archived_sessions" -type f -name "*$id*.jsonl" -print 2>/dev/null | head -2)',
    '[ "$(printf "%s\\n" "$matches" | sed "/^$/d" | wc -l)" -eq 1 ] || exit 0',
    'f="$matches"',
    'size=$(wc -c < "$f")',
    `[ "$size" -gt 0 ] && [ "$size" -le ${MAX_ROLLOUT_BYTES} ] && cat "$f"`,
  ].join("; ");
  const result = await run("wsl.exe", [
    "-d", distro, "--exec", "sh", "-c", script, "sh", codexHome ?? "", threadId,
  ], { timeoutMs: 10_000, maxBuffer: MAX_ROLLOUT_BYTES });
  return result.code === 0 && result.stdout ? result.stdout : null;
}

export async function readCodexRolloutCompletedCommand(
  context: AgentContext,
  codexHome: string | undefined,
  threadId: string,
  occurrenceId: string,
  command: string,
  fence?: CompletedCommandReconciliationFence,
  onFailure?: (reason: string) => void,
): Promise<CompletedCommandReconciliationProof | null> {
  if (!boundedId(threadId)) return null;
  const content = context.kind === "wsl"
    ? await wslRollout(context.distro, threadId, codexHome)
    : nativeRollout(threadId, codexHome);
  if (!content) {
    onFailure?.("provider rollout history was unavailable or ambiguous");
    return null;
  }
  return parseCodexRolloutCompletedCommand(content, threadId, occurrenceId, command, fence, onFailure);
}
