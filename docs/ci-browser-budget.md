# Browser CI Budget

The browser job retains five shards and a finite **59-minute** budget. The
2026-10-18 remeasurement replaces the stale 1,448-second non-install envelope with
2,016 seconds. The prior 49-minute limit cannot reserve three minutes beyond the
configured attempts, measured remainder, enforcement and failure diagnostics.
[Issue #2700](https://github.com/picoduck/wollipog/issues/2700) stays open until
post-change natural-run evidence is complete.

## Phase Evidence

[The identified fixture](../scripts/fixtures/browser-ci-timings.json) retains the
36 historical jobs from 2026-10-06, including the original recovered-install
failure (run 37478932815, attempt 1, shard 4). Its first install took 372 seconds
against a 360-second deadline; its 14-second retry succeeded and 377 tests passed,
but the job exhausted 25 minutes. Only shard 4 was actually rerun in attempt 2;
carried-forward successes are not independent measurements.

The refresh adds 25 jobs: the five most recently created successful, complete,
first-attempt natural main-push or merge-group runs available at
2026-10-18T17:15:00Z. Cancelled run 39145208011 is explicitly excluded. Four newer
runs were incomplete at that cutoff: main pushes 39148645626 and 39146876130,
and merge groups 39145913020 and 39144938863. Their first attempts' last jobs
completed at 17:35:06Z, 17:18:15Z, 17:49:23Z and 17:26:38Z respectively; those
later read-only observations are recorded separately from status at the cutoff.
This sizing sample is not a consecutive post-change delivery streak. No CI was dispatched,
rerun or cancelled to collect evidence. Latest baseline:
`b697f9c60a4d1d248f7662d667b69ec1d6fc63b6` (run 39142667230).
Each recent `completeRunAttempts` entry records head, event, creation time,
workflow conclusion and a workload fingerprint: SHA-256 of
`git ls-tree -r HEAD -- apps/web/e2e playwright.config.ts playwright.production.config.ts playwright.ports.ts`
at that run's head. All five shards of each selected workload are measured.
These fingerprints identify the measured workloads; they are provenance data,
not a pre-merge requirement that a future tree match an earlier measurement.

Durations below are seconds from read-only Actions job/step metadata:

- **Queue:** job `created_at` to `started_at`, excluded from the active budget.
- **Active:** job `started_at` to `completed_at`.
- **Install / Retry:** elapsed executed Playwright install steps. Cache-hit/miss
  paths are exclusive. A timed-out first attempt can have REST conclusion
  `success` due to `continue-on-error`; outcome and timeout annotations establish
  recovery, not that conclusion alone.
- **Other Setup:** job start to suite start minus install/retry, including gaps.
- **Suite:** remote-instance browser test step.
- **Production:** production build and smoke steps, intentionally shard-1-only.
- **Cleanup:** residual active time after the above, including gaps, post steps
  and finalization; not a named cleanup-step measurement.
- **Non-Install:** other setup + suite + production + cleanup, or active minus
  elapsed install and retry. Every fixture row reconciles both ways.

| Run | Shard | Queue | Active | Install | Retry | Other Setup | Suite | Production | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 39142667230 | 1 | 1697 | 1381 | 14 | 0 | 20 | 1266 | 78 | 3 |
| 39142667230 | 2 | 2133 | 1214 | 14 | 0 | 21 | 1176 | 0 | 3 |
| 39142667230 | 3 | 1798 | 1588 | 12 | 0 | 19 | 1555 | 0 | 2 |
| 39142667230 | 4 | 1635 | 1916 | 12 | 0 | 24 | 1876 | 0 | 4 |
| 39142667230 | 5 | 627 | 2023 | 12 | 0 | 21 | 1987 | 0 | 3 |
| 39142428503 | 1 | 730 | 1089 | 12 | 0 | 18 | 994 | 62 | 3 |
| 39142428503 | 2 | 163 | 1652 | 12 | 0 | 25 | 1612 | 0 | 3 |
| 39142428503 | 3 | 215 | 1597 | 12 | 0 | 22 | 1560 | 0 | 3 |
| 39142428503 | 4 | 2 | 1893 | 12 | 0 | 22 | 1856 | 0 | 3 |
| 39142428503 | 5 | 441 | 2030 | 14 | 0 | 22 | 1992 | 0 | 2 |
| 39141574932 | 1 | 31 | 1454 | 19 | 0 | 22 | 1332 | 77 | 4 |
| 39141574932 | 2 | 11 | 1545 | 15 | 0 | 19 | 1508 | 0 | 3 |
| 39141574932 | 3 | 355 | 1594 | 11 | 0 | 23 | 1557 | 0 | 3 |
| 39141574932 | 4 | 421 | 1928 | 18 | 0 | 24 | 1884 | 0 | 2 |
| 39141574932 | 5 | 461 | 2013 | 11 | 0 | 23 | 1976 | 0 | 3 |
| 39138757428 | 1 | 2144 | 1744 | 13 | 0 | 20 | 1612 | 97 | 2 |
| 39138757428 | 2 | 1992 | 1741 | 10 | 0 | 22 | 1706 | 0 | 3 |
| 39138757428 | 3 | 2072 | 1346 | 17 | 0 | 23 | 1302 | 0 | 4 |
| 39138757428 | 4 | 259 | 1881 | 11 | 0 | 21 | 1847 | 0 | 2 |
| 39138757428 | 5 | 2142 | 1766 | 17 | 0 | 26 | 1719 | 0 | 4 |
| 39135469681 | 1 | 3168 | 1624 | 12 | 0 | 20 | 1498 | 92 | 2 |
| 39135469681 | 2 | 2178 | 1741 | 11 | 0 | 21 | 1707 | 0 | 2 |
| 39135469681 | 3 | 1799 | 1595 | 12 | 0 | 19 | 1562 | 0 | 2 |
| 39135469681 | 4 | 2670 | 1792 | 13 | 0 | 22 | 1755 | 0 | 2 |
| 39135469681 | 5 | 1857 | 1433 | 12 | 0 | 20 | 1398 | 0 | 3 |

Per-shard non-install maxima (1–5): **1731 / 1731 / 1585 / 1910 / 2016 seconds**.
The maximum grew 568 seconds from the old 1448-second envelope. Separate maxima
are conservative sizing inputs, not a simultaneously observed worst case. All
fresh installs used the warm-cache system-dependency path, without retries.
Production checks and cleanup remain included.

## Finite Sizing Equation

| Allowance | Seconds | Basis |
| --- | --- | --- |
| Active Install Attempts | 720 | Two configured six-minute attempts on either exclusive path. |
| Non-Install Work | 2020 | Fresh maximum 2016, rounded upward to ten seconds. |
| Timeout Enforcement | 105 | 15 per install attempt and diagnostic step, above the observed 12-second overrun. |
| Failure Diagnostics | 480 | Sanitization/upload: one minute each; linux baseline regeneration: four minutes; upload/summary: one minute each. All five skip on success. |
| Required Reserve | 180 | Three minutes beyond the full modeled path. |
| Total | 3505 | 58m25s; rounded up to 59m (3540s). |

`720 + 2020 + 105 + 480 + 180 = 3505 <= 3540`. Residual modeled reserve is
**215 seconds** after installs, rounded remainder, enforcement and diagnostics.
At 49 minutes that residual would be **-385 seconds**. Even the success-only path
needs `720 + 2020 + 30 + 180 = 2950` seconds, above 49 minutes.

Count the cache-hit **or** cache-miss path, not both. A second failed attempt still
fails. Cold-cache installation and post-job cache save remain unmeasured; attempt
bounds cover installation, while cache save consumes reserve and has no separate
step deadline. The 15-second enforcement assumption is not a hosted-runner
guarantee. Inert recovery fixtures execute the retry shell with stubs, no real
apt/dpkg commands, process signals, network or sleeps. Arithmetic near-bound
replay is not simultaneous worst-case hosted evidence. The remainder is a dated
snapshot; use natural-run phases and margins to assess workload/setup changes
and trigger remeasurement, rather than treating the snapshot as a runtime guarantee.

The limit remains below the general 60-minute workflow ceiling. The same five
concurrent browser jobs perform unchanged normal execution work. A hang can hold
each runner ten minutes longer than at 49 minutes. Adding shards competes for
more of the shared 20-job pool; rebalancing five needs per-file/test durations
and a fresh all-shard baseline before justifying a smaller budget. Assertions,
coverage, flaky handling, test retries, setup recovery, admission, cancellation,
permissions, rulesets and required-check semantics are preserved.

## Before and After Margin

The replay below applies both limits to identical observed jobs; these are
**not post-change measurements**. Natural integrations must supply actual after
times. The configuration change does not shorten normal execution.

| Run | Active Seconds, Shards 1–5 | Spare at 49m | Replayed Spare at 59m |
| --- | --- | --- | --- |
| [39142667230](https://github.com/picoduck/wollipog/actions/runs/39142667230) | 1381 / 1214 / 1588 / 1916 / 2023 | 1559 / 1726 / 1352 / 1024 / 917 | 2159 / 2326 / 1952 / 1624 / 1517 |
| [39142428503](https://github.com/picoduck/wollipog/actions/runs/39142428503) | 1089 / 1652 / 1597 / 1893 / 2030 | 1851 / 1288 / 1343 / 1047 / 910 | 2451 / 1888 / 1943 / 1647 / 1510 |
| [39141574932](https://github.com/picoduck/wollipog/actions/runs/39141574932) | 1454 / 1545 / 1594 / 1928 / 2013 | 1486 / 1395 / 1346 / 1012 / 927 | 2086 / 1995 / 1946 / 1612 / 1527 |
| [39138757428](https://github.com/picoduck/wollipog/actions/runs/39138757428) | 1744 / 1741 / 1346 / 1881 / 1766 | 1196 / 1199 / 1594 / 1059 / 1174 | 1796 / 1799 / 2194 / 1659 / 1774 |
| [39135469681](https://github.com/picoduck/wollipog/actions/runs/39135469681) | 1624 / 1741 / 1595 / 1792 / 1433 | 1316 / 1199 / 1345 / 1148 / 1507 | 1916 / 1799 / 1945 / 1748 / 2107 |

The separate [runner-wait report](merge-queue-wait.md), over
2026-10-16T17:15:00Z–2026-10-18T17:15:00Z, measured 129 completed merge groups
without truncation. Longest runner wait: median **41.85**, p90 **104.37**, max
**145.45 minutes**. Critical-path execution: **27.82 / 32.70 / 72.00 minutes**;
longest job execution: **31.82 / 33.72 / 71.93 minutes**. This broader window
includes failed runs. Queue wait is excluded from the active budget. No queue
improvement or satisfaction of #2674's separate target is claimed.

Repeat over a comparable post-merge window without creating traffic:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs --repo picoduck/wollipog \
  --since <merge-time-UTC> --until <48-hours-after-merge-UTC> --json
```

## Regression Checks and Delivery Evidence

`scripts/workflow-browser-budget.test.mjs` derives both attempt paths and diagnostic
allowances from the workflow, and the remainder from the fixture. It rejects
tested reduced budgets through 58 minutes, longer attempts on either path,
omitted production/cleanup, inconsistent sums, and missing or duplicated full-run
shards. These checks catch lost modeled reserve and inconsistent shard coverage;
they do not predict the duration of future workloads or require a Git checkout.
Queue-only changes cannot alter the equation. The
existing contract pins matrix/denominator agreement. Inert shell checks retain
successful recovery, apt/dpkg cleanup order, and second-install/repair failure
propagation; success and cancellation do not trigger retry.

The 2016-second measured remainder is a dated snapshot. Natural-run margin
evidence triggers remeasurement: collect the five consecutive complete runs
below, retaining phase timings and at least 180 seconds spare on every shard.
If a shard loses that margin, remeasure all five shards and revisit the finite
budget or distribution using those observations. A pre-merge exact tree-hash
gate would block new e2e work before its natural integration measurements exist;
authors must not edit a provenance hash to imply a measurement that never happened.

Local checks and PR/merge-group CI do not complete #2700. Observe **five consecutive
naturally occurring complete main or merge-group runs containing this change**,
all five browser shards successful with at least 180 seconds spare:
`active <= 3360s` at 59 minutes. Read exact first-attempt metadata for each run:

```sh
gh api repos/picoduck/wollipog/actions/runs/<run-id>
gh api 'repos/picoduck/wollipog/actions/runs/<run-id>/attempts/1/jobs?per_page=100' --paginate
```

Retain event, attempt, head/workflow, all five job ids and phases, required
aggregation and margin. A complete failed/cancelled qualifying run breaks the
streak; incomplete/superseded runs cannot count. Reset if completeness is
ambiguous. Remeasure if the integrated workload changes. PR runs and pre-change
sizing samples cannot count. The issue stays open until all criteria have evidence.

The separate obsolete-merge-group monitor still stops after 35 minutes or 35
polls. A near-budget job plus queue wait can outlive it; it fails safely by
retaining CI. Its deadlines and the queue's outer response window are unchanged.
