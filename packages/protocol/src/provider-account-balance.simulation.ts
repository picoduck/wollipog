import type { ProviderAccountDefinition, SubscriptionUsageSnapshot } from "./index.js";
import { BALANCE_FRESH_AFTER_MS, selectBalancedAccount } from "./provider-account-balance.js";

/**
 * A discrete simulation of Automatic Balance against what Wollipog can really observe (#4353).
 *
 * Observation follows the code: an account gets a reading only while a session on it receives provider
 * responses (`rate_limit_event`, Codex's rate-limit notification). A person's manual refresh and a runner
 * start are ignored here because they are rare and only help Codex. `codex_refresh` adds a no-turn probe of
 * every account at each launch, which is what a bounded refresh could do for Codex and only Codex.
 *
 * Assumptions the code can't verify, stated so the numbers aren't read as measurements:
 * - A five-hour window holds 20% of a week's allowance and starts at first use. Weekly windows have fixed,
 *   unrelated anchors. The real ratio is the provider's and varies by plan.
 * - Workloads are invented, not read from anyone's history.
 * - External use (a provider's own app, another machine) is modelled as a share of each account's capacity.
 *
 * Deterministic for one seed.
 */

export type BalancePolicy =
  /** First eligible in a fixed order: Slice A's shipped behavior. */
  | "priority"
  /** Scores only when every eligible account has a reading under ten minutes old. */
  | "strict_fresh"
  /** Scores whichever accounts have fresh readings and ignores the rest. */
  | "known_only"
  /** Scores every account on its last reading, whatever its age. A never-read account is tried once. */
  | "last_known"
  /** `strict_fresh`, with every account probed at each launch. Codex only: Claude has no such probe. */
  | "codex_refresh"
  /** The true state of every account, including external use. The best any rule here could do. */
  | "oracle"
  /** Takes eligible accounts in turn. Reads no usage at all beyond "used up", so it has nothing to be stale. */
  | "round_robin"
  /** The most remaining in the tightest window on its last reading, ignoring resets: the issue's rejected alternative. */
  | "most_remaining"
  /** The oracle with a steeper or flatter urgency curve, to test that the rule isn't merely mistuned. */
  | "oracle_urgent"
  | "oracle_patient"
  /** True state, earliest weekly reset first among accounts above the low-headroom floor: the textbook
   * best rule for meeting deadlines, and so reset-awareness's best case. */
  | "oracle_edf";

export interface BalanceScenario {
  planUnits: readonly number[];
  profile: "solo" | "parallel" | "campaign";
  /** Demand as a share of the accounts' total weekly capacity. */
  load: number;
  /** The share of each account's capacity spent outside Wollipog. */
  externalShare: number;
  /** A five-hour window's share of a week's allowance. Defaults to 20%; the real ratio is unverified. */
  fiveHourShare?: number;
}

export interface BalanceResult {
  launches: number;
  /** Launches where two or more accounts were eligible, so a comparison was possible at all. */
  contested: number;
  /** Of those, how many the rule compared rather than finding no safe choice. */
  compared: number;
  noSafeChoice: number;
  /** Launches started on an account that was really out of allowance, which fails at the provider. */
  startedExhausted: number;
  /** Running sessions cut off by a limit. */
  interruptions: number;
  /** Demand not served, as a share of all demand. */
  unservedShare: number;
  /** Allowance that reached a weekly reset unused, as a share of all capacity offered. */
  wastedShare: number;
  /** Account probes a refresh policy ran. */
  probes: number;
}

const TICK_MINUTES = 5;
const WEEK = 7 * 24 * 60;
const FIVE_HOURS = 300;
const DEFAULT_FIVE_HOUR_SHARE = 0.2;
const MINUTE = 60_000;

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Launch { at: number; minutes: number }

function workload(profile: BalanceScenario["profile"], weeks: number, random: () => number): Launch[] {
  const launches: Launch[] = [];
  const range = (low: number, high: number) => low + random() * (high - low);
  for (let week = 0; week < weeks; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const start = (week * 7 + day) * 24 * 60;
      if (profile === "campaign") {
        // Two long bursts a week: three sessions at a time around the clock, then quiet.
        if (day !== 1 && day !== 4) continue;
        for (let slot = 0; slot < 3; slot += 1) {
          for (let at = start + range(0, 30); at < start + 48 * 60;) {
            const minutes = range(40, 150);
            launches.push({ at, minutes });
            at += minutes + range(2, 20);
          }
        }
        continue;
      }
      if (day >= 5) continue;
      if (profile === "solo") {
        // One person, a few separate sessions in a working day.
        for (let count = 0; count < 3; count += 1) {
          launches.push({ at: start + 9 * 60 + count * 180 + range(0, 60), minutes: range(45, 120) });
        }
        continue;
      }
      // Three sessions at a time through a working day.
      for (let slot = 0; slot < 3; slot += 1) {
        for (let at = start + 9 * 60 + range(0, 30); at < start + 19 * 60;) {
          const minutes = range(30, 120);
          launches.push({ at, minutes });
          at += minutes + range(2, 30);
        }
      }
    }
  }
  return launches.sort((left, right) => left.at - right.at);
}

interface SimAccount {
  id: string;
  units: number;
  weeklyUsed: number;
  weeklyResetAt: number;
  fiveUsed: number;
  fiveResetAt: number | null;
  reading: SubscriptionUsageSnapshot | undefined;
}

function truth(account: SimAccount, now: number, fiveHourShare: number): SubscriptionUsageSnapshot {
  const fiveCapacity = account.units * fiveHourShare;
  const toMs = (minute: number) => minute * MINUTE;
  const percent = (used: number, capacity: number) => Math.min(100, (used / capacity) * 100);
  return {
    sourceId: account.id, runnerId: "r", agentId: "a", provider: "claude", state: "available", fetchedAt: toMs(now),
    providerAccountId: account.id,
    buckets: [
      { id: "seven_day", label: "Weekly", usedPercent: percent(account.weeklyUsed, account.units), remainingPercent: 100 - percent(account.weeklyUsed, account.units),
        resetsAt: toMs(account.weeklyResetAt), windowDurationMinutes: WEEK },
      ...(account.fiveResetAt === null ? [] : [{ id: "five_hour", label: "Five-Hour", usedPercent: percent(account.fiveUsed, fiveCapacity),
        remainingPercent: 100 - percent(account.fiveUsed, fiveCapacity), resetsAt: toMs(account.fiveResetAt), windowDurationMinutes: FIVE_HOURS }]),
    ],
  };
}

function really(account: SimAccount, fiveHourShare: number): boolean {
  return account.weeklyUsed >= account.units || (account.fiveResetAt !== null && account.fiveUsed >= account.units * fiveHourShare);
}

export function simulateBalance(scenario: BalanceScenario, policy: BalancePolicy, seed: number, weeks = 4): BalanceResult {
  const random = prng(seed);
  const fiveHourShare = scenario.fiveHourShare ?? DEFAULT_FIVE_HOUR_SHARE;
  const readNow = (account: SimAccount, now: number) => truth(account, now, fiveHourShare);
  const exhausted = (account: SimAccount) => really(account, fiveHourShare);
  // The workload is drawn first, so every policy faces the same launches for one seed.
  const launches = workload(scenario.profile, weeks, random);
  const sessionMinutes = launches.reduce((sum, launch) => sum + launch.minutes, 0);
  const capacityPerWeek = scenario.planUnits.reduce((sum, units) => sum + units, 0);
  const burnPerMinute = (scenario.load * capacityPerWeek * weeks) / sessionMinutes;
  const accounts: SimAccount[] = scenario.planUnits.map((units, index) => ({
    id: `account-${index}`, units, weeklyUsed: 0, weeklyResetAt: Math.floor(random() * WEEK) + 1, fiveUsed: 0, fiveResetAt: null, reading: undefined,
  }));
  const definitions: ProviderAccountDefinition[] = accounts.map((account) => ({
    id: account.id, label: account.id, provider: "claude", authStatus: "authenticated", billing: "subscription",
  }));
  const running: Array<{ account: SimAccount; endsAt: number }> = [];
  const result: BalanceResult = { launches: 0, contested: 0, compared: 0, noSafeChoice: 0, startedExhausted: 0, interruptions: 0, unservedShare: 0, wastedShare: 0, probes: 0 };
  let demanded = 0;
  let served = 0;
  let wasted = 0;
  let offered = 0;
  let next = 0;
  let lastChosen: string | undefined;
  const end = weeks * WEEK;

  const spend = (account: SimAccount, units: number, now: number) => {
    if (account.fiveResetAt === null) account.fiveResetAt = now + FIVE_HOURS;
    account.weeklyUsed += units;
    account.fiveUsed += units;
  };

  for (let now = 0; now < end; now += TICK_MINUTES) {
    for (const account of accounts) {
      if (account.fiveResetAt !== null && account.fiveResetAt <= now) { account.fiveUsed = 0; account.fiveResetAt = null; }
      if (account.weeklyResetAt <= now) {
        wasted += Math.max(0, account.units - account.weeklyUsed);
        offered += account.units;
        account.weeklyUsed = 0;
        account.weeklyResetAt += WEEK;
      }
      // External use lands in occasional lumps Wollipog can't see until its next reading.
      const lump = account.units * 0.03;
      const perTick = (scenario.externalShare * account.units) / (WEEK / TICK_MINUTES);
      if (random() < perTick / lump && !exhausted(account)) spend(account, lump, now);
    }

    while (next < launches.length && launches[next]!.at < now + TICK_MINUTES) {
      const launch = launches[next]!;
      next += 1;
      result.launches += 1;
      const usage = accounts.flatMap((account) => account.reading ? [account.reading] : []);
      const chooseFirstEligible = () => accounts.find((account) => {
        const outcome = selectBalancedAccount({ accounts: definitions.filter((definition) => definition.id === account.id), usage, now: now * MINUTE });
        return outcome.status !== "none";
      });
      let chosen: SimAccount | undefined;
      const outcomeFor = (freshForMs: number, readings: readonly SubscriptionUsageSnapshot[], among = definitions) =>
        selectBalancedAccount({ accounts: among, usage: readings, now: now * MINUTE, freshForMs });
      // One denominator for every rule: launches where more than one account is eligible on the readings
      // Wollipog holds. A rule that compared only some of them still counts as having compared.
      const contested = outcomeFor(BALANCE_FRESH_AFTER_MS, usage).candidates.filter((candidate) => candidate.eligible).length >= 2;
      if (contested) result.contested += 1;
      const record = (outcome: ReturnType<typeof selectBalancedAccount>) => {
        if (!contested || outcome.status === "none") return;
        if (outcome.status === "no_safe_choice") result.noSafeChoice += 1;
        else if (outcome.basis === "scored") result.compared += 1;
      };
      const pick = (id: string) => accounts.find((account) => account.id === id);

      if (policy === "priority") {
        chosen = chooseFirstEligible();
      } else if (policy === "round_robin") {
        const eligible = outcomeFor(BALANCE_FRESH_AFTER_MS, usage).candidates.filter((candidate) => candidate.eligible);
        const last = accounts.findIndex((account) => account.id === lastChosen);
        chosen = [...accounts.slice(last + 1), ...accounts.slice(0, last + 1)].find((account) => eligible.some((candidate) => candidate.accountId === account.id));
      } else if (policy === "most_remaining") {
        const eligible = outcomeFor(Number.POSITIVE_INFINITY, usage).candidates.filter((candidate) => candidate.eligible);
        const tightest = (account: SimAccount) => account.reading
          ? Math.min(...account.reading.buckets.filter((bucket) => (bucket.resetsAt ?? Infinity) > now * MINUTE).map((bucket) => bucket.remainingPercent ?? 100), 100)
          : 100;
        chosen = accounts.filter((account) => eligible.some((candidate) => candidate.accountId === account.id))
          .reduce<SimAccount | undefined>((best, account) => !best || tightest(account) > tightest(best) ? account : best, undefined);
      } else if (policy === "oracle_edf") {
        const open = accounts.filter((account) => !exhausted(account));
        const roomy = open.filter((account) => account.weeklyUsed / account.units < 0.9);
        chosen = (roomy.length ? roomy : open).reduce<SimAccount | undefined>((best, account) =>
          !best || account.weeklyResetAt < best.weeklyResetAt ? account : best, undefined);
      } else if (policy === "oracle" || policy === "oracle_urgent" || policy === "oracle_patient") {
        const outcome = selectBalancedAccount({ accounts: definitions, usage: accounts.map((account) => readNow(account, now)), now: now * MINUTE,
          freshForMs: Number.POSITIVE_INFINITY, halfUrgencyMs: (policy === "oracle_urgent" ? 4 : policy === "oracle_patient" ? 96 : 24) * 60 * MINUTE });
        record(outcome);
        if (outcome.status === "selected") chosen = pick(outcome.accountId);
      } else if (policy === "codex_refresh") {
        for (const account of accounts) account.reading = readNow(account, now);
        result.probes += accounts.length;
        const outcome = outcomeFor(BALANCE_FRESH_AFTER_MS, accounts.map((account) => account.reading!));
        record(outcome);
        if (outcome.status === "selected") chosen = pick(outcome.accountId);
      } else if (policy === "strict_fresh") {
        const outcome = outcomeFor(BALANCE_FRESH_AFTER_MS, usage);
        record(outcome);
        // A person would choose here, or an unattended launch would refuse. Priority Order stands in for that choice.
        chosen = outcome.status === "selected" ? pick(outcome.accountId) : outcome.status === "no_safe_choice" ? chooseFirstEligible() : undefined;
      } else if (policy === "known_only") {
        const fresh = definitions.filter((definition) => usage.some((snapshot) => snapshot.providerAccountId === definition.id &&
          now * MINUTE - snapshot.fetchedAt <= BALANCE_FRESH_AFTER_MS));
        const outcome = fresh.length ? outcomeFor(BALANCE_FRESH_AFTER_MS, usage, fresh) : null;
        if (outcome) record(outcome);
        chosen = outcome?.status === "selected" ? pick(outcome.accountId) : chooseFirstEligible();
      } else {
        const unread = accounts.find((account) => !account.reading);
        const outcome = outcomeFor(Number.POSITIVE_INFINITY, usage, unread ? definitions.filter((definition) => accounts.find((account) => account.id === definition.id)!.reading) : definitions);
        if (unread) chosen = unread;
        else {
          record(outcome);
          chosen = outcome.status === "selected" ? pick(outcome.accountId) : undefined;
        }
      }

      const units = launch.minutes * burnPerMinute;
      demanded += units;
      if (!chosen) continue;
      lastChosen = chosen.id;
      if (exhausted(chosen)) {
        result.startedExhausted += 1;
        chosen.reading = readNow(chosen, now);
        continue;
      }
      running.push({ account: chosen, endsAt: launch.at + launch.minutes });
    }

    for (let index = running.length - 1; index >= 0; index -= 1) {
      const session = running[index]!;
      if (session.endsAt <= now) { running.splice(index, 1); continue; }
      if (exhausted(session.account)) {
        result.interruptions += 1;
        session.account.reading = readNow(session.account, now);
        running.splice(index, 1);
        continue;
      }
      const units = burnPerMinute * TICK_MINUTES;
      spend(session.account, units, now);
      served += units;
      // Every response in a session carries a reading of that account.
      session.account.reading = readNow(session.account, now);
    }
  }
  result.unservedShare = demanded > 0 ? Math.max(0, 1 - served / demanded) : 0;
  result.wastedShare = offered > 0 ? wasted / offered : 0;
  return result;
}

export function averageBalance(scenario: BalanceScenario, policy: BalancePolicy, seeds: number): BalanceResult {
  const total: BalanceResult = { launches: 0, contested: 0, compared: 0, noSafeChoice: 0, startedExhausted: 0, interruptions: 0, unservedShare: 0, wastedShare: 0, probes: 0 };
  for (let seed = 1; seed <= seeds; seed += 1) {
    const run = simulateBalance(scenario, policy, seed);
    for (const key of Object.keys(total) as Array<keyof BalanceResult>) total[key] += run[key];
  }
  for (const key of Object.keys(total) as Array<keyof BalanceResult>) total[key] /= seeds;
  return total;
}
