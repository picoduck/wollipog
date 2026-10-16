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
  exactly these, so a verified campaign child stays verified;
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

Out of scope: the mutation audit archive, workflow runs and their events, and the runners' own
session logs. A pruned session's runner keeps its full log until the session is deleted.

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

It can be unarchived; the record stays. It can be restarted or resumed: the agent's own context lives
with the runner and is unaffected, and new activity is numbered after the pruned range, so no event
sequence number is reused. If it is archived again, a later prune applies the same rule to the whole
session: everything outside the kept set goes, and the newest final response is the one kept.

Reprocessing a pruned session asks its runner for the full log again. If the runner still holds it,
the whole transcript returns and the prune record is cleared; a session still past the threshold is
pruned again on the next pass.

Existing transcript shares keep their own snapshot. New exports and shares contain the kept events.

## Compatibility

Pruning changes only the control plane's cache. Runners are not told, and no protocol version
changes. The hydration cursor (`hydrated_seq`, `runner_history_tail_seq`, `runner_history_epoch`)
never moves, and every runner version asks only for events after it: indexed-history runners,
legacy full-history runners, and the history preview reader. A pruned event is therefore never sent
again. A runner history-epoch change, from Reprocess or a runner that reset its log, replaces the
history as it always has.

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
