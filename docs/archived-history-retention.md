# Archived-history retention

The control plane caches every session's transcript in its database. Without retention, archived
sessions keep that cache forever, and the database grows without bound (#2777). Archived-history
retention lets an organization prune the transcripts of sessions archived longer than a threshold,
keeping a compact record of each one.

Retention is **off by default**, including after an upgrade. Nothing is pruned until an organization
owner or admin, or the host operator, turns it on.

## Policy

- **Threshold.** Whole days after archiving, from 7 to 3650. The suggested value is 90.
- **Scope.** One policy per organization. Every member can read it; only owners and admins can
  change it.
- **Environment default.** `CONTROL_PLANE_ARCHIVED_HISTORY_RETENTION_DAYS` in `control-plane.env`
  sets the policy of every organization that has not saved its own. Unset, empty or `0` is off. A
  value outside 7–3650 (or not a whole number) is logged as invalid and treated as off. A saved
  organization value, including a saved off, overrides it. The startup log states the default in
  effect.
- **Delay.** Turning retention on, or shortening the threshold, takes effect 24 hours later, so a
  mistake can be undone before anything is deleted. Lengthening the threshold or turning retention
  off applies at once. The environment default arms the same way, from the first start that saw its
  current value.
- **Age.** A session's age is the time since it was archived (`archived_at`). Unarchiving clears it,
  and archiving again starts a new clock. Sessions archived before this setting existed take the
  later of their last update and last activity, which is never earlier than their real archive time,
  so none is pruned early.

**Settings › Storage** holds it, with "Your Organization" as its scope:

- **Prune Archived History.** The switch. Turning it on, like shortening Prune After, first shows a
  danger confirmation with what the new policy would prune (sessions and, roughly, events) and when
  it starts. Turning it off saves at once.
- **Prune After.** The threshold in days. While the switch is off it holds the value the switch will
  use (90 until changed); while it is on, a change saves when the field loses focus.
- **Eligible Now** and **Last Pass.** What the policy would prune now, when pruning starts or the
  next pass runs, and what the last pass pruned.
- A neutral notice names the host's environment default while it is the policy in effect. Members
  who are not owners or admins see the rows read-only, with the reason. A control plane that
  predates retention leaves them disabled, asking for an update.

`GET /api/archived-history-retention` returns the policy, where it comes from, when pruning may
start, when the next pass runs, how many archived sessions (and roughly how many events) it would
prune, and the last pass's totals. `?previewDays=N` adds the same counts for a threshold of `N` days,
for confirming a change before saving it. `PUT /api/archived-history-retention` with
`{ "retentionDays": N }` or `{ "retentionDays": null }` saves the organization's policy.

## What is pruned

A session is pruned when it is archived, its archive is older than the threshold, it has settled
(`completed`, `failed` or `stopped`), and no Stop is pending. Pruning removes:

- every cached event outside the kept set below: tool calls and their updates, file edits and diffs,
  command output and stderr, reasoning, intermediate and streamed agent messages, permission and
  question events, checkpoints, errors, and status events;
- their transcript search rows;
- their links to large-payload artifacts, then those artifacts and their blob files.

## What is kept

Kept as events, so the transcript still shows them and search still finds them:

- every prompt (`user_message`);
- the session's final response: every part of its last top-level agent message;
- every turn completion and final-flagged report. Campaign report proofs and assignment checks read
  exactly these, so a verified campaign child stays verified. Live claude-code and codex-app-server
  answers stream without the flag, so a live session keeps only its final response; an adopted
  transcript flags every answer final, and keeps each one;
- every `token_usage` event, the evidence Claude cost corrections are reconciled against;
- control-plane attachment events, which no runner can supply again.

Measured on 1,317 real sessions, the kept events are about 3% of transcript bytes.

Kept in full, because they live outside the transcript:

- cost accounting: usage buckets, session token and cost totals, the per-model breakdown, campaign
  attribution and budgets, and cost-correction receipts. No total changes;
- campaign ledgers, work items and verifications, and workflow decisions;
- session metadata: title, status and stop cause, agent, model and effort, project, timestamps,
  preview, cost, pull-request links, parent and child links, attention and acknowledgments;
- session attachments, which keep their own 180-day expiry.

Separate policies cover the [mutation audit archive](#mutation-audit-archive-retention) and
[workflow event retention](./workflow-event-retention.md). Workflow event retention ages terminal
instances from completion, with its own Storage controls and environment default. These policies
are independent. Capable runners also trim their session logs after a completed control-plane prune,
as described [below](#runner-logs-and-upgrades).

## Mutation audit archive retention

The host operator alone can enable this separate policy with
`CONTROL_PLANE_MUTATION_AUDIT_ARCHIVE_RETENTION_DAYS` in `control-plane.env`, then restart the
control plane. There is no API, agent tool, organization override or UI setting. Unset, empty or
`0` keeps every archive row forever. Whole days from **7 to 3650** are accepted (suggested **90**);
invalid values are logged and treated as off. Startup logs state the effective days and arming time.

Enabling or shortening waits **24 hours** from the first startup that observes the new value.
The deadline survives restarts; restarting with an unchanged value does not delay it again.
Lengthening adds no delay (an existing pending deadline still applies). Turning it off applies
immediately. Re-enabling after a startup that observed off arms anew. Changes made and undone
between starts are not observed.

Only `mutation_audit_archive` rows with original request `created_at` strictly older than the
threshold are removed; the time they moved into the archive is irrelevant. Every boundary or newer
archive row is kept. The hot `mutation_audit` table's 180-day/newest-100,000 window, its archival
transaction, and all status-0 crash-intent rows are unchanged. A short archive threshold can therefore
remove a row soon after the existing hot-table sweep archives it. Actor/resource deletion still
cannot cascade into the archive.

The first background pass waits 10 minutes after startup, then passes run an hour after the previous
one ends. An age index avoids full-archive scans. Each deletion transaction removes at most 500 rows;
the budget starts at 100 and adapts toward 4 ms, resting at least 1 ms and three times the batch's
duration after every nonempty batch. A pass stops after 1,000 batches and resumes at the next pass.
Stopping interrupts between batches; a restart safely resumes by finding the remaining old rows.

No per-request tombstone or per-day aggregate remains. One singleton summary stores the policy and
arming deadline, cumulative deleted count, and the latest pass's finish time, cutoff and removed
count. Each cumulative increment commits with its deletions; the last-pass summary describes that
pass, so an interrupted process can leave its prior last-pass summary alongside updated cumulative
totals. Structured pass logs include run ID, counts, duration, maximum batch time and interruption or
batch-limit status. Failures log a warning and retry next pass. Removal batches use the same NORMAL
WAL durability as history pruning; completing a pass performs a durable summary write. `secure_delete`
stays on; pages are reused rather than shrinking the database, and WAL/backups retain their usual
limits described below. The initial upgrade builds the age index over existing archive rows, so
that one-time schema step can take longer on a large archive.

`mutation-audit-archive-retention.test.ts` covers default/invalid off, limits, persistent arming,
strict age boundaries, the hot/crash-intent kept set, bounded yielding batches, interruption,
concurrency, rollback, summary totals, indexed selection and scheduling.
`pnpm benchmark:mutation-audit-archive-retention [--dir <path>]` measures file-backed deletion batch
latency with representative maximum-length attribution fields and fails at p95 >= 16 ms.

## How a prune runs

A background pass starts 10 minutes after the control plane starts, then runs an hour after each pass
ends. It never runs during startup.

Each session is pruned in short transactions of at most 500 events or 2 MiB of payload. Removing
indexed text is the dominant cost (2–5 ms per KB with FTS5 secure-delete), so each batch's event and
text budgets adapt toward 4 ms, and the pass rests three times as long as each batch took: pruning
uses at most about a quarter of the event loop. Each batch tests the kept set on at most 1,024 rows
past where its run has read through, so a long stretch of kept rows costs one bounded read per
batch, never a read of the whole session. A run interrupted by a restart, by unarchiving, or by the
policy being turned off continues or closes at the next pass.

The last step of each session records when it was pruned, how many events were removed and under
which threshold, and gives the session a new event epoch, as crash recovery does. Open dashboards
then reload the transcript, campaign and work-item proofs move to the new epoch with their kept
report events, and accounting keeps its epoch (`accountingEventEpoch`), so cost corrections are not
fenced. The session's tool-call count, which guardrails and campaign budgets read, keeps counting
the removed tool calls. Their ids are kept, so a campaign allowance granted after a prune charges
each of them once: a history replaced later, whether it brings them back or not, never charges them
again or drops them. A run that finds a later final response than the one it started with (delayed
history can add one) reads the session again from the first row, so only the latest is kept.

Removal batches commit without their own WAL flush, like runner ingest: a batch an OS crash rolls
back is removed again by the next pass. The final step flushes, and blob files are deleted only
after it, so a crash can never restore an artifact row whose blob is gone. See
[database durability](./control-plane-database-durability.md).

## Deletion guarantees and limits

- `secure_delete` stays on, so removed rows are overwritten in the database file.
- The transcript search index has FTS5's own `secure-delete` option set, so a removed row's terms
  leave the index rather than staying behind as delete markers. This needs SQLite 3.42 or later, which
  every supported Node.js bundles. Terms deleted before the option was set stay until the index
  merges their segments.
- Search rows are deleted by key. New search rows are written with their event's row id; rows
  indexed earlier are mapped to their events once, in paced steps, before the first prune. If an
  older build has written to the database since, the mapping starts again from the first row: that
  build numbers its rows from the highest one left, which a prune may have lowered below rows
  already mapped.
- The database file does not shrink: freed pages are reused, so it stops growing. To return the
  space, stop the control plane and run `sqlite3 control-plane.db 'VACUUM'`, which needs as much free
  disk as the database itself. The control plane never vacuums automatically: on its single
  connection a vacuum would block every request for as long as it takes.
- WAL frames and existing backups keep old content until they are overwritten or rotated. Blob files
  are unlinked, not overwritten.

## Pruned sessions

A pruned session stays in the archive with its metadata, cost and kept events. Its session view
carries `historyPruned` (when, how many events, which threshold) and `archivedAt`.

- **Archived Sessions** shows a neutral **History Pruned** badge beside its lifecycle; the badge's
  tooltip gives the date and the threshold.
- **Opening it** shows a compact **History Pruned** notice above the transcript, one line saying how
  many events went and when; its Show Details says under which threshold, what kind went, and what
  was kept. The kept events follow. Load Earlier Activity gives no count, since a pruned history
  has gaps, and a session with nothing kept says so instead of "ended before anything was sent".
- **Before it is pruned**, an archived session's Session Archived notice says on which date its
  history will be pruned under the current policy.
- **Search** finds it by its metadata and its kept prompts and final response; a transcript hit
  says "History Pruned" in its details.

It can be unarchived; the record stays. It can be restarted or resumed: the agent's own context lives
with the runner and is unaffected, and new activity is numbered after the pruned range, so no event
sequence number is reused. If it is archived again, a later prune applies the same rule to the whole
session: everything outside the kept set goes, and the newest final response is the one kept.

Reprocessing an adopted pruned session asks its runner for the full log again. Once that runner
has trimmed it, Reprocess explicitly reports that full history cannot be restored; it leaves the
cached transcript and prune record unchanged. If an older runner still holds the full log, the
whole transcript returns and the prune record is cleared; a session still past the threshold is
pruned again on the next pass. Provider-native transcripts outside the runner store are not a
restoration promise and are never deleted by this policy.

Existing transcript shares keep their own snapshot. New exports and shares contain the kept events.

## Compatibility

Control-plane-only pruning remains compatible with older runners. A protocol-v231 runner
advertises `runnerHistoryRetention`; only a capable runner receives `trim_session_history`.
Older control planes send no such command, and older runners retain their complete logs.

### Runner logs and upgrades

There is **no separate runner switch or operator opt-in**. The same organization policy controls
runner trimming: off by default, 7–3650 whole days after archiving (suggested 90), the same
`CONTROL_PLANE_ARCHIVED_HISTORY_RETENTION_DAYS` default, and the same 24-hour delay on enable or
shorten. After the control plane finishes pruning a fully hydrated, archived, settled session with
no Stop pending, it asks its capable runner to trim through that exact runner epoch and sequence.
There is no additional grace period. A pass also retries already-pruned sessions, so offline
runners catch up when online.

**Upgrade effect:** an organization that already enabled archived-history retention also enables
runner trimming as soon as both components support it. An already-armed policy does not receive
another 24-hour delay on upgrade. Previously pruned sessions can lose their runner's full log on
the next retention pass. Back up runner data before upgrading if that full history is needed, or
turn the organization policy off before the upgrade. Existing policies that are off remain off.

The runner keeps the control-plane transcript kept set plus approval, permission and question
decisions, review, workflow, automation and provenance events, checkpoints and other resume
evidence. It retains unknown additive event kinds conservatively. Removed tool-call ids remain
in a hashed accounting sidecar, without their command/output text, so resuming or adding a tool
limit never resets its lifetime count. Session metadata, native resume ids, costs and usage are
unchanged. Provider-native transcripts outside the runner store are out of scope.

Copying reads 64 KiB slices and yields to live I/O, with bounded record buffers. Kept data is
written into immutable segments targeting 1 MiB (a single record can exceed that target, up to
the existing history-page record limit). An index is built during the copy and named by the same manifest, so data and index switch together. At most one retention copy runs per runner, including after a control-plane request times out. The writer lock is
free during copying; any live provider or changed source wins and defers trimming. New files
are flushed before an atomic manifest switch; a crash before it keeps the original readable,
and a crash after it keeps the complete retained log readable. The next pass finishes unlinking
superseded generations, including the original monolithic log. Open-file deletion failures are
retried. Files are unlinked, not securely overwritten.

Completion logs count the bytes of superseded files actually unlinked, consistently on the first
pass and on cleanup retries. This is a deletion counter, rather than the net change in directory
size after allocating kept data and its derived index.

The runner keeps its event sequence high-water and epoch. Only certified gaps in the retained
prefix are permitted; appends after that boundary remain contiguous. Control-plane hydration
cursors, accounting epochs and campaign proofs do not change. Resume and restart use the same
provider-native state and allocate new events above the old boundary. Re-archiving and pruning
again keeps all prompts and reports plus the newest final response under the same rules.

Retained manifests use format 2; older runner binaries fail closed on that format. To downgrade
a trimmed runner, stop it and restore its pre-upgrade runner-data backup with the older binaries;
do not point an older binary at the retained data. A control-plane downgrade does not recover
removed data. Existing exports, shares and backups retain their own snapshots.

## Guards

- `archived-history-retention.test.ts`: the policy is off by default, arms after the delay and
  relaxes at once; the environment default and organization overrides; the exact kept set, with
  search rows and payload artifacts of removed events gone and kept prompts still searchable;
  campaign proofs, accounting epoch, tool-call counts and the hydration cursor unchanged; no reused
  seq after unarchiving; a campaign allowance granted after a prune; eligibility; bounded batches
  with rests between them, and a long kept stretch read one window per batch; an interrupted run
  ending where an uninterrupted one does; unarchiving or turning retention off mid-run; reprocessing;
  legacy and colliding search rows, including an older build's row numbered below a finished scan;
  and runners of protocol 53 and current never asked for pruned events.
- `archived-history-retention.size.test.ts`: over 40 create, archive and prune cycles of about 2,000
  events each, the file grows by under 10% of what an unpruned cycle adds (about 5% when measured),
  free pages are reused, and no search row, payload artifact or blob of a removed event remains.
- `db.test.ts`, "archived-history prune removals commit without a WAL flush, and closing a run
  flushes".
- `pnpm benchmark:archived-history-retention [--dir <path>]` prunes sessions with the indexed-text
  mix measured in real logs and fails if a batch's p95 reaches 16 ms. Point `--dir` at the disk that
  holds the database.
- `apps/web`: `ArchivedHistoryRetentionPanel.dom.test.tsx` (off until confirmed; shortening is
  confirmed, lengthening and off are not; limits; read-only members; older control planes),
  `archived-history-retention.test.ts` (the copy and the prune date), the History Pruned badge in
  `ArchivedSessionsView.dom.test.tsx`, the notice in `TranscriptReadingStates.dom.test.tsx`, and
  Settings › Storage in every section-wide check of `e2e/settings-sections.spec.ts`.
