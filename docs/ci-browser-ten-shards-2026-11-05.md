# Ten-Shard Chromium Evaluation

Refs #3628. First candidate measurement and phase budget are recorded below;
passing exact-head CI and natural merge-group validation remain pending. This does not activate a merge-group fast gate
or change repository settings.

## Refreshed Profile

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
53 minutes, derived below from actual ten-shard phases including production,
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

## Measured Phase Budget

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

## Rollback

Revert the eventual delivery commit through a reviewed PR and the ordinary merge
queue. Revert workflow matrix, projects, observer inventory and budget together;
retain dated evidence as history. No repository-setting rollback is needed.
No activation or setting changes are authorized by this evaluation.
