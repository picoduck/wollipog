/** Pure logic for the Shells panel (kept out of the component — @wollipog/web has pure-logic tests
 * only). The store gives immediate rendering while the control plane rehydrates bounded history
 * after reload or reconnect.
 *
 * Scrollback is RAW terminal bytes: xterm.js is the ANSI parser/renderer (it also handles
 * escape sequences split across chunk boundaries internally, which is why the old
 * stripAnsi/splitCarry pipeline could be deleted). */

/** Per-shell scrollback cap — plenty for a console; keeps reducer churn bounded. */
import {
  runnerSupportsProtocol,
  type AgentDriverKind,
  type OS,
  type SessionCapabilities,
  type ShellOutputChunk,
} from "@wollipog/protocol";

export const SHELL_SCROLLBACK_CAP = 200_000;
export const SHELL_SCROLLBACK_CHUNK_CAP = 2048;

/** Max UTF-16 units per shell-input request. The CP rejects payloads over 64 KiB of JSON
 * string; a unit encodes to at most 3 UTF-8 bytes (surrogate-pair halves average 2), so
 * 20 000 units ≤ 60 KB — safely under the limit for any content. */
export const SHELL_INPUT_CHUNK_UNITS = 20_000;

export function supportsAgentTui(
  driver: AgentDriverKind | undefined,
  protocolVersion: number | null | undefined,
  os: OS | undefined,
): boolean {
  return Boolean(
    driver &&
    (os === "windows" || os === "linux") &&
    (["claude-code", "codex", "codex-app-server"] as string[]).includes(driver) &&
    runnerSupportsProtocol(protocolVersion, "agentTuiMirror"),
  );
}

export function supportsInitialNativeTui(
  driver: AgentDriverKind | undefined,
  protocolVersion: number | null | undefined,
  os: OS | undefined,
): boolean {
  return supportsAgentTui(driver, protocolVersion, os) &&
    runnerSupportsProtocol(protocolVersion, "sessionStartFencedShells");
}

/** Session-scoped post-create truth; never infer policy interception from the catalog agent. */
export function sessionHasHookGovernance(capabilities: SessionCapabilities | undefined): boolean {
  return Object.values(capabilities?.elicitation ?? {}).some(
    (transports) => transports?.includes("hook") === true,
  );
}

/** Split raw terminal input (a big paste) into ordered frames the input route accepts. Never
 * splits a surrogate pair — the runner decodes each frame independently. */
export function splitShellInput(data: string, max = SHELL_INPUT_CHUNK_UNITS): string[] {
  if (data.length <= max) return data.length ? [data] : [];
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    let end = Math.min(i + max, data.length);
    // Don't cut between a high surrogate and its low half.
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

export interface ShellScrollback {
  sessionId: string;
  /** Raw output, front-trimmed to the cap. */
  text: string;
  /** Total chars EVER received (monotonic, uncapped) — lets the terminal component compute
   * "what's new since I last wrote" without diffing capped strings. */
  total: number;
  exited: boolean;
  exitCode: number | null;
  chunks: ShellOutputChunk[];
  /** History prepends/reorders require xterm to replay the bounded tail. */
  revision: number;
  /** A 1013 slow-client reconnect may have dropped ephemeral bytes. Never present the retained tail
   * as contiguous after that boundary. */
  incomplete?: boolean;
  truncated?: boolean;
}

/** Idempotently merge durable history and live delivery, retaining a bounded newest tail. */
export function mergeShellChunks(
  existing: readonly ShellOutputChunk[],
  incoming: readonly ShellOutputChunk[],
  cap = SHELL_SCROLLBACK_CAP,
): ShellOutputChunk[] {
  const bySeq = new Map<number, ShellOutputChunk>();
  for (const chunk of existing) bySeq.set(chunk.seq, chunk);
  for (const chunk of incoming) bySeq.set(chunk.seq, chunk);
  const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  let chars = sorted.reduce((sum, chunk) => sum + chunk.data.length, 0);
  let remove = 0;
  while (remove < sorted.length && (chars > cap || sorted.length - remove > SHELL_SCROLLBACK_CHUNK_CAP)) {
    chars -= sorted[remove++]!.data.length;
  }
  return remove > 0 ? sorted.slice(remove) : sorted;
}

/** O(1)-amortized common path for a runner-monotonic live chunk. Full map/sort/rebuild remains
 * reserved for paged history or genuinely out-of-order recovery. */
export function appendOrderedShellChunk(
  existing: readonly ShellOutputChunk[],
  text: string,
  incoming: ShellOutputChunk,
  charCap = SHELL_SCROLLBACK_CAP,
  chunkCap = SHELL_SCROLLBACK_CHUNK_CAP,
): { chunks: ShellOutputChunk[]; text: string } {
  const chunks = [...existing, incoming];
  let nextText = text + incoming.data;
  let remove = 0;
  while (remove < chunks.length && (nextText.length > charCap || chunks.length - remove > chunkCap)) {
    nextText = nextText.slice(chunks[remove++]!.data.length);
  }
  return { chunks: remove > 0 ? chunks.slice(remove) : chunks, text: nextText };
}

export function markShellScrollbacksIncomplete(
  scrollbacks: Map<string, ShellScrollback>,
): Map<string, ShellScrollback> {
  let changed = false;
  const marked = new Map<string, ShellScrollback>();
  for (const [id, scrollback] of scrollbacks) {
    // A received exit is ordered after all output for that shell. Once it is in the store, a
    // later dashboard disconnect cannot introduce a hole into that completed transcript.
    if (scrollback.exited || scrollback.incomplete) {
      marked.set(id, scrollback);
      continue;
    }
    changed = true;
    marked.set(id, { ...scrollback, incomplete: true });
  }
  return changed ? marked : scrollbacks;
}

/** Close codes that can strand bytes from the ephemeral shell stream. Authorization and ordinary
 * normal closes do not trigger a recovery warning; transport/server/overload closes do. */
export function shellStreamMayBeIncomplete(closeCode: number): boolean {
  return closeCode !== 1000 && closeCode !== 1008;
}

/** Shell ids that disappeared from the authoritative CP registry while this dock stayed mounted. */
export function shellsRemovedAfterReconnect(
  before: readonly { shellId: string }[] | null,
  live: readonly { shellId: string }[],
): Set<string> {
  if (!before?.length) return new Set();
  const liveIds = new Set(live.map((shell) => shell.shellId));
  return new Set(before.filter((shell) => !liveIds.has(shell.shellId)).map((shell) => shell.shellId));
}

/** A shell explicitly closing remains in the CP registry until its exit echo. Never let a registry
 * refresh during that interval resurrect its optimistically removed tab. */
export function shellsVisibleAfterClose<T extends { shellId: string }>(
  live: readonly T[],
  closing: ReadonlySet<string>,
): T[] {
  return live.filter((shell) => !closing.has(shell.shellId));
}

/** Exit echoes can arrive after an explicit close already removed the tab. Those completed,
 * invisible entries have no UI consumer and otherwise accumulate for a long-lived session. */
export function exitedShellsWithoutTabs(
  tabs: readonly { shellId: string }[] | null,
  scrollbacks: ReadonlyMap<string, ShellScrollback>,
  sessionId: string,
): string[] {
  if (tabs === null) return [];
  const tabIds = new Set(tabs.map((tab) => tab.shellId));
  return [...scrollbacks]
    .filter(([shellId, scrollback]) =>
      scrollback.sessionId === sessionId && scrollback.exited && !tabIds.has(shellId))
    .map(([shellId]) => shellId);
}

/** Append a raw chunk, trimming the FRONT to the cap on a line boundary when possible so a
 * replayed buffer rarely starts mid-line (a mid-escape start after a trim is harmless — xterm
 * skates over malformed sequences). */
export function appendScrollback(existing: string, chunk: string, cap = SHELL_SCROLLBACK_CAP): string {
  let next = existing + chunk;
  if (next.length <= cap) return next;
  next = next.slice(next.length - cap);
  const nl = next.indexOf("\n");
  // Drop the partial first line unless the whole buffer is one line.
  return nl >= 0 && nl < next.length - 1 ? next.slice(nl + 1) : next;
}
