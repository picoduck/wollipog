/** Google Antigravity subscription usage and AI credit probes (Refs #4922).
 *
 * Uses Google's documented read-only print-mode slash commands (`agy -p /usage --output-format
 * stream-json` and `agy -p /credits --output-format stream-json`, shipped in CLI v1.1.11) inside
 * `antigravityCredentialContext`. Never reads the OS keyring, calls undocumented backend endpoints,
 * or sends a model prompt:
 * - CLI versions older than `ANTIGRAVITY_MIN_USAGE_CLI_VERSION` fail closed before spawning.
 * - `stream-json` emits `event: "command_result"` for built-in slash commands and `event: "init"`
 *   for ordinary prompts; observing `init` or `num_turns > 0` terminates the child immediately and
 *   reports `unsupported` so an older/unrecognized command can never run an LLM turn.
 * - Unauthenticated runs print an OAuth sign-in prompt and wait up to 60s even with closed stdin;
 *   detecting that prompt terminates the child immediately and reports `unauthenticated` without
 *   logging any URL or raw output. */

import type {
  SubscriptionUsageBucket,
  SubscriptionUsageCredits,
} from "@wollipog/protocol";
import { killTree, spawnAgent, type AgentProcess, type SpawnIsolation } from "./spawn.js";
import type { AntigravityCredentialContext } from "./antigravity-setup.js";

type JsonRecord = Record<string, unknown>;

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_PROVIDER_BUCKETS = 64;
const MAX_WINDOW_DURATION_MINUTES = 2 * 365 * 24 * 60;
const MAX_RESET_AHEAD_MS = 2 * 365 * 24 * 60 * 60_000;

export const ANTIGRAVITY_USAGE_PROBE_ARGS: readonly string[] = [
  "-p", "/usage", "--output-format", "stream-json",
];
export const ANTIGRAVITY_CREDITS_PROBE_ARGS: readonly string[] = [
  "-p", "/credits", "--output-format", "stream-json",
];

const AUTH_PROMPT_PATTERN =
  /authentication required|please visit the url to log in|paste the authorization code|waiting for authentication/iu;
const AUTH_ERROR_PATTERN =
  /authentication required|authentication failed|authentication interrupted|not signed in|sign in|unauthenticated/iu;
const NOT_APPLICABLE_PATTERN =
  /not available with a gemini api key|api key|enterprise|business|no account quota|no quota|not applicable/iu;
const TITLE_MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "nor", "of", "on", "or", "per", "the", "to", "via"]);
const KNOWN_ACRONYMS = new Set(["ai", "api", "cli", "gpt", "oss", "pro", "ultra"]);

export interface AntigravityUsageProbeDeps {
  spawn?: typeof spawnAgent;
  kill?: typeof killTree;
  onSpawn?: (child: AgentProcess) => void;
  onFinish?: (child: AgentProcess) => void;
}

export interface AntigravityUsageProbeOptions {
  command: string;
  cwd: string;
  context: AntigravityCredentialContext;
  isolation?: SpawnIsolation;
  timeoutMs: number;
  now?: () => number;
  /** Re-checked immediately before each CLI spawn (`/usage` and `/credits`) to detect in-place
   * executable replacement before passing print-mode arguments to an unverified binary. */
  verifyExecutable?: () => boolean;
  deps?: AntigravityUsageProbeDeps;
}

export type AntigravityUsageProbeResult =
  | { state: "available"; buckets: SubscriptionUsageBucket[]; credits?: SubscriptionUsageCredits }
  | { state: "unauthenticated"; detail: string }
  | { state: "not_applicable"; detail: string }
  | { state: "unsupported"; detail: string }
  | { state: "target_changed"; detail: string };

type PrintCommandOutcome =
  | { kind: "ok"; data: unknown }
  | { kind: "unauthenticated" }
  | { kind: "not_applicable" }
  | { kind: "unsupported" };

function record(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]+/gu, " ");
  return normalized ? normalized.slice(0, max) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function titleCaseLabel(raw: string): string {
  const words = raw.trim().split(/\s+/u).filter(Boolean);
  return words.map((word, index) => {
    const lower = word.toLocaleLowerCase("en-US");
    if (KNOWN_ACRONYMS.has(lower)) {
      if (lower === "pro") return "Pro";
      if (lower === "ultra") return "Ultra";
      return lower.toUpperCase();
    }
    // Preserve intentional mixed/uppercase tokens (e.g. "GPT-OSS", "Gemini", "3P").
    if (/[A-Z]/u.test(word.slice(1)) || (/^[A-Z0-9-]+$/u.test(word) && word.length > 1)) return word;
    if (index > 0 && index < words.length - 1 && TITLE_MINOR_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(" ");
}

function slug(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "quota";
}

function antigravityWindowDurationMinutes(window: string | undefined, name: string | undefined): number | undefined {
  const raw = window?.trim().toLocaleLowerCase("en-US");
  if (raw === "5h" || raw === "five_hour" || raw === "five-hour") return 5 * 60;
  if (raw === "weekly" || raw === "7d" || raw === "seven_day") return 7 * 24 * 60;
  if (raw === "daily" || raw === "24h" || raw === "1d") return 24 * 60;
  const parsed = raw?.match(/^(\d+)([mhd])$/u);
  if (parsed) {
    const amount = Number(parsed[1]);
    const unit = parsed[2];
    const minutes = unit === "m" ? amount : unit === "h" ? amount * 60 : amount * 24 * 60;
    return minutes >= 1 && minutes <= MAX_WINDOW_DURATION_MINUTES ? minutes : undefined;
  }
  if (name) {
    if (/five[- ]?hour|5[- ]?hour/iu.test(name)) return 5 * 60;
    if (/weekly|7[- ]?day/iu.test(name)) return 7 * 24 * 60;
  }
  return undefined;
}

function antigravityWindowLabel(window: string | undefined, name: string | undefined): string {
  const raw = window?.trim().toLocaleLowerCase("en-US");
  if (raw === "5h" || raw === "five_hour" || raw === "five-hour" || (name && /five[- ]?hour|5[- ]?hour/iu.test(name))) {
    return "Five-Hour Window";
  }
  if (raw === "weekly" || raw === "7d" || raw === "seven_day" || (name && /weekly|7[- ]?day/iu.test(name))) {
    return "Weekly";
  }
  if (raw === "daily" || raw === "24h" || raw === "1d") return "Daily";
  if (name) {
    const cleaned = name.replace(/\s+limit\s+remaining$/iu, "").replace(/\s+remaining$/iu, "").trim();
    if (cleaned) return titleCaseLabel(cleaned);
  }
  return raw ? titleCaseLabel(raw) : "Quota";
}

function isoResetAt(value: unknown, observedAt: number): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > observedAt + MAX_RESET_AHEAD_MS) return undefined;
  return Math.round(parsed / 1_000) * 1_000;
}

function roundPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

/** Normalize `command.data` from `agy -p /usage --output-format stream-json`.
 * Returns `not_applicable` when the CLI reports an explicit empty group list (e.g., Enterprise or
 * Business sign-ins without per-model quotas), `available` with normalized buckets, or `null` when
 * the payload shape is unrecognized. */
export function normalizeAntigravityUsageData(
  payload: unknown,
  observedAt: number,
): { state: "available"; buckets: SubscriptionUsageBucket[] } | { state: "not_applicable" } | null {
  const root = record(payload);
  if (!root || !Array.isArray(root.groups)) return null;
  if (root.groups.length === 0) return { state: "not_applicable" };

  const buckets: SubscriptionUsageBucket[] = [];
  const seenIds = new Set<string>();
  let sawRecognizedGroup = false;
  let sawAnyBucket = false;

  for (const rawGroup of root.groups) {
    const group = record(rawGroup);
    if (!group || !Array.isArray(group.buckets)) continue;
    sawRecognizedGroup = true;
    const rawGroupName = stringValue(group.name, 80);
    const groupLabel = rawGroupName ? titleCaseLabel(rawGroupName) : undefined;
    const groupBuckets: SubscriptionUsageBucket[] = [];

    for (const rawBucket of group.buckets) {
      sawAnyBucket = true;
      const entry = record(rawBucket);
      if (!entry) continue;
      const window = stringValue(entry.window, 40);
      const rawName = stringValue(entry.name, 100);
      const rawId = stringValue(entry.id, 96) ??
        stringValue(`${groupLabel ? `${slug(groupLabel)}:` : ""}${slug(window ?? rawName ?? "quota")}`, 96);
      if (!rawId || seenIds.has(rawId)) continue;

      const fraction = finite(entry.remaining_fraction ?? entry.remainingFraction);
      const remainingPercent = fraction === undefined ? undefined : roundPercent(Math.max(0, Math.min(1, fraction)) * 100);
      const usedPercent = remainingPercent === undefined ? undefined : roundPercent(100 - remainingPercent);
      const resetsAt = isoResetAt(entry.reset_time ?? entry.resetTime, observedAt);
      const windowDurationMinutes = antigravityWindowDurationMinutes(window, rawName);
      if (remainingPercent === undefined && resetsAt === undefined && windowDurationMinutes === undefined) continue;

      const windowLabel = antigravityWindowLabel(window, rawName);
      const label = stringValue(groupLabel ? `${groupLabel} — ${windowLabel}` : windowLabel, 160)!;
      const status = remainingPercent === undefined
        ? "available" as const
        : remainingPercent <= 0
          ? "exhausted" as const
          : usedPercent! >= 80
            ? "warning" as const
            : "available" as const;

      seenIds.add(rawId);
      groupBuckets.push({
        id: rawId,
        label,
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(remainingPercent === undefined ? {} : { remainingPercent }),
        ...(windowDurationMinutes === undefined ? {} : { windowDurationMinutes }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        status,
      });
    }

    // Order shorter windows before longer ones inside each model group (e.g., 5h before weekly).
    groupBuckets.sort((left, right) => {
      const leftDuration = left.windowDurationMinutes ?? Number.POSITIVE_INFINITY;
      const rightDuration = right.windowDurationMinutes ?? Number.POSITIVE_INFINITY;
      return leftDuration - rightDuration;
    });
    for (const bucket of groupBuckets) {
      if (buckets.length >= MAX_PROVIDER_BUCKETS) break;
      buckets.push(bucket);
    }
  }

  if (!sawRecognizedGroup) return null;
  if (!sawAnyBucket) return { state: "not_applicable" };
  if (buckets.length === 0) return null;
  return { state: "available", buckets };
}

/** Normalize `command.data` from `agy -p /credits --output-format stream-json`. */
export function normalizeAntigravityCreditsData(payload: unknown): SubscriptionUsageCredits | undefined {
  const root = record(payload);
  if (!root) return undefined;
  const remaining = finite(root.remaining_credits ?? root.remainingCredits);
  if (remaining === undefined || remaining < 0) return undefined;
  const balance = Number.isInteger(remaining)
    ? String(remaining)
    : String(Math.round(remaining * 100) / 100);
  if (balance.length > 80) return undefined;
  return {
    hasCredits: remaining > 0,
    balance,
  };
}

function classifyErrorText(text: string): "unauthenticated" | "not_applicable" | "error" {
  if (AUTH_ERROR_PATTERN.test(text)) return "unauthenticated";
  if (NOT_APPLICABLE_PATTERN.test(text)) return "not_applicable";
  return "error";
}

function probeAntigravityPrintCommand(
  expectedCommand: "usage" | "credits",
  args: readonly string[],
  options: AntigravityUsageProbeOptions,
): Promise<PrintCommandOutcome> {
  const spawn = options.deps?.spawn ?? spawnAgent;
  const kill = options.deps?.kill ?? killTree;
  const child = spawn({
    command: options.command,
    args: [...args],
    cwd: options.cwd,
    env: options.context.env,
    scrubInheritedEnv: options.context.scrubInheritedEnv,
    isolation: options.isolation,
    windowsShell: false,
  });
  options.deps?.onSpawn?.(child);
  child.stdin.on("error", () => {});
  child.stdin.end();

  return new Promise<PrintCommandOutcome>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let stderrText = "";
    let commandData: unknown = undefined;
    let hasCommandData = false;
    let verifiedZeroTurnSuccess = false;
    let sawTerminalError = false;
    let errorMessage: string | undefined;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill(child);
      options.deps?.onFinish?.(child);
      action();
    };

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      if (AUTH_PROMPT_PATTERN.test(line)) {
        finish(() => resolve({ kind: "unauthenticated" }));
        return;
      }
      let parsed: JsonRecord | null;
      try {
        parsed = record(JSON.parse(line));
      } catch {
        return;
      }
      if (!parsed) return;
      const event = typeof parsed.event === "string" ? parsed.event : undefined;
      // Built-in print-mode slash commands never emit an agent `init` event. Observing `init`
      // means this CLI treated the slash command as an ordinary prompt — abort immediately.
      if (event === "init") {
        finish(() => resolve({ kind: "unsupported" }));
        return;
      }
      if (event === "command_result") {
        const command = record(parsed.command);
        if (command?.name === expectedCommand && "data" in command) {
          commandData = command.data;
          hasCommandData = true;
        }
        return;
      }
      const envelope = event === "result" ? record(parsed.result) : parsed;
      if (!envelope) {
        if (event === "result") verifiedZeroTurnSuccess = false;
        return;
      }
      const numTurns = finite(envelope.num_turns);
      if (numTurns !== undefined && numTurns > 0) {
        finish(() => resolve({ kind: "unsupported" }));
        return;
      }
      const status = typeof envelope.status === "string" ? envelope.status : undefined;
      if (status === "SUCCESS") {
        const command = record(envelope.command);
        if (command?.name === expectedCommand && "data" in command) {
          commandData = command.data;
          hasCommandData = true;
        }
        // Only the final terminal result may verify zero turns; a later SUCCESS lacking num_turns=0
        // must not inherit an earlier frame's verification.
        verifiedZeroTurnSuccess = numTurns === 0;
      } else if (status === "ERROR") {
        sawTerminalError = true;
        verifiedZeroTurnSuccess = false;
        const err = stringValue(envelope.error, 300);
        if (err) errorMessage = err;
      } else if (event === "result") {
        verifiedZeroTurnSuccess = false;
      }
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Google Antigravity /${expectedCommand} probe timed out`)));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        finish(() => reject(new Error(`Google Antigravity /${expectedCommand} probe output is too large`)));
        return;
      }
      if (AUTH_PROMPT_PATTERN.test(chunk)) {
        finish(() => resolve({ kind: "unauthenticated" }));
        return;
      }
      stdoutBuffer += chunk;
      for (let newline = stdoutBuffer.indexOf("\n"); newline >= 0; newline = stdoutBuffer.indexOf("\n")) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
        if (settled) return;
      }
      if (AUTH_PROMPT_PATTERN.test(stdoutBuffer)) {
        finish(() => resolve({ kind: "unauthenticated" }));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      if (stderrText.length < 8_192) stderrText = `${stderrText}${chunk}`.slice(0, 8_192);
      if (AUTH_PROMPT_PATTERN.test(stderrText)) {
        finish(() => resolve({ kind: "unauthenticated" }));
      }
    });

    child.once("error", () => {
      finish(() => reject(new Error(`Google Antigravity /${expectedCommand} probe could not be started`)));
    });

    child.once("close", (code) => {
      if (settled) return;
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (settled) return;
      if (code === 0 && hasCommandData && verifiedZeroTurnSuccess && !sawTerminalError) {
        finish(() => resolve({ kind: "ok", data: commandData }));
        return;
      }
      const diagnostic = errorMessage ?? stderrText;
      if (diagnostic) {
        const classified = classifyErrorText(diagnostic);
        if (classified === "unauthenticated") {
          finish(() => resolve({ kind: "unauthenticated" }));
          return;
        }
        if (classified === "not_applicable") {
          finish(() => resolve({ kind: "not_applicable" }));
          return;
        }
      }
      finish(() => reject(new Error(
        `Google Antigravity /${expectedCommand} probe did not complete with a zero-turn result (code ${code ?? "null"})`,
      )));
    });
  });
}

/** Probe Google Antigravity model quotas (and best-effort AI credit balance) through `agy`. */
export async function probeAntigravitySubscriptionUsage(
  options: AntigravityUsageProbeOptions,
): Promise<AntigravityUsageProbeResult> {
  const now = options.now ?? Date.now;
  if (options.verifyExecutable && !options.verifyExecutable()) {
    return {
      state: "target_changed",
      detail: "The Google Antigravity executable changed; retry after setup re-checks it.",
    };
  }
  const usageOutcome = await probeAntigravityPrintCommand("usage", ANTIGRAVITY_USAGE_PROBE_ARGS, options);
  if (usageOutcome.kind === "unauthenticated") {
    return { state: "unauthenticated", detail: "Google Antigravity is not signed in." };
  }
  if (usageOutcome.kind === "not_applicable") {
    return {
      state: "not_applicable",
      detail: "This Google Antigravity sign-in does not report personal subscription quotas.",
    };
  }
  if (usageOutcome.kind === "unsupported") {
    return {
      state: "unsupported",
      detail: "This Google Antigravity version does not report subscription usage. Update Google Antigravity to view quotas.",
    };
  }
  const normalized = normalizeAntigravityUsageData(usageOutcome.data, now());
  if (!normalized) {
    throw new Error("Google Antigravity returned no recognizable quota windows");
  }
  if (normalized.state === "not_applicable") {
    return {
      state: "not_applicable",
      detail: "This Google Antigravity sign-in does not report personal subscription quotas.",
    };
  }

  if (options.verifyExecutable && !options.verifyExecutable()) {
    return {
      state: "target_changed",
      detail: "The Google Antigravity executable changed; retry after setup re-checks it.",
    };
  }

  let credits: SubscriptionUsageCredits | undefined;
  try {
    const creditsOutcome = await probeAntigravityPrintCommand("credits", ANTIGRAVITY_CREDITS_PROBE_ARGS, options);
    if (creditsOutcome.kind === "unauthenticated") {
      return { state: "unauthenticated", detail: "Google Antigravity is not signed in." };
    }
    if (creditsOutcome.kind === "unsupported") {
      return {
        state: "unsupported",
        detail: "This Google Antigravity version does not report subscription usage. Update Google Antigravity to view quotas.",
      };
    }
    if (creditsOutcome.kind === "ok") {
      credits = normalizeAntigravityCreditsData(creditsOutcome.data);
    }
  } catch {
    // AI credits are supplementary; a transient /credits error never hides model quotas.
  }

  return {
    state: "available",
    buckets: normalized.buckets,
    ...(credits ? { credits } : {}),
  };
}
