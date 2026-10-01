# Bounded Provider-HOME Lease Checkpoints

The native runner and in-distro helper share a canonical immutable successor journal. A fresh
canonical journal uses v2 records. After 16 transitions, the acquired owner negotiates a v4
checkpoint and a permanent `mutable-home.lock/protocol-v4.json` fence. v2 and v3 readers refuse
the incompatible guard/checkpoint. A checkpoint copies the exact active identity, commits to its
previous canonical tip and anchor, and includes a digest and exact decimal device/inode identity
for every piece of evidence it may retire. Retirement requires the registry's private acquired
token; matching a disk PID, an empty mirror directory, or a missing mirror never supplies it.

## Negotiated Bounds

| Resource | Limit |
| --- | ---: |
| Ordinary record / publication litter | 4 KiB |
| Checkpoint / either candidate slot / Windows retirement alias | 2 MiB each |
| Steady directory entries | 256 in each metadata directory |
| Steady physical metadata bytes | 10 MiB |
| Legacy migration directory entries | 4,096 in each metadata directory |
| Legacy migration physical metadata bytes | 40 MiB |
| Retirement manifest | 8,192 entries |
| Retained partial evidence | 32 entries |
| Candidate slots | 2 fixed names |
| Windows retirement aliases | 1 fixed name |
| Complete verification or compaction work | 131,072 record operations / 256 MiB read or hashed |
| Native helper IPC | 64 MiB |
| Native I/O transaction timeout | 120 seconds |
| Critical permanent-fence acquisition grace | 10 seconds, polling every 10 ms |
| Mount inventory in the Linux helper | 1 MiB |

The limits are configured in `provider-home-lease-checkpoint.ts` and independently enforced by
both native I/O backends. Nested verification shares the complete compaction budget. Native
transactions receive its remaining allowance before doing I/O; exhausting it leaves the selected
proof and all unretired evidence intact. Each acquisition/release uses a finite number of these
bounded verification/publication transactions. Tests measure whole handoffs as well as storage.

Acquisition reserves four directory entries before electing a successor; publication reserves two.
For a valid older v2 journal, one exclusive successor election is allowed before applying the
transition cap. At 31 or more transitions that successor is a private migration reservation:
provider launch and other HOME mutation are refused until catch-up succeeds. Only that same
registry can retry its private token without appending another record. A killed helper's reservation
is reclaimed through a new authenticated successor, subject to the same finite directory/byte
admission bounds. An unproven or over-bound journal is left unchanged.

After v4 selection, new acquisitions stop before 32 transitions, reserving a release slot. Failed
compaction never resets the journal or erases evidence. It produces a bounded, deduplicated
`provider_home_checkpoint_unavailable` diagnostic explaining the helper/fence/durability/work
requirements and the whole-directory quarantine remedy after proving the HOME unused. Legacy
private migration failures can add bounded reservation/release evidence, but never grant HOME
mutation past the cap. A migration checkpoint permits the larger inventory only while more than
224 selected-manifest entries remain; once retirement reduces that inventory, ordinary limits
apply even if its immutable migration flag is still set.

## Publication and Recovery

All v4 readers take a shared kernel fence; successor writers, mirror publishers, and checkpoint
publishers take its exclusive side. The fence inode is never replaced. Its digest, device/inode,
and backend are committed in the checkpoint. Native helpers pin no-follow ancestry, files, and
directory identities, independently correlate the held record to their actual parent lifecycle,
compare the exact verified preimage under the fence, and recheck acquired authority before
selection and every retirement operation. The Linux helper receives a parent-death signal;
Windows additionally verifies that the parent's creation time predates the helper's creation.

The supported coherent local backends are Linux flock on ext4, tmpfs, btrfs, overlay, XFS, ZFS,
and F2FS; native macOS flock on APFS/HFS; and native Windows LockFileEx on local NTFS. A guard
names its fence backend. Incompatible/shared-network filesystems and incompatible reader versions
refuse rather than pretending that their locks interoperate. POSIX native helpers ship as SEA
assets; Windows uses the fixed privately compiled and digest-verified C# helper without elevation
or persistent execution-policy changes.

A candidate is complete and synced before atomic selection. Selection is durable before any
manifest source is retired. POSIX uses fsync, plus F_FULLFSYNC for macOS files, and syncs each
retirement directory. Each source is reread and matched to its digest and exact inode immediately
before unlink. Full-chain verification is not repeated for every retired entry.

Windows retains a fixed `.mutable-home.retired` alias instead of treating DeleteFile or a
read-only handle as a POSIX directory barrier. Under the fence it pins source and destination
ancestry and handles, verifies selected-manifest authority, moves the source to this same-volume
alias with NtSetInformationFile(FileRenameInformationEx), flags REPLACE_IF_EXISTS |
POSIX_SEMANTICS, and flushes the exact moved inode with GENERIC_WRITE. The source handle
has DELETE access and denies shared writes; the relative single-component target uses the
pinned RootDirectory handle. Old target proof handles remain open through replacement.
Native structure offsets, zeroed conservative buffer size, synchronous completion and bounded
UTF-16 target lengths are checked before publication.
No copy, path-based rename fallback or read-only override is used. The last alias, and any surviving hard-linked
mirror, remain selected-manifest evidence and are committed before the next anchor replaces
their authorizing checkpoint. Windows byte-range fencing uses a range beyond the record's EOF,
so ordinary reads of the guard do not conflict with its own lock. Microsoft documents
[locking beyond EOF and conflicts through other handles](https://learn.microsoft.com/en-us/windows/win32/fileio/locking-and-unlocking-byte-ranges-in-files).

A guard publication interrupted after linking can leave its generated root staging name as a
hard link to the permanent guard. Under the held fence, Windows classifies that staging handle
by exact volume/file identity before accepting any bytes. Only that same guard inode receives
guard-compatible shared-write access, with deletion sharing denied, full-byte equality to the
pinned guard, stable fingerprints and a named-identity recheck. Every other staging inode is
closed and reopened with ordinary no-shared-write access and its discovery identity rechecked;
matching bytes alone do not supply guard identity or ownership authority.

Only the fixed retirement alias can change which currently selected manifest tuple it holds.
Readers still require its full digest and exact device/inode to match a committed tuple and
recheck its named identity after reading. Every ordinary retired path requires its own named
tuple. A surviving alias is committed again before the next selected anchor replaces the old
proof; it never grants ownership or authorizes cleanup on its own.

This relies on the local NTFS rename and FlushFileBuffers metadata semantics. It does not infer
a general Windows directory-fsync guarantee. Handle-relative POSIX replacement preserves
open target proof handles and refuses unsupported APIs. See the
[handle-preserving rename flags](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/4217551b-d2c0-42cb-9dc1-69a716cf6d0c),
[relative native rename targets](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information),
[write-through NTFS metadata semantics](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
and [FlushFileBuffers access requirements](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers). Process-kill tests
validate interruption recovery, not a physical power-loss experiment.

The fixed native helper is execution-probed before creating HOME lease evidence. POSIX runners
stage their trusted helper bytes in a private temporary directory, then try the explicitly
configured existing runner data directory if temporary execution is unavailable (for example,
`noexec`). A failed probe does not publish a lease and reports helper availability rather than
advising journal quarantine. Normal exit removes only the exact process-owned helper inode and
private directory; unknown entries and substitutions are retained. Killed runners can leave
external helper caches, which are outside the canonical journal bounds.

Existing system temp and explicitly configured existing runner-data parents may be inside the
provider HOME, as they normally are on Windows. Only unique process-private fixed helper
bootstrap artifacts use these parents before acquisition; this grants no access to credential
or provider mutations. The canonical lease root and every descendant remain excluded by both
lexical paths and exact physical ancestor identities, including Windows short-name aliases.
Shared parents are never created or chmodded. Canonical ancestry and the private root/file
identity are rechecked across compilation, probing, reuse and cleanup. Helper files are bounded
to 16 MiB and ancestor proof walks to 256 directories. Reuse and cleanup require a regular
single-link file with the captured full-byte digest and exact root/file identities; checking
expected entries reads at most two directory entries. Unknown entries, incomplete compiler
output, changed bytes and substituted or hard-linked artifacts are retained. Windows loads
digest-verified bytes in memory from a bounded read that denies shared writes/deletion, and
executes the fixed probe before any lease journal publication.

Initial unowned admission takes the permanent fence without waiting. Critical publication,
post-publication continuation and release allow at most 10 seconds to obtain it, using a
monotonic deadline, 10 ms polling and parent-liveness checks. The exact preimage is checked
after obtaining the fence. The helper transaction timeout remains 120 seconds. A registry
retains its exact private acquisition digest before later verification or mirroring can fail;
a deadline failure grants no HOME access. Only that registry can complete the unchanged pending
publication without republishing or adding a borrowed reference. Failed release retains the
held and pending tokens and emits a bounded, deduplicated diagnostic so exact release can be
retried; transient contention carries retry advice without a quarantine remedy.

Lease I/O is synchronous today. A maximal admitted migration measured roughly 50–90 seconds,
so runner event-loop timers and heartbeat work can be delayed during the transaction. The
physical record/byte budgets bound work; they are not a low-latency or heartbeat guarantee.
Truncated or unproven checkpoint candidates remain untouched, even if another slot is free;
the documented growth cap then stops admission while preserving the last valid chain.
Unproven publication staging litter is also preserved and counts toward the fixed directory
entry and metadata-byte admission caps. Repeated interruptions can exhaust those caps; new
acquisitions then refuse without removing evidence or resetting the selected chain.

After an interrupted completed candidate, the new owner first acquires successor Q. It may adopt
candidate P only if P commits to the currently verified anchor and historical active tip, its full
manifest remains proven, and hypothetical selection preserves the exact current Q. The checkpoint
carries the historical tip hash bridge, so Q is preserved byte for byte. Adoption is synced and
retired under Q's private token; a fresh Q checkpoint then frees the bounded publication slots.
Partial, foreign, corrupt, or otherwise unproven candidates are preserved and cannot authorize
cleanup. Two repeated completed-candidate crashes recover without exhausting the slots.

## Validation

Focused tests cover native/helper-only/mixed handoffs, real concurrent election, old reader refusal,
retained evidence, unknown entries, foreign owner/host, live and unprobeable PID, corrupt digests,
exact inode resurrection, symlinks/no-follow ancestry, unavailable compaction, maximum legacy
admission and one above, and actual killed-parent publication boundaries. Platform Isolation runs
the native regressions and portable publication-boundary tests on Linux, macOS, and both Windows
images. Windows tests include interrupted retirement move and flush boundaries.

A 512/512/1,024 native/helper/mixed handoff run measured at most 31/31/27 metadata records and
19,348/19,720/17,880 bytes respectively. Native whole-handoff read instrumentation also counts
trusted helper-binary integrity checks: its latest observed maximum was 16,421,141 bytes;
helper-only journal reads were at most 332,998 bytes. These measurements do not replace the
enforced limits. Maximum padded legacy migration (4,090 transitions) completed in approximately
90 seconds native and 79 seconds helper in the latest isolated run on the development filesystem. Its complete largest transaction
used 57,307 record operations / 221,215,834 read-or-hashed bytes native, and 73,669 /
166,524,777 helper, below both negotiated work ceilings. The selected checkpoint was roughly
1.54 MiB after subsequent cross-reader handoffs. These are workload measurements, not latency
guarantees. Large-run and exact platform CI evidence are recorded in the implementation report.
