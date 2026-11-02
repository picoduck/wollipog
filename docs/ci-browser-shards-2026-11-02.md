# Browser Shard Natural-Run Measurement: November 2, 2026

Refs #3628. Collected read-only on November 2 against main
`1b756ed11dad081d9b5fb32894477a32d15c9de7`. No traffic, reruns, cancellations,
settings changes or additional runners were generated. This records the first
post-merge natural traffic, not current-main performance or causal attribution.

## Cohort and Reproduction

Half-open UTC creation windows:

- A: [2026-10-23T21:02:55Z, 2026-10-24T02:50:17Z), from #3644's merge to #3650's merge.
- B: [2026-10-24T02:50:17Z, 2026-10-24T12:00:00Z), after the cache merge.

The [safe metadata export](ci-browser-shards-2026-11-02.json) preserves exact
run/attempt/job IDs, SHAs, phases, outcomes and selected bounded reporter counts.
It contains 19 first attempts and two reruns. Every event listing, attempt and
job listing was complete within ten pages of 100 and ten attempts per run;
queue histories were not truncated. These are deliberately short windows to
bound shared API use. Creation windows select runs, not their finish timestamps.
No later November performance claim is made. Historical main pushes here predate
the rolling-main cutover; current main evidence must come from rolling workers.

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events --since 2026-10-23T21:02:55Z \
  --until 2026-10-24T02:50:17Z --json > a.json
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events --since 2026-10-24T02:50:17Z \
  --until 2026-10-24T12:00:00Z --json > b.json
node scripts/merge-queue-wait-report.mjs --input a.json --input b.json --json
node scripts/ci-reliability-report.mjs --input docs/ci-browser-shards-2026-11-02.json
```

Reporter extraction uses exported `readTimingLog` / `applyTimingContext` from
the same collector and `ci-timing.mjs` validation, for the five Chromium jobs of
40069935046 and 40058408892 only (ten log reads). No raw logs are retained.
Equivalent CLI collection supplies their job IDs with `--timing-job`, at most ten
per invocation. IDs are in the export. Counts must match run/attempt context;
missing projections elsewhere remain unmeasured, never zero failures.

## Complete Passing Observations

Only first attempts with all five Chromium jobs passing and measured enter this
table; all five also have passing workflows. Times are elapsed minutes, not
billed minutes. Chromium active includes setup, development, shard-1 production
build/smoke, gaps and finalization. Path is creation to the last Chromium job's
completion; active max excludes runner wait. Total includes five Chromium jobs;
WebKit is separately shown. Conditional Windows execution is skipped in all five
runs, not measured as a fast pass.

| Run | Event / Window | Longest/Median | Longest/Shortest | Max Active | Complete Path | Chromium Runner-Minutes | Shard Wait Range (s) | WebKit Active |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [40032371317](https://github.com/picoduck/wollipog/actions/runs/40032371317) | Group / A | 1.1435 | 1.6256 | 37.850 | 37.900 | 160.833 | 1–2 | 0.967 |
| [40053514536](https://github.com/picoduck/wollipog/actions/runs/40053514536) | Group / A, Cache Candidate | 1.0464 | 1.2192 | 33.100 | 33.133 | 152.500 | 2 | 0.983 |
| [40058408892](https://github.com/picoduck/wollipog/actions/runs/40058408892) | Group / B | 1.0250 | 1.3789 | 32.750 | 32.783 | 147.867 | 1 | 0.983 |
| [40056011289](https://github.com/picoduck/wollipog/actions/runs/40056011289) | PR / B | 1.0136 | 1.1766 | 32.200 | 32.233 | 152.050 | 1–2 | 1.267 |
| [40069935046](https://github.com/picoduck/wollipog/actions/runs/40069935046) | PR / B | 1.0508 | 1.2584 | 28.250 | 28.283 | 129.817 | 1–2 | 1.083 |

For a broader browser definition including WebKit, add the last column to the
Chromium total: 161.800 / 153.483 / 148.850 / 153.317 / 130.900 minutes.
WebKit completes before Chromium in all five, so it does not extend their paths.
Production remains sequential on shard 1 and is already included, not added twice.
Shard-1 production build/smoke seconds, in table order: 34/49, 32/48, 26/43,
40/55, 32/47. Same-named production validation on the Node job is excluded
from this browser accounting.

Against the [October 22 baseline](ci-baseline-2026-10-22.md), passing groups'
longest/shortest median is 1.379 here (n=3), versus 1.54 (n=65).
Group longest active median is 33.10 minutes; every shard in two of three groups
finishes sooner than the old shard-5 median 35.1 minutes. One remains 37.85
minutes, including 603 seconds of install attempts on shard 1. This is evidence
of an observed reduction and improved balance in this small cohort, not a
sustained or causal performance guarantee. The compact baseline preserves
longest/shortest, not enough job durations to reconstruct longest/median or a
browser-only sum; those comparisons remain unavailable. Baseline 173.0/185.3
runner-minute p50/p90 covers *all jobs* in 73 completely measured groups, so it
cannot be compared directly to this table's browser-only totals.

The source profile in [ci-browser-shards.md](ci-browser-shards.md) spans attempts
of one run; its 1665.186s predicted maximum (27.753m), 1.0013 predicted ratio and
8305s modeled development-plus-production sum exclude setup. The natural complete
jobs remain slower than that forecast. The last pre-merge PR observation
40007510456 had max 33.65m, ratio 1.0197 and Chromium sum 162.533m. Here the two
PR observations have lower maxima/sums, but this is different traffic and code.
Keep measured whole-file weights: no single reliably overloaded shard is
established by these variable observations; changing weights now would overfit.

## Reliability, Wait and Confounders

Counts below are first-attempt workflow states, not test failure counts.

| Window / Event | First | Passing | Failing | Cancelled | Skipped | Unfinished | Unmeasured |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A / PR | 6 | 0 | 2 | 1 | 3 | 0 | 0 |
| A / Group | 4 | 2 | 2 | 0 | 0 | 0 | 0 |
| A / Historical Main Push | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| B / PR | 4 | 2 | 0 | 0 | 2 | 0 | 0 |
| B / Group | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| B / Historical Main Push | 2 | 2 | 0 | 0 | 0 | 0 | 0 |

A PR failure fraction is 2/6 over all first attempts, or 2/3 terminal admitted
non-cancelled attempts; B is 0/4 or 0/2 respectively. Group failure fractions
are 2/4 in A and 0/1 in B. Reruns 40029165955/2 and 40024026119/2 both recover
failing PR first attempts at unchanged heads: retry-only run fraction 2/10 PR
first attempts across A+B (2/2 observed reruns). There are no group reruns;
new merge-group IDs are independent run outcomes, not hidden rerun attempts.
Do not interpret recovery as proof of flaky tests. Rerun resource/wait metrics
remain unmeasured because successful jobs can be copied. Cancelled and skipped
work are excluded from passing performance comparisons.

Baseline first PR failures were 8/175, group failures 6/75, and six retry-only
recoveries among 175 PR first attempts (seven reruns). Small samples, installer
incidents and different cohorts prevent claiming a reliability improvement here.
The selected safe projections for each of 40069935046 and 40058408892 reconcile
3675 development attempts (129 skipped), plus 55 production attempts: zero failed,
cancelled, unmeasured or retry-only attempts. Other runs' within-test retry rates
are unmeasured. These counts are not a population zero-flake rate.

The cache boundary is code-dependent, not just chronological: #3650's PR and
merge-group candidates in A already contain the package cache and 68/29-minute
limits. Uncached group 40032371317 used a 372s first install plus 231s successful
retry on shard 1; cache-candidate group 40053514536 used 5–7s first installs and
no retries. Group 40058408892 used 5–10s and no retries. These are executed step
durations, not independently verified exact package-cache hit/zero-download
claims. Browser binary cache and apt package cache are different. See #3649 for
cache-path validation; do not attribute all setup variation to redistribution.

Bounded independent occupancy check, [2026-10-24T03:00:00Z,
2026-10-24T04:00:00Z), used `scripts/ci-runner-occupancy.mjs --repo
picoduck/wollipog --since ... --until ... --cache <private-dir> --json`, then
offline `--input`. Five API calls, no pagination truncation: 18 runs, 13 jobs,
205 measured runner-minutes, peak running/demand eight, mean running 3.4, zero
observed time at the 20-job ceiling and zero queued job-minutes. This one-hour
repository observation does not establish organization-wide spare capacity.
The passing table's 1–2s shard waits contrast with baseline group shard wait
medians 0.6–1.8 minutes; demand and scheduling differ, so no causal wait gain.

Later rolling-main routing, runner-contention work and v2/v3 candidates are
outside these early windows. Extrapolating this report to current main would
require a new comparable rolling-worker cohort and workload reconciliation.

## Budget Reconciliation and Acceptance

The five freshly reread jobs of successful natural #3644 group 40018244256
(window [2026-10-23T20:18:00Z, 2026-10-23T20:19:00Z)) now extend
`scripts/fixtures/browser-ci-timings.json`. Non-install seconds for shards 1–5
are 2078 / 1895 / 1916 / 1980 / 1975. Shard 1 includes 1944s development,
45s production build and 62s production smoke; setup/cleanup/gaps supply the
remainder. Post-merge A+B passing-shard maximum is 2063s (job 120698410785),
so the earlier 2078s remains the sizing maximum. Failed work cannot tighten it.

Round 2078 upward to 2080s. Retaining every configured setup/diagnostic bound:
`720 + 2080 + 480 + 180 + 480 + 180 = 4120s`. The current 68-minute cap is
40s short of that full model; the old pre-cache 59-minute model was 23s short
using unrounded 2078s. The smallest whole-minute cap that reconciles the measured
floor is **69 minutes (4140s)**, with 200s residual reserve. This increases only
the hang ceiling by one minute; it does not improve normal latency. WebKit stays
29 minutes. The budget test rejects 68 minutes and longer bounded setup phases.
This is arithmetic sizing, not a claim of a simultaneous hosted worst-case pass.
The #2700 natural streak and current workload remeasurement remain independent.

Acceptance disposition for this measurement change:

1. Timing profile: previously delivered by #3644; unchanged, with constraints recorded.
2. Natural-run measurement: delivered for identified PR/groups, with observed lower
   complete paths and balance in a small cohort. Sustained causality is unproved;
   baseline browser-only totals and historical test retries are unavailable.
3. Coverage: existing contracts retained; all five file projects, production,
   independent WebKit and conditional Windows routes remain intact. Skipped Windows
   execution is not new runtime evidence.
4. Isolation/diagnostics: no changes to serial fixtures, workers, ports, ownership,
   failOnFlakyTests or sanitization.
5. Budget: measured floor and derived cap reconciled in this draft change; delivery
   to main still requires review, exact-head CI, ready slot and actual merge.
