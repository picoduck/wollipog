# CI Measurement Baseline: October 22, 2026

This is the measurement foundation for #3626 and tracker #3625, before changing
event routing or required suites. It extends the existing
[merge-queue report](merge-queue-wait.md). No ruleset, concurrency, scheduling,
required check, retry policy or capacity changed to obtain these observations.
The collector performed bounded reads of ordinary traffic, without dispatching,
rerunning or cancelling a workflow.

## Windows and Reproduction

The historical comparison is #2674's original **153 completed merge-group runs**,
created October 17 00:00 UTC through October 19 18:39:31 UTC. Recollection with
the preserved report reproduced its numbers. The approved `max_entries_to_build`
5→2 trial began **2026-10-19T18:42:33Z**. October 19 is a partial transition,
not an acceptance day. The five full UTC working days remain **October 20, 21,
22, 23 and 26**. Do not close #2674 or edit that acceptance contract on the basis
of this report.

The new normal-traffic cohort is **[2026-10-20T00:00:00Z,
2026-10-22T00:00:00Z)**: two complete UTC days, collected at
2026-10-22T21:59:24.932Z. It contains **308 distinct runs / first attempts**
and **7 rerun attempts**. All were terminal when observed. It is an interim
observation, not the completed five-day trial, causal proof, or activation approval.
Queue histories were refreshed at 2026-10-22T22:11:55.080Z after verifying that
the successful `merged` removal must be paired with its merge event.

From the repository root at this change's revision:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --since 2026-10-17T00:00:00Z \
  --until 2026-10-19T18:39:31Z --timeout-minutes 120 --json > pre.json
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events --since 2026-10-20T00:00:00Z \
  --until 2026-10-22T00:00:00Z --timeout-minutes 120 --json > post.json
node scripts/merge-queue-wait-report.mjs --input post.json
node scripts/merge-queue-wait-report.mjs --input docs/ci-baseline-2026-10-22.json
```

The committed [machine-readable baseline](ci-baseline-2026-10-22.json) retains
raw per-attempt metrics, exact source identities and source job IDs. It deliberately
omits nested job/step detail from this compact export; fresh `post.json` contains
that detail. The markdown tables below were computed from those raw records;
the offline `--input` command recomputes cohort distributions. This preserves
the run-level baseline after Actions retention expires, without retaining logs,
test input or artifacts. A compact export can be made from `post.json` with:

```sh
jq '.recordFormat = "run metrics with source job IDs; job and step detail not retained in this baseline export"
    | .records |= map(. + {jobIds: [.jobs[].id]} | del(.jobs))' post.json > compact.json
```

Run listings, per-attempt job listings and PR removal/queue histories were **not
truncated**; no run exceeded the ten-attempt cap. Run search paged 100 at a time
within the 1,000/event bound. Job and history connections have the same bound.
Errors terminate collection; incomplete pagination is explicit. Daily reports can
also be combined as documented in the report guide: half-open boundaries and raw
identity deduplication prevent double counting, and percentiles are recomputed.
Later collection can differ because reruns, history or retained evidence change;
compare observation time and source IDs, not just a printed percentile.

## Event and Outcome Baseline

These are **first-attempt** counts. Skipped PRs are outside the observed admitted
worker cohort; historical ready/draft payload is unavailable. Cancellation is an
outcome, not a product failure or proof that all preceding execution was wasted.

| Event | First Attempts | Passing | Failing | Cancelled | Skipped | Unfinished | Unmeasured |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pull Request | 175 | 82 | 8 | 82 | 3 | 0 | 0 |
| Merge Group | 75 | 65 | 6 | 4 | 0 | 0 | 0 |
| Main Push | 58 | 16 | 1 | 41 | 0 | 0 | 0 |

Seven additional PR attempts passed; **six** followed failing first attempts at
the same head SHA. These are retry-only run outcomes, not six proven flaky tests.
The remaining rerun did not have a failing first attempt. All seven remain outside
first-attempt latency and resource distributions because copied job timings cannot
establish rerun consumption. Source run IDs are in `summary.retryOnlyRuns`.
Per-outcome distributions are in each cohort's `byState`, so cancelled and passing
observations need not be mixed in a comparison.

The issue's earlier **100-run exploratory snapshot**, from October 20 23:29:38Z
through October 21 14:41:01Z, observed 24 cancellations among 29 main pushes.
That limited sample is not the baseline. The two full days observed **41/58**;
neither cancellation ratio estimates all wasted runner time or a causal benefit
of a proposed workflow change.

## Queue Trial Comparison

The original completed-run comparison includes terminal outcomes, not exclusively
green groups. The new all-outcome group cohort is likewise explicitly separate
from the passing-only cohort. Times are minutes, nearest-rank quantiles.

| Measure | October 17–19 p50 | October 17–19 p90 | October 20–21 p50 | October 20–21 p90 |
| --- | --- | --- | --- | --- |
| Created to Required Result | 67.5 | 131.5 | 42.4 | 74.9 |
| Critical Path Waiting | 39.9 | 109.6 | 8.6 | 40.9 |
| Critical Path Executing | 30.5 | 34.3 | 33.7 | 37.8 |
| Aggregator Wait | 3.9 | 26.9 | 0.05 | 10.0 |

All 75 new first attempts have a measured required-result timeline; 11 waited
longer than they executed and 3 exceeded 120 minutes. The historical counts were
93/153 waiting-dominated and 23 results after 120 minutes. Among the new cohort's
**65 passing groups**, required-result p50/p90 was **40.2/64.1 minutes**. Thus
even the passing-only p90 is above the unchanged 60-minute target. Changing traffic,
code, optional coverage and cancellation behavior prevent causal attribution to
the build limit.

The new window contains **three `checks_timed_out` removals** (#3495 at October 20
07:40:24Z; #3540 at October 20 23:29:35Z; #3588 at October 21 23:26:32Z), compared
with seven in the original historical window. There were also 56 merged, 4
failed-check and 1 manual removals. Removal counts and late-result counts describe
different events. A removal identifies a PR episode, not a unique integration
attempt; later cancellation or success cannot establish the reason at removal.
No all-green-timeout claim is made without exact episode/run reconciliation.
The known all-green transitional timeout for #3462 is already recorded in #2674
and lies outside these two full days.

Queue history exposed **56 merge episodes**, all with a surviving enqueue and
measurable span. Their enqueue-to-merge p50/p90 was **110.7/310.7 minutes**.
GitHub can emit the successful queue removal with reason `merged` one second
before the merge event; it does not end the successful episode. Failure/manual
removals still end an entry, and a genuinely missing enqueue stays unmeasured.
History is complete under the pagination bound. These are PR-level spans, not
CI run wall times, and exclude PRs without a group created in the measurement window.

## Execution, Setup, and Resource Constraints

First-attempt elapsed runner-minutes measured were **30,914.0** for PRs,
**12,912.1** for groups, and **6,939.5** for main pushes. This is elapsed execution
across jobs, not wall-clock latency or billed usage. Complete consumption remained
unmeasured for **33 PR attempts** and **2 pushes** with absent/incomplete timing
or all-skipped work. Their measured portions remain lower bounds; no missing
evidence was imputed. No rerun consumption is added. The group consumed-minutes
p50/p90 was **173.0/185.4**, and all 75 groups had complete job timing.

Group job execution and runner wait (minutes):

| Job | Execution p50 | Execution p90 | Runner Wait p50 | Runner Wait p90 |
| --- | --- | --- | --- | --- |
| Typecheck, Unit Tests & Bundles | 26.8 | 29.3 | 0.2 | 18.6 |
| Browser Shard 1 | 30.0 | 31.9 | 1.4 | 33.0 |
| Browser Shard 2 | 28.6 | 32.9 | 1.0 | 29.7 |
| Browser Shard 3 | 25.9 | 27.6 | 1.4 | 29.5 |
| Browser Shard 4 | 31.8 | 35.3 | 0.6 | 29.9 |
| Browser Shard 5 | 35.1 | 38.2 | 1.8 | 21.9 |
| WebKit | 1.2 | 1.5 | 0.9 | 31.4 |

Each row has 75 observed job records; missing/skipped phases are excluded from
quantiles. Across passing groups, the within-run longest/shortest browser-job
ratio was **1.54 at p50 / 1.81 at p90**. All-outcome ratios include cancelled
short shards, so they are unsuitable estimates of a balanced full pass. This
supports #3628's existing imbalance investigation, without selecting a new layout.

From group step records, Unit Tests p50/p90 was **23.7/25.7 minutes** (73 measured
steps). Browser regression steps were **27.8/35.0** (368 measured shard steps),
WebKit tests **0.22/0.27** (74), and production smoke **0.92/0.95** (72).
Non-test overhead summed across jobs had p50/p90 **7.7/8.4 minutes**; it includes
builds and post-job phases as well as setup. Missing phases were excluded, not
treated as fast installs. The API's second-resolution step timing cannot resolve
subsecond costs.

Historical **slowest Node/browser file and test identities and within-test
retry outcomes are unmeasured**: the prior CI did not emit the bounded safe
projection. The new reporters supply top-20 durations and hashed identities on
ordinary subsequent CI; use `--timing-job` as documented rather than retaining
raw historical logs or uploading broad reports. File hashes resolve against the
exact checked-out suite; source line/title changes invalidate test identity
comparisons. This is measurement instrumentation, not the complete inventory or
optimization required separately by #3627/#3628.

Static resource constraints at the baseline revision:

- Chromium has five hosted shards, **one worker each**, `fullyParallel: false`.
  Tests and serial fixtures within a file cannot be treated as independent workers.
- Development and WebKit use the same per-worktree development port; production
  uses the adjacent port. Strict server ownership and no reuse prevent certifying
  another checkout. Running those suites concurrently on one worktree conflicts.
- Production build/smoke is attached only to shard 1. Include that work when
  comparing the complete browser critical path.
- Node's complete root command includes process/integration tests. The command's
  name does not establish a fast/unit-only partition or resource independence.
- The #2674 observation of a 20-job hosted ceiling and eight initial workers per
  group explains the trial's 40→16 potential initial group demand. Other workflows
  still contend. Neither runner identities nor org-wide utilization were collected
  here, so no scheduler cause or current saturation fraction is inferred.

The raw records also identify **56 exact head SHAs observed across multiple event
types**. This is duplication evidence to inspect, not equivalence of arbitrary PR
heads, integration SHAs or suite revisions. It does not authorize skipping checks.

## Cost, Lag, and Delivery Limits

**Actual billed minutes and cost are unavailable.** No price assumption was used
for this baseline. Measured job minutes omit billing rounding, OS multipliers,
plan allowances, storage and copied rerun work. The optional explicit uniform-rate
estimate is a hypothetical scenario only; its assumption and unavailable actual
cost are separate machine fields. No purchase or billing access is requested.

Rolling validation does not exist yet. Oldest unvalidated age, commits/merges
beyond the last passing full snapshot, failure-detection lag and restoration time
are **not yet measurable**. The record shape and computation contract are in the
report guide; all current values are null. Current main-push CI is not silently
substituted for #3631/#3632's future authoritative validator.

The measurement foundation supplies the downstream baseline and instrumentation.
It does not finish the five-day #2674 trial, prove a faster merge pipeline, optimize
tests, define suite selection, or activate policy. Those remain with #2674 and
#3627–#3637. Recollect the remaining trial days under their original boundaries,
deduplicate source identities, and evaluate their combined raw records.
