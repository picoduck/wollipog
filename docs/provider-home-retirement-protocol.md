# Managed Provider HOME Retirement Proposal (Refs #3157)

Revision 3. Physical cleanup remains disabled. The isolated state model below is an implemented
prerequisite; the filesystem/distributed retirement protocol remains a proposal, not a supported
feature. Account removal continues to return `credentialsRetained: true`. No real credentials may
be retired during implementation or verification.

The bounded model follows the independently assessed Phase 1 proposal (37,677 bytes, SHA-256
`6ae49db6e9bcd03df39f31270524d8feec3ce4b6ba26db830883d39c2658cabb`). The earlier temporary
`583129b9…` proposal is unavailable and was not recovered. Its denied decision grants no authority.
The state-only implementation decision is `workflow_b77ff12b71c94d0a91acc711c3b864f6`, resource
digest `b10d60fb850ad5638a9c16382982fc2c05724e52c34e90e741e2ae3876a4c103`, consumed for option
`approve_isolated_state_model` at receipt `consumedAt: 1792357901882` (policy revision 1,
authority `orchestrator`, basis `custom_policy`). It authorizes no production integration or
reviewer launch.

## Isolated State Model and Proof Boundary

`apps/runner/src/provider-home-retirement-state.ts` is imported only by its focused test. It has
no filesystem persistence/removal, production import, worker/native operation, process-lifecycle
change or configuration/binding/grant integration. Its in-memory CAS adapter **simulates** durable
records. Neither schema validation, digests, source barriers nor acknowledgements attest actual
host durability, exhaustive owners, process exit or deletion authority. A positive result is named
`terminal_eligible`, not removed. Full #3157 remains incomplete.

The model starts at explicit synthetic genesis: provider/profile/incarnation, root epoch, creator
and store epoch, and creation nonce. Snapshots contain only genesis and the complete bounded event
history; derived state is replayed rather than accepted from caller flags. Genesis itself is a
modeled premise, not evidence that a real HOME was created this way. An untrusted party can invent
a consistent alternate model; that does not prove any external fact.

Each event has a nonce, exact prior revision/digest and strict action schema. Canonical JSON
sorts object keys, preserves array order and refuses unknown schema fields/versions, accessors,
exotic prototypes, sparse arrays and non-JSON values. SHA-256 digests use distinct versioned domains
for genesis, state, roster, manifest, grants, publication, barrier and retirement. Counters use
canonical uint64 decimal strings and refuse overflow. The snapshot revision is the event count;
the smaller finite history bound is reached before that counter's arithmetic limit.

Both a complete snapshot and derived manifest/state must fit 64 KiB. There are at most 256 combined
historical-owner, consumer and intent rows, 256 successful events/nonces, JSON depth 16 and 32,768
visited JSON nodes. Canonicalization charges UTF-8 bytes incrementally before hashing. Reaching any
bound refuses without truncation, eviction or credential cleanup. Small histories can exhaust the
byte bound before the row/event bounds; the model deliberately offers no evidence compaction.

The input contract is synthetic JSON data in the supported Node realm with intact intrinsics,
not arbitrary hostile JavaScript. Native `node:util` Proxy detection refuses direct, nested, array
and revoked Proxies before prototype, length, key or descriptor reflection, without executing their
traps. Accessor descriptors refuse without invoking getters. Array length is checked before key
enumeration; own-key counts are checked before fetching individual descriptors. Ordinary-object
key enumeration still allocates and performs work proportional to the supplied own-key count,
including on rejected objects. Already-allocated input memory is outside these bounds. Output,
visited-node, depth and replay bounds therefore do not bound all input reflection work or establish
a hostile-code sandbox, and replaced intrinsics are outside this contract.

Modeled transitions:

1. **Enrollment.** Owner ids/store epochs persist permanently; reusing an owner id cannot replace
   its store. Every consumer has an enrolled intent before publication. Consumers include accounts,
   defaults, sessions, history, switches, recovery, TUIs, sign-in, launch, skills, probes and background
   work. Enrollment binds current source/grant revisions and issues an incarnation/preimage-bound
   synthetic ticket. Revoking a grant never deletes its owner or outstanding intent.
2. **Publication.** An OPEN owner can publish only the exact pending ticket, current grant and next
   source revision. Two tickets issued against the same source revision cannot both publish after
   one advances that revision. Lost/ambiguous writes leave intents represented until a barrier.
3. **Freeze.** A matching complete roster/manifest/grant/publication/provenance digest and generation
   changes OPEN to FROZEN irreversibly. That generation and census remain fixed. New owners, grants,
   consumer enrollment, publication and process admission are refused after freeze.
4. **Source Barrier.** Each connected, same-store owner supplies its exact previous source digest/
   revision, next source revision, current grant revision and frozen nonce. The barrier resolves
   every one of that owner's intents with the exact ticket: pending work may be aborted or modeled
   committed-and-retired; published work must be retired. It retires the consumer rows and remaining
   modeled grant in the same synthetic transition. This represents a writer/outbox barrier; it does
   not create one in any real database or config writer. No timeout resolves an intent.
5. **Acknowledgement.** Every historical owner must acknowledge the exact root/incarnation/store,
   frozen generation/nonce and roster/manifest/grant/publication/provenance digests, plus its source
   barrier, complete resolution digest and process-history digest. Unknown owners, missing stores,
   disconnected participants, mismatched epochs or incomplete resolutions refuse. Presence can be
   restored only for the same store epoch; this models continuity rather than proving it.
6. **Terminal Eligibility.** All consumers must be retired, all intents aborted/retired, every owner
   connected with a retired grant and matching acknowledgement, and the entire modeled history must
   contain no admitted process start or unknown-history event. Only then can FROZEN become
   TERMINAL_ELIGIBLE, irreversibly. The no-process branch derives from genesis and every modeled
   admission; no independent `noProcesses: true` field or external process-proof boolean is accepted.
   This version deliberately has no positive process-used branch, detach, removal or recovery API.

The synthetic store assigns only after complete validation. A failed CAS/transition changes neither
state nor replay evidence. An exact previously accepted event, including its original preimage, is
an inert lost-reply retry, even after later events; changing its nonce payload/preimage refuses.
An old snapshot must match an independently retained expected anchor on simulated restore. The
adapter cannot authenticate that anchor or detect a real owner restoring both records from backup.

Focused tests exercise positive no-process traces, missing-owner and unresolved-intent schedules,
late publication, source/store rollback, every freeze/ack binding, replay, identity substitution in
modeled records, strict schema/node/depth/byte/row/history/counter bounds and refusal without mutation.
Additional schedules cover pending intents resolved committed-and-retired, cross-owner resolution
refusal and publication after grant revocation. Plain terminal actions independently test sticky
process/unknown-history exclusion; an extra caller `noProcesses` field tests unknown-key refusal.
Small oversized ordinary objects/arrays and trap-counted Proxy inputs exercise the input contract
without claiming a production hostile-input resource boundary.
Existing fast-check generates canonical records, owner/intent schedules and command interleavings
against an independent flag/counter oracle. These tests never create/delete a HOME or establish
native concurrency, crash durability, cohort exclusion or complete provider process containment.

## Source Facts and Supported Sharing

The SSH-account-level root returned by `apps/runner/src/provider-profile-home.ts:13` deliberately survives replacement runners and their owner-namespaced data directories. Multiple control planes may hold profile grants. This is the real shared-HOME scenario; cross-host filesystems and unknown consumers do not become safe because paths match.

Current source at `973d3c31955646a4eb45613f0a16b6d7b2a60773` confirms #3440 retains sign-in and
removed-account payloads and canonical evidence. `profile_retire` still settles grants and releases
its own lease reference before returning; its boolean is not deletion authority. Current profile
markers and registration-scoped grant queries do not carry complete consumer generations.

The following revision-2 references describe **historical pre-retention ordering**, not current
deletion routes. Their source base was `a9caf495a252d0d6c4e14c5cf53a70a4a7339923`; line numbers
are historical. They establish ordering, not a reproduced loss incident:

- `provider-login.ts:1088` acquires/releases or calls profile retirement, then removes the directory at line 1133.
- Login settlement releases at line 967 before duplicate/unused cleanup at lines 970-971. Spawn failure and cancellation do likewise at lines 520-521 and 554-555.
- Pre-acquisition/profile-create failures reach unused cleanup at lines 462 and 482. `cleanupUnusedDirectory` at line 1153 relies on an absent credential filename; that is not ownership proof.
- `provider-home-lease.ts:1286` forgets a successfully released entry. `retireProfileHomeWhileHeld` at line 798 releases before returning its boolean.
- Account removal writes configuration before cleanup (`provider-login.ts:683-695`). Keep that ordering and report retained credentials truthfully.

Planning report626 established ordering, not cross-runner loss. The isolated model's synthetic
schedules are not native cleanup/concurrency reproductions. Directory location, UUID, missing
credential marker, empty grant list and release success never independently authorize deletion.

## Delivered Retention and Unimplemented Physical Boundary

#3440 disabled unproved recursive cleanup on every login/account-removal route. It retains all
legacy, operator-owned, configured/published, foreign, malformed and unknown HOMEs. Revocation,
local reservations, process reaping, skill serialization and configuration-write safeguards remain.
A removed configured account returns `credentialsRetained: true`.

A future positive physical path would need a newly created, completely enrolled cohort, durable
creation provenance, exact private ownership and complete lifetime proof for every consumer.
The model only explores the no-process branch. An actual completed sign-in/reference is insufficient:
`spawn.ts:895-897` documents a detached, scrubbed/unobserved descendant blind spot in existing process
tracking. Unknown or historical readers and paused old cleanup cannot be retroactively fenced by
a marker. Actual provider-used HOMEs require a stronger complete containment contract; none is
implemented here. Failure/duplicate sign-in continues to retain credentials and evidence.

Retention and this isolated prerequisite do not deliver physical cleanup of configured accounts,
real exhaustive dormant-binding accounting, legacy migration or full #3157 closure. The remaining
sections are unimplemented physical-protocol requirements, not authority to change runtime behavior.

## Namespace, Provenance and Old-Binary Exclusion

The physical proposal requires a new nested namespace under the verified shared root:
`<profiles>/.managed-retirement-v1/homes/<incarnationId>`. Sibling `state/<incarnationId>` holds
permanent provenance, fences and canonical journals; `retired/` holds detached payloads. The
incarnation identifies one never-reused physical lifetime independently of profileId. Existing
`<profiles>/<profileId>` and runner-local legacy HOMEs are never migrated or deleted automatically.

Create privately in staging. Record root/parent/HOME device and inode, canonical parent/name, profile/provider, attested instance/initial grant, creation nonce and guard hashes. Write exclusively, fsync, then publish with native no-replace rename. Foreign/preexisting destinations and incomplete provenance retain. Disk provenance is necessary but cannot reconstruct the creating worker's private epoch-bound capability after a crash.

Before exposure, install an immutable incompatible journal barrier inside the payload. A concrete candidate is fixed non-lease bytes `{"kind":"wollipog-managed-home-external","version":1}` plus newline at the canonical recovery filename and the historical lock-directory lease/checkpoint filenames. Store their identities/hashes externally. Never publish a compatible lease there; new code uses the external canonical journal.

Base anchors: `provider-home-lease.ts:252-281` validates required record fields; lines 475-504 read the recovery record or historical lease record; line 817 skips profile access for PROFILE_CHANGE but does not skip journal validation. The candidate lacks required lease fields and must be refused. An arbitrary unknown filename alone is insufficient: canonical-root enumeration at line 432 is conditional on the journal path taken. Verify exact sentinel bytes against each supported historical reader, including legacy profile mutations and packaged workers. These are proof obligations, not completed compatibility tests. An unproved reader cohort means retention/unsupported.

An old process already paused after release does not consult a new fence. Therefore legacy names cannot be made deletable by adding a marker. For new nested names, the base removed-account predicate at `provider-login.ts:1088-1109` accepts only direct children of its fixed profile/account root; existing-account refresh has `persistAccount: false`. Demonstrate those paths cannot target the new namespace, including aliases. Enumerate historical fresh-login cleanup paths; any version that can delete the new namespace without these checks disables retirement for that cohort. No inference from a version number or random UUID is sufficient.

## Publication and Consumer Races

The earlier private-only proposal used `preparing -> private -> published` or `private -> retired`;
it was never implemented. The complete contract instead needs durable enrollment **before** each
config/binding/grant publication, followed by irreversible freeze, exact owner-store barriers and
all retirement acknowledgements. A failed/ambiguous write retains its live publication intent.
The model represents these obligations but does not integrate with their real writers.

Route every native acquisition, reentrant reference, probe, skill mutation, marker mutation, exact release, recovery and checkpoint through the same external authority. A competitor winning admission first commits published and prevents retirement. Retirement winning first commits terminal state and denies the competitor before mkdir. Alias resolution must discover and verify the same canonical external authority; unfamiliar or retargeted aliases retain/refuse.

Current `ProviderProfileGrants` is insufficient as an exhaustive consumer ledger: `provider-profile-grants.ts:52` tracks creations, line 71 synchronizes a registration-scoped list and line 107 scans configured accounts. Protocol-v225 `RegisteredMessage.providerProfileGrants` is scoped to reported profiles. No claim that this proves absence of remote/dormant bindings is permitted.

## Exact Worker Authority and Atomic Retirement

Keep the worker's receipt/ack protocol and exact-entry handles (`provider-home-lease-worker.ts:18-22,46-54,77-103`; async registry line 116). Extend them with bounded private create/publish/retire operations and explicit removed/retained/indeterminate results. A path, PID, caller boolean, profile-retire response or disk record is not an exact reference capability.

Use one lock order: permanent external HOME fence, then existing canonical-journal fence. Computation may use snapshots, but every commit must revalidate the complete expected preimage and pinned identities under both locks. Holding a fence for one helper snapshot and releasing it before an unchecked TypeScript mutation is invalid. Profile writes and initialization must join the transaction. Preserve canonical verification, storage budgets and existing helper trust boundaries.

Before terminal CAS prove: the creating worker capability, exact completed acquired tip/hash, one reference, no pending receipt/completion/migration, unchanged private provenance/guard/profile/directory identities, no other grants and no published or unknown consumer. Local refusal must not consume someone else's reference. Keep account reservations until settlement ends. Reap the entire provider tree first; failure retains ownership and payload.

Commit/fsync terminal retirement binding the previous canonical tip/hash, provenance hash, pinned directory identities, exact profile/grant verdict and private detach target. Keep canonical evidence outside the payload. Normal release, stale recovery and compaction must refuse terminal state; none may recreate a retired name or erase its terminal proof.

Use no-follow pinned parent/HOME descriptors and same-filesystem native no-replace detach into the private retirement root. Never issue recursive removal against the original pathname again. Verify the detached identity before descriptor-relative, no-follow traversal; permanently retain external provenance, journal, fence and terminal proof. A substituted original path is never deleted. Unknown entries/identities during traversal stop cleanup; partial removal is indeterminate.

## Crashes, Cancellation and Platforms

Before terminal commit, cancellation retains and releases only the exact reference when release is proved. A poisoned worker or ambiguous release cannot authorize deletion (`provider-home-lease-async.ts:217,288-332,362`). A receipt alone grants no caller-visible success.

After a future terminal commit there can be no rollback or compensation into an ordinary released
lease. Crash before detach leaves credentials in place with admission blocked; crash after detach
leaves the private payload/evidence for inspection. Lost completion or interrupted traversal is
indeterminate/retained; absence of the original path never proves removal. #3440 already stopped
the historical existence-based settlement from claiming an externally moved HOME was removed.
The model enables no crash recovery deletion. A separately reviewed future recovery operation
cannot extend the original #3155 operation deadline or masquerade as cancellation compensation.

Linux may use `renameat2(RENAME_NOREPLACE)` only where the syscall/filesystem and same-filesystem identities are verified. Existing `apps/runner/native/provider-home-lease-io.c:124,197,301` pins ancestry and fences journal operations; its `renameat` at line 295 selects a checkpoint and is not an approved payload-detach primitive. Extend the fixed helper explicitly. Unsupported syscall/filesystem, EXDEV, collision, macOS, Windows and WSL retirement retain until an equally strong native primitive is implemented and tested. Never emulate no-replace using stat-then-rename; do not execute a helper chosen by an agent RPC or configuration value.

## Verification and Delivery

Synthetic credentials and isolated fixtures only. Deterministic barriers must cover competitor-first and retirement-first admission; outstanding local references; pending receipt/ack; success/publication/config-write failure; duplicate/failure/spawn-failure/cancellation/pre-acquisition failure; account removal retention; unknown remote/dormant bindings; crashes around each durable write/detach; ambiguous release; malformed/foreign/hardlinked/symlinked artifacts; retargeted aliases/root/HOME identity; old-reader and paused-old-cleanup exclusion; platform refusal; and exact retired-payload removal preserving a successor and all external evidence. Re-run recovery/compaction tests proving no revival.

Future integration needs frozen-lockfile setup, focused login/profile/lease/worker/native tests,
runner/protocol typechecks and packaged worker/helper/sidecar checks. Recheck fresh open PR overlap
and coordinate the external #3228/#3239 owner before any lifecycle integration. The isolated slice
runs only its focused synthetic/property tests and runner source/test typecheck. No dependencies,
worker clock/SEA asset, deadline, bounds, native ownership or poison/no-replacement behavior change.

Required review uses runner-owned request_cross_model_review on the own pushed PR/exact head, latest Claude Opus/high and read-only snapshot, with at most four valid rounds/two launched attempts per round. Independently adjudicate findings and preserve actual admission/cost/refusal receipts. No alternate native reviewer. Required exact-head CI, human per-PR merge consent, exact typed parent merge decision, actual merge-group MERGED and separate human/typed branch-deletion consent remain. Use Refs #3157; closure stays parent-owned. No stack operations, settings/auth/grant expansion or real-credential retirement.

## Minimum Remaining Path to Full Configured-Account Retirement

Full delivery requires a reviewed durable binding-retirement contract in addition to the partial protocol above:

1. Before a new profile becomes configured or externally bindable, durably enroll every account/session/default/background/remote consumer in a complete generation-bound manifest. Bind local registrations and participating control planes to the external provenance/identity. Missing or legacy consumers retain. Grant lists and runner heartbeats are not completeness attestations.
2. Under the same authority, freeze new bindings/admissions and obtain exact acknowledgements that every enrolled consumer is retired and all provider trees/references are drained. Use short fenced commits; never hold a filesystem lock across network acknowledgement waits. Owner-store barriers must prevent stale outbox/config continuations after acknowledgement, not merely observe their absence. Include dormant persisted sessions, disconnected runners, other control planes and pending config/publication operations. Revoke only through existing authorized actions; do not invent permission to discard dependent bindings. Existing POSIX process tracking's documented blind spot remains insufficient for exhaustive retirement; prove complete containment for all actual users or retain.
3. Bind an exhaustive manifest digest/generation and authorized account-removal intent to the terminal CAS. Racing adoption, reconnect, config writes or new grants must either precede the manifest freeze and be accounted for, or fail after it. Missing acknowledgement, unsupported peer, foreign grant or uncertain release retains indefinitely.
4. Prove mixed-version rollout and legacy-name exclusion. Existing legacy profiles need separately authorized offline ownership/consumer proof or remain retained forever; an online marker retrofit cannot stop a paused old cleanup. Published profiles from the partial revision cannot be reclassified private by an upgrade.
5. Demonstrate positive configured-account physical removal only when these proofs hold, plus deterministic races/failures and truthful retained/indeterminate results. Independently review that full protocol before implementing its new cross-component messages or migration behavior.

These requirements remain on #3157. Approval of the partial slice cannot close the issue or establish that full configured-account retirement is solved. This document requests no new authentication, governance, runtime/resource, artifact-transfer or hosting authority.
