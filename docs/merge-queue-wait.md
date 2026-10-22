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

## Event, Attempt, and Test Measurements

Use `--all-events --json` for version-2 records of `pull_request`, `merge_group`,
and `push` CI (pushes to `main` only). This mode includes cancelled, skipped and
unfinished attempts. The original completed-merge-group view above is preserved
for comparisons with #2674. A PR's worker admission is evidence of the existing
draft/ready workflow guard; the API does not preserve the historical draft event
payload, and an all-skipped/no-worker run has unmeasured readiness. Do not infer
historical readiness from the PR's current draft flag.

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events --since 2026-10-20T00:00:00Z \
  --until 2026-10-21T00:00:00Z --json > oct20.json
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events --since 2026-10-21T00:00:00Z \
  --until 2026-10-22T00:00:00Z --json > oct21.json
node scripts/merge-queue-wait-report.mjs --input oct20.json --input oct21.json --json
```

Version-2 windows are half-open (`since <= createdAt < until`); GitHub's inclusive
listing is filtered locally. Combining reports deduplicates repository/run/attempt
identities, removal identities (repository/PR/time/reason), and queue-merge episodes.
The latest collected snapshot wins for an overlapping attempt. It recomputes
nearest-rank percentiles from raw attempt metrics, with measured sample counts;
never average daily percentiles. Do not combine different repositories or assumed
cost rates. Partially collected windows retain their truncation flags after combining.

Each attempt records repository, event, API head SHA, run ID, attempt number,
check-suite/workflow IDs, source workflow path/revision, timestamps and window.
Nested jobs have IDs, outcomes and timestamps; steps have their API number within
the job, outcome and timestamps. `sha` is the API's head SHA. For PRs that is not
proof of the tested merge-ref SHA: `testedSha`/`suiteRevision` stay null until a
matching timing projection supplies `GITHUB_SHA`. The executed workflow revision
is likewise unavailable from the run listing alone; a matching projection supplies
`GITHUB_WORKFLOW_SHA`, separately from the head/source SHA. The workflow blob SHA
is explicitly unmeasured. These records measure observations; they cannot certify
releases or equivalent code across events.

Outcomes are `passing`, `failing`, `cancelled`, `skipped`, `unfinished`, or
`unmeasured`. Missing/negative durations remain null. Elapsed runner-minutes sum
non-skipped jobs with complete timestamps; `measuredRunnerMinutes` is a lower
bound when jobs are missing, and `consumedRunnerMinutes` is null if evidence is
incomplete. All-skipped/no-job attempts have no measured consumption. First
attempts and reruns have distinct cohorts. Rerun outcomes use the attempt endpoint,
not the latest run conclusion. GitHub can copy jobs into reruns; waits, execution
totals and required-result latencies for reruns remain unmeasured rather than
double-counting copied work. A failing first attempt followed by a passing attempt
is a retry-only **run outcome**, not proof of a flaky test or infrastructure cause.

Job/step timing reveals setup and shard overhead. Non-test overhead sums steps
outside the named unit/browser/production test steps; it includes builds, caches,
setup and post-job work, so it is not a pure install-time estimate. Browser shard
imbalance reports observed/expected counts, completeness, max-minus-min and
max/min job elapsed times. It includes setup; per-test timing is a separate source.
Queue history records a surviving enqueue through merge, if both events exist.
An intervening non-merged removal clears the entry; a successful `merged` removal
can precede its merge event and preserves the entry. Missing entries stay unmeasured. These
are PR episodes, not causal attribution to one merge-group run. Queue history and
removals cover only PRs observed in the merge-group cohort.

All API paths are read-only (GraphQL POSTs contain queries only). Listings cap at
10 pages of 100 per event, per job attempt and per PR history, and 10 attempts per
run; run/job requests use at most six workers. GitHub's 1,000-run search cap is
reported as truncation, not completeness. Narrow windows when truncated. API
errors fail the command with content-safe diagnostics; they never become an empty
successful measurement. The collector dispatches, reruns and cancels nothing.

### Content-Safe Test Timing

Ordinary CI uses `pnpm test:ci` with the same complete Node inventory/timeouts as
`pnpm test`. An additional reporter emits one `ci-timing-v1` JSON line. Browser
development, WebKit and production reporters emit the same schema. Existing
reporters, retries, fail-on-flaky behavior and exit statuses remain intact.
Only counts, duration, retry index, state and SHA-256 identities are emitted;
test titles, errors, stdout, inputs, screenshots and attachments are excluded.
No artifact upload or additional CI run is introduced.

The projection keeps the slowest 20 files and tests, at most 5,000 file accumulators,
and an explicit truncation flag. Node file duration sums outermost tests/suites to
avoid counting nested execution twice; individual test durations are inclusive.
Browser file duration sums observed test attempts, including retries; this is not
wall time. Retry-only test counts describe passing retry attempts, including
expected-failure semantics; they do not override `failOnFlakyTests` or classify a
root cause. Partial/cancelled runs may never emit a summary. A summary is not a
complete test inventory or a source of failure text.

File IDs hash repository-relative POSIX paths. Resolve them at the exact suite
revision with `git ls-files` and SHA-256 of each path (without a trailing newline).
Node test IDs hash `<fileId>:<line>:<column>:<title>`; browser test IDs hash
`<fileId>:<JSON titlePath>`. Titles remain on the checked-out source side. These
IDs change when source identity changes; compare only compatible suite revisions.

To read projections from natural CI, select at most ten job IDs that the same
version-2 window collects:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events --since <start> --until <end> \
  --timing-job <node-job-id> --timing-job <browser-job-id> --json
```

This opt-in reader streams up to 16 MiB per job, retains at most ten validated
projection lines, never writes log bytes, and never forwards the GitHub credential
to the signed blob host. Unsupported log hosts, unavailable/expired logs, missing
projections, and capped reads remain explicitly unmeasured/partial. Hashes and
numeric fields are validated and re-projected; unknown fields are discarded.
Log output is untrusted evidence, not approval or certification authority.

Cost remains separate from elapsed time. No invoice, allowance, paid rate or
billed-minute evidence is available to this collector. Optionally supply
`--assumed-usd-per-minute <rate>` with `--all-events` for a labelled hypothetical
uniform USD rate times measured elapsed minutes. This excludes missing/rerun
timing and billing rounding, OS multipliers, free allowances and storage; it is
neither actual cost nor a claim that a cancellation's entire duration was wasted.
There is no default price assumption.

### Future Validation Lag

The version-2 summary reserves `validationLag` with state `not-yet-measurable`
and null values until #3631/#3632 supply authoritative rolling validation.
Given a compatible passing exact snapshot and an observation time, compute:

- `oldestUnvalidatedChangeAt` from the first uncovered main commit/merge;
  its age is observation time minus that timestamp.
- `commitsBeyondSnapshot`/`mergesBeyondSnapshot` from a complete ancestry walk
  between the passing snapshot and observed main. A non-ancestor is unknown.
- `failureDetectedAt` and `detectionLagMinutes` from authoritative failed full
  validation and the first implicated unvalidated change, if attribution exists.
- `restoredAt` and `restorationMinutes` from the next compatible complete passing
  baseline and the incident's authoritative detection timestamp.

Store `lastPassingSnapshotSha`/`lastPassingSnapshotAt` and the incident timestamps
with the suite revision. Missing ancestry, stale/incomplete health, cancelled
validation and unknown attribution remain null, never zero or a healthy baseline.
Existing push CI is not the rolling validator. No current lag values are invented.

The reproducible [October 22 baseline](ci-baseline-2026-10-22.md) compares the
existing trial evidence with two full UTC days of normal traffic.

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
