# Natural PR Browser Routing Measurement

Refs #3630. Run-creation cutoff: **2026-11-09T04:19:15Z**. This is an observational
measurement of natural traffic after the owner's activation of
`pr-browser-critical-v2`, not a controlled experiment. No settings were changed,
CI runs dispatched, or jobs rerun for this measurement.

## Scope and Method

The requested run-creation window is **[2026-11-05T14:55:12Z,
2026-11-09T04:19:15Z)**. All windows are half-open UTC intervals. Jobs belonging
to an included run can finish outside its creation window; unfinished snapshots
remain unfinished. Queue episode windows use merge timestamps instead of run
creation timestamps and must be interpreted separately.
API states were fetched afterward, not reconstructed as of the cutoff.

The implementation and assurance contract were delivered by
[#4149](https://github.com/picoduck/wollipog/pull/4149), merge
`db20a71e7d73c4985b7d1d8cd425a08a01dff7be`. The
[owner's activation comment](https://github.com/picoduck/wollipog/issues/3630)
records `CI_PR_BROWSER_ROUTING=enabled` at 2026-11-05T14:55:12Z.

Collection uses the existing `merge-queue-wait-report.mjs` event collector and its
attempt/job timing quality projections. API responses, including headers, are
cached privately on disk; requests are paced and each response's quota header is
checked against a floor of 2,500. Cached responses are never fetched again.
Run/job/timeline pagination limits and unmeasured outcomes are reported explicitly.
Raw API payloads and logs are not public evidence artifacts.
The sanitized [run/attempt projection](ci-pr-browser-post-activation-2026-11-09.json)
retains identifiers, timing quality, browser outcomes, removals and queue episodes.
Collection used five adjacent slices: activation to #4229, then to November 7
00:00, November 8 00:00, November 9 00:00, and the cutoff.
All 15 event listings, job listings, attempt histories and timeline listings
completed within their ten-page/ten-attempt bounds; no truncation was reported.
The largest daily event listing was 117 runs, below the search cap of 1,000.
Run collection is sliced, but queue timelines are recomputed from the union of
tracked PR identities over the whole window before filtering by merge/removal
time. This preserves episodes crossing collection boundaries.

Required latency ends at the exact `Typecheck, Test & Sidecar Bundle` job.
Passing latency excludes failed/cancelled/skipped/unfinished outcomes. Elapsed
runner-minutes include measured job execution, not billing multipliers or dollar
costs. A partial measured sum is never described as total consumption. First
attempts and reruns remain separate because copied rerun jobs cannot support
reliable allocation timing. Job/step timestamp conflicts are unmeasured allocation,
as in #4046; no clock offset is inferred or subtracted.

## Natural Traffic Results

Era A is **[2026-11-05T14:55:12Z, 2026-11-06T00:42:15Z)**.
Era B is **[2026-11-06T00:42:15Z, 2026-11-09T04:19:15Z)**.
There are **427 attempt records**: 281 PR first attempts, 16 PR reruns and 130
merge-group first attempts. No main-push CI runs occurred in these listings;
reusable rolling validation is another workflow, not zero main validation.
Optional Platform Isolation workflow consumption is outside these CI totals and
remains unmeasured here.

“Ready” means workflow-admitted (`admitted-by-workflow-guard`), not a lookup of
the PR's present draft flag. One jobless failed PR run and three skipped PR runs
cannot establish admission and are excluded, leaving **277 admitted first
attempts**. Units are PR runs, not unique PR numbers or author episodes. Reduced
topology requires one Chromium job and successful planning; full topology has
five or ten jobs. Planned topology includes cancelled jobs and does not prove
all tests finished. A policy marker is separately verified below.

| First-Attempt Measure | Era A | Era B |
| --- | ---: | ---: |
| All PR Runs | 73 | 208 |
| Admitted PR Runs | 72 | 205 |
| Reduced / Full / Unknown | 28 / 44 / 0 | 39 / 165 / 1 |
| Reduced Share of All Admitted Runs | 38.89% | 19.02% |
| Full Share of All Admitted Runs | 61.11% | 80.49% |
| Admitted Passing / Failing / Cancelled | 48 / 8 / 16 | 127 / 16 / 62 |
| All-PR Skipped / Unfinished | 0 / 0 | 3 / 0 |
| Merge Groups Passing / Failing / Cancelled | 30 / 1 / 1 | 73 / 18 / 7 |
| Merge Groups Skipped / Unfinished | 0 / 0 | 0 / 0 |

The unknown admitted run in B was cancelled before planning established
reduction. Do not classify it as reduced because one matrix job appears.
A's full PR cohort has 41 five-shard and three ten-shard feature runs before
#4229 landed; B's full PR topologies all have ten shards.
Era A groups also mix inventories: 27 five-shard and five ten-shard groups,
including 27 five-shard and three ten-shard passing groups. The ten-shard
groups are #4229 and integrations stacked on it before landing. In those rows,
the collector's `browserShardImbalance.expected=5` is the era-pinned analysis
input, not the executed workflow inventory; `complete=false` there does not
mean a missing shard when ten observed shards actually executed.

| Passing Required Latency, Minutes | Era A Median / P90 (N) | Era B Median / P90 (N) |
| --- | ---: | ---: |
| Reduced PR | 15.67 / 21.05 (22) | 16.57 / 23.13 (23) |
| Full PR | 37.73 / 44.43 (26) | 19.70 / 27.33 (104) |
| Merge Group | 35.95 / 41.48 (30) | 19.18 / 22.75 (73) |

Against the original 33.32-minute full baseline, reduced medians differ by
−17.65 / −16.75 minutes; full medians by +4.41 / −13.62 minutes. These are
descriptive differences from one observation. B's full-PR improvement cannot be
credited to reduced routing. Reduced coverage occurred on **67/277 (24.19%)**
admitted first attempts, versus the historical applicability replay's 32/100;
the denominators and workloads differ.

| CI Runner-Minutes per Admitted First Attempt | Era A | Era B |
| --- | ---: | ---: |
| Complete Observations / Admitted Runs | 56 / 72 | 142 / 205 |
| Mean of Complete Observations | 137.53 | 181.48 |
| Reduced Median / P90 (Complete N) | 53.83 / 56.02 (23) | 55.17 / 59.83 (23) |
| Full Median / P90 (Complete N) | 198.42 / 211.48 (33) | 206.10 / 216.85 (119) |
| Sum of Complete Observations | 7,701.68 | 25,769.52 |
| Measured Partial Sum Across All Admitted Runs | 8,575.55 | 30,867.12 |

Complete-observation means are conditional, not total minutes divided by all
ready PRs. Total consumption and the all-admitted mean remain unmeasured: 16 / 63
admitted attempts lack complete allocation timing. Run 42067303894 has one
timestamp-conflict job and 42142832258 has three; JSON retains IDs and reasons.
Reduced runner-minute medians are below the baseline's 198.37; full medians
remain near it. No dollar saving or unique-PR cumulative cost is inferred.

Reruns are separate: A has six PR rerun attempts (five passing, one failing;
one reduced/five full); B has ten (nine passing, one failing; all full).
Their allocation timing and latency are unmeasured; copied jobs are not charged
again or treated as zero. No merge-group rerun occurred. There are no unmeasured
run outcomes, but unmeasured timing remains as above.

## Queue Latency, Cancellations and Failures

| Queue Measure | Era A | Era B |
| --- | ---: | ---: |
| Created Merge-Group Runs | 32 | 98 |
| Cancelled Merge-Group Runs | 1 (3.13%) | 7 (7.14%) |
| Browser-Failing Runs | 1 (3.13%) | 2 (2.04%) |
| Other Failing Runs | 0 | 16 |
| Surviving Enqueue → Merge Median / P90, Minutes (N) | 152.92 / 260.67 (27) | 20.08 / 33.68 (74) |
| Tracked `failed_checks` Removal Events | 1 | 18 |
| Tracked `merge_conflict` Removal Events | 0 | 2 |
| Tracked `manual` Removal Events | 2 | 0 |

Queue latency describes only the surviving enqueue episode of 101 merged PRs
tracked by included group runs. Earlier failed episodes and still-open PRs are
not successful latency observations. Queue/removal clocks use merge/removal time,
not group creation. Removals cover tracked PRs only: 19 failed-check removals,
two conflicts and two manual removals are **not** a population ejection rate or interchangeable with 130
created runs. Successful `merged` removals remain in JSON but are not ejections.
PR cancellation was 16/72 (22.22%) / 62/205 (30.24%) admitted first attempts;
the causes are unmeasured.
Boundary checks retain #4229's merge exactly at 2026-11-06T00:42:15Z in B,
plus #4264 at 00:43:40Z, #4315 at 2026-11-07T00:15:32Z and #4358 at
2026-11-09T00:07:00Z. Their complete queue histories confirm the merge SHAs;
all four crossed a collection-slice boundary and are included in B's 74.

All **three browser-failing runs out of 130 (2.31%)** have a corresponding
failed-check removal for their PR: three browser-associated ejections following
**full** PR coverage, with no evidenced reduced-selection escape. No other
Chromium or WebKit failing/timed-out job appears in the group cohort. Other
failing groups failed Node jobs. The #4345 group also failed `Unit Tests (1)`
(job 128363650367): two groups have browser-only CI failures, and one has mixed
browser/Node failures. Thus 17 of the 19 failing groups failed Node jobs, 16
without a browser failure. Cancelled group 42170940981 also has a failed Node
job and remains in the cancelled run count. Three browser-associated removals do not mean three removals
caused solely by browser failures. Node main-versus-flake attribution is outside
this browser-routing measurement and is not classified as a browser escape.

The November 4 baseline supplies no preactivation browser-ejection distribution;
whether ejections increased materially is **unmeasured**. Zero evidenced reduced
escapes is not proof of zero latent regressions. A denominator split by historical
PR routing for every successful integration is not established. No reproduction
or rerun was manufactured. These observations do not establish a routing rollback
signal; that decision remains the owner's.

The scheduling analyzer identified 198 PR and 130 group critical paths. Across
the mixed-era sample, median/p90 critical runner wait was 0.13/10.42 minutes for
PRs and 0.07/3.83 for groups. This is modeled runner assignment, not enqueue
latency or workflow concurrency delay. The occupancy analyzer used only collected
CI jobs at a nominal ceiling of 60: a scoped lower bound, not organization-wide
saturation evidence. The applicability tool replayed 100 recent squash identities
at source main: 36 reduced/64 full. That commit-clock replay is not the observed
67/277 runtime share or a UTC traffic window.

## Revision Boundaries and Confounders

- **2026-11-06T00:42:15Z**, merge of
  `d3c2644ff5d573257f0fc40491256fcec5ae0a4e`
  ([#4229](https://github.com/picoduck/wollipog/pull/4229)): five full Chromium
  shards became ten duration-balanced whole-file shards; browser timeout became
  54 minutes. This is the major confounder. The commit clock is
  2026-11-05T22:08:09Z; it is not the landing boundary. Feature PRs can test the
  new inventory before landing, and stale branches can retain older workflow
  bytes afterward, so actual job inventory must accompany time cohorts.
- `433e05f390d4a6d847d7c8ae6a8481f4ccd1e204`
  ([#4339](https://github.com/picoduck/wollipog/pull/4339)) changes typecheck
  checkout depth and adds the protocol-ledger check. It does not change browser
  or routing jobs, but can affect required latency.
- `1c3272252c16e052d069bfb37da1aed6d1c2c6da`
  ([#4304](https://github.com/picoduck/wollipog/pull/4304)) changes release
  runner selection, not browser/routing jobs.

No other browser/routing workflow or policy change appears in first-parent main
history between activation and source main
`72de53c7a0168d1240fe8041f94434989ae7617a`. Changes to individual tests and
application code, PR mix, concurrent workloads, caches and failures remain
confounders. The organization's move to 60 concurrent jobs on 2026-10-29 preceded
both the November 4 baseline and activation; it prevents extrapolation to earlier
20-slot cohorts and is not a routing effect.

#3617's former midnight restriction does not apply to this source: the issue is
closed, the fixture clamps its last invocation to the start of today, and the
browser suite includes an explicit 00:01 UTC clock regression test.

## Baseline and Interpretation

The [November 4 baseline](ci-pr-browser-measurements-2026-11-04.md) contains one
natural passing full PR: run 41890273700, **33.32 minutes required latency /
198.37 runner-minutes**, [2026-11-04T18:45:31Z, 2026-11-04T19:18:52Z).
Its contemporary full-PR observation is run 41920725615, **35.40 minutes /
208.47 runner-minutes**, [2026-11-04T21:56:29Z, 2026-11-04T22:31:55Z).
Neither is a distribution. The 32 reduced / 68 full applicability replay is a
Git-history selection sample, not an observed ready-PR routing share. Synthetic
benchmark dispatches are excluded from natural post-activation statistics.

That document provides no comparable natural queue-cancellation or browser-ejection
distribution. The #4149 delivery comment separately records one final full group
at 34.87 minutes and an enqueue-to-merge episode of 118.18 minutes. These are
individual observations, not a preactivation ejection rate. A postactivation
browser failure alone cannot establish a regression escaped reduced PR selection:
it needs the omitted spec, prior PR selection, integration/head relationship,
and main/flake evidence. Unresolved attribution remains unknown.

## Sampled Execution Evidence

- Reduced PR [42137093144](https://github.com/picoduck/wollipog/actions/runs/42137093144),
  attempt 1, change head `a82176bde1ae64888584c8aed098b497ae55b9de`, tested merge
  `6e8e648f0ac49d8aab5f3538125bc26fe631bf96`: routing job 127627898240 emitted
  `pr-browser-critical-v2`, mode `fast`, seven selected files out of 311.
  Chromium job 127627978585 emitted 245 development and 57 production browser
  attempt records, zero failed/retry-only records. The policy marker is bounded
  observational evidence (`certification: none`), not a full-suite certificate.
- Full five-shard merge group
  [42117705819](https://github.com/picoduck/wollipog/actions/runs/42117705819),
  integration `26ce88eb2dde7d56673b2659427e0a81e3fc6af8`, created
  2026-11-05T22:00:29Z: all five Chromium jobs and their development browser-test
  steps succeeded.
- Full ten-shard merge group
  [42315061761](https://github.com/picoduck/wollipog/actions/runs/42315061761),
  integration `2432ffc6b835dae638f1d3f9ce324cee27c12f13`, created
  2026-11-06T23:55:59Z: all ten Chromium jobs and their development test steps
  succeeded. Shard 1's production build/smoke succeeded; `Merge Group Gate` was
  skipped. Browser job IDs: 128225526815, 128225526865, 128225526878,
  128225526915, 128225526918, 128225526932, 128225526963, 128225526972,
  128225527021, 128225527330.

The first browser-failing queue attempt is
[42111261806](https://github.com/picoduck/wollipog/actions/runs/42111261806),
attempt 1, integration `612a257e23d486e37c01451e35dad8fbf373ad5b`, for #4229.
Job 127539118438's untruncated timing projection records one failed attempt and
one passing retry of the same test in `apps/web/e2e/agent-questions-live.spec.ts`.
It failed the job under fail-on-flaky semantics. #4229's final PR head
`733c49f190c4517fcf5c3eaff13a5b5ec446fcfd` had already passed full ten-shard
PR run 42069536103. Thus this is a retry-only browser failure following **full**
PR coverage, not an omitted-spec escape from reduced PR selection. A queue
removal with reason `failed_checks` is recorded at 2026-11-05T22:00:24Z.
No base reproduction was manufactured; the retry evidence establishes flakiness
in this attempt, not reproducibility on main or a root cause.

The other two browser failures are also retry-only failures after full coverage:

| Group / PR | Integration SHA | Failed Browser Job / File | Prior Passing Full PR Run | Failed-Check Removal |
| --- | --- | --- | --- | --- |
| [42382912004](https://github.com/picoduck/wollipog/actions/runs/42382912004) / #4349 | `b19f50f7be77488892c7cd4eb22344f23159a979` | 128434129538 / `agent-questions-live.spec.ts` | 42370433766, head `52d46ba88da16d6c7c590b68c560d30468712a7e` | 2026-11-07T15:02:16Z |
| [42359163850](https://github.com/picoduck/wollipog/actions/runs/42359163850) / #4345 | `8fc85d0774f42bec55640369c00663327e2ba724` | 128363650430 / `usage-view.spec.ts` | 42357414020, head `f0c404ff790505fffbe1b6f1ad2382f943aeac9b` | 2026-11-07T09:37:23Z |

Both untruncated timing projections contain one failing attempt and a passing
retry with the same file/test IDs. The agent-question failure has the same hashed
test ID in #4229 and #4349. This supports repeated flakiness, not a diagnosis.
The #4345 removal is associated with both its browser flake and a concurrent
Node failure, so the removal cannot be attributed solely to the browser flake.
Historical prior PR heads were checked against read-only PR metadata. No merge-group browser
failure in this sample needs an “escaped reduced PR regression” or “proven main
regression” attribution: all three are observed retry-only failures after full
PR coverage. This does not establish that main cannot exhibit the same flakes.
Separately, six first-attempt PR runs had Chromium failures: all used full
coverage (one five-shard, five ten-shard), and four later passed on attempt-2
reruns. No reduced PR browser failure was observed. The six run IDs are
42095509704, 42174322391, 42163880391, 42335793843, 42326463283 and 42556931314;
their presence does not change the merge-group failure/ejection denominator.

## Acceptance Criteria

| Criterion | Status | Evidence and Limits |
| --- | --- | --- |
| 1. Reduced Ordinary PRs, Full Queue | Met | 67 admitted first attempts selected reduced topology; 130 groups retained full topology. Marker and five-/ten-shard execution samples above confirm actual execution. Cancelled groups are not called complete validation. |
| 2. Exactly the Required Result; Fail Closed | Met | Static required context preserved by #4149; 45 current routing/inventory/event/aggregation/benchmark contracts passed. Natural failed dependencies, including the three browser failures, produced failed aggregates. Sampling does not prove every hypothetical error state. |
| 3. Admission, Duplicate/Supersede/Rerun/Replacement Safety and Permissions | Met | #4149 retained event/concurrency/read-only contracts; current event/routing contracts passed. Natural skipped, cancelled and rerun attempts are separate in the projection. Failure causes are not inferred solely from a cancellation. |
| 4. Tests and Workflow Consumers | Met | Workflow name/path and protected result remain unchanged; #4149 updated consumers and recorded its consumer/rolling contracts. Current 45 focused contracts pass. This documentation PR changes no workflow consumer. |
| 5. Natural Before/After Measurement | Blocked for Complete Accounting | Natural latency, routing share, conditional runner-minutes, queue latency, cancellations and browser failures/ejections are delivered here against the specified baseline. The baseline lacks a preactivation cancellation/ejection distribution; 79 admitted attempts lack complete allocation timing; rerun allocation timing is unmeasured. Consequently a complete all-ready-PR mean and a before/after ejection-rate change cannot be supplied without inventing missing data. The measured evidence and limitations are explicit. |
| 6. Exact Assurance Approval Before Activation and Rollback | Met | #4149 documents `pr-browser-critical-v2`; the issue records owner activation at 2026-11-05T14:55:12Z. Rollback is documented below. This pass neither changes settings nor reinterprets merge approval as activation approval. |

Focused verification at source main:

```sh
node --test scripts/ci-pr-browser-route.test.mjs \
  scripts/ci-pr-browser-benchmark.test.mjs \
  scripts/ci-pr-browser-inventory.test.mjs \
  scripts/workflow-ci-aggregation.test.mjs \
  scripts/workflow-pr-event-contract.test.mjs \
  scripts/workflow-ci-routing.test.mjs
```

Result: **45 passed, zero failed/cancelled/skipped**. The measurement adds no
product or workflow code. Missing historical timing is not repairable by testing
the report, and no dispatch or rerun was used to obtain additional observations.

## Owner Rollback

Only the owner can decide to roll back. The documented command is:

```sh
gh variable set CI_PR_BROWSER_ROUTING --repo picoduck/wollipog --body disabled
gh variable get CI_PR_BROWSER_ROUTING --repo picoduck/wollipog
```

Verify on a new PR event, not a failed-jobs rerun retaining an old plan/matrix:
planning skips, all **current** full Chromium shards execute (ten after #4229),
full Node and other mandatory work succeed, and the protected aggregate passes.
The assurance document's historical five-shard rollback wording predates #4229.
