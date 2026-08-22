import type { AgentDriverKind, OS, SessionStatus } from "@wollipog/protocol";

export function relativeTime(ts: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

const TITLE_CASE_MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "over",
  "per",
  "the",
  "to",
  "up",
  "via",
  "with",
]);

const TITLE_CASE_OVERRIDES: Record<string, string> = {
  chatops: "Chat-Ops",
  github: "GitHub",
  macos: "macOS",
};

/** Title-case a trusted compact UI label. Do not use this for prose or user-authored content. */
export function titleCaseLabel(value: string): string {
  const words = value.split(/(\s+)/);
  const wordIndexes = words
    .map((word, index) => (/[A-Za-z]/.test(word) ? index : -1))
    .filter((index) => index >= 0);
  const first = wordIndexes[0];
  const last = wordIndexes.at(-1);
  return words.map((word, index) => {
    if (!/[A-Za-z]/.test(word) || /^[A-Z0-9]+(?:[-/][A-Z0-9]+)*$/.test(word)) return word;
    return word.replace(/[A-Za-z][A-Za-z'-]*/g, (part) => {
      const segments = part.split("-");
      return segments.map((segment, segmentIndex) => {
        if (/^[A-Z0-9]+$/.test(segment)) return segment;
        const lower = segment.toLowerCase();
        const override = TITLE_CASE_OVERRIDES[lower];
        if (override) return override;
        const isFirst = index === first && segmentIndex === 0;
        const isLast = index === last && segmentIndex === segments.length - 1;
        if (!isFirst && !isLast && TITLE_CASE_MINOR_WORDS.has(lower)) return lower;
        return `${segment[0]!.toUpperCase()}${segment.slice(1).toLowerCase()}`;
      }).join("-");
    });
  }).join("");
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  // Round once before splitting units so 59m 59.6s becomes 1h 0m, never "59m 60s".
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${durationMs < 10_000 ? (durationMs / 1_000).toFixed(1) : totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export interface RecordedTimestamp {
  dateTime: string;
  label: string;
  title: string;
}

/** Compact Title Case relative time for timestamp metadata; callers provide the shared clock. */
export function formatRecordedRelativeTime(
  timestamp: number | undefined,
  now = Date.now(),
): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return "";
  const diff = Math.max(0, now - timestamp!);
  if (diff < 5_000) return "Just Now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s Ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m Ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h Ago`;
  return `${Math.floor(diff / 86_400_000)}d Ago`;
}

/** Session event time means recorded by the runner; adopted history may not retain provider time. */
export function formatRecordedTimestamp(
  timestamp: number | undefined,
  locale?: string,
  timeZone?: string,
): RecordedTimestamp | null {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp!);
  if (Number.isNaN(date.getTime())) return null;
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  };
  const dateOptions: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  };
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(locale, timeOptions).format(date),
    title: `Recorded ${new Intl.DateTimeFormat(locale, dateOptions).format(date)}`,
  };
}

export interface StatusMeta {
  label: string;
  className: string;
  busy: boolean;
}

const STATUS_META: Record<SessionStatus, StatusMeta> = {
  queued: { label: "Queued", className: "st-queued", busy: false },
  starting: { label: "Starting", className: "st-running", busy: true },
  running: { label: "Running", className: "st-running", busy: true },
  input_required: { label: "Awaiting Input", className: "st-input", busy: false },
  idle: { label: "Awaiting Prompt", className: "st-idle", busy: false },
  completed: { label: "Completed", className: "st-done", busy: false },
  failed: { label: "Failed", className: "st-failed", busy: false },
  stopped: { label: "Stopped", className: "st-stopped", busy: false },
};

export function statusMeta(status: SessionStatus | string): StatusMeta {
  return STATUS_META[status as SessionStatus] ?? {
    label: "Status Unavailable",
    className: "st-stopped",
    busy: false,
  };
}

/**
 * Compress a filesystem path so it fits on one line: keep the root and the leaf, eliding the middle
 * (e.g. `C:\Users\dev\Projects\wollipog` -> `C:\…\wollipog`). Paths with 3 or
 * fewer segments are returned unchanged. Works for both Windows (`\`) and POSIX (`/`) separators.
 * The full path should still be exposed via a `title` attribute for hover.
 */
export function shortenPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 3) return path;
  return `${segments[0]}${sep}…${sep}${segments[segments.length - 1]}`;
}

export function osLabel(os: OS): string {
  return os === "macos" ? "macOS" : os.charAt(0).toUpperCase() + os.slice(1);
}

/** Compact token count: 1234 -> "1.2k", 1_200_000 -> "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  // Cross to "M" once the rounded "k" value would reach 1000k (e.g. 999_999 -> "1.0M").
  if (n < 999_500) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Convert a provider-resolved Claude id into compact visible model copy. Unknown ids stay exact. */
export function resolvedModelLabel(modelId: string): string {
  const context = modelId.match(/\[([^\]]+)\]$/)?.[1];
  const normalized = modelId.replace(/\[[^\]]+\]$/, "").replace(/-\d{8}$/, "");
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(normalized);
  if (!match) return modelId;
  const family = titleCaseLabel(match[1]!);
  const version = `${match[2]}${match[3] ? `.${match[3]}` : ""}`;
  const contextLabel = context ? ` (${context.toUpperCase()} Context)` : "";
  return `${family} ${version}${contextLabel}`;
}

/** Cost in USD, with enough precision to be meaningful for small amounts. */
export function formatCost(usd: number): string {
  if (usd <= 0) return "";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * Friendly labels for the raw approval-mode ids the drivers use. The names make the
 * key distinction explicit: "AI-reviewed" auto (a classifier/Guardian model judges each
 * action) vs. the fixed-rule autos (accept-edits / workspace sandbox).
 */
const PERMISSION_LABELS: Record<string, string> = {
  // claude-code permission modes
  default: "Ask Every Time",
  auto: "Auto (AI-Reviewed)",
  acceptEdits: "Auto-Accept Edits",
  dontAsk: "Don't Ask",
  manual: "Manual",
  plan: "Plan Only (Read-Only)",
  bypassPermissions: "Full Access (No Checks)",
  // codex sandbox policies
  "read-only": "Read-Only",
  "workspace-write": "Ask for Approval",
  "danger-full-access": "Full Access (No Sandbox)",
  // codex app-server interactive policies
  untrusted: "Ask Every Time",
  "auto-review": "Approve for Me",
  "on-request": "Ask for Approval",
};

/** One-line explanation of each approval mode, used as the option's hover tooltip. */
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  default: "You approve every tool call (Allow / Reject).",
  untrusted: "You approve every tool call (Allow / Reject).",
  auto: "A classifier model reviews each action: safe ones run automatically; risky ones are blocked and the agent is steered to a safer path.",
  "auto-review": "A Guardian model reviews sandbox-boundary actions: low-risk ones run automatically; risky ones are escalated to you for Allow / Reject.",
  acceptEdits: "File edits and common file commands run without asking; other actions are blocked instead of being escalated to you.",
  dontAsk: "Actions that require approval are blocked instead of asking you.",
  manual: "Behavior depends on the installed Claude version; Wollipog has not verified what this mode permits.",
  "workspace-write": "Reads, writes, and commands inside the workspace run automatically; external files and network access require approval.",
  "read-only": "The agent can read files; edits, commands that modify files, and network access require approval.",
  plan: "The agent researches and proposes a plan without editing anything.",
  bypassPermissions: "Everything runs with no checks. Use only in isolated environments.",
  "danger-full-access": "No sandbox — the agent can do anything. Use with caution.",
  "on-request": "Reads, writes, and commands inside the workspace run automatically; external files and network access require approval.",
};

export function effortLabel(value: string): string {
  const labels: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
  return labels[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

export function permissionModeLabel(id: string, driver?: AgentDriverKind): string {
  if (driver === "codex" && id === "workspace-write") return "Auto (Workspace Sandbox)";
  return PERMISSION_LABELS[id] ?? id;
}

export function permissionModeDescription(id: string, driver?: AgentDriverKind): string | undefined {
  if (driver === "codex" && id === "workspace-write") {
    return "Reads and writes inside the workspace run automatically; external files and network access are blocked (no prompt).";
  }
  if (driver === "codex" && id === "read-only") {
    return "The agent can read files; edits and network access are blocked (no prompt).";
  }
  return PERMISSION_DESCRIPTIONS[id];
}

/** Empty approval selection copy must describe the driver's real control surface. Exec Codex has
 * sandbox policies but cannot pause for interactive Allow/Reject decisions. */
export function permissionModeEmptyLabel(driver?: AgentDriverKind): string {
  return driver === "codex" ? "Sandbox Policy" : "Approve for Me";
}

/** Resolve a persisted permission mode to the value the composer should display.
 * Legacy Codex app-server values remain valid in the driver even after leaving the catalog. */
export function permissionModeForDisplay(id: string | null | undefined, advertisedModes: readonly string[], driver?: AgentDriverKind): string {
  if (!id) return "";
  if (advertisedModes.includes(id)) return id;
  if (id === "workspace-write" && advertisedModes.includes("on-request")) return "on-request";
  if (driver === "claude-code" && id === "plan") return "plan";
  if (id === "untrusted") return "untrusted";
  return "";
}

/**
 * When a box SSH attempt is blocked *before reaching the host* — an EACCES "Permission denied" at
 * connect, a connect timeout, or an unreachable network — it's almost always a local VPN or
 * firewall, not an auth or host problem. Return an actionable hint for those cases.
 *
 * Returns null for everything else, importantly including an SSH *auth* rejection
 * ("Permission denied (publickey)"), which is NOT a VPN issue — so we never mislead on a bad key.
 */
export function sshErrorHint(error: string | null | undefined): string | null {
  if (!error) return null;
  const e = error.toLowerCase();
  // EACCES surfaces as "ssh: connect to host <h> port <p>: Permission denied" — distinct from an
  // auth rejection, which reads "Permission denied (publickey,…)" and never mentions "connect to host".
  const connectBlocked =
    e.includes("connect to host") &&
    /(permission denied|timed out|network is unreachable|no route to host)/.test(e);
  const networkUnreachable = /\b(network is unreachable|no route to host)\b/.test(e);
  if (!connectBlocked && !networkUnreachable) return null;
  return (
    "This looks like the connection was blocked before reaching the host — usually a VPN or firewall. " +
    'If a VPN is active (e.g. NordVPN), add this app to its split-tunneling list set to bypass ' +
    '("Don\'t use VPN for selected apps"), then restart the app — or pause the VPN. ' +
    "Split-tunneling rules only take effect for apps started after the rule is added."
  );
}
