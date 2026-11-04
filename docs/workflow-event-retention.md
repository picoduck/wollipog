# Workflow event retention

Workflow Event Retention is a separate per-organization opt-in policy for completed workflow
instances (#3314). It is **off by default**, including after an upgrade. Archived-history retention
does not enable it, and this policy does not prune session transcripts.

## Policy and controls

Organization owners and admins can turn **Prune Workflow Events** on in **Settings › Storage**,
under **Your Organization**. Other members can read the policy, eligibility and last-pass counts;
their controls are disabled. Enable and shorten confirmations show the proposed removal counts,
start time and kept set before saving. Opening Settings or previewing a policy never enables it.

- **Threshold:** whole days from 7 to 3650, with a suggested value of 90. Age starts at an instance's
  terminal `completed_at`, not its creation or last update. Only `succeeded`, `failed` and `stopped`
  instances with completion strictly older than the threshold are eligible. Running, queued,
  waiting, recently completed, boundary-age and missing-completion instances are retained.
- **Environment default:** the host operator can set `CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS`.
  Unset, empty and `0` mean off. Invalid values are logged and treated as off. A saved organization
  policy, including a saved off, overrides the environment. Startup logs state the default in effect.
- **Arming:** enabling or shortening waits 24 hours, including environment changes. Environment
  arming survives restarts. Turning off applies immediately; lengthening needs no new delay and
  respects any delay already pending. Each removal batch rechecks the effective policy.
- **Scope:** ownership comes from the run's workspace organization, falling back to its runner's
  organization. An instance without either known ownership is retained rather than assigned to an
  arbitrary organization's deletion policy.

`GET /api/workflow-event-retention` returns the effective policy/source, permissions, arming time,
next scheduled pass, eligible instance/event counts, and last pass. `?previewDays=N` adds counts
and the start time for that proposed threshold. `PUT /api/workflow-event-retention` accepts
`{ "retentionDays": N }`, or `null` to save an explicit off. These routes require a human organization
member; only owners and admins can write. Older control planes leave the UI disabled with an
update explanation. The optional instance marker needs no runner protocol change.

## Removed and kept

Only `workflow_events` rows and their per-transition `detail` payloads are removed.
All other tables remain intact, including:

- instance summaries: workflow identity/version, status, outcome, timestamps and transition count;
- node states and outcomes, attempts, attempt artifacts and their blob content;
- workflow definitions, multi-agent runs, sessions and their references;
- `workflow_decisions` and `workflow_decision_action_receipts` in full, including consumed grants
  and receipt claims that prevent replay;
- all session accounting, campaign records and audit records.

A durable marker records pruning time, cumulative event count, threshold and highest removed event
sequence in the same transaction as each removal. It also describes partial work interrupted by
shutdown or a policy change. Run detail shows **Event History Pruned** beside the retained workflow
and node outcomes; the API includes `eventHistoryPruned` even when no events remain. Retrying an
instance leaves its prior prune marker visible, retains its new events while running, and appends
sequence numbers above the removed range. Its next terminal completion starts a new age clock.

## Bounded maintenance and durability

The first pass starts ten minutes after control-plane startup, then an hour after each pass ends.
Each transaction removes at most 500 events and 2 MiB of detail payload; an indivisible row larger
than that byte budget is removed alone. Candidate scans inspect at most fifty terminal summaries
at a time with an indexed completion-time cursor, including sparse or already-pruned backlogs.
No event payload is copied into JavaScript. Batch sizes adapt toward four milliseconds, and the
worker yields at least three times the batch duration between batches. Concurrent pass requests
share one pass. Shutdown stops work at the next batch boundary.

Removal and its marker commit atomically under WAL `synchronous=NORMAL`, like archived-history
retention batches. The final pass record uses FULL durability and flushes the removals. An OS crash
may roll back unflushed batches; the next pass safely removes those events again. A restart continues
from the remaining eligible events. Structured logs report policy changes, pass identity, removed totals,
batch count, maximum batch duration and deferrals. Last-pass counts are also available in Storage.

SQLite `secure_delete` stays enabled. Freed database pages are reused, but pruning does not shrink
the file. WAL frames and backups retain their existing overwrite/rotation limits; see
[database durability](./control-plane-database-durability.md). This policy does not run VACUUM.

## Verification

The retention regression suite checks opt-in defaults, environment arming and saved overrides,
age/status/organization eligibility, exact kept tables and decision replay protection, payload and
row bounds, sparse cursor scans, mid-pass cancellation/relaxation/retry, restart recovery, sequence
monotonicity and page reuse across repeated create/prune cycles. Route tests cover roles and input
limits; browser and DOM tests cover confirmations, independent settings, read-only members, older
servers and the pruned workflow notice.

`pnpm benchmark:workflow-event-retention --dir <database-disk-path>` seeds 24,000 events with mixed
detail sizes, measures removal batches and event-loop delay, and requires batch p95 below 16 ms.
