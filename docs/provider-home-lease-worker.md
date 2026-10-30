# Provider HOME Lease Worker

The runner owns one lazy, serialized worker for its complete private provider-HOME registry.
Initialization, helper compilation/probing, verification, hashing, migration, acquisition,
completion and release run there. Moving only the native subprocess would leave seconds of
JavaScript verification on the heartbeat event loop. The worker shares the runner's OS PID;
native POSIX actual-parent checks and Windows process creation-time checks still refer to the
runner. Worker-thread death does not prove that the runner or its providers died.

Control messages contain a bounded HOME/provider selection and scalar results. Canonical records,
native manifests and private acquisition/completion tokens stay inside the worker. Source launches
load the fixed sibling module through the project's loader; compiled launches load the fixed JS
entry. SEA builds embed a separate, self-contained worker asset and the existing native helper.
No agent RPC, configuration or CLI mode can select worker code or enlarge its limits.

| Limit | Value |
| --- | ---: |
| Pending requests, including the active unacknowledged receipt | 64 |
| Control request | 64 KiB |
| Scalar response | 4 KiB |
| Enqueue-to-terminal deadline | 300 seconds |
| Existing helper compile / execution probe | 30 / 10 seconds |
| Existing native transaction / fence wait | 120 / 10 seconds |
| Heartbeat regression bound under normal OS scheduling | 500 ms late |

The existing byte, native IPC and verification-work budgets remain unchanged. Upgrade migration
admits at most 4,104 directory entries and 8,208 retirement tuples: the former 4,096-transition
in-lock writer could leave 4,097 files, and migration needs bounded successor/guard headroom.
The heartbeat interval, initial-pong grace and missed-pong termination thresholds remain unchanged.
The dispatch bound does not promise hard real-time behavior when the OS deschedules the runner.

## Upgrade Compatibility and Readiness

A valid in-lock v1/v2 journal enters canonical checkpoint storage on its next acquisition, after
the complete chain and abandonment evidence pass the existing ownership checks. A fresh genesis
has no predecessor to checkpoint and stays bounded until the next acquisition. The first migration
uses the original genesis as its history root, preserves v1 retained evidence, selects a durable
checkpoint before retiring validated history, and withholds HOME if migration cannot finish.
It also recovers interrupted first migrations without treating an unselected candidate as ownership
authority. POSIX and Windows helpers pin the absence of the first anchor until selection and check
future successors in both journal locations. Unknown, foreign, changed, live, and uninspectable
ownership evidence still refuses admission. Neither an update nor a rollback deletes the journal.

Runner systemd units include `Delegate=yes`. `service upgrade` adds that setting to an existing
runner unit while preserving its other directives and file mode, reloads systemd, and verifies the
effective property so a conflicting drop-in cannot silently defeat it. Failure restores the prior
unit along with the prior executables. Delegation permits future supervised cgroup evidence; it
cannot retroactively prove that an older lease's surviving processes have exited.

For a colocated control plane and runner, upgrade success requires the new runner version, a new
connection, a completed discovery pass since registration, no newly ownership-blocked discovery, and
continued availability of previously ready agent IDs and previously signed-in provider accounts.
Registration alone and cached inventory
cannot satisfy this check. Failure triggers rollback and records the reason in the upgrade journal.
An ownership block already reported in the pre-upgrade snapshot does not prevent installing a
recovery update: completion reports `fresh-harness-discovery-degraded`, emits a warning, and records
the unresolved block in the upgrade journal. A newly blocked or previously ready harness still
fails readiness and rolls back. An unknown baseline never excuses an ownership block.
The first upgrade from a control plane predating this projection has an unknown baseline. If a
legacy ownership block survives that update, the service CLI deliberately refuses a healthy result
and restores the prior generation. Before retrying, let the actual surviving processes exit or use
the existing authorized recovery flow with valid process/boot evidence; do not fabricate a baseline
or delete lease records. This can delay installation of a recovery update on a legacy blocked host.
`admin status --json` exposes the content-free `runners.items[].harnessReadiness` projection:
connection time, discovery completion, agent IDs/availability/ownership-blocked flags, and account
IDs/authentication statuses. These
answer whether discovery ran after this restart, whether an ownership refusal blocked it, and
whether a previously available harness or signed-in account regressed; provider paths, environment,
account labels and credentials are excluded. This is an additive host-admin REST field; it adds no
runner capability or wire message.
A runner-only install cannot query its remote control plane through the local bootstrap credential:
its upgrade reports `runnerVerification: "service-active-only"` and explicitly asks the operator
to verify harness readiness there.

An installed CLI whose ownership probe cannot run stays visible as **Unavailable**, with the safe
ownership failure. It is never classified as **Not Installed** or **Update Required**. This does
not permit a discovery probe or a session to bypass HOME admission. Historical leases without
adequate lifecycle evidence may still require their actual surviving processes to exit; do not
delete individual records or infer abandonment from a runner being online.

## Monotonic Deadline

The enqueue-to-terminal budget remains exactly 300,000 milliseconds. The runner records
`process.hrtime.bigint() + 300000000000n` once at enqueue. Startup, queueing, execution, receipt
delivery, acknowledgement, cancellation unwind and any compensating request retain that original
deadline. Expiry means `now >= deadline`, including at the exact boundary. Wall-clock timestamps
in canonical records and profile grants keep their existing meaning; they are not deadline inputs.

Both threads read the raw host coordinate. [Node's implementation](https://github.com/nodejs/node/blob/v24.18.0/src/node_process_methods.cc)
copies `uv_hrtime()` without subtracting a process or worker startup origin. [libuv documents](https://docs.libuv.org/en/v1.x/misc.html#c.uv_hrtime)
nanosecond units unrelated to time of day; units do not guarantee nanosecond resolution. This
coordinate is comparable between this runner and its worker, and between processes using the same
host clock. It is not a portable timestamp and is never persisted or compared across hosts or boots.

Suspend semantics follow the runtime's native clock, rather than a wall-clock approximation:

- Linux uses [`CLOCK_MONOTONIC`](https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/unix/linux.c),
  which [excludes suspend and can frequency-slew](https://man7.org/linux/man-pages/man2/clock_gettime.2.html).
- macOS libuv in [Node 22.13](https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/unix/darwin.c)
  and [Node 24.18](https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/unix/darwin.c) uses
  `mach_continuous_time()`. [Apple's implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/clock.c)
  includes sleep time. Do not infer the older `mach_absolute_time()` behavior.
- Windows libuv uses [`QueryPerformanceCounter`](https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/win/util.c).
  [Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)
  a shared system counter including sleep, with an ordering uncertainty of one tick between threads.

Thus 300 seconds means elapsed time on that platform's monotonic clock, with no universal promise
that suspended time counts identically. Timers are wakeups: an early callback recomputes the bounded,
rounded-up remaining delay, and a delayed callback cannot authorize late receipt acceptance. The
worker checks before and after synchronous execution and cancellation unwind, and watches an
unacknowledged receipt with the same deadline. Synchronous native work or OS descheduling may delay
refusal; termination does not prove rollback or release, and canonical evidence is preserved.
Boundary tests exercise logical nanosecond comparisons, not physical nanosecond scheduling accuracy.

The wire carries a canonical unsigned 64-bit decimal string (at most 20 digits), because JSON frame
sizing cannot serialize BigInt. Legacy numbers, signs, whitespace, leading zeros, overflow and
deadlines farther than the unchanged budget are refused. Startup and ready frames require the
`hrtime-ns-v1` clock marker; SEA uses the versioned fixed asset
`wollipog/provider-home-lease-worker-hrtime-ns-v1`. A legacy worker cannot silently interpret the
new coordinate. Message, queue, helper, heartbeat, profile and reference bounds are unchanged.

Each operation has a fresh UUID in a single worker epoch. Execution produces a receipt; the parent
checks its identity, deadline and lifecycle before acknowledging it; only the matching terminal
reply resolves the caller. The worker cannot process another operation while that receipt is
unacknowledged. Cancelled queued work never executes. Cancellation before acknowledgement unwinds
that acquisition's exact private reference. Cancellation crossing an already sent acknowledgement
requires an exact compensating receipt before subsequent work can execute. A retargeted HOME alias
cannot redirect cancellation to a different registry entry. Callers repeat launch-generation,
account, TUI and skill-authorization checks after their awaits.

The launch-preparation adapter also awaits account-HOME ownership before plugin inheritance and
guard preparation. Its seven callers cover ordinary launch, authentication inspection/account
selection, temporary-provider and Pi forks, automatic authentication revalidation, explicit
recovery and recovery of another session sharing the scope. Each wait retains its launch epoch,
credential identity and, where applicable, exact recovery card/request or fork target reservation.
Cancelled or stale preparation cannot continue into plugin writes, probes or provider launch.
The existing automatic-revalidation timeout cancels only its pending wait and keeps its unknown
result. Cancelling or dismissing recovery aborts the exact pending preparation; unrelated failures
still propagate through the existing error handling.

A refusal crosses the boundary as a fixed code, never as the registry's message, so no lock path
reaches the parent. The codes are distinct, and callers receive a `ProviderHomeLeaseError` carrying
the code:

- `busy`: contention on an acquisition or publication fence; retry once it is free.
- `holder_alive`: the recorded runner's PID and start time are still alive.
- `boundary_survivor`: provider or helper work remains in the recorded cgroup; ownership is
  retained until the recorded boundary is empty. Preserve the boundary and journal.
- `process_survivor`: a process carrying the recorded runner's marker survives on the fallback path.
- `boundary_unverifiable`: the recorded cgroup identity or enclosing unit retirement cannot be proved.
- `process_uninspectable`, `process_uninspectable_not_delegated`: fallback inspection cannot prove
  ownership; the second code records that the runner's systemd unit is not delegated. Future leases
  need a `Delegate=yes` unit; existing leases still need inspectability. Leave unrelated processes alone.
- `invalid_journal`: the journal is invalid, unsafe or unreadable; preserve every record.
- `foreign_owner`: a stale lease from another runner or control plane that this owner may not recover.
- `foreign_host`: a lease recorded on another host.
- `unavailable`: the helper is unavailable.
- `refusal`: everything else the registry cannot prove.
- `profile_unsupported_control_plane`, `profile_unverifiable`, `profile_not_granted` and
  `profile_changed`: a provider-profile refusal before acquisition (see below).

Protocol v235 extends v233's `providerHomeRefusal` with an optional content-free `cause`; it keeps
the v233 coarse code for older peers. v233-v234 control planes receive only the original shape.
The session notice distinguishes contention, surviving work, unsupported recovery, authorization
and unverifiable ownership without exposing process details. An Owner or Admin's account lease
inspection additionally carries a bounded blocking-process observation when available: PID,
procfs start time, process kind and membership relative to the recorded cgroup, never command,
environment, credentials or filesystem paths. These observations are diagnostic snapshots, not
recovery authority; unavailable diagnostics never weaken the ownership proof. A refused account
does not poison the worker lane or prevent acquisition of another usable account.

A foreign-owner lease is taken over only through the recovery below. Otherwise its text names that
cause and the safe options, instead of the generic "could not be proved" refusal.

### Recovering an Abandoned Lease

Since #3584, Linux runners select containment in the main thread before acquisition and pass that
exact instance parent to the lease worker. New process evidence is
`{ version: 2, bootId, startTime, marker, containment }`, where containment is either
`{ kind: "linux-cgroup-v2", bootId, mountRoot, cgroupPath, inode, unit? }` or
`{ kind: "marker-parent-links", reason }`. Records carrying it use **journal record version 5**,
which older readers reject, including readers that ignored unknown lifecycle fields. Legacy
v1/v2 records remain readable. The v4 checkpoint envelope preserves the exact version-5 previous
tip; older checkpoint readers reject that version too. Malformed evidence never becomes legacy
evidence silently. `unit`, when available, records the boot, mount root, path and inode of the
runner's own enclosing delegated service/scope, captured before the provider parent is created.

On the same boot, boundary recovery first requires the recorded runner PID/start-time identity
to be absent. A different runner resolves the recorded cgroup2 hierarchy root and exact relative
path, opens it, verifies the cgroup2 filesystem and recorded inode, and reads recursive
`cgroup.events` `populated=0`. It rechecks path/fd identity after reading and the runner identity
before accepting. No unrelated process scan participates. A surviving provider or helper anywhere
under the recorded parent blocks handoff, including detached non-dumpable helpers. Replaced
inodes, malformed events, unavailable mounts and inaccessible paths are unverified. A missing
provider parent has a separate proof: on the same boot and verified cgroup2 mount, its recorded
enclosing delegated unit must also be absent or have a different inode (a different incarnation).
A missing child under the exact still-present unit is refused. An existing provider path with a
different inode is always refused. No process or environment scan is used for either cgroup proof.

The removal argument uses kernel invariants: cgroup v2 supplies no rename operation, and
`cgroup_destroy_locked` refuses populated groups or live child groups while serialized against
migration. See the [kernel cgroup implementation](https://github.com/torvalds/linux/blob/v6.12/kernel/cgroup/cgroup.c)
and its separate [v1 rename implementation](https://github.com/torvalds/linux/blob/v6.12/kernel/cgroup/cgroup-v1.c).
The enclosing-unit evidence distinguishes unit pruning from unexplained deletion of a child.
This is lifecycle containment under the same threat model as #3275: **deliberate same-user cgroup
migration by provider code is outside the guarantee**. A restricted marker scan would not find a
scrubbed helper deliberately moved elsewhere either. Both the refusal and post-publication
acceptance diagnostics state this limitation; the journal records `linux_cgroup_unit_removed`
for the additional removal proof. Privileged changes to cgroup mounts or migration remain an
operator responsibility, never inferred from a process name or a different path.

A different boot UUID retains the existing reboot proof, regardless of PID reuse. Legacy evidence
and marker-parent-links fallback retain the scan described below. New same-owner recoveries also
append an explicit recovery note; cgroup proof is named `linux_cgroup`. Successors keep the exact
predecessor hash and bytes, never fabricate its release, and preserve existing profile grant and
exact-tip authorization checks. Existing bounded checkpoint/retirement rules are unchanged.

Internal typed causes distinguish `holder_alive`, `boundary_survivor`, `process_survivor`,
`boundary_unverifiable`, `process_uninspectable`, `process_uninspectable_not_delegated`,
`invalid_journal`, fixed-helper `unavailable`, and existing profile denials; `busy` remains fence
contention. Only fixed path-free guidance crosses the worker boundary. This change adds no
session-status field or protocol-version bump; #3585 can consume these runner-internal causes.
With #3589's existing v233 launch-refusal view, live-holder/survivor causes map to `busy` and
unverifiable-boundary/process/journal causes map to `unverifiable`. This compatibility mapping
adds no protocol values; the internal causes remain distinct for #3585.

The typed non-delegated cause remains available in authorized account recovery details. Primary
messages explain that Wollipog cannot safely unlock the account and offer another account or saving
work and restarting the machine. For future leases, the operator must use `Delegate=yes`; #3620
updated the dogfood launcher and deployed a delegated scope. That does not retroactively add
containment evidence to historical leases. For #79 phase 2, an external operator can run an isolated
stack in a delegated user scope with temporary provider HOMEs/data/ports and leave a real SSH login
open throughout recovery.

Configured ACP discovery now acquires its effective credential-HOME reference before constructing
the initialize-only client, disposes it, then awaits both agent and terminal tree proofs before
release. Missing/refused admission prevents execution; false, rejected or missing tree proofs
retain ownership. Native Claude/Codex/Pi discovery, configured Pi discovery and dynamic model
probes also acquire their effective inherited HOME, including provider HOME overrides. Their
multi-command references release only after every reported native probe tree is proven gone;
unproven trees retain ownership. Cached model discovery that spawns nothing releases immediately.
Native version/help/auth CLI commands use tracked boundaries, including Codex updater-capability
help and installed ACP-registry version probes. The latter acquires its own HOME reference before
execution; metadata-only registry callers execute nothing. Native npm release checks also report
their tracked trees to the owning discovery reference. Resolution utilities (`command -v`, directory
inspection) and fixed native helpers are not providers. WSL probes retain their existing in-distro execution and do not acquire
the unrelated native host HOME; WSL session isolation is handled separately.

Legacy detached review controllers must finish under their prior runner before the review-job
retirement upgrade. New runners refuse unfinished legacy records and never launch those controllers.
Existing provider cgroup leaves retire asynchronously after a non-killing emptiness check. Runner shutdown additionally requires the entire provider parent
empty before releasing HOME leases. A surviving detached controller legitimately blocks handoff
until its provider work finishes; shutdown and recovery guidance name this possibility.

Ordinary user-owned terminals are outside provider ownership and use their previous launch path;
provider leaf creation failures cannot prevent them opening. A `nohup`/`setsid` development server
from such a terminal survives a clean restart without retaining the provider-HOME lease. Agent
TUIs and agent shells whose cleanup owns descendants remain tracked inside provider containment.
Starting a provider manually from an ordinary terminal is user-managed execution; use a managed
provider launch or Agent TUI for HOME ownership enforcement. Legacy/non-delegated leases retain
their conservative process-scan rules, which may still refuse an uninspectable user daemon.
Dedicated media review namespaces use fresh private provider HOMEs instead of the shared leased HOME.

`provider-home-lease-cgroup.test.ts` starts independent holder/replacement processes with private
HOMEs and keeps a double-forked non-dumpable unrelated process alive throughout recovery. It
verifies that the legacy scan really refuses that process, then checks cgroup recovery, survivor
refusal, exact path/inode mismatch refusal, unchanged predecessor bytes and an appended recovery
record. It also runs a real transient delegated unit, crashes its holder, waits for systemd to prune
the recorded unit and child, and verifies recovery while an unrelated unreadable process stays
alive. The native cgroup suite asserts that rename is refused and that passive controller/shell
helpers retain their lifetimes and block shutdown handoff. Deterministic evidence/journal tests cover PID reuse, reboot, fallback guidance and profile
authorization. Run native validation as the real OS user in a delegated scope with
`WOLLIPOG_TEST_REQUIRE_CGROUP=1`; remapped-UID sandboxes cannot establish these proofs.
`WOLLIPOG_TEST_EXPECT_USER_MANAGER_QUERY=1` also exercises the actual user-manager delegation
query in `linux-cgroup.test.ts`.

The following describes the unchanged legacy/fallback scan and ownership rules.

Since #3241 a runner records lifecycle evidence in every active record it publishes, as an optional
`process` field: the boot id, its own process start time, and a random marker. Every process the
runner launches inherits that marker as `WOLLIPOG_PROVIDER_HOME_RUNNER`. A runner sets it in its own
environment when it starts, replacing any value inherited from a predecessor, and `spawnAgent` adds it
explicitly so a provider's explicit environment cannot drop it. Only Linux records evidence; other
platforms publish records without it.

An unreleased record with evidence is abandoned only when one of these holds:

- **Reboot:** the current boot id differs from the recorded one.
- **Process scan:** in the same boot, no process has the recorded PID and start time, no readable
  process of this user carries the marker, and no process of this user is left uninspected. A process
  whose environment cannot be read (non-dumpable, such as Codex, or set-id) is uninspected unless its
  world-readable `stat` shows it is a zombie, started before the recorded runner, or descends from the
  scanning runner. The scan skips the scanning process itself, which may have inherited a
  predecessor's marker. Only a read that reports the process gone (ENOENT/ESRCH) excuses it; any other
  read failure leaves it uninspected. The scan repeats the process listing, keyed by PID and start
  time, until one listing shows only processes already inspected and no listed process vanished
  before it was read, since a process that exits may have forked first. A table that does not settle
  within 16 listings, as on a busy host, proves nothing; the next acquisition tries again.

A dead PID alone never proves abandonment, including for the same owner's own restart. A record
without evidence (an older runner, another platform) keeps the earlier rule: only its own owner
reclaims it once its PID is gone.

Another owner may then succeed it only when the HOME's profile marker grants this control plane (the
acquisition passed the grant check with a profile id). Marker changes (adoption, revocation and
retirement) and marker-less HOMEs never recover another owner's lease. The successor is an ordinary
active v2 record with a `recovery` note, `{ proof: "reboot" | "process_scan", profileId }`, appended
after the stale record and linked to its exact bytes. The stale record is kept, and no release is ever
written for the old owner. Readers accept an owner change over an active record only with that note,
on the same host, and over a record that carried evidence. A release never carries the note.

Pre-lifecycle runners ignore the old `process` field. They refuse a legacy recovery record because they allow no owner
change over an active record, so a rollback binary fails closed with its generic refusal until a
checkpoint retires that link. The WSL in-distro helper refuses it the same way.

The scan shares the ledger's known limit: a descendant that scrubs its environment, or that a
non-dumpable process launched after the recorded runner started and that this runner did not launch,
cannot be told apart, and the second blocks recovery. A reboot always proves abandonment.

### Owner/Admin Recovery Authorization

A lease the rules above cannot recover automatically (one without evidence, from an older runner or
macOS, or one on a HOME without a profile grant for this control plane) can be recovered on an Owner
or Admin's one-time authorization (#3241 part 2, protocol v229):

1. `lease_inspect` reads the journal without creating anything and reports the state (`none`,
   `released`, `held`, `stale` or `unverifiable`). For a stale record it reports the exact hash a
   successor would link to, the record's `createdAt`, whether it is on this host and carries
   evidence, and why an authorized recovery would be refused now (or `null`).
2. The control plane records the authorization (`provider_home_lease_recoveries`: who, with which
   role, and the exact stale record hash) and sends its id with that hash.
3. `lease_recover` succeeds exactly that record and releases the HOME again before replying, so
   later launches acquire it through the ordinary handoff. Its successor carries the note
   `{ proof: "authorized", authorizationId, basis, profileId? }`.

The authorization replaces only the profile grant requirement, never the proof:

- The record must still be this host's (`foreign_host` otherwise).
- A HOME whose marker exists must still grant this control plane.
- A record with evidence still needs that evidence (`basis` is `reboot` or `process_scan`); a later
  boot time never overrides surviving evidence.
- A record without evidence (including a v1 lease, of any owner, including this one) needs the
  current boot to have started at least a minute after its `createdAt` (`basis: "booted_after"`);
  otherwise `no_reboot_proof`. The record's PID is not consulted, since a later boot may reuse it.
  Linux reads the boot time from `/proc/stat`, macOS from `kern.boottime`. The runner offers no
  recovery for a Windows or non-POSIX HOME.
- Any other tip (released, replaced, missing, held by this runner, or a partial in-lock journal) is
  `stale_tip_changed`, and nothing is created or published. The exclusive successor name makes each
  authorization usable once.

Readers accept an `authorized` note only on an active successor on the same host, with a basis that
matches whether its predecessor carried evidence. Part 1 readers refuse the note's shape and fail
closed.

### Provider Profile Identity

A provider HOME can carry a stable host-local profile identity (#3239) in
`<home>/.agent-manager/profile-v1.json`, a sibling of `provider-home-leases-v1/`. The lease journal
and its root are unchanged. The marker is strict JSON, at most 4 KiB, with exactly these keys:
`version: 1`, `kind: "wollipog-provider-profile"`, a lowercase UUID v4 `profileId`, `provider`
(`claude` or `codex`), an ISO `createdAt`, and at most 16 `grants` of
`{ controlPlaneInstanceId, grantId, grantedAt }`, one per control-plane instance. An unknown
version, kind or key makes the marker unverifiable.

The worker reads the marker without following links. `.agent-manager` must be a real directory.
The file must be a regular file owned by the runner's user, with one link, not group- or
world-writable, and unchanged across the read. Windows has no `O_NOFOLLOW` or POSIX owner check, so
a marker present there is always unverifiable; marker-less Windows homes are unaffected. Markers are
replaced only through an exclusive 0600 temporary file, fsync, rename and directory fsync, and only
by the worker while it holds that HOME's lease.

Each acquisition carries an optional `profile` context: the profile id the account or session
recorded, whether the control plane negotiates profiles, and the profile ids it holds active grants
for. The parent reads the capability when it dispatches the request, not when it queues it. The
worker knows its attested control-plane instance. Against the canonical HOME, before any lease
journal I/O and again on every re-entrant reference, it decides:

1. No marker and no recorded id: acquire as before.
2. No marker but a recorded id: `profile_changed`.
3. An unreadable, unsafe or newer-format marker: `profile_unverifiable`.
4. A marker whose id differs from the recorded one: `profile_changed`.
5. A marker the control plane does not negotiate (including callers that send no context):
   `profile_unsupported_control_plane`.
6. No grant for this instance in the marker, or no active grant on the control plane:
   `profile_not_granted`.

A refused acquisition creates no lease directory, and a refused re-entrant reference adds no
reference. An unsafe `.agent-manager` keeps its existing `refusal`. The four codes cross the boundary
with fixed, path-free texts.

An acquisition that names no expected profile id takes one from the configured account whose
directory is exactly the requested HOME path, so a directory substituted under an adopted account is
refused as `profile_changed` for sessions, Agent TUIs, probes, sign-in and skill transactions alike.

### Profile Marker Operations

Four operations change a marker, and only these do; see [Provider Profiles](./provider-profiles.md)
for the grant model:

- `profile_create { home, provider, profileId, grantId }` writes the first marker of a new managed
  profile HOME (Add Account): identity `profileId` with only this instance's `grantId`. A HOME that
  already holds a marker is refused as `profile_changed`, and an unreadable one as
  `profile_unverifiable`, so a creation never replaces or merges an identity. The reply adds no
  field.

- `profile_adopt { home, provider, grantId }` records the worker's attested control-plane instance
  with `grantId` in the marker, creating a new random identity when the HOME has none. An existing
  marker keeps its id and the other instances' grants; this instance's older grant is replaced. The
  successful reply carries the marker's `profileId`, the only reply field this operation adds.
- `profile_revoke { home, provider, profileId, grantId }` removes exactly that grant of this
  instance. The reply's `value` is true when the marker changed; a HOME without a marker has nothing
  to revoke, and a marker holding another profile is refused as `profile_changed`.
- `profile_retire { home, provider, profileId? }` settles grants for a removed
  account's HOME. It removes every grant of this instance and replies `value: true` only when
  dropping its reference released the lease (nothing else on this runner held the HOME) and the
  marker grants no other instance. A marker-less HOME is not shared; an unreadable marker is kept
  (`value: false`), never replaced. For a managed profile HOME the caller sends the account's
  recorded `profileId`: a marker holding another identity, or none, is kept unchanged
  (`value: false`). Neither result authorizes physical deletion: a successor or unproved consumer
  may still depend on the released HOME. Current cleanup retains every HOME and its canonical
  evidence; see [Provider HOME Cleanup Status](provider-home-cleanup.md).

All four take the HOME's lease the same way an acquisition does, but skip the grant check, since
they are how grants change. A HOME another live owner holds is refused with the acquisition's code
(`busy`, `foreign_owner`, `foreign_host`). The marker is read with the operation's provider while
the lease is held; an unreadable marker, or one for the other provider, is never replaced: creation,
adoption and revocation refuse it as `profile_unverifiable`, and retirement keeps the HOME. A marker already
holding 16 other grants is `profile_grant_limit`. The write
uses the same atomic replacement as acquisitions' marker checks expect, then the operation drops
the reference it took: the lease is released when it was the first reference and kept when a
session already held the HOME. None of these operations is an acquisition, so none can be cancelled
after its receipt, and the parent poisons the lane on a `profileId` in any other reply. The
instance always comes from the worker's startup data, never from a frame.

Callers that release before shutdown (skill transactions, launch preparation, and a launch or skill
acquisition that became stale after its grant) use `acquire_reference`. The worker keeps the receipt's exact-entry
release for that completed acquisition, at most 1024 at once, and `release_reference` names the
acquisition by its id. Every handle is settled: a consumer that keeps its reference until shutdown
(a launch preparation, Agent TUI or fork whose processes were not proven gone, or an unfinished
adoption or restore) sends `retain_reference`, which frees only the handle. Only in-flight transactions and
open session, TUI and fork handles occupy the pool, however many launches a runner performs. Releasing by path would re-resolve the HOME, so a symlink retargeted in
between could drop another HOME's reference. The handle cannot be redirected: it drops only the
entry it joined, at most once. Path-based `release` remains only for the provider sign-in supervisor
(sign-in settlement). Account removal retains the HOME; grant retirement still uses the worker's
exact internal receipt.

Short-lived provider processes release their reference once their process tree is proven gone (#3238). This covers:

- account-authentication and account-switch status commands;
- Codex subscription-usage probes;
- session-naming helpers.

Each process reports a proof when it finishes. The proof is true only when the process's POSIX
boundary terminated its descendants and found no survivor. On Linux with delegated cgroup v2
containment, this is the kernel's recursive empty-boundary proof described below. Otherwise the
boundary tracks processes through parent links and the inherited environment marker. The consumer
releases its reference only if every proof is true. A run that started no process also releases.

This is the same proof runner shutdown relies on before releasing every lease, so early release is
exactly as strong as shutdown release. On macOS and Linux without containment, a helper that detaches
with a scrubbed environment before its parent link is observed, or whose environment cannot be read,
can remain invisible to that observational boundary. macOS has no cgroup equivalent here and keeps
that limit; it does not claim the Linux containment standard.

### Linux Process Containment

The runner resolves its current cgroup through `/proc/self/cgroup` and `/proc/self/mountinfo`.
Write permission alone never proves delegation. Before creating anything, the fixed helper checks
systemd's documented `user.delegate=1` xattr on the nearest containing service/scope. Systemd's
user manager (including version 255) does not set this marker on its units. When it is absent, a
bounded, read-only `/usr/bin/systemctl --user show` query must report a loaded unit with
`Delegate=yes` and a `ControlGroup` exactly matching that nearest unit's hierarchy path. The query
uses the runner user's runtime bus and never enables delegation. It cannot substitute an ancestor
or a same-named unit elsewhere. The runner never inherits the user manager's delegation across a
non-delegated child scope. A unit hidden above a namespaced mount cannot be attested. Non-systemd
trees require an explicit delegation marker on the current cgroup; arbitrary writable trees are
unsupported. The marker requires systemd 251+ and kernel 5.6+; the user-manager query also supports
delegated user units without that marker. Absent or unreadable evidence (including an unavailable
user bus or systemctl) reports `cgroup-not-delegated` and performs no cgroup writes. See
[systemd's delegation contract](https://systemd.io/CGROUP_DELEGATION/) and its
[unit properties](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html).

Inside that declared delegation, the runner creates one randomly named instance parent below its
current cgroup and one leaf per native provider launch. It never moves the runner, changes
controllers, enables delegation, or creates a service/scope for itself. An operator must start it
in an appropriately delegated unit; changing the hosting installation is a separate operation.
Cgroup v2 with writable `cgroup.procs`, `cgroup.kill` (Linux 5.14+) and readable `cgroup.events`,
plus an executable fixed helper, is required. A read-only mount, missing delegation, unsupported
kernel or unavailable helper chooses the existing marker/parent-link proof
for that runner instance. Once cgroups are chosen, subsequent preparation failures refuse launch
instead of silently weakening that instance's containment claim.

The statically linked native launcher inherits an already-open cgroup directory as fd 3, verifies
its filesystem, writes itself into `cgroup.procs`, acknowledges admission on a private fd 4 pipe,
closes those descriptors, and only then executes the provider. A separate close-on-exec fd 5
reports exec errno so callers still receive `ChildProcess` errors such as `ENOENT` and `EACCES`
before `close`. The launcher really spawns, so its `pid`, `spawn` and `exit` remain observable even
on provider exec failure; consumers must settle failure once across `error` and `close`.
No shell startup or provider code can
fork before joining. A join failure exits without executing the provider. Cleanup waits for the
admission acknowledgement, so an empty leaf while the launcher is still waiting to join never
counts as a tree-gone proof. A waiter's timeout never erases a late acknowledgement. Uncertain
admission retains an unproved result but still ends the unreaped launcher and kills its own cgroup.
The helper is staged under temporary storage with a runner-data-directory fallback for noexec
mounts. A removed temporary copy is safely restaged from the fixed asset; changed existing copies
still fail verification.

Both `PosixProcessBoundary.releaseIfEmpty()` and `terminate()` use the same open-descriptor-backed
cgroup identity. Non-killing release requires recursive `cgroup.events` `populated=0`. Termination
first sends TERM/CONT to cgroup members using pidfds, including retained setsid work after the root
exits. It gives them two seconds, then uses recursive `cgroup.kill` for survivors and waits for the
same empty state; successful signal delivery alone is insufficient. The bounded TERM helper checks
membership after opening each pidfd, so PID reuse cannot authorize an unrelated signal; missing
or unreadable membership skips grace for that process, never final kernel cleanup. It reads no
environment or unrelated process listing, so setsid,
double-forking, environment scrubbing, non-dumpability and PID reuse cannot hide ordinary descendants
or implicate unrelated same-user processes. Kernel survivor termination is SIGKILL; drivers'
existing EOF grace happens before this cleanup.
A missing, replaced or unreadable boundary retains the
lease. Empty leaves are removed where possible; populated boundaries survive runner exit.

This is lifecycle containment, not a security boundary against a same-user process deliberately
moving itself to another writable cgroup. Existing provider isolation remains responsible for
hostile code. The runner neither installs a process-wide subreaper nor adopts responsibility for
unrelated orphans.

`provider_process_containment` logs fixed `proofStandard` and `reason` values without HOME paths or
environment contents. `providerContainmentStatus()` exposes the instance's selected standard;
each POSIX boundary also exposes its own `proofStandard` and optional `containmentIdentity`.
`providerContainmentIdentity()` initializes and exposes the instance parent's identity before a
future lease acquisition: `{ kind: "linux-cgroup-v2", bootId, mountRoot, cgroupPath, inode }`.
`cgroupPath` is relative to the cgroup2 mount and `mountRoot` identifies that mount's hierarchy root;
the boot UUID and decimal inode distinguish reboot and path reuse without trusting a runner PID.
Per-launch identities have the same shape. These are internal typed values, not a protocol change.

Coverage is native Linux launches through `spawnAgent` with `trackDescendants` enabled: Codex exec
and app-server, Pi, Claude one-shot/persistent/resume/fork probes, ACP agents and client terminals,
session and temporary fork providers, provider sign-in, account status/switch commands,
subscription-usage and naming helpers, and Agent TUIs and managed-worktree shells. The protected
Claude namespace's outer bwrap launch joins a leaf too; its control protocol still preserves the
existing graceful namespace proof, and disposal additionally proves its cgroup empty. Closed
namespaces with surviving members remain registered for shutdown. The native helper/compiler and
host utilities are not providers and are not placed in these leaves. Explicitly untracked native
shells and detached review controllers now join passive leaves as described above. WSL, Windows,
container and cloud launches retain their existing proof rules. Codex's direct hook,
permission-profile and MCP inventory probes use the compatible
`spawnAgent`/`trackDescendants` API delivered in #3340.

The containment mechanism delivered in #3275 supplies the identity persisted and verified by #3584
as described above. Legacy records retain their original process-scan proof.

`linux-cgroup.test.ts` covers admission races, fallback diagnostics/API compatibility, failed or
unverifiable cleanup and the shared early-release/shutdown proof without process scans. Its native
fixtures double-fork, call setsid, clear their environment and optionally become non-dumpable; the
real delegated-cgroup cases re-exec with an empty environment (clearenv alone does not change
`/proc/pid/environ`), assert they are dead before proof, verify a retained helper's TERM handler, and
leave an unrelated process alive. A six-second blocked-loop case covers queued admission.
Those cases explicitly skip where delegation is unavailable. Set `WOLLIPOG_TEST_REQUIRE_CGROUP=1`
for validation on a delegated Linux host to make unavailable containment fail instead of skipping.
The required Linux CI job launches this suite as the ordinary test user in two transient
`Delegate=yes` services, one owned by the system manager and one by the user manager, with this
flag set. Both have bounded runtimes and are collected on completion. CI therefore exercises the
marker and user-manager evidence paths without relying on the job's original unit delegation.
The user-manager run additionally sets `WOLLIPOG_TEST_EXPECT_USER_MANAGER_QUERY=1`. In that test
process only, the initial marker probe is treated as absent and the test requires an actual
systemctl query to establish containment. All cgroup operations stay real. This preserves query
coverage even if a future user manager starts setting the marker; production detection is unchanged.

A surviving, unknown or unprobeable descendant keeps the reference until shutdown. So does a spawn without a POSIX boundary, where only the root's exit is observable: native Windows (whose kill-on-close Job is not verified), WSL, and remote spawns.

Session providers and temporary fork providers work the same way per driver instance. Each launch takes its own handle, kept in a map keyed by the driver instance, and the instance settles it exactly once when it ends. Every path that ends an instance outside runner shutdown settles it: stop, idle parking, restart, delete, recovery, role conversion, account switch, worktree rebind, a failed initialization and fork cleanup.

The proof comes from `ProviderProcessLedger` (spawn.ts), which records every process the instance starts:

- A child spawned with the ledger's owner is covered by the owner's POSIX boundaries, which stay registered until proven gone.
- Any other child is proven individually. A child without an owner (a per-turn probe, say) has its boundary terminated when it closes, so its proof is settled then: a true result drops it from the ledger, and a false one makes every later proof false. Children therefore do not accumulate over a long session.
- A Claude virtual provider (the protected `bwrap` launch) has no boundary of its own; its namespace is the unit of proof, described below.
- A child without a boundary, or any untracked work the instance has run, makes the proof false. Codex MCP inventory, permission-profile deny and sandbox-projection probes start through `spawnAgent` with descendant tracking. Each probe ends its whole boundary on completion or timeout and reports the proof. The ledger waits for asynchronous preparation and its probes before proving the instance; cached permission-profile verdicts carry the original aggregate process proof to every consumer.
- Proving seals the ledger, so the instance can start nothing afterwards.

How an instance ended decides which proof it gets:

- **Disposed:** the killing proof, which ends survivors as disposal already started to.
- **Exited on its own:** the non-killing proof, so live background work is left for orphan recovery and the reference is kept.
- **Disposal threw:** kept.

A failed construction keeps the reference if a constructor ran, and releases it otherwise. During shutdown nothing is settled per instance; `close()` releases every reference after the global reaping proof.

Session and Agent TUI handles live as long as their sessions and terminals. A runner with 512 open session and TUI handles together gives later launches and TUIs a plain reference until shutdown, so the worker's 1024-handle pool stays free for transactions and probes.

Pi, Codex app-server, Claude Code and ACP prove their trees. Codex exec was retired in #3259.

**Launch preparation** takes its account-HOME reference in the `index.ts` adapter, for a plugin-provider session with a credential home whose context is native and whose target is the host. The reference is a transaction-scoped handle, so it does not count against the 512-handle budget. The caller of `prepareLaunch` owns it and passes it as `providerHome`, next to `isCurrent` and `signal`. Everything that runs under it reports there: the adapter's plugin inheritance and Codex guard, the launch's authentication preflight, and the status command of each authentication caller, through the same process observer as the account probes. The handle is settled exactly once, on those proofs:

- **Ordinary launch:** settled once the driver's own reference holds the HOME, just before the driver is constructed. That includes the null reference of a launch that needs no shared lease, or one past the handle budget, which holds a plain reference. Every earlier exit settles it on the way out: a stale launch, an authentication refusal, a failed transcript transfer, an isolation failure, a refused worktree lease and a failed driver acquisition.
- **Authentication inspection, account selection, automatic revalidation and explicit recovery:** settled in a `finally` once their status command has finished, with its proofs. A revalidation that timed out still settles when its work ends. A sign-in during explicit recovery runs under the login supervisor's own lease.
- **Recovery of another session sharing the scope:** settled right after its preparation, since nothing else runs under it.
- **Temporary-provider and Pi forks:** settled once the temporary driver's own reference is held, or when the fork gives up before that.

The reference is released only when nothing ran unprovably and every reported process tree is proven gone. A preparation that ran nothing, including one cancelled or gone stale after the grant, also releases. These keep it until shutdown:

- A Codex guard hook-inventory probe whose boundary could not prove its tree gone. Successful and failed enumerations both end the entire boundary before returning and report that proof to the preparation.
- A plugin inheritance that threw partway, since the HOME may be half-written.
- A status command whose tree was not proven gone, or one run by an injected command runner.

Runner shutdown settles nothing per preparation; `close()` releases every reference after the global reaping proof. Sessions that take no preparation reference, because they have no credential home, are unchanged.

**Agent TUIs** hold their reference from the grant until the TUI has ended. The launch preparation owns it first, then the shell open path, then the opened terminal:

- When the TUI process closes or fails to start, `ShellManager` reports its tree proof once: on native Linux the TUI's ownerless POSIX boundary, terminated at close, decides; a Windows ConPTY process always reports false. The reference is released only for a true proof. Explicit close, session close and worktree retirement end in that same close event, so they settle the same way.
- A preparation or open that fails after the grant settles with no TUI process: it releases, unless a probe already ran outside a boundary.
- A Codex TUI releases only when its own tree and every preparation probe (permission-profile, hook inventory and, for an Orchestrator TUI, MCP inventory) are proven gone. A false or rejected probe proof keeps the reference. A preparation that started no probe has no process proof to wait for.
- Windows native and WSL TUIs keep theirs too, since neither has a tree proof, and so does a false or failed proof.
- Runner shutdown settles nothing per TUI; `close()` releases every reference after the global reaping proof.

**Claude forks** take an exact-entry reference for the target fork (isolated to the new worktree), whichever client runs the fork: the live driver or a temporary one. The live client's ledger is never asked to prove, because proving would seal it. Instead `forkSession` reports the fork bootstrap's own tree proof through an optional process observer once the bootstrap has finished. The bootstrap has an ownerless boundary terminated at close. The reference is released only when that proof arrived and is true. A false proof, or none at all (a driver without the observer, or a bootstrap that never spawned), keeps it. A fork refused before `forkSession` was called releases it, since nothing was started.

**Claude Code** records its one-shot and persistent provider spawns under the ledger's owner, and its resume and fork accounting probe without one, so the probe is proven on its own.

- **Graceful stop:** `dispose()` gives a persistent provider its EOF grace window, then kills it, and only then ends the owner's survivors. The killing proof waits for those same retirements first, so it never cuts the grace window short.
- **Protected namespace:** when the provider runs inside its `bwrap` namespace, the namespace counts as gone only when it closed after the runner's TERMINATE frame, without the SIGKILL fallback, and its task root was removed. A SIGKILLed outer process can close a moment before the kernel has finished tearing down the PID namespace, and a namespace that closed on its own proves nothing about the work it hosted, so both keep the reference.
- **Namespace disposal:** the killing proof starts or joins the namespace's disposal. The non-killing proof only checks that the namespace already ended that way, so a live namespace, such as one with retained background tasks, keeps the reference.

**ACP** records its agent process without an owner, so the agent's survivors are still terminated when it closes and the agent is proven on its own. Each client terminal keeps its own owner, so releasing one terminal never ends another's retained work. The terminal service records how each terminal's tree ended, whether by kill, release or disposal (a command that exited on its own keeps its retained work until one of those). Once the service is disposed, the terminals count as gone only when every recorded ending proved its tree gone; a false result stays false. The ACP proof is the agent's proof and the terminals' proof together.

Both drivers keep the reference for Windows, WSL, container and cloud launches, for a spawn without a pid, and for a terminal without a POSIX boundary.

A missing, late, malformed, duplicate or mismatched completion, failed cancellation unwind, worker
error or unexpected exit poisons the lane. It rejects further work, retains canonical evidence and
never transparently creates another registry to reconstruct private authority. Terminating a worker
does not imply rollback or release. Recovery requires the existing runner lifecycle and native
owner/liveness proofs. Shutdown first closes acquisition admission; after provider, login and TUI
trees have been reaped, it awaits complete release. Unproved release reports false and retains proof.

Content-free `provider_home_worker_operation` logs correlate an epoch/request UUID with method,
queue wait, operation duration and outcome. `provider_home_worker_unavailable` reports the poisoned
epoch and fixed reason. Existing checkpoint/release diagnostics remain available. These logs never
carry HOME paths, provider environment values, manifests or private completion tokens, and logging
failure cannot change ownership.

## Measured Responsiveness

The regression fixture executes the actual production `startHeartbeat` function with an isolated
socket sink and immediate pong. It measures dispatch inter-gap minus interval with
`performance.now()`, separately from the lease operation's elapsed duration. Fixture preparation
precedes measurement. The maximal migration starts after 9,900 ms of asynchronous timer setup,
placing the first unchanged 10-second heartbeat due time inside the pending operation even on
machines that finish migration in less than 10 seconds. Setup overshoot or no dispatch strictly
between operation start and completion fails sampling explicitly. Setup and post-work dispatches
cannot satisfy that proof; the original dispatch timestamps remain intact for the 500 ms bound.
The heartbeat callback SHA-256 is
`fe29eb1bc6a221ecd6c271b510fe6035baf8e89f6299a356e3b48ce55f8d88c6`.

Linux / Node 24.18.1 measurements on a local development filesystem:

| Workload | Before: operation / heartbeat delay | Worker: operation / heartbeat delay |
| --- | --- | --- |
| Cold initialization, acquisition and release | 726 / 649 ms | 395 / 3.03 ms |
| Maximal 4,090 legacy transitions, 3,300 padding bytes each | 99,016 / 89,240 ms (10-second heartbeat) | 47,880 / 1.23 ms (10-second heartbeat) |
| Release with a reader holding the permanent fence for 1.5 seconds | 1,364 / 1,286 ms | 1,312 / 3.69 ms |
| SIGKILL at `candidate-durable`, then proved recovery and release | 685 / 605 ms | 481 / 6.15 ms |
| Fixed helper initialization/probe failure before HOME mutation | Not measured | 365 / 2.25 ms |

The actual source daemon, using SessionManager skill reconciliation and a loopback WebSocket peer,
measured a 426 ms cold operation and 0.81 ms maximum heartbeat delay. The actual packaged SEA daemon
processed the maximal migration in 78,580 ms while seven normal 10-second heartbeats were at most
0.70 ms late, with the broader native regression suite running concurrently. Both daemon fixtures refused a second live owner without changing evidence, recovered
after the first runner was killed, and proved graceful shutdown release. These are local Linux
results; macOS and Windows results come from the platform jobs, rather than inference from Linux.

## Verification Matrix

`provider-home-lease-async.test.ts` exercises real worker cancellation before/after acknowledgement,
alias retargeting, worker loss, live-parent refusal and generated reference-count sequences.
`provider-home-lease-worker-protocol.test.ts` injects invalid identities, phases, changed receipts,
loss, deadlines and queue saturation. `provider-home-lease-heartbeat.test.ts` covers maximal migration,
cold/failure paths, actual fence contention and killed-runner recovery. Existing native, portable,
checkpoint and I/O suites retain the ownership, durability and private-token proofs.
`provider-home-lease-clock.test.ts` covers unsigned wire round-trips, bounded timer rounding and
actual cross-thread/process coordinate bracketing. `provider-home-lease-deadline.test.ts` controls
monotonic time, wall time, timers and message delivery independently, including both wall-jump
directions, startup, queue expiry, receipt/done boundaries, early callbacks and original-deadline
cancellation compensation. `provider-home-lease-worker-deadline.test.ts` executes the complete
source worker with the same deterministic fixture, including real canonical I/O and fixed helpers.
The packaged verifier reads the exact embedded SEA asset through a verifier-only preload and runs
those unchanged bytes through that fixture, then checks the asset digest against the release build.
Its ordinary daemon lifecycle checks still launch the actual fixed worker. There is no production
clock override, alternate selectable worker or native diagnostic shortcut.
`session-manager-lease-preparation.test.ts` executes the production plugin ownership phase with
isolated controllers, including stale card/account/epoch checks, recovery cancellation, the
automatic timeout and unrelated-error preservation. It also runs the production Codex guard phase,
which forwards each hook-inventory boundary proof and retains a partial plugin write.
`session-provider-lease-release.test.ts` and `provider-process-lease-release.test.ts` settle the
preparation reference through the ordinary launch and the inspection, recheck, automatic revalidation
and sibling recovery callers. The fork
integration test settles it after the temporary driver's own reference. The fork integration tests defer both
preparation paths and verify source/target deletion, epoch and credential replacement before any
temporary provider is constructed; existing plugin argument assertions remain in place.

The Platform Isolation matrix runs Linux, macOS and both Windows images. It runs the focused source
tests and `verify-provider-home-worker-binary.mjs --source`, then builds the real native SEA and runs
the same daemon fixture with `--packaged`. The daemon fixture launches no live provider and uses
private temporary HOME, configuration and data roots. It runs these steps:

1. An idle runner releases the HOME after its skill transaction.
2. A second live runner then acquires the same HOME.
3. A separate holder process with the runners' owner and its own live PID takes the HOME; the
   second runner's sync is refused, and the journal is unchanged.
4. After the holder is killed, that runner recovers, then releases on graceful shutdown. Linux can additionally use `--maximal` with a
packaged binary to measure normal heartbeat delivery through the entire shipped path.

The Codex probe boundary regressions execute fake Codex commands that start detached helpers, on
completion and timeout. They check complete tree exit for MCP inventory, permission-profile commands,
sandbox projection and hook inventory; cached proof sharing; app-server disposal; and
launch-preparation/TUI reference release and conservative retention. Native discovery's Codex version
and app-server help commands also use ownerless boundaries and return their exit proof. Windows and
WSL MCP adapters retain their existing invocation and report false because no native POSIX tree proof
covers them. Injected probe runners are conservatively unproven. The already tracked model-discovery,
subscription-usage and authentication-status probes keep their existing ownership paths.
Ordinary Agent Control provisioning forwards both MCP inventory reads (before and after its proposed
server entry) to the launch-preparation owner too, even when a read fails or the entry is refused.

### Local Recovery for Legacy and Native HOMEs

Linux installations also expose `--state-doctor provider-home inspect|recover`. This command works
alongside the runner and uses the existing provider-HOME fences; it does not take the runner's
whole data-directory maintenance lease. It can inspect or recover a native default HOME that is
absent from the configured-account UI. Run it as the OS user who owns both the HOME and the stable
runner data directory, using the runner executable belonging to this installation:

```sh
# Capture this in the host terminal, outside a container or agent sandbox.
host_pid_namespace=$(readlink /proc/self/ns/pid)
wollipog-runner --state-doctor provider-home inspect \
  --data-dir /path/to/runner-data --home /path/to/provider-home \
  --expected-pid-namespace "$host_pid_namespace"

# After explicitly authorizing the exact stale tip printed by inspection:
wollipog-runner --state-doctor provider-home recover \
  --data-dir /path/to/runner-data --home /path/to/provider-home \
  --expected-pid-namespace "$host_pid_namespace" \
  --stale-tip-hash <64-character-tip-hash> --authorization-id <authorization-uuid>
```

Inspection prints content-free lifecycle and refusal fields, with no provider paths or environment.
Recovery repeats abandonment and exact-tip proof in the normal registry publication path, appends
an authorized recovery and releases only its own reference. It never fabricates a release of the
old owner, skips unreadable processes, deletes records, stops a process, or launches a provider.
A changed tip, surviving work, unverifiable proof, or profile authorization failure refuses the
operation. An unconfirmed recovery explicitly reports that publication may already have happened;
inspect before retrying and never assume no change. This initial local command does not supply profile grants; a marked profile continues
to require its existing authorized profile-aware recovery flow. Other state-doctor commands retain
their existing offline maintenance requirements.

The expected PID namespace binds an operator's host snapshot to execution. Never obtain it from an
agent sandbox and use it to recover a host HOME: a restricted procfs view cannot establish host-wide
abandonment. This is an operator input, not independent proof of the host namespace. Every lease
proof still runs again at publication.

For a legacy scan blocked only by Linux process visibility, an administrator can temporarily grant
**CAP_SYS_PTRACE and CAP_DAC_READ_SEARCH** to this one maintenance process while retaining the
account owner's real and effective UID. The first permits process inspection; the second permits
reading root-owned procfs files such as a nondumpable SSH process's environment (mode 0400). Neither
capability changes the recovery command's use of the account owner's ordinary journal write
permissions and fences. These capabilities are nevertheless privileged and belong only to this
reviewed, short-lived maintenance process. Do not run the command directly as root (the protected journal must stay owned
by the account user), grant file capabilities to the runner, change SSH permissions, or give the
long-running runner elevated capabilities. Let any `sudo` launcher exit before scanning: a same-user
set-ID ancestor is itself protected by the ordinary fallback rules. Privileged inspection does not
waive the lifecycle proof or authorize a different stale record. Review the exact command and
snapshot before executing; if proof still fails, preserve the evidence and investigate that cause.

After recovering older evidence, verify that the normal service runs with effective `Delegate=yes`
and that fresh acquisitions record their cgroup and enclosing unit. A later normal restart should
recover using that boundary while unrelated unreadable SSH processes remain alive. Test-runner HOME
and credential isolation prevents local verification from publishing another owner's native-HOME
lease into the live installation.
