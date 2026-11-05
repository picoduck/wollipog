# Ten-Shard Chromium Evaluation

Refs #3628. Two candidate measurements and a phase budget are recorded below;
passing exact-head CI and natural merge-group validation remain pending. This does not activate a merge-group fast gate
or change repository settings.

## Initial Profile: November 4 Source

This historical starting profile was replaced by the two-run refresh below.

Source: passing natural full PR run
[41920725615](https://github.com/picoduck/wollipog/actions/runs/41920725615),
attempt 1, head `f9e6a702e9753af844cbe20c85949cc7bee95a06`, tested merge
`eefbc3ebc32d7d3ed4f7aee586c1d4feb6cbda98`. UTC half-open observation window
**[2026-11-04T21:56:29Z, 2026-11-04T22:31:55Z)**. Denominator: five executed
Chromium jobs in one passing PR, not five independent runs. The earlier
[routing measurement](ci-pr-browser-measurements-2026-11-04.md) independently
records this run with no missing execution or timestamp-conflict allocation.
No CI traffic was created to refresh this profile.

| Shard | Job ID | Suite Seconds | Production Seconds | Other Setup | Install | Cleanup |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 126892194460 | 1869 | 102 | 46 | 7 | 4 |
| 2 | 126892194214 | 2045 | 0 | 53 | 11 | 5 |
| 3 | 126892194487 | 1931 | 0 | 29 | 6 | 3 |
| 4 | 126892194400 | 2071 | 0 | 32 | 6 | 3 |
| 5 | 126892194141 | 1614 | 0 | 36 | 7 | 4 |

Times are API step seconds. Other setup and cleanup include gaps; production is
build plus smoke, sequential on shard 1. Queue wait is excluded. The safe
reporter projection supplies 100 measured whole-file weights (top 20 per shard).
The tested tree has 307 discovered file candidates; the remaining 207 receive
`ceil((9530000 - sum(measured file milliseconds)) / 207) = 14558ms`.
This residual includes test-runner overhead and is an estimate, not a measurement
of each remaining file. Hashes resolve against the tested tree, not today's main.
The fixture retains safe source context, test counts, hashes and phase arithmetic.

At implementation base `511f65bba18c2d650dfd3b676d02ef06169e48aa`, live discovery
contains 311 file candidates. New files receive the residual estimate automatically.
The ten estimated loads, including production once, are 969.009 / 971.193 /
971.167 / 966.506 / 957.306 / 971.580 / 971.508 / 971.537 / 971.730 / 968.753
seconds. These are forecasts, not hosted measurements. A roughly 16.2-minute
forecast plus setup makes the 15–20-minute target plausible but unproven.
Production's 102 seconds does not itself bound the forecast path, so it remains
on shard 1, preloaded in the balancing algorithm.

## Coverage and Measurement Gates

The candidate uses ten whole-file projects, one worker each, fullyParallel false,
strict independent ports, no reuse, failOnFlakyTests and unchanged sanitized
diagnostics. Inventory tests compare actual Playwright discovery identities to
the matrix and assert intact files, automatic additions, production, WebKit and
conditional Windows routes. Reduced PRs must still select exactly one browser
job; full PRs, merge groups, dispatch and rolling validation need all ten.

The first measurement used the historical 75-minute cap. The candidate now uses
54 minutes, derived below from actual ten-shard phases including production,
setup, cleanup, both bounded install attempts on the exclusive path, cache
phases, timeout enforcement, failure diagnostics and reserve.

Use this PR's full CI and at most three additional branch dispatches, without
pushing while a measurement is active. Record every run and job ID, UTC window,
execution, runner wait, timestamp conflicts, required-result latency and elapsed
runner-minutes. Compare to the November 2 five-shard cohort with its documented
workload/era limitations. Increased peak Chromium fan-out is ten versus five
standard jobs (+5); total execution work is retained, with five extra setup paths.
Elapsed runner-minutes are not billed usage or a dollar estimate. Measure the
extra setup cost and Node critical-path bound rather than assuming linear gains.
Natural merge-group results are required after enqueue and actual merge.

The timing collector accepts `--all-events --browser-shards 10` for an explicitly
bounded ten-shard window. It records the expectation with each attempt; offline
reprojection preserves it. Without the option it retains the historical five-shard
expectation. Do not apply a current inventory to old runs or infer completeness
from the highest job number observed. Rolling validation takes its expected set
from the shared shard-count module, guarded against the actual workflow matrix
and Playwright discovery. Main-health checks use job names rather than five-shard
array positions; historical five-job rolling runs remain uncertified under the
new current inventory until a complete current run is observed.

## First Complete Browser Sample

Source [42054331358](https://github.com/picoduck/wollipog/actions/runs/42054331358),
attempt 1, PR head `69a3ccc4a3d9bc535f29551edb522cba77146928`, tested merge
`4a65869bbd681ce445e79e9046e343a374be5525`. UTC half-open window
**[2026-11-05T15:22:33Z, 2026-11-05T16:04:38Z)**. Denominator: one natural PR
with ten passing Chromium jobs and passing WebKit, inside a **failing workflow**.
The [safe export](ci-browser-ten-shards-2026-11-05.json) records job clocks,
phases and reporter projections. Zero missing execution or #4046 timestamp
conflicts; no guessed offset or imputed zero.

| Shard | Job ID | Active Seconds | Runner Wait | Suite | Production | Non-Install |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 127342213609 | 1072 | 1066 | 929 | 105 | 1066 |
| 2 | 127342213669 | 811 | 413 | 763 | 0 | 805 |
| 3 | 127342213238 | 1117 | 82 | 1076 | 0 | 1112 |
| 4 | 127342213499 | 753 | 688 | 717 | 0 | 748 |
| 5 | 127342213224 | 926 | 387 | 887 | 0 | 920 |
| 6 | 127342213564 | 1073 | 990 | 1033 | 0 | 1068 |
| 7 | 127342213427 | 1114 | 757 | 998 | 0 | 1108 |
| 8 | 127342213582 | 1082 | 893 | 1040 | 0 | 1076 |
| 9 | 127342213289 | 1092 | 176 | 1039 | 0 | 1083 |
| 10 | 127342213547 | 725 | 704 | 689 | 0 | 720 |

All table values are seconds from API clocks in the same window, one job per row.
Longest/median uses the collector's nearest-rank median: **1.0420**;
longest/shortest **1.5407**. Chromium consumption **162.75 runner-minutes**;
including WebKit **164.3833**. Complete browser path **41.8667 minutes**.
Maximum Chromium active **18.6167 minutes** (shard 3), minimum **12.0833**
(shard 10). Browser execution reaches the target here; end-to-end latency does
not. Production is included once. Windows comparison correctly skipped, which
is not new runtime coverage of Windows.

Protected result job **127362748454** failed after **42.05 minutes**. The inferred
critical chain is PR Suite Routing → shard 1 → aggregator: **18.1333 minutes
execution / 23.9167 residual delay**. Residual includes runner waits and upstream
gaps; it is not one job's runner wait. Routing job **127338472292** waited
**5.9833 minutes** and ran **13 seconds**. Maximum individual wait **17.7667m**
belongs to shard 1, created after routing. Run creation to shard start is about
24m and must not be mislabeled as that job's runner wait. All-workflow elapsed
consumption is **205.4667 runner-minutes**, not billed usage or dollar cost.

Node jobs **127342213046 / 127342213084 / 127342213137** failed. Their logs
identify positional certification/fixture assumptions in the rehearsal forge,
admission-evidence and release certification; shard 2's readiness report fails
through that forge. Commit `b01433b9b` fixes these, and affected local tests pass.
Safe browser projections total **4124 attempts (151 skips), zero failed or
retry-only**, including production's 55. No install retries occurred. One workflow
failure out of one is a candidate defect, not a population failure/flake estimate.

## Comparison, Contention and Alternatives

The [November 2 baseline](ci-browser-shards-2026-11-02.md) has 242 coherent
passing five-shard groups: maximum active p50/p90 **35.98/38.02m**, complete
browser path **36.77/51.18m**, longest/median **1.080/1.297**, Chromium sum
**159.68/172.05 runner-minutes**, maximum runner wait **0.05/18.27m**. This
candidate's longest active is 17.36m below that median; browser completion is
5.10m above it. Chromium minutes are 3.07 (+1.92%) above the median. Workloads,
demand and outcomes differ: these are descriptive comparisons, not causal
evidence or a passing-queue result. No dollar saving is claimed.

Against profile PR 41920725615, setup/install/cleanup sum rises from **252s**
to **489s**: **237s / 3.95 extra runner-minutes**. Suite plus production falls
from 9632s to 9276s, so Chromium elapsed falls from 164.7333m to 162.75m.
Timing variation can exceed setup cost; this is not proof of less execution work.

Potential fan-out grows from 11 to 16 non-advisory work jobs (three Node, checks,
delegated recovery, WebKit, five/ten Chromium; conditional Windows independent).
This run actually peaked at ten simultaneous executing jobs. A repository census
of the same creation window used 45 API calls: 201 runs / 224 jobs, nine copied
jobs removed, 11 unfinished runs omitted from job collection, no pagination
truncation or detected timing conflicts. Its complete source is in the safe export.
Observed cohort peak running was **34**, running-plus-demand **69**, mean running
**22.3663**, mean queued **18.0321**. Occupancy is a lower bound: pre-window
creations and unfinished runs are absent. This cannot establish organization-wide
saturation of the owner's 60-job Team allowance or a scheduler defect. Extra
fan-out adds demand, but one observation cannot prove it caused the residual delay.

Retain ten for the next sample without competing self-dispatch. Even an ideal
eight-way division of the observed 9276s suite/production total is **19.325m**
before setup and file imbalance; the profile forecast is approximately 20m before
setup. That trades execution margin for two fewer allocations without a measured
queue benefit. Splitting production adds another setup/allocation to remove only
105s from shard 1; shard 3's 18.62m path remains. Neither alternative is yet
supported as better. Revisit if repeated natural queue evidence misses the target.
Extra dispatches used: **0/3**.

## First-Sample Phase Budget (Superseded)

All ten coherent phases are in the
[sizing fixture](../scripts/fixtures/browser-ci-ten-shard-timings.json).
Maximum non-install **1112s**, job **127342213238**, rounds upward to **1120s**.
Retain configured 720s exclusive-path install attempts, 480s cache/verification,
180s enforcement, 480s failure diagnostics and 180s reserve:
`720 + 1120 + 480 + 180 + 480 + 180 = 3160s`.
The smallest whole-minute cap is **53m (3180s)**, retaining **200s** after the
modeled non-reserve phases. This replaces the five-shard 2460s floor/75m cap;
historical observations stay unchanged. WebKit remains 29m, Windows 25m.
Queue wait is excluded. Observed cache-hit installs were 5–9s without retry;
cold-path bounds are allowances, not new cold-cache measurements. One passing
browser set supplies sizing evidence; later coherent workload/setup changes can
require recalculation. #2700's separate natural margin streak remains incomplete.

## Successful Repeat and One-Time Weight Refresh

Source [42063471740](https://github.com/picoduck/wollipog/actions/runs/42063471740),
attempt 1, head `09accc26210f98eb975774e971ee721b6b3d457a`, tested merge
`8979d3695f440a3dd5854e687a4de50e55b28722`. UTC half-open window
**[2026-11-05T16:20:52Z, 2026-11-05T16:44:55Z)**. Denominator: one passing
natural full PR, all ten Chromium jobs, WebKit, all Node jobs and the required
aggregate successful. Windows comparison skipped through the retained diff
detector. Optional Platform Isolation has no sample here; no platform speedup
or runtime coverage is inferred from absence. The safe export contains both runs.

| Shard | Job ID | Active Seconds | Runner Wait | Suite | Production | Non-Install |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 127371354431 | 881 | 286 | 749 | 85 | 875 |
| 2 | 127371354565 | 1003 | 237 | 960 | 0 | 997 |
| 3 | 127371354382 | 1153 | 257 | 1104 | 0 | 1147 |
| 4 | 127371354386 | 979 | 267 | 927 | 0 | 971 |
| 5 | 127371354308 | 1031 | 129 | 988 | 0 | 1025 |
| 6 | 127371354153 | 1110 | 109 | 1058 | 0 | 1105 |
| 7 | 127371354283 | 1034 | 163 | 995 | 0 | 1029 |
| 8 | 127371354345 | 1142 | 220 | 1094 | 0 | 1136 |
| 9 | 127371354276 | 975 | 158 | 858 | 0 | 955 |
| 10 | 127371354169 | 1045 | 145 | 1002 | 0 | 1039 |

Each table cell is seconds from one API job/step in the same window. No missing
execution or timestamp-conflict allocation. Safe browser projections again total
**4124 attempts / 151 skips / zero failed or retry-only**, including 55 production
attempts; no install retry. One passing workflow out of the two observed PRs
does not estimate population reliability; the first failed on corrected fixtures.

Maximum active **19.2167m**, longest/median **1.1183**, longest/shortest **1.3087**,
Chromium **172.55 runner-minutes**, Chromium plus WebKit **174.45**;
complete browser path **23.90m**. Required result **127385965491** passed at
**24.00m**, with **19.4833m execution / 4.5167m residual delay** on the inferred
routing → shard 3 → aggregate chain. Maximum individual runner wait **4.7667m**;
routing **127371098999** waited 11s and ran 13s. Total elapsed runner usage
**211.4833m**; setup/install/cleanup in Chromium **533s**, versus first sample
489s and five-shard profile source 252s. Against the November 2 passing-group
median, execution is 16.76m shorter, complete browser path 12.87m shorter and
Chromium consumption 12.87 runner-minutes (+8.06%) higher. Different workloads,
setup and demand prevent a causal or billing claim. Neither PR proves the
15–20m end-to-end queue target. Node job 127371354430 took 13.2m; Chromium still
bounds execution here. Wait dominated sample one but not this repeat.

Shard 3 is slowest twice, with shard 8 also near the tail; other shards vary
substantially (for example shard 10 moves from 12.08m to 17.42m). To improve
the evidence rather than tune individual anomalies, the final candidate refreshes
all weights once from **both** complete samples. Their e2e trees have no diff.
The top 20 safe file timings per shard yield **202 unique measured files** and
20 source jobs (two run attempts, not 20 independent workloads). For each file,
use the upward-rounded mean of its observed durations. Four files appear in just
one top-20 projection, so their weights have one observation; no missing duration
is imputed as zero. For 109 remaining files, residual estimate is
`ceil((mean complete suite milliseconds - sum measured file weights) / 109)`
= **9347ms**. Reporter censoring and runner overhead remain limitations.
Production's mean build/smoke is **95s**, preloaded once on shard 1.

The model's complete suite-plus-production mean is **9548.062s** after residual
rounding. New per-shard loads are **950.891 / 950.998 / 958.313 / 958.349 /
958.205 / 950.954 / 950.895 / 960.002 / 958.421 / 951.034 seconds**.
Longest/median forecast **1.0094**, maximum **16.0000m**, excluding setup.
This does not claim an observed 16-minute run or a guaranteed queue result.
Final-head CI and the natural merge group must validate this redistribution.
All whole-file isolation, live discovery and coverage contracts stay intact.
No extra dispatch is used; two natural PR runs have consumed **416.95 elapsed
runner-minutes** total, including the failed first attempt. No dollar cost is
available. Review rounds 1–2 cost **$1.6764212**; further review is pending.

## Current Measured Budget

Across 20 coherent Chromium jobs, maximum non-install **1147s** is job
**127371354382**. Retain that observed floor after refreshing assignments, rather
than shrinking it to the forecast. Upward rounding gives **1150s**:
`720 + 1150 + 480 + 180 + 480 + 180 = 3190s <= 3240s`.
The current cap is **54 minutes**, with **230s** residual reserve. This supersedes
the first sample's 53m proposal. It retains all configured setup, timeout,
diagnostic and reserve allowances, and includes production/setup/cleanup.
It excludes queue wait and unmeasured allocation. Cold paths and #2700's margin
streak remain unproven; subsequent actual phases may require reconciliation.

## Rollback

Revert the eventual delivery commit through a reviewed PR and the ordinary merge
queue. Revert workflow matrix, projects, observer inventory and budget together;
retain dated evidence as history. No repository-setting rollback is needed.
No activation or setting changes are authorized by this evaluation.
