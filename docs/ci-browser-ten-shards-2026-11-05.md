# Ten-Shard Chromium Evaluation

Refs #3628. Candidate evaluation; measured ten-shard performance and the final
budget reconciliation are pending. This does not activate a merge-group fast gate
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

The first measurement retains the historical 75-minute cap provisionally. Before
delivery, replace that historical five-shard sizing floor with actual ten-shard
coherent non-install phases; include production, setup, cleanup, both bounded
install attempts on the exclusive path, cache phases, timeout enforcement,
failure diagnostics and reserve. Do not derive a smaller cap by dividing a
historical maximum by two.

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

## Rollback

Revert the eventual delivery commit through a reviewed PR and the ordinary merge
queue. Revert workflow matrix, projects, observer inventory and budget together;
retain dated evidence as history. No repository-setting rollback is needed.
No activation or setting changes are authorized by this evaluation.
