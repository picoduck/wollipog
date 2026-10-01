# Canonical Provider-HOME Lease Checkpoints

The canonical journal in `.agent-manager/provider-home-leases-v1` uses immutable
hash-linked successors and an exclusively published successor pathname to elect a
single writer. Version 3 adds bounded checkpoints shared by the native reader and
the WSL helper. The containing directory name stays unchanged so old binaries see
the incompatible format rather than initialize an independent ownership domain.

`apps/runner/src/provider-home-lease-checkpoint.ts` defines the fixed format limits
used by both readers. Changing these is a protocol change, not a per-process
environment setting. Compaction starts at 16 transitions. At 31 transitions new
acquisitions refuse, reserving the 32nd transition for an already acquired owner's
release. An unavailable checkpoint never enables an append-unbounded fallback.
Existing v2 homes already at the acquisition cap also refuse; operators must
preserve their evidence rather than reset them as a migration shortcut.

Each metadata directory permits at most 256 entries, with a bounded enumeration
that stops on entry 257. Acquisitions additionally reserve four root entry slots
for publication and release. Ordinary records and publication litter have a
4,096-byte limit; a checkpoint has a 65,536-byte limit. A checkpoint's retirement
manifest permits 72 entries, and historical partial evidence permits 32 records.
There are two fixed checkpoint staging slots and one selected checkpoint, with no
historical checkpoint directories or recursively embedded checkpoint chain.

Consequently, the root and mirror directory together admit at most 512 entries
and a conservative 32 MiB of metadata bytes, including checkpoints, manifests,
mirrors, interrupted candidates, retained evidence and publication litter.
Successful homes without partial evidence normally remain below 36 records and
100 KB. Unverified publication litter is preserved and charged against the entry
and byte limits; repeated crashes cannot silently create an unlimited allowance.

Each canonical verification and each complete checkpoint attempt separately has
an 8,192-record and 8 MiB verification-work budget. Record payload reads and hashes,
previous-tip hashes, manifest commitments and snapshot hash input are charged.
Every read additionally has its individual byte limit; the native reader uses a
fixed buffer rather than reading an expanding file to EOF. Acquisition invokes a
fixed number of these bounded operations, and release invokes one checkpoint
attempt and one verification. Retirement that reaches its work budget stops with
the exact immutable proof still selected and resumes on a later acquired lease.
Directory and manifest enumeration remain bounded even for refused input.

Only the exact active lease acquired by the current registry/helper invocation
may compact. A matching PID on disk never supplies that authority. Before any
selection the writer publishes and fsyncs `protocol-v3.json` in the mirror
directory. This permanent incompatible guard is included in the snapshot and its
hash is bound by every selected v3 checkpoint. Directory-only rollback readers
refuse it even if a crash interrupts migration or retirement. Version-2 canonical
readers also refuse the guard or the selected version-3 root record.

A checkpoint copies the acquired active tip's identity unchanged and includes
its exact bytes and hash, the previous anchor hash, a cumulative historical
commitment, the guard hash and an exact retirement manifest. Manifest paths are
restricted to known canonical records, optional mirrors and the two staging
slots. Each entry names a digest, device and inode. A tip's future successor is
never eligible for retirement. Optional late mirrors are authorized only as
aliases of their already verified canonical inode and digest. Partial historical
evidence remains outside the retirement manifest and retains its original digest.

The writer writes the candidate exclusively, fsyncs the file and directory,
rechecks its acquired tip and full evidence snapshot, and checks the candidate's
bytes. It atomically renames the candidate over `mutable-home.recovery.json`, then
fsyncs the root directory. Only after durable selection does it retire manifest
entries. Every remaining entry is checked before retirement and immediately
before unlink, and the containing directory is fsynced after each removal. Linux
native operations use pinned no-follow directory descriptors; the helper uses
descriptor-relative operations throughout. Native platforms without this durable
descriptor-relative publication path retain the valid chain and use the capped
unavailable policy.

A killed writer leaves either the previous valid chain or a complete selected
checkpoint. A new same-owner/same-host reader must prove the active PID dead and
win a canonical successor before completing retirement. Missing files are
authorized only by a selected manifest; an unproven empty historical directory
cannot be cleaned. Re-created manifest pathnames must still match their original
digest and inode. A staging name that remains in the selected manifest is not
reused. An interrupted, complete candidate can itself be retired only when its
previous active tip is proven by the still verified canonical history.

Malformed or incomplete candidates, exhausted staging slots, changed retained
digests, incompatible formats, links, unexpected entries, foreign active owners,
other hosts and live/unprobeable PIDs fail closed. Compaction failures preserve
the last valid chain and produce a fixed, bounded diagnostic, deduplicated to at
most 16 messages. Native diagnostics reach the runner log with a stable event and
the lease ID; helper diagnostics use the existing bounded result collection.
Check filesystem support, permissions, fsync failures, staging evidence and the
verification budget. Never delete individual records or reset a journal. Manual
quarantine of the entire lease directory requires independently proving that no
provider or runner uses that HOME.

With `WOLLIPOG_LEASE_LONG_RUN=1`, the focused checkpoint suite measures 512 native
passes, 512 helper passes and 1,024 mixed handoffs; CI uses 64 passes per mode.
It checks storage and verification reads, real competing
writers, SIGKILL at every guard/candidate/selection/retirement boundary,
cross-reader recovery, work exhaustion, capped growth, retained digests, inode
substitution, no-follow refusals, same-PID registries and malformed manifests.
