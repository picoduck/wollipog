# Browser CI Budget

The browser job retains five shards and a finite **40-minute** budget. A recovered
dependency-install timeout and a passing suite exhausted the previous 25-minute
budget in [PR #2694's run 37478932815, attempt 1](https://github.com/picoduck/wollipog/actions/runs/37478932815/job/112321655661).
The annotation says the job exceeded `25m0s`; all 377 tests passed in 17.9 minutes.
The unchanged-head retry passed in 16m20s, and its matching merge group passed.
This is one verified margin failure, not a deterministic browser failure or a
documentation regression. General frequency and the mirror's root cause were not
established. [Issue #2700](https://github.com/picoduck/wollipog/issues/2700) tracks
the implementation and the remaining natural-run evidence.

## Phase Evidence

[The identified timing fixture](../scripts/fixtures/browser-ci-timings.json)
contains 36 independent jobs measured on 2026-10-06: all five jobs of the original
PR attempt, only the genuinely rerun shard from attempt 2, 25 jobs from five
successful first-attempt main-push or merge-group runs, and all five jobs of the
current-main push `37489739075`. Successful jobs carried forward by a failed-job
rerun are not fresh measurements.

Durations are seconds, derived from GitHub's public job and step metadata:

- **Queue:** job `created_at` to `started_at`. Keep it separate from active time;
  it does not consume the job budget. It includes scheduling wait, without
  attributing that wait to a specific scheduler cause.
- **Active:** job `started_at` to `completed_at`.
- **First Install / Retry:** elapsed time of each executed Playwright install
  step. The first timeout's REST conclusion is `success` due to
  `continue-on-error`; its explicit timeout annotation/log and executed retry
  establish the failed outcome.
- **Other Setup:** job start to browser-suite start minus elapsed first install
  and retry. This includes all pre-suite steps **and gaps between them**.
- **Suite:** elapsed remote-instance browser test step.
- **Production:** elapsed production build and browser smoke steps, intentionally
  shard-1-only. Their skips on other shards are normal.
- **Cleanup:** remaining active time after setup, installs, suite and production,
  including gaps, post steps and job finalization. It is a residual, not a claim
  that GitHub attributes every second to a named cleanup step.
- **Non-Install:** other setup + suite + production + cleanup; equivalently active
  minus elapsed first install and retry. Queue is excluded.

The source failure's phases reconcile as `372 + 14 + 40 + 1075 + 0 + 4 = 1505`.
Its first install exceeded the configured 360 seconds by 12 seconds. The 14-second
retry succeeded, and the tests passed just as the job limit was reached.

The original docs-head workload differs from the current-main baseline in ten
e2e files. All five shards were therefore measured again at actual baseline
`97dd322c312ff315a651cfa6af5e5229fdcc181d`, rather than relying only on older jobs.
Its e2e/config Git-tree fingerprint is
`6c296375752a7c52bed4f431c03dfca5624c4440ba46c773ad99130ca3c294d0`.
The current-main push phases are:

| Shard | Queue | Active | First Install | Retry | Other Setup | Suite | Production | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | 893 | 19 | 0 | 22 | 820 | 28 | 4 |
| 2 | 219 | 1061 | 17 | 0 | 35 | 1001 | 0 | 8 |
| 3 | 2 | 1075 | 19 | 0 | 26 | 1025 | 0 | 5 |
| 4 | 65 | 966 | 26 | 0 | 26 | 910 | 0 | 4 |
| 5 | 275 | 1406 | 27 | 0 | 26 | 1350 | 0 | 3 |

The five successful main/group sample runs' maximum non-install remainder was
1419 seconds. The original PR's passing shard 5 supplies a slower 1448-second
envelope, which is retained. Current matching-group shard 1's 1415-second remainder
includes 44 seconds of production checks. No phase is removed to make the budget
fit, and the separate maxima are not claimed to have occurred simultaneously.

## Finite Sizing Equation

The active install path is either the cached-browser **system-dependency** path
or the cache-miss **browser-with-dependencies** path. Each has two six-minute
attempts; count the first and retry of the active path, not both exclusive paths.
All sampled installs used the cache-hit path. There is no measured cold-cache
sample here: cold setup is conservatively accounted from its configured bounds,
not from invented successful timings. A second failed attempt still fails the job.

| Allowance | Seconds | Basis |
| --- | --- | --- |
| Active Install Attempts | 720 | Two configured six-minute attempts. |
| Non-Install Work | 1450 | Measured maximum 1448, rounded upward. |
| Timeout Enforcement | 30 | 15 per attempt, above the observed 12-second overrun. |
| Required Reserve | 180 | At least three minutes of whole-job margin. |
| Total | 2380 | 39m40s; the 2400-second job limit adds 20s rounding slack. |

The modeled residual reserve is 200 seconds. Enforcement overhead can vary on
hosted runners; 15 seconds per attempt is an explicit sizing assumption, not a
guarantee. The three-minute reserve and natural observations add evidence but
cannot guarantee every future runner. Remeasure after workload or setup changes.

This revisits the old below-thirty goal: its 16.3-minute envelope is stale, and
30, 35 or 39 minutes cannot cover the current conservative equation. Forty stays
finite, beneath the repository's general 60-minute workflow ceiling, so hung or
doubled workloads still fail loudly. It is not permission to grow the budget
without new measurements and review.

More shards or workers could reduce suite duration, but require file-duration
profiling and concurrency verification. System-package caching could improve
common setup, but cannot remove cache-miss/fallback accounting. Neither is changed
by this focused fix; all assertions, scheduling, retries, cleanup and aggregation
remain intact.

## Regression Checks and Delivery Evidence

`scripts/workflow-browser-budget.test.mjs` derives attempt allowances from both
actual workflow paths and the remainder from the identified phase fixture. It
rejects reduced budgets, longer first or retry limits on either path, omitted
production/cleanup and inconsistent phase accounting. It verifies queue exclusion
and full-run shard coverage alongside the existing matrix/denominator contract.

Inert temporary command stubs execute the unchanged Ubuntu retry shell and verify
cleanup/repair ordering, successful recovery and propagation of second-install
or dpkg-repair failure. An expression model confirms failed **outcome** triggers
retry despite successful **conclusion**, while success or cancellation does not.
No real apt commands, process signals, network, hosted stalls or timing sleeps
are needed. Near-bound setup plus each measured remainder is an arithmetic replay,
not evidence that those maxima occurred together on a hosted runner.

Local checks and one passing PR/merge group do **not** complete issue #2700.
Delivery requires **five consecutive naturally occurring complete main or
merge-group CI runs** containing this change, every shard successful with at least
three minutes of actual margin (`active <= 2220s` at the 40-minute limit). Observe
after merge if necessary; do not manufacture stalls, dispatch runs or rerun
unrelated work to build the sample.

For each observed integration, retain its event, attempt, exact head and workflow,
all five job ids and phase timings, required aggregation, and active margin.
Report incomplete or superseded runs explicitly; they cannot count as successes.
A completed failed or cancelled qualifying integration breaks the streak. When
completeness is ambiguous, use the stricter interpretation and reset the streak.
If integration changes the workload, repeat and reconcile the baseline before
counting it as delivery evidence. The issue stays open while any criterion is
outstanding, even after the implementation merges.
