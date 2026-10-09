# Lossless Event Compaction and Audit Archive

The runner remains the source of truth for session event history. Compaction changes the physical
files that hold that history, never its logical NDJSON byte stream, sequence numbers, event bodies,
timestamps, ordering, or log epoch.

## Runner history layout

A new session starts in the rolling-compatible monolithic layout:

```text
<session>/meta.json
<session>/events.ndjson
<session>/events.idx
```

After idle maintenance compacts it, `events.manifest.json` atomically selects an ordered set of
immutable cold segments plus one mutable active generation:

```text
<session>/events.manifest.json
<session>/events.segment.<epoch>.<seq-range>.<uuid>.<sha-prefix>.ndjson
<session>/events.active.<epoch>.<seq-range>.<uuid>.ndjson
<session>/events.ndjson/  # directory fence for pre-compaction runner binaries
<session>/events.idx
```

The manifest records each segment's exact byte length, contiguous sequence range, and full SHA-256.
Names must be contained basenames with the expected runner-owned prefix. Duplicate files, sequence
gaps, wrong epochs, missing/truncated files, and malformed metadata fail closed. A cold segment's
hash is verified the first time a process actually seeks into that unchanged file; unrelated deep
pages do not hash the full archive.

Segment bytes followed by active bytes are exactly the pre-compaction `events.ndjson` bytes. The
sparse index therefore continues to address one virtual byte space. Existing checkpoints and
frozen `{logEpoch, throughSeq}` page chains remain valid across any number of manifest switches.
The legacy whole-history RPC reads the same ordered sources for old control planes.

## Publication and recovery

The per-session writer lock is a `lock` file naming its owner; its mtime is the last refresh, and a
lock unrefreshed for 60 seconds is stale. Lock and guard files are published complete, by
hard-linking a written temp file into place. Taking a free lock is one exclusive publication; a stale
takeover, a refresh, and a release each run inside a short guard section (`lock.guard`, recording the
holder's pid, process start time, and a token), so a takeover replaces exactly the stale lock it
inspected and never one that was refreshed, released, or retaken meanwhile. Anything published inside
the guard is touched before the guard is released, so a lease starts when it is published. On a
filesystem without hard links the free path also runs inside the guard. A busy guard fails the
operation closed after a brief wait.

Only the runner, which holds the data-directory lease, ever removes a guard, and only when its holder
is gone: its pid has exited, or the guard is old and its pid now belongs to a process that started
later. Any other process fails closed on an abandoned guard. An empty or malformed `lock.guard`
(damage, or a crash mid-write on a filesystem without hard links) is never removed automatically; the
session's lock then stays unavailable until that file is deleted by hand while no runner is using the
session. Pids and start times are host-local, so the data directory must not be shared across
machines.

Compaction needs the normal per-session writer lock to plan and to publish. It keeps the event loop
responsive: no single synchronous step is a bulk copy, a whole-range parse, or an fsync of a large
file. It:

1. validates the durable tail and derived sparse index under the lock, and records the epoch and
   manifest identity it planned against. Idle maintenance then releases the lock, so a turn that
   starts during the copy is never refused;
2. finds the newline-aligned cut by parsing bounded slices of the active file, yielding between
   slices;
3. copies the prefix into a new segment and the suffix into a new active generation. Reads, writes,
   and fsyncs run on the libuv pool; only hashing runs on the main thread, one 1 MiB chunk at a
   time;
4. catches up with events appended to the old active file during the copy, copying only complete
   lines, then fsyncs the new files and their directory. It also stages fsynced temp copies of the
   manifest and, for the first compaction of a legacy log, the fence intent;
5. takes the lock again and, without yielding, verifies that the epoch, the manifest identity, and
   the active inode are unchanged. Idle maintenance re-takes the lock only with an exclusive create,
   so it never overwrites or steals a lock that a turn took meanwhile. If more than 256 KiB arrived
   since the last catch-up, it lets the lock go and catches up again, up to four times. Otherwise it
   copies the remaining complete lines, checks that the prepared segment, active file, and staged
   files still exist (orphan collection in another store could have removed them), and re-reads
   the lock. Finally it atomically renames the staged files into place, which publishes the
   manifest. A changed epoch or manifest abandons the
   copy, as do a remaining torn suffix and a lock now held by another owner;
6. retires the former `events.ndjson` inode and places a directory at that legacy path.

Torn-tail repair only truncates after a file's final newline, and a reset changes the epoch, so
bytes copied up to an observed newline stay identical. Appends made during compaction are therefore
copied once, in order, before the manifest switch. Appends made after the switch go to the new
active generation.

Until step 5 publishes, readers keep using the previous manifest and files. After it, readers use
the new generation. Superseded files remain for one hour so a cross-process reader that captured the prior
layout can finish, then bounded orphan collection removes at most 32 files per session/pass.
Unpublished crash debris is never referenced and follows the same cleanup path. Orphan collection skips
the files of a compaction that the same store is still preparing. The directory fence
makes a pre-compaction runner binary fail its legacy read/append closed instead of creating a second
writable log beside the manifest. If Windows temporarily blocks retirement for an open reader, a
later maintenance pass retries it.

The append path keeps a per-session layout for the current log epoch, so its cost does not grow
with the number of segments. A warm append stats only the manifest (inode, nanosecond mtime, and
size) and the active file. Any change to the manifest identity or epoch refetches and revalidates
the full layout. A streaming session also revalidates it at least every 250 ms, so a missing or
truncated cold segment still fails appends closed within one metadata flush interval. While the
manifest's identity is unchanged it names the same segments, so that revalidation is one `lstat` per
segment (a regular file of the recorded size) rather than a manifest re-read; any doubt, and at least
every 30 seconds regardless, falls back to the full read. Compaction in
this process extends the cached layout with the segment it just published. That layout is keyed by
the identity of the exact manifest inode it renamed into place, so a later replacement always
misses. Reset, lock hand-off, session removal, and a failed append drop the cached layout. A
pending legacy-fence intent keeps the session uncached so every append retries the fence. The first
append after acquiring the writer lock still re-reads the manifest from disk, checks every
segment's presence and size, and repairs a torn suffix before it assigns a sequence.

`resetEvents()` remains the commit point for reprocess. Its durable reset intent publishes an empty
canonical `events.ndjson`, removes the manifest, advances `logEpoch`, resets the sparse index, and
removes every cold/active generation. A crash at any point repeats that idempotent recovery. Session
deletion recursively removes the complete archive.

## Bounded idle maintenance

The runner schedules a four-session pass ten seconds after startup and every five minutes. It never
steals a fresh writer lock. The cursor rotates through sorted session ids so the same early sessions
cannot starve a large fleet.

Default per-session policy:

- trigger when the mutable active generation exceeds 64 MiB;
- retain at least 16 MiB and the newest 1,024 events;
- archive at most 64 MiB in one pass;
- rebuild a missing/malformed derived index while idle, even when compaction is not yet needed;
- keep superseded reader generations for one hour.

One pass has bounded copy, hash, session, and orphan work. Rebuilding a missing or malformed index is the
exception: it still scans that session's history synchronously. Legacy monolithic logs need no eager
startup migration; repeated maintenance gradually converts an oversized active file.

## Audit retention

Session-event compaction never rewrites or filters an event, including approval, review, workflow,
automation, provenance, and usage events. Control-plane `governance_audit` remains append-only and
independent of the session foreign-key lifecycle.

Mutation attribution has a bounded hot table and an indexed append-only archive. Before completed
rows can leave the 180-day/100,000-row hot window, one SQLite transaction copies them into
`mutation_audit_archive` and only then removes the hot copies. Status-0 crash intents stay hot until
completion. Authorized listing merges hot and archived rows into the same bounded newest-first
surface; actor/resource deletion cannot cascade into the archive.

## Artifact maintenance

Large event-payload chunks are linked to their committed SQLite event row through
`session_event_artifacts`. Live appends, indexed page hydration, legacy hydration, and inline
migration insert those links in the same transaction as the event. A one-time migration extracts
references already present in pre-index payload JSON, then records completion. Orphan collection is
therefore an indexed anti-join instead of repeatedly running `instr` across every artifact/event
pair.

The inline-payload migration persists its scanned event-id high-water and considers only eligible
event kinds. A temporarily unavailable artifact store leaves the original row and stops before
advancing past it; the next open retries without rescanning older noneligible history.

The control plane performs one bounded orphan pass and one bounded blob-GC pass every minute in
addition to startup/lifecycle cleanup. Each pass examines at most 1,000 rows, so a backlog drains
without an unbounded startup pause and transient filesystem failures stay queued for retry.

## Operational diagnostics

`history_corrupt` from a paged read means the runner detected malformed manifest data, a missing or
truncated source, a SHA-256 mismatch, invalid UTF-8/JSON, a sequence discontinuity, or an invalid
sparse checkpoint. The runner does not skip past that damage. Repair is explicit: restore the exact
immutable file from backup, reprocess an adopted transcript into a new epoch, or delete the session.
Derived `events.idx` can be removed safely; idle maintenance or the next indexed read rebuilds it
from authoritative history.
