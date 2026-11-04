# True Premerge Batching Evaluation: October 28, 2026

Refs #3638 under #3625. This is a timeboxed decision document, not an adoption. It used no app
installation, account, credential grant, purchase, ruleset change or second queue. It added no
CI traffic: no dispatch, rerun or ready-for-review event. All inputs come from existing history,
public documentation, or an offline deterministic model with inert fixtures.

## Decision

**Retain GitHub's native merge queue with full merge-group validation. Do not migrate to a
true-batching queue.** The only route to a lighter merge gate remains the staged design in
#3625/#3637, and it activates only through that design's separate human approval.

**Temporary regressions on `main` are not accepted today.** The full merge gate stays. Accepting
bounded temporary regressions is the explicit price of the staged design. Approve it only with
#3637's activation, within its proposed bounds (detection ≤ 120 min, backlog ≤ 5 commits or
7,200 s, recovery ≤ 240 min), and only after its open code gaps are closed. The modeled exposure
under those bounds is in [Staged Validation Exposure](#staged-validation-exposure).

**No migration is justified** while all of the following hold. These are the
[revisit triggers](#revisit-triggers):

- the queue is idle about half the time;
- the first-attempt spurious failure rate stays near 12–15%;
- the reviewed-exact-head merge path and the #3631–#3637 machinery depend on native `merge_group`
  events.

Batching would save runner-minutes: a modeled 11–27% at today's arrival rate. Its latency gain
appears only when capacity is constrained, and it cannot reach #2674's p90 target of 60 minutes.

The rest of this document gives the evidence for each acceptance criterion.

## Sample and Method

**Window:** merge-group runs created in `[2026-10-20T00:00:00Z, 2026-10-28T22:00:00Z)`. This
covers seven working days and one weekend.

**Sampling rule:** every pull request merged into `main` since 2026-10-20T00:00Z whose squash
commit changes at least one path outside `docs/` and outside `*.md`. Dependabot PRs are excluded.
Classification uses local `git show --name-only` on each PR's merge commit, at no API cost.

| Merged PRs Since October 20 | Count |
| --- | ---: |
| Code-changing (the sample) | **150** |
| Code-changing with a readable queue timeline | 149 |
| Documentation-only (excluded) | 4 |
| Dependabot (excluded) | 7 |

Queue-level measures (arrivals, depth, merge-group outcomes, runner minutes) cover **every**
queue entry, because docs-only and Dependabot entries occupy the same queue. PR-level measures
cover the 149 sampled code PRs.

**Collection:** a merge-group-only wrapper around the existing `scripts/merge-queue-wait-report.mjs`.
For each window it calls `listRuns`, `listJobs`, `attemptRecord` and `eventSummary`, and then makes
one GraphQL timeline read per PR: enqueue, removal and reason, merge, and head pushes.

- **API cost:** 245 REST + 171 GraphQL calls for the merge-group data, 2 GraphQL search calls for
  the PR list, and 1 REST listing of rolling-validation runs. That is well inside the
  [API budget](main-ci-health-budget-2026-10-24.md). REST remaining stayed above 4,600 of 5,000.
- **Raw records:** cached outside the repository. The derived model inputs are committed as
  [`ci-premerge-batching-inputs-2026-10-28.json`](ci-premerge-batching-inputs-2026-10-28.json).
  That file holds every source run ID, first-enqueue arrival, passing execution sample and
  same-head re-enqueue delay.
- **Interpretation:** these are observations of natural traffic, not causal measurements.
  Cohort rules match the [October 22 baseline](ci-baseline-2026-10-22.md): first attempts only,
  and cancelled jobs without executed steps are unmeasured.

## Native Merge Groups Never Combine Builds (AC1)

GitHub's queue has four distinct mechanisms. Only the first two produce CI builds.

| Mechanism | Setting | What It Controls | Builds per Entry |
| --- | --- | --- | --- |
| Build concurrency | `max_entries_to_build` (live: 2) | How many queued entries may have a `merge_group` build running at once | Unchanged: one |
| Speculative combined prefix | Inherent | Each entry's build tests `main` plus every entry ahead of it plus the entry itself | One, cumulative |
| Actual CI batch | None in native | One build whose result admits several entries | Native has no such build |
| Merge/deployment batch | `min_entries_to_merge`, `max_entries_to_merge` (live: 1/5), `min_entries_to_merge_wait_minutes` (0) | How many already-passed entries land in one push to `main` | Unchanged: one |

GitHub's documentation states each point directly
([managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue);
[ruleset REST parameters](https://docs.github.com/en/rest/repos/rules)):

- **Build concurrency** is "the maximum number of `merge_group` webhooks to dispatch …, throttling
  the total amount of concurrent CI builds."
- **Merge limits**: "Merge limits do not combine `merge_group` builds. Merge limits only affect
  merges to the base branch once one or more `merge_group` has satisfied build checks."
- **What a group contains**: a PR's changes are grouped "with the latest version of the
  `base_branch` as well as changes from pull requests ahead of it in the queue."
- **Grouping strategy**: under `ALLGREEN` (live), "the merge commit created by merge queue for each
  PR in the group must pass all required checks to merge." Under `HEADGREEN`, "only the commit at
  the head of the merge group … must pass." HEADGREEN lets a later green build vouch for earlier
  entries. It does not dispatch fewer builds.

This repository's history confirms it:

- **One run per entry.** Every one of the 236 first-attempt merge-group runs has a
  `gh-readonly-queue/main/pr-<N>-<sha>` branch naming exactly one entry.
- **Multi-PR landings were still built separately.** With `max_entries_to_merge` 5, only 7 of 153
  landings combined two PRs; 146 landed alone. Each PR in a combined landing still had its own
  passing group, and each run's head SHA is that PR's landed commit. For example, #3721 and #3731
  both landed at 2026-10-27T23:42:42Z, from runs `40599833656` and `40599831387`.
- **Raising the minimum only delays builds.** Raising `min_entries_to_merge` would hold passed
  groups until more entries pass. It adds wait without removing a build.

So "increase the merge batch size" changes how commits land, not how often the full suite runs.

## Measured Inputs (AC2 Baseline)

### Arrivals and Queue Occupancy

**Entries:** 194 enqueue events, made up of 153 first enqueues and 41 re-enqueues.

**By day:**

| Day | Enqueues |
| --- | ---: |
| October 20 (Tue) | 27 |
| October 21 (Wed) | 36 |
| October 22 (Thu) | 20 |
| October 23 (Fri) | 14 |
| October 24 (Sat) | 9 |
| October 25 (Sun) | 5 |
| October 26 (Mon) | 25 |
| October 27 (Tue) | 30 |
| October 28 (Wed, to 22:00Z) | 28 |

**By hour (UTC):** the busiest hours are 02–03 (13 and 17 enqueues), 13–14 (12, 13) and 22–23
(15, 13). The quietest are 06–10 (2–5 each).

**Spacing and occupancy:**

| Measure | Value |
| --- | --- |
| Interarrival p50 / p90 | 26.4 / 159.3 min |
| Queue depth (5-minute samples) p50 / p90 / max | 1 / 9 / 16 |
| Share of samples with an empty queue | 49% |

The queue is bursty. It is idle about half the time and holds nine or more entries at its p90.
That shape limits what batching can collect: there is rarely more than one waiting entry to batch.

### Suite Duration, Latency and Outcomes

**236 first-attempt merge-group runs:**

| Outcome | Runs | Share |
| --- | ---: | ---: |
| Passing | 171 | 72.5% |
| Failing (a test job failed) | 36 | 15.3% |
| Cancelled without a failing job | 29 | 12.3% |

"Failing" includes fail-fast runs that GitHub reports as cancelled after a test job failed.
"Cancelled" is mostly speculative groups rebuilt after the entry ahead of them failed or was
removed. The queue retries by re-enqueueing, so there were no rerun attempts.

| Measure | p50 | p90 | Max |
| --- | ---: | ---: | ---: |
| Critical-path execution, passing groups (min) | 34.7 | 38.2 | 43.6 |
| Critical-path runner wait, passing groups (min) | 2.0 | 35.1 | 86.0 |
| Run created to required result, passing (min) | 39.3 | 69.7 | 119.9 |
| Run created to required result, all outcomes (min) | 39.2 | 78.3 | — |
| Last enqueue to merge, 149 sampled PRs (min) | 77.1 | 334.4 | 521.5 |
| First enqueue to merge, 149 sampled PRs (min) | 108.0 | 483.6 | 8,736.8 |

Eleven required results arrived after 120 minutes.

**Failed test jobs** (a group can fail more than one): Unit/build 15, Browser shard 1: 10,
shard 2: 6, WebKit 4, shard 3: 2, shards 4 and 5: 1 each.

Failures cluster:

- **October 22, 00:29–01:41Z:** shard 1 failed five groups across four PRs.
- **October 28, 00:16–00:55Z:** shard 2 failed four groups across three PRs.

Both clusters look like base- or infrastructure-level failures, not PR defects.

### Removals and the Spurious-Failure Rate

Non-merge removals of the 149 sampled code PRs:

| Reason | Re-enqueued, Same Head | Re-enqueued, New Head |
| --- | ---: | ---: |
| `failed_checks` | 22 | 4 |
| `checks_timed_out` | 7 | 0 |
| `manual` | 2 | 3 |

How to read these counts:

- **Most failures were not the PR's fault.** 22 of 26 failed-check removals (85%) later merged at
  the **unchanged head**. The failure therefore came from flakiness, a red base, infrastructure, or
  an interaction with an entry ahead. Only 4 of 149 PRs (2.7%) needed a new head after a failed
  group.
- **Retries are fast.** The median re-enqueue delay is 6.9 min after a failed-check removal and
  3.5 min after a timeout.
- **Multiple enqueues are common.** 26 of 149 PRs (17%) were enqueued more than once. One PR was
  enqueued seven times and built nine groups.

**Model rates:** a 12% spurious full-suite failure rate per build and a 3% defect rate per entry.
Measured failing groups are 15.3% of all groups. Excluding the failures that needed a new head
leaves 13.6%, which still includes repeat failures of the same entry.

### Runner-Minute Cost

| Measure | Value |
| --- | --- |
| Consumed runner-minutes per passing group, p50 / p90 | 178.6 / 194.3 |
| All merge-group first attempts, total (lower bound) | 40,169 runner-min: 30,573 passing, 6,344 failing, 3,252 cancelled |
| Per merged PR (160 merges, all PRs) | 251 runner-min |
| Per merged code PR (149 sampled) | 248 runner-min |
| Groups per merged code PR | 106 one, 27 two, 13 three, 2 four, 1 nine |
| Runner-minutes per critical-path execution minute (median) | 5.19 |

**Rolling validation adds a second full suite.** Rolling full validation already runs after every
merge, on top of the full merge-group gate. From October 23 to 28 (22:00Z) it executed 60 runs
(53 success, 7 failure, plus 19 cancelled pending runs) for 85 merges. That is **0.71 rolling full
runs per merge**, with run wall time p50 / p90 of 46 / 85 min. Today every merge therefore pays
about 1.47 merge-group suites plus about 0.7 rolling suites.

Rolling validation already batches naturally: one run validates every merge since the previous
one.

**Cost:** actual billed cost is unavailable. These are elapsed runner-minutes, not invoices.

## Modeled Comparison (AC2)

### Model

[`scripts/premerge-batching-model.mjs`](../scripts/premerge-batching-model.mjs) replays the 153
measured first-enqueue times. It draws build durations from the 171 measured passing executions,
and draws same-head retry delays from the 38 measured re-enqueues. It is a seeded discrete-event
model: 20 seeds, with quantiles pooled across seeds. It reads no clock or network.

```sh
node scripts/premerge-batching-model.mjs --inputs docs/ci-premerge-batching-inputs-2026-10-28.json
node scripts/premerge-batching-model.mjs --inputs docs/ci-premerge-batching-inputs-2026-10-28.json --set slots=1
node --test scripts/premerge-batching-model.test.mjs
```

**Designs.** Each design shares a pool of `slots` concurrent full suites. The 20-job runner
ceiling holds two eight-job suites before PR CI contends for it.

- **Native** builds one speculative cumulative group per entry, up to `depth` at once. `HEADGREEN`
  is the tuned native variant.
- **Batch** builds one suite per batch of up to N entries, with `depth` speculative batches in
  flight. A failing batch splits by bisection or one at a time. Optionally it retries the batch
  once before splitting.
- **Staged** runs native ordering over a fast gate with its own small-job pool. One rolling full
  validation of `main`'s tip runs at a time. #3633-style holds admit only reverts while any full
  verdict is unresolved (a spurious failure holds too, until a passing rerun), the backlog exceeds
  5 commits, or the oldest unvalidated commit is older than 120 min. A hold withdraws ordinary
  entries already building. A failed verdict schedules a revert only for defects in the snapshot
  it tested, `repairMinutes` (20) later; a revert whose fast build flakes is retried on the same
  delay. Ordinary same-head retries draw from the measured re-enqueue delays, whose tail includes
  one 7,408-minute (five-day) human gap.

**Assumptions** (all overridable with `--set`): 12% spurious full-suite failures and 3% defective
entries.

**Unmeasured inputs, and how they move the results:**

- **Fast-gate inputs** (10 min, 40 runner-min, 4% spurious failures, 60% defect catch) are
  unmeasured, because no fast group has run. Staged results scale with these values.
- **Interacting changes** are not a separate rate. In a speculative native group, or in a batch
  with an entry ahead, a pair interaction behaves like a defect of the later entry. Native and
  batch designs both catch it before landing. The staged design catches it only after landing, in
  rolling validation.

### Calibration

At two slots, the native model's median sojourn (38 min) is close to the measured passing build
latency (39.3 min), but it understates queue sojourn: the model's p50 / p90 is 38 / 114 min,
against 77 / 334 measured from the last enqueue.

The model leaves out several real delays:

- runner contention from PR CI;
- manual dequeues;
- clustered failures;
- check timeouts;
- human hand-offs.

At one slot the model gives 100 / 286 min, which brackets the measured values. The tables below
show both slot counts. The real queue sits between them.

### Results at Today's Arrival Rate

Minutes. "Builds" are full suites per merged entry, including cancelled builds.

| Design | p50, 2 Slots | p90, 2 Slots | Builds | Runner-Min / Merge | p50, 1 Slot | p90, 1 Slot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native, depth 2 (live) | 38.3 | 113.6 | 1.26 | 220.5 | 100.4 | 285.7 |
| Native, depth 5 | 38.1 | 119.4 | 1.28 | 220.9 | — | — |
| Native, depth 2, HEADGREEN | 37.5 | 98.2 | 1.12 | 202.5 | 100.4 | 285.7 |
| Batch 2, depth 1, bisect | 59.6 | 145.3 | 0.95 | 170.9 | — | — |
| Batch 4, depth 1, bisect | 53.1 | 124.8 | 0.90 | 162.0 | 53.1 | 124.8 |
| Batch 4, depth 1, one-by-one | 54.2 | 133.5 | 0.91 | 163.7 | — | — |
| Batch 4, depth 1, retry then bisect | 52.0 | 122.4 | 0.90 | 161.8 | — | — |
| Batch 4, depth 2, bisect | 37.5 | 87.8 | 1.13 | 197.2 | 71.5 | 148.9 |
| Staged fast gate + rolling | 10.0 | 37.0 | 0.83 | 193.7 | 10.0 | 37.0 |

**Mean landing size** for a size-4 batch is only 1.34, because the queue rarely holds four
waiting entries.

### Results Under Higher Load

These rows compress the same arrival trace by ×2 and ×3. Values are p50 / p90 latency and
runner-minutes per merge.

| Design | ×2, 2 Slots | ×3, 2 Slots | ×2, 1 Slot | ×3, 1 Slot |
| --- | --- | --- | --- | --- |
| Native, depth 2 | 76 / 209, 224 | 148 / 370, 225 | 368 / 829, 210 | 879 / 1,648, 210 |
| Native, HEADGREEN | 66 / 158, 200 | 124 / 292, 199 | Same as native | Same as native |
| Batch 4, depth 1, bisect | 64 / 198, 130 | 82 / 278, 113 | 64 / 198, 130 | 82 / 278, 113 |
| Batch 4, depth 2, bisect | 44 / 108, 172 | 52 / 145, 157 | 89 / 222, 139 | 108 / 324, 122 |
| Staged | 10 / 48, 161 | 16 / 90, 145 | 10 / 48, 161 | 16 / 90, 145 |

**Failure-rate sensitivity** (today's rate, 2 slots), comparing a 5% spurious rate with 12%:

| Design | p90 at 5% | p90 at 12% | Builds per Merge at 5% | Builds per Merge at 12% |
| --- | ---: | ---: | ---: | ---: |
| Native | 81 | 114 | 1.13 | 1.26 |
| Batch 4, depth 1 | 97 | 125 | 0.84 | 0.90 |
| Batch 4, depth 2 | 68 | 88 | 1.03 | 1.13 |

### Comparison by Concern

- **Small-batch wait.** A batching queue that builds one batch at a time (bors-style depth 1)
  makes most entries wait for the batch ahead. At today's rate that raises the median from 38 to
  52–60 min, because there is little to batch. Speculative batching (depth 2) matches native on
  the median and lowers p90 from 114 to 88 min. It keeps less than half of the runner saving:
  197 runner-min per merge, against 162 at depth 1 and 220 for native.
- **Good-path throughput.** Native capacity is about `slots × 1,440 / 34.7 / 1.26 ≈ 33` merges per
  day per full-suite slot. Peak weekdays brought 30–36 enqueues, so one effective slot is already
  at saturation. That matches the measured queue-depth p90 of 9.
  - Batch 4 needs 0.63–0.90 builds per merge, which is 1.4–2× native's capacity per slot. At one
    slot and ×2–3 load it is the only stable full-gate design.
  - Raising `max_entries_to_build` beyond real capacity changes nothing: depth 5 behaves like
    depth 2.
- **Failed and flaky batches.** A spurious failure in a batch triggers a split. At today's 12%,
  that is about 6 splits per nine days at batch 4, and about 11 at ×3.
  - Bisection costs fewer builds than one-by-one: the fixture with one defect in eight entries
    takes 7 builds against 9.
  - Retrying a batch once before splitting halves the number of splits, but lengthens p90 under
    load (278 to 340 min at ×3).
  - Correlated base or infrastructure failures, like the October 22 and 28 clusters, fail every
    batch and every bisection step. They waste more builds than in native, where each entry
    fails once.
- **Interacting changes.** Native and batch designs both catch a combination failure before it
  lands, because each build contains every entry ahead. A batch that fails only through an
  interaction bisects down to the later entry. With HEADGREEN, an entry whose own cumulative group
  failed can land if a later group passes. That later group includes it, so no untested
  combination lands. The intermediate `main` commit itself was never green, however.
- **Revert retesting.** A revert in a native or batching queue is an ordinary entry that runs the
  full suite before landing: one or more extra builds. In the staged design a revert needs a fast
  build plus a rolling full validation of the restored tip. The model counts 1.9 reverts per nine
  days at a 60% fast-gate catch rate.
- **Head and base updates.** Native: the `--match-head-commit` enqueue binds approval to the exact
  head. Behavior on a later push to an already-queued PR is not documented on the pages read. A base update needs no rebuild,
  because each group is rebuilt on the current queue state.
  - Batching tools differ: see [Candidate Batching Queues](#candidate-batching-queues). Aviator
    automatically requeues a new head. Trunk fails a PR updated at merge time. Mergify dequeues a
    batch when its branch is edited.
  - No candidate offers an enqueue-time expected-SHA parameter.
- **Preservation of reviewed exact heads.** Native squash lands the tested group commit (group head
  SHA = landed SHA, above). Trunk and Mergify (merge/squash/rebase methods) land each PR at its own
  head as a separate commit. The batch is tested once, but the landed squash commits are created
  afterwards, so the exact landed commits were never individually tested. This is the same
  property as HEADGREEN's intermediate commits.

### Staged Validation Exposure

At today's arrival rate, with an unmeasured 60% fast-gate catch rate and a 3% defect rate, the
model estimates the following per nine-day trace:

| Measure | Modeled Value |
| --- | ---: |
| Escapes to `main` | 1.9 |
| Red minutes on `main` | 224, about two hours per escape |
| Ordinary merges landed while a defect was live | 2.1 |
| Admission hold minutes | 685, about 5% of the trace |

Most hold time comes from spurious full verdicts, which hold admission until a passing rerun; at a
5% spurious rate holds fall to 375 minutes. Holds rise to 725 and 838 minutes at ×2 and ×3, where
the staged p90 reaches 48 and 90 minutes as backlog and age holds start to limit throughput.

**Sensitivity to the fast gate's catch rate:**

| Fast-Gate Catch Rate | Escapes | Red Minutes | Hold Minutes |
| ---: | ---: | ---: | ---: |
| 90% | 0.7 | 76 | 623 |
| 30% | 3.4 | 380 | 785 |

The fast gate's real coverage is the dominant unknown, and #3637 must measure it before anyone
accepts temporary regressions.

## Candidate Batching Queues

Sources are public documentation only, read 2026-10-28. Nothing was installed or signed up for.

| Concern | Mergify | Trunk Merge Queue | Aviator MergeQueue | Graphite | bors-ng |
| --- | --- | --- | --- | --- | --- |
| One suite per batch | Yes ([batches](https://docs.mergify.com/merge-queue/batches)) | Yes ([batching](https://docs.trunk.io/merge-queue/optimizations/batching)) | Yes ([batching](https://docs.aviator.co/mergequeue/concepts/batching)) | Private beta ([optimizations](https://graphite.com/docs/merge-queue-optimizations)) | Yes, `staging` branch ([repository](https://github.com/bors-ng/bors-ng)) |
| Failure split | Parallel split up to `max_parallel_checks`; attempts cap | Bisection, separate concurrency | Bisection | Parallel isolation or bisection | Halves |
| Flake handling | `max_checks_retries`; a later passing batch can vouch | Optimistic merging; pending-failure depth | Optimistic validation; retriable checks (beta) | Not documented | None |
| Squash and linear history | Yes: one commit per PR at its own head ([strategies](https://docs.mergify.com/merge-queue/merge-strategies)) | Squash default; separate commit per PR | Squash supported; fast-forward mode | Squash; PRs may show **closed**, not merged | Merge commit per batch; squash closes PRs |
| Native queue | Incompatible: disable the rule or exempt the app ([rulesets](https://docs.mergify.com/merge-queue/github-rulesets)) | Turn off "Require merge queue" ([migration](https://docs.trunk.io/merge-queue/migrating-from-github-merge-queue)) | Not documented | Not compatible ([merge queue](https://graphite.com/docs/graphite-merge-queue)) | Not applicable |
| Ruleset bypass | Exempt bypass on every ruleset | Exempt on a "restrict updates" ruleset ([protection](https://docs.trunk.io/merge-queue/getting-started/configure-branch-protection)) | Exempt for fast-forward | "Always allow" bypass ([setup](https://graphite.com/docs/set-up-merge-queue)) | Pushes `main` |
| App permissions | Contents, PRs, Checks, Actions, Workflows write; Administration read ([security](https://docs.mergify.com/security)) | Not documented for the queue app | Contents, PRs, Checks, Workflows, Actions write ([permissions](https://docs.aviator.co/manage/github-app-permissions)) | Actions, checks, contents, PRs, workflows write ([privacy](https://graphite.com/docs/privacy-and-security)) | Contents, PRs, statuses, checks write |
| New push while queued | Batch branch edit dequeues | `PR_UPDATED_AT_MERGE_TIME` failure | Automatically requeues the new head | Not documented | `up_to_date_approvals` option |
| Expected-SHA enqueue pin | Not found | Not found; API takes number only ([submit](https://docs.trunk.io/merge-queue/reference/api-v2/mergequeues/submit-a-pull-request-to-a-merge-queue)) | Not found | Not found | Not applicable |
| Public price | Open source $0; Max $21/seat/month ([pricing](https://mergify.com/pricing)) | Free ≤ 5 committers; open source by contact ([billing](https://docs.trunk.io/setup-and-administration/billing)) | Team $20/dev/month ([pricing](https://www.aviator.co/pricing)) | Team $40/user/month ([pricing](https://graphite.com/pricing)) | Free, self-hosted |
| Data | Clones temporarily; SOC 2 Type II | No full-codebase storage; flaky-test data kept 45 days ([security](https://docs.trunk.io/setup-and-administration/security)) | Not documented; self-hosted option | Stores tokens and logs | Self-run |
| Vendor risk | Hosted SaaS | Hosted SaaS | SaaS or Helm/Compose | Batching in beta | **Archived** 2024; README points to GitHub's native queue |

`picoduck/wollipog` is public, so Mergify's open-source tier and Trunk's open-source contact may
apply. A public price is not an approved purchase.

## Compatibility, Operations and Risk (AC3)

### Rulesets and Merge Authority

Ruleset `22200037` (`main: merge queue`) is live with squash merges, linear history, the required
aggregator `Typecheck, Test & Sidecar Bundle` (integration 15368), `ALLGREEN` grouping, a 120-minute
timeout, and an OrganizationAdmin bypass only.

**A batching vendor would require all of the following:**

1. **Turn off the native rule.** The `merge_queue` rule would have to be disabled. After that,
   `gh pr merge <n> --squash` would no longer enqueue.
2. **Add a third-party bypass actor.** The app needs Exempt or "Always allow" bypass, with
   contents, workflows and actions **write** access on a repository that ships agent and runner
   code.
3. **Re-implement exact-head enforcement.** Typed `pr_merge` decisions bind approval to
   `gh pr merge URL --squash --match-head-commit SHA`. No candidate exposes an enqueue-time
   expected SHA, so this would need dismiss-approvals-on-push plus a custom pre-enqueue check.
4. **Re-port the #3631–#3637 machinery.** These components key off `merge_group` events and native
   queue state:
   - the merge-group gate;
   - `merge-group-cleanup`;
   - `merge-queue-wait-report`;
   - #3633's queued-entry holds and the proposed `Regression Admission` required context;
   - the documentation for #2674's queue trial.

   Every one would need a port to the vendor's queue, or would be lost.

Items 1 and 2 are a persistent permission grant plus a governance and ruleset change. Each is
human-only.

### Queue Recovery

- **Native:** recovery is documented in [Main Merge Recovery](main-merge-recovery.md) and
  [Merge-Group Cleanup](merge-group-cleanup.md).
- **Vendor:** a vendor outage would stop all merges unless its bypass were used manually. The
  fallback is to re-enable the native rule, which is a ruleset change. Entries are not transferred
  between queues.

### Operating Cost

**Native:** no new cost. It keeps paying about 1.47 full suites per merge for merge groups and
about 0.71 for rolling validation.

**Batching at today's rate:** about 58 runner-min saved per merge at depth 1, against the modeled
native cost (220 → 162). That is roughly 1,450 runner-min per 25-merge working day, but it raises
median latency. Depth 2 saves about 23 runner-min per merge.

**Staged design:** saves most where it matters for latency. Merge-group full suites are replaced by
fast builds, and rolling validation already runs.

### Data Retention and External Access

Every hosted candidate receives repository metadata, CI results and (except where noted) a
temporary clone. Retention is published only for Trunk's flaky-test data (45 days). Any adoption
would need a separate data-handling review.

### Migration and Rollback

**Migration** would take these steps:

1. Install the app with the bypass.
2. Disable the native rule.
3. Port the agent merge path and the typed-gate command.
4. Port measurement and admission.
5. Retrain contributor guidance in `AGENTS.md` and the skills.

**Rollback** reverses steps 1–2 through a ruleset change. Entries queued at rollback must be
re-enqueued.

## Recommendation (AC4)

**Path:** keep the native queue with full merge-group validation. Pursue the staged design only
through #3637's approval. Do not adopt a batching queue.

**Why:**

1. **Little to batch.** The queue is idle 49% of the time and its median depth is 1. A size-4
   batch averages 1.34 entries.
2. **Latency does not improve enough.** Depth-1 batching worsens median latency at today's rate.
   Speculative batching improves p90 by about 25 min but cannot reach p90 ≤ 60, and keeps less
   than half of the runner saving.
3. **Flakes cost batching more.** Spurious failures (12–15% per build, often clustered) are the
   largest cost driver in every full-gate design. They cost a batching queue more, through split
   cascades, than they cost native. Reducing them (#3636, #3628) helps every option: native p90
   drops from 114 to 81 at a 5% spurious rate.
4. **Migration has high authority and integration cost.** Every hosted candidate needs native-queue
   removal, a write-scoped bypass app, and a rebuilt exact-head control. The existing #3631–#3637
   investment would be stranded.
5. **Capacity is the binding constraint.** Batching's real advantage appears at one effective slot
   or ×2–3 load. #2674's capacity and admission options, being measured in a parallel workstream,
   address that directly without changing merge authority.

**Temporary regressions on `main`:** not accepted under the current gate. The staged design is
the only modeled option that meets a sub-60-minute p90 at today's and twice today's arrival rate
(37 and 48 min). Accepting its bounded
regressions is a separate human decision at #3637 activation, with the exposure modeled above.

### Revisit Triggers

Reopen a batching evaluation only if **both** of the following hold:

- A human declines bounded regressions on `main` permanently, or #3637 cannot close its code gaps.
- One of these is measured:
  - sustained arrivals at or above about 60 entries per working day;
  - an effective full-suite capacity at or below one slot after #2674's changes;
  - a spurious failure rate at or below 5%, which makes batch splits cheap.

**Adoption proposal:** none. Batching is not selected. If the triggers fire, a pilot would need a
separately authorized test repository with inert fixtures. Trunk and Mergify are the two candidates
that document true batch CI, per-PR squash commits at each PR's own head, and linear history.

## Limits

- **Single window.** One nine-day window, including a weekend. The October 22–23 and October 28
  failure clusters weigh heavily on it.
- **Removal reasons only.** Failure causes come from removal reasons and job names. No logs were
  read, so the 85% same-head figure does not separate flakes from red base or infrastructure
  failures.
- **Shared runner pool not modeled.** The model has no PR-CI contention, manual dequeues or
  timeouts. Its absolute latencies are lower bounds for native; compare designs within a column.
- **Assumed fast-gate inputs.** Fast-gate duration, cost, spurious rate and catch rate are
  assumptions. Staged results are conditional on them.
- **Unverified vendor claims.** Vendor statements are documentation claims, unverified by any
  trial. Items marked "not documented" or "not found" were not confirmed either way.
