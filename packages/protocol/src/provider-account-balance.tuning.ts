import { averageBalance, type BalancePolicy, type BalanceScenario } from "./provider-account-balance.simulation.js";
const policies: BalancePolicy[] = ["priority", "round_robin", "most_remaining", "last_known", "oracle", "oracle_urgent", "oracle_patient", "oracle_edf"];
const plans: Record<string, readonly number[]> = { "2 equal": [100, 100], "3 equal": [100, 100, 100], "3 unequal": [100, 100, 500], "4 equal": [100, 100, 100, 100] };
const profiles = ["solo", "parallel", "campaign"] as const;
const pct = (value: number) => `${(value * 100).toFixed(1).padStart(5)}%`;
const seeds = Number(process.argv[2] ?? 16);
const run = (title: string, scenarioFor: (profile: typeof profiles[number], planUnits: readonly number[]) => BalanceScenario) => {
  console.log(title);
  for (const policy of policies) {
    let unserved = 0; let wasted = 0; let n = 0;
    for (const profile of profiles) for (const planUnits of Object.values(plans)) {
      const result = averageBalance(scenarioFor(profile, planUnits), policy, seeds);
      unserved += result.unservedShare; wasted += result.wastedShare; n += 1;
    }
    console.log(`  ${policy.padEnd(15)} unserved ${pct(unserved / n)}  wasted ${pct(wasted / n)}`);
  }
};
run("## Default model: 95% load, 5% external, five-hour share 20%", (profile, planUnits) => ({ planUnits, profile, load: 0.95, externalShare: 0.05 }));
run("## Weekly binds, five-hour never does: reset-awareness's best case (95% load, 0 external, share 100%)", (profile, planUnits) => ({ planUnits, profile, load: 0.95, externalShare: 0, fiveHourShare: 1 }));
run("## Same, at 120% load", (profile, planUnits) => ({ planUnits, profile, load: 1.2, externalShare: 0, fiveHourShare: 1 }));
run("## Same, at 70% load", (profile, planUnits) => ({ planUnits, profile, load: 0.7, externalShare: 0, fiveHourShare: 1 }));
