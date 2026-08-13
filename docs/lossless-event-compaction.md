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

Compaction runs only while an idle-maintenance owner holds the normal per-session writer lock. It:

1. flushes the active event file and pending metadata;
2. validates the durable tail and derived sparse index;
3. copies one bounded, newline-aligned prefix and the remaining suffix into new generational files;
4. fsyncs both files and their directory;
5. atomically publishes a fsynced manifest that references them;
6. retires the former `events.ndjson` inode and places a directory at that legacy path.

Until step 5, readers keep using the previous manifest and files. After step 5, readers use the new
generation. Superseded files remain for one hour so a cross-process reader that captured the prior
layout can finish, then bounded orphan collection removes at most 32 files per session/pass.
Unpublished crash debris is never referenced and follows the same cleanup path. The directory fence
makes a pre-compaction runner binary fail its legacy read/append closed instead of creating a second
writable log beside the manifest. If Windows temporarily blocks retirement for an open reader, a
later maintenance pass retries it.

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

One pass has bounded copy, hash, session, and orphan work. Legacy monolithic logs need no eager
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
