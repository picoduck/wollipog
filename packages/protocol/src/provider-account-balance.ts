import type { ProviderAccountDefinition, SubscriptionUsageBucket, SubscriptionUsageSnapshot } from "./index.js";
import { providerAccountIneligibility, type ProviderAccountEligibilityInput, type ProviderAccountSkipReason } from "./provider-account-selection.js";

/**
 * Feasibility scoring for Automatic Balance (#4353). Nothing launches through this yet: it exists so a
 * simulation can show what the rule would do with the data Wollipog really has.
 *
 * The rule, in plain language: use the account that would otherwise lose the most allowance to its next
 * reset. Each account's remaining percentage in its longest window is discounted by how far off that
 * window's reset is, so 40% left resetting in 3 hours beats 80% left resetting in 5 days. A shorter window
 * about to reset adds a small nudge, since its allowance comes back soon anyway. An account whose tightest
 * limit is nearly used, and won't reset within the hour, goes last. Percentages across unequal plans are a
 * heuristic, not capacity: 40% of a small plan is less than 40% of a large one, and no reliable multiplier
 * exists. Model compatibility is unknown and never scored.
 *
 * Exhaustion, spend controls, sign-in, access, context, billing and cooldowns all run first, through
 * `providerAccountIneligibility`. Scoring only orders what remains, so it can never choose past them.
 */

export const BALANCE_FRESH_AFTER_MS = 10 * 60_000;
/** Below this remaining percentage a window can't be trusted to carry a session. */
export const BALANCE_LOW_HEADROOM_PERCENT = 10;
/** A limit resetting this soon isn't low headroom: the allowance is about to come back. */
export const BALANCE_SOON_RESET_MS = 60 * 60_000;
/** How far off a reset halves the urgency of the allowance behind it. */
export const BALANCE_RESET_HALF_URGENCY_MS = 24 * 60 * 60_000;
const SHORT_WINDOW_NUDGE = 0.1;

/** Why an account can't be scored. Never a reason to skip it: it stays eligible, and simply can't be compared. */
export type BalanceUnknownReason =
  /** No reading has ever arrived, or the provider hasn't answered for it. */
  | "no_reading"
  /** A reading exists but is older than the freshness limit the caller set. */
  | "stale"
  /** A window reports status or a reset but no percentage, as older Claude Code versions do. */
  | "no_utilization"
  /** A window reports a percentage but no reset, so nothing says how soon it comes back. */
  | "no_reset"
  /** A window's length is neither reported nor known from its id, so windows can't be told apart. */
  | "no_duration";

export type BalanceScore =
  | { scored: true; score: number; lowHeadroom: boolean; headroomPercent: number }
  | { scored: false; reason: BalanceUnknownReason };

const KNOWN_WINDOW_MINUTES: Readonly<Record<string, number>> = {
  five_hour: 300,
  seven_day: 7 * 24 * 60,
  seven_day_opus: 7 * 24 * 60,
  seven_day_sonnet: 7 * 24 * 60,
  seven_day_fable: 7 * 24 * 60,
  seven_day_overage_included: 7 * 24 * 60,
};

/** Extra usage isn't allowance to protect: Automatic Balance never spends it, so it never counts. */
function scoredWindow(bucket: SubscriptionUsageBucket): boolean {
  return !/overage/u.test(bucket.id);
}

function remainingPercent(bucket: SubscriptionUsageBucket): number | undefined {
  return bucket.remainingPercent ?? (bucket.usedPercent === undefined ? undefined : Math.max(0, 100 - bucket.usedPercent));
}

function windowMinutes(bucket: SubscriptionUsageBucket): number | undefined {
  return bucket.windowDurationMinutes ?? KNOWN_WINDOW_MINUTES[bucket.id];
}

/** One account's score from its reading, or why it has none. `freshForMs` is the age a caller accepts. */
export function scoreProviderAccountUsage(
  usage: SubscriptionUsageSnapshot | undefined,
  now: number,
  freshForMs: number = BALANCE_FRESH_AFTER_MS,
  halfUrgencyMs: number = BALANCE_RESET_HALF_URGENCY_MS,
): BalanceScore {
  if (!usage || usage.state !== "available") return { scored: false, reason: "no_reading" };
  if (now - usage.fetchedAt > freshForMs) return { scored: false, reason: "stale" };
  // A window whose reset has passed has come back, so what it last said no longer counts against it.
  const current = usage.buckets.filter((bucket) => scoredWindow(bucket) && (bucket.resetsAt === undefined || bucket.resetsAt > now));
  if (current.length === 0) {
    return usage.buckets.length ? { scored: true, score: 0, lowHeadroom: false, headroomPercent: 100 } : { scored: false, reason: "no_reading" };
  }
  const windows: Array<{ remaining: number; resetsIn: number; minutes: number }> = [];
  for (const bucket of current) {
    const remaining = remainingPercent(bucket);
    const minutes = windowMinutes(bucket);
    if (remaining === undefined) return { scored: false, reason: "no_utilization" };
    if (bucket.resetsAt === undefined) return { scored: false, reason: "no_reset" };
    if (minutes === undefined) return { scored: false, reason: "no_duration" };
    windows.push({ remaining, resetsIn: bucket.resetsAt - now, minutes });
  }
  const binding = windows.filter((window) => window.resetsIn > BALANCE_SOON_RESET_MS);
  const headroomPercent = binding.length ? Math.min(...binding.map((window) => window.remaining)) : 100;
  const controls = (usage.spendControls ?? []).flatMap((control) => control.remainingPercent === undefined ? [] : [control.remainingPercent]);
  // Several windows can share the longest length, as per-model weekly limits do: the tightest of them binds.
  const longest = windows.reduce((best, window) =>
    window.minutes > best.minutes || (window.minutes === best.minutes && window.remaining < best.remaining) ? window : best);
  const atRisk = (longest.remaining / 100) / (1 + longest.resetsIn / halfUrgencyMs);
  const nudge = windows.filter((window) => window !== longest).reduce((sum, window) =>
    sum + SHORT_WINDOW_NUDGE * (window.remaining / 100) * Math.max(0, 1 - window.resetsIn / (window.minutes * 60_000)), 0);
  return {
    scored: true,
    score: atRisk + nudge,
    lowHeadroom: Math.min(headroomPercent, ...controls) < BALANCE_LOW_HEADROOM_PERCENT,
    headroomPercent,
  };
}

export type BalanceCandidate =
  | { accountId: string; eligible: false; reason: ProviderAccountSkipReason; retryAt?: number; limitLabel?: string }
  | { accountId: string; eligible: true; score: BalanceScore };

export type BalanceOutcome =
  /** Nothing is eligible: the same refusal Priority Order gives. */
  | { status: "none"; candidates: BalanceCandidate[] }
  /** One account is eligible, so nothing needs comparing. */
  | { status: "selected"; basis: "only_eligible"; accountId: string; candidates: BalanceCandidate[] }
  /** Every eligible account was compared. */
  | { status: "selected"; basis: "scored"; accountId: string; candidates: BalanceCandidate[] }
  /** Two or more are eligible and at least one can't be scored, so no comparison is honest. */
  | { status: "no_safe_choice"; unknown: BalanceUnknownReason[]; candidates: BalanceCandidate[] };

/**
 * Chooses among one provider's accounts. Every account an unknown reading leaves unscored blocks the whole
 * comparison, because the accounts that do have numbers are the ones already being used: comparing only those
 * would keep spending the busy account and never reach the idle one Balance exists to find.
 */
export function selectBalancedAccount(input: {
  accounts: readonly ProviderAccountDefinition[];
  usage: readonly SubscriptionUsageSnapshot[];
  agent?: ProviderAccountEligibilityInput["agent"];
  accessRefused?: (account: ProviderAccountDefinition) => boolean;
  now: number;
  freshForMs?: number;
  /** How far off a reset halves its urgency. Exposed so a simulation can test the rule isn't mistuned. */
  halfUrgencyMs?: number;
}): BalanceOutcome {
  const candidates = input.accounts.map((account): BalanceCandidate => {
    const usage = input.usage.find((snapshot) => snapshot.providerAccountId === account.id);
    const refused = providerAccountIneligibility(account, {
      ...(input.agent ? { agent: input.agent } : {}),
      ...(usage ? { usage } : {}),
      accessRefused: input.accessRefused?.(account) ?? false,
      now: input.now,
    });
    return refused
      ? { accountId: account.id, eligible: false, ...refused }
      : { accountId: account.id, eligible: true, score: scoreProviderAccountUsage(usage, input.now, input.freshForMs, input.halfUrgencyMs) };
  });
  const eligible = candidates.filter((candidate): candidate is Extract<BalanceCandidate, { eligible: true }> => candidate.eligible);
  if (eligible.length === 0) return { status: "none", candidates };
  if (eligible.length === 1) return { status: "selected", basis: "only_eligible", accountId: eligible[0]!.accountId, candidates };
  const unknown = eligible.flatMap((candidate) => candidate.score.scored ? [] : [candidate.score.reason]);
  if (unknown.length) return { status: "no_safe_choice", unknown, candidates };
  // Stable, so equal scores keep the order the caller gave.
  const ranked = [...eligible].sort((left, right) => {
    const a = left.score as Extract<BalanceScore, { scored: true }>;
    const b = right.score as Extract<BalanceScore, { scored: true }>;
    return Number(a.lowHeadroom) - Number(b.lowHeadroom) || b.score - a.score;
  });
  return { status: "selected", basis: "scored", accountId: ranked[0]!.accountId, candidates };
}
