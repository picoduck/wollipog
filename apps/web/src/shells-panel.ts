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
  sessionRole,
  type AgentDriverKind,
  type OS,
  type SessionCapabilities,
  type SessionRole,
  type ShellOutputChunk,
  type ShellView,
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

/** Current catalog context is the narrowest available truth for an existing session. Ordinary WSL
 * TUI remains supported, but Orchestrator TUI must be hidden unless its agent is provably native;
 * the runner remains authoritative if catalog state changes between render and open. */
export function supportsSessionAgentTui(
  driver: AgentDriverKind | undefined,
  protocolVersion: number | null | undefined,
  os: OS | undefined,
  permissionMode: string | null | undefined,
  agentContextKind: "native" | "wsl" | undefined,
  role?: SessionRole,
): boolean {
  if (!supportsAgentTui(driver, protocolVersion, os)) return false;
  if (sessionRole({ role, permissionMode }) !== "orchestrator") return true;
  // A TUI has no runner control channel, so only the coupled preset's static rules can shape it;
  // an Orchestrator with independent provider permissions has no TUI form.
  return permissionMode === "orchestrator" && agentContextKind === "native";
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

/** What one terminal tab shows (#2864): "Shell 1" and the working folder's name, or "Agent TUI". */
export interface ShellTabView {
  id: string;
  label: string;
  /** The last segment of the folder the shell runs in; null for an Agent TUI or an unknown folder. */
  folder: string | null;
  /** The full directory, for the tab's tooltip. */
  folderPath: string | null;
  /** A running shell has no status; an exited or reconnecting one says so after its label. */
  status: "exited" | "reconnecting" | null;
}

export function shellTabView(
  shell: Pick<ShellView, "shellId" | "name" | "kind" | "status">,
  { exited, folderPath }: { exited: boolean; folderPath: string | null },
): ShellTabView {
  const tui = shell.kind === "agent_tui";
  const folder = tui ? null : (folderPath ?? "").split(/[\\/]+/).filter(Boolean).pop() ?? null;
  return {
    id: shell.shellId,
    label: tui ? "Agent TUI" : shell.name,
    folder,
    folderPath: folder ? folderPath : null,
    status: exited || shell.status === "exited" ? "exited" : shell.status === "reconnecting" ? "reconnecting" : null,
  };
}

/** Why New Agent TUI cannot open, as its menu item's second line (§9.1); null when it can. */
export function agentTuiUnavailableReason({ machineOnline, machineName, tuiOpen, guardrailBlocked }: {
  machineOnline: boolean;
  machineName: string;
  tuiOpen: boolean;
  guardrailBlocked: boolean;
}): string | null {
  if (!machineOnline) return `${machineName} is offline.`;
  // A guardrail outranks the open TUI: closing that one would not make another available.
  if (guardrailBlocked) return "Unavailable while this session has a cost budget, cost checkpoint or tool-call limit.";
  if (tuiOpen) return "An Agent TUI is already open for this session.";
  return null;
}

/** The search addon's result counts; `index` is -1 when no match is selected. */
export interface TerminalSearchResults {
  index: number;
  count: number;
}

/** Search stops counting here (the addon's highlight limit), so a common term reads "1 of 1,000+". */
export const TERMINAL_SEARCH_LIMIT = 1000;

/** The match count beside the search field: "2 of 5", "No matches". */
export function terminalSearchCountLabel(results: TerminalSearchResults): string {
  if (results.count <= 0) return "No matches";
  const total = results.count >= TERMINAL_SEARCH_LIMIT
    ? `${TERMINAL_SEARCH_LIMIT.toLocaleString("en-US")}+`
    : String(results.count);
  if (results.index < 0) return results.count === 1 ? "1 match" : `${total} matches`;
  return `${results.index + 1} of ${total}`;
}

/**
 * The order of the terminal's notices within a severity (`TerminalNoticeSlot`, #2865). A failed
 * terminal action is danger, so it shows ahead of them all. `TERMINAL_NOTICE_RANK` re-exports it
 * beside the other slots' tables.
 */
export const TERMINAL_NOTICE_RANKS = {
  machineOffline: 1,
  reconnecting: 2,
  agentTuiBlocked: 3,
  agentTuiUntracked: 4,
  outputIncomplete: 5,
  actionFailed: 6,
} as const;

/** One condition for the terminal's notice slot: what it shows, without the rendering, so every host
 * of the terminal ranks the same conditions the same way. */
export interface TerminalNoticeCondition {
  key: string;
  severity: "danger" | "warning" | "info";
  rank: number;
  /** Title Case: its item in "+N More". */
  title: string;
  /** Sentence case: the notice's one line. */
  message: string;
}

/** What holds for the terminal and its selected shell, as the slot's conditions. */
export function terminalNoticeConditions({
  machineOnline,
  machineName,
  activeShell,
  outputIncomplete,
  agentTuiBlocked,
  hookGovernance,
  error,
}: {
  machineOnline: boolean;
  machineName: string;
  /** The selected tab's shell, or null with no tab. */
  activeShell: Pick<ShellView, "shellId" | "kind" | "status"> | null;
  /** The selected shell's stream may have dropped output while the dashboard reconnected. */
  outputIncomplete: boolean;
  /** This session could open an Agent TUI, but a guardrail stops it. */
  agentTuiBlocked: boolean;
  /** Policy hooks still govern an Agent TUI in this session. */
  hookGovernance: boolean;
  /** The last terminal action that failed, in the server's words. */
  error: string | null;
}): TerminalNoticeCondition[] {
  const rank = TERMINAL_NOTICE_RANKS;
  const conditions: TerminalNoticeCondition[] = [];
  if (!machineOnline) {
    conditions.push({
      key: "machine-offline",
      severity: "warning",
      rank: rank.machineOffline,
      title: "Machine Offline",
      message: `${machineName} is offline. Shells reconnect when it's back.`,
    });
  }
  if (activeShell?.status === "reconnecting") {
    conditions.push({
      // Per shell, so dismissing one shell's reconnect never hides the next one's.
      key: `reconnecting:${activeShell.shellId}`,
      severity: "info",
      rank: rank.reconnecting,
      title: "Reconnecting",
      message: "Reconnecting to this shell…",
    });
  }
  if (agentTuiBlocked) {
    conditions.push({
      key: "agent-tui-blocked",
      severity: "warning",
      rank: rank.agentTuiBlocked,
      title: "Agent TUI Unavailable",
      message: "Agent TUI is unavailable while this session has a cost budget, cost checkpoint or tool-call limit. " +
        "Clear those guardrails or use Direct.",
    });
  }
  if (activeShell?.kind === "agent_tui") {
    conditions.push({
      key: "agent-tui-untracked",
      severity: "info",
      rank: rank.agentTuiUntracked,
      title: "Agent TUI Not Tracked",
      message: "Agent TUI runs outside Wollipog's tracking: no usage, approval cards or transcript entries." +
        (hookGovernance ? " Policy hooks stay on." : ""),
    });
  }
  if (outputIncomplete) {
    conditions.push({
      key: "output-incomplete",
      severity: "warning",
      rank: rank.outputIncomplete,
      title: "Output May Be Incomplete",
      message: "Some of this shell's output may be missing after the connection recovered.",
    });
  }
  if (error) {
    conditions.push({ key: "action-failed", severity: "danger", rank: rank.actionFailed, title: "Terminal Error", message: error });
  }
  return conditions;
}

/** The status row under an exited shell: "Shell exited with code 0." */
export function shellExitedMessage(kind: ShellView["kind"], exitCode: number | null | undefined): string {
  const subject = kind === "agent_tui" ? "Agent TUI" : "Shell";
  return exitCode == null ? `${subject} exited.` : `${subject} exited with code ${exitCode}.`;
}

/** Under a running shell that takes no input here. */
export const READ_ONLY_SHELL_MESSAGE = "Read-only: this shell's output is shown, but it doesn't take input.";

/** Why a Windows-native shell's row reads "No TTY": its tooltip and description. */
export const PIPE_MODE_REASON =
  "This Windows-native shell has no TTY, so commands go in a line at a time and full-screen programs don't run.";
