# Control-plane database durability

The control plane keeps one SQLite connection (`ControlPlaneDb.open` in
`apps/control-plane/src/db.ts`) in WAL mode. This page records which commits wait for a disk flush,
what an OS crash or power loss can therefore roll back, and how the runner's retained event log
recovers it.

## Settings

- `journal_mode=WAL`.
- `busy_timeout=250` (`CONTROL_PLANE_DB_BUSY_TIMEOUT_MS`). Exactly one control plane owns a
  database file, and in WAL mode readers and SQLite-aware backups (`VACUUM INTO`, the online backup
  API) never block its writes. Only another writer, such as test seeding or a manual edit, can
  hold the write lock. A statement that meets that lock now waits up to 250 ms instead of failing
  at once with `SQLITE_BUSY`. The wait blocks the event loop, so it stays short: a lock held longer
  still fails fast, and periodic work defers its tick as before.
- A second connection beside a running control plane, such as a test that inspects or adjusts its
  database, uses `ControlPlaneDb.attach`, never `open` (#3789). `open` applies the schema and runs
  startup work, so it takes the write lock repeatedly. An attached connection applies no schema,
  can be read-only, and waits up to 10 s (`ATTACHED_DB_BUSY_TIMEOUT_MS`) for the server's lock.
  Its own commits skip the WAL sync, so they release the lock well within the server's 250 ms wait.
  It never collects artifact blobs, because only the owning server knows which blobs it is staging.
  Read-only suits only plain queries, since some reads settle derived state (`getSession`).
- `synchronous=FULL` on the connection: every commit flushes the WAL before it returns, so a
  control-plane decision is durable once it has been acknowledged.
- Live runtime snapshots (`session_runtime_updated`) stay `FULL` but are grouped. After
  registration a runner republishes one snapshot per retained session, and a separate flush for
  each held newer live snapshots back for tens of seconds under disk contention (#2601). A run of
  up to 32 consecutive queued snapshots from one runner, for distinct sessions, now commits in one
  transaction (`updateSessionsFromRuntimeSnapshots`). Nothing about the run is broadcast or sent
  to a runner until that commit returns, and a failed commit rolls back the whole run. A snapshot
  with stop, decision, hook, policy, media or cost-repair work keeps its own commit, in order. The
  event loop still yields between runs. A crash before a run commits loses only frames that nothing
  has acknowledged yet, and the runner republishes them when it next registers.
- `secure_delete=ON`: SQLite overwrites deleted ordinary-table content with zeros rather than
  leaving session text, credentials or decision content recoverable from free pages in the main
  database file. The extra delete I/O is an intentional privacy tradeoff; reducing maintenance
  scans does not relax it. The transcript search index also has FTS5's own `secure-delete` option
  set, so a deleted row's terms leave the index instead of remaining as delete markers (#2777). This
  is still not complete storage erasure: WAL/journal files, backups, and external artifact blobs
  need their own retention handling.
  See [SQLite's secure-delete documentation](https://sqlite.org/pragma.html#pragma_secure_delete)
  and the [index/sweep measurements](./session-event-index-and-sweep-performance.md).
- Runner-replayable event ingest is one exception. `appendEvent` called with a runner sequence
  number and `appendHydratedPage` switch the connection to `synchronous=NORMAL` for their own
  transaction and back to `FULL` afterwards (`replayableCommit`). They are relaxed only in WAL mode
  (outside WAL, `NORMAL` can corrupt the file), and never for a transaction that carries a
  `token_usage` event (see below).
- [Archived-history retention](./archived-history-retention.md) removal batches are the other
  (`relaxedCommit` in `pruneArchivedHistoryBatch`). A removal is idempotent, so one an OS crash
  rolls back is removed again by the next pass. The step that closes a session's prune is `FULL`,
  and payload blob files are deleted only after it, so a restored artifact row never points at a
  missing blob.
- Checkpoints run on a worker thread (`WalCheckpointer` in `apps/control-plane/src/wal-checkpointer.ts`),
  started by the control plane after it opens the database. About every 250 ms the worker runs
  `wal_checkpoint(PASSIVE)` on its own connection, which uses `synchronous=FULL`. PASSIVE never
  takes the write lock and never waits for one, so the main connection's readers and writers never
  wait for the worker; frames it cannot copy yet wait for the next pass. While the worker runs, the
  main connection's automatic checkpoint is raised from SQLite's default of 1,000 pages to a
  backstop of 16,384 pages (64 MiB at 4 KiB pages). The backstop fires only when the worker falls
  behind, stops checkpointing, or has died, and the log stays bounded in each of those cases. One
  case it cannot bound: a worker checkpoint that hangs inside the kernel, on storage that stops
  completing flushes, keeps SQLite's checkpoint lock, so the backstop's own checkpoints return busy
  and the log grows until the flush completes. No checkpoint can make progress then. Before the
  worker, the same hang froze the event loop inside the commit that ran the checkpoint; now
  ingest continues, so the hang is reported instead. The worker counts each pass it completes in
  shared memory, whether or not the pass copied anything, and the main thread reads that count
  about every 5 seconds without a message round trip. If a running worker completes no pass for
  30 seconds, the control plane logs one warning, `WAL checkpoint worker stalled; no checkpoint pass
  has completed`, with the time since its last completed pass (`sinceLastPassMs`) and the log's
  size in bytes (`walBytes`, read off the event loop during the stall; `null` if no reading
  arrived). It warns once per stall, not on every check. When a pass completes again it logs
  `WAL checkpoint worker recovered` once, with `stalledMs`. A worker that is stopped, disabled, or
  waiting to restart is never reported, and the check never blocks or throws into the event loop.
  The warning only reports the hang: nothing in the control plane can end it. A worker that exits
  or fails to start is logged and restarted after 1, 5, then 30 seconds (back to 1 second once a worker has
  stayed up for a minute); the control plane never depends on it. A clean shutdown stops the
  worker after one last checkpoint pass. The main connection's commits are unchanged by any of
  this: `journal_mode` and `synchronous` are exactly as above. Tools and tests that open the
  database without starting the worker keep SQLite's default automatic checkpoint.
- The worker runs only on a SQLite with the fix for the
  [WAL-reset bug](https://sqlite.org/wal.html#the_wal_reset_bug): 3.51.3 and later, or the 3.44.6
  and 3.50.7 backports. The bug needs two connections writing or checkpointing the same file at
  once, which a single connection never does and the worker would. Node bundles its SQLite, so on
  an older runtime (Node 22.13 bundles 3.47.2) the control plane logs that the worker is disabled
  and keeps checkpointing on its own connection at SQLite's default threshold, as before.

Before the worker, the automatic checkpoint ran inside whichever commit crossed 1,000 pages, so it
copied the log and flushed both files on the event loop in the middle of event ingest. On the
same synthetic database at 600 streamed events per second with 8 dashboards, that alone set the
delivery p95 (about 16 ms); see #2761 for the measurements.

Flushing every streamed event capped ingest near 150 events per second, because each flush blocks
the control plane's only thread. Measured on a local NVMe SSD with 500 sessions and about 220,000
events, 10 streaming sessions and 6 dashboards:

| Measurement                                | Every commit flushed | Event ingest relaxed |
| ------------------------------------------ | -------------------- | -------------------- |
| `appendEvent` p50                          | 5.1 ms               | 0.07 ms              |
| Runner-to-dashboard p50 / p95, 200 events/s | 1.4 s / 2.9 s        | 0.5 ms / 9 ms        |
| Runner-to-dashboard p50 / p95, 300 events/s | 4.4 s / 8.6 s        | 0.5 ms / 12 ms       |

## Optional incremental vacuum

`CONTROL_PLANE_DB_INCREMENTAL_VACUUM=1` opts the **host** into paced free-page reclamation (#3321).
It is off by default; unset, empty and `0` are off, invalid values warn and are off. There is no
organization/API/UI override. Like #2777, an observed off-to-on transition arms for **24 hours**,
persisted across restarts; observed off disables immediately at startup and reenabling arms anew.
Only enabled new empty databases choose `auto_vacuum=INCREMENTAL` before schema creation. Existing
files require the [explicit offline conversion](./archived-history-retention.md#one-time-offline-conversion).
Startup never runs full `VACUUM` and refuses incremental maintenance on an unconverted database.

The offline operator CLI is
`pnpm db:enable-incremental-vacuum --db <existing-file> --owner-stopped [--temp-dir <directory>]`.
Stop all owners/readers/backups first, from outside the hosting stack, and verify a SQLite-aware
backup. The command requires exclusive SQLite access and pins SQLite's temp directory. On both
the database and temporary-file filesystems it requires free bytes of at least
`2 × N + max(256 MiB, ceil(N / 10))`, where `N = max(page_count × page_size, main-file bytes)`.
Unknown or insufficient space, missing acknowledgement or failed locking refuses before setting
auto-vacuum mode or starting the full rewrite. Unsupported temp-directory control also refuses.
The same filesystem needs that amount once. Other writers can consume space after the check;
the margin is headroom, not a disk reservation. Exclusive locking cannot prove an idle rollback
handle is closed, so operator downtime remains mandatory. Conversion preserves WAL mode and
logical records; failures require inspection before restart. It is never a live maintenance step.

Once armed, maintenance starts 10 minutes after startup and hourly after the preceding pass ends,
independently of retention. It starts only with at least **256 free pages**, then drains in **1–32-page**
steps, initially one page, adapting toward **4 ms above the measured one-page cost** and resting
at least **1 ms and 3× work time** after every step. Each pass caps at **1,000 steps**: at 4 KiB pages,
at most about **128 MiB per hourly pass**, with warmup and slower storage reducing that throughput. A 2 GiB reclamation takes
more than 16 passes. It is not an emergency full-disk recovery mechanism.

One-page samples estimate the fixed cost of a `FULL` commit, so sync latency alone cannot pin
the budget at one page (#3575). A faster multi-page step lowers that estimate, so an initial
latency spike cannot keep it inflated. Growth is at most doubling per step. Complete steps reaching
**12 ms** reduce the next page budget proportionally toward **8 ms**, regardless of the baseline,
leaving headroom below the 16 ms target. These estimates cannot guarantee a bound on arbitrary I/O.

Each step runs with the main connection's normal **`synchronous=FULL`**, outside retention's or
ingest's relaxed transactions. No replay, approval, accounting or privacy guard is weakened;
`secure_delete=ON` and FTS5 secure-delete are unchanged. Only for the synchronous maintenance
call, `busy_timeout` is zero so lock contention defers instead of blocking for the request path's
250 ms; it is restored in `finally`, without an asynchronous gap. Steps are independent SQLite
transactions; interruption safely leaves the remaining free list for the next pass. Retained
records do not change. WAL checkpoints, worker settings, backstops and SQLite-version guards are
unchanged. Shrinkage becomes visible as ordinary checkpoints apply the WAL's truncation; a reader
can delay it. No forced checkpoint is added.

Startup logs report mode/arming; pass logs report reclaimed pages/bytes, p95/max complete-step
latency, average reclaimed pages per step (`pagesPerStep`), slow-step count and stop/limit state
with a run ID and entry point. Busy/errors defer to the next pass; the first step >=16 ms warns once per pass.
`pnpm benchmark:incremental-vacuum [--dir <fixture-parent>]` creates a disposable
file-backed fixture, checks kept data and physical shrinkage, and measures complete steps alongside
ordinary `FULL` writes and the existing checkpoint worker, failing at **p95 >=16 ms**. The 16 ms
target requires measurement on the operator's storage, not an unconditional timing guarantee.

On a Linux/Node 24.18.1 NVMe fixture with 16,000 indexed records, the worker and concurrent `FULL`
writes, the updated adaptation reclaimed **50.24 MiB in 10.89 seconds** (about **4.61 MiB/s** during
the pass): **411 steps**, averaging **31.29 pages/step**, with **8.73 ms p95 / 10.46 ms max**.
The fixture drained before the 1,000-step cap; this is a measured example, not a guaranteed hourly rate.

Backups and restores retain their existing SQLite-aware consistency, durability, privacy and
rotation requirements. A restored pre-conversion backup retains `auto_vacuum=NONE` and needs
conversion again; startup does not rewrite it. A converted backup retains incremental mode.
Persisted arming state is backed up too: an enabled environment can resume an already mature
deadline after restore, so leave it off if maintenance should remain disabled. Shrinking allocation
does not erase old content from WAL, backups or external artifact storage.

## What a Crash Can Lose

**A control-plane process crash, kill, or out-of-memory exit loses nothing.** Committed WAL frames
are already in the operating system's page cache.

**An OS crash or power loss never corrupts the database.** WAL frames are checksummed, and recovery
discards an incomplete tail. It can roll back only relaxed commits that no later flush has covered:
an event-ingest transaction, or a retention removal batch, whose events then reappear until the next
retention pass removes them again.

The WAL is flushed by every `FULL` commit (that is, any other write: a status change, a prompt, a
decision) and by every checkpoint that copies frames: a worker pass, about every 250 ms while the
log has frames, or the automatic checkpoint (the backstop at 16,384 pages while the worker runs,
1,000 pages otherwise). A pass that has nothing it may copy does not flush; that happens while a
reader on another connection still uses the frames, and the control plane holds no long-lived
reader. A flush covers the whole file, so it also makes every earlier relaxed commit durable. The
exposure is therefore the run of event commits since the most recent other write or flushing
checkpoint: while the worker keeps up, about a quarter of a second of streaming; otherwise up to
the automatic threshold. The same holds for the final pass at shutdown, and an exit without one
leaves the committed log for the next open to recover, as it always has. The operating system
usually writes those pages back within seconds, but nothing guarantees it.

A rolled-back ingest transaction takes with it everything it wrote in the same transaction:

- the event rows and their transcript search entries;
- the session's hydrated-history cursor;
- the session preview, last-activity time, and message count;
- campaign-report rebinding, background-continuation projection, usage coverage, and event-artifact
  links.

Large payloads are published as artifacts before their event row. Their blobs are made durable
off the event loop first, including a WAL flush of their pending-write rows; their artifact rows
then commit relaxed, like the event row (`createStagedEventPayloadArtifacts`). An artifact row that
rolls back leaves a durable pending row, so startup removes its blob. An artifact whose event rolled
back is left unreferenced, and startup collects it (`collectOrphanedEventPayloadArtifacts`).
Re-ingesting the event republishes the same content-addressed bytes. See
[large session-event payloads](./large-event-payloads.md).

Nothing else is exposed, because every other write still flushes at its commit:

- prompts and queued messages;
- permission and workflow decisions, including the consumption of single-use approvals;
- runner, device, and agent credentials and their revocation, and transcript-share revocation;
- settings, governance and audit records, and session status;
- events the control plane writes itself, which carry no runner sequence number (artifact
  attachments, runner disconnect and reconnect notices, question attribution);
- `token_usage` events and usage retention maintenance.

Usage events stay `FULL` because replay could not restore them faithfully. On reconnect the
runner's snapshot reaches the control plane before the lost events are pulled again, and
`reconcileUsageSnapshotInTransaction` books the missing usage as flat totals and marks it covered.
The replayed event is then skipped, losing its cache breakdown, and a provider that reports no
cost would be priced as if nothing were cached. A `FULL` commit flushes every earlier relaxed
commit too, so a rolled-back run of events never contains a usage event.

Relaxing the whole connection was rejected for this reason. A rolled-back consumption or revocation
has no other copy, so it would silently re-enable a used approval or a revoked credential.

## How the Runner's Log Recovers Lost Events

The runner keeps every event it has sent in its session store (`apps/runner/src/session-store.ts`):
an append-only log plus lossless compaction segments, retained for as long as the runner holds the
session. The control plane's hydrated-history cursor rolls back in the same transaction as the
events, so after a crash the control plane is consistently behind rather than holding gaps.

1. The control plane restarts, and the runner reconnects and re-registers.
2. The runner republishes each session's durable tail (`session_runtime_updated`, sent by
   `publishNegotiatedSessionSnapshots`). The control plane records the larger tail and marks the
   session's cached history incomplete (`reconcileRunnerHistoryInTransaction`). It does not pull
   anything yet.
3. The missing events are pulled when the first of these happens:
   - **The session's next live event.** `onSessionEvent` (`apps/control-plane/src/sessions.ts`) sees
     a runner sequence number that is not the cursor plus one. It does not store the event out of
     order; it calls `hydrateHistory` instead.
   - **Any read of the session's history.** `GET /api/sessions/:id/events` and the child-session page
     route call `hydrateHistory`. Event reads, including reads without `limit`, return a bounded
     cached page immediately while hydration runs in the background. Until it finishes, responses
     report `cacheComplete: false`; consumers must keep paging or retry the same cursor when empty.
     See [the events API migration guide](./session-events-api.md).
   - **Campaign verification**, which force-hydrates the child session.
4. `hydrateHistory` requests contiguous pages from the cursor (`session_history_page`) and applies
   them with `appendHydratedPage`.

A session's rolled-back rows are always a suffix of runner events, because any other write would
have flushed everything before it. The recovered events take the next free per-session sequence
numbers. If the control plane writes its own event to the session before they return (a reconnect
notice, for example), those numbers differ from the ones dashboards saw before the crash.

## Keeping Open Dashboards Consistent

A dashboard caches each transcript in memory under the session's event epoch and, after a
reconnect, fetches only events above its old position. Within one epoch a sequence number must
therefore always name the same event. The control plane keeps that true across a rollback:

1. At startup it compares the host's boot identity with the one stored in `control_plane_metadata`
   (`host_boot_id`). On Linux that is `/proc/sys/kernel/random/boot_id`; elsewhere it is the boot
   time derived from the system uptime, compared with a 60-second tolerance. Only an OS crash or
   power loss can roll a commit back, and both reboot the host. When the boot is unchanged, as on
   every ordinary control-plane restart, none of the steps below apply.
2. After a reboot, each session is watched until its cache catches up with the runner's durable
   tail reported since startup: a runtime snapshot or history page reports the tail, and the session
   is settled once the hydrated cursor reaches it. A session whose cache is already complete when
   the tail arrives, or whose history is reset, settles immediately.
3. If the control plane writes its own event to a session that has not settled, the next runner
   event committed to that session gives it a new event epoch in the same transaction
   (`advanceEventEpochInTransaction` in `apps/control-plane/src/db.ts`). The cached rows stay as
   they are.
4. The control plane then broadcasts the session, and dashboards treat the new epoch as they treat
   any history reset. They drop the cached transcript and recover it from the start. A dashboard
   that reconnects later reads the new epoch from its snapshot.

The epoch advances whenever this order occurs after a reboot, even if nothing was rolled back. For
example, a runner may have streamed events while the control plane was down. That costs one
transcript reload for the affected session. A session whose replay continues its surviving history
in order keeps its epoch, because each event returns to its old number.

Other records bound to the old epoch are kept valid:

- A campaign report verification or a work-item verification moves to the new epoch when its report
  event still has the same sequence number, timestamp, and digest. The report must already have been
  durable when it was verified, because verification is a `FULL` commit. Proofs that do not match
  follow the same replay rebinding rules as a history reset.
- Background-continuation projections move to the new epoch.
- Accounting does not move. Claude cost corrections bind their identity, export, and recovery scope
  to `accountingEventEpoch`: the event epoch minus the session's `recovered_event_epochs`. A recovery
  advance keeps every row and event id, so it leaves that value unchanged. A history reset or clear
  still changes it.
- A history-page chain that advances the epoch on one page continues with the new epoch on the
  next, so the pending ask it collects across pages is restored.

Limits:

- Recovery is lazy. A session that receives no new event and is never opened stays behind, so its
  newest events are missing from its transcript, search, and preview until something reads it.
- The runner must still hold the session. If its history epoch changed, the control plane resets
  and re-pulls the whole log instead.
- The watch over unsettled sessions lives in memory. If the control plane restarts again on the
  same boot before a session settles, that session is no longer watched.
- A database last opened by a build that did not record the boot identity cannot detect a reboot
  on its first start after the upgrade.
- A runner on the same host shares the power loss. It flushes its log on a 250 ms debounce after
  appending and at lifecycle points, so it can lose its own last fraction of a second of events.
  Nothing can recover those. This was already true before ingest was relaxed.

## Guards

- `db.test.ts`, test "only runner-replayable event ingest commits without a per-commit WAL flush":
  records the `synchronous` level at every commit. It fails if ingest flushes again, or if the
  relaxation leaks to the connection or to control-plane writes. The test "archived-history prune
  removals commit without a WAL flush, and closing a run flushes" does the same for retention.
- `wal-checkpointer.test.ts`: the worker checkpoints while the connection stays `FULL` in WAL mode;
  only PASSIVE checkpoints exist; main-connection writes with no busy timeout never meet a lock
  while the worker runs, even beside a long-lived reader; a dead worker leaves the log bounded by
  the backstop while every commit succeeds; a crashed worker restarts; a worker that cannot open
  the file never affects the control plane; restart backoff advances until a worker stays healthy;
  the worker never starts on a SQLite without the WAL-reset fix; and a clean shutdown checkpoints
  once more, leaves no log, and holds no lock. For the stall warning: a worker blocked so that no
  pass completes is reported stalled exactly once per stall and recovered once when it resumes;
  the watchdog, driven one check at a time, reports the log's size and discards a size reading that
  returns after its stall ended; a sustained workload with an idle log, passes skipped beside a reader, and
  a clean shutdown reports no stall, and neither does a stopped, disabled, or restarting worker.
  Every other scenario in the file also fails on any stall report.
- `ingest-rollback-recovery.test.ts` simulates a rolled-back suffix by reopening a copy of the
  database taken before the relaxed commits on a different host boot. It drives the web store as an
  open dashboard and checks that the dashboard ends with the server's order without a reload. It
  also checks that an ordinary restart keeps the epoch and the dashboard's cache, and that a
  verified campaign report stays verified.
- `pnpm benchmark:event-ingest [--dir <path>]` measures the real per-event commit cost and fails
  above a 1 ms p50. Point `--dir` at the disk that holds the database: on tmpfs every flush is free,
  which hides a regression.
- `event-payload-staging.test.ts` copies the database, WAL, and blob root at every step of a large
  payload's ingestion, as a process crash would leave them, and checks that recovery never leaves a
  row referencing a missing blob. It also pins that the pending row is flushed before the blob is
  published and that the artifact rows commit relaxed, after it.
- `pnpm benchmark:event-payload [--dir <path>]` fails if a 16 KiB to 1 MiB payload blocks the event
  loop for 2 ms or more at p95.
