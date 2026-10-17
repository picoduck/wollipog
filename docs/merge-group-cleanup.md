# Obsolete Merge-Group CI

GitHub rebuilds queue integrations as entries advance or change. The CI concurrency
key uses the full queue ref, so the replacement cannot automatically cancel work
on an older ref. Never group all merge runs by base branch or PR number: other
queue entries may still need an earlier integration's checks.

`Stop Obsolete Merge-Group CI` starts on CI's `workflow_run` `in_progress` and
`completed` events for merge-group runs, including reruns. A completion wakes it
because a failing group is what makes the integrations behind it obsolete. It
checks out the trusted default-branch commit supplied by that event (`github.sha`),
without persisted Git credentials. It never downloads triggering-run artifacts or
executes integration code. Only this separate workflow has `actions: write`;
required CI retains its existing read-only permissions, concurrency, jobs, and
required status name.

## One Monitor for the Whole Queue

One monitor watches every active merge-group CI attempt (#2674). Its job has the
concurrency group `merge-group-cleanup` without cancelling in progress, so at most
one monitor runs and one waits; a newer waiting monitor replaces an older one, which
loses nothing because each scans the queue itself. The group sits on the job, not
the workflow: every CI event starts the workflow, and a skipped pull-request
invocation must never replace a waiting monitor.

Hosted runners are what merge-group CI waits for, and the organization's plan
allows 20 concurrent jobs. The earlier design started one monitor per merge-group
attempt, so a queue building five integrations held five runners just to poll.
The shared monitor holds at most one.

## Cancellation Evidence

Every 60 seconds the monitor lists the newest 100 merge-group CI runs and reads one
complete snapshot of the main merge queue and its refs. It judges each active
attempt (repository, run ID, run attempt, main queue ref, and integration SHA)
separately. Cancellation requires the integration's ref to be absent from the
complete ref listing, and no queue entry or queue ref to reference its SHA, in two
consecutive observations of that attempt. It then re-reads that run and the queue
immediately before requesting ordinary cancellation of that exact attempt, and
does not ask again while the cancellation takes effect. An attempt that drops out
of the active listing, or a new attempt of the same run, must earn two fresh
observations. It never force-cancels or deletes runs.

With available API responses and an active monitor, persistent definitive
evidence results in a cancellation request within 150 seconds of the first obsolete
observation (60 seconds between observations plus bounded 10-second requests).
GitHub scheduling, including the monitor's own wait for a runner, and cancellation
completion are outside that bound. The monitor exits as soon as no merge-group CI
is active, or after 35 polls or 35 minutes, whichever comes first; the job has a
40-minute budget. When it exits at its budget, the next merge-group CI event starts
another.

Unknown entries, missing heads, GraphQL errors, more than 100 refs or entries,
partial connections, and API failures retain CI. A run older than the newest 100
merge-group runs is not watched; it only keeps running. Logs identify each run,
attempt, and SHA and record evidence, withheld/requested cancellation, idle exit,
and exhaustion. They omit API response bodies, exception messages, and tokens. For
`queue-evidence-incomplete` or `queue-evidence-ambiguous`, inspect the current queue
and refs. For `merge_group_evidence_unavailable`, check API availability and
workflow token permissions. Never cancel a run manually solely because it is older
than another.

The workflow begins operating after it lands on the default branch. Before landing,
the regression suite exercises its decision and transport paths with fake APIs;
it does not cancel live CI as a test. To see how much merge-group CI waits for
runners, see [Merge-Queue Wait](merge-queue-wait.md).
