import type { AgentContext } from "@wollipog/protocol";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { run } from "../discovery/resolve.js";
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
    stdout: typeof item.stdout === "string" ? item.stdout : "",
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
): CompletedCommandReconciliationProof | null {
  if (!boundedId(threadId) || !boundedId(occurrenceId) || !command || command.length > 2000) return null;
  let sessionIdentityMatches = false;
  const items: Array<ReturnType<typeof completedCommandItem> & { ordinal: number }> = [];
  const completedTurns = new Map<string, number[]>();
  let ordinal = 0;
  for (const line of content.split("\n")) {
    const row = parseLine(line);
    if (!row) continue;
    const payload = object(row.payload);
    if (row.type === "session_meta" && payload?.id === threadId) sessionIdentityMatches = true;
    if (row.type !== "event_msg" || !payload) continue;
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
  const commands = items.filter((item) => item.script === command);
  if (commands.length !== 1) return null;
  const completed = commands[0]!;
  const turnCompletions = completedTurns.get(completed.turnId) ?? [];
  if (turnCompletions.length !== 1 || turnCompletions[0]! <= completed.ordinal) return null;
  if (fence) {
    if (fence.providerThreadId !== threadId || completed.turnId !== fence.providerTurnId ||
        completed.itemId !== fence.providerItemId) return null;
    return {
      commandDigest: createHash("sha256").update(command, "utf8").digest("hex"),
      providerThreadId: threadId,
      providerTurnId: completed.turnId,
      providerItemId: completed.itemId,
    };
  }
  const admissions = items.filter((item) => item.turnId === completed.turnId &&
    item.ordinal < completed.ordinal && legacyAdmission(item, occurrenceId));
  if (admissions.length !== 1) return null;
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
): Promise<CompletedCommandReconciliationProof | null> {
  if (!boundedId(threadId)) return null;
  const content = context.kind === "wsl"
    ? await wslRollout(context.distro, threadId, codexHome)
    : nativeRollout(threadId, codexHome);
  return content ? parseCodexRolloutCompletedCommand(content, threadId, occurrenceId, command, fence) : null;
}
