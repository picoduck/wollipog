import type { AgentDriverKind, OS } from "@wollipog/protocol";

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
  intellij: "IntelliJ",
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
    return word.replace(/[A-Za-z][A-Za-z'-]*/g, (part, offset: number) => {
      // An ordinal's suffix ("1st", "22nd") belongs to its number and stays lowercase.
      if (/\d/.test(word[offset - 1] ?? "")) return part;
      const segments = part.split("-");
      return segments.map((segment, segmentIndex) => {
        if (!segment) return segment;
        if (/^[A-Z0-9]+$/.test(segment)) return segment;
        // A name cased on purpose (ChatGPT, OpenCode) keeps its casing, as an acronym does.
        if (/^[A-Z][a-z0-9]*[A-Z]/.test(segment)) return segment;
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

/** Compact relative time for timestamp metadata, in sentence case ("4m ago", docs/design-system.md
 * §17.2); callers provide the shared clock. */
export function formatRecordedRelativeTime(
  timestamp: number | undefined,
  now = Date.now(),
): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return "";
  const diff = Math.max(0, now - timestamp!);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const TIMESTAMP_FORMATTER_LIMIT = 32;
const DEFAULT_FORMAT_ENVIRONMENT_TTL_MS = 1_000;
const timestampFormatters = new Map<string, Intl.DateTimeFormat>();
let defaultFormatEnvironment: { locale: string; timeZone: string; fingerprint: string; refreshedAt: number } | undefined;

/** Explicit invalidation for default-environment changes; retains no timestamp or transcript data. */
export function clearTimestampFormatterCache() {
  timestampFormatters.clear();
  defaultFormatEnvironment = undefined;
}

export function timestampFormatterCacheSize() { return timestampFormatters.size; }

function timestampFormatter(style: "clock" | "recorded" | "title", locale?: string, timeZone?: string) {
  const callerLocale = locale;
  const callerZone = timeZone;
  // The implicit locale/time zone can change while a long-lived tab is open. Use actual resolved
  // defaults, refresh on a changed language/UTC offset, and recheck at least once per second of
  // active formatting for zone changes sharing an offset. The refresh also drops old instances.
  if (locale === undefined || !timeZone) {
    const now = Date.now();
    const languages = typeof navigator === "undefined" ? "" : navigator.languages?.join(",") ?? navigator.language;
    const fingerprint = `${languages}:${new Date(now).getTimezoneOffset()}`;
    if (!defaultFormatEnvironment || defaultFormatEnvironment.fingerprint !== fingerprint ||
        now < defaultFormatEnvironment.refreshedAt || now - defaultFormatEnvironment.refreshedAt >= DEFAULT_FORMAT_ENVIRONMENT_TTL_MS) {
      const resolved = new Intl.DateTimeFormat().resolvedOptions();
      if (defaultFormatEnvironment && (defaultFormatEnvironment.locale !== resolved.locale || defaultFormatEnvironment.timeZone !== resolved.timeZone)) {
        timestampFormatters.clear();
      }
      defaultFormatEnvironment = { locale: resolved.locale, timeZone: resolved.timeZone, fingerprint, refreshedAt: now };
    }
    locale ??= defaultFormatEnvironment.locale;
    timeZone ||= defaultFormatEnvironment.timeZone;
  }
  // Keep implicit and explicit environments distinct: some hosts report Etc/Unknown as their
  // default but reject that name as an explicit zone. Pass the original arguments to Intl.
  const key = JSON.stringify([locale, timeZone, style, callerLocale === undefined, !callerZone]);
  const cached = timestampFormatters.get(key);
  if (cached) {
    timestampFormatters.delete(key);
    timestampFormatters.set(key, cached);
    return cached;
  }
  const options: Intl.DateTimeFormatOptions = style === "title"
    ? { dateStyle: "medium", timeStyle: "medium", ...(callerZone ? { timeZone: callerZone } : {}) }
    : { hour: "numeric", minute: "2-digit", ...(style === "recorded" ? { second: "2-digit" } : {}), ...(callerZone ? { timeZone: callerZone } : {}) };
  const formatter = new Intl.DateTimeFormat(callerLocale, options);
  if (timestampFormatters.size >= TIMESTAMP_FORMATTER_LIMIT) timestampFormatters.delete(timestampFormatters.keys().next().value!);
  timestampFormatters.set(key, formatter);
  return formatter;
}

/** Wall-clock time without seconds ("12:26 AM"), the transcript's one visible timestamp. */
export function formatClock(
  timestamp: number | undefined,
  locale?: string,
  timeZone?: string,
): string {
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp!);
  if (Number.isNaN(date.getTime())) return "";
  return timestampFormatter("clock", locale, timeZone).format(date);
}

/** A local day in words: "Today", "Yesterday", then the date ("Oct 3, 2026"). */
export function localDayLabel(at: number, now: number): string {
  const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day === today) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at));
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
  return {
    dateTime: date.toISOString(),
    label: timestampFormatter("recorded", locale, timeZone).format(date),
    title: `Recorded ${timestampFormatter("title", locale, timeZone).format(date)}`,
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
const COST = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SUB_CENT_COST = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });

export function formatCost(usd: number): string {
  if (usd <= 0) return "";
  // Grouped like every other figure ("$1,234.56"), so a large session total stays readable (#2166).
  return usd < 0.01 ? SUB_CENT_COST.format(usd) : COST.format(usd);
}

/**
 * Friendly labels for the raw approval-mode ids the drivers use. The names make the
 * key distinction explicit: "AI-reviewed" auto (a classifier/Guardian model judges each
 * action) vs. the fixed-rule autos (accept-edits / workspace sandbox).
 */
const PERMISSION_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  // Shared native-harness permission modes (Claude and Pi advertise supported subsets)
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

/** What each permission mode lets run, shown as its permission menu row's second line. What happens
 * to an action that needs approval depends on delivery, so the menu adds that where Wollipog knows. */
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  default: "You approve each tool call before it runs.",
  untrusted: "You approve each tool call before it runs.",
  auto: "A classifier model reviews each action: safe ones run, and risky ones are blocked so the agent tries a safer path.",
  "auto-review": "A Guardian model reviews actions outside the sandbox: low-risk ones run, and risky ones come to you to allow or reject.",
  acceptEdits: "File edits and common file commands run without asking.",
  dontAsk: "Only actions your settings already allow run; anything else is blocked instead of asking you.",
  manual: "Behavior depends on the installed Claude version; Wollipog hasn't verified what this mode permits.",
  "workspace-write": "Reads, writes, and commands inside the workspace run automatically; files outside it and network access need approval.",
  "read-only": "The agent can read files; edits, commands that change files, and network access need approval.",
  plan: "The agent researches and proposes a plan without editing anything.",
  bypassPermissions: "Everything runs with no command approvals. Use only in isolated environments.",
  "danger-full-access": "Everything runs with no sandbox and no command approvals. Use only in isolated environments.",
  "on-request": "Reads, writes, and commands inside the workspace run automatically; files outside it and network access need approval.",
};

export function effortLabel(value: string): string {
  const labels: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
  return labels[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/** Display name for a provider service-tier id, for a tier no catalog names (a carried-over tier the
 * destination does not advertise). `default` is the provider-standard tier. Unknown ids are title
 * cased rather than shown raw. */
export function serviceTierLabel(id: string): string {
  if (id === "default") return "Default";
  return titleCaseLabel(id.replace(/[-_]+/g, " ").trim()) || id;
}

export function permissionModeLabel(id: string, driver?: AgentDriverKind): string {
  if (driver === "codex" && id === "workspace-write") return "Auto (Workspace Sandbox)";
  return PERMISSION_LABELS[id] ?? id;
}

export function permissionModeDescription(id: string, driver?: AgentDriverKind): string | undefined {
  if (id === "orchestrator") {
    const approvalBoundary = driver === "codex" || driver === "codex-app-server"
      ? "Guardian reviews eligible actions automatically"
      : "The harness keeps implementation approvals blocked";
    return `Manages child sessions without its own shell or file-write tools. ${approvalBoundary}; Wollipog keeps child management and human-only requests under its own controls. Selected at session creation and fixed for that session.`;
  }
  // Pi has no settings allowlist: its driver refuses every tool call in Don't Ask (pi-rpc.ts).
  if (driver === "pi" && id === "dontAsk") {
    return "Every tool call is blocked instead of asking you.";
  }
  if (driver === "codex" && id === "workspace-write") {
    return "Reads and writes inside the workspace run automatically; files outside it and network access are blocked.";
  }
  if (driver === "codex" && id === "read-only") {
    return "The agent can read files; edits and network access are blocked.";
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
    "The connection was blocked before it reached the host, usually by a VPN or firewall. " +
    "Pause the VPN or add this app to its split-tunneling list, then restart the app and try again."
  );
}

/**
 * One or two sentences for a failed SSH connection or a refused Connect via SSH request, in the
 * person's words rather than ssh's. The caller keeps the raw text behind Show Details
 * (docs/design-system.md §8.5, §13.2). `target` is the SSH target as entered: "user@host" or a
 * `~/.ssh/config` alias.
 *
 * Connect via SSH (#2987) shows it above the dialog's footer; a machine's failure notice (#2988)
 * reuses it for a reconnect that failed.
 *
 * `request` says the error is a Wollipog API request's, not ssh's: `status` is the HTTP status the
 * control plane answered with, or null when the request never reached it (a network failure, a
 * timeout, the desktop transport's own error). Connect via SSH's request only records the machine,
 * and no SSH runs before the control plane answers, so a request failure is never an SSH diagnosis.
 */
export function describeSshFailure(
  error: string | null | undefined,
  target?: string,
  request?: { status: number | null },
): string {
  const raw = (error ?? "").trim();
  const e = raw.toLowerCase();
  const host = target?.trim() || "the machine";
  const unreachable = "Wollipog couldn't be reached. Check the connection, then try again.";
  // A request past its deadline may still have been applied (RequestTimeoutError), so a retry
  // could add the machine twice.
  if (request && /\bdid(?:n't| not) answer within\b/.test(e)) {
    return "Wollipog didn't answer in time. Check the machine list before trying again.";
  }
  // The browser's words for a request that never reached Wollipog: nothing was tried over SSH.
  if (request?.status === null || /\b(failed to fetch|load failed|networkerror)\b/.test(e)) return unreachable;
  if (request) {
    if (request.status === 401 || request.status === 403) {
      return "Wollipog refused the request. Check that you're signed in and allowed to connect machines.";
    }
    // The control plane's own field checks (POST /api/boxes), made before any SSH is attempted.
    if (e.includes("invalid sshtarget")) return "Use an SSH target such as user@host, with no spaces or leading dash.";
    if (e.includes("sshport")) return "Use a port from 1 to 65535.";
    if (e.includes("displayname")) return "Use a machine name of 120 characters or fewer, with no control characters.";
    return `Wollipog couldn't start connecting to ${host}. Try again.`;
  }
  // An authentication rejection ("Permission denied (publickey,password).") or too many keys offered.
  // A connect-time EACCES reads "port 22: Permission denied" with no parenthesis, and is the hint's.
  if (/permission denied \(/.test(e) || e.includes("too many authentication failures")) {
    return "The host refused your SSH key. Load the key with ssh-add, then try again.";
  }
  const blocked = sshErrorHint(raw);
  if (blocked) return blocked;
  if (e.includes("host key verification failed") || e.includes("remote host identification has changed")) {
    return `The host key for ${host} doesn't match the one this computer knows. Check the host, then update ~/.ssh/known_hosts.`;
  }
  if (e.includes("could not resolve hostname")) return `This computer couldn't find ${host}. Check the SSH target.`;
  if (e.includes("connection refused")) return `${host} refused the connection. Check that SSH runs there and the port is right.`;
  return `Wollipog couldn't reach ${host} over SSH.`;
}

/** The calendar day of `instant` in `timeZone` (the viewer's when omitted), as a UTC midnight. */
function calendarDay(instant: number, timeZone?: string): number {
  return Date.parse(new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}),
  }).format(new Date(instant)));
}

/**
 * A moment in words, without seconds (#2968): "Today, 2:00 AM", "Tomorrow, 2:00 AM",
 * "Yesterday, 2:00 AM", "Sat, 9:00 AM" later this week, and "Oct 14, 9:00 AM" otherwise, with the
 * year only when it is not this year's. In the viewer's time zone unless one is given.
 */
export function formatCalendarTime(instant: number, now = Date.now(), timeZone?: string, locale?: string): string {
  if (!Number.isFinite(instant) || !Number.isFinite(now)) return "";
  const zone = timeZone ? { timeZone } : {};
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, ...zone }).format(new Date(instant));
  const time = format({ hour: "numeric", minute: "2-digit" });
  const days = Math.round((calendarDay(instant, timeZone) - calendarDay(now, timeZone)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days === -1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) return `${format({ weekday: "short" })}, ${time}`;
  const year = (value: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", ...zone }).format(new Date(value));
  return `${format({ month: "short", day: "numeric", ...(year(instant) !== year(now) ? { year: "numeric" } : {}) })}, ${time}`;
}

const countOf = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/**
 * A moment still to come, as its time and how long until it (#2977): "2:36 AM, in 4 minutes",
 * "2:36 AM, in less than a minute", "3:40 AM, in 1 hour 4 minutes"; on another day the time is
 * `formatCalendarTime()`'s ("Tomorrow, 2:36 AM, in 23 hours"). The wait counts the clock's minutes
 * from now to then, so at 2:31 the words for 2:36 always say 5 minutes, whatever the seconds. Under a
 * minute away reads "in less than a minute", and a moment already here reads "now". In the viewer's
 * time zone unless one is given.
 */
export function formatFuture(at: number, now = Date.now(), timeZone?: string, locale?: string): string {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "";
  const wait = at - now;
  if (wait <= 0) return "now";
  const time = calendarDay(at, timeZone) === calendarDay(now, timeZone)
    ? formatClock(at, locale, timeZone)
    : formatCalendarTime(at, now, timeZone, locale);
  const minutes = Math.floor(at / 60_000) - Math.floor(now / 60_000);
  const until = wait < 60_000 ? "less than a minute"
    : minutes < 60 ? countOf(minutes, "minute")
      : minutes % 60 === 0 || minutes >= 24 * 60 ? countOf(Math.round(minutes / 60), "hour")
        : `${countOf(Math.floor(minutes / 60), "hour")} ${countOf(minutes % 60, "minute")}`;
  return `${time}, in ${until}`;
}
