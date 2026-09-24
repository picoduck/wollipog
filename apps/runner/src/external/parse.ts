/**
 * Phase 3: pure, version-tolerant parsers for the bare CLIs' on-disk session stores. Kept separate
 * from the filesystem walking (sources.ts) so they unit-test against fixtures with no I/O.
 *
 * Both stores are append-only JSONL. We never throw on a malformed/unknown line — we skip it — so a
 * schema change in a future CLI version degrades to "fewer events / no title", never a crash.
 *
 *   Claude  ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl   (filename uuid = --resume id)
 *   Codex   ~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl  (session_meta.payload.id = resume id)
 *   Pi      ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl  (header id = --session id)
 */

import type { AgentContext, ExternalSessionDescriptor, SessionEventPayload } from "@wollipog/protocol";
import { SKILL_TOOL_KIND, skillToolTitle } from "../drivers/skill-tool.js";

const TITLE_MAX = 100;

function splitLines(content: string): string[] {
  return content.split("\n").filter((l) => l.trim().length > 0);
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function tsToMs(v: unknown, fallback: number): number {
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

function finiteNonNegative(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Truncate a value for an event body so a single huge tool output can't bloat the store. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…(${s.length - max} more chars)` : s;
}
const TITLE_CLIP = 140;
const BODY_CLIP = 8000;

/* ------------------------------- Claude Code ------------------------------ */

/** Text of a claude transcript line, whose `message.content` is a string or an array of blocks. */
function claudeText(obj: Record<string, unknown>): string {
  const msg = obj.message as { content?: unknown } | undefined;
  const c = msg?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { type: string; text: string } => !!b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
  }
  return "";
}

/** Strip Claude Code's local-command / system wrappers (mirrors stripCodexNoise for codex). These
 * are injected as user-role messages when a local slash command runs (e.g. /model), so without this
 * a "<local-command-caveat>…" block surfaces as the session title or a bogus user prompt. */
export function stripClaudeNoise(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<(command-name|command-message|command-args)>[\s\S]*?<\/\1>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

/** Parse a claude session file into a list descriptor (cheap: just the head fields). */
export function parseClaudeSession(
  content: string,
  fileName: string,
  mtimeMs: number,
  context: AgentContext,
): ExternalSessionDescriptor | null {
  const id = fileName.replace(/\.jsonl$/i, "");
  // Claude names files by the session uuid; bail on anything that isn't id-shaped.
  if (!/^[0-9a-f][0-9a-f-]{10,}$/i.test(id)) return null;
  let cwd = "";
  let title = "";
  let createdAt = mtimeMs;
  let sawFirstTs = false;
  let count = 0;
  for (const line of splitLines(content)) {
    const obj = tryParse(line);
    if (!obj) continue;
    if (!cwd) cwd = asString(obj.cwd);
    if (!sawFirstTs && typeof obj.timestamp === "string") {
      createdAt = tsToMs(obj.timestamp, mtimeMs);
      sawFirstTs = true;
    }
    if (obj.type === "user" || obj.type === "assistant") {
      count++;
      // Strip Claude Code's local-command/system wrappers; when a message is nothing but those it
      // strips to empty, so `title` stays unset and we fall through to the first REAL user prompt.
      if (!title && obj.type === "user") {
        const t = stripClaudeNoise(claudeText(obj)).slice(0, TITLE_MAX);
        if (t) title = t;
      }
    }
  }
  return { agentSessionId: id, driver: "claude-code", cwd, context, title, createdAt, updatedAt: mtimeMs, messageCount: count };
}

/** Content blocks of a claude transcript line (a string `content` → one synthetic text block). */
function claudeBlocks(obj: Record<string, unknown>): Array<Record<string, unknown>> {
  const msg = obj.message as { content?: unknown } | undefined;
  const c = msg?.content;
  if (typeof c === "string") return c.trim() ? [{ type: "text", text: c }] : [];
  if (Array.isArray(c)) return c.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
  return [];
}

/** Flatten a claude tool_result's `content` (string | block[]) to text. */
function claudeResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function claudeToolKind(name: string): string | undefined {
  if (/^(Read|NotebookRead)$/.test(name)) return "read";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "edit";
  if (/^(Glob|Grep|LS)$/.test(name)) return "search";
  if (name === "Bash") return "execute";
  if (/^(WebFetch|WebSearch)$/.test(name)) return "fetch";
  if (name === "Task" || name === "Agent") return "agent";
  if (name === "Skill") return SKILL_TOOL_KIND;
  return undefined;
}

function claudeToolTitle(name: string, input: Record<string, unknown>): string {
  if (name === "Skill") return skillToolTitle(input.skill, input.args);
  if (name === "Bash") return clip(asString(input.command) || name, TITLE_CLIP);
  const path = asString(input.file_path) || asString(input.path) || asString(input.pattern) || asString(input.notebook_path);
  return clip(path ? `${name}: ${path}` : name, TITLE_CLIP);
}

/** Edit-family tools whose target path we surface as a file_edit card (the diff isn't in the transcript). */
function claudeEditPath(name: string, input: Record<string, unknown>): string | null {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return asString(input.file_path) || asString(input.notebook_path) || null;
  return null;
}

/**
 * Parse a claude transcript into our event payloads. Beyond user/agent text we recover the rich
 * turn structure so an adopted timeline matches a live one: `thinking` → agent_thought, `tool_use`
 * → tool_call (+ file_edit for edits), `tool_result` → tool_call_update. Whole messages are tagged
 * `final` so the UI keeps them as distinct bubbles.
 */
export function parseClaudeTranscript(content: string): SessionEventPayload[] {
  const out: SessionEventPayload[] = [];
  for (const line of splitLines(content)) {
    const obj = tryParse(line);
    if (!obj) continue;
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const parentId = asString(obj.parent_tool_use_id);
    const pp = parentId ? { parentToolUseId: parentId } : {};
    for (const b of claudeBlocks(obj)) {
      switch (asString(b.type)) {
        case "text": {
          // User turns can be pure local-command/system wrappers — strip them so adopted history
          // doesn't show bogus "<local-command-caveat>…" bubbles (assistant text is left as-is).
          const text = obj.type === "user" ? stripClaudeNoise(asString(b.text)) : asString(b.text).trim();
          if (!text) break;
          out.push(obj.type === "assistant" ? { kind: "agent_message", text, final: true, ...pp } : { kind: "user_message", text, final: true });
          break;
        }
        case "thinking": {
          const text = asString(b.thinking).trim();
          if (text) out.push({ kind: "agent_thought", text, final: true, ...pp });
          break;
        }
        case "tool_use": {
          const name = asString(b.name);
          const id = asString(b.id);
          const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
          if (id) out.push({ kind: "tool_call", toolCallId: id, title: claudeToolTitle(name, input), toolKind: claudeToolKind(name), status: "completed", ...pp });
          const editPath = claudeEditPath(name, input);
          if (editPath) out.push({ kind: "file_edit", path: editPath, ...pp });
          break;
        }
        case "tool_result": {
          const id = asString(b.tool_use_id);
          const text = clip(claudeResultText(b.content).trim(), BODY_CLIP);
          if (id) out.push({ kind: "tool_call_update", toolCallId: id, status: b.is_error ? "failed" : "completed", text: text || undefined, ...pp });
          break;
        }
      }
    }
    if (obj.type === "assistant" && parentId) {
      const message = obj.message && typeof obj.message === "object" ? obj.message as Record<string, unknown> : null;
      const usage = message?.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : null;
      if (usage) {
        out.push({
          kind: "token_usage",
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
          cachedInputTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
          ...(typeof usage.cache_creation_input_tokens === "number"
            ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
            : {}),
          ...(typeof message?.model === "string" && message.model ? { model: message.model } : {}),
          parentToolUseId: parentId,
        });
      }
    }
  }
  return out;
}

/* ---------------------------------- Codex --------------------------------- */

/** Strip codex's injected wrappers (environment context, user instructions, subagent notifications)
 * so titles/messages read cleanly and don't surface as bogus user prompts. */
export function stripCodexNoise(text: string): string {
  return text
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, "")
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/g, "")
    // Older rollouts emitted a wrapper-only leading context block. The newer path-bearing
    // AGENTS.md heading is classified from its complete response-item/content envelope below;
    // stripping that heading from arbitrary text would erase a legitimate shape-matching prompt.
    .replace(/^\s*<instructions>[\s\S]*?<\/instructions>\s*/i, "")
    .trim();
}

/** A codex `<subagent_notification>` is a subagent's result injected as a *user-role* message — it's
 * the agent's own work, not a user prompt. Pull out its findings (markdown) to render as folded work. */
export function codexSubagentText(raw: string): string | null {
  const m = raw.match(/<subagent_notification>([\s\S]*?)<\/subagent_notification>/);
  if (!m) return null;
  const inner = (m[1] ?? "").trim();
  let body = inner;
  let label = "Subagent";
  try {
    const obj = JSON.parse(inner) as { status?: Record<string, unknown> };
    const status = obj.status ?? {};
    for (const key of ["completed", "failed", "in_progress"]) {
      const v = status[key];
      if (typeof v === "string" && v.trim()) {
        body = v.trim();
        label = key === "completed" ? "Subagent result" : `Subagent ${key.replace("_", " ")}`;
        break;
      }
    }
  } catch {
    /* keep the raw inner text */
  }
  return `**🤖 ${label}**\n\n${body}`;
}

function codexUserTextBlocks(payload: Record<string, unknown>): string[] {
  const content = payload.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { text: string } => !!b && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text);
}

function codexUserText(payload: Record<string, unknown>): string {
  return codexUserTextBlocks(payload).join("").trim();
}

/** A Codex client's generated context is identified from the complete multi-block user-message
 * envelope. A plain user prompt containing the same heading is intentionally not classified. */
function isCodexInjectedContextFrame(payload: Record<string, unknown>): boolean {
  const blocks = codexUserTextBlocks(payload).map((text) => text.trim()).filter(Boolean);
  if (blocks.length < 2) return false;
  const agents = /^# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<instructions>[\s\S]*?<\/instructions>$/i;
  const environment = /^<environment_context>[\s\S]*?<\/environment_context>$/;
  const userInstructions = /^<user_instructions>[\s\S]*?<\/user_instructions>$/;
  const plugins = /^<recommended_plugins>[\s\S]*?<\/recommended_plugins>$/i;
  return blocks.some((block) => agents.test(block)) &&
    blocks.some((block) => environment.test(block)) &&
    blocks.every((block) => agents.test(block) || environment.test(block) ||
      userInstructions.test(block) || plugins.test(block));
}

function codexIdFromName(fileName: string): string {
  // rollout-2026-06-29T15-46-52-019f1522-75ac-7dd1-96de-9c7e36c5ed65.jsonl
  const m = fileName.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1]! : "";
}

/** Parse a codex rollout file into a list descriptor (from its session_meta head + a title scan). */
export function parseCodexSession(
  content: string,
  fileName: string,
  mtimeMs: number,
  context: AgentContext,
): ExternalSessionDescriptor | null {
  const lines = splitLines(content);
  const metaObj = lines.map(tryParse).find((o) => o?.type === "session_meta");
  const meta = (metaObj?.payload ?? null) as Record<string, unknown> | null;
  const id = asString(meta?.id) || codexIdFromName(fileName);
  if (!id) return null;
  // Codex persists spawned agents as their own rollout files. They are implementation details of
  // the parent conversation (and carry its injected opening context), not resumable user sessions.
  const source = meta?.source;
  if (meta?.thread_source === "subagent" || (source != null && typeof source === "object" && "subagent" in source)) {
    return null;
  }
  const cwd = asString(meta?.cwd);
  const createdAt = tsToMs(meta?.timestamp, mtimeMs);
  let title = "";
  let count = 0;
  for (const line of lines) {
    const obj = tryParse(line);
    if (!obj) continue;
    const p = obj.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    if (obj.type === "event_msg" && p.type === "agent_message") {
      count++;
    } else if (obj.type === "response_item" && p.type === "message" && p.role === "user") {
      if (isCodexInjectedContextFrame(p)) continue;
      const text = stripCodexNoise(codexUserText(p));
      // Injected context is persisted with role=user by Codex, but is neither a user turn nor a
      // title candidate. Advance to the first meaningful prompt and keep the count honest.
      if (text) {
        count++;
        if (!title) title = text.slice(0, TITLE_MAX);
      }
    } else if (obj.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") {
      if (!title) title = stripCodexNoise(p.message).slice(0, TITLE_MAX);
    }
  }
  return { agentSessionId: id, driver: "codex", cwd, context, title, createdAt, updatedAt: mtimeMs, messageCount: count };
}

function codexToolKind(name: string): string | undefined {
  if (/patch|apply|edit|write|update/i.test(name)) return "edit";
  if (/shell|exec|command|bash|terminal/i.test(name)) return "execute";
  if (/read|cat|view|open/i.test(name)) return "read";
  if (/search|grep|find|glob|\brg\b/i.test(name)) return "search";
  if (/web|fetch|browse|url|http/i.test(name)) return "fetch";
  return undefined;
}

/** A shell command (string or argv array) from a codex tool's parsed arguments, if present. */
function codexCommand(args: Record<string, unknown>): string | null {
  const c = args.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : "")).join(" ").trim() || null;
  return null;
}

function codexToolTitle(name: string, args: Record<string, unknown>): string {
  const cmd = codexCommand(args);
  if (cmd) return clip(cmd, TITLE_CLIP);
  const path = asString(args.path) || asString(args.file_path) || asString(args.query);
  return clip(path ? `${name}: ${path}` : name, TITLE_CLIP);
}

/**
 * Codex narrates each step as an `agent_message` before running its tools; only the last message of
 * a turn (no tool call after it, before the next user turn) is the actual answer. Reclassify the
 * narration as reasoning so the UI folds it into the collapsible "work" block, like Codex does.
 * Single backward pass: a tool_call seen later in the same turn ⇒ the message is narration.
 */
function foldCodexNarration(events: SessionEventPayload[]): SessionEventPayload[] {
  const out = events.slice();
  let toolAfterInTurn = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i]!.kind;
    if (k === "user_message") toolAfterInTurn = false;
    else if (k === "tool_call") toolAfterInTurn = true;
    else if (k === "agent_message" && toolAfterInTurn) {
      out[i] = { kind: "agent_thought", text: (events[i] as { text: string }).text, final: true };
    }
  }
  return out;
}

/** Text from a codex `reasoning` item's summary; the real chain-of-thought is encrypted (skipped). */
function codexReasoningText(payload: Record<string, unknown>): string {
  const sum = payload.summary;
  if (!Array.isArray(sum)) return "";
  return sum
    .map((s) => (typeof s === "string" ? s : s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string" ? (s as { text: string }).text : ""))
    .join("\n")
    .trim();
}

/**
 * Parse a codex transcript into our event payloads. Beyond user/agent text we recover tool calls
 * (`function_call`/`*_call` → tool_call, paired `*_output` → tool_call_update) and reasoning
 * summaries, so an adopted timeline matches a live one. Codex's real reasoning body is encrypted,
 * so only `summary` text (when present) becomes an agent_thought. Whole messages are tagged `final`.
 */
export function parseCodexTranscript(content: string): SessionEventPayload[] {
  const out: SessionEventPayload[] = [];
  for (const line of splitLines(content)) {
    const obj = tryParse(line);
    if (!obj) continue;
    const p = obj.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    const pt = asString(p.type);
    if (obj.type === "event_msg" && pt === "agent_message" && typeof p.message === "string") {
      out.push({ kind: "agent_message", text: p.message, final: true });
    } else if (obj.type === "response_item") {
      if (pt === "message" && p.role === "user") {
        if (isCodexInjectedContextFrame(p)) continue;
        const raw = codexUserText(p);
        const subagent = codexSubagentText(raw);
        if (subagent) {
          // A subagent result injected as a user-role message — fold it in as work, not a user prompt.
          out.push({ kind: "agent_thought", text: subagent, final: true });
        } else {
          const text = stripCodexNoise(raw);
          if (text) out.push({ kind: "user_message", text, final: true });
        }
      } else if (pt === "reasoning") {
        const text = codexReasoningText(p);
        if (text) out.push({ kind: "agent_thought", text, final: true });
      } else if (pt.endsWith("_call")) {
        const name = asString(p.name) || pt.replace(/_call$/, "");
        const id = asString(p.call_id) || asString(p.id);
        let args: Record<string, unknown> = {};
        if (typeof p.arguments === "string") {
          const parsed = tryParse(p.arguments);
          if (parsed) args = parsed;
        }
        const body = codexCommand(args) ? "" : clip(JSON.stringify(args), 2000);
        if (id)
          out.push({
            kind: "tool_call",
            toolCallId: id,
            title: codexToolTitle(name, args),
            toolKind: codexToolKind(name),
            status: "completed",
            text: body || undefined,
          });
      } else if (pt.endsWith("_output")) {
        const id = asString(p.call_id) || asString(p.id);
        const output = clip(asString(p.output).trim(), BODY_CLIP);
        if (id) out.push({ kind: "tool_call_update", toolCallId: id, status: "completed", text: output || undefined });
      }
    }
  }
  return foldCodexNarration(out);
}

/* ----------------------------------- Pi ---------------------------------- */

interface ParsedPiSession {
  header: Record<string, unknown>;
  activeEntries: Record<string, unknown>[];
}

function piSessionIdIsSafe(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(id);
}

function piCwdIsAbsolute(cwd: string): boolean {
  return cwd.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(cwd) || cwd.startsWith("\\\\");
}

/** Pi v2+ stores a tree in one append-only file. Only the branch ending at the last complete entry
 * is the resumable conversation; importing every line would surface abandoned branches as turns.
 * Legacy v1 files are linear. A malformed tree is not safely resumable and is rejected rather than
 * guessed at. Unknown entry types remain in the chain and are ignored by the event mapper. */
function parsePiStructure(content: string): ParsedPiSession | null {
  const lines = splitLines(content);
  if (!lines.length) return null;
  const header = tryParse(lines[0]!);
  if (!header || header.type !== "session") return null;
  const id = asString(header.id);
  const cwd = asString(header.cwd);
  const version = header.version === undefined ? 1 : Number(header.version);
  if (!piSessionIdIsSafe(id) || !piCwdIsAbsolute(cwd) ||
      !Number.isSafeInteger(version) || version < 1) return null;

  const entries = lines.slice(1).map(tryParse).filter((entry): entry is Record<string, unknown> => entry != null);
  if (version === 1) return { header, activeEntries: entries };
  const identified = entries.filter((entry) => typeof entry.id === "string" && entry.id.length > 0);
  if (!identified.length) return { header, activeEntries: [] };
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of identified) {
    const entryId = asString(entry.id);
    if (!piSessionIdIsSafe(entryId) || byId.has(entryId)) return null;
    byId.set(entryId, entry);
  }
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: Record<string, unknown> | undefined = identified.at(-1);
  while (cursor) {
    const entryId = asString(cursor.id);
    if (!entryId || seen.has(entryId)) return null;
    seen.add(entryId);
    branch.push(cursor);
    if (cursor.parentId === null) break;
    const parentId = asString(cursor.parentId);
    if (!parentId) return null;
    cursor = byId.get(parentId);
    if (!cursor) return null;
  }
  return { header, activeEntries: branch.reverse() };
}

function piText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((raw) => {
    const block = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("").trim();
}

function piBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    : [];
}

function piToolKind(name: string): string | undefined {
  if (/^(read|ls)$/iu.test(name)) return "read";
  if (/^(edit|write)$/iu.test(name)) return "edit";
  if (/^(find|grep|search)$/iu.test(name)) return "search";
  if (/^(bash|shell|exec|command)$/iu.test(name)) return "execute";
  if (/^(web|fetch|browse)$/iu.test(name)) return "fetch";
  return undefined;
}

function piToolTitle(name: string, args: Record<string, unknown>): string {
  const command = asString(args.command);
  if (command) return clip(command, TITLE_CLIP);
  const path = asString(args.path) || asString(args.file_path) || asString(args.query) || asString(args.pattern);
  return clip(path ? `${name}: ${path}` : name || "Pi Tool", TITLE_CLIP);
}

function piUsage(message: Record<string, unknown>): Extract<SessionEventPayload, { kind: "token_usage" }> | null {
  const usage = message.usage && typeof message.usage === "object"
    ? message.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : null;
  const provider = asString(message.provider);
  const model = asString(message.model);
  const inputTokens = finiteNonNegative(usage.input);
  const outputTokens = finiteNonNegative(usage.output);
  const cachedInputTokens = finiteNonNegative(usage.cacheRead);
  const cacheCreationInputTokens = finiteNonNegative(usage.cacheWrite);
  const costUsd = finiteNonNegative(cost?.total);
  if ([inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, costUsd]
    .every((value) => value === undefined)) return null;
  return {
    kind: "token_usage",
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    costUsd,
    ...(provider && model ? { model: `${provider}/${model}` } : model ? { model } : {}),
  };
}

/** Parse a Pi session header plus its active branch into a discovery descriptor. The header id must
 * agree with the filename so an unrelated JSONL file cannot be adopted through a forged suffix. */
export function parsePiSession(
  content: string,
  fileName: string,
  mtimeMs: number,
  context: AgentContext,
): ExternalSessionDescriptor | null {
  const parsed = parsePiStructure(content);
  if (!parsed) return null;
  const id = asString(parsed.header.id);
  const stem = fileName.replace(/\.jsonl$/iu, "");
  if (!fileName.toLowerCase().endsWith(".jsonl") || (stem !== id && !stem.endsWith(`_${id}`))) return null;
  let title = "";
  let explicitName = "";
  let messageCount = 0;
  for (const entry of parsed.activeEntries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      explicitName = entry.name.trim();
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    messageCount++;
    if (!title && message.role === "user") title = piText(message.content).slice(0, TITLE_MAX);
  }
  return {
    agentSessionId: id,
    driver: "pi",
    cwd: asString(parsed.header.cwd),
    context,
    title: (explicitName || title).slice(0, TITLE_MAX),
    createdAt: tsToMs(parsed.header.timestamp, mtimeMs),
    updatedAt: mtimeMs,
    messageCount,
  };
}

/** Recover the visible active Pi branch without ever invoking Pi's migrator against the source
 * file. Tool-only assistant messages deliberately emit no empty agent bubble. */
export function parsePiTranscript(content: string): SessionEventPayload[] {
  const parsed = parsePiStructure(content);
  if (!parsed) return [];
  const out: SessionEventPayload[] = [];
  for (const entry of parsed.activeEntries) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    const role = asString(message.role);
    if (role === "user") {
      const text = piText(message.content);
      if (text) out.push({ kind: "user_message", text, final: true });
      continue;
    }
    if (role === "assistant") {
      for (const block of piBlocks(message.content)) {
        const type = asString(block.type);
        if (type === "text") {
          const text = asString(block.text).trim();
          if (text) out.push({ kind: "agent_message", text, final: true });
        } else if (type === "thinking") {
          const text = asString(block.thinking).trim();
          if (text) out.push({ kind: "agent_thought", text, final: true });
        } else if (type === "toolCall") {
          const id = asString(block.id);
          const name = asString(block.name);
          const args = block.arguments && typeof block.arguments === "object"
            ? block.arguments as Record<string, unknown>
            : {};
          if (id) out.push({
            kind: "tool_call",
            toolCallId: id,
            title: piToolTitle(name, args),
            toolKind: piToolKind(name),
            status: "completed",
            text: Object.keys(args).length ? clip(JSON.stringify(args), 2_000) : undefined,
          });
        }
      }
      const usage = piUsage(message);
      if (usage) out.push(usage);
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
        out.push({ kind: "error", message: clip(message.errorMessage.trim(), BODY_CLIP) });
      }
      continue;
    }
    if (role === "toolResult") {
      const id = asString(message.toolCallId);
      if (id) out.push({
        kind: "tool_call_update",
        toolCallId: id,
        status: message.isError === true ? "failed" : "completed",
        text: clip(piText(message.content), BODY_CLIP) || undefined,
      });
      continue;
    }
    if (role === "bashExecution") {
      const id = `pi-bash-${asString(entry.id) || out.length + 1}`;
      const command = asString(message.command);
      out.push({ kind: "tool_call", toolCallId: id, title: clip(command || "Shell", TITLE_CLIP), toolKind: "execute", status: "completed" });
      out.push({
        kind: "tool_call_update",
        toolCallId: id,
        status: message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0) ? "failed" : "completed",
        text: clip(asString(message.output), BODY_CLIP) || undefined,
      });
    }
  }
  return out;
}
