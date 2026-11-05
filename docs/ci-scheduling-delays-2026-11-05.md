# CI Scheduling Delays: November 5, 2026

Refs #2674. Read-only history investigation at `511f65bba18c2d650dfd3b676d02ef06169e48aa`,
using the merged #4046 `timingQuality` classifier. No workflow was dispatched, rerun or cancelled;
no workflow, runner, plan, variable, ruleset or merge-queue setting was changed.

The four complete post-Team-upgrade days have **no observed `checks_timed_out` removal**.
Merge-group required-result p90 is **40.65 minutes**, versus the historical trial's 65.9 minutes.
Execution remains the main measured component: median critical-path step execution is 36.83
minutes. This cohort misses both campaign targets: roughly 15-minute PR checks and 15–20-minute
queue validation. It predates PR browser-routing activation and the ten-shard experiment, so it
cannot assess their gains. Aggregator runner waits still reach 6m12s in merge groups and 11m03s
on PRs; they should remain visible even though they no longer exhaust this cohort's queue window.

## Cohort and Evidence

The [sanitized JSON export](ci-scheduling-delays-2026-11-05.json) contains exact run/attempt IDs,
SHAs, job IDs, timestamps, per-step timestamps for identified critical paths and conflicted jobs,
other job IDs, all observed removal identities and denominators. It omits logs, runner and actor
identities, branch names and test names. Every time below is UTC; every window is half-open.

| Window | PR First Attempts | Merge-Group First Attempts | All Attempts Including Reruns |
| --- | ---: | ---: | ---: |
| [2026-10-30 00:00, 2026-10-31 00:00) | 108 | 50 | 162 |
| [2026-11-02 00:00, 2026-11-03 00:00) | 107 | 55 | 169 |
| [2026-11-03 00:00, 2026-11-04 00:00) | 109 | 46 | 164 |
| [2026-11-04 00:00, 2026-11-05 00:00) | 61 | 45 | 109 |
| Total | 385 | 196 | 604 |

The collector also queried main-push CI: there were zero runs in these windows. There are 581
first attempts and 23 rerun attempts. Rerun copies are retained as identities, excluded from wait
and execution distributions. All run, attempt, job and removal pagination completed without
truncation. Collection finished at 2026-11-05T15:11:40Z.

October 29 is excluded as the upgrade transition day; its provisional cutover readback was
2026-10-29T14:53:07Z. November 1's one-hour clock pattern is outside this working-day cohort.
November 5 is excluded entirely: routing activated at **2026-11-05T14:55:12Z**, a new boundary.
The four-day cohort does not replace the five-day cohort originally proposed on #2674.

## Partition and Denominators

The offline `scripts/ci-scheduling-delays.mjs` consumes version-2 reports from the existing
collector. It reuses the existing dependency/critical-path model and #4046 classifier:

- **Runner wait:** job `created_at` to `started_at`, only for first attempts with execution
  evidence and no clock conflict. Dependency waiting before job creation is separate.
- **Step execution:** union of non-skipped executed step intervals, including setup and test
  steps. Overlapping steps count once. This is step wall time, not CPU time or test-only time.
- **Finalization:** last executed step end to job `completed_at`, only when clocks pass #4046.
  This is an observed API gap; it does not identify an internal GitHub service or cause.
- **Runner overhead:** the remaining job interval before/between steps. **Scheduling gap** is
  required-result wall time minus measured critical-job intervals and runner waits. Neither is
  relabelled as test execution or runner queue wait.
- **Unmeasured allocation:** executed steps outside their job interval or a terminal gap over
  180 seconds. Raw job/step timestamps and the observed job span are retained, but execution,
  finalization and wait allocation are null. No guessed one-hour offset is subtracted.

A conflicting required job withdraws the critical path, even if another job might have been
the longest. Missing/incomplete steps retain nulls. No completed required result is invented for
a skipped, cancelled-before-start or absent aggregator. Known skipped routing anchors consume
zero execution. Unknown critical paths remain null; omitted noncritical jobs remain identifiable
through `otherJobIds`.

The 385 PR first attempts contain 234 measured required results, including 198 passing runs.
There are 233 identified PR critical paths (466 jobs); the remaining attempts include skipped
and cancelled runs and one completed-result run with conflicting evidence. All 196 merge groups
have measured required results and identified paths (392 jobs), including 147 passing runs.
Required-result timing includes failure results; it is not a success-rate claim. Passing-only
PR p50/p90 is 39.07/49.48 minutes (n=198); merge-group p50/p90 is 37.82/40.65 (n=147).

| Measure (Minutes) | PR n | PR p50 / p90 / Max | Merge-Group n | Merge-Group p50 / p90 / Max |
| --- | ---: | --- | ---: | --- |
| Run created → required result | 234 | 38.83 / 47.08 / 65.47 | 196 | 37.35 / 40.65 / 61.92 |
| Critical runner wait, summed | 233 | 0.08 / 9.37 / 28.83 | 196 | 0.07 / 1.05 / 24.72 |
| Critical step execution, summed | 233 | 37.07 / 40.03 / 44.42 | 196 | 36.83 / 39.73 / 41.10 |
| Critical finalization, summed | 233 | 0.08 / 0.12 / 2.02 | 196 | 0.08 / 0.13 / 0.82 |
| Critical runner overhead, summed | 233 | 0.03 / 0.05 / 0.25 | 196 | 0.03 / 0.03 / 0.18 |
| Scheduling gap | 233 | 0.02 / 0.03 / 0.15 | 196 | 0.02 / 0.03 / 0.05 |
| Last dependency completion → aggregator start | 234 | 0.03 / 0.45 / 11.05 | 196 | 0.03 / 0.17 / 6.20 |

Each row has its own distribution; percentiles must not be added together. Per-run partitions
reconcile to required wall time. The JSON provides the individual job partitions rather than
assigning a cohort percentile to a particular job.

## Exact Scheduling and Finalization Examples

| Run / Job | Observation |
| --- | --- |
| [41001466755 / 123899851452](https://github.com/picoduck/wollipog/actions/runs/41001466755/job/123899851452) | Merge-group aggregator created Oct 30 04:56:40, started 05:02:52, completed 05:02:55: **6m12s runner wait**, three-second job interval. Last dependency completed at job creation. |
| [41392566912 / 125118242820](https://github.com/picoduck/wollipog/actions/runs/41392566912/job/125118242820) | PR aggregator waited **11m03s** after dependencies; critical browser job 125106947180 executed steps for 38.30 minutes. |
| [41396270157 / 125118160812](https://github.com/picoduck/wollipog/actions/runs/41396270157/job/125118160812) | Merge-group browser shard created Nov 2 05:49:44, started 06:14:25, completed 06:51:32: **24m41s runner wait**, 37m07s job interval. |
| [41443173747 / 125269786104](https://github.com/picoduck/wollipog/actions/runs/41443173747/job/125269786104) | PR browser shard created Nov 2 12:15:18, started 12:44:05, completed 13:20:36: **28m47s runner wait**, 36m31s job interval. |
| [41538767729 / 125614346174](https://github.com/picoduck/wollipog/actions/runs/41538767729/job/125614346174) | PR aggregator finalization gap **78 seconds**; browser job 125597250769 adds 43 seconds, giving the 121-second maximum critical-path finalization sum. |

Independent check-run reads for jobs 123899851452, 124217735543 and 125614346174 agree with
their Actions-job `started_at` and `completed_at` timestamps. That three-job sample does not prove
equality for every check. The larger API gap remains observed finalization, not proof of scheduler
slot occupancy or of a specific service-side defect.

Four first-attempt PR jobs are unmeasured allocation; no merge-group job is flagged:

| Run | Job | #4046 Reason | Raw Terminal Gap (Seconds) |
| --- | --- | --- | ---: |
| 41100871383 | 124217735543, WebKit | unexplained-terminal-gap | 195 |
| 41100871383 | 124217735750, Delegated Pipeline Recovery | unexplained-terminal-gap | 249 |
| 41100595057 | 124217058777, Browser (3) | unexplained-terminal-gap | 233 |
| 41100595057 | 124217058800, Browser (5) | unexplained-terminal-gap | 233 |

Those gaps are not added to the measured finalization column. There is no evidence in these four
days supporting a one-hour correction. A different-day anomaly cannot supply a missing allocation.

## Timeout Census and Trial Comparison

In addition to the run collector's removals, the investigation listed all repository PRs by
descending `updated_at`, through the first page older than October 30 (275 PRs), and fetched each
complete removal timeline. This catches removals for PRs whose merge-group run was created before
a selected window. The JSON retains those PR numbers and all **173 removal events** inside the
four windows. **Zero were `checks_timed_out`**, so there is no timeout-window component to attribute
in this cohort. Removed/deleted/inaccessible PR history and concurrent updates remain API limits;
this is a bounded historical census, not a guarantee against future timeout removals.

The [October 28 trial report](ci-runner-contention-2026-10-28.md) covers October 20, 21, 22, 23,
26: 151 completed merge-group runs, required-result p50/p90/max 39.2/65.9/134.6 minutes, critical
wait p50/p90 1.2/31.9, execution p50/p90 34.8/39.1 and four timeout removals. Two had failed jobs;
two had no prior failure but still-running browser shards, so all-green was unproven. The new
196-group p90 is 25.25 minutes lower, but median execution has not improved. The old export lacks
step evidence needed for retrospective #4046 classification; old execution/wait figures are
historical context, not a recomputed compatible partition or causal estimate of Team's effect.

Measured CI-only peak concurrent first-attempt allocations were **59, 58, 56 and 55** by day,
respectively, excluding conflicted jobs. Each exceeds the old 20-job ceiling, confirming capacity
beyond Free's limit. These are lower bounds, not a complete organization occupancy census: other
workflows, other repositories, reruns and carry-in runs can occupy additional slots. This evidence
does not establish idle capacity during any particular wait or prove GitHub scheduler starvation.
The pilot's ≤60-minute p90 and no-timeout conditions hold for these four days; its original fifth
full day is unavailable as an unchanged cohort after routing activation.

## Targets, Proposals, Costs and Rollback

Removing all measured critical runner wait and finalization still leaves a median 36.83 minutes
of merge-group step execution. Thus scheduling changes alone cannot meet the 15–20-minute queue
target. The #3628 shard evaluation addresses that execution component; #3630 addresses ordinary
PR browser execution. Neither gain is measured here. A separate natural post-activation cohort
must start at 2026-11-05T14:55:12Z or later and record shard/workflow revisions before comparison.

No new repository-setting or scheduling change is recommended for activation from this evidence.
The read-only queue readback still has a 120-minute response timeout, build concurrency 2,
ALLGREEN grouping, squash merging and maximum merge batch 5. Increasing the timeout has zero
modeled benefit for this cohort's zero timeout removals and would not accelerate checks. Retain
the full merge-group regression gate. The fast-only merge gate is not an activation proposal.

If an operator pursues a runner-independent aggregation design separately, its maximum isolated
observed saving here is 6.20 merge-group minutes or 11.05 PR minutes on the worst affected run;
the median saving is about two seconds. This counterfactual removes only the measured wait,
holds dependencies fixed, and does not predict pool-wide feedback. It needs design and a separately
approved infrastructure/scheduling decision, preservation of failure reporting, and rollback to
the current hosted aggregator. Existing #2674 already owns that observation; no new issue is needed.

The investigation caused **zero CI runner-minutes** (zero dispatched/rerun workflows). First-attempt
CI consumed 96,226.88 measured elapsed runner-minutes across the four windows, excluding conflicts
and reruns; this is not billed usage or full-pool cost. The November 5 organization Actions usage
summary reports net $0 across all returned Actions SKUs; it is not attributed to this cohort and
does not include Team's subscription cost. No invoice or new purchase was made.

Rollback for this PR is a normal revert of the report/tooling commit; it has no live configuration
effect. The earlier Team pilot's human-only rollback remains downgrade to Free at the billing
period boundary, with increased contention expected. No downgrade or other live action is requested.

## Reproduction and Verification

Collect each day with the existing cache/quota-protected command, then analyze offline:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/ci-runner-occupancy.mjs \
  --repo picoduck/wollipog --cache <cache-dir> --floor 2500 --queue-wait --all-events \
  --since 2026-10-30T00:00:00Z --until 2026-10-31T00:00:00Z > team-2026-10-30.json
# Repeat for Nov 2, 3 and 4, each ending at the next midnight.
node scripts/ci-scheduling-delays.mjs team-2026-10-30.json team-2026-11-02.json \
  team-2026-11-03.json team-2026-11-04.json > scheduling.json
node --import tsx --test scripts/ci-scheduling-delays.test.mjs \
  scripts/ci-job-timing.test.mjs scripts/merge-queue-wait-report.test.mjs \
  scripts/ci-runner-occupancy.test.mjs
```

The committed export adds the removal census, cost readback, CI-only occupancy lower bounds and
provenance to the analyzer's output. For the independent census, enumerate
`GET /repos/picoduck/wollipog/pulls?state=all&sort=updated&direction=desc&per_page=100&page=N`
through the first older page, then use the existing `listRemovals` helper for every retained PR.
Filter by the four half-open windows, not the continuous October 30–November 5 interval.

Two default-transport unreadable-response failures and repeated jobs-endpoint HTTP 502 failures
interrupted collection. Cached retries recovered all four days; a complete 20-item first page
(18 jobs) recovered the problematic November 4 listing. No missing day was replaced with zero.
No HTTP 403/429 or quota-floor refusal was observed; collection retained a 2,500-request floor.
Tests cover interval union, partition reconciliation, skipped/queued/rerun records and conservative
withdrawal of a path after a #4046 conflict. They do not simulate GitHub's scheduler.

This delivers timing attribution and historical reliability evidence. It does not establish the
campaign's new latency targets or future reliability under expected contention. Keep #2674 open
for the post-routing/shard cohort; #3628 and #3630 remain the existing execution-work references.
