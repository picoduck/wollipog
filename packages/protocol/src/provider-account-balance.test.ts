import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAccountDefinition, SubscriptionUsageBucket, SubscriptionUsageSnapshot } from "./index.js";
import { BALANCE_FRESH_AFTER_MS, scoreProviderAccountUsage, selectBalancedAccount, type BalanceOutcome } from "./provider-account-balance.js";
import { averageBalance, simulateBalance, type BalancePolicy, type BalanceScenario } from "./provider-account-balance.simulation.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const account = (id: string, overrides: Partial<ProviderAccountDefinition> = {}): ProviderAccountDefinition => ({
  id, label: id, provider: "claude", authStatus: "authenticated", billing: "subscription", ...overrides,
});
const weekly = (remaining: number, resetsIn: number): SubscriptionUsageBucket => ({
  id: "seven_day", label: "Weekly", usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: NOW + resetsIn, windowDurationMinutes: 7 * 24 * 60,
});
const fiveHour = (remaining: number, resetsIn: number): SubscriptionUsageBucket => ({
  id: "five_hour", label: "Five-Hour", usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: NOW + resetsIn, windowDurationMinutes: 300,
});
const reading = (id: string, buckets: SubscriptionUsageBucket[], overrides: Partial<SubscriptionUsageSnapshot> = {}): SubscriptionUsageSnapshot => ({
  sourceId: id, runnerId: "r", agentId: "a", provider: "claude", state: "available", fetchedAt: NOW - 60_000, providerAccountId: id, buckets, ...overrides,
});
const select = (accounts: ProviderAccountDefinition[], usage: SubscriptionUsageSnapshot[], freshForMs?: number) =>
  selectBalancedAccount({ accounts, usage, now: NOW, ...(freshForMs === undefined ? {} : { freshForMs }) });
const chosen = (outcome: BalanceOutcome) => outcome.status === "selected" ? outcome.accountId : outcome.status;

test("less remaining allowance wins on a nearer reset", () => {
  const outcome = select([account("plenty"), account("soon")], [
    reading("plenty", [weekly(80, 5 * DAY)]),
    reading("soon", [weekly(40, 3 * HOUR)]),
  ]);
  assert.equal(chosen(outcome), "soon");
  assert.equal(outcome.status === "selected" && outcome.basis, "scored");
  // A distant reset leaves remaining allowance to decide.
  assert.equal(chosen(select([account("more"), account("less")], [reading("more", [weekly(80, 5 * DAY)]), reading("less", [weekly(40, 5 * DAY)])])), "more");
  // Scarcity beats urgency once the near reset has little left to lose.
  assert.equal(chosen(select([account("plenty"), account("soon")], [reading("plenty", [weekly(90, 2 * DAY)]), reading("soon", [weekly(12, 3 * HOUR)])])), "plenty");
});

test("an imminent short window nudges but doesn't outweigh a longer window", () => {
  // Otherwise equal, the account whose five-hour allowance is about to come back goes first.
  assert.equal(chosen(select([account("later"), account("imminent")], [
    reading("later", [weekly(50, 2 * DAY), fiveHour(90, 4.5 * HOUR)]),
    reading("imminent", [weekly(50, 2 * DAY), fiveHour(90, 0.5 * HOUR)]),
  ])), "imminent");
  // A five-hour reset doesn't make up for a week's allowance that's far off and smaller.
  assert.equal(chosen(select([account("weekly-soon"), account("five-soon")], [
    reading("weekly-soon", [weekly(50, 6 * HOUR)]),
    reading("five-soon", [weekly(30, 5 * DAY), fiveHour(100, 0.2 * HOUR)]),
  ])), "weekly-soon");
});

test("a low-headroom longer window goes last, however close another of its resets is", () => {
  const usage = [
    reading("trap", [weekly(4, 3 * DAY), fiveHour(100, 0.1 * HOUR)]),
    reading("steady", [weekly(35, 6 * DAY)]),
  ];
  assert.equal(chosen(select([account("trap"), account("steady")], usage)), "steady");
  const scored = scoreProviderAccountUsage(usage[0], NOW);
  assert.deepEqual(scored.scored && [scored.lowHeadroom, scored.headroomPercent], [true, 4]);
  // Low headroom that's about to come back isn't low: that's the use-it-or-lose-it case itself.
  const resetting = scoreProviderAccountUsage(reading("resetting", [weekly(4, 0.5 * HOUR)]), NOW);
  assert.equal(resetting.scored && resetting.lowHeadroom, false);
  // A low-headroom account still beats having nothing, and nothing else was eligible to prefer.
  assert.equal(chosen(select([account("trap"), account("trap2")], [reading("trap", [weekly(4, 3 * DAY)]), reading("trap2", [weekly(9, 3 * DAY)])])), "trap2");
});

test("exhaustion, spend controls, sign-in, access, context, billing and cooldowns all outrank any score", () => {
  // Each of these would score far above the plain account if it reached scoring at all.
  const tempting = [weekly(99, 1.5 * HOUR)];
  const usage = (id: string, overrides: Partial<SubscriptionUsageSnapshot> = {}, buckets = tempting) => reading(id, buckets, overrides);
  const plain = reading("plain", [weekly(5, 6 * DAY)]);
  const cases: Array<[string, ProviderAccountDefinition, SubscriptionUsageSnapshot, string]> = [
    ["a used-up window", account("x"), usage("x", {}, [...tempting, { ...fiveHour(0, 2 * HOUR), status: "exhausted" }]), "usage_exhausted"],
    ["a reached spend control", account("x"), usage("x", { spendControls: [{ id: "s", label: "Spend", reached: true, resetsAt: NOW + DAY }] }), "spend_limit_reached"],
    ["a signed-out account", account("x", { authStatus: "unauthenticated" }), usage("x"), "signed_out"],
    ["another server's account", account("x", { profile: { access: "not_granted" } as ProviderAccountDefinition["profile"] }), usage("x"), "access_not_granted"],
    ["API billing", account("x", { billing: "api" }), usage("x"), "api_billing"],
    ["a cooldown", account("x", { selectionCooldownUntil: NOW + HOUR }), usage("x"), "cooldown"],
  ];
  for (const [name, candidate, snapshot, reason] of cases) {
    const outcome = select([candidate, account("plain")], [snapshot, plain]);
    assert.equal(chosen(outcome), "plain", name);
    assert.equal(outcome.candidates.find((item) => item.accountId === "x")?.eligible, false, name);
    assert.equal((outcome.candidates.find((item) => item.accountId === "x") as { reason?: string }).reason, reason, name);
  }
  // A context this agent can't run in, through the agent's own readiness.
  const outcome = selectBalancedAccount({
    accounts: [account("x"), account("plain")], usage: [usage("x"), plain], now: NOW,
    agent: { providerAccountReadiness: { defaultAuthStatus: "authenticated", readyAccountIds: ["plain"] } },
  });
  assert.equal(chosen(outcome), "plain");
  // Extra usage is never allowance to protect, and never blocks a score.
  const overage = reading("o", [weekly(50, DAY), { id: "overage", label: "Extra Usage", status: "available" }]);
  assert.equal(scoreProviderAccountUsage(overage, NOW).scored, true);
});

test("stale, missing and partial readings can't be scored, and block the comparison rather than losing it", () => {
  const good = reading("good", [weekly(40, 3 * HOUR)]);
  const cases: Array<[string, SubscriptionUsageSnapshot | undefined, string]> = [
    ["no reading", undefined, "no_reading"],
    ["a reading that hasn't arrived", reading("x", [], { state: "unavailable" }), "no_reading"],
    ["an old reading", reading("x", [weekly(90, DAY)], { fetchedAt: NOW - BALANCE_FRESH_AFTER_MS - 1 }), "stale"],
    ["status and reset only", reading("x", [{ id: "five_hour", label: "Five-Hour", resetsAt: NOW + HOUR, status: "available" }]), "no_utilization"],
    ["no reset", reading("x", [{ id: "seven_day", label: "Weekly", usedPercent: 10 }]), "no_reset"],
    ["an unknown window length", reading("x", [{ id: "mystery", label: "Mystery", usedPercent: 10, resetsAt: NOW + DAY }]), "no_duration"],
    ["one partial window beside a good one", reading("x", [weekly(90, DAY), { id: "seven_day_opus", label: "Opus", resetsAt: NOW + DAY }]), "no_utilization"],
  ];
  for (const [name, usage, reason] of cases) {
    const outcome = select([account("x"), account("good")], usage ? [usage, good] : [good]);
    assert.equal(outcome.status, "no_safe_choice", name);
    assert.deepEqual(outcome.status === "no_safe_choice" && outcome.unknown, [reason], name);
    // An unknown account stays eligible: only a positive reading of a limit ever removes one.
    assert.equal(outcome.candidates.find((item) => item.accountId === "x")?.eligible, true, name);
  }
  // Nothing to compare needs no scoring, whatever the reading says.
  const alone = select([account("x")], []);
  assert.equal(alone.status === "selected" && alone.basis, "only_eligible");
  assert.equal(select([], []).status, "none");
});

test("a window whose reset has passed comes back instead of counting against its account", () => {
  const passed = reading("x", [weekly(5, -HOUR), fiveHour(3, -DAY)]);
  const scored = scoreProviderAccountUsage(passed, NOW);
  assert.equal(scored.scored && scored.lowHeadroom, false);
  const partlyPassed = scoreProviderAccountUsage(reading("x", [weekly(70, 2 * DAY), fiveHour(1, -HOUR)]), NOW);
  assert.equal(partlyPassed.scored && partlyPassed.lowHeadroom, false);
});

test("per-model weekly windows bind at their tightest, and known ids supply their length", () => {
  const usage = reading("x", [
    { id: "seven_day", label: "Weekly", usedPercent: 20, resetsAt: NOW + 2 * DAY },
    { id: "seven_day_opus", label: "Opus", usedPercent: 95, resetsAt: NOW + 2 * DAY },
  ]);
  const scored = scoreProviderAccountUsage(usage, NOW);
  assert.equal(scored.scored && scored.lowHeadroom, true);
  assert.equal(scored.scored && scored.headroomPercent, 5);
});

test("percentages across unequal plans are a heuristic: a small plan can win on the same numbers", () => {
  // Scoring sees no plan size, and no reliable multiplier exists, so 40% of a small plan and 40% of one five
  // times its size tie, and the caller's order decides. The UI must not call this available capacity.
  const outcome = select([account("small"), account("large")], [reading("small", [weekly(40, DAY)], { plan: "pro" }), reading("large", [weekly(40, DAY)], { plan: "max_5x" })]);
  assert.equal(chosen(outcome), "small");
});

test("the rule is deterministic for one input", () => {
  const usage = [reading("a", [weekly(40, DAY)]), reading("b", [weekly(41, DAY + 1)])];
  assert.deepEqual(select([account("a"), account("b")], usage), select([account("a"), account("b")], usage));
});

const SEEDS = 6;
const scenarios: BalanceScenario[] = (["solo", "parallel", "campaign"] as const).flatMap((profile) =>
  [[100, 100], [100, 100, 100], [100, 100, 500]].map((planUnits) => ({ planUnits, profile, load: 0.95, externalShare: 0.05 })));
const across = (policy: BalancePolicy, pick: (run: ReturnType<typeof averageBalance>) => number) =>
  scenarios.reduce((sum, scenario) => sum + pick(averageBalance(scenario, policy, SEEDS)), 0) / scenarios.length;

test("simulation: a fresh-only rule almost never has a safe choice, because idle accounts are unknown", () => {
  const rate = (scenario: BalanceScenario) => {
    const run = averageBalance(scenario, "strict_fresh", SEEDS);
    return run.contested ? run.compared / run.contested : 0;
  };
  // One person's sessions in turn: every other account is idle, so nothing is ever comparable.
  assert.equal(rate({ planUnits: [100, 100, 100], profile: "solo", load: 0.95, externalShare: 0.05 }), 0);
  assert.ok(across("strict_fresh", (run) => run.noSafeChoice / run.contested) > 0.75, "most contested launches find no safe choice");
  // With a probe at every launch the comparison always works, which is the Codex-only route.
  // (Short of exactly 100% only when the probe itself finds an account used up, leaving one eligible.)
  assert.ok(across("codex_refresh", (run) => run.compared / run.contested) > 0.99);
});

test("simulation: comparing only what has fresh numbers keeps spending the busy account", () => {
  const priority = across("priority", (run) => run.unservedShare);
  const knownOnly = across("known_only", (run) => run.unservedShare);
  const oracle = across("oracle", (run) => run.unservedShare);
  assert.ok(knownOnly > oracle + 0.02, `known_only ${knownOnly} should stay well short of oracle ${oracle}`);
  assert.ok(Math.abs(knownOnly - priority) < Math.abs(priority - oracle), "it buys less than half of what scoring could");
});

test("simulation: scoring reduces lost allowance at load, and a probe at each launch reaches the best case", () => {
  const measure = (policy: BalancePolicy) => across(policy, (run) => run.wastedShare);
  assert.ok(measure("oracle") < measure("priority"), "scoring beats a fixed order when every account is known");
  assert.ok(measure("last_known") < measure("priority"), "last-known readings capture part of that");
  assert.ok(measure("oracle") <= measure("last_known"));
  assert.ok(Math.abs(measure("codex_refresh") - measure("oracle")) < 1e-9, "a true reading at launch is the oracle");
});

test("simulation: invisible outside use erodes last-known scoring without making it worse than a fixed order", () => {
  const scenario = (externalShare: number): BalanceScenario => ({ planUnits: [100, 100, 100], profile: "parallel", load: 0.95, externalShare });
  const gap = (externalShare: number) => averageBalance(scenario(externalShare), "last_known", SEEDS).unservedShare -
    averageBalance(scenario(externalShare), "oracle", SEEDS).unservedShare;
  assert.ok(averageBalance(scenario(0.4), "last_known", SEEDS).unservedShare <= averageBalance(scenario(0.4), "priority", SEEDS).unservedShare + 0.01);
  assert.ok(gap(0) >= 0 && gap(0.4) > -0.05);
});

test("simulation: the same seed gives the same result", () => {
  const scenario = scenarios[1]!;
  assert.deepEqual(simulateBalance(scenario, "last_known", 7), simulateBalance(scenario, "last_known", 7));
});
