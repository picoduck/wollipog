import { averageBalance, type BalancePolicy, type BalanceScenario } from "./provider-account-balance.simulation.js";

const policies: BalancePolicy[] = ["priority", "round_robin", "most_remaining", "strict_fresh", "known_only", "last_known", "oracle"];
const plans: Record<string, readonly number[]> = { "2 equal": [100, 100], "3 equal": [100, 100, 100], "3 unequal": [100, 100, 500], "4 equal": [100, 100, 100, 100] };
const profiles = ["solo", "parallel", "campaign"] as const;
const pct = (value: number) => `${(value * 100).toFixed(1).padStart(5)}%`;
const seeds = Number(process.argv[2] ?? 20);

console.log("## Compared every eligible account (share of launches with 2+ eligible; 95% load, 5% external)");
for (const profile of profiles) {
  for (const [name, planUnits] of Object.entries(plans)) {
    const scenario: BalanceScenario = { planUnits, profile, load: 0.95, externalShare: 0.05 };
    const cells = (["strict_fresh", "known_only", "last_known", "codex_refresh"] as const).map((policy) => {
      const run = averageBalance(scenario, policy, seeds);
      return `${policy}=${pct(run.contested ? run.compared / run.contested : 0)}`;
    });
    const base = averageBalance(scenario, "strict_fresh", seeds);
    console.log(`${profile.padEnd(9)} ${name.padEnd(10)} contested=${pct(base.contested / base.launches)} launches/4wk=${String(Math.round(base.launches)).padStart(4)}  ${cells.join("  ")}`);
  }
}

console.log("\n## strict_fresh across load (no-safe-choice share of contested launches, all plans)");
for (const profile of profiles) {
  const cells = [0.3, 0.5, 0.8, 0.95, 1.2].map((load) => {
    let safe = 0; let contested = 0;
    for (const planUnits of Object.values(plans)) {
      const run = averageBalance({ planUnits, profile, load, externalShare: 0.05 }, "strict_fresh", seeds);
      safe += run.noSafeChoice; contested += run.contested;
    }
    return `load ${load}: ${pct(contested ? safe / contested : 0)}`;
  });
  console.log(`${profile.padEnd(9)} ${cells.join("  ")}`);
}

const outcomes = (scenarioFor: (profile: typeof profiles[number], planUnits: readonly number[]) => BalanceScenario, chosen = policies) => {
  for (const policy of chosen) {
    const totals = { unserved: 0, wasted: 0, interruptions: 0, started: 0, launches: 0, n: 0 };
    for (const profile of profiles) {
      for (const planUnits of Object.values(plans)) {
        const run = averageBalance(scenarioFor(profile, planUnits), policy, seeds);
        totals.unserved += run.unservedShare; totals.wasted += run.wastedShare;
        totals.interruptions += run.interruptions; totals.started += run.startedExhausted; totals.launches += run.launches; totals.n += 1;
      }
    }
    console.log(`  ${policy.padEnd(14)} unserved ${pct(totals.unserved / totals.n)}  wasted ${pct(totals.wasted / totals.n)}  interrupted/launch ${pct(totals.interruptions / totals.launches)}  startedExhausted/launch ${pct(totals.started / totals.launches)}`);
  }
};

console.log("\n## Outcomes by load (all plans and profiles, 5% external)");
for (const load of [0.5, 0.8, 0.95, 1.2]) {
  console.log(`load ${load}`);
  outcomes((profile, planUnits) => ({ planUnits, profile, load, externalShare: 0.05 }));
}

console.log("\n## Sensitivity: five-hour window's share of a week (95% load)");
for (const fiveHourShare of [0.1, 0.2, 0.4]) {
  console.log(`five-hour share ${fiveHourShare}`);
  outcomes((profile, planUnits) => ({ planUnits, profile, load: 0.95, externalShare: 0.05, fiveHourShare }), ["priority", "round_robin", "most_remaining", "last_known", "oracle"]);
}

console.log("\n## External use (95% load, all plans and profiles)");
for (const externalShare of [0, 0.05, 0.2, 0.4]) {
  console.log(`external ${externalShare}`);
  outcomes((profile, planUnits) => ({ planUnits, profile, load: 0.95, externalShare }), ["priority", "round_robin", "last_known", "oracle"]);
}

console.log("\n## By profile at 95% load, 5% external (all plans)");
for (const profile of profiles) {
  console.log(profile);
  for (const policy of policies) {
    let unserved = 0; let wasted = 0; let n = 0;
    for (const planUnits of Object.values(plans)) {
      const run = averageBalance({ planUnits, profile, load: 0.95, externalShare: 0.05 }, policy, seeds);
      unserved += run.unservedShare; wasted += run.wastedShare; n += 1;
    }
    console.log(`  ${policy.padEnd(14)} unserved ${pct(unserved / n)}  wasted ${pct(wasted / n)}`);
  }
}
console.log("\n## Unequal plans only (100, 100, 500) at 95% load");
for (const profile of profiles) {
  console.log(profile);
  for (const policy of policies) {
    const run = averageBalance({ planUnits: [100, 100, 500], profile, load: 0.95, externalShare: 0.05 }, policy, seeds);
    console.log(`  ${policy.padEnd(14)} unserved ${pct(run.unservedShare)}  wasted ${pct(run.wastedShare)}`);
  }
}
