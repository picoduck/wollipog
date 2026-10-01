# Obsolete Merge-Group CI

GitHub rebuilds queue integrations as entries advance or change. The CI concurrency
key uses the full queue ref, so the replacement cannot automatically cancel work
on an older ref. Never group all merge runs by base branch or PR number: other
queue entries may still need an earlier integration's checks.

`Stop Obsolete Merge-Group CI` starts on CI's `workflow_run/in_progress` event,
including reruns. It checks out the trusted default-branch commit supplied by that
event (`github.sha`), without persisted Git credentials. It never downloads
triggering-run artifacts or executes integration code. Only this separate workflow
has `actions: write`; required CI retains its existing read-only permissions,
concurrency, jobs, and required status name.

Each monitor is pinned to one repository, CI run ID, run attempt, main queue ref,
and integration SHA. Every 60 seconds it reads that run and a complete snapshot of
the main merge queue and its refs. Cancellation requires the integration ref to be
absent, and no queue entry or queue ref to reference its SHA, in two consecutive
observations. It rechecks the run and queue immediately before requesting ordinary
cancellation of that exact run. It never force-cancels or deletes runs.

With available API responses and an active monitor, persistent definitive
evidence results in a cancellation request within 150 seconds of the first obsolete
observation (60 seconds between observations plus bounded 10-second requests).
GitHub scheduling and cancellation completion are outside that bound. A monitor
exits when its target completes or changes attempt, or after 35 polls or 35 minutes,
whichever comes first; the workflow has a 40-minute budget. One small
hosted job per running merge-group CI attempt is the monitoring cost.

Unknown entries, missing heads, GraphQL errors, more than 100 refs or entries,
partial connections, and API failures retain CI. Logs identify the run and SHA and
record evidence, withheld/requested cancellation, and exhaustion. They omit API
response bodies, exception messages, and tokens. For `queue-evidence-incomplete`
or `queue-evidence-ambiguous`, inspect the current queue and refs. For
`merge_group_evidence_unavailable`, check API availability and workflow token
permissions. Never cancel a run manually solely because it is older than another.

The workflow begins operating after it lands on the default branch. Before landing,
the regression suite exercises its decision and transport paths with fake APIs;
it does not cancel live CI as a test.
