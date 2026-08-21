/**
 * Phase 3: walk the bare CLIs' on-disk session stores and turn them into ExternalSessionDescriptors,
 * across both execution contexts a box can host — the native host and every WSL distro (claude lives
 * in WSL on a typical Windows box). Parsing is delegated to the pure functions in parse.ts.
 *
 * Cost control: the stores can hold hundreds of historical sessions, so we take only the most-recent
 * `CAP` files per store/context (by mtime) and read them on demand (never on register). Everything is
 * best-effort — a missing dir, an unreadable file, or a dead distro yields nothing, never an error.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentContext,
  AgentDefinition,
  AgentDriverKind,
  ExternalSessionDescriptor,
  SessionEventPayload,
} from "@wollipog/protocol";
import { listWslDistros, run } from "../discovery/resolve.js";
import {
  parseClaudeSession,
  parseClaudeTranscript,
  parseCodexSession,
  parseCodexTranscript,
} from "./parse.js";

/** Most-recent sessions to surface per store per context. */
const CAP = 40;
const WSL_TIMEOUT_MS = 8000;
/** For listing, read only the head of each WSL transcript — enough for id/cwd/title, but bounded so
 * the batched output can't overflow execFile's buffer for long-lived sessions. */
const HEAD_BYTES = 64 * 1024;
/** Buffer headroom for the batched list (CAP * HEAD_BYTES) and for a single full-transcript backfill. */
const LIST_MAX_BUFFER = 64 * 1024 * 1024;
const TRANSCRIPT_MAX_BUFFER = 128 * 1024 * 1024;

interface RawFile {
  fileName: string;
  content: string;
  mtimeMs: number;
}

interface StoreSpec {
  driver: AgentDriverKind;
  /** $HOME-relative directory the CLI keeps its sessions in. */
  subdir: string;
  parseHead: (content: string, fileName: string, mtimeMs: number, ctx: AgentContext) => ExternalSessionDescriptor | null;
  parseTranscript: (content: string) => SessionEventPayload[];
}

const STORES: StoreSpec[] = [
  { driver: "claude-code", subdir: ".claude/projects", parseHead: parseClaudeSession, parseTranscript: parseClaudeTranscript },
  { driver: "codex", subdir: ".codex/sessions", parseHead: parseCodexSession, parseTranscript: parseCodexTranscript },
];

/** App Server and `codex exec` share Codex's on-disk rollout store. The selected integration
 * controls how an adopted thread resumes; it does not create a second transcript directory. */
export function externalSessionStoreDriver(driver: AgentDriverKind): AgentDriverKind {
  return driver === "codex-app-server" ? "codex" : driver;
}

/** Preserve runner-owned transcript facts while honoring a user's explicit choice to resume a
 * Codex rollout through App Server. No other client-supplied driver/context change is accepted. */
export function retargetExternalSession(
  found: ExternalSessionDescriptor,
  requested: Pick<ExternalSessionDescriptor, "driver" | "context">,
): ExternalSessionDescriptor {
  const sameContext = requested.context.kind === found.context.kind
    && (found.context.kind !== "wsl"
      || (requested.context.kind === "wsl" && requested.context.distro === found.context.distro));
  return requested.driver === "codex-app-server" && found.driver === "codex" && sameContext
    ? { ...found, driver: "codex-app-server" }
    : found;
}

/* ------------------------------ native (Node fs) -------------------------- */

function walkJsonl(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return; // codex nests y/m/d; claude is shallow — bound it regardless
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

/** Listing needs only the transcript header. Keep native reads bounded just like the WSL path so
 * one very large or long-lived JSONL file cannot exhaust the runner heap during discovery. */
export function readSessionHead(path: string, maxBytes = HEAD_BYTES): string {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(file, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(file);
  }
}

function nativeRawFiles(subdir: string): RawFile[] {
  const root = join(homedir(), subdir);
  const paths: string[] = [];
  walkJsonl(root, paths);
  const stamped = paths
    .map((p) => {
      try {
        return { path: p, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtimeMs: number } => x != null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, CAP);
  const out: RawFile[] = [];
  for (const { path, mtimeMs } of stamped) {
    try {
      out.push({ fileName: basename(path), content: readSessionHead(path), mtimeMs });
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

/* --------------------------------- WSL ------------------------------------ */

const WOLLIPOG_FILE = "===WOLLIPOGFILE===";

/** One batched script per distro: list the most-recent jsonl, print each as a framed (mtime, path,
 * content) block, so we read N files in a single wsl.exe spawn instead of N. */
async function wslRawFiles(distro: string, subdir: string): Promise<RawFile[]> {
  // `head -c` per file keeps each transcript bounded (we only need id/cwd/title from the head); the
  // batched output therefore can't blow execFile's buffer even for very long sessions.
  const script =
    `cd "$HOME" 2>/dev/null || exit 0; [ -d "${subdir}" ] || exit 0; ` +
    `find "${subdir}" -type f -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null | sort -rn | head -${CAP} | ` +
    `while IFS="$(printf '\\t')" read -r mt path; do ` +
    `printf '${WOLLIPOG_FILE}\\t%s\\t%s\\n' "$mt" "$path"; head -c ${HEAD_BYTES} "$path" 2>/dev/null; printf '\\n'; done`;
  const r = await run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", script], {
    timeoutMs: WSL_TIMEOUT_MS,
    maxBuffer: LIST_MAX_BUFFER,
  });
  if (r.code !== 0 || !r.stdout.includes(WOLLIPOG_FILE)) return [];
  const out: RawFile[] = [];
  for (const block of r.stdout.split(WOLLIPOG_FILE).slice(1)) {
    const nl = block.indexOf("\n");
    if (nl < 0) continue;
    const header = block.slice(0, nl); // "\t<mt>\t<path>"
    const content = block.slice(nl + 1);
    const parts = header.split("\t").filter((p) => p.length);
    if (parts.length < 2) continue;
    const mtimeMs = Math.round(parseFloat(parts[0]!) * 1000);
    out.push({ fileName: basename(parts[1]!), content, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 });
  }
  return out;
}

async function wslReadOne(distro: string, subdir: string, agentSessionId: string): Promise<string> {
  const id = agentSessionId.replace(/[^0-9a-zA-Z-]/g, ""); // resume ids are uuid-ish; keep it shell-safe
  if (!id) return "";
  const script = `cd "$HOME" 2>/dev/null || exit 0; f=$(find "${subdir}" -type f -name '*${id}*.jsonl' 2>/dev/null | head -1); [ -n "$f" ] && cat "$f"`;
  const r = await run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", script], {
    timeoutMs: WSL_TIMEOUT_MS,
    maxBuffer: TRANSCRIPT_MAX_BUFFER, // full transcript for backfill — don't truncate history
  });
  return r.code === 0 ? r.stdout : "";
}

/* ------------------------------- public API ------------------------------- */

/** Resolve the box's agent launch params for a driver/context, so an adopted session can resume.
 * null ⇒ nothing on the box can drive that (driver, context) pair — the same check decides both the
 * descriptor's `resumable` flag and whether an adopt lands promptable or as read-only history, so
 * the list's label can never disagree with what adopting actually does. */
export function resolveLaunchForDriver(
  agents: AgentDefinition[],
  driver: AgentDriverKind,
  context: AgentContext,
): { command: string; args: string[]; env: Record<string, string> } | null {
  const agent = agents.find((a) => {
    const aDriver = a.driver ?? "acp";
    const aCtx = a.context ?? { kind: "native" as const };
    if (aDriver !== driver || aCtx.kind !== context.kind) return false;
    return context.kind !== "wsl" || (aCtx.kind === "wsl" && aCtx.distro === context.distro);
  });
  return agent ? { command: agent.command, args: agent.args ?? [], env: agent.env ?? {} } : null;
}

/** Resolve one exact runner catalog identity for host launch authorization. A confirmed signed-out
 * native provider remains launchable so SessionManager can enter its runner-owned authentication
 * recovery flow; missing, unsupported, and otherwise disabled catalog rows stay fail-closed. */
export function resolveLaunchForAgent(
  agents: AgentDefinition[],
  agentId: string | null | undefined,
  driver: AgentDriverKind,
  context: AgentContext,
): { command: string; args: string[]; env: Record<string, string> } | null {
  if (!agentId) return null;
  const agent = agents.find((candidate) => {
    if (candidate.id !== agentId || (candidate.driver ?? "acp") !== driver) return false;
    const candidateContext = candidate.context ?? { kind: "native" as const };
    if (candidateContext.kind !== context.kind ||
        (context.kind === "wsl" &&
          (candidateContext.kind !== "wsl" || candidateContext.distro !== context.distro))) return false;
    if (candidate.available !== false) return true;
    if (driver === "claude-code") return candidate.claudeCode?.status === "unauthenticated";
    if (driver === "codex-app-server") {
      return candidate.authStatus === "unauthenticated" && candidate.codexAppServer?.status === "supported";
    }
    return driver === "codex" && candidate.authStatus === "unauthenticated";
  });
  return agent
    ? { command: agent.command, args: [...(agent.args ?? [])], env: { ...(agent.env ?? {}) } }
    : null;
}

/** Enumerate external (CLI-started) sessions across the native host + every WSL distro, dedup against
 * sessions Wollipog already owns, sorted most-recent first. A selected agent narrows the scan
 * to one transcript store and execution context. */
export async function listExternalSessions(
  knownAgentSessionIds: Set<string>,
  selected?: { driver: AgentDriverKind; context: AgentContext },
): Promise<ExternalSessionDescriptor[]> {
  const contexts: AgentContext[] = selected ? [selected.context] : [{ kind: "native" }];
  if (!selected) {
    try {
      for (const distro of await listWslDistros()) contexts.push({ kind: "wsl", distro });
    } catch {
      /* no WSL — native only */
    }
  }
  const selectedStoreDriver = selected ? externalSessionStoreDriver(selected.driver) : undefined;
  const stores = selected ? STORES.filter((store) => store.driver === selectedStoreDriver) : STORES;

  const all: ExternalSessionDescriptor[] = [];
  for (const ctx of contexts) {
    for (const store of stores) {
      const raws = ctx.kind === "native" ? nativeRawFiles(store.subdir) : await wslRawFiles(ctx.distro, store.subdir);
      for (const raw of raws) {
        const d = store.parseHead(raw.content, raw.fileName, raw.mtimeMs, ctx);
        if (d && d.agentSessionId && !knownAgentSessionIds.has(d.agentSessionId)) {
          all.push(selected?.driver === "codex-app-server" && d.driver === "codex"
            ? { ...d, driver: "codex-app-server" }
            : d);
        }
      }
    }
  }
  // A given id can only appear once; if two contexts somehow surface it, keep the most recent.
  const byId = new Map<string, ExternalSessionDescriptor>();
  for (const d of all) {
    const prev = byId.get(d.agentSessionId);
    if (!prev || d.updatedAt > prev.updatedAt) byId.set(d.agentSessionId, d);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Re-resolve a single external session from the box's own enumeration, by its resume id. Used at
 * adopt time so execution state (cwd/driver/context) comes from disk, never a client-supplied body. */
export async function findExternalSession(
  agentSessionId: string,
  knownAgentSessionIds: Set<string>,
): Promise<ExternalSessionDescriptor | null> {
  const all = await listExternalSessions(knownAgentSessionIds);
  return all.find((d) => d.agentSessionId === agentSessionId) ?? null;
}

/** Best-effort parse of one external session's transcript into our event payloads (3c backfill). */
export async function readExternalTranscript(
  descriptor: ExternalSessionDescriptor,
  homeDirectory = homedir(),
): Promise<SessionEventPayload[]> {
  const store = STORES.find((s) => s.driver === externalSessionStoreDriver(descriptor.driver));
  if (!store) return [];
  let content = "";
  if (descriptor.context.kind === "native") {
    const paths: string[] = [];
    walkJsonl(join(homeDirectory, store.subdir), paths);
    const hit = paths.find((p) => basename(p).includes(descriptor.agentSessionId));
    if (hit) {
      try {
        content = readFileSync(hit, "utf8");
      } catch {
        /* unreadable */
      }
    }
  } else {
    content = await wslReadOne(descriptor.context.distro, store.subdir, descriptor.agentSessionId);
  }
  return content ? store.parseTranscript(content) : [];
}
