# CI Runner Contention: October 28, 2026

Refs #2674, tracker #3625 (workstream 1). This report measures the hosted-runner pool that every
workflow in this repository shares, reports the #2674 trial cohort as that issue defines it, and
compares admission, scheduling, queue and capacity options. It is read-only analysis of existing
run history. No workflow was dispatched, rerun or cancelled, and no ruleset, variable, runner,
concurrency setting or plan was changed. Every option below that touches a live policy or spends
money is a proposal for the human owner.

## Findings

- **The pool is GitHub-hosted only, with a hard limit of 20 concurrent jobs.** All 9,353
  allocations from runs created October 20 – 28 18:00Z ran in the `GitHub Actions` runner group on
  standard labels (`ubuntu-24.04`, `windows-latest`/`windows-2025`, `macos-latest`). The
  organization is on GitHub Free, whose limit is 20 concurrent standard jobs, five of them macOS.
  Peak observed running jobs is exactly 20 on every busy day.
- **Waits are slot contention, not slow allocation.** Across the trial cohort, 98.8% of queued
  job-minutes accrued while 19 or 20 jobs were already running. Jobs that waited over five minutes
  saw a median of 20 running jobs when they were created. On October 20–21 the pool sat at the
  ceiling for 53–64% of the day, and on October 27 demand peaked at 269 jobs running or waiting.
- **Pull-request CI is the largest demand.** In the trial cohort, `ci.yml` pull-request runs used
  42.4% of runner-minutes, merge groups 30.6%, main pushes 11.7% (retired on October 25 by #3668),
  Platform Isolation 5.2% and the merge-group cleanup monitor 3.9%. PR jobs carry most of the
  waiting: 51,203 minutes of runner wait, against 8,588 for merge-group jobs.
- **The trial cohort misses the 60-minute p90 target.** The five working days defined in #2674
  give 151 completed merge-group runs, p90 created-to-required of **65.9 minutes**, and four
  `checks_timed_out` removals. Two of those groups had a failing job before removal. Two had
  no failure before removal, but browser shards were still running and were cancelled after
  ejection, so their all-green status cannot be shown either way.
- **Contention was worse on October 27–28** (separate cohort, not the trial): 67 runs, p90
  119.9 minutes, three timeout removals, one confirmed all-green. In that one, #3586's group
  [40516494080](https://github.com/picoduck/wollipog/actions/runs/40516494080) passed every work
  job by 15:19:19 UTC. Its required aggregator then waited 43m23s for a runner and succeeded at
  16:02:45, 3m15s after the 15:59:30 removal.
- **Capacity is the lever with the largest modeled effect.** A trace-driven replay, calibrated at
  20 slots to within 3.3 minutes of the observed trial p90, models merge-group p90 of **39.4
  minutes at 60 slots**, essentially execution time alone. GitHub Team gives 60 concurrent standard
  jobs. Standard runners stay free for public repositories, so the cost is the per-seat plan price.
  Reaching 60 slots therefore costs about **$4 per month** at today's single filled seat.

## Data and Method

Two read-only sources were used, both from the repository root at `e8a238cac`:

1. **Trial and contention cohorts.** These come from the unmodified
   `scripts/merge-queue-wait-report.mjs`, original completed-merge-group view, one command per UTC
   day exactly as documented in [merge-queue-wait.md](merge-queue-wait.md#build-concurrency-trial-october-19-2026):

   ```sh
   GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs --repo picoduck/wollipog \
     --since 2026-10-20T00:00:00Z --until 2026-10-21T00:00:00Z --timeout-minutes 120 --json > 2026-10-20.json
   # ... likewise 21, 22, 23 and 26; and 27 plus 2026-10-28T00:00Z..18:00Z for the separate cohort
   node scripts/ci-runner-occupancy.mjs --queue-wait-input 2026-10-20.json ... --queue-wait-input 2026-10-26.json
   ```

   `--queue-wait-input` combines the daily reports as the issue requires: run IDs and removal
   identities (pull request, time, reason) are deduplicated across shared day boundaries and every
   percentile is recomputed from the combined run metrics. No daily percentile is averaged. The
   original report keeps non-timeout removals only as counts, so those are summed and flagged as
   possibly repeating at a shared endpoint. No run or removal pagination was truncated.

2. **Runner occupancy across all workflows.** The new `scripts/ci-runner-occupancy.mjs` lists
   every workflow run created from 2026-10-19T12:00Z to 2026-10-28T18:00Z, in six-hour slices.
   It reads every attempt's jobs with the merge-queue report's own `listJobs`. Skipped runs need
   no job read. Collection ran at 2026-10-28T22:42–22:52Z: **7,995 runs, 13,613 job records**,
   no listing, job-page or attempt truncation, and no unfinished run.

   ```sh
   GITHUB_TOKEN=$(gh auth token) node scripts/ci-runner-occupancy.mjs --repo picoduck/wollipog \
     --cache ~/.cache/wollipog-ci-ws1/api --floor 2500 \
     --since 2026-10-20T00:00:00Z --until 2026-10-21T00:00:00Z > day-2026-10-20.json
   node scripts/ci-runner-occupancy.mjs --input day-2026-10-19.json ... --input day-2026-10-28.json \
     --window 2026-10-20T00:00:00Z..2026-10-21T00:00:00Z ... --scenario capacity=60
   ```

   A job counts as holding a runner only with a runner ID or executed-step evidence. A job
   cancelled while queued keeps a start placeholder, so it counts as waiting until it was
   cancelled, never as running. A rerun's copied jobs, which share their original's name and span,
   are counted once. Occupancy is clipped to each analysis window and includes runs created before
   it. A window's attribution counts only runs created inside it. Responses are cached under
   `~/.cache`, never in the repository, and collection stops at a rate-limit floor.

API use: 3,146 REST calls for occupancy, plus about 300 REST and GraphQL calls for the canonical
daily reports and spot reconciliation. Shared REST headroom stayed at or above 4,600 of 5,000
throughout, above the 3,000 floor that
[main-ci-health-budget-2026-10-24.md](main-ci-health-budget-2026-10-24.md) reserves.

## Runner Pool and Measured Capacity

| Property | Measured or Documented Value |
| --- | --- |
| Runner type | GitHub-hosted standard runners only: 9,353 allocations (runs created October 20 – 28 18:00Z) in group `GitHub Actions`, 0 elsewhere. Repository self-hosted runners: 0. Organization runner listing: not readable with this token (HTTP 403). |
| Plan and limit | Organization plan `free`, one filled seat. Free allows 20 concurrent standard jobs, at most 5 macOS ([GitHub limits](https://docs.github.com/en/actions/reference/limits), read 2026-10-28). |
| Observed ceiling | Peak running = 20 on every weekday measured; never above 20. |
| Labels used | `ubuntu-24.04` (CI, cleanup, controllers), `windows-latest` and `windows-2025` (Platform Isolation, settings rows), `macos-latest` (Platform Isolation). `windows-latest` currently maps to Windows Server 2025 ([runner images](https://github.com/actions/runner-images), read 2026-10-28). |
| Cost today | Standard runners in public repositories are free and do not use included compute ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), read 2026-10-28). |

Per-day occupancy. Each window is one UTC day, half-open. "Near-ceiling share" is the fraction of
queued job-minutes accrued while 19 or more jobs were running. Runner-minutes are elapsed job
execution, not billing.

| Day | At Ceiling | Near-Ceiling Share | Mean Running | Peak Demand | Queued Job-Minutes | Runner-Minutes | PR | Merge Group | Main Push | Rolling | Groups / PR Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Oct 20 | 63.6% | 99.1% | 16.2 | 127 | 27,604 | 23,686 | 11,616 | 6,299 | 3,011 | 0 | 38 / 91 |
| Oct 21 | 52.8% | 99.4% | 16.0 | 226 | 45,043 | 22,478 | 10,621 | 6,353 | 3,607 | 0 | 37 / 84 |
| Oct 22 | 20.2% | 94.3% | 9.6 | 67 | 4,157 | 13,651 | 4,055 | 5,786 | 1,998 | 0 | 33 / 42 |
| Oct 23 | 2.5% | 42.8% | 5.0 | 27 | 313 | 7,054 | 1,768 | 2,659 | 1,379 | 764 | 15 / 36 |
| Oct 24 (Sat) | 0.3% | 12.9% | 4.3 | 24 | 51 | 6,188 | 1,461 | 1,609 | 1,321 | 1,454 | 9 / 20 |
| Oct 25 (Sun) | 8.9% | 96.5% | 4.2 | 63 | 1,216 | 6,200 | 2,724 | 890 | 655 | 902 | 5 / 26 |
| Oct 26 | 40.6% | 98.9% | 12.6 | 161 | 17,227 | 18,207 | 7,983 | 4,919 | 0 | 2,733 | 28 / 71 |
| Oct 27 | 37.9% | 98.4% | 10.4 | 269 | 59,940 | 15,226 | 7,927 | 3,204 | 0 | 1,496 | 21 / 60 |

Saturation tracked pull-request traffic: the four days with 60 or more PR runs were at the ceiling
38–64% of the time, and days with 42 or fewer 0.3–20%. Main-push CI stopped on October 25.
Rolling validation (#3631) used 1,496–2,733 minutes on October 26–27, against 1,998–3,607 for
push CI on October 20–22. This is an observed change, not a controlled comparison. On October 27–28 every UTC hour from 13:00 to 22:00 except 15:00 was at
the ceiling 80–96% of the time.

### Demand by Workflow and Event

Trial cohort windows (October 20, 21, 22, 23 and 26), 85,076 runner-minutes. Waits are
created-to-started for first-attempt jobs that held a runner.

| Workflow / Event | Runs | Jobs Run | Runner-Minutes | Share | Cancelled-Job Minutes | Wait p50 / p90 / Max (min) | Queued Job-Minutes |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| ci / pull_request | 324 | 2,115 | 36,042 | 42.4% | 4,071 | 9.1 / 76.4 / 229.8 | 51,203 |
| ci / merge_group | 151 | 1,372 | 26,016 | 30.6% | 823 | 0.1 / 19.1 / 121.4 | 8,588 |
| ci / push (main) | 83 | 714 | 9,995 | 11.7% | 3,271 | 0.0 / 9.6 / 92.8 | 2,277 |
| platform-isolation / pull_request | 134 | 525 | 4,404 | 5.2% | 1,403 | 2.7 / 20.9 / 129.1 | 4,734 |
| main-rolling-validation / workflow_dispatch | 26 | 226 | 3,496 | 4.1% | 0 | 0.0 / 4.8 / 23.8 | 331 |
| merge-group-cleanup / workflow_run | 1,642 | 158 | 3,347 | 3.9% | 0 | 0.9 / 24.3 / 40.1 | 1,145 |
| linux-release-compatibility / pull_request | 43 | 72 | 1,308 | 1.5% | 81 | 4.2 / 33.3 / 60.8 | 954 |
| pr-ci-supersede / workflow_run | 1,611 | 368 | 54 | 0.1% | 0 | 6.8 / 100.3 / 233.0 | 11,001 |
| All other workflows | 806 | 230 | 412 | 0.5% | — | — | — |

Separate contention cohort, October 27 00:00Z – October 28 18:00Z (36,005 runner-minutes): PR
42.1% (wait p90 120.3), merge groups 30.3% (wait p90 38.1), rolling validation 12.9%, Platform
Isolation 8.6% (wait p90 68.4), cleanup monitor 4.0%. The superseded-PR canceller waited a p90
of 151.2 minutes for a runner. While it waits, superseded PR CI keeps running; that is #3420's
open first criterion, closed as not planned.

### Critical Path in Merge Groups

Which first-attempt job ended each group's critical path (the merge-queue report's dependency
model), with that job's runner wait in minutes:

| Job on Critical Path | Trial Cohort Runs (of 151) | Wait p50 / p90 / Max | Oct 27–28 Runs (of 66) | Wait p50 / p90 / Max |
| --- | ---: | --- | ---: | --- |
| Required aggregator | 151 | 0.0 / 6.8 / 20.1 | 66 | 0.2 / 23.2 / 69.1 |
| Browser shard 5 | 49 | 0.0 / 21.9 / 87.7 | 10 | 1.3 / 56.2 / 65.9 |
| Browser shard 4 | 45 | 0.3 / 25.9 / 33.2 | 29 | 1.8 / 39.6 / 58.2 |
| Browser shard 1 | 27 | 0.4 / 67.1 / 92.3 | 10 | 0.2 / 46.0 / 102.6 |
| Browser shard 2 | 14 | 12.6 / 39.5 / 121.4 | 5 | 2.6 / 87.5 / 87.5 |
| Browser shard 3 | 9 | 9.5 / 104.4 / 104.4 | 8 | 28.4 / 140.5 / 140.5 |
| Typecheck, Unit Tests & Bundles | 6 | 0.8 / 98.3 / 98.3 | 4 | 3.2 / 103.7 / 103.7 |

Execution of the slowest shards is 32–40 minutes, so a group cannot report much before 35
minutes. When shards 2 and 3, the fastest by execution, end the critical path, it is
because they waited. #3628's shard balance and #3627's Node work shorten execution. Waits come
from the pool.

## #2674 Trial Cohort (As Defined)

The cohort is the five full UTC working days October 20, 21, 22, 23 and 26, with the unchanged
120-minute timeout and the combination rules in the October 20 trial record. This report computes
it and does not redefine, extend or relabel it.

| Measure (minutes) | Median | p90 | Max |
| --- | ---: | ---: | ---: |
| Run created to required result | 39.2 | 65.9 | 134.6 |
| Critical path waiting | 1.2 | 31.9 | 121.5 |
| Critical path executing | 34.8 | 39.1 | 44.6 |
| Longest job wait for a runner | 1.7 | 29.8 | 121.4 |
| Aggregator wait after dependencies | 0.0 | 6.8 | 20.1 |

Sample: 151 completed runs (38, 37, 33, 15 and 28 per day), 0 duplicates across shared boundaries,
5 required results after 120 minutes, 16 runs waiting longer than executing. Removals: 101
merged, 19 failed checks, 2 manual, 4 `checks_timed_out`.

| Removal (UTC) | Group Run | Created to Removal | State at Removal |
| --- | --- | --- | --- |
| #3495, Oct 20 07:40:24 | [39375862997](https://github.com/picoduck/wollipog/actions/runs/39375862997) | 123 min | Browser shard 3 had failed at 07:26:03; not all-green. |
| #3540, Oct 20 23:29:35 | [39500726799](https://github.com/picoduck/wollipog/actions/runs/39500726799) | 120 min | Shard 4 and unit/build had failed; not all-green. |
| #3588, Oct 21 23:26:32 | [39678681360](https://github.com/picoduck/wollipog/actions/runs/39678681360) | 121 min | No failure. Shards 2 and 3 still running, cancelled after ejection: all-green unproven. |
| #3677, Oct 26 13:54:31 | [40318437984](https://github.com/picoduck/wollipog/actions/runs/40318437984) | 121 min | No failure. Shards 1, 3 and 4 still running, cancelled after ejection: all-green unproven. |

Measurement result: p90 65.9 minutes against the 60-minute target, and two timeout removals with
no failure observed before removal. This report does not declare the trial passed or failed beyond
these measurements; that is the issue owner's call.

### Separate Cohort: October 27 – 28 (Not the Trial)

Same method, windows 2026-10-27T00:00Z–28T00:00Z and 28T00:00Z–28T18:00Z: 67 runs, required
result p50/p90/max **41.3/119.9/214.5**, critical-path waiting p90 86.0, aggregator wait p90 23.2,
6 results after 120 minutes, 22 waiting-dominated. Removals: 38 merged, 8 failed checks, 3
`checks_timed_out`:

- #3586, 15:59:30, [40516494080](https://github.com/picoduck/wollipog/actions/runs/40516494080):
  **all-green**, as described in the findings.
- #3718, 17:59:49, [40536475525](https://github.com/picoduck/wollipog/actions/runs/40536475525):
  no failure; shards 1, 4 and 5 started 115–126 minutes after creation and were cancelled after
  ejection.
- #3586, 20:02:24, [40555792344](https://github.com/picoduck/wollipog/actions/runs/40555792344):
  no failure; five browser shards and WebKit never received a runner in 2h04m.

## Replay Model

`--scenario` replays every collected job that held a runner. Each job becomes ready at its
observed creation time and runs for its observed execution time on `capacity` uniform slots,
first-come first-served unless a category is prioritized. A merge group's modeled
required-result time recomputes every executed job's finish: modeled creation plus modeled
runner wait plus observed execution. A job created later than the run waits in the model for the
last of its dependencies, using the merge-queue report's dependency model. The aggregator therefore
waits for every required branch, so a model result never falls below the slowest branch's
execution. Assumptions, stated with every result:

- In the slot replay itself, creation times stay as observed, so jobs whose dependencies finish
  sooner do not compete for slots earlier. This slightly understates contention under small
  capacity increases.
- Execution time does not change with load. The macOS limit of five is ignored (macOS jobs are 3.1%
  of allocations). Jobs cancelled before a runner stay unrun.
- Fewer cancellations, faster merges and changed author behavior are not modeled. The model ranks
  options; it does not predict exact latency.

Calibration: at 20 slots the model gives trial p50/p90 40.1/69.2 against observed 39.2/65.9
(151 runs), and October 27–28 46.4/97.5 against observed 41.0/100.2 (66 runs whose executed jobs
could all be replayed, of 67).

| Scenario | Trial Group p90 (Observed 65.9) | Trial Groups > 60 / > 120 | Oct 27–28 Group p90 (Observed 100.2) | Oct 27–28 > 60 / > 120 | Trial PR Job Wait p90 |
| --- | ---: | --- | ---: | --- | ---: |
| 20 slots, today | 69.2 | 20 / 4 | 97.5 | 16 / 5 | 73.1 |
| 20, merge groups served first | 46.8 | 2 / 0 | 47.3 | 0 / 0 | 78.5 |
| 20, PR browser `max-parallel: 2` | 62.8 | 19 / 4 | 84.6 | 12 / 5 | 80.1 |
| 20, no PR Chromium shards 2–5 on ~50% of PRs | 47.4 | 2 / 0 | 61.9 | 8 / 0 | 32.3 |
| 20, no PR Chromium shards 2–5 on any PR | 43.5 | 1 / 0 | 40.7 | 0 / 0 | 9.1 |
| 20, no superseded-PR canceller or cleanup monitor jobs | 66.7 | 18 / 4 | 83.0 | 12 / 5 | 70.5 |
| 20, no Platform Isolation on PRs | 61.7 | 16 / 2 | 73.7 | 10 / 2 | 61.6 |
| 20, no `windows-2025` Platform Isolation lane (upper bound) | 66.2 | 18 / 3 | 83.4 | 12 / 4 | 67.0 |
| 25 slots | 47.3 | 5 / 0 | 56.4 | 4 / 1 | 42.6 |
| 30 slots | 41.0 | 2 / 0 | 42.1 | 1 / 0 | 28.7 |
| 40 slots | 39.9 | 0 / 0 | 36.5 | 0 / 0 | 10.2 |
| 60 slots (GitHub Team) | 39.4 | 0 / 0 | 36.3 | 0 / 0 | 0.0 |

The "~50% of PRs" row drops shards for PR runs with an even run ID, a stand-in for an unknown
eligible fraction. #3630's routing is inactive and its eligible fraction is WS2's measurement.

## Options

Savings are modeled from the table above unless marked measured. Runner-minutes are elapsed
execution from the trial cohort (17,015 per working day: PR 7,208, merge groups 5,203).

### Capacity

| Option | Modeled Effect | Cost | Risks and Dependencies | Rollback |
| --- | --- | --- | --- | --- |
| **C1. GitHub Team for the organization** (60 concurrent standard jobs) | Group p90 65.9 → 39.4 (trial), 100.2 → 36.3 (Oct 27–28); PR wait p90 73 → 0; no modeled timeout | $4 per user per month ([pricing](https://github.com/pricing), read 2026-10-28); 1 filled seat today. Standard runners stay free for public repositories. No runner-minute charge. | Organization billing decision and payment method (human). Seat count grows with members. Higher concurrency raises workflow API traffic (health/controller budgets are per invocation and remain bounded). | Downgrade to Free; no repository change to revert. |
| C2. GitHub Support concurrency increase | Unknown size | None stated | GitHub documents that Support can raise concurrency limits; eligibility on Free is not documented. | None needed. |
| C3. Larger runners reserved for merge groups | Equivalent to "merge groups served first" plus their own slots: p90 ≈ 39–47 | Requires Team. Linux 4-core x64 $0.012/min ([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)); at today's ~5,203 merge-group minutes per working day ≈ $62/day, about $1,500/month at unchanged minutes. Larger runners are billed for public repositories. | Execution on 4 cores is unmeasured, so minutes may fall. A runner-label change to `ci.yml`. | Revert the label. |
| C4. Self-hosted runners for trusted events only | Like C3 at hardware cost | No GitHub platform charge per the billing page read 2026-10-28; hardware and operations not priced. | Public repository: must never run pull-request code; restrict to `merge_group` and `main` dispatch. Needs a separately authorized operator and host. Never the Wollipog hosting machine. Overlaps #3509's finalizer label. | Remove the label and deregister. |

### Admission

| Option | Modeled Effect | Cost | Risks and Dependencies |
| --- | --- | --- | --- |
| A1. Activate #3630 PR routing | ~50% routed: trial p90 47.4, Oct 27–28 61.9; 100%: 43.5/40.7. PR wait p90 also falls. | Removes four of five Chromium jobs per routed PR; shards 2–5 are 67% of PR CI runner-minutes | Owned by #3629/#3630 and their approval; selection safety is their contract. This report only supplies the capacity value. |
| A2. PR browser `max-parallel: 2` | p90 62.8 / 84.6: small gain, PR waits worse | None | Lengthens PR feedback by about two shard durations. Not recommended. |
| A3. Runner-free superseded-PR cancellation | Removing canceller and monitor jobs: p90 66.7 / 83.0. Measured: cancelled PR jobs used 4,071 minutes (11% of PR minutes) in the trial cohort. | External poller holding `actions:write`, or a dedicated trusted runner | #3420 closed this as not planned for those reasons. Revisit only with C4. |
| A4. Stop running the shared Windows Platform Isolation steps twice | Upper bound (lane removed): p90 66.2 / 83.4. Measured: the `windows-2025` lane ran 289 jobs and 3,743 of 8,789 Platform Isolation PR minutes over October 20–28. `windows-latest` and `windows-2025` are the same image today. In 152 successful jobs, about 19 of each lane's ~21 minutes are steps both lanes run (mostly the 15–16 minute provider-HOME lease protocol). Only the native-skill steps (`windows-latest`) and the WSL boundary step (`windows-2025`, ~2 minutes) differ. | None | Merging the lanes moves about 2 minutes onto one job and removes about 19 minutes per run. If two images or a second lease-protocol sample is intended, pin `windows-2022` instead. Owner decision. |
| A5. Ready-slot discipline (at most two ready CI-heavy PRs across campaigns) | Not modeled. It is an agent operating rule, not enforcement. | None | Already in use for campaigns. Human and other-tool PRs are outside it. |

### Scheduling

GitHub-hosted runners have no job priority. "Merge groups served first" (p90 46.8 / 47.3) can only
be built from a separate pool (C3 or C4) or by keeping other demand out (A1, A3, A4). Job ordering
inside `ci.yml` cannot reserve a slot. The aggregator's waits (p90 6.8 and 23.2 minutes, 43 minutes
in the all-green timeout) are slot waits on the smallest runner, and only capacity or lower
competing demand shortens them. Requiring the work jobs directly instead of the aggregator
removes that last wait. It has the skipped-counts-as-success risk documented in
[ci-aggregation.md](ci-aggregation.md) and would be a ruleset change. Not recommended now.
Shard balance (#3628) and the Node critical path (#3627) reduce the 35-minute execution floor;
they cannot remove queue time.

### Queue Configuration

| Option | Effect | Risks |
| --- | --- | --- |
| Q1. Keep `max_entries_to_build` at 2 | Merge groups are 30% of demand. Their own wait p50 is under 2 minutes, so the binding demand is PR CI. Lowering to 1 serializes speculation without reducing PR contention. | Revisit raising it only after C1 shows idle capacity: a separate measured approval. |
| Q2. Check-response timeout 120 → 180 minutes | Estimated from observed job starts plus p90 shard execution, 4 of the 5 no-failure timeouts (#3588, #3677, #3586's first group, #3718) would have reported within 180 minutes. #3586's second group never got runners and is undetermined. Each avoided ejection saves a rebuild (group consumption p50 173 minutes in [the October 22 baseline](ci-baseline-2026-10-22.md)) plus rebuilding entries behind it. | Hides latency rather than removing it. A hung group can hold the queue 60 minutes longer. A ruleset change requiring explicit human approval. |
| Q3. Batch size (`max_entries_to_merge`) | Does not reduce built groups. | Owned by WS3's #3638 evaluation. |

## Pilot Proposals

These are exact proposals for the human owner. Nothing below has been applied or requested.

### Pilot 1: GitHub Team Capacity (Recommended)

- **Change:** upgrade organization `picoduck` from Free to Team, monthly billing, current members
  only. No repository, workflow, ruleset or runner change.
- **Window:** the next five full UTC working days after the upgrade is confirmed.
- **Measurement:** the same daily commands as above, labelled as a new cohort. Report peak running
  above 20 as proof that the limit changed, then p90 required result, timeout removals with exact
  reconciliation, PR job wait and total runner-minutes.
- **Success:** peak running exceeds 20 at least once, merge-group p90 required result ≤ 60
  minutes, and no `checks_timed_out` removal of a group with no failure.
- **Abort:** peak running never exceeds 20 on a day with more than 20 jobs ready, or any
  unexpected Actions charge appears.
- **Rollback:** downgrade to Free at the end of the billing period.
- **Approval:** a purchase and organization-plan change by the human billing owner.

### Pilot 2: Queue Timeout 180 Minutes (Only if Pilot 1 Is Declined or Delayed)

- **Change:** ruleset `main: merge queue` (ID 22200037), `check_response_timeout_minutes` from 120 to
  180. Every other field stays unchanged. Take a full readback before and after, as the October 19
  trial did.
- **Window:** five full UTC working days, a cohort separate from the #2674 trial.
- **Success:** no timeout removal of a group with no failure, and no group that exceeds 180 minutes.
- **Abort:** any queue entry held longer than 180 minutes, or a failure hidden by the longer window.
- **Rollback:** restore 120 with the same readback procedure.
- **Approval:** an explicit human ruleset decision (live policy change).

### Pilot 3: Run Shared Windows Platform Isolation Steps Once (Code Only)

- **Change:** one `platform-isolation.yml` edit through a normal reviewed PR. Run the WSL boundary
  step in the `windows-latest` job and remove `windows-2025` from both matrices. Alternatively, if a
  second Windows image is intended, pin `windows-2022`, which keeps both lanes but makes them distinct.
- **Window:** five working days of natural PR traffic touching `apps/runner/**`.
- **Success (merged lanes):** Platform Isolation PR minutes fall by about 39% (about 19 of 21.6
  minutes per `windows-2025` job), and every Windows step, including the WSL boundary, still runs and passes.
- **Abort:** a Windows-only failure that only the removed lane would have caught.
- **Rollback:** revert the PR.
- **Approval:** the follow-up issue publication and normal merge gates. No live policy change.

## Limits

- Elapsed job time is not billed usage. No invoice was read.
- The occupancy window starts at 2026-10-19T12:00Z. Jobs from runs created earlier are missing
  from the first hours, which only affects October 19, outside every reported window.
- Queue waits come from job timestamps. The reason GitHub delayed a given job is inferred from the
  concurrent count, not read from the scheduler.
- The cohorts differ in traffic and code. October 23 and 26 include the #3644 shard rebalancing and
  #3668 push-CI retirement. Neither cohort isolates a single cause.
- The organization runner listing (HTTP 403) was not readable, but every allocation reported the
  hosted runner group.
