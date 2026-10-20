# Merge-Queue Wait

The `main: merge queue` ruleset removes an entry with `checks_timed_out` when the
required check `Typecheck, Test & Sidecar Bundle` has not reported within the
queue's check-response timeout. Merge-group runs whose tests all pass have been
removed this way because their jobs waited for hosted runners, not because the
tests ran long (#2674).

`scripts/merge-queue-wait-report.mjs` measures that split. It is read-only:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs --repo picoduck/wollipog \
  [--since 2026-10-12T09:00:00Z] [--until 2026-10-14T12:46:00Z] [--timeout-minutes 120] [--json]
```

The window defaults to the last 48 hours. `--timeout-minutes` should match the
ruleset's `check_response_timeout_minutes` for that window.

For each completed merge-group CI run created in the window, it reads the jobs of
that run's first attempt, the one the queue waited on. A rerun copies the earlier
attempt's finished jobs with new creation times, so a later attempt's timeline
cannot be read as waits. GitHub creates a job when its dependencies finish, so a
job's created-to-started span is its wait for a runner. It reports median, p90,
and maximum for:

- **Run created to required result:** when the aggregator completed.
- **Critical path executing:** the summed execution of the chain of jobs ending at
  the aggregator. The jobs API does not name dependencies, so the chain follows
  `ci.yml`'s structure, which a test pins to the workflow files: the aggregator
  follows the last of its dependencies to finish, a called workflow's job (such as
  the settings-rows comparison) follows the last job of the same call to finish
  before it was created, and no other job has dependencies. A run with a job created
  late for any other reason is counted as unmeasured rather than guessed.
- **Critical path waiting:** the rest of the time to the required result.
- **Longest job wait for a runner**, **aggregator wait after dependencies**,
  **longest job execution**, and **run created to last job finished**.

It also counts runs whose required result came later than the timeout, runs whose
critical path waited longer than it executed, runs whose aggregator never ran, and
merge-queue removals by reason, listing each `checks_timed_out` removal.

## Limits

Times run from the run's creation. A run can be created well after its queue entry
(one waited over three hours), and the queue's window starts at the entry, so the
report understates the window used. Removals are read only for pull requests with
a merge-group run created in the window, up to 1,000 per pull request; the report
says when that bound cut a history short. `--since` and `--until` accept any ISO
8601 offset and are compared as instants. The report does not attribute a wait to a
cause; runner contention is the observed pattern, measured separately in #2674.

## Acceptance Measure

#2674 proposes a bounded target: over five consecutive working days with the queue
in normal use, no merge group whose jobs all pass is removed with `checks_timed_out`,
and p90 time to the required result is at most 60 minutes. Run the report over each
day of that period. Changing the queue ruleset or scheduling policy remains a
separate, human-approved operation.

## Build-Concurrency Trial: October 19, 2026

At 18:42:33 UTC on October 19, an explicitly human-approved update to the
`main: merge queue` ruleset (ID `22200037`) reduced `max_entries_to_build` from
5 to 2. A full ruleset readback matched the approved payload: that was the only
field changed. The 120-minute check-response timeout, `ALLGREEN` strategy,
required check, squash merge, bypass actors, branch conditions and maximum
merge batch of 5 were preserved. This document records the applied setting;
merging it does not apply another ruleset update.

The current workflow can request eight initial worker jobs per merge group:
unit/build, five browser shards, WebKit and settings-row change detection.
Five groups can therefore request 40 worker jobs; two request 16. Against the
20-job hosted-runner ceiling measured in #2674, this removes the queue's own
overcommitment before other workflows. It does not reserve slots or establish
that pull-request CI, cleanup, optional jobs and other demand cannot contend.
Fewer speculative builds can also reduce peak merge throughput; measure the
tradeoff rather than treating the lower limit as proof of delivery.

### Baseline

The existing read-only report measured 153 completed merge-group runs created
between October 17 at 00:00 UTC and October 19 at 18:39:31 UTC. Neither run nor
removal pagination was truncated.

| Measure | Median | p90 |
| --- | --- | --- |
| Run created to required result | 67.5 min | 131.5 min |
| Critical path waiting | 39.9 min | 109.6 min |
| Critical path executing | 30.5 min | 34.3 min |
| Aggregator wait after dependencies | 3.9 min | 26.9 min |

Waiting exceeded execution in 93 runs. The report found 23 required results
later than 120 minutes and seven `checks_timed_out` removals among the PRs it
covered. Those are different counts: a late result does not itself establish
which queue entry expired. The existing report limits above still apply.

### Verification and Completion

- Treat October 19 as a partial-day transition, including already-built groups;
  its results do not constitute a clean five-day post-change sample.
- Measure the next five full UTC working days separately: October 20, 21, 22,
  23 and 26. Each window is midnight to the following midnight; exclude the
  weekend from the five-day sample. Use the report command above with each
  day's exact `--since`, `--until` and the unchanged `--timeout-minutes 120`.
- Retain both critical-path waiting/execution and aggregator wait. Reconcile
  timeout removals with their exact merge groups and conclusions; do not count
  a manually canceled obsolete group's later failure as the reason it expired.
- The acceptance target remains no all-green group removed for
  `checks_timed_out` and p90 time to the required result at most 60 minutes
  under normal contended use. Insufficient traffic or contention is incomplete
  evidence, not a passing result. Keep #2674 open until this is demonstrated.
- If the target is missed, inspect the measurements and propose the next
  bounded change for human review. Do not silently increase the timeout, alter
  required checks, buy runner capacity or retune the ruleset. Restoring the
  old build limit is another policy change requiring explicit approval.
