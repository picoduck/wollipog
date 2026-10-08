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
- `synchronous=FULL` on the connection: every commit flushes the WAL before it returns, so a
  control-plane decision is durable once it has been acknowledged.
- Runner-replayable event ingest is the one exception. `appendEvent` called with a runner sequence
  number and `appendHydratedPage` switch the connection to `synchronous=NORMAL` for their own
  transaction and back to `FULL` afterwards (`replayableCommit`). They are relaxed only in WAL mode
  (outside WAL, `NORMAL` can corrupt the file), and never for a transaction that carries a
  `token_usage` event (see below).

Flushing every streamed event capped ingest near 150 events per second, because each flush blocks
the control plane's only thread. Measured on a local NVMe SSD with 500 sessions and about 220,000
events, 10 streaming sessions and 6 dashboards:

| Measurement                                | Every commit flushed | Event ingest relaxed |
| ------------------------------------------ | -------------------- | -------------------- |
| `appendEvent` p50                          | 5.1 ms               | 0.07 ms              |
| Runner-to-dashboard p50 / p95, 200 events/s | 1.4 s / 2.9 s        | 0.5 ms / 9 ms        |
| Runner-to-dashboard p50 / p95, 300 events/s | 4.4 s / 8.6 s        | 0.5 ms / 12 ms       |

## What a Crash Can Lose

**A control-plane process crash, kill, or out-of-memory exit loses nothing.** Committed WAL frames
are already in the operating system's page cache.

**An OS crash or power loss never corrupts the database.** WAL frames are checksummed, and recovery
discards an incomplete tail. It can roll back exactly one kind of commit: a relaxed event-ingest
transaction that no later flush has covered.

The WAL is flushed by every `FULL` commit (that is, any other write: a status change, a prompt, a
decision) and by every checkpoint (by default each 1,000 WAL pages). A flush covers the whole file,
so it also makes every earlier relaxed commit durable. The exposure is therefore the run of event
commits since the most recent other write or checkpoint. The operating system usually writes those
pages back within seconds, but nothing guarantees it.

A rolled-back ingest transaction takes with it everything it wrote in the same transaction:

- the event rows and their transcript search entries;
- the session's hydrated-history cursor;
- the session preview, last-activity time, and message count;
- campaign-report rebinding, background-continuation projection, usage coverage, and event-artifact
  links.

Large payloads are published as artifacts in `FULL` commits before their event row. An artifact
whose event rolled back is left unreferenced, and startup collects it
(`collectOrphanedEventPayloadArtifacts`). Re-ingesting the event republishes the same
content-addressed bytes.

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
     route call `hydrateHistory`. Until it finishes, responses report `cacheComplete: false`.
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
  relaxation leaks to the connection or to control-plane writes.
- `ingest-rollback-recovery.test.ts` simulates a rolled-back suffix by reopening a copy of the
  database taken before the relaxed commits on a different host boot. It drives the web store as an
  open dashboard and checks that the dashboard ends with the server's order without a reload. It
  also checks that an ordinary restart keeps the epoch and the dashboard's cache, and that a
  verified campaign report stays verified.
- `pnpm benchmark:event-ingest [--dir <path>]` measures the real per-event commit cost and fails
  above a 1 ms p50. Point `--dir` at the disk that holds the database: on tmpfs every flush is free,
  which hides a regression.
