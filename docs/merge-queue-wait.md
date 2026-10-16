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
that run's attempt. GitHub creates a job when its dependencies finish, so a job's
created-to-started span is its wait for a runner. It reports median, p90, and
maximum for:

- **Run created to required result:** when the aggregator completed.
- **Critical path executing:** the execution of the dependency that finished last,
  plus the aggregator's own execution.
- **Critical path waiting:** the rest of the time to the required result.
- **Longest job wait for a runner**, **aggregator wait after dependencies**,
  **longest job execution**, and **run wall time**.

It also counts runs whose required result came later than the timeout, runs whose
critical path waited longer than it executed, runs whose aggregator never ran, and
merge-queue removals by reason, listing each `checks_timed_out` removal.

## Limits

Times run from the run's creation. A run can be created well after its queue entry
(one waited over three hours), and the queue's window starts at the entry, so the
report understates the window used. Removals are read only for pull requests with
a merge-group run created in the window. The report does not attribute a wait to a
cause; runner contention is the observed pattern, measured separately in #2674.

## Acceptance Measure

#2674 proposes a bounded target: over five consecutive working days with the queue
in normal use, no merge group whose jobs all pass is removed with `checks_timed_out`,
and p90 time to the required result is at most 60 minutes. Run the report over each
day of that period. Changing the queue ruleset or scheduling policy remains a
separate, human-approved operation.
